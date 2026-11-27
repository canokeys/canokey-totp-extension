import { AutofillController } from '../lib/autofill-controller';
import { wipe } from '../lib/bytes';
import { DeviceManager } from '../lib/canokey/device-manager';
import { OathClient } from '../lib/canokey/oath-client';
import { AppError, errorCode, errorMessage } from '../lib/errors';
import { assertMessageSender } from '../lib/message-security';
import { decodeBase32, importPreview } from '../lib/otpauth';
import { helperMatchPattern, tabOrigin } from '../lib/origin';
import { readQrFromScreenshot } from '../lib/qr';
import { canShowHelper, changeMapping, getCustomMappings } from '../lib/storage';
import type { ImportResult, Message, MessageResponse } from '../lib/types';

export default defineBackground(() => {
  const devices = new DeviceManager(chrome.runtime.getURL('wasm/canokey.wasm'));
  const oath = new OathClient(devices);
  const autofill = new AutofillController(devices, oath);

  async function helperAllowed(origin: string): Promise<boolean> {
    return await canShowHelper(origin) && await chrome.permissions.contains({ origins: [helperMatchPattern(origin)] });
  }

  async function refreshHelper(tab: chrome.tabs.Tab): Promise<void> {
    const origin = tabOrigin(tab.url);
    if (tab.id === undefined || !origin || !await helperAllowed(origin)) return;
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      files: ['content-scripts/helper.js'],
    }).catch(() => undefined);
  }

  async function refreshHelpers(): Promise<void> {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map(async (tab) => {
      if (tab.id !== undefined) {
        await chrome.tabs.sendMessage(tab.id, { type: 'helper:refresh' }, { frameId: 0 }).catch(() => undefined);
      }
      await refreshHelper(tab);
    }));
  }

  async function importCredential(message: Extract<Message, { type: 'import:manual' }>): Promise<ImportResult> {
    const { deviceId, touch, password, fillTarget } = message;
    const draft = { ...message.draft, secret: decodeBase32(message.draft.secret) };
    try {
      importPreview(draft);
      const checkTarget = fillTarget && (async () => {
        const target = await autofill.inspect(fillTarget.tabId, fillTarget.origin, fillTarget.documentId);
        if (!await autofill.hasField(target)) throw new AppError('DOCUMENT_CHANGED', 'The verification field changed. Reopen the importer.');
      });
      if (checkTarget) await checkTarget();
      const credential = await oath.import(deviceId, draft, touch, password, checkTarget);
      if (!fillTarget) return { credential };
      try {
        const fill = await autofill.start(fillTarget.tabId, {
          selection: { deviceId, credentialName: credential.nameHex },
          expectedOrigin: fillTarget.origin, expectedDocumentId: fillTarget.documentId,
          ...(password ? { password } : {}),
        });
        return { credential, fill };
      } catch (error) {
        return { credential, fillError: errorMessage(error) };
      }
    } finally {
      wipe(draft.secret);
    }
  }

  async function handle(message: Message, sender: chrome.runtime.MessageSender): Promise<unknown> {
    assertMessageSender(message, sender, chrome.runtime.id, chrome.runtime.getURL(''));
    switch (message.type) {
      case 'helper:status':
        return helperAllowed(message.origin);
      case 'helper:clicked':
        if (!await helperAllowed(message.origin)) throw new AppError('PERMISSION_DENIED', 'The fill button is unavailable on this website.');
        await autofill.start(sender.tab!.id!, { expectedOrigin: message.origin, expectedDocumentId: sender.documentId! });
        return undefined;
      case 'device:list':
        return devices.status();
      case 'credential:list':
        return oath.list(message.deviceId, message.password);
      case 'mapping:list':
        return getCustomMappings();
      case 'mapping:change': {
        const mappings = await changeMapping(message.mapping, message.previous);
        void refreshHelpers().catch(() => undefined);
        return mappings;
      }
      case 'autofill:start':
        return autofill.start(message.tabId, message);
      case 'autofill:select':
        return autofill.select(message.operationId, message.selection, message.mode);
      case 'autofill:password':
        return autofill.password(message.operationId, message.deviceId, message.password);
      case 'autofill:retry':
        return autofill.retry(message.operationId);
      case 'autofill:cancel':
        return autofill.cancel(message.operationId);
      case 'autofill:copy':
        return autofill.copy(message.operationId);
      case 'operation:get': {
        const operation = autofill.get(message.operationId);
        if (!operation) throw new AppError('OPERATION_EXPIRED', 'This operation is no longer available. Start again.');
        return operation;
      }
      case 'import:manual':
        return importCredential(message);
      case 'import:target': {
        const target = await autofill.inspect(message.tabId, message.expectedOrigin);
        return await autofill.hasField(target) ? target : undefined;
      }
      case 'import:screenshot': {
        const target = await autofill.inspect(message.tabId, message.expectedOrigin);
        const screenshot = await chrome.tabs.captureVisibleTab(target.windowId, { format: 'png' });
        await autofill.inspect(target.tabId, target.origin, target.documentId);
        return readQrFromScreenshot(screenshot);
      }
      default:
        throw new AppError('MESSAGE_INVALID', 'Unknown message.');
    }
  }

  chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse: (result: MessageResponse) => void) => {
    if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') {
      sendResponse({ ok: false, error: 'Invalid message.' });
      return false;
    }
    handle(message, sender).then(
      (data) => sendResponse({ ok: true, data }),
      (error: unknown) => sendResponse({ ok: false, error: errorMessage(error), code: errorCode(error) }),
    );
    return true;
  });

  chrome.commands.onCommand.addListener((command) => {
    if (command !== 'fill-totp') return;
    void chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
      if (tab?.id === undefined) return;
      try {
        await autofill.start(tab.id);
      } catch {
        await chrome.action.setBadgeText({ tabId: tab.id, text: 'ERR' });
      }
    }).catch(() => undefined);
  });

  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.url || change.status === 'loading') autofill.cancelTab(tabId);
    if (change.status === 'complete') void refreshHelper(tab).catch(() => undefined);
  });
  chrome.tabs.onRemoved.addListener((tabId) => autofill.cancelTab(tabId));
  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => autofill.cancelOtherTabs(tabId, windowId));
  chrome.windows.onRemoved.addListener((windowId) => autofill.closedInteraction(windowId));
  chrome.permissions.onAdded.addListener(() => { void refreshHelpers().catch(() => undefined); });
  chrome.permissions.onRemoved.addListener(() => { void refreshHelpers().catch(() => undefined); });
  chrome.runtime.onStartup.addListener(() => { void refreshHelpers().catch(() => undefined); });
  chrome.runtime.onInstalled.addListener(() => { void refreshHelpers().catch(() => undefined); });
  navigator.usb?.addEventListener('disconnect', (event: Event) => {
    if ('device' in event) autofill.disconnect((event as USBConnectionEvent).device.serialNumber?.toUpperCase());
  });
});

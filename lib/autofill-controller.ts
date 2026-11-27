import type { OathClient } from './canokey/oath-client';
import type { DeviceManager } from './canokey/device-manager';
import { AppError, errorMessage } from './errors';
import { matchingCredentials, normalizeOrigin, tabOrigin } from './origin';
import { getMappings } from './storage';
import { isOtpValid, MAX_OPERATION_AGE_MS, totpWindow } from './totp-time';
import type { AutofillSelection, AutofillTarget, ContentMessage, CopyResult, Credential, DeviceInfo, MessageResponse, OperationState, OperationView, PrepareResult } from './types';

interface Operation {
  view: OperationView;
  passwords: Map<string, string>;
  timeout: ReturnType<typeof setTimeout>;
  copy?: CopyResult & { calculatedAt: number };
  interaction?: Promise<void>;
  interactionWindowId?: number;
  codeTimeout?: ReturnType<typeof setTimeout>;
}

interface StartOptions {
  selection?: AutofillSelection;
  mode?: 'fill' | 'copy';
  expectedOrigin?: string;
  expectedDocumentId?: string;
  password?: string;
}

const TERMINAL: readonly OperationState[] = ['complete', 'cancelled', 'error'];

export class AutofillController {
  private readonly operations = new Map<string, Operation>();

  constructor(private readonly devices: DeviceManager, private readonly oath: OathClient) {}

  get(id: string): OperationView | undefined {
    const operation = this.operations.get(id);
    if (!operation) return undefined;
    if (operation.copy && !isOtpValid(operation.copy.calculatedAt, operation.copy.expiresAt, Date.now())) {
      this.finish(operation, 'error', 'The code expired. Retry.');
    }
    return operation.view;
  }

  private require(id: string, states: OperationState[]): Operation {
    const view = this.get(id);
    const operation = this.operations.get(id);
    if (!operation || !view || !states.includes(view.state)) {
      throw new AppError('OPERATION_EXPIRED', 'This operation is no longer available. Start again.');
    }
    return operation;
  }

  private update(operation: Operation, patch: Partial<OperationView>): void {
    operation.view = { ...operation.view, ...patch };
  }

  private finish(operation: Operation, state: 'complete' | 'cancelled' | 'error', message?: string): void {
    delete operation.copy;
    clearTimeout(operation.codeTimeout);
    operation.passwords.clear();
    this.update(operation, { state, message, credentials: [], lockedDevices: [] });
    delete operation.view.deviceId;
    delete operation.view.credentialName;
    delete operation.view.passwordDevice;
    delete operation.view.passwordDeviceId;
    this.clearStatus(operation, true);
  }

  private clearStatus({ view }: Operation, release = false): void {
    void chrome.action.setBadgeText({ tabId: view.target.tabId, text: '' }).catch(() => undefined);
    void this.sendContent(view.target, { type: 'content:status', operationId: view.id, state: 'clear', release }).catch(() => undefined);
  }

  async inspect(tabId: number, expectedOrigin?: string, expectedDocumentId?: string): Promise<AutofillTarget> {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active || !tab.url) throw new AppError('TARGET_INVALID', 'The target tab is no longer active.');
    const origin = normalizeOrigin(tab.url);
    if (expectedOrigin !== undefined && origin !== expectedOrigin) {
      throw new AppError('TARGET_CHANGED', 'The target website changed. Start again.');
    }
    const [injected] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content-scripts/content.js'] });
    const documentId = injected?.documentId;
    if (!documentId || (expectedDocumentId !== undefined && expectedDocumentId !== documentId)) {
      throw new AppError('DOCUMENT_CHANGED', 'The target page changed. Start again.');
    }
    return { tabId, origin, documentId, windowId: tab.windowId };
  }

  async hasField(target: AutofillTarget): Promise<boolean> {
    const reply = await this.sendContent(target, { type: 'content:inspect' });
    return reply.ok && (reply.data as Pick<PrepareResult, 'found'> | undefined)?.found === true;
  }

  async start(tabId: number, options: StartOptions = {}): Promise<OperationView> {
    const target = await this.inspect(tabId, options.expectedOrigin, options.expectedDocumentId);
    const id = crypto.randomUUID().replaceAll('-', '');
    this.cancelTab(tabId);
    const operation: Operation = {
      view: { id, target, mode: options.mode ?? 'fill', state: 'calculating', credentials: [], lockedDevices: [], ...options.selection },
      passwords: new Map(),
      timeout: setTimeout(() => {
        this.cancel(id);
        this.operations.delete(id);
      }, MAX_OPERATION_AGE_MS),
    };
    this.operations.set(id, operation);
    if (options.password && options.selection) operation.passwords.set(options.selection.deviceId, options.password);
    await this.run(operation, async () => {
      if (operation.view.mode === 'fill') {
        const reply = await this.sendContent(target, { type: 'content:prepare', operationId: id });
        const result = reply.data as PrepareResult | undefined;
        if (!reply.ok || !result) throw new AppError('DOCUMENT_UNAVAILABLE', 'The target page is unavailable.');
        if (!result.found) this.update(operation, { formIssue: result.reason ?? 'not-found' });
      }
      if (options.selection) await this.continueSelection(operation, options.selection);
      else await this.findAccounts(operation);
    });
    const state = operation.view.state;
    if (!['complete', 'cancelled'].includes(state) && !(options.mode === 'copy' && state === 'ready-to-fill')) {
      await this.openInteraction(operation);
    }
    return operation.view;
  }

  private async findAccounts(operation: Operation, unlocked?: { deviceId: string; credentials: Credential[] }): Promise<void> {
    const status = await this.devices.status();
    const credentials: Credential[] = [];
    const lockedDevices: DeviceInfo[] = [];
    let unavailable = status.authorizedCount > status.devices.length;
    for (const device of status.devices) {
      if (operation.view.state !== 'calculating') return;
      try {
        const accounts = unlocked?.deviceId === device.id ? unlocked.credentials : await this.oath.list(device.id, operation.passwords.get(device.id));
        credentials.push(...accounts);
      } catch (error) {
        if (error instanceof AppError && ['OATH_PASSWORD_REQUIRED', 'OATH_AUTH'].includes(error.code)) lockedDevices.push(device);
        else unavailable = true;
      }
    }
    const matches = matchingCredentials(credentials, operation.view.target.origin, await getMappings());
    if (operation.view.state !== 'calculating') return;
    if (matches.length === 1 && !lockedDevices.length && !unavailable) {
      const credential = matches[0]!;
      this.update(operation, { deviceId: credential.deviceId, credentialName: credential.nameHex });
      await this.continueSelection(operation, { deviceId: credential.deviceId, credentialName: credential.nameHex }, credential);
      return;
    }
    const selectable = matches.length ? matches : credentials;
    this.update(operation, { credentials: selectable, lockedDevices });
    if (!selectable.length && lockedDevices.length === 1) {
      this.update(operation, { state: 'password-required', passwordDevice: lockedDevices[0], passwordDeviceId: lockedDevices[0]!.id });
    } else if (!selectable.length && !lockedDevices.length) {
      this.update(operation, {
        state: status.devices.length && !unavailable ? 'no-accounts' : 'device-required',
        message: unavailable ? 'CanoKey could not be read. Retry.' : undefined,
      });
    } else {
      this.update(operation, { state: 'select-account', message: unavailable ? 'Some CanoKeys could not be read.' : undefined });
    }
  }

  async select(id: string, selection: AutofillSelection, mode: 'fill' | 'copy'): Promise<void> {
    const operation = this.require(id, ['select-account']);
    if (!operation.view.credentials.some((item) => item.deviceId === selection.deviceId && item.nameHex === selection.credentialName)) {
      throw new AppError('CREDENTIAL_NOT_FOUND', 'Choose an account from this list.');
    }
    if (mode !== 'fill' && mode !== 'copy') throw new AppError('OPERATION_INVALID', 'Invalid action.');
    this.update(operation, { ...selection, mode, state: 'calculating', message: undefined });
    await this.run(operation, () => this.continueSelection(operation, selection));
  }

  async password(id: string, deviceId: string, password: string): Promise<void> {
    const operation = this.require(id, ['password-required', 'select-account']);
    const { view } = operation;
    if (!password || (view.state === 'password-required' ? view.passwordDeviceId !== deviceId : !view.lockedDevices.some((item) => item.id === deviceId))) {
      throw new AppError('PASSWORD_REQUIRED', 'Enter the OATH password for the selected CanoKey.');
    }
    operation.passwords.set(deviceId, password);
    this.update(operation, { state: 'calculating', message: undefined });
    await this.run(operation, async () => {
      if (view.deviceId && view.credentialName) {
        await this.continueSelection(operation, { deviceId: view.deviceId, credentialName: view.credentialName });
      } else {
        this.update(operation, { passwordDeviceId: deviceId });
        const credentials = await this.oath.list(deviceId, password);
        if (operation.view.state === 'calculating') await this.findAccounts(operation, { deviceId, credentials });
      }
    });
  }

  async retry(id: string): Promise<void> {
    const operation = this.require(id, ['device-required', 'no-accounts']);
    const { deviceId, credentialName } = operation.view;
    this.update(operation, { state: 'calculating', message: undefined });
    await this.run(operation, () => deviceId && credentialName
      ? this.continueSelection(operation, { deviceId, credentialName })
      : this.findAccounts(operation));
  }

  private async continueSelection(operation: Operation, selection: AutofillSelection, resolved?: Credential): Promise<void> {
    if (operation.view.state !== 'calculating') return;
    if (operation.view.formIssue && operation.view.mode === 'fill') {
      this.update(operation, { state: 'copy-required' });
      return;
    }
    this.update(operation, {
      passwordDeviceId: selection.deviceId,
      passwordDevice: operation.view.lockedDevices.find((device) => device.id === selection.deviceId),
    });
    const { target, id, mode } = operation.view;
    await this.validateTarget(target, mode === 'fill' ? id : undefined);
    const password = operation.passwords.get(selection.deviceId);
    const credential = resolved ?? (await this.oath.list(selection.deviceId, password)).find((item) => item.nameHex === selection.credentialName);
    if (!credential) throw new AppError('CREDENTIAL_NOT_FOUND', 'This account is no longer available on the CanoKey.');
    if (operation.view.state !== 'calculating') return;
    let window = totpWindow(Date.now(), credential.period);
    try {
      if (window.waitMs) {
        await new Promise((resolve) => setTimeout(resolve, window.waitMs));
        if (operation.view.state !== 'calculating') return;
        await this.validateTarget(target, mode === 'fill' ? id : undefined);
        window.challenge.fill(0);
        window = totpWindow(Date.now(), credential.period, false);
      }
      const code = await this.oath.calculate(credential.deviceId, credential, window.challenge, {
        onWaiting: () => {
          if (operation.view.state !== 'calculating') return;
          this.update(operation, { state: 'touch-required' });
          void this.sendContent(target, { type: 'content:status', operationId: id, state: 'touch-required' }).catch(() => undefined);
          void chrome.action.setBadgeText({ tabId: target.tabId, text: 'TOUCH' }).catch(() => undefined);
        },
      }, password);
      if (!['calculating', 'touch-required'].includes(operation.view.state)) return;
      await this.validateTarget(target, mode === 'fill' ? id : undefined);
      if (!['calculating', 'touch-required'].includes(operation.view.state)) return;
      if (!isOtpValid(window.calculatedAt, window.expiresAt, Date.now())) throw new AppError('OTP_EXPIRED', 'The code expired. Retry.');
      operation.passwords.clear();
      if (mode === 'fill') {
        const result = await this.sendContent(target, { type: 'content:fill', operationId: id, code });
        if (!['calculating', 'touch-required'].includes(operation.view.state)) return;
        if (result.ok) {
          this.finish(operation, 'complete');
          return;
        }
        this.update(operation, { message: 'Could not fill the field. You can copy the code.' });
      }
      operation.copy = { code, calculatedAt: window.calculatedAt, expiresAt: window.expiresAt };
      operation.codeTimeout = setTimeout(() => {
        if (operation.copy) this.finish(operation, 'error', 'The code expired. Retry.');
      }, Math.max(0, window.expiresAt - Date.now()));
      this.update(operation, { state: 'ready-to-fill' });
      this.clearStatus(operation);
    } finally {
      window.challenge.fill(0);
    }
  }

  async copy(id: string): Promise<CopyResult | undefined> {
    const operation = this.require(id, ['copy-required', 'ready-to-fill']);
    if (operation.view.state === 'copy-required') {
      const { deviceId, credentialName } = operation.view;
      if (!deviceId || !credentialName) throw new AppError('CREDENTIAL_REQUIRED', 'Select an account.');
      this.update(operation, { state: 'calculating', mode: 'copy' });
      await this.run(operation, () => this.continueSelection(operation, { deviceId, credentialName }));
      if (this.get(id)?.state !== 'ready-to-fill') return undefined;
    }
    await this.validateTarget(operation.view.target);
    const current = this.get(id);
    const result = operation.copy;
    if (!result || current?.state !== 'ready-to-fill') return undefined;
    this.finish(operation, 'complete');
    return { code: result.code, expiresAt: result.expiresAt };
  }

  private async validateTarget(target: AutofillTarget, operationId?: string): Promise<void> {
    const tab = await chrome.tabs.get(target.tabId).catch(() => undefined);
    if (!tab?.active || tabOrigin(tab.pendingUrl || tab.url) !== target.origin) {
      throw new AppError('TARGET_CHANGED', 'The target tab or website changed. Start again.');
    }
    const result = await this.sendContent(target, { type: 'content:validate', operationId: operationId ?? '', requireField: operationId !== undefined }).catch(() => undefined);
    if (!result?.ok) throw new AppError('DOCUMENT_CHANGED', 'The target page or field changed. Start again.');
  }

  private sendContent(target: AutofillTarget, message: ContentMessage): Promise<MessageResponse> {
    return chrome.tabs.sendMessage(target.tabId, message, { frameId: 0, documentId: target.documentId });
  }

  private async run(operation: Operation, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (TERMINAL.includes(operation.view.state)) return;
      const message = errorMessage(error);
      if (error instanceof AppError && ['OATH_PASSWORD_REQUIRED', 'OATH_AUTH'].includes(error.code) && operation.view.passwordDeviceId) {
        operation.passwords.delete(operation.view.passwordDeviceId);
        this.update(operation, { state: 'password-required', message });
        this.clearStatus(operation);
      } else if (error instanceof AppError && ['DEVICE_REQUIRED', 'DEVICE_NOT_FOUND', 'WEBUSB_INTERFACE'].includes(error.code)) {
        this.update(operation, { state: 'device-required', message });
        this.clearStatus(operation);
      } else {
        this.finish(operation, 'error', message);
      }
    }
  }

  cancel(id: string): void {
    const operation = this.operations.get(id);
    if (operation && !TERMINAL.includes(operation.view.state)) this.finish(operation, 'cancelled');
  }

  cancelTab(tabId: number): void {
    for (const { view } of this.operations.values()) {
      if (view.target.tabId === tabId) this.cancel(view.id);
    }
  }

  cancelOtherTabs(activeTabId: number, windowId: number): void {
    for (const { view } of this.operations.values()) {
      if (view.target.windowId === windowId && view.target.tabId !== activeTabId) this.cancel(view.id);
    }
  }

  disconnect(serial?: string): void {
    for (const { view, passwords } of this.operations.values()) {
      if (!serial || view.deviceId === serial || passwords.has(serial) || view.credentials.some((item) => item.deviceId === serial)) this.cancel(view.id);
    }
  }

  closedInteraction(windowId: number): void {
    for (const [id, operation] of this.operations) {
      if (operation.interactionWindowId !== windowId) continue;
      this.cancel(id);
      clearTimeout(operation.timeout);
      this.operations.delete(id);
    }
  }

  private async openInteraction(operation: Operation): Promise<void> {
    operation.interaction ??= chrome.windows.create({
      url: chrome.runtime.getURL(`operation.html?op=${operation.view.id}`),
      type: 'popup', width: 440, height: 620, focused: true,
    }).then((window) => {
      if (window?.id !== undefined) operation.interactionWindowId = window.id;
    });
    await operation.interaction;
  }
}

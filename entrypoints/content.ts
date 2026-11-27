import { discoverOtpTarget, fillOtpTarget, type OtpTarget } from '../lib/otp-form';
import type { ContentMessage, MessageResponse } from '../lib/types';

export default defineContentScript({
  matches: ['https://*/*'],
  registration: 'runtime',
  main(ctx) {
    const operations = new Map<string, OtpTarget>();
    let status: HTMLDivElement | undefined;
    let statusOperation: string | undefined;
    let completed = false;

    function showStatus(state: 'touch-required' | 'calculating' | 'complete' | 'clear'): void {
      status?.remove();
      status = undefined;
      if (state === 'clear') return;
      const text = state === 'touch-required' ? 'Touch your CanoKey' : state === 'calculating' ? 'Waiting for CanoKey…' : 'TOTP filled by CanoKey';
      status = document.createElement('div');
      status.setAttribute('role', 'status');
      status.textContent = text;
      status.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;pointer-events:none;background:#161616;color:#fff;padding:10px 14px;border-radius:6px;font:14px system-ui;box-shadow:0 2px 12px #0004;';
      document.documentElement.append(status);
      if (state === 'complete') {
        const completedStatus = status;
        setTimeout(() => completedStatus.remove(), 2500);
      }
    }

    const receive = (message: ContentMessage, _sender: chrome.runtime.MessageSender, sendResponse: (response: MessageResponse) => void) => {
      if (message?.type === 'content:inspect') {
        const discovery = discoverOtpTarget();
        sendResponse({ ok: true, data: { found: Boolean(discovery.target), reason: discovery.reason } });
        return false;
      }
      if (!message || typeof message !== 'object' || !('operationId' in message) || typeof message.operationId !== 'string') return false;
      const target = operations.get(message.operationId);
      if (message.type === 'content:prepare') {
        const discovery = discoverOtpTarget();
        if (discovery.target) {
          operations.set(message.operationId, discovery.target);
          setTimeout(() => operations.delete(message.operationId), 90_000);
        }
        sendResponse({ ok: true, data: { found: Boolean(discovery.target), reason: discovery.reason } });
        return false;
      }
      if (message.type === 'content:validate') {
        sendResponse({ ok: message.requireField === false || Boolean(target && target.elements.every((input) => input.isConnected)) });
        return false;
      }
      if (message.type === 'content:status') {
        if (message.state === 'clear') {
          if (message.release) operations.delete(message.operationId);
          if (statusOperation === message.operationId && !completed) showStatus('clear');
        } else {
          statusOperation = message.operationId;
          completed = false;
          showStatus(message.state);
        }
        sendResponse({ ok: true });
        return false;
      }
      if (message.type === 'content:fill') {
        const filled = Boolean(target && /^\d{4,8}$/.test(message.code) && fillOtpTarget(target, message.code));
        if (filled) {
          operations.delete(message.operationId);
          statusOperation = message.operationId;
          completed = true;
          showStatus('complete');
        }
        sendResponse({ ok: filled });
        return false;
      }
      return false;
    };
    chrome.runtime.onMessage.addListener(receive);
    ctx.onInvalidated(() => {
      chrome.runtime.onMessage.removeListener(receive);
      status?.remove();
      operations.clear();
    });
  },
});

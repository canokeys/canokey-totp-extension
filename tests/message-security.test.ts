import { describe, expect, it } from 'vitest';
import { assertMessageSender } from '../lib/message-security';
import type { Message } from '../lib/types';

const id = 'extension-id';
const extensionUrl = `chrome-extension://${id}/`;
const privileged = { id, url: `${extensionUrl}popup.html` } as chrome.runtime.MessageSender;
const content = { id, url: 'https://example.com/login', origin: 'https://example.com', frameId: 0, documentId: 'document-1', tab: { id: 1 } } as chrome.runtime.MessageSender;

describe('internal message sender validation', () => {
  it('accepts only this extension for privileged APIs', () => {
    const message: Message = { type: 'device:list' };
    expect(() => assertMessageSender(message, privileged, id, extensionUrl)).not.toThrow();
    for (const sender of [{ ...privileged, id: 'other' }, { ...privileged, url: 'https://example.com' }, { ...privileged, url: undefined }, { ...content, url: 'https://example.com' }]) {
      expect(() => assertMessageSender(message, sender as chrome.runtime.MessageSender, id, extensionUrl)).toThrow();
    }
  });

  it('binds helper requests to the top frame, document, tab and exact origin', () => {
    const message: Message = { type: 'helper:clicked', origin: 'https://example.com' };
    expect(() => assertMessageSender(message, content, id, extensionUrl)).not.toThrow();
    const invalid = [
      { ...content, frameId: 1 },
      { ...content, documentId: undefined },
      { ...content, tab: undefined },
      { ...content, origin: 'https://example.com.evil.test' },
      { ...content, url: 'https://sub.example.com/login' },
      { ...content, id: 'other' },
    ];
    for (const sender of invalid) expect(() => assertMessageSender(message, sender as chrome.runtime.MessageSender, id, extensionUrl)).toThrow();
  });
});

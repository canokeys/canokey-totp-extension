import { AppError } from './errors';
import { normalizeOrigin } from './origin';
import type { Message } from './types';

export function assertMessageSender(message: Message, sender: chrome.runtime.MessageSender, extensionId: string, extensionUrl: string): void {
  if (sender.id !== extensionId) throw new AppError('SENDER_INVALID', 'Invalid extension sender.');
  if (message.type === 'helper:clicked' || message.type === 'helper:status') {
    if (sender.tab?.id === undefined || sender.frameId !== 0 || !sender.documentId || sender.origin !== message.origin || normalizeOrigin(sender.url ?? '') !== message.origin) {
      throw new AppError('SENDER_INVALID', 'Invalid content-script sender.');
    }
    return;
  }
  if (!sender.url?.startsWith(extensionUrl)) throw new AppError('SENDER_INVALID', 'Only extension pages can use this API.');
}

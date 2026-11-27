import type { Message, MessageResponse } from './types';

export async function send<T>(message: Message): Promise<T> {
  const response: MessageResponse<T> = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    const error = new Error(response?.error ?? 'The extension operation failed.') as Error & { code?: string };
    if (response?.code) error.code = response.code;
    throw error;
  }
  return response.data as T;
}

export async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error('No active tab is available.');
  return tab;
}

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

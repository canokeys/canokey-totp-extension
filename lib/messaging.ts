import type { Message, MessageResponse } from './types';

export const DEVICE_AUTHORIZED_CHANNEL = 'canokey-device-authorized';

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

export async function openDeviceSettings(): Promise<void> {
  // Chrome's USB chooser needs a normal tab. A separate window keeps the verification tab active.
  await chrome.windows.create({ url: chrome.runtime.getURL('options.html#devices'), type: 'normal', width: 900, height: 700 });
}

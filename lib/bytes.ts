export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9A-Fa-f]{2})+$/.test(hex)) throw new Error('Invalid hexadecimal data');
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

export function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}

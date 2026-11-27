import { formatCredentialName } from './oath-name';
import type { ImportPreview, TotpDraft } from './types';
import { wipe } from './bytes';

export function decodeBase32(input: string): Uint8Array {
  let accumulator = 0;
  let bits = 0;
  const output = new Uint8Array(Math.floor(input.length * 5 / 8));
  let length = 0;
  for (const character of input.toUpperCase()) {
    if (character === '=' || character === ' ' || character === '-') continue;
    const value = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(character);
    if (value < 0) {
      wipe(output);
      throw new Error('Invalid base32 secret');
    }
    accumulator = (accumulator << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output[length++] = (accumulator >>> bits) & 0xff;
    }
  }
  if (bits >= 5 || (accumulator & ((1 << bits) - 1)) !== 0) {
    wipe(output);
    throw new Error('Invalid base32 secret padding');
  }
  if (length === 0 || length > 64) {
    wipe(output);
    throw new Error('CanoKey accepts secrets containing 1 to 64 bytes');
  }
  const result = output.slice(0, length);
  wipe(output);
  return result;
}

function validateDraft(draft: TotpDraft): TotpDraft {
  if (!draft.account || draft.account.length > 64) throw new Error('Account name is required');
  if (draft.issuer !== undefined && draft.issuer.length > 64) throw new Error('Issuer is too long');
  if (!['SHA1', 'SHA256', 'SHA512'].includes(draft.algorithm)) throw new Error('Unsupported algorithm');
  if (!Number.isInteger(draft.digits) || draft.digits < 4 || draft.digits > 8) throw new Error('Digits must be between 4 and 8');
  if (!Number.isSafeInteger(draft.period) || draft.period < 1 || draft.period > 86_400) throw new Error('Invalid period');
  if (draft.secret.length < 1 || draft.secret.length > 64) throw new Error('Secret must contain 1 to 64 bytes');
  return draft;
}

export function parseOtpAuth(uri: string): TotpDraft {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    throw new Error('Invalid otpauth URI');
  }
  if (url.protocol !== 'otpauth:' || url.hostname.toLowerCase() !== 'totp') throw new Error('Only TOTP otpauth URIs are supported');
  const recognized = ['secret', 'issuer', 'algorithm', 'digits', 'period'];
  for (const key of recognized) {
    if (url.searchParams.getAll(key).length > 1) throw new Error(`Duplicate ${key} parameter`);
  }
  const label = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const separator = label.indexOf(':');
  const labelIssuer = separator >= 0 ? label.slice(0, separator) : undefined;
  const account = separator >= 0 ? label.slice(separator + 1) : label;
  const secretText = url.searchParams.get('secret');
  if (!secretText) throw new Error('Missing secret');
  const algorithm = (url.searchParams.get('algorithm') ?? 'SHA1').toUpperCase() as TotpDraft['algorithm'];
  const digits = Number(url.searchParams.get('digits') ?? 6);
  const period = Number(url.searchParams.get('period') ?? 30);
  const secret = decodeBase32(secretText);
  const issuer = url.searchParams.get('issuer') ?? labelIssuer;
  try {
    return validateDraft({
      ...(issuer ? { issuer } : {}),
      account,
      secret,
      algorithm,
      digits,
      period,
    });
  } catch (error) {
    wipe(secret);
    throw error;
  }
}

export function encodeBase32(data: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let output = '';
  let accumulator = 0;
  let bits = 0;
  for (const byte of data) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(accumulator >>> bits) & 31];
    }
  }
  if (bits > 0) output += alphabet[(accumulator << (5 - bits)) & 31];
  return output;
}

export function importPreview(draft: TotpDraft): ImportPreview {
  validateDraft(draft);
  return {
    ...(draft.issuer ? { issuer: draft.issuer } : {}),
    account: draft.account,
    algorithm: draft.algorithm,
    digits: draft.digits,
    period: draft.period,
    name: formatCredentialName(draft.issuer, draft.account, draft.period),
  };
}

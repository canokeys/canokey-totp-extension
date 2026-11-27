import type { Algorithm } from './types';

export interface ParsedCredentialName {
  issuer?: string;
  account: string;
  period: number;
}

export function parseCredentialName(raw: string, kind: 'totp' | 'hotp' = 'totp'): ParsedCredentialName {
  let rest = raw;
  let period = kind === 'totp' ? 30 : 0;
  if (kind === 'totp') {
    const match = /^([1-9][0-9]*)\/(.*)$/.exec(rest);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        period = parsed;
        rest = match[2] ?? '';
      }
    }
  }
  if (!rest.startsWith(':')) {
    const separator = rest.indexOf(':');
    if (separator >= 0) {
      return { issuer: rest.slice(0, separator), account: rest.slice(separator + 1), period };
    }
  }
  return { account: rest, period };
}

export function formatCredentialName(issuer: string | undefined, account: string, period = 30): string {
  let name = `${issuer ? `${issuer}:` : ''}${account}`;
  const ambiguous = /^[0-9]+\//.test(name);
  if (period !== 30 || ambiguous) name = `${period}/${name}`;
  return name;
}

export function algorithmFromWire(value: number): Algorithm | null {
  return ({ 1: 'SHA1', 2: 'SHA256', 3: 'SHA512' } as const)[value as 1 | 2 | 3] ?? null;
}

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatCredentialName, parseCredentialName } from '../lib/oath-name';
import { DEFAULT_MAPPINGS, matchingCredentials, normalizeOrigin } from '../lib/origin';
import { decodeBase32, encodeBase32, importPreview, parseOtpAuth } from '../lib/otpauth';
import { isOtpValid, periodMilliseconds, totpWindow } from '../lib/totp-time';
import { changeMapping, getCustomMappings, getMappings, MAPPINGS_KEY } from '../lib/storage';
import type { Credential } from '../lib/types';

const local = new Map<string, unknown>();
beforeEach(() => {
  local.clear();
  vi.stubGlobal('chrome', { storage: { local: {
    get: vi.fn(async (key: string) => ({ [key]: local.get(key) })),
    set: vi.fn(async (values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) local.set(key, value); }),
  } } });
});

describe('OATH names', () => {
  it('parses issuer, account and non-default periods', () => {
    expect(parseCredentialName('60/GitHub:alice:work')).toEqual({ issuer: 'GitHub', account: 'alice:work', period: 60 });
    expect(parseCredentialName('GitHub:alice')).toEqual({ issuer: 'GitHub', account: 'alice', period: 30 });
    expect(parseCredentialName(':alice')).toEqual({ account: ':alice', period: 30 });
    expect(parseCredentialName('30/15/account')).toEqual({ account: '15/account', period: 30 });
    expect(formatCredentialName(undefined, '15/account')).toBe('30/15/account');
    expect(formatCredentialName('GitHub', 'alice', 45)).toBe('45/GitHub:alice');
  });
});

describe('TOTP windows', () => {
  it('encodes big-endian challenges for arbitrary periods', () => {
    const window = totpWindow(61_000, 60);
    expect(window.step).toBe(1n);
    expect([...window.challenge]).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(window.expiresAt).toBe(120_000);
    expect(window.waitMs).toBe(0);
  });

  it('waits for the next window near expiry without calculating ahead immediately', () => {
    const window = totpWindow(27_000, 30);
    expect(window.waitMs).toBe(3000);
    expect(window.step).toBe(1n);
    expect(window.calculatedAt).toBe(30_000);
    expect(totpWindow(25_999, 30).step).toBe(0n);
    expect(totpWindow(26_000, 30).waitMs).toBe(4000);
  });

  it('rejects results outside their validity window and invalid periods', () => {
    expect(isOtpValid(1000, 31_000, 30_999)).toBe(true);
    expect(isOtpValid(1000, 31_000, 31_000)).toBe(false);
    expect(isOtpValid(1000, 31_000, 999)).toBe(false);
    expect(() => periodMilliseconds(0)).toThrow('Invalid TOTP period');
  });

  it.each([1, 2, 3, 4])('gives a %d-second credential a usable calculation window', (period) => {
    const boundary = period * 1000;
    expect(totpWindow(boundary - 1, period).waitMs).toBe(1);
    expect(totpWindow(boundary, period)).toMatchObject({ waitMs: 0, step: 1n, expiresAt: 2 * boundary });
    expect(totpWindow(2 * boundary - 1, period, false)).toMatchObject({ waitMs: 0, step: 1n });
  });
});

describe('origin access control', () => {
  it('normalizes only exact HTTPS origins', () => {
    expect(normalizeOrigin('https://github.com/login?next=x')).toBe('https://github.com');
    expect(normalizeOrigin('https://EXAMPLE.com:443/a')).toBe('https://example.com');
    expect(normalizeOrigin('https://example.com:8443/a')).toBe('https://example.com:8443');
    for (const value of ['http://example.com', 'https://user@example.com', 'file:///tmp/a']) expect(() => normalizeOrigin(value)).toThrow();
  });

  it('matches issuers and exact origins with both built-in and custom entries', async () => {
    const account: Credential = { deviceId: '01020304', name: 'GitHub:alice', nameHex: '61', issuer: ' GitHub ', account: 'alice', algorithm: 'SHA1', period: 30 };
    expect(matchingCredentials([account], 'https://github.com', DEFAULT_MAPPINGS)).toEqual([account]);
    for (const origin of ['https://github.com.example.com', 'https://gist.github.com', 'https://github.com:8443']) {
      expect(matchingCredentials([account], origin, DEFAULT_MAPPINGS)).toEqual([]);
    }
    await changeMapping({ issuer: 'github', origin: 'https://example.com:8443/login' });
    expect(matchingCredentials([account], 'https://example.com:8443', await getMappings())).toEqual([account]);
    expect(matchingCredentials([account], 'https://example.com', await getMappings())).toEqual([]);
  });

  it('edits and removes custom mappings without writing built-in entries or duplicates', async () => {
    const mapping = { issuer: 'Example', origin: 'https://example.com' };
    const second = { issuer: 'Other', origin: 'https://example.com' };
    await Promise.all([changeMapping(mapping), changeMapping(second)]);
    await changeMapping({ issuer: 'EXAMPLE', origin: 'https://example.com/test' });
    await changeMapping({ issuer: ' GitHub ', origin: 'https://github.com' });
    expect(await getCustomMappings()).toEqual([mapping, second]);
    expect([...local.keys()]).toEqual([MAPPINGS_KEY]);
    const updated = { ...mapping, origin: 'https://example.com:8443' };
    await changeMapping(updated, mapping);
    await changeMapping(undefined, second);
    expect(await getCustomMappings()).toEqual([updated]);
  });
});

describe('otpauth import', () => {
  it('parses and validates TOTP parameters locally', () => {
    const draft = parseOtpAuth('otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA256&digits=8&period=60');
    expect(draft.account).toBe('alice');
    expect(draft.issuer).toBe('GitHub');
    expect(draft.algorithm).toBe('SHA256');
    expect(draft.digits).toBe(8);
    expect(draft.period).toBe(60);
    expect(encodeBase32(draft.secret)).toBe('JBSWY3DPEHPK3PXP');
    expect(importPreview(draft).name).toBe('60/GitHub:alice');
  });

  it('rejects HOTP, malformed base32, invalid digits and duplicate parameters', () => {
    for (const uri of [
      'otpauth://hotp/a?secret=JBSWY3DP',
      'https://totp/a?secret=JBSWY3DP',
      'otpauth://totp/a?secret=!',
      'otpauth://totp/a?secret=A',
      'otpauth://totp/a?secret=JBSWY3DP&digits=9',
      'otpauth://totp/a?secret=JBSWY3DP&period=0',
      'otpauth://totp/a?secret=JBSWY3DP&secret=JBSWY3DP',
    ]) expect(() => parseOtpAuth(uri)).toThrow();
  });

  it('handles padding and whitespace without accepting non-zero trailing bits', () => {
    expect([...decodeBase32('MY======')]).toEqual([0x66]);
    expect(encodeBase32(decodeBase32('my======'))).toBe('MY');
    expect(() => decodeBase32('MZ')).toThrow();
    expect(() => decodeBase32('')).toThrow();
  });
});

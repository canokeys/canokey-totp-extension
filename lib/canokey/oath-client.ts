import { encodeUtf8, toHex, wipe } from '../bytes';
import { AppError } from '../errors';
import { algorithmFromWire, formatCredentialName, parseCredentialName } from '../oath-name';
import type { Credential, TotpDraft } from '../types';
import type { DeviceManager } from './device-manager';
import type { ApduTransport, TransportEvents } from './transport';
import type { CanokeyWasm, OathRequest } from './wasm';

const SELECT = 1;
const LIST = 3;
const PUT = 4;
const CALCULATE = 7;
const TRUNCATED = 1;

async function deriveAccessKey(password: string, handle: Uint8Array): Promise<Uint8Array> {
  const passwordBytes = encodeUtf8(password);
  const salt = handle.slice();
  let derived: ArrayBuffer | undefined;
  try {
    const key = await crypto.subtle.importKey('raw', passwordBytes.buffer as ArrayBuffer, 'PBKDF2', false, ['deriveBits']);
    derived = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-1', salt: salt.buffer, iterations: 1000 }, key, 128);
    return new Uint8Array(derived).slice();
  } finally {
    wipe(passwordBytes);
    wipe(salt);
    if (derived) new Uint8Array(derived).fill(0);
  }
}

export class OathClient {
  constructor(private readonly devices: DeviceManager) {}

  private async accessRequest(
    profile: number,
    password: string | undefined,
    run: (access: Pick<OathRequest, 'accessKey' | 'hostChallenge'> | undefined) => Promise<number>,
    wasm: CanokeyWasm,
    transport: ApduTransport,
  ): Promise<number> {
    if (!password) return run(undefined);
    const selected = await wasm.runOath(profile, { kind: SELECT }, transport);
    let handle: Uint8Array | undefined;
    try {
      const selection = wasm.selection(selected);
      if (!selection.locked) throw new AppError('OATH_NOT_PROTECTED', 'The OATH applet does not have an access password.');
      handle = selection.handle;
      if (!handle) throw new AppError('OATH_LEGACY_PASSWORD', 'This firmware does not support OATH access passwords.');
    } finally {
      wasm.freeOperation(selected);
    }
    const accessKey = await deriveAccessKey(password, handle);
    const hostChallenge = crypto.getRandomValues(new Uint8Array(8));
    try {
      return await run({ accessKey, hostChallenge });
    } finally {
      wipe(accessKey);
      wipe(hostChallenge);
    }
  }

  list(deviceId: string, password?: string): Promise<Credential[]> {
    return this.devices.withProfile(deviceId, {}, async ({ profile, transport }, wasm) => {
      const entries = await this.listEntries(profile, password, wasm, transport);
      return entries.flatMap((entry): Credential[] => {
        if ((entry.algorithmType & 0xf0) !== 0x20) return [];
        const algorithm = algorithmFromWire(entry.algorithmType & 0x0f);
        if (!algorithm) return [];
        const parsed = parseCredentialName(entry.name);
        return [{
          deviceId,
          name: entry.name,
          nameHex: entry.nameHex,
          ...(parsed.issuer ? { issuer: parsed.issuer } : {}),
          account: parsed.account,
          algorithm,
          ...(entry.digits ? { digits: entry.digits } : {}),
          period: parsed.period,
        }];
      });
    });
  }

  private async listEntries(profile: number, password: string | undefined, wasm: CanokeyWasm, transport: ApduTransport) {
    const execute = (access: Pick<OathRequest, 'accessKey' | 'hostChallenge'> | undefined) => wasm.runOath(profile, { kind: LIST, ...access }, transport);
    let operation: number;
    try {
      operation = await this.accessRequest(profile, password, execute, wasm, transport);
    } catch (error) {
      if (password || !(error instanceof AppError) || error.code !== 'OATH_PASSWORD_REQUIRED') throw error;
      throw new AppError('OATH_PASSWORD_REQUIRED', 'Enter the OATH access password to read this CanoKey.');
    }
    try {
      return wasm.entries(operation);
    } finally {
      wasm.freeOperation(operation);
    }
  }

  async import(deviceId: string, draft: TotpDraft, touch: boolean, password?: string, beforeWrite?: () => Promise<unknown>): Promise<Credential> {
    const name = formatCredentialName(draft.issuer, draft.account, draft.period);
    const nameBytes = encodeUtf8(name);
    try {
      if (nameBytes.length > 64) {
        throw new AppError('NAME_TOO_LONG', 'Issuer and account must fit the 64-byte CanoKey credential name limit.');
      }
      const nameHex = toHex(nameBytes);
      await this.devices.withProfile(deviceId, {}, async ({ profile, transport }, wasm) => {
        const entries = await this.listEntries(profile, password, wasm, transport);
        if (entries.some((entry) => entry.nameHex === nameHex)) {
          throw new AppError('CREDENTIAL_EXISTS', 'A credential with this name already exists. Choose a different issuer or account.');
        }
        const operation = await this.accessRequest(profile, password, async (access) => {
          if (beforeWrite) await beforeWrite();
          return wasm.runOath(profile, {
            kind: PUT,
            nameHex,
            secret: draft.secret,
            credentialKind: 2,
            algorithm: draft.algorithm,
            digits: draft.digits,
            properties: touch ? 2 : 0,
            ...access,
          }, transport);
        }, wasm, transport);
        wasm.freeOperation(operation);
      });
      return {
        deviceId,
        name,
        nameHex,
        ...(draft.issuer ? { issuer: draft.issuer } : {}),
        account: draft.account,
        algorithm: draft.algorithm,
        digits: draft.digits,
        period: draft.period,
      };
    } finally {
      wipe(nameBytes);
      wipe(draft.secret);
    }
  }

  calculate(deviceId: string, credential: Credential, challenge: Uint8Array, events: TransportEvents, password?: string): Promise<string> {
    return this.devices.withProfile(deviceId, events, async ({ profile, transport }, wasm) => {
      const operation = await this.accessRequest(profile, password, (access) => wasm.runOath(profile, {
        kind: CALCULATE,
        nameHex: credential.nameHex,
        credentialKind: 2,
        algorithm: credential.algorithm,
        challenge,
        format: TRUNCATED,
        ...access,
      }, transport), wasm, transport);
      try {
        return wasm.decimal(operation);
      } finally {
        wasm.freeOperation(operation);
      }
    });
  }
}

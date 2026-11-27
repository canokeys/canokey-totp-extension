import { readFileSync } from 'node:fs';
import { createHmac, pbkdf2Sync } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fromHex, toHex } from '../lib/bytes';
import { AppError } from '../lib/errors';
import { CanokeyWasm } from '../lib/canokey/wasm';
import type { ApduTransport } from '../lib/canokey/transport';
import { OathClient } from '../lib/canokey/oath-client';
import type { DeviceManager } from '../lib/canokey/device-manager';

const bytes = readFileSync(`${process.cwd()}/public/wasm/canokey.wasm`);
let wasm: CanokeyWasm;

class Transcript implements ApduTransport {
  readonly commands: Uint8Array[] = [];
  constructor(private readonly steps: Array<{ command: string; response: string }>) {}
  async exchange(command: Uint8Array): Promise<Uint8Array> {
    this.commands.push(command.slice());
    const step = this.steps.shift();
    if (!step) throw new Error(`Unexpected APDU ${toHex(command)}`);
    expect(toHex(command).toLowerCase()).toBe(step.command.toLowerCase());
    return fromHex(step.response);
  }
  done() { expect(this.steps).toHaveLength(0); }
}

const textHex = (value: string) => toHex(new TextEncoder().encode(value));
const select = '00a4040007a0000005272101';
const legacySelect = `${select}00`;
const unprotected = `79030600007108${textHex('12345678')}9000`;
const protectedSelection = `${unprotected.slice(0, -4)}7408${textHex('CCCCCCCC')}7b01019000`;

async function profile(version = '3.1.0'): Promise<number> {
  const transport = new Transcript([
    { command: '00a4040005f00000000000', response: '9000' },
    { command: '0031000000', response: `${textHex(version)}9000` },
    { command: '0031010000', response: '6d00' },
    { command: '0032000000', response: '010203049000' },
  ]);
  const probed = await wasm.probe(transport);
  transport.done();
  expect(probed.info.id).toBe('01020304');
  expect(probed.info.firmware).toBe(version);
  return probed.profile;
}

beforeAll(async () => { wasm = await CanokeyWasm.fromBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer); });

describe('production libcanokey WASM APDU transcripts', () => {
  it('probes identity, enumerates modern TOTP and handles A5 pagination', async () => {
    const device = await profile();
    const name = 'GitHub:alice';
    const entry = `720d21${textHex(name)}`;
    const transport = new Transcript([
      { command: select, response: unprotected },
      { command: '00a10000ff', response: `${entry}9000` },
      { command: '00a50000ff', response: '6985' },
    ]);
    try {
      const operation = await wasm.runOath(device, { kind: 3 }, transport);
      try {
        expect(wasm.entries(operation)).toMatchObject([{ name, algorithmType: 0x21 }]);
      } finally { wasm.freeOperation(operation); }
      transport.done();
    } finally { wasm.freeProfile(device); }
  });

  it('calculates one modern TOTP with the supplied 60-second challenge', async () => {
    const device = await profile();
    const name = '60/GitHub:alice';
    const nameTlv = `71${(new TextEncoder().encode(name).length).toString(16).padStart(2, '0')}${textHex(name)}`;
    const challenge = '0000000000000001';
    const body = `${nameTlv}7408${challenge}`;
    const transport = new Transcript([
      { command: select, response: unprotected },
      { command: `00a20001${(fromHex(body).length).toString(16).padStart(2, '0')}${body}`, response: '7605060000002a9000' },
    ]);
    try {
      const operation = await wasm.runOath(device, { kind: 7, nameHex: textHex(name), credentialKind: 2, algorithm: 'SHA1', challenge: fromHex(challenge), format: 1 }, transport);
      try { expect(wasm.decimal(operation)).toBe('000042'); } finally { wasm.freeOperation(operation); }
      transport.done();
      expect(transport.commands.some((command) => command[1] === 0xa4 && command[2] === 0 && command[3] === 1)).toBe(false);
    } finally { wasm.freeProfile(device); }
  });

  it('performs bidirectional OATH access authentication without fallback', async () => {
    const device = await profile();
    const key = new TextEncoder().encode('KKKKKKKKKKKKKKKK');
    const host = new TextEncoder().encode('HHHHHHHH');
    const hostProof = '0de0bae281ba21980e7692c934529f0f61111651';
    const deviceProof = 'caa1346e39058dd36ed76fb49053e14f66ce428b';
    const body = `7514${hostProof}7408${textHex('HHHHHHHH')}`;
    const transport = new Transcript([
      { command: select, response: protectedSelection },
      { command: `00a3000020${body}`, response: `7514${deviceProof}9000` },
      { command: '00a10000ff', response: '9000' },
    ]);
    try {
      const operation = await wasm.runOath(device, { kind: 3, accessKey: key, hostChallenge: host }, transport);
      wasm.freeOperation(operation);
      transport.done();
    } finally { wasm.freeProfile(device); }
  });

  it('imports SHA512, eight digits and touch protection without exportability', async () => {
    const device = await profile();
    const transport = new Transcript([
      { command: select, response: unprotected },
      { command: '000100000a710161730323082a7802', response: '9000' },
    ]);
    try {
      const operation = await wasm.runOath(device, { kind: 4, nameHex: '61', secret: new Uint8Array([42]), credentialKind: 2, algorithm: 'SHA512', digits: 8, properties: 2 }, transport);
      wasm.freeOperation(operation);
      transport.done();
    } finally { wasm.freeProfile(device); }
  });

  it('uses the legacy 1.3 list, pagination and single-credential calculate protocol', async () => {
    const device = await profile('1.3');
    const transport = new Transcript([
      { command: legacySelect, response: '9000' },
      { command: '00030000ff', response: `7101617502210661ff` },
      { command: '00060000ff', response: `710161750212089000` },
      { command: '00060000ff', response: '6985' },
    ]);
    try {
      const list = await wasm.runOath(device, { kind: 3 }, transport);
      try { expect(wasm.entries(list)).toMatchObject([{ name: 'a', algorithmType: 0x21, digits: 6 }, { name: 'a', algorithmType: 0x12, digits: 8 }]); } finally { wasm.freeOperation(list); }
      transport.done();
      const calculateTransport = new Transcript([
        { command: legacySelect, response: '9000' },
        { command: '000400000d7101617408000000000000000000', response: '7605060000002a9000' },
      ]);
      const calculation = await wasm.runOath(device, { kind: 7, nameHex: '61', credentialKind: 2, algorithm: 'SHA1', challenge: new Uint8Array(8), format: 1 }, calculateTransport);
      try { expect(wasm.decimal(calculation)).toBe('000042'); } finally { wasm.freeOperation(calculation); }
      calculateTransport.done();
    } finally { wasm.freeProfile(device); }
  });

  it('preserves transport failures instead of replacing them with protocol errors', async () => {
    const device = await profile();
    const failure = new AppError('USB_WRITE', 'write failed');
    try {
      await expect(wasm.runOath(device, { kind: 3 }, { exchange: async () => { throw failure; } })).rejects.toBe(failure);
    } finally { wasm.freeProfile(device); }
  });
});

describe('OathClient integration', () => {
  it('derives the PBKDF2 access key from password and SELECT salt', async () => {
    const device = await profile();
    let authenticated = false;
    const transport: ApduTransport = {
      async exchange(command) {
        const hex = toHex(command).toLowerCase();
        if (hex === select) return fromHex(protectedSelection);
        if (command[1] === 0xa3) {
          expect(command[2]).toBe(0);
          expect(command[3]).toBe(0);
          const hostProof = command.slice(7, 27);
          const hostChallenge = command.slice(29, 37);
          const key = fromHex('f531154d46d1bdbbcc1fcce02d6b4c93');
          expect(pbkdf2Sync('password', '12345678', 1000, 16, 'sha1').toString('hex')).toBe(toHex(key).toLowerCase());
          const expected = createHmac('sha1', key).update('CCCCCCCC').digest('hex');
          expect(toHex(hostProof).toLowerCase()).toBe(expected);
          authenticated = true;
          return new Uint8Array([0x75, 20, ...createHmac('sha1', key).update(hostChallenge).digest(), 0x90, 0]);
        }
        if (command[1] === 0xa2) return fromHex('7605060000002a9000');
        throw new Error(`Unexpected APDU ${hex}`);
      },
    };
    const manager = { withProfile: vi.fn(async (_id: string, _events: unknown, action: (session: { profile: number; transport: ApduTransport }, instance: CanokeyWasm) => Promise<string>) => action({ profile: device, transport }, wasm)) } as unknown as DeviceManager;
    try {
      const client = new OathClient(manager);
      await expect(client.calculate('01020304', { deviceId: '01020304', name: 'a', nameHex: '61', account: 'a', algorithm: 'SHA1', digits: 6, period: 30 }, new Uint8Array(8), {}, 'password')).resolves.toBe('000042');
      expect(authenticated).toBe(true);
    } finally { wasm.freeProfile(device); }
  });

  it('refuses to overwrite a same-name credential and wipes the temporary secret', async () => {
    const secret = new Uint8Array([1, 2, 3]);
    const device = await profile();
    const transport = new Transcript([
      { command: select, response: unprotected },
      { command: '00a10000ff', response: `720d21${textHex('GitHub:alice')}9000` },
      { command: '00a50000ff', response: '6985' },
    ]);
    const manager = {
      withProfile: async (_id: string, _events: unknown, action: (session: { profile: number; transport: ApduTransport }, instance: CanokeyWasm) => Promise<unknown>) => action({ profile: device, transport }, wasm),
    } as unknown as DeviceManager;
    try {
      const client = new OathClient(manager);
      await expect(client.import('01020304', { issuer: 'GitHub', account: 'alice', secret, algorithm: 'SHA1', digits: 6, period: 30 }, true)).rejects.toMatchObject({ code: 'CREDENTIAL_EXISTS' });
      expect(secret).toEqual(new Uint8Array(3));
      transport.done();
    } finally {
      wasm.freeProfile(device);
    }
  });
});

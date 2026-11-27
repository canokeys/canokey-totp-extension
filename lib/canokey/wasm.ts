import { fromHex, toHex, utf8, wipe } from '../bytes';
import { AppError } from '../errors';
import type { Algorithm } from '../types';
import type { ApduTransport } from './transport';

interface WasmExports {
  memory: WebAssembly.Memory;
  cnk_wasm_alloc(size: number): number;
  cnk_wasm_free(pointer: number, size: number): void;
  cnk_wasm_zero(pointer: number, size: number): void;
  cnk_probe_device_new(mode: number, options: number, out: number, error: number): number;
  cnk_operation_take_profile(operation: number, out: number): number;
  cnk_profile_free(profile: number): void;
  cnk_profile_serial_u32(profile: number, out: number): number;
  cnk_profile_firmware_text(profile: number, buffer: number, length: number): number;
  cnk_profile_model_copy(profile: number, buffer: number, length: number): number;
  cnk_operation_free(operation: number): void;
  cnk_operation_start(operation: number, step: number, error: number): number;
  cnk_operation_advance(operation: number, response: number, length: number, step: number, error: number): number;
  cnk_operation_command(operation: number, buffer: number, length: number): number;
  cnk_operation_error(operation: number, error: number): number;
  cnk_oath_new(profile: number, request: number, options: number, out: number, error: number): number;
  cnk_operation_oath_info(operation: number, index: number, info: number): number;
  cnk_operation_oath_copy(operation: number, index: number, field: number, buffer: number, length: number): number;
}

export interface DeviceProfile {
  id: string;
  serial: string;
  firmware: string;
  model: string;
}

export interface OathSelection {
  locked: boolean;
  handle?: Uint8Array;
  legacy: boolean;
}

export interface OathEntry {
  nameHex: string;
  name: string;
  algorithmType: number;
  digits?: number;
}

export interface OathRequest {
  kind: number;
  nameHex?: string;
  secret?: Uint8Array;
  accessKey?: Uint8Array;
  hostChallenge?: Uint8Array;
  challenge?: Uint8Array;
  credentialKind?: number;
  algorithm?: Algorithm;
  digits?: number;
  properties?: number;
  format?: number;
}

const ERROR_SIZE = 24;
const REQUEST_SIZE = 80;
const INFO_SIZE = 48;
const EXCHANGE = 1;
const DONE = 2;

export class CanokeyWasm {
  private constructor(private readonly exports: WasmExports) {}

  static async load(url: string): Promise<CanokeyWasm> {
    const response = await fetch(url);
    const bytes = await response.arrayBuffer();
    return CanokeyWasm.fromBytes(bytes);
  }

  static async fromBytes(bytes: ArrayBuffer): Promise<CanokeyWasm> {
    const module = await WebAssembly.instantiate(bytes, {});
    return new CanokeyWasm(module.instance.exports as unknown as WasmExports);
  }

  private u32(pointer: number, value: number): void {
    new DataView(this.exports.memory.buffer).setUint32(pointer, value, true);
  }

  private readU32(pointer: number): number {
    return new DataView(this.exports.memory.buffer).getUint32(pointer, true);
  }

  private alloc(size: number): number {
    const pointer = this.exports.cnk_wasm_alloc(size);
    if (!pointer) throw new AppError('WASM_MEMORY', 'CanoKey protocol memory allocation failed.');
    return pointer;
  }

  private free(pointer: number, size: number, sensitive = false): void {
    if (!pointer) return;
    if (sensitive) this.exports.cnk_wasm_zero(pointer, size);
    this.exports.cnk_wasm_free(pointer, size);
  }

  private withBuffer<T>(bytes: Uint8Array, sensitive: boolean, action: (pointer: number) => T): T {
    const pointer = this.alloc(Math.max(1, bytes.length));
    try {
      new Uint8Array(this.exports.memory.buffer, pointer, bytes.length).set(bytes);
      return action(pointer);
    } finally {
      this.free(pointer, Math.max(1, bytes.length), sensitive);
    }
  }

  private withNumber<T>(action: (pointer: number) => T): T {
    const pointer = this.alloc(4);
    try {
      this.u32(pointer, 0);
      return action(pointer);
    } finally {
      this.free(pointer, 4);
    }
  }

  private check(status: number, errorPointer = 0): void {
    if (status === 0) return;
    if (status === 5 && errorPointer) this.throwProtocolError(errorPointer);
    throw new AppError('WASM_ABI', `CanoKey protocol call failed (${status}).`);
  }

  private throwProtocolError(pointer: number): never {
    const view = new DataView(this.exports.memory.buffer, pointer, ERROR_SIZE);
    const kind = view.getUint32(4, true);
    const status = view.getUint16(20, true);
    const messages: Record<number, [string, string]> = {
      6: ['OATH_AUTH', 'The OATH password is incorrect.'],
      8: ['OATH_PASSWORD_REQUIRED', 'The OATH applet requires a password.'],
      9: ['DEVICE_CONDITIONS', 'The CanoKey applet rejected the operation in its current state.'],
      10: ['CREDENTIAL_NOT_FOUND', 'The credential no longer exists. Rebind the account.'],
      12: ['UNSUPPORTED_FIRMWARE', 'This operation is not supported by the device firmware.'],
      13: ['UNSUPPORTED_ALGORITHM', 'This algorithm is not supported by the device firmware.'],
      14: ['UNKNOWN_FIRMWARE', 'This firmware capabilities are unknown; the operation was not attempted.'],
      18: ['DEVICE_AUTH', 'CanoKey authentication proof could not be verified.'],
    };
    const [code, message] = messages[kind] ?? ['PROTOCOL_ERROR', `CanoKey rejected the operation (kind ${kind}, status ${status.toString(16).toUpperCase()}).`];
    throw new AppError(code, message);
  }

  private copy(call: (buffer: number, length: number) => number, sensitive = false, optional = false): Uint8Array {
    return this.withNumber((length) => {
      const initial = call(0, length);
      if (optional && initial === 4) return new Uint8Array();
      this.check(initial);
      const size = this.readU32(length);
      const pointer = this.alloc(Math.max(1, size));
      try {
        this.u32(length, size);
        this.check(call(pointer, length));
        return new Uint8Array(this.exports.memory.buffer, pointer, size).slice();
      } finally {
        this.free(pointer, Math.max(1, size), sensitive);
      }
    });
  }

  private start(operation: number): number {
    return this.withNumber((step) => this.withBuffer(new Uint8Array(ERROR_SIZE), false, (error) => {
      new DataView(this.exports.memory.buffer).setUint32(error, ERROR_SIZE, true);
      const status = this.exports.cnk_operation_start(operation, step, error);
      this.check(status, error);
      return this.readU32(step);
    }));
  }

  private command(operation: number): Uint8Array {
    return this.copy((buffer, length) => this.exports.cnk_operation_command(operation, buffer, length));
  }

  private advance(operation: number, response: Uint8Array): number {
    return this.withNumber((step) => this.withBuffer(response, true, (responsePointer) => this.withBuffer(new Uint8Array(ERROR_SIZE), false, (error) => {
      new DataView(this.exports.memory.buffer).setUint32(error, ERROR_SIZE, true);
      const status = this.exports.cnk_operation_advance(operation, responsePointer, response.length, step, error);
      this.check(status, error);
      return this.readU32(step);
    })));
  }

  private async drive(operation: number, transport: ApduTransport): Promise<void> {
    let step = this.start(operation);
    try {
      while (step === EXCHANGE) {
        const command = this.command(operation);
        try {
          const response = await transport.exchange(command);
          try {
            step = this.advance(operation, response);
          } finally {
            wipe(response);
          }
        } finally {
          wipe(command);
        }
      }
      if (step !== DONE) throw new AppError('PROTOCOL_STATE', 'CanoKey protocol operation did not complete.');
    } catch (error) {
      this.withBuffer(new Uint8Array(ERROR_SIZE), false, (pointer) => {
        new DataView(this.exports.memory.buffer).setUint32(pointer, ERROR_SIZE, true);
        if (this.exports.cnk_operation_error(operation, pointer) === 0 && new DataView(this.exports.memory.buffer, pointer, ERROR_SIZE).getUint32(4, true) !== 0) this.throwProtocolError(pointer);
      });
      throw error;
    }
  }

  async probe(transport: ApduTransport): Promise<{ profile: number; info: DeviceProfile }> {
    const operation = this.withNumber((out) => this.withBuffer(new Uint8Array(ERROR_SIZE), false, (error) => {
      new DataView(this.exports.memory.buffer).setUint32(error, ERROR_SIZE, true);
      const status = this.exports.cnk_probe_device_new(0, 0, out, error);
      this.check(status, error);
      return this.readU32(out);
    }));
    try {
      await this.drive(operation, transport);
      const profile = this.withNumber((out) => {
        this.check(this.exports.cnk_operation_take_profile(operation, out));
        return this.readU32(out);
      });
      const serialNumber = this.withNumber((out) => {
        this.check(this.exports.cnk_profile_serial_u32(profile, out));
        return this.readU32(out);
      });
      const serial = serialNumber.toString(16).toUpperCase().padStart(8, '0');
      const firmwareBytes = this.copy((buffer, length) => this.exports.cnk_profile_firmware_text(profile, buffer, length));
      const modelBytes = this.copy((buffer, length) => this.exports.cnk_profile_model_copy(profile, buffer, length), false, true);
      return { profile, info: { id: serial, serial, firmware: utf8(firmwareBytes), model: utf8(modelBytes) } };
    } finally {
      this.exports.cnk_operation_free(operation);
    }
  }

  createOathOperation(profile: number, request: OathRequest): number {
    const requestPointer = this.alloc(REQUEST_SIZE);
    const errorPointer = this.alloc(ERROR_SIZE);
    const buffers: Array<{ pointer: number; size: number; sensitive: boolean }> = [];
    try {
      new Uint8Array(this.exports.memory.buffer, requestPointer, REQUEST_SIZE).fill(0);
      this.u32(requestPointer, REQUEST_SIZE);
      this.u32(requestPointer + 4, request.kind);
      const attach = (offset: number, bytes: Uint8Array | undefined, sensitive = false) => {
        if (!bytes) return;
        const pointer = this.alloc(Math.max(1, bytes.length));
        buffers.push({ pointer, size: Math.max(1, bytes.length), sensitive });
        new Uint8Array(this.exports.memory.buffer, pointer, bytes.length).set(bytes);
        this.u32(requestPointer + offset, pointer);
        this.u32(requestPointer + offset + 4, bytes.length);
      };
      attach(8, request.nameHex ? fromHex(request.nameHex) : undefined);
      attach(24, request.secret, true);
      attach(32, request.accessKey, true);
      attach(40, request.hostChallenge, true);
      attach(48, request.challenge);
      this.u32(requestPointer + 56, request.credentialKind ?? 0);
      this.u32(requestPointer + 60, request.algorithm ? { SHA1: 1, SHA256: 2, SHA512: 3 }[request.algorithm] : 0);
      this.u32(requestPointer + 64, request.digits ?? 0);
      this.u32(requestPointer + 68, request.properties ?? 0);
      this.u32(requestPointer + 76, request.format ?? 0);
      this.u32(errorPointer, ERROR_SIZE);
      const operation = this.withNumber((out) => {
        const status = this.exports.cnk_oath_new(profile, requestPointer, 0, out, errorPointer);
        this.check(status, errorPointer);
        return this.readU32(out);
      });
      new Uint8Array(this.exports.memory.buffer, requestPointer, REQUEST_SIZE).fill(0);
      return operation;
    } finally {
      this.free(requestPointer, REQUEST_SIZE, true);
      this.free(errorPointer, ERROR_SIZE);
      for (const buffer of buffers) this.free(buffer.pointer, buffer.size, buffer.sensitive);
    }
  }

  async runOath(profile: number, request: OathRequest, transport: ApduTransport): Promise<number> {
    const operation = this.createOathOperation(profile, request);
    try {
      await this.drive(operation, transport);
      return operation;
    } catch (error) {
      this.exports.cnk_operation_free(operation);
      throw error;
    }
  }

  freeOperation(operation: number): void {
    this.exports.cnk_operation_free(operation);
  }

  freeProfile(profile: number): void {
    this.exports.cnk_profile_free(profile);
  }

  oathInfo(operation: number, index = 0): { kind: number; count: number; algorithmType: number; digits: number; codeKind: number; flags: number; handle: Uint8Array } {
    const pointer = this.alloc(INFO_SIZE);
    try {
      new Uint8Array(this.exports.memory.buffer, pointer, INFO_SIZE).fill(0);
      this.u32(pointer, INFO_SIZE);
      this.check(this.exports.cnk_operation_oath_info(operation, index, pointer));
      const view = new DataView(this.exports.memory.buffer, pointer, INFO_SIZE);
      return {
        kind: view.getUint32(4, true),
        count: view.getUint32(8, true),
        algorithmType: view.getUint32(12, true),
        digits: view.getUint32(16, true),
        codeKind: view.getUint32(20, true),
        flags: view.getUint32(24, true),
        handle: new Uint8Array(this.exports.memory.buffer, pointer + 32, 8).slice(),
      };
    } finally {
      this.free(pointer, INFO_SIZE);
    }
  }

  oathCopy(operation: number, index: number, field: number, sensitive = false): Uint8Array {
    return this.copy((buffer, length) => this.exports.cnk_operation_oath_copy(operation, index, field, buffer, length), sensitive);
  }

  selection(operation: number): OathSelection {
    const info = this.oathInfo(operation);
    const legacy = info.kind === 5;
    const locked = !legacy && (info.flags & 1) !== 0;
    const result: OathSelection = { locked, legacy };
    if (info.kind === 1) result.handle = info.handle;
    return result;
  }

  entries(operation: number): OathEntry[] {
    const info = this.oathInfo(operation);
    return Array.from({ length: info.count }, (_, index) => {
      const item = this.oathInfo(operation, index);
      const raw = this.oathCopy(operation, index, 2);
      return {
        nameHex: toHex(raw),
        name: utf8(raw),
        algorithmType: item.algorithmType,
        ...(item.digits ? { digits: item.digits } : {}),
      };
    });
  }

  decimal(operation: number): string {
    const bytes = this.oathCopy(operation, 0, 4, true);
    try {
      return utf8(bytes);
    } finally {
      wipe(bytes);
    }
  }
}

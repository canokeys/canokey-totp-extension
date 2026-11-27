import { AppError } from '../errors';
import type { DeviceInfo, DeviceStatus } from '../types';
import { CanokeyWasm, type DeviceProfile } from './wasm';
import type { ApduTransport, TransportEvents } from './transport';
import { authorizedCanoKeys, WebUsbTransport } from './webusb';

interface ProfileSession {
  profile: number;
  info: DeviceProfile;
  transport: ApduTransport;
}

export class DeviceManager {
  private wasmPromise?: Promise<CanokeyWasm>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly wasmUrl: string) {}

  private wasm(): Promise<CanokeyWasm> {
    this.wasmPromise ??= CanokeyWasm.load(this.wasmUrl);
    return this.wasmPromise;
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action, action);
    this.queue = result.catch(() => undefined);
    return result;
  }

  status(): Promise<DeviceStatus> {
    return this.enqueue(async () => {
      const devices = await authorizedCanoKeys();
      const result: DeviceInfo[] = [];
      for (const device of devices) {
        try {
          result.push(await this.probeUsbDevice(device));
        } catch {
          // One busy or disconnected device must not hide other authorized keys.
        }
      }
      return { devices: result, authorizedCount: devices.length };
    });
  }

  private async probeUsbDevice(device: USBDevice): Promise<DeviceInfo> {
    const wasm = await this.wasm();
    const { transport, close } = await WebUsbTransport.open(device);
    let profile = 0;
    try {
      const probed = await wasm.probe(transport);
      profile = probed.profile;
      return { ...probed.info, productName: device.productName ?? 'CanoKey' };
    } finally {
      if (profile) wasm.freeProfile(profile);
      await close().catch(() => undefined);
    }
  }

  withProfile<T>(deviceId: string, events: TransportEvents, action: (session: ProfileSession, wasm: CanokeyWasm) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const wasm = await this.wasm();
      const devices = await authorizedCanoKeys();
      if (devices.length === 0) throw new AppError('DEVICE_REQUIRED', 'Connect and authorize a CanoKey.');
      const sorted = [...devices].sort((left, right) => Number(right.serialNumber?.toUpperCase() === deviceId) - Number(left.serialNumber?.toUpperCase() === deviceId));
      let lastError: unknown;
      for (const device of sorted) {
        let profile = 0;
        let close: (() => Promise<void>) | undefined;
        let selected = device.serialNumber?.toUpperCase() === deviceId;
        try {
          const opened = await WebUsbTransport.open(device, events);
          close = opened.close;
          const probed = await wasm.probe(opened.transport);
          profile = probed.profile;
          selected = probed.info.id === deviceId;
          if (!selected) {
            wasm.freeProfile(profile);
            profile = 0;
            await close();
            close = undefined;
            continue;
          }
          return await action({ profile, info: probed.info, transport: opened.transport }, wasm);
        } catch (error) {
          if (selected) throw error;
          lastError = error;
        } finally {
          if (profile) wasm.freeProfile(profile);
          if (close) await close().catch(() => undefined);
        }
      }
      if (lastError && devices.length === 1) throw lastError instanceof Error ? lastError : new AppError('DEVICE_ERROR', 'The CanoKey operation failed.');
      throw new AppError('DEVICE_NOT_FOUND', 'The selected CanoKey is not connected or authorized.');
    });
  }
}

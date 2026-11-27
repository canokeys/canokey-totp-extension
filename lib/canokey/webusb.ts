import { AppError } from '../errors';
import type { ApduTransport, TransportEvents } from './transport';

export const CANOKEY_USB_FILTER = { vendorId: 0x20a0, productId: 0x42d4 } as const;
const RESPONSE_READY = 0;
const RESPONSE_PROCESSING = 1;
const COMMAND_TIMEOUT_MS = 5000;
const TOUCH_TIMEOUT_MS = 40_000;

function bytes(view: DataView | undefined): Uint8Array {
  if (!view) return new Uint8Array();
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeout: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AppError('DEVICE_TIMEOUT', 'The CanoKey operation timed out.')), timeout);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export function findWebUsbInterface(device: USBDevice): { interfaceNumber: number; alternateSetting: number } {
  const configuration = device.configuration;
  if (!configuration) throw new AppError('DEVICE_CONFIGURATION', 'CanoKey has no active USB configuration.');
  for (const usbInterface of configuration.interfaces) {
    for (const alternate of usbInterface.alternates) {
      if (alternate.interfaceClass === 0xff && alternate.interfaceSubclass === 0xff && alternate.interfaceProtocol === 0xff && alternate.endpoints.length === 0) {
        return { interfaceNumber: usbInterface.interfaceNumber, alternateSetting: alternate.alternateSetting };
      }
    }
  }
  throw new AppError('WEBUSB_INTERFACE', 'No CanoKey WebUSB interface was found. Check that WebUSB is enabled on the device.');
}

export class WebUsbTransport implements ApduTransport {
  private constructor(
    private readonly device: USBDevice,
    private readonly interfaceNumber: number,
    private readonly events: TransportEvents,
  ) {}

  static async open(device: USBDevice, events: TransportEvents = {}): Promise<{ transport: WebUsbTransport; close: () => Promise<void> }> {
    if (!device.opened) await device.open();
    let selection: ReturnType<typeof findWebUsbInterface>;
    try {
      selection = findWebUsbInterface(device);
      await device.claimInterface(selection.interfaceNumber);
      if (selection.alternateSetting !== 0) await device.selectAlternateInterface(selection.interfaceNumber, selection.alternateSetting);
    } catch (error) {
      await device.close().catch(() => undefined);
      throw error;
    }
    const { interfaceNumber } = selection;
    const transport = new WebUsbTransport(device, interfaceNumber, events);
    return {
      transport,
      close: async () => {
        try {
          await device.releaseInterface(interfaceNumber);
        } finally {
          await device.close();
        }
      },
    };
  }

  private setup(request: number): USBControlTransferParameters {
    return { requestType: 'vendor', recipient: 'interface', request, value: 0, index: this.interfaceNumber };
  }

  async exchange(command: Uint8Array): Promise<Uint8Array> {
    return withTimeout(this.exchangeInner(command), TOUCH_TIMEOUT_MS + COMMAND_TIMEOUT_MS);
  }

  private async exchangeInner(command: Uint8Array): Promise<Uint8Array> {
    const output = await withTimeout(this.device.controlTransferOut(this.setup(0), command.slice().buffer), COMMAND_TIMEOUT_MS);
    if (output.status !== 'ok' || output.bytesWritten !== command.length) {
      throw new AppError('USB_WRITE', 'CanoKey did not accept the complete command.');
    }
    const started = Date.now();
    let notified = false;
    while (true) {
      const statusResult = await withTimeout(this.device.controlTransferIn(this.setup(2), 1), COMMAND_TIMEOUT_MS);
      const state = bytes(statusResult.data)[0];
      if (statusResult.status !== 'ok' || state === undefined) throw new AppError('USB_STATUS', 'CanoKey returned an invalid transport status.');
      if (state === RESPONSE_READY) break;
      if (state !== RESPONSE_PROCESSING) throw new AppError('USB_STATE', 'CanoKey is busy or in an unexpected transport state.');
      if (Date.now() - started > TOUCH_TIMEOUT_MS) throw new AppError('TOUCH_TIMEOUT', 'Touch confirmation timed out. Try again.');
      if (!notified && Date.now() - started > 700) {
        notified = true;
        this.events.onWaiting?.();
      }
      await delay(20);
    }
    const response = await withTimeout(this.device.controlTransferIn(this.setup(1), 4096), COMMAND_TIMEOUT_MS);
    if (response.status !== 'ok') throw new AppError('USB_READ', 'CanoKey response transfer failed.');
    const result = bytes(response.data);
    if (result.length < 2) throw new AppError('USB_RESPONSE', 'CanoKey returned a truncated APDU response.');
    return result;
  }
}

export async function requestCanoKey(): Promise<USBDevice> {
  if (!navigator.usb) throw new AppError('WEBUSB_UNSUPPORTED', 'This browser does not support WebUSB.');
  return navigator.usb.requestDevice({ filters: [CANOKEY_USB_FILTER] });
}

export async function authorizedCanoKeys(): Promise<USBDevice[]> {
  if (!navigator.usb) return [];
  return (await navigator.usb.getDevices()).filter((device) => device.vendorId === CANOKEY_USB_FILTER.vendorId && device.productId === CANOKEY_USB_FILTER.productId);
}

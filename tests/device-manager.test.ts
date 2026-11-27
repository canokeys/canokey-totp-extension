import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceManager } from '../lib/canokey/device-manager';
import { CanokeyWasm } from '../lib/canokey/wasm';
import { authorizedCanoKeys, WebUsbTransport } from '../lib/canokey/webusb';

vi.mock('../lib/canokey/webusb', () => ({
  authorizedCanoKeys: vi.fn(),
  WebUsbTransport: { open: vi.fn() },
}));

const device = { serialNumber: '01020304' } as USBDevice;

afterEach(() => { vi.restoreAllMocks(); });

describe('device operation serialization', () => {
  it('runs concurrent requests one at a time and closes each USB session', async () => {
    const close = vi.fn(async () => undefined);
    vi.mocked(authorizedCanoKeys).mockResolvedValue([device]);
    vi.mocked(WebUsbTransport).open.mockResolvedValue({ transport: {} as WebUsbTransport, close });
    vi.spyOn(CanokeyWasm, 'load').mockResolvedValue({
      probe: async () => ({ profile: 1, info: { id: '01020304', serial: '01020304', firmware: '3.1.0', model: 'CanoKey' } }),
      freeProfile: vi.fn(),
    } as unknown as CanokeyWasm);
    const manager = new DeviceManager('chrome-extension://test/wasm/canokey.wasm');
    const events: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = manager.withProfile('01020304', {}, async () => {
      events.push('first:start');
      await blocked;
      events.push('first:end');
    });
    await vi.waitFor(() => expect(events).toEqual(['first:start']));
    const second = manager.withProfile('01020304', {}, async () => { events.push('second'); });
    await Promise.resolve();
    expect(vi.mocked(WebUsbTransport).open.mock.calls).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
    expect(vi.mocked(WebUsbTransport).open.mock.calls).toHaveLength(2);
    expect(close).toHaveBeenCalledTimes(2);
  });
});

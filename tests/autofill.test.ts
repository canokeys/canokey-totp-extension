import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AutofillController } from '../lib/autofill-controller';
import { AppError } from '../lib/errors';
import type { DeviceManager } from '../lib/canokey/device-manager';
import type { OathClient } from '../lib/canokey/oath-client';
import type { ContentMessage, Credential } from '../lib/types';

const DEVICE = { id: '01020304', productName: 'CanoKey', serial: '01020304', model: '', firmware: '3.1.0' };
const ACCOUNT: Credential = { deviceId: DEVICE.id, name: 'Example:alice', nameHex: '61', issuer: 'Example', account: 'alice', algorithm: 'SHA1', period: 30 };
const selection = { deviceId: DEVICE.id, credentialName: ACCOUNT.nameHex };
let sent: ContentMessage[];
let list: ReturnType<typeof vi.fn>;
let calculate: ReturnType<typeof vi.fn>;
let devices: DeviceManager;
let oath: OathClient;
let formFound: boolean;
let prepared: string | undefined;
let controller: AutofillController;
let tab: { id: number; active: boolean; url: string; windowId: number };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(10_000);
  sent = [];
  formFound = true;
  prepared = undefined;
  tab = { id: 1, active: true, url: 'https://example.com/verify', windowId: 1 };
  list = vi.fn(async () => [ACCOUNT]);
  calculate = vi.fn(async () => '123456');
  devices = { status: vi.fn(async () => ({ devices: [DEVICE], authorizedCount: 1 })) } as unknown as DeviceManager;
  oath = { list, calculate } as unknown as OathClient;
  controller = new AutofillController(devices, oath);
  vi.stubGlobal('chrome', {
    storage: {
      local: { get: vi.fn(async () => ({ 'issuer-mappings.v1': [{ issuer: 'Example', origin: 'https://example.com' }] })) },
    },
    tabs: {
      get: vi.fn(async () => tab),
      sendMessage: vi.fn(async (_tabId: number, message: ContentMessage) => {
        sent.push(message);
        if (message.type === 'content:prepare') {
          prepared = formFound ? message.operationId : undefined;
          return { ok: true, data: { found: formFound } };
        }
        if (message.type === 'content:status' && message.release && prepared === message.operationId) prepared = undefined;
        if (message.type === 'content:validate') {
          return { ok: tab.url === 'https://example.com/verify' && (message.requireField === false || prepared === message.operationId) };
        }
        return { ok: true };
      }),
    },
    scripting: { executeScript: vi.fn(async () => [{ documentId: 'document-1' }]) },
    action: { setBadgeText: vi.fn(async () => undefined) },
    windows: { create: vi.fn(async () => ({ id: 2 })) },
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
  });
});

afterEach(() => {
  controller.cancelTab(1);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function start(mode: 'fill' | 'copy' = 'fill') {
  return controller.start(1, { selection, mode });
}

describe('autofill operation lifecycle', () => {
  it('calculates from the live device for a unique issuer match', async () => {
    const operation = await controller.start(1);
    expect(operation.state).toBe('complete');
    expect(list).toHaveBeenCalledOnce();
    expect(calculate).toHaveBeenCalledOnce();
    expect(calculate.mock.calls[0]?.[1]).toEqual(ACCOUNT);
    expect(sent.filter((message) => message.type === 'content:fill')).toEqual([
      { type: 'content:fill', operationId: operation.id, code: '123456' },
    ]);
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('uses a single action for one of multiple matches and rejects accounts removed from the device', async () => {
    const second = { ...ACCOUNT, nameHex: '62', account: 'bob' };
    list.mockResolvedValueOnce([ACCOUNT, second]).mockResolvedValueOnce([ACCOUNT]);
    const operation = await controller.start(1);
    expect(operation.state).toBe('select-account');
    expect(calculate).not.toHaveBeenCalled();
    await controller.select(operation.id, { deviceId: DEVICE.id, credentialName: second.nameHex }, 'fill');
    expect(controller.get(operation.id)).toMatchObject({ state: 'error' });
    expect(calculate).not.toHaveBeenCalled();
  });

  it('waits for an explicit copy action when the OTP field is unavailable', async () => {
    formFound = false;
    const operation = await start();
    expect(operation).toMatchObject({ state: 'copy-required', formIssue: 'not-found' });
    expect(calculate).not.toHaveBeenCalled();
    expect(await controller.copy(operation.id)).toEqual({ code: '123456', expiresAt: 30_000 });
    expect(sent.some((message) => message.type === 'content:fill')).toBe(false);
    await expect(controller.copy(operation.id)).rejects.toThrow();
  });

  it('keeps a fallback copy tied to the document that was inspected', async () => {
    formFound = false;
    const operation = await start();
    tab.url = 'https://example.com/another-page';
    expect(await controller.copy(operation.id)).toBeUndefined();
    expect(calculate).not.toHaveBeenCalled();
  });

  it('discards a late device result after user cancellation', async () => {
    const pendingCode = deferred<string>();
    calculate.mockReturnValue(pendingCode.promise);
    const pending = start();
    await vi.waitFor(() => expect(calculate).toHaveBeenCalled());
    controller.cancelTab(1);
    pendingCode.resolve('123456');
    expect((await pending).state).toBe('cancelled');
    expect(sent.some((message) => message.type === 'content:fill')).toBe(false);
  });

  it.each(['navigation', 'tab-switch'])('discards a result after %s', async (change) => {
    const pendingCode = deferred<string>();
    calculate.mockReturnValue(pendingCode.promise);
    const pending = start();
    await vi.waitFor(() => expect(calculate).toHaveBeenCalled());
    if (change === 'navigation') tab.url = 'https://other.test/verify';
    else tab.active = false;
    pendingCode.resolve('123456');
    expect((await pending).state).toBe('error');
    expect(sent.some((message) => message.type === 'content:fill')).toBe(false);
  });

  it('keeps the operation active when opening its own interaction window', async () => {
    const operation = await start('copy');
    controller.cancelOtherTabs(2, 2);
    expect(controller.get(operation.id)?.state).toBe('ready-to-fill');
    expect((await controller.copy(operation.id))?.code).toBe('123456');
  });

  it('cancels the operation when another tab in the target window becomes active', async () => {
    const operation = await start('copy');
    controller.cancelOtherTabs(2, 1);
    expect(controller.get(operation.id)?.state).toBe('cancelled');
    await expect(controller.copy(operation.id)).rejects.toThrow();
  });

  it('rejects a code that expires while waiting for the device', async () => {
    const pendingCode = deferred<string>();
    calculate.mockReturnValue(pendingCode.promise);
    const pending = start();
    await vi.waitFor(() => expect(calculate).toHaveBeenCalled());
    vi.mocked(Date.now).mockReturnValue(30_000);
    pendingCode.resolve('123456');
    expect(await pending).toMatchObject({ state: 'error', message: expect.stringContaining('expired') });
    expect(sent.some((message) => message.type === 'content:fill')).toBe(false);
  });

  it('invalidates naturally expired copy results', async () => {
    const operation = await start('copy');
    vi.mocked(Date.now).mockReturnValue(30_000);
    expect(controller.get(operation.id)?.state).toBe('error');
    await expect(controller.copy(operation.id)).rejects.toThrow();
  });

  it('cannot retrieve an operation after the worker restarts', async () => {
    const operation = await start('copy');
    const restarted = new AutofillController(devices, oath);
    expect(restarted.get(operation.id)).toBeUndefined();
    await expect(restarted.copy(operation.id)).rejects.toThrow();
  });

  it('removes an unfinished operation after its timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      formFound = false;
      const operation = await start();
      expect(operation.state).toBe('copy-required');
      await vi.advanceTimersByTimeAsync(90_000);
      expect(controller.get(operation.id)).toBeUndefined();
      expect(calculate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumes a requested fill after one successful password submission', async () => {
    list.mockRejectedValueOnce(new AppError('OATH_PASSWORD_REQUIRED', 'Enter the password.'));
    const operation = await start();
    expect(operation.state).toBe('password-required');
    await controller.password(operation.id, DEVICE.id, 'test-password');
    expect(controller.get(operation.id)?.state).toBe('complete');
    expect(calculate.mock.lastCall?.at(-1)).toBe('test-password');
    expect(sent.some((message) => message.type === 'content:fill')).toBe(true);
  });

  it('retries a wrong password for a device discovered by issuer matching', async () => {
    list.mockRejectedValueOnce(new AppError('OATH_PASSWORD_REQUIRED', 'Enter the password.'));
    const operation = await controller.start(1);
    list.mockRejectedValueOnce(new AppError('OATH_AUTH', 'Incorrect password.'));
    await controller.password(operation.id, DEVICE.id, 'wrong');
    expect(controller.get(operation.id)).toMatchObject({ state: 'password-required', message: 'Incorrect password.' });
    await controller.password(operation.id, DEVICE.id, 'right');
    expect(controller.get(operation.id)?.state).toBe('complete');
    expect(calculate.mock.lastCall?.at(-1)).toBe('right');
  });
});

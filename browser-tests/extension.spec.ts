import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import path from 'node:path';

const extensionPath = path.resolve('.output/chrome-mv3');
const verificationForm = '<!doctype html><html><body><form><label>Verification code<input autocomplete="one-time-code" inputmode="numeric" maxlength="6"></label></form></body></html>';
let context: BrowserContext;
let target: Page;
let nativeUsbAvailable: boolean;

async function invokeShortcut(): Promise<void> {
  await target.bringToFront();
  const cdp = await context.newCDPSession(target);
  const nativeVirtualKeyCode = process.platform === 'darwin' ? 31 : 32;
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 9, key: 'o', code: 'KeyO', windowsVirtualKeyCode: 79, nativeVirtualKeyCode });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 9, key: 'o', code: 'KeyO', windowsVirtualKeyCode: 79, nativeVirtualKeyCode });
}

async function installMockDevice(worker: Worker): Promise<void> {
  await worker.evaluate(() => {
    let response = new Uint8Array();
    let names = ['Example:alice'];
    const selection = new Uint8Array([0x79, 3, 6, 0, 0, 0x71, 8, ...new TextEncoder().encode('12345678'), 0x90, 0]);
    const ok = new Uint8Array([0x90, 0]);
    const device = {
      vendorId: 0x20a0,
      productId: 0x42d4,
      productName: 'CanoKey Mock',
      serialNumber: '01020304',
      opened: false,
      configuration: { interfaces: [{ interfaceNumber: 3, claimed: false, alternate: { alternateSetting: 0 }, alternates: [{ alternateSetting: 0, interfaceClass: 255, interfaceSubclass: 255, interfaceProtocol: 255, endpoints: [] }] }] },
      async open() { this.opened = true; },
      async close() { this.opened = false; },
      async claimInterface() {},
      async releaseInterface() {},
      async selectAlternateInterface() {},
      async controlTransferOut(_setup: unknown, data: ArrayBuffer) {
        const command = new Uint8Array(data);
        const instruction = command[1];
        if (instruction === 0xa4 && command[5] === 0xf0) response = ok;
        else if (instruction === 0x31 && command[2] === 0) response = new Uint8Array([...new TextEncoder().encode('3.1.0'), 0x90, 0]);
        else if (instruction === 0x31) response = new Uint8Array([0x6d, 0]);
        else if (instruction === 0x32) response = new Uint8Array([1, 2, 3, 4, 0x90, 0]);
        else if (instruction === 0xa4) response = selection;
        else if (instruction === 0xa1) {
          const entries = names.flatMap((value) => {
            const name = new TextEncoder().encode(value);
            return [0x72, name.length + 1, 0x21, ...name];
          });
          response = new Uint8Array([...entries, 0x90, 0]);
        }
        else if (instruction === 0xa5) response = new Uint8Array([0x69, 0x85]);
        else if (instruction === 0xa2 && command[5] === 0x71) {
          const nameLength = command[6] ?? 0;
          const name = new TextDecoder().decode(command.slice(7, 7 + nameLength));
          const index = names.indexOf(name);
          response = index < 0 ? new Uint8Array([0x6a, 0x88]) : new Uint8Array([0x76, 5, 6, 0, 0, 0, 42 + index, 0x90, 0]);
        } else if (instruction === 0x01) {
          const nameLength = command[6] ?? 0;
          names.push(new TextDecoder().decode(command.slice(7, 7 + nameLength)));
          response = ok;
        }
        else throw new Error('Unexpected mock WebUSB command');
        return { status: 'ok', bytesWritten: command.length };
      },
      async controlTransferIn(setup: { request: number }, length: number) {
        const data = setup.request === 2 ? new Uint8Array([0]) : response.slice(0, length);
        return { status: 'ok', data: new DataView(data.buffer, data.byteOffset, data.byteLength) };
      },
    };
    Object.defineProperty(navigator, 'usb', { configurable: true, value: {
      async getDevices() { return [device]; },
      async requestDevice() { return device; },
      addEventListener() {},
      setAccounts(accounts: string[]) { names = accounts; },
    } });
  });
}

async function setMockAccounts(worker: Worker, names: string[]): Promise<void> {
  await worker.evaluate((accounts) => {
    const usb = navigator.usb as USB & { setAccounts: (names: string[]) => void };
    usb.setAccounts(accounts);
  }, names);
}

test.beforeEach(async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'This extension currently targets Chromium.');
  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  nativeUsbAvailable = await worker.evaluate(() => typeof navigator.usb === 'object' && navigator.usb !== null);
  await installMockDevice(worker);
  target = await context.newPage();
  await target.route('https://example.test/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: verificationForm,
  }));
  await target.goto('https://example.test/verify');
  await target.bringToFront();
});

test.afterEach(async () => { await context?.close(); });

const mapping = { issuer: 'Example', origin: 'https://example.test' };

async function addMapping(worker: Worker): Promise<void> {
  await worker.evaluate(async (value) => chrome.storage.local.set({ 'issuer-mappings.v1': [value] }), mapping);
}

async function waitForOperation(): Promise<Page> {
  const opening = context.waitForEvent('page', (page) => page.url().includes('/operation.html'));
  await invokeShortcut();
  return opening;
}

test('one shortcut picks the unique live issuer match', async () => {
  const worker = context.serviceWorkers()[0]!;
  await addMapping(worker);
  const shortcut = process.platform === 'darwin' ? '⌥⇧O' : 'Alt+Shift+O';
  expect(await worker.evaluate(() => chrome.commands.getAll())).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'fill-totp', shortcut })]));
  await invokeShortcut();
  await expect(target.locator('input')).toHaveValue('000042', { timeout: 10_000 });
  expect(context.pages().some((page) => page.url().includes('/operation.html'))).toBe(false);
  expect(await worker.evaluate(() => chrome.storage.local.get(null))).toEqual({ 'issuer-mappings.v1': [mapping] });
  expect(await worker.evaluate(() => chrome.storage.session.get(null))).toEqual({});
});

test('the GitLab QR issuer fills via the built-in mapping', async () => {
  const worker = context.serviceWorkers()[0]!;
  await setMockAccounts(worker, ['GitHub:alice', 'gitlab.com:bob']);
  await target.route('https://gitlab.com/**', (route) => route.fulfill({ contentType: 'text/html', body: verificationForm }));
  await target.goto('https://gitlab.com/users/sign_in');
  await invokeShortcut();
  await expect(target.locator('input')).toHaveValue('000043', { timeout: 10_000 });
  expect(await worker.evaluate(() => chrome.storage.local.get(null))).toEqual({});

  const options = await context.newPage();
  await options.goto(new URL('options.html', worker.url()).href);
  const defaults = options.locator('details').filter({ hasText: 'Built-in mappings' });
  await defaults.getByText('Built-in mappings', { exact: true }).click();
  await expect(defaults.getByText('GitLab', { exact: true })).toBeVisible();
  await expect(defaults.getByText('gitlab.com', { exact: true })).toBeVisible();
});

test('one click on the account fills an unmapped website', async () => {
  const interaction = await waitForOperation();
  await expect(interaction.locator('.origin')).toHaveText('https://example.test');
  await interaction.getByRole('button', { name: 'Fill code' }).click();
  await expect(target.locator('input')).toHaveValue('000042', { timeout: 10_000 });
  expect(await context.serviceWorkers()[0]!.evaluate(() => chrome.storage.local.get(null))).toEqual({});
});

test('multiple matches fill on a single account action', async () => {
  const worker = context.serviceWorkers()[0]!;
  await addMapping(worker);
  await setMockAccounts(worker, ['Example:alice', 'Example:bob', 'Other:carol']);
  const interaction = await waitForOperation();
  await expect(interaction.getByRole('button', { name: 'Fill code' })).toHaveCount(2);
  await interaction.locator('.account').filter({ hasText: 'bob' }).getByRole('button', { name: 'Fill code' }).click();
  await expect(target.locator('input')).toHaveValue('000043', { timeout: 10_000 });
});

test('an empty CanoKey shows an empty account list and retry reads it again', async () => {
  const worker = context.serviceWorkers()[0]!;
  await addMapping(worker);
  await setMockAccounts(worker, []);
  const interaction = await waitForOperation();
  await expect(interaction.getByRole('status')).toHaveText('No TOTP credentials found.');
  await expect(interaction.getByRole('button', { name: 'Authorize a CanoKey' })).toHaveCount(0);
  await setMockAccounts(worker, ['Example:alice']);
  await interaction.getByRole('button', { name: 'Retry' }).click();
  await expect(target.locator('input')).toHaveValue('000042', { timeout: 10_000 });
});

test('one popup permission request covers mapped websites across tabs', async () => {
  const requests: string[][] = [];
  // The browser's confirmation dialog is outside the page surface.
  await context.exposeFunction('testWebsitePermission', (method: 'contains' | 'request', origins: string[]) => {
    if (method === 'request') requests.push(origins);
    return requests.some((granted) => origins.every((origin) => granted.includes(origin)));
  });
  await context.addInitScript(() => {
    if (location.protocol !== 'chrome-extension:' || location.pathname !== '/popup.html') return;
    const website = new URLSearchParams(location.search).get('website');
    const checkPermission = Reflect.get(window, 'testWebsitePermission') as (method: string, origins: string[]) => Promise<boolean>;
    Object.defineProperty(chrome.tabs, 'query', { value: async () => [{ id: 1, url: website }] });
    Object.defineProperty(chrome.permissions, 'contains', { value: ({ origins }: chrome.permissions.Permissions) => checkPermission('contains', origins ?? []) });
    Object.defineProperty(chrome.permissions, 'request', { value: ({ origins }: chrome.permissions.Permissions) => checkPermission('request', origins ?? []) });
  });

  const worker = context.serviceWorkers()[0]!;
  const popup = await context.newPage();
  const popupUrl = new URL('popup.html', worker.url());
  popupUrl.searchParams.set('website', 'https://github.com');
  await popup.goto(popupUrl.href);
  const enable = popup.getByRole('button', { name: 'Show C on all mapped websites' });
  await expect(enable).toHaveAccessibleDescription('Your browser will request access to all HTTPS websites.');
  expect(requests).toEqual([]);
  await enable.click();
  await expect(enable).toHaveCount(0);

  popupUrl.searchParams.set('website', 'https://app.fastmail.com');
  await popup.goto(popupUrl.href);
  await expect(popup.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  await expect(enable).toHaveCount(0);
  expect(requests).toEqual([['https://*/*']]);
  expect(await worker.evaluate(() => chrome.storage.local.get(null))).toEqual({});
});

test('the webpage button fills a labelled numeric code field once it has a permitted mapping', async () => {
  const worker = context.serviceWorkers()[0]!;
  await target.route('https://example.test/verify', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<label for="code">Enter the 6-digit code from your app that appears after scanning the QR code:</label><input id="code" type="text" placeholder="XXXXXX" autocomplete="off" pattern="[0-9]*" maxlength="6">',
  }));
  await target.reload();
  // The native host-permission prompt is outside Playwright's page surface.
  // Use the shortcut's temporary host grant for the real content-script injection.
  const initial = await waitForOperation();
  await initial.getByRole('button', { name: 'Close' }).click();
  await target.bringToFront();
  await addMapping(worker);
  await worker.evaluate(async () => {
    Object.defineProperty(chrome.permissions, 'contains', { value: async () => true });
  });
  await target.reload();
  const button = target.getByRole('button', { name: 'Fill verification code with CanoKey' });
  await expect(button).toBeVisible();
  await expect(target.locator('input')).toHaveValue('');
  await button.click();
  await expect(target.locator('input')).toHaveValue('000042', { timeout: 10_000 });

  const options = await context.newPage();
  await options.goto(new URL('options.html', worker.url()).href);
  await options.getByRole('button', { name: 'Remove' }).click();
  await expect(button).toHaveCount(0);
});

test('one click copies when the verification field is missing', async () => {
  const worker = context.serviceWorkers()[0]!;
  await addMapping(worker);
  await target.route('https://example.test/no-field', (route) => route.fulfill({ contentType: 'text/html', body: '<p>Use the verification code on another screen.</p>' }));
  await target.goto('https://example.test/no-field');
  const interaction = await waitForOperation();
  await interaction.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      value: (code: string) => {
        document.body.dataset.copied = code;
        return Promise.resolve();
      },
    });
  });
  await interaction.getByRole('button', { name: 'Copy code' }).click();
  await expect(interaction.locator('body')).toHaveAttribute('data-copied', '000042', { timeout: 10_000 });
});

test('a code offered for manual copying disappears at expiry', async () => {
  const interaction = await waitForOperation();
  await interaction.clock.install();
  await interaction.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      value: () => Promise.reject(new Error('Clipboard unavailable')),
    });
  });
  await interaction.getByRole('button', { name: 'Copy code' }).click();
  await expect(interaction.locator('.code')).toHaveText('000042', { timeout: 10_000 });
  await interaction.clock.fastForward(30_000);
  await expect(interaction.getByRole('alert')).toHaveText('The code expired. Start again.');
  await expect(interaction.locator('.code')).toHaveCount(0);
  await expect(interaction.getByText('TOTP filled successfully.')).toHaveCount(0);
});

async function reviewImport(): Promise<Page> {
  const worker = context.serviceWorkers()[0]!;
  const activation = await waitForOperation();
  await activation.getByRole('button', { name: 'Close' }).click();
  await target.bringToFront();
  const tab = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]!);
  expect(tab.url).toBe('https://example.test/verify');
  const params = new URLSearchParams({ tab: String(tab.id), origin: 'https://example.test' });
  const url = new URL(`import.html?${params}`, worker.url()).href;
  const opening = context.waitForEvent('page', (page) => page.url() === url);
  await worker.evaluate(async (url) => { await chrome.windows.create({ url, type: 'popup' }); }, url);
  const importer = await opening;
  await importer.getByRole('button', { name: 'Paste otpauth URI' }).click();
  await importer.getByRole('textbox', { name: 'Paste otpauth URI' }).fill('otpauth://totp/Example:bob?secret=MY');
  await expect(importer.getByRole('textbox', { name: 'Account name' })).toHaveValue('bob');
  return importer;
}

test('a pasted URI opens an editable form and imports and fills once', async () => {
  const worker = context.serviceWorkers()[0]!;
  const importer = await reviewImport();
  await importer.getByRole('button', { name: 'Import and fill' }).click();
  await expect(target.locator('input')).toHaveValue('000043', { timeout: 10_000 });
  expect(await worker.evaluate(() => chrome.storage.local.get(null))).toEqual({});
  expect(await worker.evaluate(() => chrome.storage.session.get(null))).toEqual({});
});

test('checks the original page before importing and filling', async () => {
  const importer = await reviewImport();
  await target.route('https://other.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<p>Another website</p>' }));
  await target.goto('https://other.test/verify');
  await importer.getByRole('button', { name: 'Import and fill' }).click();
  await expect(importer.getByRole('alert')).toBeVisible();
  await importer.getByRole('button', { name: 'Import to CanoKey' }).click();
  await expect(importer.getByRole('status')).toHaveText('Credential imported. bob');
});

test('options saves only issuer mappings and applies edits', async () => {
  const worker = context.serviceWorkers()[0]!;
  const options = await context.newPage();
  await options.goto(new URL('options.html', worker.url()).href);
  const mappings = options.getByRole('region', { name: 'Issuer and websites' });
  await mappings.getByRole('textbox', { name: 'Issuer' }).fill(mapping.issuer);
  const address = mappings.getByRole('textbox', { name: 'HTTPS address' });
  await address.fill(mapping.origin);
  await mappings.getByRole('button', { name: 'Add mapping' }).click();
  await expect(mappings.getByText(mapping.origin, { exact: true })).toBeVisible();
  await mappings.getByRole('button', { name: 'Edit', exact: true }).click();
  await address.fill('https://example.test:8443/a');
  await mappings.getByRole('button', { name: 'Save' }).click();
  await expect(mappings.getByText('https://example.test:8443')).toBeVisible();
  expect(await worker.evaluate(() => chrome.storage.local.get(null))).toEqual({
    'issuer-mappings.v1': [{ issuer: 'Example', origin: 'https://example.test:8443' }],
  });
  await mappings.getByRole('button', { name: 'Remove' }).click();
  await expect(mappings.getByText('https://example.test:8443')).toHaveCount(0);
});

test('manifest has no default host access and all code is local', async () => {
  const worker = context.serviceWorkers()[0]!;
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.permissions).toEqual(['activeTab', 'scripting', 'storage']);
  expect(manifest.host_permissions ?? []).toEqual([]);
  expect(manifest.optional_host_permissions).toEqual(['https://*/*']);
  expect(await worker.evaluate(() => chrome.permissions.contains({ origins: ['https://*/*'] }))).toBe(false);
  expect(manifest.content_scripts ?? []).toEqual([]);
  expect(manifest.externally_connectable).toBeUndefined();
  expect(nativeUsbAvailable).toBe(true);
  expect(await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts())).toEqual([]);
  expect(typeof manifest.content_security_policy === 'object' ? manifest.content_security_policy.extension_pages : manifest.content_security_policy).toContain('wasm-unsafe-eval');
});

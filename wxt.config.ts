import { defineConfig } from 'wxt';
import { HTTPS_HOST_PATTERN } from './lib/origin';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  entrypointsDir: 'entrypoints',
  publicDir: 'public',
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      delete manifest.host_permissions;
    },
  },
  manifest: {
    name: 'CanoKey TOTP',
    description: 'Fill TOTP codes computed by your CanoKey. Secrets and OTP calculation stay on the hardware key.',
    version: '0.1.0',
    minimum_chrome_version: '116',
    permissions: ['activeTab', 'scripting', 'storage'],
    host_permissions: [],
    optional_host_permissions: [HTTPS_HOST_PATTERN],
    commands: {
      'fill-totp': {
        suggested_key: { default: 'Alt+Shift+O' },
        description: 'Fill a TOTP code with CanoKey',
      },
    },
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'",
    },
  },
  vite: () => ({
    build: {
      target: 'chrome116',
    },
  }),
});

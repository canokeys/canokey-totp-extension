import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser-tests',
  timeout: 60_000,
  workers: 1,
  use: {
    headless: false,
    viewport: { width: 1100, height: 800 },
  },
});

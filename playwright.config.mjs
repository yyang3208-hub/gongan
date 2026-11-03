import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const channel = process.env.PLAYWRIGHT_CHANNEL ||
  (existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe') ? 'chrome' : undefined);
if (!process.env.GONGAN_E2E_DATABASE) throw new Error('Use npm run test:e2e to create an isolated temporary database.');

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:3229', channel, viewport: { width: 1600, height: 900 }, trace: 'retain-on-failure' },
  webServer: {
    command: 'node server.mjs',
    url: 'http://127.0.0.1:3229/api/health',
    reuseExistingServer: false,
    env: { PORT: '3229', GONGAN_DATABASE: process.env.GONGAN_E2E_DATABASE, TIANDITU_TOKEN: '', GONGAN_SETTINGS_KEY: '',
      IMAGERY_NODEODM_URL: '', IMAGERY_NODEODM_TOKEN: '', IMAGERY_GDAL_INFO: '', IMAGERY_GDAL_TRANSLATE: '', IMAGERY_GDAL2TILES: '', IMAGERY_PYTHON: '' },
  },
});

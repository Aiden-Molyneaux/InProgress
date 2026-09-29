import { defineConfig } from '@playwright/test';

const PORT = 4399;

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 30_000,
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: 'msedge',
    viewport: { width: 520, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  webServer: {
    command: 'node test/e2e/start-server.mjs',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});

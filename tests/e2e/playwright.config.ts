import { defineConfig } from '@playwright/test';

const executablePath = process.env.CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: 'specs',
  // Each spec starts its own demo server and relay on free ports, but the
  // sandbox and CI runners are small, so keep the browser count low.
  workers: 2,
  timeout: 60_000,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    launchOptions: {
      args: ['--enable-features=WebMCPTesting'],
      ...(executablePath ? { executablePath } : {}),
    },
  },
});

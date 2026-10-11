// The check's two servers and two projects (ADR 0041). The relay runs in
// local mode with no settings but TABDOCK_HOME and TABDOCK_PORT, so it binds
// loopback, keeps its owner token and audit log in TABDOCK_HOME, and admits
// pages from loopback origins. Readiness is /healthz, which needs no token;
// SIGINT stops it, so it closes its audit log with relay_stop; and a server
// already on either port fails the run rather than being reused under
// another token. In another repository, change the two commands and the URL.

import { defineConfig } from '@playwright/test';

const port = process.env.TABDOCK_PORT ?? '8787';
const executablePath = process.env.CHROMIUM_EXECUTABLE;
const browser = executablePath ? { executablePath } : {};

export default defineConfig({
  testDir: 'specs',
  // One relay and one owner token: more workers would share the user's budgets and gain nothing.
  workers: 1,
  timeout: 120_000,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  webServer: [
    {
      name: 'relay',
      command: process.env.CI_CHECK_RELAY_COMMAND ?? 'npx --no-install tabdock-relay',
      url: `http://127.0.0.1:${port}/healthz`,
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGINT', timeout: 10_000 },
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      name: 'page',
      command: process.env.CI_CHECK_PAGE_COMMAND ?? 'echo set CI_CHECK_PAGE_COMMAND && exit 1',
      url: process.env.CI_CHECK_PAGE_URL ?? 'http://127.0.0.1:5180/',
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGINT', timeout: 5_000 },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
  projects: [
    {
      // No flag turns native WebMCP on, so the page runs on the polyfill it loads.
      name: 'chromium',
      testIgnore: /advisory\.spec\.ts$/,
      use: { browserName: 'chromium', launchOptions: { ...browser } },
    },
    {
      // Run by hand only, never in this repository's CI (ADR 0041, decision 1).
      name: 'advisory',
      testMatch: /advisory\.spec\.ts$/,
      use: { browserName: 'chromium', launchOptions: { ...browser } },
    },
  ],
});

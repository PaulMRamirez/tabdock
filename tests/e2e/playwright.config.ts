import { defineConfig } from '@playwright/test';

const executablePath = process.env.CHROMIUM_EXECUTABLE;
const browser = executablePath ? { executablePath } : {};

/**
 * The MCP-B 6 leg (A5.4, ADR 0031): specs that run the page on MCP-B 6,
 * mcpb6.spec.ts and from M6 mcpb6-images.spec.ts (ADR 0039).
 */
const MCPB6_SPECS = /mcpb6(-[a-z-]+)?\.spec\.ts$/;

export default defineConfig({
  testDir: 'specs',
  globalSetup: './src/global-setup.ts',
  // Each spec starts its own demo server and relay on free ports, but the
  // sandbox and CI runners are small, so keep the browser count low.
  workers: 2,
  timeout: 60_000,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  projects: [
    {
      name: 'chromium',
      testIgnore: MCPB6_SPECS,
      use: { launchOptions: { args: ['--enable-features=WebMCPTesting'], ...browser } },
    },
    {
      // Run alone with `playwright test --project mcpb6`. Without the
      // WebMCPTesting flag no Chrome turns native WebMCP on, so the 6.0.0
      // polyfill installs instead of keeping a native context; the specs
      // still check that it did before they trust a result.
      name: 'mcpb6',
      testMatch: MCPB6_SPECS,
      use: { launchOptions: { args: [], ...browser } },
    },
  ],
});

import { ensurePlaywrightChromium } from './harness.ts';

// Lets `pnpm test:e2e` run from a fresh clone without a separate browser install.
export default function globalSetup(): void {
  if (!process.env.CHROMIUM_EXECUTABLE) ensurePlaywrightChromium();
}

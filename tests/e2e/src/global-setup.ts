import { ensurePlaywrightChromium } from './harness.ts';

// Lets `pnpm test:e2e` run from a fresh clone without a separate browser install.
export default async function globalSetup(): Promise<void> {
  await ensurePlaywrightChromium();
}

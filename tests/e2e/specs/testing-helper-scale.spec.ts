import { expect, type Page, test } from '@playwright/test';
import { allowAttach, widgetButton } from '@tabdock/adapter/testing';
import { startDemoServer, type DemoServer } from '@tabdock/demo/server';
import {
  callTool,
  connectMcp,
  startTabdock,
  type Tabdock,
  waitForDock,
  waitForLink,
} from '../src/tabdock-harness.ts';

// ADR 0041's helper at a device scale of 1.25, as a Windows display set to
// 125% runs Chromium. The page scrolls in 0.8 px steps there, and Chromium
// rounds the content and client sizes it reports, so on a right-to-left page,
// or one that scrolls up from the bottom, the layout viewport's position and
// the scroll range it is checked against differ by up to 1.6 px. The helper
// must find Allow at every such step rather than take the page for one whose
// scrolling element stands in for the document.

const CI = 'tabdock-ci-check';
const executablePath = process.env.CHROMIUM_EXECUTABLE;

// No viewport of Playwright's own: its emulation would set the scale back to 1.
test.use({
  launchOptions: {
    args: [
      '--enable-features=WebMCPTesting',
      '--force-device-scale-factor=1.25',
      '--window-size=1280,720',
    ],
    ...(executablePath === undefined ? {} : { executablePath }),
  },
  viewport: null,
});

let demo: DemoServer;
let tabdock: Tabdock;

test.beforeAll(async () => {
  demo = await startDemoServer({ e2eHook: true });
});
test.afterAll(async () => {
  await demo.close();
});
test.beforeEach(async () => {
  tabdock = await startTabdock({ demo });
});
test.afterEach(async () => {
  await tabdock.close();
});

/** Lays the board out by `style` on `html`, beside a block of an odd size that overflows it. */
async function shape(page: Page, style: string, width: number, height: number): Promise<void> {
  await page.evaluate(
    ([css, w, h]) => {
      document.documentElement.setAttribute('style', css);
      const block = document.createElement('div');
      Object.assign(block.style, { width: `${String(w)}px`, height: `${String(h)}px` });
      document.body.append(block);
    },
    [style, width, height] as const,
  );
}

test('finds Allow at every scroll step on right-to-left and bottom-up pages', async ({ page }) => {
  await page.goto(tabdock.pageUrl);
  await page.waitForSelector('html[data-tools="ready"]');
  const { code } = await waitForLink(page);
  const cdp = await page.context().newCDPSession(page);
  const client = await connectMcp(tabdock.relay, tabdock.users.alice, CI);
  try {
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1.25);
    const pending = callTool(client, 'pair_page', { code });
    const requestId = await waitForDock(page, (s) => s.pendingRequests[0]?.requestId);
    const target = { action: 'approve-driver', requestId } as const;

    for (const { style, width, height, across } of [
      { style: 'direction: rtl', width: 1503, height: 10, across: true },
      { style: 'writing-mode: vertical-lr; direction: rtl', width: 10, height: 751, across: false },
    ]) {
      await shape(page, style, width, height);
      // Every device pixel of the first 32 CSS px from the scroll origin.
      for (let step = 0; step <= 40; step++) {
        const by = -step * 0.8;
        await page.evaluate(
          ([sideways, px]) => {
            if (sideways) window.scrollTo(px, 0);
            else window.scrollTo(0, px);
          },
          [across, by] as const,
        );
        await expect(
          widgetButton(cdp, target, { timeoutMs: 2000 }),
          `${style} at ${String(by)}`,
        ).resolves.toHaveProperty('backendNodeId');
      }
    }

    expect(await allowAttach(cdp, { as: 'driver', requestId })).toBe(requestId);
    expect((await pending).structured).toMatchObject({ role: 'driver' });
  } finally {
    await client.close();
    await cdp.detach();
  }
});

import { expect, type Page, test } from '@playwright/test';
import {
  allowAttach,
  clickInWidget,
  waitingPrompts,
  widgetButton,
  WidgetTestError,
} from '@tabdock/adapter/testing';
import { startDemoServer, type DemoServer } from '@tabdock/demo/server';
import {
  callTool,
  connectMcp,
  startTabdock,
  type Tabdock,
  waitForDock,
  waitForLink,
} from '../src/tabdock-harness.ts';

// Chrome on Android makes a scrolling element that fills the viewport the
// page's scroller in the document's place (its implicit root scroller, on by
// default there). DevTools then counts that element's scroll in the visual
// viewport's pageY while its hit test does not, so ADR 0041's helper could
// check a spot beside its press and miss an element there that lets clicks
// through to Allow. Desktop Chromium keeps the feature off; this file turns
// it on, as a phone has it, and the helper must refuse rather than press.

const CI = 'tabdock-ci-check';
const executablePath = process.env.CHROMIUM_EXECUTABLE;

test.use({
  launchOptions: {
    args: ['--enable-features=WebMCPTesting', '--enable-blink-features=ImplicitRootScroller'],
    ...(executablePath === undefined ? {} : { executablePath }),
  },
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
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

/** Puts the board under one element that fills the viewport and scrolls in the document's place. */
async function scrollerBoard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { documentElement: html, body } = document;
    Object.assign(html.style, { height: '100%', overflow: 'hidden' });
    Object.assign(body.style, { height: '100%', overflow: 'hidden', margin: '0' });
    const scroller = document.createElement('div');
    scroller.id = 'scroller';
    Object.assign(scroller.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '100%',
      height: '100%',
      overflow: 'auto',
    });
    const tall = document.createElement('div');
    tall.style.height = '4000px';
    scroller.append(tall);
    body.append(scroller);
  });
}

async function scrollTo(page: Page, top: number): Promise<void> {
  await page.evaluate((y) => {
    const scroller = document.getElementById('scroller');
    if (scroller === null) throw new Error('no scroller');
    scroller.scrollTop = y;
  }, top);
}

test('refuses to press where an element scrolls in the document’s place, and presses once it is back at its top', async ({
  page,
}) => {
  await page.goto(tabdock.pageUrl);
  await page.waitForSelector('html[data-tools="ready"]');
  const { code } = await waitForLink(page);
  const cdp = await page.context().newCDPSession(page);
  await scrollerBoard(page);
  const client = await connectMcp(tabdock.relay, tabdock.users.alice, CI);
  try {
    const pending = callTool(client, 'pair_page', { code });
    const requestId = await waitForDock(page, (s) => s.pendingRequests[0]?.requestId);
    const target = { action: 'approve-driver', requestId } as const;
    // At its top the element and the document agree, so the helper finds Allow.
    const at = await widgetButton(cdp, target);

    // Scrolled a few pixels, DevTools counts the element's scroll as the
    // document's: the case this file exists for, or it proves nothing.
    await scrollTo(page, 6);
    await expect
      .poll(async () => {
        const metrics = await cdp.send('Page.getLayoutMetrics');
        return [metrics.cssVisualViewport.pageY, metrics.cssLayoutViewport.pageY];
      })
      .toEqual([6, 0]);

    // An element over the centre of Allow that lets clicks through to it.
    await page.evaluate(({ x, y }) => {
      const over = document.createElement('div');
      over.id = 'cover';
      Object.assign(over.style, {
        position: 'fixed',
        left: `${String(x - 2)}px`,
        top: `${String(y - 2)}px`,
        width: '4px',
        height: '4px',
        zIndex: '2147483647',
        pointerEvents: 'none',
      });
      document.documentElement.append(over);
    }, at);
    await expect(clickInWidget(cdp, target, { timeoutMs: 1500 })).rejects.toThrow(
      new WidgetTestError(
        'the page scrolls an element in place of the document (an implicit root scroller), so no check can say where a press would land',
      ),
    );
    expect((await waitingPrompts(cdp)).attach).toEqual([{ requestId, client: CI }]);

    // Back at its top and uncovered, the helper approves as it would anywhere.
    await page.evaluate(() => document.getElementById('cover')?.remove());
    await scrollTo(page, 0);
    expect(await allowAttach(cdp, { as: 'driver', requestId })).toBe(requestId);
    expect((await pending).structured).toMatchObject({ role: 'driver' });
  } finally {
    await client.close();
    await cdp.detach();
  }
});

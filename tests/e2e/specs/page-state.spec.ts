// Page state in the browser (ADR 0040, A6.6), against a scripted relay whose
// welcome names maxStateBytes: the demo board publishes its view through
// attach()'s handle, the script-tag build publishes a `tabdock:state`
// CustomEvent's detail while the attach() build ignores the event, and the
// widget's state line says the page shares its state with everyone
// attached, or that pause holds it, within the panel at phone width and with
// no control of its own.

import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { startDemoServer, type DemoServer } from '@tabdock/demo/server';
import {
  ATTACH_REQUEST_TTL_MS,
  encodeFrame,
  MAX_DESCRIPTION_CHARS,
  MAX_FRAME_BYTES,
  MAX_RESULT_CHARS,
  MAX_STATE_BYTES,
  type PageFrame,
  parsePageFrame,
  PING_INTERVAL_MS,
  RESUME_WINDOW_MS,
} from '@tabdock/protocol';
import { scriptTagFile } from '../../../packages/adapter/scripts/script-tag-build.ts';
import { demoPageUrl, waitForDock, widgetEvaluate, widgetText } from '../src/tabdock-harness.ts';

/** Never dialled: routeWebSocket answers in its place. */
const FAKE_RELAY = 'ws://127.0.0.1:9/page';

let demo: DemoServer;
let pageErrors: string[];

test.beforeAll(async () => {
  demo = await startDemoServer({ e2eHook: true });
});
test.afterAll(async () => {
  await demo.close();
});
test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
});
test.afterEach(() => {
  expect(pageErrors).toEqual([]);
});

/** A relay that welcomes every hello as an M6 relay does, and keeps what the page sends. */
async function routeStateRelay(page: Page): Promise<{ frames: PageFrame[] }> {
  const frames: PageFrame[] = [];
  await page.routeWebSocket(FAKE_RELAY, (ws: WebSocketRoute) => {
    ws.onMessage((message) => {
      const parsed = parsePageFrame(typeof message === 'string' ? message : message.toString());
      if (parsed.kind !== 'ok') throw new Error(`the page sent a ${parsed.kind} frame`);
      frames.push(parsed.frame);
      if (parsed.frame.t !== 'hello') return;
      ws.send(
        encodeFrame({
          t: 'welcome',
          pageId: 'page-1',
          resumeToken: 'resume-1',
          resumed: false,
          pairing: { code: 'ABCDE-FGHJK', expiresAt: Date.now() + 120_000 },
          roster: [],
          limits: {
            maxFrameBytes: MAX_FRAME_BYTES,
            maxResultChars: MAX_RESULT_CHARS,
            maxDescriptionChars: MAX_DESCRIPTION_CHARS,
            pingIntervalMs: PING_INTERVAL_MS,
            // This relay never pings, so keep the page's silence watchdog out of the way.
            idleTimeoutMs: 600_000,
            resumeWindowMs: RESUME_WINDOW_MS,
            attachRequestTtlMs: ATTACH_REQUEST_TTL_MS,
            maxStateBytes: MAX_STATE_BYTES,
          },
        }),
      );
    });
  });
  return { frames };
}

function stateValues(frames: PageFrame[]): unknown[] {
  return frames.flatMap((frame) => (frame.t === 'state' ? [frame.value] : []));
}

function dispatchState(page: Page, detail: unknown): Promise<void> {
  return page.evaluate((value) => {
    document.dispatchEvent(new CustomEvent('tabdock:state', { detail: value }));
  }, detail);
}

test('the demo board publishes its view through attach(), and the attach() build ignores the event', async ({
  page,
}) => {
  const relay = await routeStateRelay(page);
  await page.goto(demoPageUrl(demo, FAKE_RELAY));
  await page.waitForSelector('html[data-tools="ready"]');
  await waitForDock(page, (state) => state.link === 'linked');
  await expect.poll(() => stateValues(relay.frames).length).toBeGreaterThan(0);
  expect(stateValues(relay.frames)[0]).toEqual({
    view: { x: 0, y: 0, zoom: 1 },
    itemCount: 3,
    highlighted: [],
  });
  // The state goes before the tools frame, so a resumed relay serves no read in between.
  const kinds = relay.frames.map((frame) => frame.t).filter((t) => t === 'state' || t === 'tools');
  expect(kinds[0]).toBe('state');
  // Only the script-tag build listens: a page that holds the handle publishes through it.
  await dispatchState(page, { stop: 9 });
  await page.waitForTimeout(800);
  expect(stateValues(relay.frames)).not.toContainEqual({ stop: 9 });
});

test("the script-tag build publishes a tabdock:state event's detail, refusing what is not an object", async ({
  page,
}) => {
  const relay = await routeStateRelay(page);
  const adapter = Buffer.from(await scriptTagFile());
  await page.route(`${demo.url}tabdock-adapter.js`, (route) =>
    route.fulfill({ contentType: 'text/javascript', body: adapter }),
  );
  // Without ?relay the board registers its tools and attaches nothing itself.
  await page.goto(demo.url);
  await page.waitForSelector('html[data-tools="ready"]');
  await page.evaluate((relayUrl) => {
    const script = document.createElement('script');
    script.src = '/tabdock-adapter.js';
    script.dataset.relay = relayUrl;
    document.head.append(script);
  }, FAKE_RELAY);
  await expect
    .poll(() => relay.frames.filter((frame) => frame.t === 'tools').length)
    .toBeGreaterThan(0);
  await dispatchState(page, { stop: 4, note: 'page words' });
  await expect.poll(() => stateValues(relay.frames)).toEqual([{ stop: 4, note: 'page words' }]);
  await expect
    .poll(() => widgetText(page, 'state-line'))
    .toBe('This page shares its state with everyone attached, invited people included.');
  // A plain Event carries no detail, and an array is not an object: neither throws on the page.
  await page.evaluate(() => {
    document.dispatchEvent(new Event('tabdock:state'));
  });
  await dispatchState(page, [1, 2]);
  await expect
    .poll(() => widgetText(page, 'state-line'))
    .toBe('Page state not shared: not a JSON object.');
  // The refusal cleared what the relay held.
  await expect.poll(() => stateValues(relay.frames).at(-1)).toBeNull();
});

test.describe('at phone width', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('the state line fits the panel with no sideways scroll, adds no control, and says pause holds state', async ({
    page,
  }) => {
    const relay = await routeStateRelay(page);
    await page.goto(demoPageUrl(demo, FAKE_RELAY));
    await page.waitForSelector('html[data-tools="ready"]');
    await waitForDock(page, (state) => state.link === 'linked' && state.published === 'shared');
    await expect
      .poll(() => widgetText(page, 'state-line'))
      .toBe('This page shares its state with everyone attached, invited people included.');
    const layout = (await widgetEvaluate(
      page,
      'state-line',
      `function () {
        const panel = this.closest('.panel');
        return {
          shown: !this.hidden && !panel.hidden,
          scrollWidth: panel.scrollWidth,
          clientWidth: panel.clientWidth,
          lineRight: this.getBoundingClientRect().right,
          panelRight: panel.getBoundingClientRect().right,
          controls: this.querySelectorAll('button, [data-armed]').length,
        };
      }`,
    )) as {
      shown: boolean;
      scrollWidth: number;
      clientWidth: number;
      lineRight: number;
      panelRight: number;
      controls: number;
    };
    expect(layout.shown).toBe(true);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.lineRight).toBeLessThanOrEqual(layout.panelRight);
    expect(layout.controls).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
    // Pause holds state: the relay is sent null, and the line says so.
    await page.evaluate(() => {
      window.__tabdockDock?.pause(true);
    });
    await expect
      .poll(() => widgetText(page, 'state-line'))
      .toBe('Page state is held while paused.');
    await expect.poll(() => stateValues(relay.frames).at(-1)).toBeNull();
    await page.evaluate(() => {
      window.__tabdockDock?.pause(false);
    });
    await expect.poll(() => stateValues(relay.frames).at(-1)).toMatchObject({ itemCount: 3 });
  });
});

import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { startDemoServer, type DemoServer } from '@tabdock/demo/server';
import {
  ATTACH_REQUEST_TTL_MS,
  type AttachmentView,
  encodeFrame,
  MAX_DESCRIPTION_CHARS,
  MAX_FRAME_BYTES,
  MAX_RESULT_CHARS,
  type PageFrame,
  parsePageFrame,
  PING_INTERVAL_MS,
  type RelayFrame,
  RESUME_WINDOW_MS,
} from '@tabdock/protocol';
import {
  clickInWidget,
  demoPageUrl,
  dockState,
  waitForDock,
  widgetButtonCentre,
  widgetButtonNow,
  widgetVisible,
} from '../src/tabdock-harness.ts';

// The operator's widget against a scripted relay. Playwright's routeWebSocket
// stands in for the relay, so a test controls every frame the page sees, and
// Playwright's clock holds the widget's timers still while a test checks what
// a click inside the arming window does.

/** Never dialled: routeWebSocket answers in its place. */
const FAKE_RELAY = 'ws://127.0.0.1:9/page';
/** The widget's ARM_DELAY_MS. */
const ARM_DELAY_MS = 500;

// Tall enough that a few prompts never make the panel scroll, which would move them.
test.use({ viewport: { width: 1280, height: 1200 } });

let demo: DemoServer;
let pageErrors: string[];

test.beforeAll(async () => {
  demo = await startDemoServer();
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

interface FakeRelay {
  /** Every frame the page sent, over every connection, in order. */
  readonly frames: PageFrame[];
  readonly connections: number;
  /** Sends a frame to the page over the newest connection. */
  send(frame: RelayFrame): void;
  /** Closes the newest connection from the relay's side, as a network drop would end it. */
  drop(): Promise<void>;
}

function attachment(userId: string, displayName: string): AttachmentView {
  return {
    userId,
    displayName,
    role: 'driver',
    grantedAt: Date.now(),
    lastUsedAt: null,
    expiresAt: null,
    clients: [],
  };
}

function attachRequest(requestId: string, userId: string): RelayFrame {
  return {
    t: 'attach_request',
    requestId,
    user: { userId, displayName: userId.charAt(0).toUpperCase() + userId.slice(1) },
    via: 'code',
    client: null,
    expiresAt: Date.now() + ATTACH_REQUEST_TTL_MS,
  };
}

/**
 * Opens the demo page against a scripted relay that welcomes every hello
 * (resuming when the hello carries a token) with an empty roster, and waits
 * for the link. The clock is installed first, so a test can pause it later.
 */
async function openWithFakeRelay(page: Page): Promise<FakeRelay> {
  const frames: PageFrame[] = [];
  let current: WebSocketRoute | null = null;
  let connections = 0;
  await page.clock.install();
  await page.routeWebSocket(FAKE_RELAY, (ws) => {
    current = ws;
    connections += 1;
    ws.onMessage((message) => {
      const parsed = parsePageFrame(typeof message === 'string' ? message : message.toString());
      if (parsed.kind !== 'ok') throw new Error(`the page sent a ${parsed.kind} frame`);
      frames.push(parsed.frame);
      if (parsed.frame.t !== 'hello') return;
      ws.send(
        encodeFrame({
          t: 'welcome',
          pageId: 'page-1',
          resumeToken: `resume-${connections}`,
          resumed: parsed.frame.resumeToken !== undefined,
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
          },
        }),
      );
    });
  });
  await page.goto(demoPageUrl(demo.url, FAKE_RELAY));
  await page.waitForSelector('html[data-tools="ready"]');
  await waitForDock(page, (state) => state.link === 'linked');
  return {
    frames,
    get connections() {
      return connections;
    },
    send(frame) {
      if (!current) throw new Error('the page has not connected');
      current.send(encodeFrame(frame));
    },
    async drop() {
      await current?.close({ code: 1001, reason: 'gone' });
    },
  };
}

/**
 * Stops the page's timers; only runFor moves them on from here. pauseAt takes
 * a time in the page's future, and the page's clock runs on while this asks
 * for it, so a loaded machine may need another try.
 */
async function pauseClock(page: Page): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const now = await page.evaluate(() => Date.now());
    try {
      await page.clock.pauseAt(now + 250);
      return;
    } catch (error) {
      if (attempt === 5 || !String(error).includes('to the past')) throw error;
    }
  }
}

function decisions(relay: FakeRelay) {
  return relay.frames.filter((frame) => frame.t === 'attach_decision');
}

test('a roster change from the relay that moves the prompts disarms them until they hold still', async ({
  page,
}) => {
  const relay = await openWithFakeRelay(page);
  relay.send({ t: 'roster', attachments: [attachment('carol', 'Carol')] });
  relay.send(attachRequest('req-bob', 'bob'));
  const target = { action: 'approve-observer', requestId: 'req-bob' };
  const before = await widgetButtonCentre(page, target);

  await pauseClock(page);
  // The relay renames Carol to something that wraps. The roster has as many
  // rows as before, and the prompt above it moves up.
  const longName = `Carol ${'with a display name long enough to wrap '.repeat(2)}`.trim();
  relay.send({ t: 'roster', attachments: [attachment('carol', longName)] });
  await waitForDock(page, (state) => state.roster[0]?.displayName === longName);
  const moved = await widgetButtonNow(page, target);
  expect(moved?.armed).toBe(false);
  expect(moved?.y ?? before.y).toBeLessThan(before.y);

  // A click on the button where it now sits does nothing, and restarts the wait.
  await page.mouse.click(moved?.x ?? 0, moved?.y ?? 0);
  expect((await dockState(page))?.pendingRequests.map((r) => r.requestId)).toEqual(['req-bob']);
  await page.clock.runFor(ARM_DELAY_MS - 100);
  expect((await widgetButtonNow(page, target))?.armed).toBe(false);
  await page.clock.runFor(100);
  expect((await widgetButtonNow(page, target))?.armed).toBe(true);
  expect(decisions(relay)).toEqual([]);

  await page.mouse.click(moved?.x ?? 0, moved?.y ?? 0);
  await expect
    .poll(() => decisions(relay))
    .toEqual([{ t: 'attach_decision', requestId: 'req-bob', allow: true, role: 'observer' }]);
});

test('a click on a box that moved with no state change is ignored, and restarts its wait', async ({
  page,
}) => {
  const relay = await openWithFakeRelay(page);
  relay.send(attachRequest('req-bob', 'bob'));
  const target = { action: 'approve-driver', requestId: 'req-bob' };
  const before = await widgetButtonCentre(page, target);

  await pauseClock(page);
  // A shorter window moves the bottom-pinned panel up; nothing renders, and no tick runs.
  await page.setViewportSize({ width: 1280, height: 1000 });
  const moved = await widgetButtonNow(page, target);
  expect(moved?.y ?? before.y).toBeLessThan(before.y);
  await page.mouse.click(moved?.x ?? 0, moved?.y ?? 0);
  expect((await widgetButtonNow(page, target))?.armed).toBe(false);
  await page.clock.runFor(ARM_DELAY_MS);
  expect(decisions(relay)).toEqual([]);

  await page.mouse.click(moved?.x ?? 0, moved?.y ?? 0);
  await expect
    .poll(() => decisions(relay))
    .toEqual([{ t: 'attach_decision', requestId: 'req-bob', allow: true, role: 'driver' }]);
});

test('prompts arriving every 300 ms leave the oldest one armed on its own schedule', async ({
  page,
}) => {
  const relay = await openWithFakeRelay(page);
  await pauseClock(page);
  const oldest = { action: 'approve-observer', requestId: 'req-1' };
  for (let n = 1; n <= 4; n += 1) {
    if (n > 1) await page.clock.runFor(300);
    relay.send(attachRequest(`req-${n}`, `user${n}`));
    await waitForDock(page, (state) => state.pendingRequests.length === n);
  }
  // 900 ms after the oldest prompt appeared, and 0 ms after the newest: each
  // new one went on top, so the oldest never moved and armed at 500 ms.
  expect((await widgetButtonNow(page, oldest))?.armed).toBe(true);
  expect(
    (await widgetButtonNow(page, { action: 'approve-observer', requestId: 'req-4' }))?.armed,
  ).toBe(false);

  await clickInWidget(page, oldest);
  await expect
    .poll(() => decisions(relay))
    .toEqual([{ t: 'attach_decision', requestId: 'req-1', allow: true, role: 'observer' }]);
});

test('the panel opens by itself once on the way in, so a resumed link leaves it closed', async ({
  page,
}) => {
  const relay = await openWithFakeRelay(page);
  // Nobody is attached, so the panel opened to show the code.
  expect(await widgetVisible(page, 'pairing-code')).toBe(true);
  await clickInWidget(page, { action: 'toggle' });
  await expect.poll(() => widgetVisible(page, 'pairing-code')).toBe(false);

  // The link drops and resumes, still with nobody attached: the panel stays as the operator left it.
  await relay.drop();
  await waitForDock(page, (state) => state.link === 'reconnecting');
  await waitForDock(page, (state) => relay.connections === 2 && state.link === 'linked');
  expect(relay.frames.filter((frame) => frame.t === 'hello').at(-1)).toMatchObject({
    resumeToken: 'resume-1',
  });
  expect(await widgetVisible(page, 'pairing-code')).toBe(false);

  // Once someone has attached and gone, nobody is attached again: that is a new way in.
  relay.send({ t: 'roster', attachments: [attachment('alice', 'Alice')] });
  await waitForDock(page, (state) => state.roster.length === 1);
  expect(await widgetVisible(page, 'pairing-code')).toBe(false);
  relay.send({ t: 'roster', attachments: [] });
  await expect.poll(() => widgetVisible(page, 'pairing-code')).toBe(true);
});

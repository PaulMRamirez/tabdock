import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { encodeQr } from '@tabdock/adapter/qr';
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
  type Role,
} from '@tabdock/protocol';
import {
  approveThroughHandle,
  clickInWidget,
  demoPageUrl,
  dockState,
  scriptClickInWidget,
  waitForDock,
  widgetButtonCentre,
  widgetButtonNow,
  widgetItems,
  widgetText,
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
/** Console errors a test causes on purpose, in order; any other fails it. */
let expectedErrors: string[];

test.beforeAll(async () => {
  demo = await startDemoServer();
});
test.afterAll(async () => {
  await demo.close();
});
test.beforeEach(({ page }) => {
  pageErrors = [];
  expectedErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
});
test.afterEach(() => {
  expect(pageErrors).toEqual(expectedErrors);
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

function attachment(userId: string, displayName: string, role: Role = 'driver'): AttachmentView {
  return {
    userId,
    displayName,
    role,
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
 * pairingUrl goes in the welcome's pairing, as a relay with a public URL sends it.
 */
async function openWithFakeRelay(
  page: Page,
  options: { pairingUrl?: string } = {},
): Promise<FakeRelay> {
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
          pairing: {
            code: 'ABCDE-FGHJK',
            ...(options.pairingUrl === undefined ? {} : { url: options.pairingUrl }),
            expiresAt: Date.now() + 120_000,
          },
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

test('a prompt that armed while the tab was hidden waits again when the tab is shown', async ({
  page,
}) => {
  const relay = await openWithFakeRelay(page);
  // Headless tabs never hide, so the test stands in for the browser's visibility state.
  await page.evaluate(() => {
    let visibility: DocumentVisibilityState = 'hidden';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => visibility === 'hidden',
    });
    (window as unknown as { showTab: () => void }).showTab = () => {
      visibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    };
    document.dispatchEvent(new Event('visibilitychange'));
  });
  relay.send(attachRequest('req-bg', 'mallory'));
  await waitForDock(page, (state) => state.pendingRequests.length === 1);
  const target = { action: 'approve-driver', requestId: 'req-bg' };
  await page.clock.runFor(ARM_DELAY_MS * 3);
  expect((await widgetButtonNow(page, target))?.armed).toBe(true);

  await pauseClock(page);
  await page.evaluate(() => {
    (window as unknown as { showTab: () => void }).showTab();
  });
  const shown = await widgetButtonNow(page, target);
  expect(shown?.armed).toBe(false);
  // The first click on return lands nowhere.
  await page.mouse.click(shown?.x ?? 0, shown?.y ?? 0);
  await page.clock.runFor(ARM_DELAY_MS);
  expect(decisions(relay)).toEqual([]);

  // Focus alone restarts the wait as well.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect((await widgetButtonNow(page, target))?.armed).toBe(false);
  await page.clock.runFor(ARM_DELAY_MS);
  expect((await widgetButtonNow(page, target))?.armed).toBe(true);
  await page.mouse.click(shown?.x ?? 0, shown?.y ?? 0);
  await expect
    .poll(() => decisions(relay))
    .toEqual([{ t: 'attach_decision', requestId: 'req-bg', allow: true, role: 'driver' }]);
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

// M2: the roster's role switch and Revoke, Revoke all, the activity log and
// the pause switch. Roster rows and the pause control are armed boxes like
// the prompts, since Make driver and Resume grant access.

function framesOf<T extends PageFrame['t']>(relay: FakeRelay, type: T) {
  return relay.frames.filter((frame): frame is Extract<PageFrame, { t: T }> => frame.t === type);
}

/**
 * An attach request the operator approves through the page's handle. The
 * scripted relay ignores the decision; the test sends the roster itself.
 */
async function approveOnPage(
  page: Page,
  relay: FakeRelay,
  userId: string,
  role: Role,
): Promise<void> {
  const requestId = `req-${userId}`;
  relay.send(attachRequest(requestId, userId));
  await waitForDock(page, (state) => state.pendingRequests.some((r) => r.requestId === requestId));
  expect(await approveThroughHandle(page, requestId, role)).toBe(true);
}

function invokeFrame(
  callId: string,
  tool: string,
  client: { name: string; version: string } | null = null,
  deadlineMs = 45_000,
): RelayFrame {
  return {
    t: 'invoke',
    callId,
    tool,
    arguments: {},
    caller: { userId: 'alice', displayName: 'Alice', client, role: 'driver' },
    deadlineMs,
  };
}

test('Make driver and Make observer send set_role for that row', async ({ page }) => {
  const relay = await openWithFakeRelay(page);
  // The switch is only offered on rows the operator approved here.
  await approveOnPage(page, relay, 'bob', 'observer');
  relay.send({
    t: 'roster',
    attachments: [attachment('alice', 'Alice'), attachment('bob', 'Bob', 'observer')],
  });
  await clickInWidget(page, { action: 'make-driver', userId: 'bob' });
  await expect
    .poll(() => framesOf(relay, 'set_role'))
    .toEqual([{ t: 'set_role', userId: 'bob', role: 'driver' }]);

  // The relay applies it, so Bob's switch now offers the way back.
  relay.send({
    t: 'roster',
    attachments: [attachment('alice', 'Alice'), attachment('bob', 'Bob')],
  });
  await clickInWidget(page, { action: 'make-observer', userId: 'bob' });
  await expect
    .poll(() => framesOf(relay, 'set_role'))
    .toEqual([
      { t: 'set_role', userId: 'bob', role: 'driver' },
      { t: 'set_role', userId: 'bob', role: 'observer' },
    ]);
});

test('Revoke ends one attachment and Revoke all ends every one', async ({ page }) => {
  const relay = await openWithFakeRelay(page);
  relay.send({
    t: 'roster',
    attachments: [attachment('alice', 'Alice'), attachment('bob', 'Bob')],
  });
  await clickInWidget(page, { action: 'revoke', userId: 'bob' });
  await expect.poll(() => framesOf(relay, 'revoke')).toEqual([{ t: 'revoke', userId: 'bob' }]);

  relay.send({ t: 'roster', attachments: [attachment('alice', 'Alice')] });
  await waitForDock(page, (state) => state.roster.length === 1);
  await clickInWidget(page, { action: 'revoke-all' });
  await expect
    .poll(() => framesOf(relay, 'revoke'))
    .toEqual([
      { t: 'revoke', userId: 'bob' },
      { t: 'revoke', userId: '*' },
    ]);

  // With nobody attached there is nothing to revoke, so the control goes.
  relay.send({ t: 'roster', attachments: [] });
  await expect.poll(() => widgetButtonNow(page, { action: 'revoke-all' })).toBeNull();
});

test('a roster row that moves disarms its buttons until it holds still', async ({ page }) => {
  const relay = await openWithFakeRelay(page);
  await approveOnPage(page, relay, 'bob', 'observer');
  relay.send({
    t: 'roster',
    attachments: [attachment('bob', 'Bob', 'observer'), attachment('carol', 'Carol')],
  });
  const target = { action: 'make-driver', userId: 'bob' };
  const before = await widgetButtonCentre(page, target);

  await pauseClock(page);
  // Carol's row, below Bob's, grows when the relay renames her to something
  // that wraps; the panel is pinned at the bottom, so Bob's row moves up.
  const longName = `Carol ${'with a display name long enough to wrap '.repeat(2)}`.trim();
  relay.send({
    t: 'roster',
    attachments: [attachment('bob', 'Bob', 'observer'), attachment('carol', longName)],
  });
  await waitForDock(page, (state) => state.roster[1]?.displayName === longName);
  const moved = await widgetButtonNow(page, target);
  expect(moved?.armed).toBe(false);
  expect(moved?.y ?? before.y).toBeLessThan(before.y);

  // A click where Make driver now sits does nothing, and restarts the wait.
  await page.mouse.click(moved?.x ?? 0, moved?.y ?? 0);
  expect((await dockState(page))?.roster.map((entry) => entry.role)).toEqual([
    'observer',
    'driver',
  ]);
  await page.clock.runFor(ARM_DELAY_MS - 100);
  expect((await widgetButtonNow(page, target))?.armed).toBe(false);
  await page.clock.runFor(100);
  expect((await widgetButtonNow(page, target))?.armed).toBe(true);
  expect(framesOf(relay, 'set_role')).toEqual([]);

  await page.mouse.click(moved?.x ?? 0, moved?.y ?? 0);
  await expect
    .poll(() => framesOf(relay, 'set_role'))
    .toEqual([{ t: 'set_role', userId: 'bob', role: 'driver' }]);
});

test('a role switch the relay flips under the pointer waits again, though nothing moved', async ({
  page,
}) => {
  const relay = await openWithFakeRelay(page);
  await approveOnPage(page, relay, 'bob', 'driver');
  relay.send({ t: 'roster', attachments: [attachment('bob', 'Bob')] });
  const aimed = await widgetButtonCentre(page, { action: 'make-observer', userId: 'bob' });

  await pauseClock(page);
  // The relay says Bob is an observer now, so the button under the pointer would grant driver.
  relay.send({ t: 'roster', attachments: [attachment('bob', 'Bob', 'observer')] });
  await waitForDock(page, (state) => state.roster[0]?.role === 'observer');
  const flipped = await widgetButtonNow(page, { action: 'make-driver', userId: 'bob' });
  expect(flipped?.armed).toBe(false);
  await page.mouse.click(aimed.x, aimed.y);
  await page.clock.runFor(ARM_DELAY_MS);
  expect(framesOf(relay, 'set_role')).toEqual([]);
});

test('a client list that keeps changing neither moves a row nor makes its buttons wait again', async ({
  page,
}) => {
  const relay = await openWithFakeRelay(page);
  await approveOnPage(page, relay, 'alice', 'driver');
  const withClients = (count: number, round: number): AttachmentView => ({
    ...attachment('alice', 'Alice'),
    clients: Array.from({ length: count }, (_, i) => ({
      name: `a-client-that-renames-itself-${String(round)}-${String(i)}`,
      version: '1.0.0',
    })),
  });
  relay.send({ t: 'roster', attachments: [withClients(1, 0)] });
  const target = { action: 'revoke', userId: 'alice' };
  const before = await widgetButtonCentre(page, target);

  await pauseClock(page);
  // Any attached client names itself, on every call if it likes, and each new name is a new roster.
  for (let round = 1; round <= 5; round += 1) {
    relay.send({ t: 'roster', attachments: [withClients(round * 4, round)] });
    await waitForDock(page, (state) => state.roster[0]?.clients.length === round * 4);
    expect(await widgetButtonNow(page, target)).toEqual({ armed: true, ...before });
  }
  await page.mouse.click(before.x, before.y);
  await expect.poll(() => framesOf(relay, 'revoke')).toEqual([{ t: 'revoke', userId: 'alice' }]);
});

test('a row the page never approved says so and offers only Revoke, and every row shows the role the page enforces', async ({
  page,
}) => {
  const relay = await openWithFakeRelay(page);
  await approveOnPage(page, relay, 'bob', 'observer');
  // The relay claims both drive; only Bob was approved here, and as an observer.
  relay.send({
    t: 'roster',
    attachments: [attachment('mallory', 'Mallory'), attachment('bob', 'Bob')],
  });
  await waitForDock(page, (state) => state.roster.length === 2);
  const rows = await widgetItems(page, 'roster');
  expect(rows[0]?.text).toContain('Mallory (not approved on this page)');
  expect(rows[1]?.text).toContain('Bob (observer)');
  for (const action of ['make-driver', 'make-observer']) {
    expect(await widgetButtonNow(page, { action, userId: 'mallory' })).toBeNull();
  }

  // Bob's switch offers what he lacks on this page, whatever the relay says.
  await clickInWidget(page, { action: 'make-driver', userId: 'bob' });
  await expect
    .poll(() => framesOf(relay, 'set_role'))
    .toEqual([{ t: 'set_role', userId: 'bob', role: 'driver' }]);
  await clickInWidget(page, { action: 'revoke', userId: 'mallory' });
  await expect.poll(() => framesOf(relay, 'revoke')).toEqual([{ t: 'revoke', userId: 'mallory' }]);
  // Until the relay drops her, her row says the revoke is on its way.
  await expect
    .poll(async () => (await widgetItems(page, 'roster'))[0]?.text)
    .toContain('Mallory (revoke pending)');
});

test('the pause switch waits again after it flips, so a double click cannot pause and resume', async ({
  page,
}) => {
  await openWithFakeRelay(page);
  const aimed = await widgetButtonCentre(page, { action: 'pause' });

  await pauseClock(page);
  await page.mouse.click(aimed.x, aimed.y);
  await waitForDock(page, (state) => state.paused);
  expect((await widgetButtonNow(page, { action: 'resume' }))?.armed).toBe(false);
  // The second click of a double click lands on Resume, which does nothing yet.
  await page.mouse.click(aimed.x, aimed.y);
  await page.clock.runFor(ARM_DELAY_MS - 100);
  expect((await dockState(page))?.paused).toBe(true);
  expect((await widgetButtonNow(page, { action: 'resume' }))?.armed).toBe(false);
  await page.clock.runFor(100);
  expect((await widgetButtonNow(page, { action: 'resume' }))?.armed).toBe(true);

  await page.mouse.click(aimed.x, aimed.y);
  await waitForDock(page, (state) => !state.paused);
});

test('the activity log names the user, client, tool and outcome of each call', async ({ page }) => {
  const relay = await openWithFakeRelay(page);
  relay.send(attachRequest('req-alice', 'alice'));
  await waitForDock(page, (state) => state.pendingRequests.length === 1);
  expect(await approveThroughHandle(page, 'req-alice', 'driver')).toBe(true);
  relay.send({ t: 'roster', attachments: [attachment('alice', 'Alice')] });
  await waitForDock(page, (state) => state.roster.length === 1);

  const client = { name: 'test-client', version: '1.2.3' };
  relay.send(invokeFrame('call-1', 'get_view', client));
  await expect.poll(() => framesOf(relay, 'result').map((frame) => frame.ok)).toEqual([true]);
  relay.send(invokeFrame('call-2', 'no_such_tool'));
  await expect.poll(() => framesOf(relay, 'result')).toHaveLength(2);

  const text = (await widgetText(page, 'activity')) ?? '';
  const newer = text.indexOf('Alice: no_such_tool, tool_not_found');
  const older = text.search(/Alice via test-client 1\.2\.3: get_view, ok in \d+ ms/);
  // Newest first.
  expect(newer).toBeGreaterThanOrEqual(0);
  expect(older).toBeGreaterThan(newer);
  expect((await dockState(page))?.activity.map((entry) => entry.outcome)).toEqual([
    'tool_not_found',
    'ok',
  ]);
});

test('on the MCP-B polyfill, a write whose tool the page unregisters mid-run holds the page until its deadline and a grace', async ({
  page,
}) => {
  const relay = await openWithFakeRelay(page);
  // A single-page app's view change: switch_view's handler ends the
  // registration its own tool came with, then carries on for a second.
  const polyfill = await page.evaluate(async () => {
    const context = (
      document as unknown as {
        modelContext: {
          registerTool(tool: object, options?: { signal?: AbortSignal }): Promise<void>;
        };
      }
    ).modelContext;
    const events: [string, number][] = [];
    (window as unknown as { __viewEvents: [string, number][] }).__viewEvents = events;
    const view = new AbortController();
    await context.registerTool(
      {
        name: 'switch_view',
        description: 'Moves to another view, whose tools replace this one.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: false },
        execute: async () => {
          events.push(['switch_view start', performance.now()]);
          view.abort();
          await new Promise((resolve) => setTimeout(resolve, 1000));
          events.push(['switch_view end', performance.now()]);
          return 'switched';
        },
      },
      { signal: view.signal },
    );
    await context.registerTool({
      name: 'set_note',
      description: 'Writes a note.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: false },
      execute: () => {
        events.push(['set_note start', performance.now()]);
        return 'noted';
      },
    });
    return Reflect.get(context, '__isWebMCPPolyfill') === true;
  });
  expect(polyfill).toBe(true);
  await expect
    .poll(() =>
      framesOf(relay, 'tools')
        .at(-1)
        ?.tools.map((tool) => tool.name),
    )
    .toEqual(expect.arrayContaining(['switch_view', 'set_note']));
  await approveOnPage(page, relay, 'alice', 'driver');
  relay.send({ t: 'roster', attachments: [attachment('alice', 'Alice')] });
  await waitForDock(page, (state) => state.roster.length === 1);

  relay.send(invokeFrame('call-1', 'switch_view', null, 1500));
  relay.send(invokeFrame('call-2', 'set_note'));
  const outcomes = () =>
    framesOf(relay, 'result').map((frame) => [frame.callId, frame.error?.message ?? 'ok']);
  // The polyfill answers the first call at once, though its handler runs on.
  await expect.poll(outcomes).toEqual([['call-1', 'Tool unregistered']]);
  await expect
    .poll(() => widgetText(page, 'activity'))
    .toMatch(/switch_view, tool_error in \d+ ms, but its handler is still running/);

  // Nothing reports that handler's end, so set_note waits out the 1.5 s deadline plus 2 s.
  await expect.poll(outcomes, { timeout: 10_000 }).toEqual([
    ['call-1', 'Tool unregistered'],
    ['call-2', 'ok'],
  ]);
  const events = await page.evaluate(
    () => (window as unknown as { __viewEvents: [string, number][] }).__viewEvents,
  );
  expect(events.map(([event]) => event)).toEqual([
    'switch_view start',
    'switch_view end',
    'set_note start',
  ]);
  const started = Object.fromEntries(events);
  expect((started['set_note start'] ?? 0) - (started['switch_view start'] ?? 0)).toBeGreaterThan(
    3000,
  );
  expect(
    (await dockState(page))?.activity.map((entry) => [entry.callId, entry.handlerRunning]),
  ).toEqual([
    ['call-2', false],
    ['call-1', false],
  ]);
});

test('pause answers calls with page_busy, shows on the badge, and holds across a reload', async ({
  page,
}) => {
  const relay = await openWithFakeRelay(page);
  expect(await widgetVisible(page, 'badge-paused')).toBe(false);
  await clickInWidget(page, { action: 'pause' });
  await waitForDock(page, (state) => state.paused);
  expect(await widgetVisible(page, 'badge-paused')).toBe(true);

  relay.send(invokeFrame('call-1', 'get_view'));
  await expect
    .poll(() => framesOf(relay, 'result'))
    .toEqual([
      {
        t: 'result',
        callId: 'call-1',
        ok: false,
        error: {
          code: 'page_busy',
          message: expect.stringContaining('paused') as unknown as string,
        },
      },
    ]);

  // A reload must not quietly resume.
  await page.reload();
  await page.waitForSelector('html[data-tools="ready"]');
  await waitForDock(page, (state) => relay.connections === 2 && state.link === 'linked');
  expect((await dockState(page))?.paused).toBe(true);
  expect(await widgetVisible(page, 'badge-paused')).toBe(true);
  relay.send(invokeFrame('call-2', 'get_view'));
  await expect
    .poll(() => framesOf(relay, 'result').map((frame) => frame.error?.code))
    .toEqual(['page_busy', 'page_busy']);

  // Page script cannot press Resume; only the operator's own click lifts the pause.
  await scriptClickInWidget(page, { action: 'resume' });
  expect((await dockState(page))?.paused).toBe(true);
  await clickInWidget(page, { action: 'resume' });
  await waitForDock(page, (state) => !state.paused);
  expect(await widgetVisible(page, 'badge-paused')).toBe(false);
  // Running calls again: this caller lost its approval with the reload, so the role check answers.
  relay.send(invokeFrame('call-3', 'get_view'));
  await expect
    .poll(() => framesOf(relay, 'result').map((frame) => frame.error?.code))
    .toEqual(['page_busy', 'page_busy', 'role_denied']);
});

// M3: the pairing QR code. A relay with a public URL sends a pairing URL whose
// fragment holds a single-use nonce; the widget draws it as one SVG path inside
// the closed shadow root, built with DOM calls, so it works on a page that
// enforces Trusted Types, and the URL never reaches the console.

// Shaped like the relay's: its public URL, /pair#, and a 22-character base64url nonce.
const PAIRING_NONCE = 'q3Zf0_Wn-8xLr2TmB9cKpA';
const NEXT_PAIRING_NONCE = 'Vb7nQ1sX_e4Jk0LmZp9RtA';
const PAIRING_URL = `https://tabdock-owner.ngrok-free.app/pair#${PAIRING_NONCE}`;
const NEXT_PAIRING_URL = `https://tabdock-owner.ngrok-free.app/pair#${NEXT_PAIRING_NONCE}`;
/** The QR spec's quiet zone: four light modules on every side. */
const QUIET_ZONE = 4;

/** What a strict page sends: Trusted Types for every script sink, and no data: images. */
const TRUSTED_TYPES_CSP = "require-trusted-types-for 'script'; img-src 'self'";
const TRUSTED_HTML_ERROR = "This document requires 'TrustedHTML' assignment.";

interface Violation {
  directive: string;
  sample: string;
}

/**
 * Serves the demo page with TRUSTED_TYPES_CSP added to the demo server's own
 * policy on its way to the browser, so the page is the real demo page under a
 * strict CSP, and records every violation the page reports.
 */
async function enforceTrustedTypes(page: Page): Promise<() => Promise<Violation[]>> {
  await page.addInitScript(() => {
    const seen: Violation[] = [];
    Object.defineProperty(window, '__cspViolations', { value: seen });
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push({ directive: event.effectiveDirective, sample: event.sample });
    });
  });
  const demoOrigin = new URL(demo.url).origin;
  await page.route(
    (url) => url.origin === demoOrigin && url.pathname === '/',
    async (route) => {
      const response = await route.fetch();
      const headers = response.headers();
      const own = headers['content-security-policy'];
      await route.fulfill({
        response,
        headers: {
          ...headers,
          'content-security-policy': own ? `${own}; ${TRUSTED_TYPES_CSP}` : TRUSTED_TYPES_CSP,
        },
      });
    },
  );
  return () =>
    page.evaluate(() => (window as unknown as { __cspViolations: Violation[] }).__cspViolations);
}

/** Every console line the page writes, of any level. */
function recordConsole(page: Page): string[] {
  const lines: string[] = [];
  page.on('console', (message) => lines.push(message.text()));
  return lines;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The QR drawing and what sits around it, read from inside the closed shadow root. */
interface QrReading {
  namespace: string | null;
  /** Every element inside the svg, by name. */
  inside: string[];
  viewBox: string | null;
  d: string | null;
  qr: Box;
  code: Box | null;
  /** How far the panel's content is wider than the panel; above 0 means it scrolls sideways. */
  panelOverflow: number;
}

interface CdpNode {
  backendNodeId: number;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
}

function nodeWithRole(node: CdpNode, role: string): CdpNode | null {
  const list = node.attributes ?? [];
  for (let i = 0; i + 1 < list.length; i += 2) {
    if (list[i] === 'data-role' && list[i + 1] === role) return node;
  }
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
    const found = nodeWithRole(child, role);
    if (found) return found;
  }
  return null;
}

/** Page script cannot reach into the closed shadow root; the DevTools protocol can. */
async function readQr(page: Page): Promise<QrReading> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const node = nodeWithRole(root, 'pairing-qr');
    if (!node) throw new Error('the widget has no pairing-qr element');
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: node.backendNodeId });
    if (object.objectId === undefined) throw new Error('could not resolve the QR element');
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function () {
        const box = (element) => {
          if (!element) return null;
          const { left, top, right, bottom } = element.getBoundingClientRect();
          return { left, top, right, bottom };
        };
        const svg = this.firstElementChild;
        const panel = this.closest('.panel');
        return {
          namespace: svg ? svg.namespaceURI : null,
          inside: svg ? Array.from(svg.querySelectorAll('*'), (element) => element.localName) : [],
          viewBox: svg ? svg.getAttribute('viewBox') : null,
          d: svg && svg.firstElementChild ? svg.firstElementChild.getAttribute('d') : null,
          qr: box(this),
          code: box(panel.querySelector('[data-role="pairing-code"]')),
          panelOverflow: panel.scrollWidth - panel.clientWidth,
        };
      }`,
      returnByValue: true,
    });
    return result.value as QrReading;
  } finally {
    await cdp.detach();
  }
}

/** The dark modules a path draws, which must be nothing but one-module-tall runs. */
function drawnModules(d: string): Set<string> {
  const run = /M(\d+) (\d+)h(\d+)v1h-(\d+)z/gy;
  const dark = new Set<string>();
  let end = 0;
  for (let match = run.exec(d); match !== null; match = run.exec(d)) {
    const [, x = 0, y = 0, width = 0, back] = match.map(Number);
    expect(back).toBe(width);
    for (let col = x; col < x + width; col += 1) dark.add(`${y},${col}`);
    end = run.lastIndex;
  }
  expect(end).toBe(d.length);
  return dark;
}

/** The library's matrix for a URL at level M, shifted by the quiet zone, and the side with it. */
function libraryModules(url: string): { modules: number; size: number; dark: Set<string> } {
  const code = encodeQr(url);
  if (!code) throw new Error('the library would not encode the URL');
  const modules = code.getModuleCount();
  const dark = new Set<string>();
  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (code.isDark(row, col)) dark.add(`${row + QUIET_ZONE},${col + QUIET_ZONE}`);
    }
  }
  return { modules, size: modules + 2 * QUIET_ZONE, dark };
}

function expectDrawing(reading: QrReading, url: string): void {
  const expected = libraryModules(url);
  expect(reading.namespace).toBe('http://www.w3.org/2000/svg');
  expect(reading.inside).toEqual(['path']);
  expect(reading.viewBox).toBe(`0 0 ${expected.size} ${expected.size}`);
  const dark = drawnModules(reading.d ?? '');
  expect(dark.size).toBe(expected.dark.size);
  expect(dark).toEqual(expected.dark);
}

test('the pairing URL draws as a QR code under Trusted Types, matches the library, redraws for a new pairing and never reaches the console', async ({
  page,
}) => {
  const lines = recordConsole(page);
  const violations = await enforceTrustedTypes(page);
  const relay = await openWithFakeRelay(page, { pairingUrl: PAIRING_URL });
  await expect.poll(() => widgetVisible(page, 'pairing-qr')).toBe(true);
  const first = await readQr(page);
  expectDrawing(first, PAIRING_URL);
  expect(first.qr.right - first.qr.left).toBeGreaterThanOrEqual(120);

  // A new ticket (a rotation, or a code used up) brings a new URL.
  relay.send({
    t: 'pairing',
    code: 'KMNPQ-RSTVW',
    url: NEXT_PAIRING_URL,
    expiresAt: Date.now() + 120_000,
  });
  await waitForDock(page, (state) => state.pairing?.code === 'KMNPQ-RSTVW');
  const next = await readQr(page);
  expect(next.d).not.toBe(first.d);
  expectDrawing(next, NEXT_PAIRING_URL);
  expect(await widgetVisible(page, 'pairing-qr')).toBe(true);

  // Loading the adapter and drawing the widget broke nothing: zod runs jitless
  // (packages/protocol/src/zod-config.ts), so not even its eval probe is reported.
  expect(await violations()).toEqual([]);
  // And the policy was in force: the library's own SVG string would have been refused.
  const blocked = await page.evaluate(
    (svg) => {
      try {
        document.createElement('div').innerHTML = svg;
        return 'allowed';
      } catch (error) {
        return error instanceof TypeError ? 'blocked' : 'other';
      }
    },
    encodeQr(PAIRING_URL)?.createSvgTag() ?? '<svg></svg>',
  );
  expect(blocked).toBe('blocked');
  expectedErrors.push(TRUSTED_HTML_ERROR);

  // The nonce is a credential (S11): no console line carries either URL.
  expect(lines.length).toBeGreaterThan(0);
  for (const secret of [PAIRING_NONCE, NEXT_PAIRING_NONCE, '/pair#']) {
    expect(lines.filter((line) => line.includes(secret))).toEqual([]);
  }
});

test('a pairing without a URL, or with one that is not https, shows the code and no QR code', async ({
  page,
}) => {
  const relay = await openWithFakeRelay(page);
  expect(await widgetVisible(page, 'pairing-code')).toBe(true);
  expect(await widgetVisible(page, 'pairing-qr')).toBe(false);
  expect((await readQr(page)).d).toBeNull();

  const pairing = (code: string, url?: string): RelayFrame => ({
    t: 'pairing',
    code,
    ...(url === undefined ? {} : { url }),
    expiresAt: Date.now() + 120_000,
  });
  // The relay builds the URL from its public URL, which must be https; a phone is never sent anywhere else.
  relay.send(pairing('CDEFG-HJKMN', `http://tabdock-owner.ngrok-free.app/pair#${PAIRING_NONCE}`));
  await waitForDock(page, (state) => state.pairing?.code === 'CDEFG-HJKMN');
  expect(await widgetVisible(page, 'pairing-qr')).toBe(false);
  expect((await readQr(page)).d).toBeNull();

  relay.send(pairing('DEFGH-JKMNP', PAIRING_URL));
  await expect.poll(() => widgetVisible(page, 'pairing-qr')).toBe(true);
  expectDrawing(await readQr(page), PAIRING_URL);

  // The next ticket comes without one: the old drawing goes, and nothing of it stays behind.
  relay.send(pairing('EFGHJ-KMNPQ'));
  await waitForDock(page, (state) => state.pairing?.code === 'EFGHJ-KMNPQ');
  expect(await widgetVisible(page, 'pairing-qr')).toBe(false);
  const cleared = await readQr(page);
  expect(cleared.d).toBeNull();
  expect(cleared.viewBox).toBeNull();
  expect(await widgetText(page, 'pairing-code')).toBe('EFGHJ-KMNPQ');
});

test('at phone width the QR code and the typed code both fit the panel, and on a laptop they sit side by side', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openWithFakeRelay(page, { pairingUrl: PAIRING_URL });
  await expect.poll(() => widgetVisible(page, 'pairing-qr')).toBe(true);
  /** One line of the 26 px code is about 31 px tall; a wrapped code would be twice that. */
  const ONE_LINE = 40;

  const phone = await readQr(page);
  expectDrawing(phone, PAIRING_URL);
  expect(phone.panelOverflow).toBeLessThanOrEqual(0);
  expect(phone.qr.left).toBeGreaterThanOrEqual(0);
  expect(phone.qr.right).toBeLessThanOrEqual(360);
  expect(phone.qr.right - phone.qr.left).toBeGreaterThanOrEqual(120);
  // No room for both on one line, so the code goes below the QR, whole.
  const code = phone.code ?? { left: 0, top: 0, right: 0, bottom: 0 };
  expect(code.top).toBeGreaterThanOrEqual(phone.qr.bottom);
  expect(code.right).toBeLessThanOrEqual(360);
  expect(code.bottom - code.top).toBeLessThan(ONE_LINE);

  await page.setViewportSize({ width: 1280, height: 1200 });
  const laptop = await readQr(page);
  const beside = laptop.code ?? { left: 0, top: 0, right: 0, bottom: 0 };
  expect(laptop.panelOverflow).toBeLessThanOrEqual(0);
  expect(beside.left).toBeGreaterThanOrEqual(laptop.qr.right);
  expect(beside.top).toBeGreaterThanOrEqual(laptop.qr.top);
  expect(beside.bottom).toBeLessThanOrEqual(laptop.qr.bottom);
  expect(beside.bottom - beside.top).toBeLessThan(ONE_LINE);
});

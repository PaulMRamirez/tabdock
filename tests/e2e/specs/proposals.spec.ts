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
  PROPOSAL_TTL_MS,
  type RelayFrame,
  RESUME_WINDOW_MS,
} from '@tabdock/protocol';
import { proposalButtonNow, proposalRow } from '../src/proposal-helpers.ts';
import {
  approveThroughHandle,
  clickInWidget,
  demoPageUrl,
  scriptClickInWidget,
  waitForDock,
  widgetEvaluate,
  widgetText,
  widgetVisible,
} from '../src/tabdock-harness.ts';

// The operator's proposal queue (ADR 0042, A6.11) against a scripted relay:
// Playwright's routeWebSocket stands in for it, so a test puts proposals
// before the board as a relay would, and Playwright's clock holds the
// widget's timers still while a test checks what a click inside the arming
// window does. Each row is an armed box whose Accept is that call's
// confirmation; at a phone's width twenty rows scroll within their own list.

/** Never dialled: routeWebSocket answers in its place. */
const FAKE_RELAY = 'ws://127.0.0.1:9/page';
/** The widget's ARM_DELAY_MS. */
const ARM_DELAY_MS = 500;

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

interface FakeRelay {
  readonly frames: PageFrame[];
  send(frame: RelayFrame): void;
}

function observer(userId: string): AttachmentView {
  return {
    userId,
    displayName: userId.charAt(0).toUpperCase() + userId.slice(1),
    kind: 'member',
    role: 'observer',
    grantedAt: Date.now(),
    lastUsedAt: null,
    expiresAt: null,
    clients: [],
    inviteId: null,
    endsAt: null,
  };
}

async function routeFakeRelay(page: Page): Promise<FakeRelay> {
  const frames: PageFrame[] = [];
  let current: WebSocketRoute | null = null;
  await page.routeWebSocket(FAKE_RELAY, (ws) => {
    current = ws;
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
          },
        }),
      );
    });
  });
  return {
    frames,
    send(frame) {
      if (!current) throw new Error('the page has not connected');
      current.send(encodeFrame(frame));
    },
  };
}

/** The board with ?proposals=all, linked to the scripted relay, with these users seated as observers. */
async function openBoard(page: Page, users: readonly string[]): Promise<FakeRelay> {
  await page.clock.install();
  const relay = await routeFakeRelay(page);
  const url = new URL(demoPageUrl(demo, FAKE_RELAY));
  url.searchParams.set('proposals', 'all');
  await page.goto(url.href);
  await page.waitForSelector('html[data-tools="ready"]');
  await waitForDock(page, (state) => state.link === 'linked');
  for (const userId of users) {
    relay.send({
      t: 'attach_request',
      requestId: `rq-${userId}`,
      user: { userId, displayName: observer(userId).displayName },
      account: { kind: 'member', verified: true },
      via: 'code',
      client: { name: 'claude-code', version: '2.1.290' },
      expiresAt: Date.now() + ATTACH_REQUEST_TTL_MS,
    });
    await waitForDock(page, (state) =>
      state.pendingRequests.some((request) => request.requestId === `rq-${userId}`),
    );
    expect(await approveThroughHandle(page, `rq-${userId}`, 'observer')).toBe(true);
  }
  relay.send({ t: 'roster', attachments: users.map(observer) });
  await waitForDock(page, (state) => state.roster.length === users.length);
  return relay;
}

function propose(
  relay: FakeRelay,
  proposalId: string,
  userId: string,
  args: Record<string, unknown> = { label: 'Stop 3', x: 1, y: 2 },
): void {
  relay.send({
    t: 'proposal',
    proposalId,
    tool: 'add_item',
    arguments: args,
    proposer: {
      userId,
      displayName: observer(userId).displayName,
      client: { name: 'claude-code', version: '2.1.290' },
      role: 'observer',
    },
    expiresAt: Date.now() + PROPOSAL_TTL_MS,
  });
}

async function shown(page: Page, count: number): Promise<void> {
  await waitForDock(page, (state) => state.proposals.length === count);
  // The queue rings the badge rather than opening the panel, so open it as the operator would.
  if (!(await widgetVisible(page, 'proposal-list'))) {
    await clickInWidget(page, { action: 'toggle' });
  }
}

function decisions(relay: FakeRelay) {
  return relay.frames.filter((frame) => frame.t === 'proposal_decision');
}

/** Stops the page's timers; only runFor moves them on from here. */
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

test('a row takes no click until it has held still on screen, never a script’s, and then accepts', async ({
  page,
}) => {
  const relay = await openBoard(page, ['bob']);
  propose(relay, 'pr_1', 'bob');
  await shown(page, 1);
  // The page takes a proposal only once it has read its tools, which waits on
  // the page's timers, so the clock stops after; closing and opening the
  // panel then puts the row on screen afresh, as a new one comes.
  await pauseClock(page);
  await clickInWidget(page, { action: 'toggle' });
  await clickInWidget(page, { action: 'toggle' });
  const accept = await proposalButtonNow(page, 'pr_1', 'proposal-accept');
  expect(accept?.armed).toBe(false);
  // A click inside the arming window does nothing, and starts the wait again.
  await page.mouse.click(accept?.x ?? 0, accept?.y ?? 0);
  await page.clock.runFor(ARM_DELAY_MS - 100);
  expect((await proposalButtonNow(page, 'pr_1', 'proposal-accept'))?.armed).toBe(false);
  await page.clock.runFor(100);
  expect((await proposalButtonNow(page, 'pr_1', 'proposal-accept'))?.armed).toBe(true);
  expect(decisions(relay)).toEqual([]);
  // A page script's click is never trusted.
  await scriptClickInWidget(page, { action: 'proposal-accept', proposalId: 'pr_1' });
  expect(decisions(relay)).toEqual([]);
  expect(await widgetText(page, 'badge-proposals')).toBe('1 proposed');

  await page.mouse.click(accept?.x ?? 0, accept?.y ?? 0);
  await expect
    .poll(() => decisions(relay))
    .toEqual([{ t: 'proposal_decision', proposalId: 'pr_1', accept: true }]);
  await waitForDock(page, (state) => state.proposals.length === 0);
  expect(await widgetVisible(page, 'badge-proposals')).toBe(false);
});

test('arguments show as the caller wrote them, escaped and cut with the count left out', async ({
  page,
}) => {
  const relay = await openBoard(page, ['bob']);
  const label = `pay ‮evil ${'x'.repeat(300)}`;
  propose(relay, 'pr_1', 'bob', { label, x: 1, y: 2 });
  await shown(page, 1);
  const text = String(await proposalRow(page, 'pr_1'));
  expect(text).toContain('Bob proposes add_item');
  expect(text).toContain('Arguments, as their client wrote them:');
  expect(text).toContain('pay \\u202eevil');
  expect(text).not.toContain('‮');
  const whole = `{"label":"pay \\u202eevil ${'x'.repeat(300)}","x":1,"y":2}`;
  expect(text).toContain(`... (${String(whole.length - 160)} more characters)`);
  // Show all shows the whole text, and the row waits again before its Accept takes a click.
  await clickInWidget(page, { action: 'proposal-args', proposalId: 'pr_1' });
  expect(
    await widgetEvaluate(page, 'proposal-args', 'function () { return this.textContent; }'),
  ).toBe(whole);
  expect((await proposalButtonNow(page, 'pr_1', 'proposal-accept'))?.armed).toBe(false);
});

test('Dismiss all is not held back, and a paused page takes no Accept', async ({ page }) => {
  const relay = await openBoard(page, ['bob']);
  propose(relay, 'pr_1', 'bob');
  propose(relay, 'pr_2', 'bob');
  await shown(page, 2);
  await page.evaluate(() => {
    window.__tabdockDock?.pause(true);
  });
  const accept = await proposalButtonNow(page, 'pr_1', 'proposal-accept');
  expect(accept?.disabled).toBe(true);
  expect(String(await proposalRow(page, 'pr_1'))).toContain('Resume the page to accept');
  await page.mouse.click(accept?.x ?? 0, accept?.y ?? 0);
  expect(decisions(relay)).toEqual([]);
  await clickInWidget(page, { action: 'proposal-dismiss-all' });
  await expect
    .poll(() => decisions(relay))
    .toEqual([
      { t: 'proposal_decision', proposalId: 'pr_1', accept: false },
      { t: 'proposal_decision', proposalId: 'pr_2', accept: false },
    ]);
});

for (const viewport of [
  { width: 360, height: 640 },
  { width: 320, height: 568 },
]) {
  test(`twenty proposals at ${String(viewport.width)} by ${String(viewport.height)} scroll in their own list, every Accept reachable`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const users = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7'];
    const relay = await openBoard(page, users);
    const ids: string[] = [];
    for (let n = 0; n < 20; n += 1) {
      const id = `pr_${String(n + 1).padStart(2, '0')}`;
      ids.push(id);
      propose(relay, id, users[Math.floor(n / 3)] ?? 'u7', {
        label: `Stop ${String(n)}`,
        x: n,
        y: n,
      });
    }
    await shown(page, 20);
    expect(await widgetText(page, 'badge-proposals')).toBe('20 proposed');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const list = (await widgetEvaluate(
      page,
      'proposal-list',
      'function () { return { scroll: this.scrollHeight, client: this.clientHeight, width: this.scrollWidth, shown: this.clientWidth }; }',
    )) as { scroll: number; client: number; width: number; shown: number };
    expect(list.scroll).toBeGreaterThan(list.client);
    expect(list.client).toBeLessThanOrEqual(viewport.height * 0.45 + 1);
    expect(list.width).toBeLessThanOrEqual(list.shown);
    for (const id of ids) {
      const accept = await proposalButtonNow(page, id, 'proposal-accept');
      expect(accept, id).not.toBeNull();
      expect(accept?.x ?? -1, id).toBeGreaterThanOrEqual(0);
      expect(accept?.x ?? Infinity, id).toBeLessThanOrEqual(viewport.width);
      expect(accept?.y ?? -1, id).toBeGreaterThanOrEqual(0);
      expect(accept?.y ?? Infinity, id).toBeLessThanOrEqual(viewport.height);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}

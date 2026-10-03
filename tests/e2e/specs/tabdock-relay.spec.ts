import type { Client } from '@modelcontextprotocol/client';
import { expect, test, type Page } from '@playwright/test';
import { startDemoServer, type DemoServer } from '@tabdock/demo/server';
import {
  type PageFrame,
  parsePageFrame,
  parseRelayFrame,
  type RelayFrame,
  type Role,
  untrustedHeader,
} from '@tabdock/protocol';
import type { DevTokenUser } from '@tabdock/relay';
import {
  activityStrip,
  callTool,
  clickInWidget,
  connectMcp,
  dockState,
  errorCode,
  scriptClickInWidget,
  startTabdock,
  waitForDock,
  waitForLink,
  widgetButtonCentre,
  widgetButtonNow,
  widgetItems,
  widgetText,
  widgetVisible,
  type Tabdock,
} from '../src/tabdock-harness.ts';

// Tabdock in a real browser: the demo page runs the real adapter (bundled into
// the page, over the MCP-B polyfill or native WebMCP) and dials a Tabdock
// relay; MCP clients pair by the code on the page, and the operator answers by
// clicking the widget. The M1 specs come first, then the M2 ones.

declare global {
  interface Window {
    /** slow_write's controls; only the M2 specs below register that tool on the demo page. */
    __slowWrite?: SlowWrite;
  }
}

interface SlowWrite {
  /** How many times the page ran the handler. */
  started: number;
  /** Whether the runtime handed the handler an AbortSignal, and whether it fired. */
  signal: 'none' | 'live' | 'aborted';
  /** Lets every run of the handler return. */
  finish: () => void;
}

let demo: DemoServer;
let tabdock: Tabdock;
/** Alice's first client, on a 2025 MCP revision. */
let client: Client;
/** Clients a test opened beside `client`, closed after it. */
let extraClients: Client[];
/** Everything the page printed to its console, and every pairing code it showed. */
let consoleLines: string[];
let codesSeen: Set<string>;
/** Codes already handed to pair_page; each works once. */
let codesUsed: Set<string>;
/** Console errors a test causes on purpose; see allowConsoleError. */
let allowedErrors: RegExp[];
/** Every relay log line, at debug level, so ordering checks can read the queue. */
let relayLogs: string[];
/** Every frame on the page's link to the relay, in the order the page sent or received it. */
let linkFrames: { from: 'page' | 'relay'; text: string }[];

const ALICE_CLIENT = 'tabdock-playwright';
const ALICE_MODERN_CLIENT = 'tabdock-playwright-modern';
const BOB_CLIENT = 'tabdock-playwright-bob';

test.beforeAll(async () => {
  demo = await startDemoServer();
});
test.afterAll(async () => {
  await demo.close();
});
test.beforeEach(async ({ page }) => {
  relayLogs = [];
  tabdock = await startTabdock({
    demo,
    logLevel: 'debug',
    logSink: (line) => {
      relayLogs.push(line);
    },
  });
  client = await connectMcp(tabdock.relay, tabdock.users.alice, ALICE_CLIENT);
  extraClients = [];
  consoleLines = [];
  codesSeen = new Set();
  codesUsed = new Set();
  allowedErrors = [];
  linkFrames = [];
  page.on('console', (message) => {
    // Full Chrome (CHROMIUM_EXECUTABLE), unlike Playwright's headless shell,
    // asks for /favicon.ico, which the demo server does not serve. That miss is
    // the browser's, not the page's, so it is kept apart from real errors.
    const faviconMiss =
      message.type() === 'error' &&
      message.text().startsWith('Failed to load resource') &&
      message.location().url === new URL('/favicon.ico', demo.url).href;
    consoleLines.push(`${faviconMiss ? 'favicon' : message.type()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => consoleLines.push(`pageerror: ${error.message}`));
  page.on('websocket', (socket) => {
    if (socket.url() !== tabdock.relay.pageUrl) return;
    socket.on('framesent', ({ payload }) =>
      linkFrames.push({ from: 'page', text: String(payload) }),
    );
    socket.on('framereceived', ({ payload }) =>
      linkFrames.push({ from: 'relay', text: String(payload) }),
    );
  });
});
test.afterEach(async () => {
  for (const extra of extraClients) await extra.close();
  await client.close();
  await tabdock.close();
  // The adapter logs to the console; no page error, token or code may show up there (S11).
  expect(
    consoleLines.filter(
      (line) =>
        /^(error|pageerror):/.test(line) && !allowedErrors.some((allowed) => allowed.test(line)),
    ),
  ).toEqual([]);
  // Nor in the relay's own log, debug lines included. Only counts are compared, so a failure prints no secret.
  const secrets = [
    tabdock.users.alice.token,
    tabdock.users.bob.token,
    ...codesSeen,
    ...secretsOnLink(),
  ];
  for (const secret of secrets) {
    expect(consoleLines.filter((line) => line.includes(secret)).length).toBe(0);
    expect(relayLogs.filter((line) => line.includes(secret)).length).toBe(0);
  }
});

/**
 * Every pairing code and resume token the relay sent the page, rotated codes
 * no test step read included, so the log checks in afterEach cover them all.
 */
function secretsOnLink(): string[] {
  return linkFrames.flatMap(({ from, text }) => {
    if (from !== 'relay') return [];
    const parsed = parseRelayFrame(text);
    if (parsed.kind !== 'ok') return [];
    const { frame } = parsed;
    if (frame.t === 'welcome') return [frame.pairing.code, frame.resumeToken];
    return frame.t === 'pairing' ? [frame.code] : [];
  });
}

/**
 * Native WebMCP reports a handler that throws on the console as well
 * ("WebMCP tool execution failed: Uncaught BoardError: ..."); the polyfill
 * does not. A test that makes a handler throw on purpose allows that one line.
 */
function allowHandlerError(message: string): void {
  const escaped = message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  allowedErrors.push(
    new RegExp(`^error: WebMCP tool execution failed: Uncaught \\w+: ${escaped}$`),
  );
}

async function openDemo(page: Page): Promise<{ pageId: string; code: string }> {
  await page.goto(tabdock.pageUrl);
  await page.waitForSelector('html[data-tools="ready"]');
  const linked = await waitForLink(page);
  codesSeen.add(linked.code);
  return linked;
}

/** pair_page, then a click on the widget's Allow as driver button. */
async function pairByClick(page: Page): Promise<string> {
  const { code } = await waitForLink(page);
  codesSeen.add(code);
  const pending = callTool(client, 'pair_page', { code });
  const requestId = await waitForDock(page, (s) => s.pendingRequests[0]?.requestId);
  await clickInWidget(page, { action: 'approve-driver', requestId });
  const paired = await pending;
  expect(paired.isError, paired.text).toBe(false);
  expect(paired.structured).toMatchObject({ role: 'driver' });
  return (paired.structured as { page: string }).page;
}

async function waitForToolCount(pageId: string, count: number): Promise<{ name: string }[]> {
  let tools: { name: string }[] = [];
  await expect
    .poll(async () => {
      const listed = await callTool(client, 'list_page_tools', { page: pageId });
      tools = (listed.structured as { tools?: { name: string }[] } | undefined)?.tools ?? [];
      return tools.length;
    })
    .toBe(count);
  return tools;
}

test('the widget shows the pairing code in a closed shadow root page script cannot open', async ({
  page,
}) => {
  const { code } = await openDemo(page);
  const host = await page.evaluate(() => {
    const element = document.querySelector('tabdock-dock');
    return { present: element !== null, shadowRoot: element?.shadowRoot ?? null };
  });
  expect(host).toEqual({ present: true, shadowRoot: null });
  expect(await widgetText(page, 'pairing-code')).toBe(code);
  // Nobody is attached yet, so the panel opened by itself: the code shows without a click.
  expect(await widgetVisible(page, 'pairing-code')).toBe(true);
  // The badge still closes and reopens it.
  await clickInWidget(page, { action: 'toggle' });
  await expect.poll(() => widgetVisible(page, 'pairing-code')).toBe(false);
  await clickInWidget(page, { action: 'toggle' });
  await expect.poll(() => widgetVisible(page, 'pairing-code')).toBe(true);
  // The console guard in afterEach sees the adapter's own lines.
  expect(consoleLines.some((line) => line.includes('[tabdock] linked as page'))).toBe(true);
  await expect(page.locator('[data-role="status"]')).toHaveText(
    /Tabdock relay 127\.0\.0\.1:\d+: linked/,
  );
});

test('pair by code, approve by clicking Allow as driver, then list and call tools', async ({
  page,
}) => {
  const { pageId } = await openDemo(page);
  expect(await pairByClick(page)).toBe(pageId);
  // pair_page answers once the relay records the attachment; the roster frame
  // reaches the page a moment later, so wait for it rather than read at once.
  await expect
    .poll(async () => (await dockState(page))?.roster.map((a) => [a.userId, a.role]))
    .toEqual([['alice', 'driver']]);

  const tools = await waitForToolCount(pageId, 6);
  expect(tools.map((t) => t.name).sort()).toEqual([
    'add_item',
    'clear_board',
    'get_view',
    'highlight_item',
    'list_items',
    'move_view',
  ]);
  const pages = await callTool(client, 'list_pages');
  const origin = new URL(demo.url).origin;
  expect((pages.structured as { pages: unknown[] }).pages).toEqual([
    {
      page: pageId,
      origin,
      title: 'Tabdock demo board',
      role: 'driver',
      state: 'awake',
      toolCount: 6,
    },
  ]);

  const view = await callTool(client, 'call_page_tool', { page: pageId, tool: 'get_view' });
  expect(view.isError, view.text).toBe(false);
  expect(view.text.split('\n', 1)[0]).toBe(untrustedHeader(origin, 'get_view'));
  expect(view.structured).toMatchObject({ zoom: 1 });

  const added = await callTool(client, 'call_page_tool', {
    page: pageId,
    tool: 'add_item',
    arguments: { label: 'From Playwright', x: 120, y: 80, color: 'purple' },
  });
  expect(added.isError, added.text).toBe(false);
  expect(added.structured).toMatchObject({ item: { id: 'item-4', label: 'From Playwright' } });
  await expect(page.locator('[data-role="view"]')).toHaveText(/4 items/);
  expect((await activityStrip(page))[0]).toMatch(/add_item: added item-4/);

  // A handler error is page content, labelled like any result.
  allowHandlerError('No item with id item-999');
  const missing = await callTool(client, 'call_page_tool', {
    page: pageId,
    tool: 'highlight_item',
    arguments: { id: 'item-999' },
  });
  expect(missing.isError).toBe(true);
  expect(missing.text.split('\n', 1)[0]).toBe(untrustedHeader(origin, 'highlight_item'));
});

test('Deny on an attach request returns denied_by_operator and attaches nobody', async ({
  page,
}) => {
  const { code } = await openDemo(page);
  const pending = callTool(client, 'pair_page', { code });
  const requestId = await waitForDock(page, (s) => s.pendingRequests[0]?.requestId);

  // A script's click is not the operator's: the widget ignores events that are not trusted.
  await scriptClickInWidget(page, { action: 'approve-driver', requestId });
  expect((await dockState(page))?.pendingRequests.map((r) => r.requestId)).toEqual([requestId]);

  await clickInWidget(page, { action: 'deny', requestId });
  const denied = await pending;
  expect(errorCode(denied), denied.text).toBe('denied_by_operator');
  const state = await dockState(page);
  expect(state?.pendingRequests).toEqual([]);
  expect(state?.roster).toEqual([]);
  const pages = await callTool(client, 'list_pages');
  expect(pages.text).toMatch(/not attached to any page/);
});

test('Allow as observer attaches an observer, whose add_item returns role_denied', async ({
  page,
}) => {
  const { pageId, code } = await openDemo(page);
  const pending = callTool(client, 'pair_page', { code });
  const requestId = await waitForDock(page, (s) => s.pendingRequests[0]?.requestId);
  await clickInWidget(page, { action: 'approve-observer', requestId });
  const paired = await pending;
  expect(paired.isError, paired.text).toBe(false);
  expect(paired.structured).toMatchObject({ page: pageId, role: 'observer' });
  await expect
    .poll(async () => (await dockState(page))?.roster.map((a) => [a.userId, a.role]))
    .toEqual([['alice', 'observer']]);
  await waitForToolCount(pageId, 6);

  const added = await callTool(client, 'call_page_tool', {
    page: pageId,
    tool: 'add_item',
    arguments: { label: 'Not allowed', x: 10, y: 10 },
  });
  expect(errorCode(added), added.text).toBe('role_denied');
  await expect(page.locator('[data-role="view"]')).toHaveText(/3 items/);
  // Reading is what an observer may do.
  const view = await callTool(client, 'call_page_tool', { page: pageId, tool: 'get_view' });
  expect(view.isError, view.text).toBe(false);
});

test('a prompt that arrives as the operator clicks cannot take a click meant for another', async ({
  page,
}) => {
  const { code } = await openDemo(page);
  const bob = await connectMcp(tabdock.relay, tabdock.users.bob, 'tabdock-playwright-bob');
  try {
    const aliceAsks = callTool(client, 'pair_page', { code });
    const first = await waitForDock(page, (s) => s.pendingRequests[0]?.requestId);
    // The operator aims at Allow as driver on Alice's prompt...
    const aim = await widgetButtonCentre(page, { action: 'approve-driver', requestId: first });

    // ...and Bob's request lands just before the click.
    const nextCode = await waitForDock(page, (s) =>
      s.pairing && s.pairing.code !== code ? s.pairing.code : null,
    );
    codesSeen.add(nextCode);
    const bobAsks = callTool(bob, 'pair_page', { code: nextCode });
    await page.waitForFunction(() => window.__tabdockDock?.state.pendingRequests.length === 2);
    const second =
      (await dockState(page))?.pendingRequests.find((r) => r.user.userId === 'bob')?.requestId ??
      '';
    // New prompts go on top, so Alice's button has not moved and stays armed:
    // each box waits only after it appears or moves itself.
    const now = await widgetButtonNow(page, { action: 'approve-driver', requestId: first });
    expect(now?.armed).toBe(true);
    expect([Math.round(now?.x ?? 0), Math.round(now?.y ?? 0)]).toEqual([
      Math.round(aim.x),
      Math.round(aim.y),
    ]);
    await page.mouse.click(aim.x, aim.y);

    // The click lands where it was aimed: Alice is approved, and Bob is not.
    const alice = await aliceAsks;
    expect(alice.structured).toMatchObject({ role: 'driver' });
    expect((await dockState(page))?.pendingRequests.map((r) => r.requestId)).toEqual([second]);
    await clickInWidget(page, { action: 'deny', requestId: second });
    expect(errorCode(await bobAsks)).toBe('denied_by_operator');
    await expect
      .poll(async () => (await dockState(page))?.roster.map((a) => [a.userId, a.role]))
      .toEqual([['alice', 'driver']]);
  } finally {
    await bob.close();
  }
});

test('clear_board shows a confirm prompt on the page, and Deny returns denied_by_operator', async ({
  page,
}) => {
  await openDemo(page);
  const pageId = await pairByClick(page);
  await waitForToolCount(pageId, 6);

  const pending = callTool(client, 'call_page_tool', { page: pageId, tool: 'clear_board' });
  const confirm = await waitForDock(page, (s) => s.pendingConfirms[0]);
  expect(confirm.tool).toBe('clear_board');
  expect(confirm.caller).toMatchObject({ userId: 'alice', role: 'driver' });
  await clickInWidget(page, { action: 'confirm-deny', callId: confirm.callId });

  const denied = await pending;
  expect(errorCode(denied), denied.text).toBe('denied_by_operator');
  await expect(page.locator('[data-role="view"]')).toHaveText(/3 items/);
  expect((await dockState(page))?.pendingConfirms).toEqual([]);
});

test('a page reload keeps the attachment, and calls work afterwards (A1.3)', async ({ page }) => {
  await openDemo(page);
  const pageId = await pairByClick(page);
  await waitForToolCount(pageId, 6);

  await page.reload();
  await page.waitForSelector('html[data-tools="ready"]');
  const after = await waitForLink(page);
  expect(after.pageId).toBe(pageId);
  expect((await dockState(page))?.roster.map((a) => a.userId)).toEqual(['alice']);

  await waitForToolCount(pageId, 6);
  const pages = await callTool(client, 'list_pages');
  expect((pages.structured as { pages: unknown[] }).pages).toMatchObject([
    { page: pageId, state: 'awake', role: 'driver' },
  ]);
  const added = await callTool(client, 'call_page_tool', {
    page: pageId,
    tool: 'add_item',
    arguments: { label: 'After reload', x: -100, y: 60 },
  });
  expect(added.isError, added.text).toBe(false);
  expect((await activityStrip(page))[0]).toMatch(/add_item: added item-4/);
});

// M2 in a real browser: two people and three MCP clients share the demo page
// through the real relay, and the operator steers them with real clicks on the
// widget's roster rows, Revoke all, and the pause switch. Ordering claims rest
// on what was recorded (the relay's queue log, the frames on the page's link),
// never on how long something took.

test.describe('M2: many clients, many users', () => {
  // Tall enough that the panel never scrolls, which would move the boxes and disarm them.
  test.use({ viewport: { width: 1280, height: 1200 } });

  async function extraClient(user: DevTokenUser, name: string, modern = false): Promise<Client> {
    const opened = await connectMcp(tabdock.relay, user, name, { modern });
    extraClients.push(opened);
    return opened;
  }

  /** pair_page with the code the page shows now, then a click on the widget's Allow as `role`. */
  async function pairAs(page: Page, mcp: Client, userId: string, role: Role): Promise<string> {
    const code = await waitForDock(page, (s) =>
      s.link === 'linked' && s.pairing !== null && !codesUsed.has(s.pairing.code)
        ? s.pairing.code
        : null,
    );
    codesUsed.add(code);
    codesSeen.add(code);
    const pending = callTool(mcp, 'pair_page', { code });
    const requestId = await waitForDock(
      page,
      (s) => s.pendingRequests.find((r) => r.user.userId === userId)?.requestId,
    );
    await clickInWidget(page, { action: `approve-${role}`, requestId });
    const paired = await pending;
    expect(paired.isError, paired.text).toBe(false);
    expect(paired.structured).toMatchObject({ role });
    return (paired.structured as { page: string }).page;
  }

  interface TwoUsers {
    pageId: string;
    /** Alice's second client, on revision 2026-07-28; `client` is her first. */
    aliceModern: Client;
    bob: Client;
  }

  /**
   * Alice attaches as driver and Bob as observer, each approved by a click,
   * and Alice's second client makes one read, which names it to the page.
   */
  async function attachTwoUsers(page: Page): Promise<TwoUsers> {
    const { pageId } = await openDemo(page);
    expect(await pairAs(page, client, 'alice', 'driver')).toBe(pageId);
    await waitForToolCount(pageId, 6);
    const bob = await extraClient(tabdock.users.bob, BOB_CLIENT);
    expect(await pairAs(page, bob, 'bob', 'observer')).toBe(pageId);
    // Her attachment covers every client she uses, so this one needs no pairing of its own.
    const aliceModern = await extraClient(tabdock.users.alice, ALICE_MODERN_CLIENT, true);
    const view = await getView(aliceModern, pageId);
    expect(view.isError, view.text).toBe(false);
    await waitForDock(
      page,
      (s) => s.roster.find((a) => a.userId === 'alice')?.clients.length === 2,
    );
    return { pageId, aliceModern, bob };
  }

  function getView(mcp: Client, pageId: string) {
    return callTool(mcp, 'call_page_tool', { page: pageId, tool: 'get_view' });
  }

  function addItem(mcp: Client, pageId: string, label: string) {
    return callTool(mcp, 'call_page_tool', {
      page: pageId,
      tool: 'add_item',
      arguments: { label, x: 40, y: 40 },
    });
  }

  /** The roster as the page holds it: each user's id, role and client names, newest client first. */
  async function rosterOf(page: Page): Promise<[string, Role, string[]][]> {
    return ((await dockState(page))?.roster ?? []).map((a) => [
      a.userId,
      a.role,
      a.clients.map((c) => c.name),
    ]);
  }

  async function rolesOf(page: Page): Promise<[string, Role][]> {
    return (await rosterOf(page)).map(([userId, role]) => [userId, role]);
  }

  async function rowUsers(page: Page): Promise<(string | undefined)[]> {
    return (await widgetItems(page, 'roster')).map((row) => row.data.userId);
  }

  /** The relay's log entries with this message, oldest first. */
  function relayLogEntries(message: string): Record<string, unknown>[] {
    return relayLogs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.msg === message);
  }

  /** Frames of one type the relay sent the page. Only that type is kept, so a failed check prints no code or token. */
  function framesToPage<T extends RelayFrame['t']>(type: T): Extract<RelayFrame, { t: T }>[] {
    return linkFrames.flatMap(({ from, text }) => {
      if (from !== 'relay') return [];
      const parsed = parseRelayFrame(text);
      return parsed.kind === 'ok' && parsed.frame.t === type
        ? [parsed.frame as Extract<RelayFrame, { t: T }>]
        : [];
    });
  }

  /** Frames of these types the page sent the relay, in the order it sent them. */
  function framesFromPage(...types: PageFrame['t'][]): PageFrame[] {
    return linkFrames.flatMap(({ from, text }) => {
      if (from !== 'page') return [];
      const parsed = parsePageFrame(text);
      return parsed.kind === 'ok' && types.includes(parsed.frame.t) ? [parsed.frame] : [];
    });
  }

  /**
   * Registers slow_write on the page the way page code would: a write whose
   * handler holds until the test calls finish, so a call can be caught while
   * it runs on the page. The MCP-B polyfill hands handlers no AbortSignal and
   * native WebMCP does (docs/notes/baseline.md), so the tool records which.
   */
  async function registerSlowWrite(page: Page): Promise<void> {
    await page.evaluate(async () => {
      const context = (
        document as unknown as { modelContext: { registerTool(tool: object): Promise<void> } }
      ).modelContext;
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const control: SlowWrite = {
        started: 0,
        signal: 'none',
        finish: () => {
          release();
        },
      };
      window.__slowWrite = control;
      await context.registerTool({
        name: 'slow_write',
        title: 'Slow write',
        description: 'A write that holds until the test lets it finish.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: false },
        execute: async (_input: unknown, options?: { signal?: AbortSignal }) => {
          control.started += 1;
          const signal = options?.signal;
          if (signal) {
            control.signal = signal.aborted ? 'aborted' : 'live';
            signal.addEventListener('abort', () => {
              control.signal = 'aborted';
            });
          }
          await gate;
          return { finished: true };
        },
      });
    });
  }

  test('two users and three clients attach, and the roster shows each client under its user (A2.1)', async ({
    page,
  }) => {
    const { pageId, aliceModern, bob } = await attachTwoUsers(page);
    // Read before any other call: a call from a client already listed moves it
    // to the front at the relay without a new roster frame, so the order shown
    // here is the one of the last frame, sent when her second client was new.
    expect(await rosterOf(page)).toEqual([
      ['alice', 'driver', [ALICE_MODERN_CLIENT, ALICE_CLIENT]],
      ['bob', 'observer', [BOB_CLIENT]],
    ]);
    // What the operator reads, row by row.
    const rows = await widgetItems(page, 'roster');
    expect(rows.map((row) => row.data.userId)).toEqual(['alice', 'bob']);
    expect(rows[0]?.text).toContain('Alice (driver)');
    expect(rows[0]?.text).toContain(`Clients: ${ALICE_MODERN_CLIENT} 0.0.0, ${ALICE_CLIENT} 0.0.0`);
    expect(rows[0]?.text).toMatch(/Expires in 7 h 59 min|Expires in 8 h 0 min/);
    expect(rows[1]?.text).toContain('Bob (observer)');
    expect(rows[1]?.text).toContain(`Clients: ${BOB_CLIENT} 0.0.0`);
    // Both eras are in play: the two 2025-era clients each opened a session on
    // the relay's sessionful leg, and the 2026-07-28 one opened none (ADR 0009).
    expect(relayLogEntries('MCP session opened').map((entry) => entry.userId)).toEqual([
      'alice',
      'bob',
    ]);

    for (const reader of [client, bob]) {
      const read = await callTool(reader, 'call_page_tool', { page: pageId, tool: 'list_items' });
      expect(read.isError, read.text).toBe(false);
    }
    // Each client sees the page under its user's role.
    for (const [mcp, role] of [
      [client, 'driver'],
      [aliceModern, 'driver'],
      [bob, 'observer'],
    ] as const) {
      const pages = await callTool(mcp, 'list_pages');
      expect((pages.structured as { pages: unknown[] }).pages).toMatchObject([
        { page: pageId, role, state: 'awake' },
      ]);
    }
    // The relay's audit names the client of every call, on either protocol revision (S7).
    expect(
      tabdock.relay.audit
        .records()
        .map((record) => [record.userId, record.client?.name, record.tool, record.outcome]),
    ).toEqual([
      ['alice', ALICE_MODERN_CLIENT, 'get_view', 'ok'],
      ['alice', ALICE_CLIENT, 'list_items', 'ok'],
      ['bob', BOB_CLIENT, 'list_items', 'ok'],
    ]);
  });

  test('Revoke on a row ends the running and queued writes of that user with not_attached, and the next call (A2.4)', async ({
    page,
  }) => {
    const { pageId, aliceModern, bob } = await attachTwoUsers(page);
    await registerSlowWrite(page);
    await waitForToolCount(pageId, 7);

    let runningSettled = false;
    const running = callTool(client, 'call_page_tool', { page: pageId, tool: 'slow_write' });
    const markSettled = (): void => {
      runningSettled = true;
    };
    void running.then(markSettled, markSettled);
    await page.waitForFunction(() => window.__slowWrite?.started === 1);
    const slowCallId = await waitForDock(
      page,
      (s) => s.activity.find((e) => e.tool === 'slow_write' && e.outcome === 'running')?.callId,
    );
    // Her other client's write waits at the relay behind the running one: the queue says so.
    const queued = addItem(aliceModern, pageId, 'Never added');
    await expect
      .poll(() =>
        relayLogEntries('call queued')
          .filter((entry) => entry.pageId === pageId && entry.userId === 'alice')
          .map((entry) => [entry.callId === slowCallId, entry.ahead]),
      )
      .toEqual([
        [true, 0],
        [false, 1],
      ]);
    // Reads never wait for writes: Bob's runs beside the slow one while it still holds.
    const read = await callTool(bob, 'call_page_tool', { page: pageId, tool: 'list_items' });
    expect(read.isError, read.text).toBe(false);
    expect(runningSettled).toBe(false);

    await clickInWidget(page, { action: 'revoke', userId: 'alice' });
    const [ran, waited] = await Promise.all([running, queued]);
    expect(errorCode(ran), ran.text).toBe('not_attached');
    expect(errorCode(waited), waited.text).toBe('not_attached');
    // The next call from either of her clients is refused too (S8).
    for (const mcp of [client, aliceModern]) {
      const next = await getView(mcp, pageId);
      expect(errorCode(next), next.text).toBe('not_attached');
    }

    // Her row is gone from the widget; Bob's stays.
    await expect.poll(() => rowUsers(page)).toEqual(['bob']);
    expect(await rosterOf(page)).toEqual([['bob', 'observer', [BOB_CLIENT]]]);

    // On the link: the page's revoke went out before its own answer for the
    // running call, and the relay cancelled that call on the page.
    await expect
      .poll(() => framesToPage('cancel'))
      .toEqual([{ t: 'cancel', callId: slowCallId, reason: 'revoked' }]);
    const sent = framesFromPage('revoke', 'result').map((frame) =>
      frame.t === 'revoke'
        ? `revoke ${frame.userId}`
        : frame.t === 'result' && frame.callId === slowCallId
          ? `result ${frame.error?.code ?? 'ok'}`
          : 'other result',
    );
    expect(sent.filter((line) => line !== 'other result')).toEqual([
      'revoke alice',
      'result cancelled',
    ]);

    // On the page: the running write ended cancelled, and the queued one never arrived.
    const activity = (await dockState(page))?.activity ?? [];
    expect(activity.find((e) => e.callId === slowCallId)?.outcome).toBe('cancelled');
    expect(activity.some((e) => e.tool === 'add_item')).toBe(false);
    await expect(page.locator('[data-role="view"]')).toHaveText(/3 items/);
    // Where the runtime handed the handler a signal (native WebMCP), the cancel fired it.
    await expect.poll(() => page.evaluate(() => window.__slowWrite?.signal)).not.toBe('live');

    // The handler finishing late changes nothing, and Bob carries on.
    await page.evaluate(() => {
      window.__slowWrite?.finish();
    });
    const after = await getView(bob, pageId);
    expect(after.isError, after.text).toBe(false);
    // The audit gains a record as each call ends, and the queued write ends first, so order is not compared.
    const ended = tabdock.relay.audit
      .records()
      .filter((record) => record.userId === 'alice' && record.tool !== 'get_view')
      .map((record) => [record.client?.name, record.tool, record.outcome]);
    expect(ended).toHaveLength(2);
    expect(ended).toEqual(
      expect.arrayContaining([
        [ALICE_CLIENT, 'slow_write', 'not_attached'],
        [ALICE_MODERN_CLIENT, 'add_item', 'not_attached'],
      ]),
    );
  });

  test('Make observer stops the writes of a driver but not the reads, and Make driver restores them within maxDrivers', async ({
    page,
  }) => {
    const { pageId, bob } = await attachTwoUsers(page);

    await clickInWidget(page, { action: 'make-observer', userId: 'alice' });
    await expect
      .poll(() => rolesOf(page))
      .toEqual([
        ['alice', 'observer'],
        ['bob', 'observer'],
      ]);
    expect((await widgetItems(page, 'roster'))[0]?.text).toContain('Alice (observer)');
    const refused = await addItem(client, pageId, 'Refused');
    expect(errorCode(refused), refused.text).toBe('role_denied');
    const read = await getView(client, pageId);
    expect(read.isError, read.text).toBe(false);

    // Nobody drives now, so Bob can.
    await clickInWidget(page, { action: 'make-driver', userId: 'bob' });
    await expect
      .poll(() => rolesOf(page))
      .toEqual([
        ['alice', 'observer'],
        ['bob', 'driver'],
      ]);
    const fromBob = await addItem(bob, pageId, 'From Bob');
    expect(fromBob.isError, fromBob.text).toBe(false);

    // maxDrivers is 1, so while Bob drives the relay keeps Alice an observer.
    await clickInWidget(page, { action: 'make-driver', userId: 'alice' });
    await expect
      .poll(() =>
        relayLogEntries('driver limit reached; granting observer').map((entry) => entry.userId),
      )
      .toEqual(['alice']);
    expect(await rolesOf(page)).toEqual([
      ['alice', 'observer'],
      ['bob', 'driver'],
    ]);
    const stillRefused = await addItem(client, pageId, 'Still refused');
    expect(errorCode(stillRefused), stillRefused.text).toBe('role_denied');

    // Once Bob steps back, Make driver gives Alice her writes again.
    await clickInWidget(page, { action: 'make-observer', userId: 'bob' });
    await expect
      .poll(() => rolesOf(page))
      .toEqual([
        ['alice', 'observer'],
        ['bob', 'observer'],
      ]);
    await clickInWidget(page, { action: 'make-driver', userId: 'alice' });
    await expect
      .poll(() => rolesOf(page))
      .toEqual([
        ['alice', 'driver'],
        ['bob', 'observer'],
      ]);
    const restored = await addItem(client, pageId, 'Restored');
    expect(restored.isError, restored.text).toBe(false);
    await expect(page.locator('[data-role="view"]')).toHaveText(/5 items/);
  });

  test('the activity list shows each call with its user, client, tool and outcome', async ({
    page,
  }) => {
    const { pageId, bob } = await attachTwoUsers(page);
    expect(
      (await callTool(bob, 'call_page_tool', { page: pageId, tool: 'list_items' })).isError,
    ).toBe(false);
    expect((await addItem(client, pageId, 'Logged')).isError).toBe(false);
    const clearing = callTool(client, 'call_page_tool', { page: pageId, tool: 'clear_board' });
    const confirm = await waitForDock(page, (s) => s.pendingConfirms[0]);
    await clickInWidget(page, { action: 'confirm-deny', callId: confirm.callId });
    expect(errorCode(await clearing)).toBe('denied_by_operator');
    allowHandlerError('No item with id item-999');
    const missing = await callTool(client, 'call_page_tool', {
      page: pageId,
      tool: 'highlight_item',
      arguments: { id: 'item-999' },
    });
    expect(missing.isError).toBe(true);
    // Refused by the relay itself, so it never reaches the page's log; the relay's audit has it.
    expect(errorCode(await addItem(bob, pageId, 'Observer write'))).toBe('role_denied');

    const expected = [
      ['Alice', ALICE_CLIENT, 'highlight_item', 'tool_error'],
      ['Alice', ALICE_CLIENT, 'clear_board', 'denied_by_operator'],
      ['Alice', ALICE_CLIENT, 'add_item', 'ok'],
      ['Bob', BOB_CLIENT, 'list_items', 'ok'],
      ['Alice', ALICE_MODERN_CLIENT, 'get_view', 'ok'],
    ];
    const activity = (await dockState(page))?.activity ?? [];
    expect(activity.map((e) => [e.user.displayName, e.client?.name, e.tool, e.outcome])).toEqual(
      expected,
    );
    // The widget's lines say the same, newest first, each with how long it took.
    const lines = await widgetItems(page, 'activity');
    expect(lines.map((line) => line.data.activityId)).toEqual(activity.map((e) => e.callId));
    expect(lines.map((line) => line.data.outcome)).toEqual(expected.map((entry) => entry[3]));
    lines.forEach((line, index) => {
      const [name, clientName, tool, outcome] = expected[index] ?? [];
      expect(line.text).toMatch(
        new RegExp(
          `^\\S+ ${String(name)} via ${String(clientName)} 0\\.0\\.0: ${String(tool)}, ${String(outcome)} in \\d+ ms$`,
        ),
      );
    });

    // The relay's audit records the same calls, oldest first, with the refused write too (S7).
    expect(
      tabdock.relay.audit
        .records()
        .map((record) => [record.userId, record.client?.name, record.tool, record.outcome]),
    ).toEqual([
      ['alice', ALICE_MODERN_CLIENT, 'get_view', 'ok'],
      ['bob', BOB_CLIENT, 'list_items', 'ok'],
      ['alice', ALICE_CLIENT, 'add_item', 'ok'],
      ['alice', ALICE_CLIENT, 'clear_board', 'denied_by_operator'],
      ['alice', ALICE_CLIENT, 'highlight_item', 'tool_error'],
      ['bob', BOB_CLIENT, 'add_item', 'role_denied'],
    ]);
  });

  test('Pause answers every call with page_busy, and Resume lets calls run again', async ({
    page,
  }) => {
    const { pageId } = await openDemo(page);
    expect(await pairAs(page, client, 'alice', 'driver')).toBe(pageId);
    await waitForToolCount(pageId, 6);

    await clickInWidget(page, { action: 'pause' });
    await waitForDock(page, (s) => s.paused);
    expect(await widgetVisible(page, 'badge-paused')).toBe(true);
    expect(await widgetText(page, 'pause-box')).toContain('Paused');
    const paused = [await addItem(client, pageId, 'While paused'), await getView(client, pageId)];
    expect(paused.map((outcome) => errorCode(outcome))).toEqual(['page_busy', 'page_busy']);
    await expect(page.locator('[data-role="view"]')).toHaveText(/3 items/);

    await clickInWidget(page, { action: 'resume' });
    await waitForDock(page, (s) => !s.paused);
    expect(await widgetVisible(page, 'badge-paused')).toBe(false);
    const added = await addItem(client, pageId, 'After resume');
    expect(added.isError, added.text).toBe(false);
    await expect(page.locator('[data-role="view"]')).toHaveText(/4 items/);
    expect(
      ((await dockState(page))?.activity ?? []).map((entry) => [entry.tool, entry.outcome]),
    ).toEqual([
      ['add_item', 'ok'],
      ['get_view', 'page_busy'],
      ['add_item', 'page_busy'],
    ]);
  });

  test('Revoke all ends every attachment, and coming back takes a new approval', async ({
    page,
  }) => {
    const { pageId, aliceModern, bob } = await attachTwoUsers(page);

    await clickInWidget(page, { action: 'revoke-all' });
    await expect.poll(() => rosterOf(page)).toEqual([]);
    expect(await rowUsers(page)).toEqual([]);
    expect(await widgetButtonNow(page, { action: 'revoke-all' })).toBeNull();
    for (const mcp of [client, aliceModern, bob]) {
      const call = await getView(mcp, pageId);
      expect(errorCode(call), call.text).toBe('not_attached');
      const pages = await callTool(mcp, 'list_pages');
      expect(pages.text).toMatch(/not attached to any page/);
    }

    // Nobody slips back in: Bob's next pair_page asks the operator again.
    expect(await pairAs(page, bob, 'bob', 'observer')).toBe(pageId);
    await expect.poll(() => rosterOf(page)).toEqual([['bob', 'observer', [BOB_CLIENT]]]);
    expect(await rowUsers(page)).toEqual(['bob']);
  });
});

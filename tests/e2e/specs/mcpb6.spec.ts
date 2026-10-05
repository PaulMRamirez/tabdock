import type { Client } from '@modelcontextprotocol/client';
import { expect, test, type Page } from '@playwright/test';
import { startDemoServer, type DemoServer } from '@tabdock/demo/server';
import {
  type PageFrame,
  parsePageFrame,
  parseRelayFrame,
  type RelayFrame,
  untrustedHeader,
} from '@tabdock/protocol';
import { mcpb6Runtime, useMcpb6 } from '../src/mcpb6-page.ts';
import {
  callTool,
  clickInWidget,
  connectMcp,
  dockState,
  errorCode,
  startTabdock,
  waitForDock,
  waitForLink,
  type Tabdock,
} from '../src/tabdock-harness.ts';

// A5.4: the adapter's call, cancel and consequential specs on MCP-B's 6.0
// beta polyfill (M5 decision D4, ADR 0031). The demo page and the adapter it
// bundles run unchanged; src/mcpb6-page.ts installs the beta before the page's
// own scripts, so its 5.1.0 initializeWebMCPPolyfill() finds a context and
// steps aside. The playwright.config.ts project "mcpb6" runs this file
// without the flag that turns native WebMCP on, and every test first proves
// the context is 6's, so a pass can never be 5.1.0's or Chrome's. On 6 the adapter takes the
// path it takes on native Chrome (ADR 0001's notes): no __isWebMCPPolyfill
// marker, an object input taken the first time, consequentialHint reported,
// and the caller's signal handed to the handler, so a revoke or a client's
// cancel aborts it. Results arrive as 6 gives them, a plain string quoted and
// a handler's error as a fixed text, which the adapter and relay forward as is.

declare global {
  interface Window {
    /** slow_write's controls, as in tabdock-relay.spec.ts. */
    __slowWrite?: SlowWrite;
  }
}

interface SlowWrite {
  started: number;
  signal: 'none' | 'live' | 'aborted';
  finish: () => void;
}

let demo: DemoServer;
let tabdock: Tabdock;
/** Alice's first client, on a 2025 MCP revision. */
let client: Client;
let extraClients: Client[];
let consoleLines: string[];
let relayLogs: string[];
let linkFrames: { from: 'page' | 'relay'; text: string }[];

const ALICE_CLIENT = 'tabdock-playwright-mcpb6';
const ALICE_MODERN_CLIENT = 'tabdock-playwright-mcpb6-modern';

test.beforeAll(async () => {
  demo = await startDemoServer({ e2eHook: true });
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
  linkFrames = [];
  await useMcpb6(page, { recordCalls: true });
  page.on('console', (message) => {
    consoleLines.push(`${message.type()}: ${message.text()}`);
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
  // 6 logs nothing for a handler's error, so no error line is allowed at all.
  expect(consoleLines.filter((line) => /^(error|pageerror):/.test(line))).toEqual([]);
  // The adapter tried an object first and kept it: it never had to say it switched (ADR 0001).
  expect(consoleLines.filter((line) => line.includes('takes executeTool input as'))).toEqual([]);
  // No token, code or resume token in the console or the relay's log (S11); counts only, so a failure prints none.
  const secrets = [tabdock.users.alice.token, tabdock.users.bob.token, ...secretsOnLink()];
  for (const secret of secrets) {
    expect(consoleLines.filter((line) => line.includes(secret)).length).toBe(0);
    expect(relayLogs.filter((line) => line.includes(secret)).length).toBe(0);
  }
});

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

/** Frames of one type the relay sent the page, that type alone, so a failed check prints no secret. */
function framesToPage<T extends RelayFrame['t']>(type: T): Extract<RelayFrame, { t: T }>[] {
  return linkFrames.flatMap(({ from, text }) => {
    if (from !== 'relay') return [];
    const parsed = parseRelayFrame(text);
    return parsed.kind === 'ok' && parsed.frame.t === type
      ? [parsed.frame as Extract<RelayFrame, { t: T }>]
      : [];
  });
}

/** The tools frames the page sent, as the relay received them. */
function toolsFramesFromPage(): Extract<PageFrame, { t: 'tools' }>[] {
  return linkFrames.flatMap(({ from, text }) => {
    if (from !== 'page') return [];
    const parsed = parsePageFrame(text);
    return parsed.kind === 'ok' && parsed.frame.t === 'tools' ? [parsed.frame] : [];
  });
}

/** The page's answers for one call, as error codes ('ok' for a result without one). */
function resultsFromPage(callId: string): string[] {
  return linkFrames.flatMap(({ from, text }) => {
    if (from !== 'page') return [];
    const parsed = parsePageFrame(text);
    return parsed.kind === 'ok' && parsed.frame.t === 'result' && parsed.frame.callId === callId
      ? [parsed.frame.error?.code ?? 'ok']
      : [];
  });
}

/**
 * Opens the demo on the beta and proves that is what runs: the polyfill
 * installed over nothing, no 5.1.0 marker or navigator alias, and 6's own
 * refusal of a JSON string.
 */
async function openOnMcpb6(page: Page): Promise<string> {
  await page.goto(tabdock.pageUrl);
  await page.waitForSelector('html[data-tools="ready"]');
  expect(await mcpb6Runtime(page)).toEqual({
    hadContextBefore: false,
    installed: true,
    marker: undefined,
    navigatorAlias: false,
    stringInput: 'TypeError: inputObject must be an object',
  });
  const { pageId } = await waitForLink(page);
  return pageId;
}

/** pair_page with the code the page shows, then a click on Allow as driver. */
async function pairByClick(page: Page, mcp: Client = client): Promise<string> {
  const { code } = await waitForLink(page);
  const pending = callTool(mcp, 'pair_page', { code });
  const requestId = await waitForDock(page, (s) => s.pendingRequests[0]?.requestId);
  await clickInWidget(page, { action: 'approve-driver', requestId });
  const paired = await pending;
  expect(paired.isError, paired.text).toBe(false);
  expect(paired.structured).toMatchObject({ role: 'driver' });
  return (paired.structured as { page: string }).page;
}

async function waitForToolCount(pageId: string, count: number): Promise<string[]> {
  let names: string[] = [];
  await expect
    .poll(async () => {
      const listed = await callTool(client, 'list_page_tools', { page: pageId });
      const tools = (listed.structured as { tools?: { name: string }[] } | undefined)?.tools ?? [];
      names = tools.map((tool) => tool.name);
      return names.length;
    })
    .toBe(count);
  return names;
}

/** Every executeTool call the page made, as input type and settlement, from the init script's record. */
async function executeCalls(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window.__mcpb6?.calls ?? []).map((call) => `${call.input} ${call.outcome}`),
  );
}

/** Registers a tool the way page code would, on the page's own context. */
async function registerTool(
  page: Page,
  tool: { name: string; annotations: Record<string, boolean>; returns: string },
): Promise<void> {
  await page.evaluate(async ({ name, annotations, returns }) => {
    const context = (
      document as unknown as { modelContext: { registerTool(tool: object): Promise<void> } }
    ).modelContext;
    await context.registerTool({
      name,
      title: name,
      description: `A tool the 6.0 leg registers: ${name}.`,
      inputSchema: { type: 'object', properties: {} },
      annotations,
      execute: () => returns,
    });
  }, tool);
}

/**
 * A write that holds until the test lets it go, recording whether the runtime
 * handed it a signal and whether that signal fired; 5.1.0 hands none.
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

test('call: on the 6.0 beta a driver lists and calls tools, the object input is taken the first time, and results arrive as 6 gives them', async ({
  page,
}) => {
  const pageId = await openOnMcpb6(page);
  expect(await pairByClick(page)).toBe(pageId);
  expect((await waitForToolCount(pageId, 6)).sort()).toEqual([
    'add_item',
    'clear_board',
    'get_view',
    'highlight_item',
    'list_items',
    'move_view',
  ]);
  const origin = new URL(demo.url).origin;

  const view = await callTool(client, 'call_page_tool', { page: pageId, tool: 'get_view' });
  expect(view.isError, view.text).toBe(false);
  expect(view.text.split('\n', 1)[0]).toBe(untrustedHeader(origin, 'get_view'));
  expect(view.structured).toMatchObject({ zoom: 1 });
  // The adapter's first call passed an object and 6 took it; nothing was retried as a string.
  expect(await executeCalls(page)).toEqual(['object resolved']);

  const added = await callTool(client, 'call_page_tool', {
    page: pageId,
    tool: 'add_item',
    arguments: { label: 'From the 6.0 leg', x: 120, y: 80, color: 'purple' },
  });
  expect(added.isError, added.text).toBe(false);
  expect(added.structured).toMatchObject({ item: { id: 'item-4', label: 'From the 6.0 leg' } });
  await expect(page.locator('[data-role="view"]')).toHaveText(/4 items/);

  // 6 serializes every result as JSON, so a handler's plain text arrives quoted,
  // and the adapter and relay forward it as the runtime gave it (ADRs 0001 and 0031).
  await registerTool(page, {
    name: 'say_plain',
    annotations: { readOnlyHint: true },
    returns: 'plain text',
  });
  await waitForToolCount(pageId, 7);
  const plain = await callTool(client, 'call_page_tool', { page: pageId, tool: 'say_plain' });
  expect(plain.isError, plain.text).toBe(false);
  expect(plain.text).toBe(`${untrustedHeader(origin, 'say_plain')}\n"plain text"`);
  expect(plain.structured).toBeUndefined();

  // A handler's error is 6's fixed UnknownError text, its own message hidden;
  // the adapter forwards the message, labelled as page content.
  const missing = await callTool(client, 'call_page_tool', {
    page: pageId,
    tool: 'highlight_item',
    arguments: { id: 'item-999' },
  });
  expect(missing.isError).toBe(true);
  expect(missing.text).toBe(`${untrustedHeader(origin, 'highlight_item')}\nTool execution failed`);

  expect(await executeCalls(page)).toEqual([
    'object resolved',
    'object resolved',
    'object resolved',
    'object rejected',
  ]);
  expect(tabdock.relay.audit.records().map((record) => [record.tool, record.outcome])).toEqual([
    ['get_view', 'ok'],
    ['add_item', 'ok'],
    ['say_plain', 'ok'],
    ['highlight_item', 'tool_error'],
  ]);
});

test("cancel: Revoke ends a running and a queued write with not_attached, and the running handler's signal fires (A2.4)", async ({
  page,
}) => {
  const pageId = await openOnMcpb6(page);
  expect(await pairByClick(page)).toBe(pageId);
  await registerSlowWrite(page);
  await waitForToolCount(pageId, 7);
  // Her attachment covers every client she uses; this one speaks 2026-07-28.
  const aliceModern = await connectMcp(tabdock.relay, tabdock.users.alice, ALICE_MODERN_CLIENT, {
    modern: true,
  });
  extraClients.push(aliceModern);

  const running = callTool(client, 'call_page_tool', { page: pageId, tool: 'slow_write' });
  await page.waitForFunction(() => window.__slowWrite?.started === 1);
  // 6 hands the handler the signal the adapter gave executeTool.
  expect(await page.evaluate(() => window.__slowWrite?.signal)).toBe('live');
  const slowCallId = await waitForDock(
    page,
    (s) => s.activity.find((e) => e.tool === 'slow_write' && e.outcome === 'running')?.callId,
  );
  const queued = callTool(aliceModern, 'call_page_tool', {
    page: pageId,
    tool: 'add_item',
    arguments: { label: 'Never added', x: 40, y: 40 },
  });
  await expect
    .poll(() =>
      relayLogs
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.msg === 'call queued' && entry.pageId === pageId)
        .map((entry) => entry.ahead),
    )
    .toEqual([0, 1]);

  await clickInWidget(page, { action: 'revoke', userId: 'alice' });
  const [ran, waited] = await Promise.all([running, queued]);
  expect(errorCode(ran), ran.text).toBe('not_attached');
  expect(errorCode(waited), waited.text).toBe('not_attached');
  for (const mcp of [client, aliceModern]) {
    const next = await callTool(mcp, 'call_page_tool', { page: pageId, tool: 'get_view' });
    expect(errorCode(next), next.text).toBe('not_attached');
  }

  // The relay cancelled the running call on the page, the page answered it
  // cancelled, and on 6 the abort reached the handler itself.
  await expect
    .poll(() => framesToPage('cancel'))
    .toEqual([{ t: 'cancel', callId: slowCallId, reason: 'revoked' }]);
  await expect.poll(() => resultsFromPage(slowCallId)).toEqual(['cancelled']);
  await expect.poll(() => page.evaluate(() => window.__slowWrite?.signal)).toBe('aborted');
  const activity = (await dockState(page))?.activity ?? [];
  expect(activity.find((e) => e.callId === slowCallId)?.outcome).toBe('cancelled');
  expect(activity.some((e) => e.tool === 'add_item')).toBe(false);

  // The handler ending late changes nothing.
  await page.evaluate(() => {
    window.__slowWrite?.finish();
  });
  await expect(page.locator('[data-role="view"]')).toHaveText(/3 items/);
  expect(await executeCalls(page)).toEqual(['object rejected']);
});

test("cancel: a client's cancellation reaches the page as cancel and aborts the handler's signal", async ({
  page,
}) => {
  const pageId = await openOnMcpb6(page);
  expect(await pairByClick(page)).toBe(pageId);
  await registerSlowWrite(page);
  await waitForToolCount(pageId, 7);

  const abort = new AbortController();
  const pending = client
    .callTool(
      { name: 'call_page_tool', arguments: { page: pageId, tool: 'slow_write' } },
      { signal: abort.signal },
    )
    .then(
      () => 'answered',
      () => 'rejected',
    );
  await page.waitForFunction(() => window.__slowWrite?.started === 1);
  expect(await page.evaluate(() => window.__slowWrite?.signal)).toBe('live');
  const callId = await waitForDock(
    page,
    (s) => s.activity.find((e) => e.tool === 'slow_write' && e.outcome === 'running')?.callId,
  );
  abort.abort();
  expect(await pending).toBe('rejected');

  await expect
    .poll(() => framesToPage('cancel'))
    .toEqual([{ t: 'cancel', callId, reason: 'client' }]);
  await expect.poll(() => page.evaluate(() => window.__slowWrite?.signal)).toBe('aborted');
  await expect.poll(() => resultsFromPage(callId)).toEqual(['cancelled']);

  // The write slot is free once the abort lands, as on native Chrome (ADR 0001's notes), so the next write runs.
  const added = await callTool(client, 'call_page_tool', {
    page: pageId,
    tool: 'add_item',
    arguments: { label: 'After the cancel', x: 10, y: 10 },
  });
  expect(added.isError, added.text).toBe(false);
  await page.evaluate(() => {
    window.__slowWrite?.finish();
  });
  expect(await executeCalls(page)).toEqual(['object rejected', 'object resolved']);
});

test('consequential: clear_board prompts on the page and Deny returns denied_by_operator; 6 reports consequentialHint, so a hinted tool the policy does not list prompts too (A2.5)', async ({
  page,
}) => {
  const pageId = await openOnMcpb6(page);
  expect(await pairByClick(page)).toBe(pageId);
  await waitForToolCount(pageId, 6);
  // 6 keeps the demo's consequentialHint and reports all four hints, where 5.1.0 drops it.
  expect(
    await page.evaluate(async () => {
      const context = (
        document as unknown as {
          modelContext: {
            getTools(): Promise<{ name: string; annotations?: Record<string, boolean> }[]>;
          };
        }
      ).modelContext;
      return (await context.getTools()).find((tool) => tool.name === 'clear_board')?.annotations;
    }),
  ).toEqual({
    consequentialHint: true,
    debugging: false,
    readOnlyHint: false,
    untrustedContentHint: false,
  });

  const clearing = callTool(client, 'call_page_tool', { page: pageId, tool: 'clear_board' });
  const confirm = await waitForDock(page, (s) => s.pendingConfirms[0]);
  expect(confirm.tool).toBe('clear_board');
  expect(confirm.caller).toMatchObject({ userId: 'alice', role: 'driver' });
  await clickInWidget(page, { action: 'confirm-deny', callId: confirm.callId });
  const denied = await clearing;
  expect(errorCode(denied), denied.text).toBe('denied_by_operator');
  await expect(page.locator('[data-role="view"]')).toHaveText(/3 items/);
  expect((await dockState(page))?.pendingConfirms).toEqual([]);

  // The demo's policy lists clear_board alone, so only the hint makes this one consequential.
  await registerTool(page, {
    name: 'stamp_board',
    annotations: { readOnlyHint: false, consequentialHint: true },
    returns: 'stamped',
  });
  await waitForToolCount(pageId, 7);
  const stamping = callTool(client, 'call_page_tool', { page: pageId, tool: 'stamp_board' });
  const hinted = await waitForDock(page, (s) => s.pendingConfirms[0]);
  expect(hinted.tool).toBe('stamp_board');
  await clickInWidget(page, { action: 'confirm-allow', callId: hinted.callId });
  const stamped = await stamping;
  expect(stamped.isError, stamped.text).toBe(false);
  expect(stamped.text.endsWith('\n"stamped"')).toBe(true);

  // A write with no hint and no listing runs without a prompt: hints are reported, so none is guessed.
  const added = await callTool(client, 'call_page_tool', {
    page: pageId,
    tool: 'add_item',
    arguments: { label: 'No prompt', x: 0, y: 40 },
  });
  expect(added.isError, added.text).toBe(false);
  expect((await dockState(page))?.pendingConfirms).toEqual([]);
  expect((await dockState(page))?.notice ?? null).toBeNull();

  // The tools frame marks exactly what the page counts as consequential
  // (ADR 0026): the listed tool and the one 6 reports the hint for.
  const marks = toolsFramesFromPage()
    .at(-1)
    ?.tools.map((tool) => [tool.name, 'consequential' in tool ? tool.consequential : 'unmarked']);
  expect(Object.fromEntries(marks ?? [])).toEqual({
    get_view: 'unmarked',
    list_items: 'unmarked',
    add_item: 'unmarked',
    move_view: 'unmarked',
    highlight_item: 'unmarked',
    clear_board: true,
    stamp_board: true,
  });

  expect(
    ((await dockState(page))?.activity ?? []).map((entry) => [entry.tool, entry.outcome]),
  ).toEqual([
    ['add_item', 'ok'],
    ['stamp_board', 'ok'],
    ['clear_board', 'denied_by_operator'],
  ]);
  // Deny settles before any executeTool, so the page ran only the two writes it allowed.
  expect(await executeCalls(page)).toEqual(['object resolved', 'object resolved']);
});

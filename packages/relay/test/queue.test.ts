// The write queue (SPEC section 5, A2.3): mutating calls run one at a time per
// page in arrival order, read-only calls go straight through, and a queued
// call leaves the queue on cancel, revoke, sleep or timeout, with its role
// checked again when it reaches the front.

import type { Client } from '@modelcontextprotocol/client';
import type { JsonObject, PageTool } from '@tabdock/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArgumentChecker } from '../src/argument-checker.ts';
import {
  connectPage,
  type InvokeFrame,
  type InvokeReply,
  type PageOptions,
  type TestPage,
  TOOLS,
  WRITE_TOOL,
} from './helpers/page-client.ts';
import {
  ALICE,
  BOB,
  CAROL,
  callTool,
  connectClient,
  type ClientOptions,
  delay,
  eventually,
  pairAndApprove,
  startRelay,
  type TestRelay,
  type ToolOutcome,
} from './helpers/relay.ts';

let current: TestRelay | undefined;
const pages: TestPage[] = [];
const clients: Client[] = [];

async function setup(options: Parameters<typeof startRelay>[0] = {}): Promise<TestRelay> {
  current = await startRelay(options);
  return current;
}

async function page(options: PageOptions = {}): Promise<TestPage> {
  if (!current) throw new Error('no relay');
  const opened = await connectPage(current.relay.pageUrl, { tools: TOOLS, ...options });
  pages.push(opened);
  return opened;
}

async function client(user = ALICE, options: ClientOptions = {}): Promise<Client> {
  if (!current) throw new Error('no relay');
  const connected = await connectClient(current.relay, user, options);
  clients.push(connected);
  return connected;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const connected of clients.splice(0)) await connected.close();
  for (const opened of pages.splice(0)) opened.ws.terminate();
  await current?.close();
  current = undefined;
});

/** A page that holds every invoke until the test answers it. */
function holdingPage(): { held: InvokeFrame[]; onInvoke: (frame: InvokeFrame) => undefined } {
  const held: InvokeFrame[] = [];
  return {
    held,
    onInvoke: (frame) => {
      held.push(frame);
      return undefined;
    },
  };
}

function answer(opened: TestPage, frame: InvokeFrame | undefined, content = '{}'): void {
  if (!frame) throw new Error('no invoke to answer');
  opened.send({ t: 'result', callId: frame.callId, ok: true, content });
}

function write(who: Client, pageId: string, label: string): Promise<ToolOutcome> {
  return callTool(who, 'call_page_tool', {
    page: pageId,
    tool: 'add_item',
    arguments: { label },
  });
}

/** Call ids in the order the relay logged them joining the page's queue. */
function queuedOrder(lines: string[]): string[] {
  return lines
    .map((line) => JSON.parse(line) as { msg: string; callId?: string })
    .filter((entry) => entry.msg === 'call queued')
    .map((entry) => entry.callId ?? '');
}

describe('the write queue (A2.3)', () => {
  it('runs twenty concurrent mutating calls from three clients one at a time in arrival order, while reads interleave', async () => {
    const { relay, lines } = await setup({ timings: { callDeadlineMs: 10_000 } });
    let active = 0;
    let mostActive = 0;
    let writesDone = 0;
    const opened = await page({
      policy: { maxDrivers: 2 },
      onInvoke: async (frame): Promise<InvokeReply> => {
        if (frame.tool === 'get_view') return { ok: true, content: '{"view":1}' };
        active += 1;
        mostActive = Math.max(mostActive, active);
        await delay(10);
        active -= 1;
        return { ok: true, content: JSON.stringify(frame.arguments) };
      },
    });
    const laptop = await client(ALICE, { name: 'laptop' });
    const phone = await client(ALICE, { name: 'phone', modern: true });
    const tablet = await client(BOB, { name: 'tablet' });
    await pairAndApprove(laptop, opened, 'driver');
    await pairAndApprove(tablet, opened, 'driver');
    const writers = [laptop, phone, tablet];

    const writes = Array.from({ length: 20 }, (_, i) =>
      write(writers[i % 3] as Client, opened.pageId, `w${String(i)}`).then((outcome) => {
        writesDone += 1;
        return outcome;
      }),
    );
    // Reads sent while the writes are still queued come back before the writes finish.
    await eventually(() => opened.all('invoke').length >= 2);
    const reads = await Promise.all(
      writers.map((reader) =>
        callTool(reader, 'call_page_tool', { page: opened.pageId, tool: 'get_view' }),
      ),
    );
    expect(writesDone).toBeLessThan(20);
    for (const read of reads) expect(read.isError, read.text).toBe(false);

    for (const outcome of await Promise.all(writes))
      expect(outcome.isError, outcome.text).toBe(false);
    expect(mostActive).toBe(1);
    const invoked = opened.all('invoke');
    const writeIds = invoked.filter((frame) => frame.tool === 'add_item').map((f) => f.callId);
    expect(writeIds).toHaveLength(20);
    // Strictly in the order they reached the relay.
    expect(writeIds).toEqual(queuedOrder(lines));
    // The reads went to the page between writes, not after them.
    const readAt = invoked.findIndex((frame) => frame.tool === 'get_view');
    const lastWriteAt = invoked.map((frame) => frame.tool).lastIndexOf('add_item');
    expect(readAt).toBeGreaterThan(0);
    expect(readAt).toBeLessThan(lastWriteAt);

    // A2.1: two users and three client instances, all on the roster.
    const roster = opened.all('roster').at(-1)?.attachments ?? [];
    expect(roster.map((entry) => [entry.userId, entry.clients.map((c) => c.name).sort()])).toEqual([
      ['alice', ['laptop', 'phone']],
      ['bob', ['tablet']],
    ]);
    expect(relay.audit.records().filter((record) => record.tool === 'add_item')).toHaveLength(20);
  });

  it("a queued call's deadline counts from arrival, not from when it reaches the page", async () => {
    await setup({ timings: { callDeadlineMs: 2000 } });
    const { held, onInvoke } = holdingPage();
    const opened = await page({ onInvoke });
    const alice = await client();
    await pairAndApprove(alice, opened);
    const first = write(alice, opened.pageId, 'first');
    const second = write(alice, opened.pageId, 'second');
    await eventually(() => held.length === 1);
    await delay(300);
    answer(opened, held[0]);
    await eventually(() => held.length === 2);
    expect(held[0]?.deadlineMs).toBe(2000);
    expect(held[1]?.deadlineMs).toBeLessThanOrEqual(1700);
    expect(held[1]?.deadlineMs).toBeGreaterThan(1000);
    answer(opened, held[1]);
    expect((await first).isError).toBe(false);
    expect((await second).isError).toBe(false);
  });

  it('a queued call that runs out of time fails with timeout and never reaches the page', async () => {
    const { relay } = await setup({ timings: { callDeadlineMs: 200, callDeadlineGraceMs: 100 } });
    const { held, onInvoke } = holdingPage();
    const opened = await page({ onInvoke });
    const alice = await client();
    await pairAndApprove(alice, opened);
    const first = write(alice, opened.pageId, 'first');
    const second = write(alice, opened.pageId, 'second');
    expect((await second).text).toBe(
      'timeout: the call waited 200 ms behind other calls that change the page and never ran',
    );
    expect((await first).text).toBe('timeout: the page did not answer within 200 ms');
    await opened.sync();
    expect(held).toHaveLength(1);
    expect(opened.all('cancel')).toEqual([
      { t: 'cancel', callId: held[0]?.callId, reason: 'timeout' },
    ]);
    expect(relay.audit.records().map((record) => record.outcome)).toEqual(['timeout', 'timeout']);
  });

  it("a client's cancel takes its call out of the queue, and the page never hears of it", async () => {
    const { relay } = await setup();
    const { held, onInvoke } = holdingPage();
    const opened = await page({ onInvoke });
    const alice = await client();
    await pairAndApprove(alice, opened);
    const first = write(alice, opened.pageId, 'first');
    await eventually(() => held.length === 1);
    const abort = new AbortController();
    const cancelled = alice
      .callTool(
        {
          name: 'call_page_tool',
          arguments: { page: opened.pageId, tool: 'add_item', arguments: { label: 'x' } },
        },
        { signal: abort.signal },
      )
      .then(
        () => 'answered',
        () => 'rejected',
      );
    await eventually(
      () => relay.audit.records().length === 0 && queuedOrder(current?.lines ?? []).length === 2,
    );
    abort.abort();
    expect(await cancelled).toBe('rejected');
    await eventually(() => relay.audit.records().some((record) => record.outcome === 'cancelled'));
    answer(opened, held[0]);
    expect((await first).isError).toBe(false);
    await opened.sync();
    expect(held).toHaveLength(1);
    expect(opened.all('cancel')).toHaveLength(0);
  });

  it("a revoke ends the user's running and queued calls, and the next user's call runs", async () => {
    await setup();
    const { held, onInvoke } = holdingPage();
    const opened = await page({ onInvoke, policy: { maxDrivers: 2 } });
    const alice = await client();
    const bob = await client(BOB);
    await pairAndApprove(alice, opened);
    await pairAndApprove(bob, opened);
    const running = write(alice, opened.pageId, 'a1');
    await eventually(() => held.length === 1);
    const queuedAlice = write(alice, opened.pageId, 'a2');
    const queuedBob = write(bob, opened.pageId, 'b1');
    await eventually(() => queuedOrder(current?.lines ?? []).length === 3);
    opened.send({ t: 'revoke', userId: 'alice' });
    const revoked = 'not_attached: the page operator revoked your attachment';
    expect((await running).text).toBe(revoked);
    expect((await queuedAlice).text).toBe(revoked);
    await eventually(() => held.length === 2);
    expect(held[1]?.caller.userId).toBe('bob');
    expect(opened.all('cancel')).toEqual([
      { t: 'cancel', callId: held[0]?.callId, reason: 'revoked' },
    ]);
    answer(opened, held[1]);
    expect((await queuedBob).isError).toBe(false);
  });

  it('a role taken away while a call waits is caught when it reaches the front', async () => {
    await setup();
    const { held, onInvoke } = holdingPage();
    const opened = await page({ onInvoke, policy: { maxDrivers: 2 } });
    const alice = await client();
    const bob = await client(BOB);
    await pairAndApprove(alice, opened);
    await pairAndApprove(bob, opened);
    const first = write(alice, opened.pageId, 'a1');
    await eventually(() => held.length === 1);
    const waiting = write(bob, opened.pageId, 'b1');
    await eventually(() => queuedOrder(current?.lines ?? []).length === 2);
    opened.send({ t: 'set_role', userId: 'bob', role: 'observer' });
    await opened.sync();
    answer(opened, held[0]);
    expect((await first).isError).toBe(false);
    expect((await waiting).text).toBe(
      'role_denied: you are an observer on this page now, and add_item is not marked read-only',
    );
    await opened.sync();
    expect(held).toHaveLength(1);
  });

  it('a page that drops fails every queued call with page_asleep', async () => {
    await setup();
    const { held, onInvoke } = holdingPage();
    const opened = await page({ onInvoke });
    const alice = await client();
    await pairAndApprove(alice, opened);
    const calls = [
      write(alice, opened.pageId, '1'),
      write(alice, opened.pageId, '2'),
      write(alice, opened.pageId, '3'),
    ];
    // A write is logged as queued when it arrives, before its argument check, so
    // wait for the first to reach the page as well.
    await eventually(() => held.length === 1 && queuedOrder(current?.lines ?? []).length === 3);
    opened.ws.terminate();
    for (const outcome of await Promise.all(calls)) {
      expect(outcome.text).toBe('page_asleep: the page disconnected before it answered');
    }
    expect(held).toHaveLength(1);
  });

  it('refuses a mutating call with page_busy past the queue depth, while reads still go through (S9)', async () => {
    const { relay } = await setup({ limits: { queueDepth: 2 } });
    const { held, onInvoke } = holdingPage();
    const opened = await page({
      onInvoke: (frame) => {
        if (frame.tool === 'get_view') return { ok: true, content: '{}' };
        onInvoke(frame);
        return undefined;
      },
    });
    const alice = await client();
    const carol = await client(CAROL);
    await pairAndApprove(alice, opened);
    await pairAndApprove(carol, opened, 'observer');
    const calls = [
      write(alice, opened.pageId, '1'),
      write(alice, opened.pageId, '2'),
      write(alice, opened.pageId, '3'),
    ];
    await eventually(() => queuedOrder(current?.lines ?? []).length === 3);
    expect(await write(alice, opened.pageId, '4')).toEqual({
      isError: true,
      text: 'page_busy: 2 calls that change the page are already waiting their turn; try again shortly',
      structured: undefined,
    });
    const read = await callTool(carol, 'call_page_tool', { page: opened.pageId, tool: 'get_view' });
    expect(read.isError, read.text).toBe(false);
    for (let i = 0; i < 3; i += 1) {
      await eventually(() => held.length === i + 1);
      answer(opened, held[i]);
    }
    for (const outcome of await Promise.all(calls)) expect(outcome.isError).toBe(false);
    expect(relay.audit.records().map((record) => record.outcome)).toContain('page_busy');
  });
});

/**
 * Each level references the next one twice, so checking any instance costs
 * 2^levels steps: at 24 levels the check always runs out of its budget.
 */
function fanOut(levels: number): JsonObject {
  const $defs: Record<string, unknown> = {};
  for (let level = 0; level < levels; level += 1) {
    const next = { $ref: `#/$defs/d${String(level + 1)}` };
    $defs[`d${String(level)}`] = { anyOf: [next, next] };
  }
  $defs[`d${String(levels)}`] = { type: 'object' };
  return { type: 'object', $defs, $ref: '#/$defs/d0' };
}

/** Nested past what the relay prepares for a check, so calls to its tool skip the check at once. */
function tooDeep(levels: number): JsonObject {
  let schema: JsonObject = { type: 'string' };
  for (let level = 0; level < levels; level += 1) {
    schema = { type: 'object', properties: { a: schema } };
  }
  return schema;
}

describe('the write queue while argument checks run (ADR 0010)', () => {
  /** How long the fan-out check takes before it gives up: far longer than the gaps below. */
  const CHECK_MS = 600;
  const SLOW_WRITE: PageTool = {
    name: 'slow_write',
    description: 'A write whose argument check takes its whole budget.',
    inputSchema: fanOut(24),
    annotations: { readOnlyHint: false },
  };
  const DEEP_WRITE: PageTool = {
    name: 'deep_write',
    description: 'A write whose schema is too deep to check.',
    inputSchema: tooDeep(40),
    annotations: { readOnlyHint: false },
  };
  const SLOW_READ: PageTool = {
    name: 'slow_read',
    description: 'A read whose argument check takes its whole budget.',
    inputSchema: fanOut(24),
    annotations: { readOnlyHint: true },
  };

  it('keeps arrival order when a later write skips the check an earlier one still waits on', async () => {
    await setup({ timings: { argumentCheckMs: CHECK_MS, callDeadlineMs: 5000 } });
    const { held, onInvoke } = holdingPage();
    const opened = await page({ tools: [SLOW_WRITE, DEEP_WRITE], onInvoke });
    const alice = await client();
    await pairAndApprove(alice, opened);
    const call = (tool: string) =>
      callTool(alice, 'call_page_tool', { page: opened.pageId, tool, arguments: {} });

    const first = call('slow_write');
    // Long enough for the first call to reach the relay, far shorter than its check.
    await delay(100);
    const second = call('deep_write');
    await eventually(() => held.length === 1, 3000);
    expect(held[0]?.tool).toBe('slow_write');
    await delay(50);
    expect(held).toHaveLength(1);
    answer(opened, held[0]);
    await eventually(() => held.length === 2);
    expect(held[1]?.tool).toBe('deep_write');
    answer(opened, held[1]);
    expect((await first).isError).toBe(false);
    expect((await second).isError).toBe(false);
  });

  it('queues a read behind the running write when the page re-lists its tool as mutating during the check', async () => {
    const { lines } = await setup({ timings: { argumentCheckMs: CHECK_MS, callDeadlineMs: 5000 } });
    const { held, onInvoke } = holdingPage();
    const opened = await page({ tools: [WRITE_TOOL, SLOW_READ], onInvoke });
    const alice = await client();
    await pairAndApprove(alice, opened);
    const running = write(alice, opened.pageId, 'first');
    await eventually(() => held.length === 1);
    const reading = callTool(alice, 'call_page_tool', {
      page: opened.pageId,
      tool: 'slow_read',
      arguments: {},
    });
    await delay(100);
    opened.send({
      t: 'tools',
      tools: [WRITE_TOOL, { ...SLOW_READ, annotations: { readOnlyHint: false } }],
    });
    await opened.sync();
    // Its check gives up at the budget; the call is a write by then, so it waits its turn.
    await eventually(() => lines.some((line) => line.includes('ran out of time')), 3000);
    await eventually(() => queuedOrder(lines).length === 2);
    await delay(50);
    expect(held).toHaveLength(1);
    answer(opened, held[0]);
    await eventually(() => held.length === 2);
    expect(held[1]?.tool).toBe('slow_read');
    answer(opened, held[1]);
    expect((await running).isError).toBe(false);
    expect((await reading).isError).toBe(false);
  });

  /**
   * A generous budget: the fan-out check holds its call this long, far longer
   * than any step below takes on a loaded machine, so the page can re-list a
   * tool while the check runs, and ordinary checks never come near it.
   */
  const WINDOW_MS = 2000;

  /** Resolves once the relay has asked the check worker about a call to this tool. */
  function checkStarted(tool: string): () => boolean {
    const check = vi.spyOn(ArgumentChecker.prototype, 'check');
    return () => check.mock.calls.some(([name]) => name === tool);
  }

  it('sends a write re-listed as read-only during its check exactly once, and the write behind it does not wait for it', async () => {
    const { lines } = await setup({
      timings: { argumentCheckMs: WINDOW_MS, callDeadlineMs: 10_000 },
    });
    const { held, onInvoke } = holdingPage();
    const opened = await page({ tools: [SLOW_WRITE, WRITE_TOOL], onInvoke });
    const alice = await client();
    await pairAndApprove(alice, opened);
    const started = checkStarted('slow_write');
    const slow = callTool(alice, 'call_page_tool', {
      page: opened.pageId,
      tool: 'slow_write',
      arguments: {},
    });
    await eventually(started);
    const behind = write(alice, opened.pageId, 'behind');
    await eventually(() => queuedOrder(lines).length === 2);
    opened.send({
      t: 'tools',
      tools: [{ ...SLOW_WRITE, annotations: { readOnlyHint: true } }, WRITE_TOOL],
    });
    await opened.sync();
    expect(held).toHaveLength(0);

    // Its check gives up; it is a read by then, so it goes out beside the write
    // behind it, which runs without waiting for its answer.
    await eventually(() => held.length === 2, WINDOW_MS * 3);
    expect(held.map((frame) => frame.tool)).toEqual(['slow_write', 'add_item']);
    await delay(100);
    await opened.sync();
    expect(held).toHaveLength(2);
    answer(opened, held[1]);
    expect((await behind).isError).toBe(false);
    answer(opened, held[0]);
    expect((await slow).isError).toBe(false);
    await opened.sync();
    expect(held).toHaveLength(2);
  }, 20_000);

  it('names a client whose only call is a write once its check passes', async () => {
    const { relay } = await setup({ timings: { argumentCheckMs: WINDOW_MS } });
    const opened = await page({ onInvoke: () => ({ ok: true, content: '{}' }) });
    await pairAndApprove(await client(), opened);
    const writer = await client(ALICE, { name: 'writer', modern: true });
    expect((await write(writer, opened.pageId, 'x')).isError).toBe(false);
    await opened.sync();
    expect(relay.audit.records().map((record) => [record.tool, record.outcome])).toEqual([
      ['add_item', 'ok'],
    ]);
    expect(
      opened
        .all('roster')
        .at(-1)
        ?.attachments[0]?.clients.map((c) => c.name),
    ).toEqual(['writer', 'relay-test']);
  });

  it('refuses a read re-listed as mutating during its check with page_busy when the queue is full (S9)', async () => {
    const { lines } = await setup({
      limits: { queueDepth: 1 },
      timings: { argumentCheckMs: WINDOW_MS, callDeadlineMs: 10_000 },
    });
    const { held, onInvoke } = holdingPage();
    const opened = await page({ tools: [WRITE_TOOL, SLOW_READ], onInvoke });
    const alice = await client();
    await pairAndApprove(alice, opened);
    // One write on the page and one waiting: the queue is at its depth.
    const running = write(alice, opened.pageId, 'first');
    await eventually(() => held.length === 1);
    const waiting = write(alice, opened.pageId, 'second');
    await eventually(() => queuedOrder(lines).length === 2);

    const started = checkStarted('slow_read');
    const reading = callTool(alice, 'call_page_tool', {
      page: opened.pageId,
      tool: 'slow_read',
      arguments: {},
    });
    await eventually(started);
    opened.send({
      t: 'tools',
      tools: [WRITE_TOOL, { ...SLOW_READ, annotations: { readOnlyHint: false } }],
    });
    await opened.sync();
    // Its check gives up; it is a write by then, and no place is left for it.
    expect(await reading).toEqual({
      isError: true,
      text: 'page_busy: 1 calls that change the page are already waiting their turn; try again shortly',
      structured: undefined,
    });
    expect(queuedOrder(lines)).toHaveLength(2);
    answer(opened, held[0]);
    await eventually(() => held.length === 2);
    expect(held[1]?.tool).toBe('add_item');
    answer(opened, held[1]);
    expect((await running).isError).toBe(false);
    expect((await waiting).isError).toBe(false);
    await opened.sync();
    expect(held.map((frame) => frame.tool)).toEqual(['add_item', 'add_item']);
  }, 20_000);
});

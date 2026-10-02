// The write queue (SPEC section 5, A2.3): mutating calls run one at a time per
// page in arrival order, read-only calls go straight through, and a queued
// call leaves the queue on cancel, revoke, sleep or timeout, with its role
// checked again when it reaches the front.

import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectPage,
  type InvokeFrame,
  type InvokeReply,
  type PageOptions,
  type TestPage,
  TOOLS,
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
    await eventually(() => queuedOrder(current?.lines ?? []).length === 3);
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

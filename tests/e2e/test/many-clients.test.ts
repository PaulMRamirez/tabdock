// A2.1 and A2.3 end to end through the real adapter: two users on three MCP
// clients of both protocol eras share one sim page, the page's own roster names
// every one of them, and twenty concurrent writes from the three clients run on
// the page strictly one at a time in the order they reached the relay while
// reads go straight through.

import type { Client } from '@modelcontextprotocol/client';
import { createDefaultTools, type FakeToolDefinition } from '@tabdock/sim-page';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachAs,
  callTool,
  deferred,
  delay,
  eventually,
  inputField,
  listPages,
  pairAgain,
  queuedCallIds,
  SIM_TOOL_COUNT,
  startWorld,
  type ToolOutcome,
  waitForTools,
  watchFrames,
  type World,
} from './helpers.ts';

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

interface PageEvent {
  kind: 'start' | 'end' | 'read';
  label: string;
  /** performance.now() where the handler ran; the sim page shares the test's clock. */
  at: number;
}

interface WriteSpan {
  label: string;
  startIndex: number;
  endIndex: number;
  startAt: number;
  endAt: number;
}

/** Each write's start and end on the page, in the order the writes started. */
function writeSpans(events: readonly PageEvent[]): WriteSpan[] {
  const spans: WriteSpan[] = [];
  events.forEach((event, index) => {
    if (event.kind !== 'start') return;
    const endIndex = events.findIndex(
      (other, at) => at > index && other.kind === 'end' && other.label === event.label,
    );
    const end = events[endIndex];
    if (!end) throw new Error(`write ${event.label} never ended`);
    spans.push({
      label: event.label,
      startIndex: index,
      endIndex,
      startAt: event.at,
      endAt: end.at,
    });
  });
  return spans;
}

/** Each client's name, sorted, per user on the page's roster. */
function rosterClients(
  roster: readonly { userId: string; role: string; clients: readonly { name: string }[] }[],
): [string, string, string[]][] {
  return roster
    .map((entry): [string, string, string[]] => [
      entry.userId,
      entry.role,
      entry.clients.map((client) => client.name).sort(),
    ])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

describe('A2.1: two users and three clients on one page', () => {
  it("the page's roster lists both users and all three clients, and list_pages works for each", async () => {
    world = await startWorld();
    const sim = await world.page({ policy: { maxDrivers: 2 } });
    const laptop = await world.client(world.alice, 'alice-laptop');
    const phone = await world.client(world.alice, 'alice-phone', { modern: true });
    const tablet = await world.client(world.bob, 'bob-tablet');

    const pageId = await attachAs(laptop, sim, 'driver');
    // Alice's second client pairs with the next code and joins her attachment without a prompt.
    const again = await pairAgain(phone, sim);
    expect(again.isError, again.text).toBe(false);
    expect(again.text).toMatch(/You were already attached\./);
    expect(again.structured).toMatchObject({ page: pageId, role: 'driver' });
    expect(await attachAs(tablet, sim, 'observer')).toBe(pageId);

    const state = await sim.waitFor((s) => {
      const clients = s.roster.flatMap((entry) => entry.clients);
      return s.roster.length === 2 && clients.length === 3;
    });
    expect(rosterClients(state.roster)).toEqual([
      ['alice', 'driver', ['alice-laptop', 'alice-phone']],
      ['bob', 'observer', ['bob-tablet']],
    ]);
    expect(state.roster.map((entry) => entry.displayName).sort()).toEqual(['Alice', 'Bob']);

    for (const [client, role] of [
      [laptop, 'driver'],
      [phone, 'driver'],
      [tablet, 'observer'],
    ] as const) {
      expect(await listPages(client)).toMatchObject([{ page: pageId, role, state: 'awake' }]);
    }

    // Each client is attributed by its own name on both eras, on the page and in the audit.
    await waitForTools(laptop, pageId, SIM_TOOL_COUNT);
    for (const client of [laptop, phone, tablet]) {
      const read = await callTool(client, 'call_page_tool', { page: pageId, tool: 'get_value' });
      expect(read.isError, read.text).toBe(false);
    }
    expect(
      sim.activity.map((entry) => [entry.user.userId, entry.client?.name, entry.outcome]).reverse(),
    ).toEqual([
      ['alice', 'alice-laptop', 'ok'],
      ['alice', 'alice-phone', 'ok'],
      ['bob', 'bob-tablet', 'ok'],
    ]);
    expect(
      world.relay.audit.records().map((record) => [record.userId, record.client?.name]),
    ).toEqual([
      ['alice', 'alice-laptop'],
      ['alice', 'alice-phone'],
      ['bob', 'bob-tablet'],
    ]);
  });
});

describe('A2.3: the write queue through the real adapter', () => {
  it('runs twenty concurrent writes from three clients one at a time in arrival order, while reads interleave', async () => {
    world = await startWorld({ timings: { callDeadlineMs: 20_000 } });
    const w = world;

    // The page's own record, in the order things happened there: when each
    // write's handler started and ended, and when each read ran.
    const events: PageEvent[] = [];
    const note = (kind: PageEvent['kind'], label: string): void => {
      events.push({ kind, label, at: performance.now() });
    };
    let writesRunning = 0;
    let mostWritesRunning = 0;
    // Holds the first write on the page until the reads have come back.
    const gate = deferred();
    const startedWrites = (): number => events.filter((event) => event.kind === 'start').length;
    const reads: { label: string; queuedAtRelay: number; startedOnPage: number }[] = [];
    const labelled = {
      type: 'object',
      properties: { label: { type: 'string' } },
      required: ['label'],
      additionalProperties: false,
    };
    const probeTools = (): FakeToolDefinition[] => [
      {
        name: 'write',
        description: 'Record a write; the first one waits for the test.',
        inputSchema: labelled,
        annotations: { readOnlyHint: false },
        execute: async (input) => {
          const label = inputField(input, 'label');
          writesRunning += 1;
          mostWritesRunning = Math.max(mostWritesRunning, writesRunning);
          note('start', label);
          if (startedWrites() === 1) await gate.promise;
          // A real macrotask, so a second write could start meanwhile if anything let it.
          await new Promise((resolve) => setTimeout(resolve, 1));
          note('end', label);
          writesRunning -= 1;
          return { label };
        },
      },
      {
        name: 'read',
        description: 'Record a read and what the relay had queued by then.',
        inputSchema: labelled,
        annotations: { readOnlyHint: true },
        execute: (input) => {
          const label = inputField(input, 'label');
          note('read', label);
          // The relay runs in this process, so its log is the relay's own record at this instant.
          reads.push({
            label,
            queuedAtRelay: queuedCallIds(w.relayLogs).length,
            startedOnPage: startedWrites(),
          });
          return { label };
        },
      },
    ];
    const sim = await w.page({
      policy: { maxDrivers: 2 },
      tools: (store) => [...createDefaultTools(store), ...probeTools()],
    });
    const laptop = await w.client(w.alice, 'alice-laptop');
    const phone = await w.client(w.alice, 'alice-phone', { modern: true });
    const tablet = await w.client(w.bob, 'bob-tablet');
    const pageId = await attachAs(laptop, sim, 'driver');
    const again = await pairAgain(phone, sim);
    expect(again.isError, again.text).toBe(false);
    await attachAs(tablet, sim, 'driver');
    await waitForTools(laptop, pageId, SIM_TOOL_COUNT + 2);
    const wire = watchFrames(sim);

    const clients: [string, Client][] = [
      ['alice-laptop', laptop],
      ['alice-phone', phone],
      ['bob-tablet', tablet],
    ];
    const call = (client: Client, tool: string, label: string): Promise<ToolOutcome> =>
      callTool(client, 'call_page_tool', { page: pageId, tool, arguments: { label } });
    const writes = Array.from({ length: 20 }, (_, i) => {
      const [, client] = clients[i % 3] as [string, Client];
      return call(client, 'write', `w${String(i)}`);
    });

    // All twenty have reached the relay and the first holds the page.
    await eventually(async () =>
      Promise.resolve(queuedCallIds(w.relayLogs).length === 20 && startedWrites() === 1),
    );
    // Reads from every client come back while nineteen writes still wait their turn.
    const readOutcomes = await Promise.all(
      clients.map(([name, client]) => call(client, 'read', `r-${name}`)),
    );
    for (const outcome of readOutcomes) expect(outcome.isError, outcome.text).toBe(false);
    expect(startedWrites()).toBe(1);
    gate.resolve();

    const outcomes = await Promise.all(writes);
    for (const outcome of outcomes) expect(outcome.isError, outcome.text).toBe(false);

    // Strictly one at a time: each write's span on the page ends before the next one starts,
    // in the page's event order and on its clock.
    const spans = writeSpans(events);
    expect(spans).toHaveLength(20);
    for (let k = 0; k + 1 < spans.length; k += 1) {
      const [current, next] = [spans[k], spans[k + 1]];
      if (!current || !next) throw new Error('missing span');
      expect(current.endIndex).toBeLessThan(next.startIndex);
      expect(current.endAt).toBeLessThanOrEqual(next.startAt);
    }
    expect(mostWritesRunning).toBe(1);
    const writeStarts = spans.map((span) => span.label);

    // In arrival order: the page started them in the order the relay logged them arriving.
    const labelByCallId = new Map<string, string>();
    for (const frame of wire) {
      if (frame.t === 'invoke' && frame.tool === 'write') {
        labelByCallId.set(frame.callId, inputField(frame.arguments, 'label'));
      }
    }
    const arrival = queuedCallIds(w.relayLogs);
    expect(arrival).toHaveLength(20);
    expect(arrival.map((callId) => labelByCallId.get(callId))).toEqual(writeStarts);
    // The invokes reached the page in that same order, on the page's own socket.
    const writeIds = new Set(arrival);
    const order = wire
      .filter((frame) => frame.t === 'invoke' && writeIds.has(frame.callId))
      .map((frame) => (frame.t === 'invoke' ? frame.callId : ''));
    expect(order).toEqual(arrival);

    // The reads ran on the page while writes were queued: inside the first write, with the rest waiting.
    expect(reads).toHaveLength(3);
    for (const read of reads) {
      expect(read.queuedAtRelay - read.startedOnPage).toBeGreaterThanOrEqual(1);
    }
    const first = spans[0];
    if (!first) throw new Error('no write ran');
    for (const [name] of clients) {
      const at = events.findIndex((event) => event.kind === 'read' && event.label === `r-${name}`);
      expect(at).toBeGreaterThan(first.startIndex);
      expect(at).toBeLessThan(first.endIndex);
    }

    // The writes came from all three clients, and the page and the relay attribute each one.
    const pageWrites = sim.activity.filter((entry) => entry.tool === 'write');
    expect(pageWrites).toHaveLength(20);
    expect(new Set(pageWrites.map((entry) => entry.client?.name))).toEqual(
      new Set(['alice-laptop', 'alice-phone', 'bob-tablet']),
    );
    expect(pageWrites.every((entry) => entry.outcome === 'ok')).toBe(true);
    const audited = w.relay.audit.records().filter((record) => record.tool === 'write');
    expect(audited.map((record) => record.outcome)).toEqual(Array<string>(20).fill('ok'));
    expect(new Set(audited.map((record) => record.client?.name))).toEqual(
      new Set(['alice-laptop', 'alice-phone', 'bob-tablet']),
    );
  }, 30_000);
});

describe('the write queue when a running write is answered early', () => {
  it.each(['a client cancel', 'a revoke'] as const)(
    'keeps the next write off the page until a write answered by %s has ended there (polyfill 5.1)',
    async (how) => {
      world = await startWorld({ timings: { callDeadlineMs: 15_000 } });
      const w = world;
      const log: string[] = [];
      let running = 0;
      let most = 0;
      const gate = deferred();
      const started = deferred();
      const write = (name: string, body: () => Promise<void>): FakeToolDefinition => ({
        name,
        description: `${name} on the page`,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false },
        execute: async (_input, runtime) => {
          running += 1;
          most = Math.max(most, running);
          // The polyfill calls a handler with its input alone, so nothing can tell it to stop.
          log.push(runtime === undefined ? `${name} start` : `${name} start with a signal`);
          await body();
          log.push(`${name} end`);
          running -= 1;
          return { done: name };
        },
      });
      const sim = await w.page({
        profile: 'polyfill-5.1',
        // The polyfill drops consequentialHint, so the page names its one
        // consequential tool, wipe, and these writes run with no prompt.
        policy: { maxDrivers: 2, consequentialTools: ['wipe'] },
        tools: (store) => [
          ...createDefaultTools(store),
          write('slow_write', async () => {
            started.resolve();
            await gate.promise;
          }),
          write('fast_write', () => delay(10)),
        ],
      });
      const alice = await w.client(w.alice, 'alice-laptop');
      const bob = await w.client(w.bob, 'bob-tablet');
      const pageId = await attachAs(alice, sim, 'driver');
      await attachAs(bob, sim, 'driver');
      await waitForTools(alice, pageId, SIM_TOOL_COUNT + 2);

      const abort = new AbortController();
      const slow = alice
        .callTool(
          { name: 'call_page_tool', arguments: { page: pageId, tool: 'slow_write' } },
          { signal: abort.signal },
        )
        .then(
          (result) => (result.isError === true ? 'tool error' : 'answered'),
          () => 'rejected',
        );
      await started.promise;
      const fast = callTool(bob, 'call_page_tool', { page: pageId, tool: 'fast_write' });
      await eventually(async () => Promise.resolve(queuedCallIds(w.relayLogs).length === 2));
      if (how === 'a client cancel') abort.abort();
      else expect(sim.revoke('alice')).toBe(true);
      expect(await slow).toBe(how === 'a client cancel' ? 'rejected' : 'tool error');

      // The relay answered Alice and sent Bob's write on; the page holds it
      // while the slow handler, which never heard of the cancel, still runs.
      await sim.waitFor((s) => s.activity.some((entry) => entry.tool === 'fast_write'));
      await delay(100);
      expect(log).toEqual(['slow_write start']);
      expect(sim.activity.find((entry) => entry.tool === 'slow_write')).toMatchObject({
        outcome: 'cancelled',
        handlerRunning: true,
      });

      gate.resolve();
      const after = await fast;
      expect(after.isError, after.text).toBe(false);
      expect(log).toEqual([
        'slow_write start',
        'slow_write end',
        'fast_write start',
        'fast_write end',
      ]);
      expect(most).toBe(1);
      expect(sim.activity.find((entry) => entry.tool === 'slow_write')).toMatchObject({
        outcome: 'cancelled',
        handlerRunning: false,
      });
    },
    20_000,
  );
});

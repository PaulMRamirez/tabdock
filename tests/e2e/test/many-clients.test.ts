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
  eventually,
  inputField,
  listPages,
  pairingCode,
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
    // Alice's second device pairs with the next code and joins her attachment without a prompt.
    const again = await callTool(phone, 'pair_page', { code: await pairingCode(sim) });
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

    // What the page handlers saw, in the order they saw it.
    const events: string[] = [];
    const writeStarts: string[] = [];
    let writesRunning = 0;
    let mostWritesRunning = 0;
    // Holds the first write on the page until the reads have come back.
    const gate = deferred();
    const reads: { label: string; queuedAtRelay: number; startedOnPage: number }[] = [];
    const probeTools = (): FakeToolDefinition[] => [
      {
        name: 'write',
        description: 'Record a write; the first one waits for the test.',
        inputSchema: {
          type: 'object',
          properties: { label: { type: 'string' } },
          required: ['label'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
        execute: async (input) => {
          const label = inputField(input, 'label');
          writesRunning += 1;
          mostWritesRunning = Math.max(mostWritesRunning, writesRunning);
          events.push(`start ${label}`);
          writeStarts.push(label);
          if (writeStarts.length === 1) await gate.promise;
          // A real macrotask, so a second write could start meanwhile if anything let it.
          await new Promise((resolve) => setTimeout(resolve, 1));
          events.push(`end ${label}`);
          writesRunning -= 1;
          return { label };
        },
      },
      {
        name: 'read',
        description: 'Record a read and what the relay had queued by then.',
        inputSchema: {
          type: 'object',
          properties: { label: { type: 'string' } },
          required: ['label'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        execute: (input) => {
          const label = inputField(input, 'label');
          events.push(`read ${label}`);
          // The relay runs in this process, so its log is the relay's own record at this instant.
          reads.push({
            label,
            queuedAtRelay: queuedCallIds(w.relayLogs).length,
            startedOnPage: writeStarts.length,
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
    expect((await callTool(phone, 'pair_page', { code: await pairingCode(sim) })).isError).toBe(
      false,
    );
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
      Promise.resolve(queuedCallIds(w.relayLogs).length === 20 && writeStarts.length === 1),
    );
    // Reads from every client come back while nineteen writes still wait their turn.
    const readOutcomes = await Promise.all(
      clients.map(([name, client]) => call(client, 'read', `r-${name}`)),
    );
    for (const outcome of readOutcomes) expect(outcome.isError, outcome.text).toBe(false);
    expect(writeStarts).toHaveLength(1);
    gate.resolve();

    const outcomes = await Promise.all(writes);
    for (const outcome of outcomes) expect(outcome.isError, outcome.text).toBe(false);

    // Strictly one at a time: every write ends before the next one starts.
    const writeEvents = events.filter((event) => !event.startsWith('read '));
    expect(writeEvents).toHaveLength(40);
    for (let i = 0; i < writeEvents.length; i += 2) {
      const label = (writeEvents[i] ?? '').slice('start '.length);
      expect(writeEvents[i]).toBe(`start ${label}`);
      expect(writeEvents[i + 1]).toBe(`end ${label}`);
    }
    expect(mostWritesRunning).toBe(1);

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
    // And the relay sent each write only after the one before it had answered.
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
    const firstEnd = events.indexOf(`end ${writeStarts[0] ?? ''}`);
    for (const [name] of clients) {
      const at = events.indexOf(`read r-${name}`);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(firstEnd);
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

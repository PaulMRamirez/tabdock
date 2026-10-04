// A2.2: roles are checked twice (S5). The real relay refuses an observer a
// mutating tool before the page hears of it, including after the operator
// demotes a driver, and also when the demotion lands while that driver's write
// is waiting in the queue. Then the relay's check is taken out of the way: a scripted
// stand-in relay sends the real adapter an invoke that claims driver for a
// user the operator approved as observer, on a roster that lies too, and the
// page answers role_denied without running its handler.

import { createDefaultTools, type SimPage, startSimPage } from '@tabdock/sim-page';
import type { Caller } from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachAs,
  callTool,
  deferred,
  errorCode,
  eventually,
  linked,
  queuedCallIds,
  SIM_TOOL_COUNT,
  startWorld,
  waitForTools,
  watchFrames,
  type World,
} from './helpers.ts';
import { STAND_IN_LIMITS, type StandInRelay, startStandInRelay } from './stand-in-relay.ts';

let world: World | undefined;
let standIn: StandInRelay | undefined;
let sim: SimPage | undefined;
afterEach(async () => {
  await sim?.close();
  sim = undefined;
  await standIn?.close();
  standIn = undefined;
  await world?.close();
  world = undefined;
});

describe('A2.2: the relay refuses an observer a mutating tool', () => {
  it('refuses the observer before the page hears of it, and holds a demotion the same way', async () => {
    world = await startWorld();
    const page = await world.page();
    const alice = await world.client(world.alice, 'alice-laptop');
    const bob = await world.client(world.bob, 'bob-tablet');
    const pageId = await attachAs(alice, page, 'driver');
    await attachAs(bob, page, 'observer');
    await waitForTools(bob, pageId, SIM_TOOL_COUNT);

    const refused = await callTool(bob, 'call_page_tool', {
      page: pageId,
      tool: 'set_value',
      arguments: { value: 'from an observer' },
    });
    expect(errorCode(refused), refused.text).toBe('role_denied');
    // The relay's own wording: the call never left the relay.
    expect(refused.text).toBe(
      'role_denied: you are an observer on this page, and set_value is not marked read-only',
    );
    expect(page.store.calls).toEqual([]);
    expect(page.activity).toEqual([]);

    // Reads stay open to the observer, and the driver still writes.
    const read = await callTool(bob, 'call_page_tool', { page: pageId, tool: 'get_value' });
    expect(read.isError, read.text).toBe(false);
    const written = await callTool(alice, 'call_page_tool', {
      page: pageId,
      tool: 'set_value',
      arguments: { value: 'from the driver' },
    });
    expect(written.isError, written.text).toBe(false);

    // The operator demotes Alice from the page; the relay refuses her next write itself.
    expect(page.setRole('alice', 'observer')).toBe(true);
    await page.waitFor((s) => s.roster.find((a) => a.userId === 'alice')?.role === 'observer');
    const demoted = await callTool(alice, 'call_page_tool', {
      page: pageId,
      tool: 'set_value',
      arguments: { value: 'after the demotion' },
    });
    expect(errorCode(demoted), demoted.text).toBe('role_denied');
    expect(page.store.value).toBe('from the driver');
    expect(page.store.calls.map((c) => c.tool)).toEqual(['get_value', 'set_value']);
    expect(world.relay.audit.records().map((r) => [r.userId, r.tool, r.outcome])).toEqual([
      ['bob', 'set_value', 'role_denied'],
      ['bob', 'get_value', 'ok'],
      ['alice', 'set_value', 'ok'],
      ['alice', 'set_value', 'role_denied'],
    ]);
  });
});

describe('A2.2: a demotion reaches a write already waiting in the queue', () => {
  it('refuses the queued write when it reaches the front, so the page never runs it', async () => {
    world = await startWorld({ timings: { callDeadlineMs: 15_000 } });
    const w = world;
    const started = deferred();
    const gate = deferred();
    const page = await w.page({
      policy: { maxDrivers: 2 },
      tools: (store) => [
        ...createDefaultTools(store),
        {
          name: 'slow_write',
          description: 'A write that holds the page until the test lets it finish.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: false },
          execute: async () => {
            started.resolve();
            await gate.promise;
            return { done: true };
          },
        },
      ],
    });
    const alice = await w.client(w.alice, 'alice-laptop');
    const bob = await w.client(w.bob, 'bob-tablet', { modern: true });
    const pageId = await attachAs(alice, page, 'driver');
    await attachAs(bob, page, 'driver');
    await waitForTools(alice, pageId, SIM_TOOL_COUNT + 1);
    const wire = watchFrames(page);

    const slow = callTool(alice, 'call_page_tool', { page: pageId, tool: 'slow_write' });
    await started.promise;
    const waiting = callTool(bob, 'call_page_tool', {
      page: pageId,
      tool: 'set_value',
      arguments: { value: 'queued before the demotion' },
    });
    await eventually(async () => Promise.resolve(queuedCallIds(w.relayLogs).length === 2));

    // Bob was a driver when his write arrived; the operator demotes him while it waits.
    expect(page.setRole('bob', 'observer')).toBe(true);
    await page.waitFor((s) => s.roster.find((a) => a.userId === 'bob')?.role === 'observer');
    gate.resolve();
    expect((await slow).isError).toBe(false);
    const refused = await waiting;
    expect(refused.text).toBe(
      'role_denied: you are an observer on this page now, and set_value is not marked read-only',
    );
    // Only Alice's write was ever sent to the page.
    expect(wire.flatMap((frame) => (frame.t === 'invoke' ? [frame.tool] : []))).toEqual([
      'slow_write',
    ]);
    expect(page.store.calls).toEqual([]);
    expect(page.store.value).toBeNull();
  });
});

describe('A2.2: the adapter refuses when the relay check is bypassed', () => {
  function caller(userId: string, displayName: string, role: Caller['role']): Caller {
    return { userId, displayName, client: { name: 'stand-in-client', version: '0.0.0' }, role };
  }

  it('answers role_denied for an observer whose invoke claims driver, and the handler never runs', async () => {
    standIn = await startStandInRelay();
    const relay = standIn;
    sim = await startSimPage({ relayUrl: relay.url, profile: 'chrome-156' });
    const page = sim;

    const hello = await relay.next('hello');
    expect(hello.policy.autoApprove).toBe('none');
    relay.send({
      t: 'welcome',
      pageId: 'pg_standin001',
      resumeToken: 'stand-in-resume-token',
      resumed: false,
      // A made-up code for a relay that pairs nobody; no client ever sees it.
      pairing: { code: 'STAND-IN000', expiresAt: Date.now() + 120_000 },
      roster: [],
      limits: STAND_IN_LIMITS,
    });
    expect((await linked(page)).pageId).toBe('pg_standin001');
    const tools = await relay.next('tools', (frame) => frame.tools.length === SIM_TOOL_COUNT);
    expect(tools.tools.find((t) => t.name === 'set_value')?.annotations?.readOnlyHint).toBe(false);

    // The operator approves Bob as an observer and Alice as a driver, on the page.
    const answer = async (userId: string, displayName: string, role: Caller['role']) => {
      const requestId = `rq_${userId}`;
      relay.send({
        t: 'attach_request',
        requestId,
        user: { userId, displayName },
        account: { kind: 'member', verified: true },
        via: 'code',
        client: { name: 'stand-in-client', version: '0.0.0' },
        expiresAt: Date.now() + 60_000,
      });
      await page.waitFor((s) => s.pendingRequests.some((r) => r.requestId === requestId));
      expect(page.dock.approve(requestId, role)).toBe(true);
      expect(await relay.next('attach_decision', (f) => f.requestId === requestId)).toEqual({
        t: 'attach_decision',
        requestId,
        allow: true,
        role,
      });
    };
    await answer('bob', 'Bob', 'observer');
    await answer('alice', 'Alice', 'driver');

    // The stand-in skips its own check and lies: everyone is a driver, and Carol, whom
    // nobody approved, is attached too.
    const now = Date.now();
    const listed = (userId: string, displayName: string) => ({
      userId,
      displayName,
      kind: 'member' as const,
      role: 'driver' as const,
      grantedAt: now,
      lastUsedAt: null,
      expiresAt: now + 3_600_000,
      clients: [],
      inviteId: null,
      endsAt: null,
    });
    relay.send({
      t: 'roster',
      attachments: [listed('alice', 'Alice'), listed('bob', 'Bob'), listed('carol', 'Carol')],
    });
    await page.waitFor((s) => s.roster.length === 3);

    const invoke = async (callId: string, tool: string, who: Caller, args = {}) => {
      relay.send({ t: 'invoke', callId, tool, arguments: args, caller: who, deadlineMs: 5000 });
      return relay.next('result', (frame) => frame.callId === callId);
    };

    const bobWrites = await invoke('cl_bob_write', 'set_value', caller('bob', 'Bob', 'driver'), {
      value: 'observer write',
    });
    expect(bobWrites).toMatchObject({ ok: false, error: { code: 'role_denied' } });
    expect(bobWrites.error?.message).toBe('observers may only run read-only tools');

    const carolReads = await invoke(
      'cl_carol_read',
      'get_value',
      caller('carol', 'Carol', 'driver'),
    );
    expect(carolReads).toMatchObject({ ok: false, error: { code: 'role_denied' } });
    expect(carolReads.error?.message).toBe(
      'the operator has not approved this caller on this page',
    );

    // Neither handler ran.
    expect(page.store.calls).toEqual([]);
    expect(page.store.value).toBeNull();

    // Controls: the same stand-in's invokes do run when the operator's grant allows them.
    const bobReads = await invoke('cl_bob_read', 'get_value', caller('bob', 'Bob', 'driver'));
    expect(bobReads).toMatchObject({ ok: true });
    const aliceWrites = await invoke(
      'cl_alice_write',
      'set_value',
      caller('alice', 'Alice', 'driver'),
      {
        value: 'driver write',
      },
    );
    expect(aliceWrites).toMatchObject({ ok: true });
    expect(page.store.calls.map((c) => c.tool)).toEqual(['get_value', 'set_value']);
    expect(page.store.value).toBe('driver write');

    // The page's activity log (S7) records the refusals as its own outcome.
    expect(page.activity.map((e) => [e.user.userId, e.tool, e.outcome]).reverse()).toEqual([
      ['bob', 'set_value', 'role_denied'],
      ['carol', 'get_value', 'role_denied'],
      ['bob', 'get_value', 'ok'],
      ['alice', 'set_value', 'ok'],
    ]);
  });
});

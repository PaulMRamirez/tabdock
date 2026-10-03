// The operator's controls end to end through the real adapter: A2.4, a revoke
// from the page while a call runs (S8); A2.5, a consequential tool that
// prompts on the page, where a deny and silence both end in denied_by_operator
// (S6); and the pause switch, which turns every call away with page_busy until
// the operator resumes.

import { createDefaultTools } from '@tabdock/sim-page';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachAs,
  callTool,
  errorCode,
  eventually,
  holdRecord,
  holdTool,
  listPages,
  pairingCode,
  queuedCallIds,
  SIM_TOOL_COUNT,
  startWorld,
  waitForTools,
  watchFrames,
  type World,
} from './helpers.ts';

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

describe('A2.4: revoke cancels an in-flight call and blocks the next one', () => {
  it("the client hears not_attached, the page handler's AbortSignal fires, and the next call is refused", async () => {
    world = await startWorld({ timings: { callDeadlineMs: 15_000 } });
    const held = holdRecord();
    // chrome-156 hands handlers an AbortSignal, so the page itself can be told to stop.
    const sim = await world.page({
      profile: 'chrome-156',
      tools: (store) => [...createDefaultTools(store), holdTool(held)],
    });
    const alice = await world.client(world.alice, 'alice-laptop');
    const bob = await world.client(world.bob, 'bob-tablet');
    const pageId = await attachAs(alice, sim, 'driver');
    await attachAs(bob, sim, 'observer');
    await waitForTools(alice, pageId, SIM_TOOL_COUNT + 1);
    const wire = watchFrames(sim);

    const pending = callTool(alice, 'call_page_tool', { page: pageId, tool: 'hold' });
    expect(await held.started.promise).toEqual({ hasSignal: true });
    const invoke = wire.find((frame) => frame.t === 'invoke' && frame.tool === 'hold');
    if (invoke?.t !== 'invoke') throw new Error('the hold invoke never reached the page');
    expect(sim.activity[0]).toMatchObject({ callId: invoke.callId, outcome: 'running' });

    // The operator presses Revoke on Alice's row, through the page's own handle.
    expect(sim.revoke('alice')).toBe(true);

    const outcome = await pending;
    expect(outcome.text).toBe('not_attached: the page operator revoked your attachment');
    await held.aborted.promise;
    expect(sim.activity.find((entry) => entry.callId === invoke.callId)?.outcome).toBe('cancelled');
    // The relay cancelled the call on the page too, saying why.
    await eventually(async () =>
      Promise.resolve(wire.some((frame) => frame.t === 'cancel' && frame.callId === invoke.callId)),
    );
    expect(wire.filter((frame) => frame.t === 'cancel')).toEqual([
      { t: 'cancel', callId: invoke.callId, reason: 'revoked' },
    ]);

    // The next call is refused at the relay and never reaches the page.
    const before = sim.store.calls.length;
    const next = await callTool(alice, 'call_page_tool', { page: pageId, tool: 'get_value' });
    expect(next.text).toBe(`not_attached: you are not attached to page ${pageId}`);
    expect(sim.store.calls.length).toBe(before);
    expect(await listPages(alice)).toEqual([]);

    // Bob's attachment is untouched.
    const state = await sim.waitFor((s) => s.roster.length === 1);
    expect(state.roster.map((a) => [a.userId, a.role])).toEqual([['bob', 'observer']]);
    const read = await callTool(bob, 'call_page_tool', { page: pageId, tool: 'get_value' });
    expect(read.isError, read.text).toBe(false);
    expect(world.relay.audit.records().map((r) => [r.userId, r.tool, r.outcome])).toEqual([
      ['alice', 'hold', 'not_attached'],
      ['alice', 'get_value', 'not_attached'],
      ['bob', 'get_value', 'ok'],
    ]);
  });

  it("drops the revoked user's queued writes too, and another user's queued write still runs", async () => {
    world = await startWorld({ timings: { callDeadlineMs: 15_000 } });
    const w = world;
    const held = holdRecord();
    const sim = await w.page({
      policy: { maxDrivers: 2 },
      tools: (store) => [...createDefaultTools(store), holdTool(held)],
    });
    const alice = await w.client(w.alice, 'alice-laptop');
    const bob = await w.client(w.bob, 'bob-phone', { modern: true });
    const pageId = await attachAs(alice, sim, 'driver');
    await attachAs(bob, sim, 'driver');
    await waitForTools(alice, pageId, SIM_TOOL_COUNT + 1);
    const wire = watchFrames(sim);
    const setValue = (client: typeof alice, value: string) =>
      callTool(client, 'call_page_tool', { page: pageId, tool: 'set_value', arguments: { value } });

    // Alice's hold runs on the page; two more of hers and one of Bob's wait behind it.
    const holding = callTool(alice, 'call_page_tool', { page: pageId, tool: 'hold' });
    await held.started.promise;
    const aliceFirst = setValue(alice, 'alice 1');
    await eventually(async () => Promise.resolve(queuedCallIds(w.relayLogs).length === 2));
    const bobs = setValue(bob, 'bob');
    await eventually(async () => Promise.resolve(queuedCallIds(w.relayLogs).length === 3));
    const aliceSecond = setValue(alice, 'alice 2');
    await eventually(async () => Promise.resolve(queuedCallIds(w.relayLogs).length === 4));

    expect(sim.revoke('alice')).toBe(true);
    const revoked = 'not_attached: the page operator revoked your attachment';
    expect((await holding).text).toBe(revoked);
    expect((await aliceFirst).text).toBe(revoked);
    expect((await aliceSecond).text).toBe(revoked);
    await held.aborted.promise;
    const after = await bobs;
    expect(after.isError, after.text).toBe(false);

    // Of the four calls in arrival order, only the hold and Bob's write ever reached the page.
    const [holdId, aliceFirstId, bobId, aliceSecondId] = queuedCallIds(w.relayLogs);
    expect(new Set([holdId, aliceFirstId, bobId, aliceSecondId]).size).toBe(4);
    const invokes = wire.flatMap((frame) => (frame.t === 'invoke' ? [frame.callId] : []));
    expect(invokes).toEqual([holdId, bobId]);
    expect(wire.filter((frame) => frame.t === 'cancel')).toEqual([
      { t: 'cancel', callId: holdId, reason: 'revoked' },
    ]);
    // The hold tool keeps no store record; set_value does, and only Bob's ran.
    expect(sim.store.calls).toEqual([{ tool: 'set_value', input: { value: 'bob' } }]);
    expect(sim.store.value).toBe('bob');
  });

  it("Revoke all ends everyone's attachment at once", async () => {
    world = await startWorld();
    const sim = await world.page({ policy: { maxDrivers: 2 } });
    const alice = await world.client(world.alice, 'alice-laptop');
    const bob = await world.client(world.bob, 'bob-tablet', { modern: true });
    const pageId = await attachAs(alice, sim, 'driver');
    await attachAs(bob, sim, 'driver');
    await sim.waitFor((s) => s.roster.length === 2);

    expect(sim.revoke('*')).toBe(true);
    await sim.waitFor((s) => s.roster.length === 0);
    for (const client of [alice, bob]) {
      const call = await callTool(client, 'call_page_tool', { page: pageId, tool: 'get_value' });
      expect(errorCode(call), call.text).toBe('not_attached');
      expect(await listPages(client)).toEqual([]);
    }
    expect(sim.store.calls).toEqual([]);
  });
});

describe('a revoke made while the link is down', () => {
  it.each(['none', 'observer'] as const)(
    "survives a reload before the link is back: the relay ends the attachment and the next call is not_attached (autoApprove '%s')",
    async (autoApprove) => {
      world = await startWorld();
      const sim = await world.page({ policy: { autoApprove } });
      const bob = await world.client(world.bob, 'bob-tablet');
      let pageId: string;
      if (autoApprove === 'none') {
        pageId = await attachAs(bob, sim, 'observer');
      } else {
        const paired = await callTool(bob, 'pair_page', { code: await pairingCode(sim) });
        expect(paired.isError, paired.text).toBe(false);
        pageId = (paired.structured as { page: string }).page;
      }
      await sim.waitFor((s) => s.roster.some((attachment) => attachment.userId === 'bob'));
      await waitForTools(bob, pageId, SIM_TOOL_COUNT);
      const read = await callTool(bob, 'call_page_tool', { page: pageId, tool: 'get_value' });
      expect(read.isError, read.text).toBe(false);

      // The link drops, the operator revokes Bob before it is back, then reloads the tab.
      sim.socket?.terminate();
      await sim.waitFor((s) => s.link === 'reconnecting');
      expect(sim.revoke('bob')).toBe(true);
      await sim.reload();

      // The reloaded page resumes the session and sends the revoke the relay never heard.
      await sim.waitFor((s) => s.link === 'linked' && s.roster.length === 0);
      const next = await callTool(bob, 'call_page_tool', { page: pageId, tool: 'get_value' });
      expect(next.text).toBe(`not_attached: you are not attached to page ${pageId}`);
      expect(await listPages(bob)).toEqual([]);
      expect(sim.store.calls.map((call) => call.tool)).toEqual(['get_value']);
    },
  );
});

describe('A2.5: a consequential tool prompts on the page', () => {
  it('a deny returns denied_by_operator, and the writes queued behind the prompt run after it', async () => {
    world = await startWorld();
    const w = world;
    const sim = await w.page({ policy: { maxDrivers: 2 } });
    const alice = await w.client(w.alice, 'alice-laptop');
    const bob = await w.client(w.bob, 'bob-phone', { modern: true });
    const pageId = await attachAs(alice, sim, 'driver');
    await attachAs(bob, sim, 'driver');
    await waitForTools(alice, pageId, SIM_TOOL_COUNT);
    const set = await callTool(alice, 'call_page_tool', {
      page: pageId,
      tool: 'set_value',
      arguments: { value: 'keep me' },
    });
    expect(set.isError, set.text).toBe(false);

    const wiping = callTool(alice, 'call_page_tool', { page: pageId, tool: 'wipe' });
    const prompted = await sim.waitFor((s) => s.pendingConfirms.length > 0);
    const confirm = prompted.pendingConfirms[0];
    // The prompt names who is asking and through which client.
    expect(confirm).toMatchObject({
      tool: 'wipe',
      caller: {
        userId: 'alice',
        displayName: 'Alice',
        role: 'driver',
        client: { name: 'alice-laptop', version: '0.0.0' },
      },
    });

    // Bob's write arrives while the operator decides; it waits at the relay behind the wipe.
    const bobWrites = callTool(bob, 'call_page_tool', {
      page: pageId,
      tool: 'set_value',
      arguments: { value: 'from bob' },
    });
    await eventually(async () => Promise.resolve(queuedCallIds(w.relayLogs).length === 3));
    expect(sim.store.calls.map((c) => c.tool)).toEqual(['set_value']);

    expect(sim.dock.confirm(confirm?.callId ?? '', false)).toBe(true);
    const denied = await wiping;
    expect(denied.text).toBe('denied_by_operator: the page operator denied this call');
    expect(sim.state.pendingConfirms).toEqual([]);

    const after = await bobWrites;
    expect(after.isError, after.text).toBe(false);
    expect(sim.store.calls.map((c) => c.tool)).toEqual(['set_value', 'set_value']);
    expect(sim.store.value).toBe('from bob');
    expect(sim.activity.map((e) => [e.user.userId, e.tool, e.outcome]).reverse()).toEqual([
      ['alice', 'set_value', 'ok'],
      ['alice', 'wipe', 'denied_by_operator'],
      ['bob', 'set_value', 'ok'],
    ]);
  });

  it('silence until the deadline also denies', async () => {
    // A short page deadline; the relay keeps its default grace past it.
    world = await startWorld({ timings: { callDeadlineMs: 500 } });
    const sim = await world.page();
    const alice = await world.client(world.alice, 'alice-laptop', { modern: true });
    const pageId = await attachAs(alice, sim, 'driver');
    await waitForTools(alice, pageId, SIM_TOOL_COUNT);

    const wiping = callTool(alice, 'call_page_tool', { page: pageId, tool: 'wipe' });
    await sim.waitFor((s) => s.pendingConfirms.length > 0);
    // Nobody answers.
    const denied = await wiping;
    expect(errorCode(denied), denied.text).toBe('denied_by_operator');
    expect(sim.state.pendingConfirms).toEqual([]);
    expect(sim.store.calls).toEqual([]);
    expect(sim.activity[0]).toMatchObject({ tool: 'wipe', outcome: 'denied_by_operator' });
    expect(world.relay.audit.records().at(-1)).toMatchObject({
      tool: 'wipe',
      outcome: 'denied_by_operator',
    });
  });
});

describe('the pause switch', () => {
  it('answers every call page_busy while paused, and resuming restores calls', async () => {
    world = await startWorld();
    const sim = await world.page();
    const alice = await world.client(world.alice, 'alice-laptop');
    const pageId = await attachAs(alice, sim, 'driver');
    await waitForTools(alice, pageId, SIM_TOOL_COUNT);

    sim.pause(true);
    expect(sim.state.paused).toBe(true);
    const read = await callTool(alice, 'call_page_tool', { page: pageId, tool: 'get_value' });
    const write = await callTool(alice, 'call_page_tool', {
      page: pageId,
      tool: 'set_value',
      arguments: { value: 'while paused' },
    });
    for (const outcome of [read, write]) {
      expect(outcome.text).toBe('page_busy: the page is busy; try again shortly');
    }
    expect(sim.store.calls).toEqual([]);
    // The attachment stays: a pause is not a revoke.
    expect(await listPages(alice)).toMatchObject([{ page: pageId, role: 'driver' }]);

    sim.pause(false);
    expect(sim.state.paused).toBe(false);
    const resumed = await callTool(alice, 'call_page_tool', {
      page: pageId,
      tool: 'set_value',
      arguments: { value: 'after resume' },
    });
    expect(resumed.isError, resumed.text).toBe(false);
    expect(sim.store.value).toBe('after resume');
    expect(sim.activity.map((e) => [e.tool, e.outcome]).reverse()).toEqual([
      ['get_value', 'page_busy'],
      ['set_value', 'page_busy'],
      ['set_value', 'ok'],
    ]);
    expect(world.relay.audit.records().map((r) => r.outcome)).toEqual([
      'page_busy',
      'page_busy',
      'ok',
    ]);
  });
});

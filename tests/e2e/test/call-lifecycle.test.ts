// How M2 ends calls and attachments that the operator never touched, end to
// end through the real adapter: an attachment left unused past its idle time
// expires and drops off the page's roster (ADR 0009); arguments that fail a
// tool's inputSchema are refused at the relay before the page sees them, on
// every measured runtime (ADR 0008); and a client's cancellation, on either
// protocol era, reaches the page and aborts the running handler.

import { createDefaultTools, RUNTIME_PROFILES } from '@tabdock/sim-page';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachAs,
  callTool,
  errorCode,
  eventually,
  holdRecord,
  holdTool,
  listPages,
  relayEntries,
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

describe('idle expiry (ADR 0009)', () => {
  it('drops an attachment unused for its idle time from the roster, and its next call is not_attached', async () => {
    // Shortened from 8 hours. Long enough for the first call to land well inside it.
    world = await startWorld({ timings: { attachmentIdleMs: 2000 } });
    const w = world;
    const sim = await w.page();
    const alice = await w.client(w.alice, 'alice-laptop');
    const pageId = await attachAs(alice, sim, 'driver');
    const attached = await sim.waitFor((s) => s.roster.length === 1);
    const entry = attached.roster[0];
    // The roster tells the operator when the attachment will end.
    expect(entry?.expiresAt).toBe((entry?.grantedAt ?? 0) + 2000);
    await waitForTools(alice, pageId, SIM_TOOL_COUNT);
    // A call strictly after the grant, so an expiry counted from the grant would come first.
    await eventually(async () => Promise.resolve(Date.now() > (entry?.grantedAt ?? 0)));
    // The relay stamps the call on arrival, no earlier than this.
    const calledAt = Date.now();
    const used = await callTool(alice, 'call_page_tool', { page: pageId, tool: 'get_value' });
    expect(used.isError, used.text).toBe(false);

    // No more calls: the relay ends the attachment and tells the page.
    await sim.waitFor((s) => s.roster.length === 0, 10_000);
    // Counted from the call, not the grant: the call moved the expiry (the relay
    // ends an attachment only once Date.now() has passed its expiresAt).
    expect(Date.now()).toBeGreaterThanOrEqual(calledAt + 2000);
    expect(relayEntries(w.relayLogs).some((e) => e.msg === 'attachment expired')).toBe(true);
    expect(await listPages(alice)).toEqual([]);
    const next = await callTool(alice, 'call_page_tool', { page: pageId, tool: 'get_value' });
    expect(next.text).toBe(`not_attached: you are not attached to page ${pageId}`);
    expect(sim.store.calls.map((c) => c.tool)).toEqual(['get_value']);
  }, 15_000);
});

describe('argument validation at the relay (ADR 0008)', () => {
  it.each(RUNTIME_PROFILES)(
    'on %s, refuses arguments that fail the schema with invalid_arguments before the page sees them',
    async (profile) => {
      world = await startWorld();
      const sim = await world.page({ profile, policy: { consequentialTools: ['wipe'] } });
      const alice = await world.client(world.alice, 'alice-laptop');
      const pageId = await attachAs(alice, sim, 'driver');
      await waitForTools(alice, pageId, SIM_TOOL_COUNT);
      const setValue = (args: Record<string, unknown>) =>
        callTool(alice, 'call_page_tool', { page: pageId, tool: 'set_value', arguments: args });

      const prefix =
        'invalid_arguments: the arguments for tool set_value do not match its inputSchema: ';
      const wrongType = await setValue({ value: 42 });
      expect(wrongType.text).toBe(`${prefix}arguments/value has the wrong type (rule "type")`);
      const extra = await setValue({ value: 'ok', note: 'not in the schema' });
      expect(errorCode(extra), extra.text).toBe('invalid_arguments');
      const missing = await setValue({});
      expect(errorCode(missing), missing.text).toBe('invalid_arguments');
      const tooLong = await setValue({ value: 'x'.repeat(1001) });
      expect(errorCode(tooLong), tooLong.text).toBe('invalid_arguments');

      // None reached the page: its handler and its own activity log never saw them.
      expect(sim.store.calls).toEqual([]);
      expect(sim.activity).toEqual([]);

      const valid = await setValue({ value: 'fits' });
      expect(valid.isError, valid.text).toBe(false);
      expect(sim.store.calls).toEqual([{ tool: 'set_value', input: { value: 'fits' } }]);
      expect(world.relay.audit.records().map((r) => r.outcome)).toEqual([
        'invalid_arguments',
        'invalid_arguments',
        'invalid_arguments',
        'invalid_arguments',
        'ok',
      ]);
    },
  );
});

describe('cancellation from a client', () => {
  it.each([
    // No version pin: the SDK speaks the 2025 revision and holds a session with the relay.
    ['a 2025-era session client (notifications/cancelled)', 'alice-laptop', false],
    // Pinned to 2026-07-28, the client cancels by dropping its request stream.
    ['a 2026-07-28 client (it drops its request stream)', 'alice-phone', true],
  ])(
    'from %s reaches the page as cancel with reason client and aborts the running handler',
    async (_label, name, modern) => {
      world = await startWorld({ timings: { callDeadlineMs: 15_000 } });
      const held = holdRecord();
      const sim = await world.page({
        profile: 'chrome-156',
        tools: (store) => [...createDefaultTools(store), holdTool(held, { readOnly: true })],
      });
      const alice = await world.client(world.alice, name, { modern });
      const pageId = await attachAs(alice, sim, 'driver');
      await waitForTools(alice, pageId, SIM_TOOL_COUNT + 1);
      const wire = watchFrames(sim);

      const abort = new AbortController();
      const pending = alice
        .callTool(
          { name: 'call_page_tool', arguments: { page: pageId, tool: 'hold' } },
          { signal: abort.signal },
        )
        .then(
          () => 'answered',
          () => 'rejected',
        );
      expect(await held.started.promise).toEqual({ hasSignal: true });
      abort.abort();
      expect(await pending).toBe('rejected');

      await held.aborted.promise;
      const invoke = wire.find((frame) => frame.t === 'invoke' && frame.tool === 'hold');
      if (invoke?.t !== 'invoke') throw new Error('the hold invoke never reached the page');
      expect(invoke.caller.client).toEqual({ name, version: '0.0.0' });
      expect(wire.filter((frame) => frame.t === 'cancel')).toEqual([
        { t: 'cancel', callId: invoke.callId, reason: 'client' },
      ]);
      expect(sim.activity.find((e) => e.callId === invoke.callId)?.outcome).toBe('cancelled');
      await eventually(async () => Promise.resolve(world?.relay.audit.records().length === 1));
      expect(world.relay.audit.records()[0]).toMatchObject({
        tool: 'hold',
        outcome: 'cancelled',
        client: { name, version: '0.0.0' },
      });

      // The client carries on: the same client calls again.
      const read = await callTool(alice, 'call_page_tool', { page: pageId, tool: 'get_value' });
      expect(read.isError, read.text).toBe(false);
    },
  );
});

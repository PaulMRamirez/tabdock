// A first-class call (ADR 0025, A5.1) against the real adapter core, on the
// sim page, on both MCP eras: the relay suites hold the two routes side by
// side on the wire, and this holds what only the adapter decides. A call to
// `<page id>__wipe` prompts the operator on the page exactly as
// call_page_tool's does, Deny answers denied_by_operator in the same words
// with the same record, and Allow runs the handler (S6, A2.5); a client's
// cancellation of a call by a first-class name reaches the page as `cancel`
// and aborts the handler, as call_page_tool's does (S8).

import type { Client } from '@modelcontextprotocol/client';
import type { PendingConfirm } from '@tabdock/adapter/core';
import { createDefaultTools } from '@tabdock/sim-page';
import type { SimPage } from '@tabdock/sim-page';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachAs,
  callTool,
  errorCode,
  eventually,
  holdRecord,
  holdTool,
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

const ERAS = [
  ['a 2025-era session', false],
  ['2026-07-28', true],
] as const;

/**
 * A call that waits on the operator: the prompt it raised, the id of the
 * call the page was handed, and its answer once given.
 */
async function prompted(
  sim: SimPage,
  pending: Promise<ToolOutcome>,
  allow: boolean,
): Promise<{
  prompt: Omit<PendingConfirm, 'callId' | 'expiresAt'>;
  callId: string;
  answer: ToolOutcome;
}> {
  const state = await sim.waitFor((s) => s.pendingConfirms.length > 0);
  const [first] = state.pendingConfirms;
  if (first === undefined) throw new Error('no prompt on the page');
  expect(sim.dock.confirm(first.callId, allow)).toBe(true);
  const { tool, caller } = first;
  return { prompt: { tool, caller }, callId: first.callId, answer: await pending };
}

async function attachedDriver(
  world: World,
  modern: boolean,
): Promise<{ sim: SimPage; alice: Client; pageId: string }> {
  const sim = await world.page();
  const alice = await world.client(world.alice, 'alice-laptop', { modern });
  const pageId = await attachAs(alice, sim, 'driver');
  await waitForTools(alice, pageId, SIM_TOOL_COUNT);
  return { sim, alice, pageId };
}

describe('a consequential tool called by its first-class name', () => {
  it.each(ERAS)(
    'prompts on the page as call_page_tool does, and Deny answers denied_by_operator alike (%s)',
    async (_label, modern) => {
      world = await startWorld({ firstClassTools: true });
      const { sim, alice, pageId } = await attachedDriver(world, modern);
      const name = `${pageId}__wipe`;
      // The member's own list shows it by that name.
      expect((await alice.listTools()).tools.map((tool) => tool.name)).toContain(name);
      const kept = await callTool(alice, `${pageId}__set_value`, { value: 'keep me' });
      expect(kept.isError, kept.text).toBe(false);

      const fixed = await prompted(
        sim,
        callTool(alice, 'call_page_tool', { page: pageId, tool: 'wipe' }),
        false,
      );
      const fixedRecord = world.relay.audit.records().at(-1);
      const named = await prompted(sim, callTool(alice, name), false);
      const namedRecord = world.relay.audit.records().at(-1);

      expect(fixed.prompt).toMatchObject({
        tool: 'wipe',
        caller: { userId: 'alice', displayName: 'Alice', role: 'driver' },
      });
      expect(named.prompt).toEqual(fixed.prompt);
      expect(errorCode(fixed.answer), fixed.answer.text).toBe('denied_by_operator');
      expect(named.answer).toEqual(fixed.answer);
      expect(namedRecord).toMatchObject({ tool: 'wipe', outcome: 'denied_by_operator' });
      // Each line names the call the page was handed (ADR 0045), and the
      // two differ in nothing else a second call could share.
      expect(fixedRecord?.callId).toBe(fixed.callId);
      expect(namedRecord?.callId).toBe(named.callId);
      expect({ ...namedRecord, at: 0, durationMs: 0, callId: '' }).toEqual({
        ...fixedRecord,
        at: 0,
        durationMs: 0,
        callId: '',
      });
      expect(sim.store.value).toBe('keep me');
      expect(sim.store.calls.some((call) => call.tool === 'wipe')).toBe(false);

      // The same prompt, allowed this time, runs the handler.
      const allowed = await prompted(sim, callTool(alice, name), true);
      expect(allowed.prompt).toEqual(fixed.prompt);
      expect(allowed.answer.isError, allowed.answer.text).toBe(false);
      expect(allowed.answer.structured).toEqual({ wiped: true });
      expect(sim.store.value).toBeNull();
    },
  );
});

describe("a client's cancellation of a call by its first-class name", () => {
  it.each(ERAS)(
    'reaches the page as cancel with reason client and aborts the handler (%s)',
    async (_label, modern) => {
      world = await startWorld({ firstClassTools: true, timings: { callDeadlineMs: 15_000 } });
      const held = holdRecord();
      const sim = await world.page({
        profile: 'chrome-156',
        tools: (store) => [...createDefaultTools(store), holdTool(held, { readOnly: true })],
      });
      const alice = await world.client(world.alice, 'alice-laptop', { modern });
      const pageId = await attachAs(alice, sim, 'driver');
      await waitForTools(alice, pageId, SIM_TOOL_COUNT + 1);
      const wire = watchFrames(sim);

      const abort = new AbortController();
      const pending = alice
        .callTool({ name: `${pageId}__hold`, arguments: {} }, { signal: abort.signal })
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
      expect(wire.filter((frame) => frame.t === 'cancel')).toEqual([
        { t: 'cancel', callId: invoke.callId, reason: 'client' },
      ]);
      expect(sim.activity.find((entry) => entry.callId === invoke.callId)?.outcome).toBe(
        'cancelled',
      );
      await eventually(async () => Promise.resolve(world?.relay.audit.records().length === 1));
      expect(world.relay.audit.records()[0]).toMatchObject({ tool: 'hold', outcome: 'cancelled' });
    },
  );
});

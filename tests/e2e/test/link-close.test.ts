// How the page link ends, end to end with the real relay: a page that hears
// nothing from the relay closes with CLOSE_SILENT and resumes as the same page
// (only CLOSE_DETACH ends a session at once), and a page that detaches while a
// call runs leaves that call to the relay, which answers page_gone.

import { SILENCE_GRACE_MS, type Timers } from '@tabdock/adapter/core';
import { CLOSE_DETACH, CLOSE_SILENT, IDLE_TIMEOUT_MS } from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachAs,
  callTool,
  errorCode,
  eventually,
  linked,
  listPages,
  SIM_TOOL_COUNT,
  startWorld,
  waitForTools,
  type World,
} from './helpers.ts';

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

/** What the relay logged, by message. */
function relayMessages(w: World): string[] {
  return w.relayLogs.map((line) => (JSON.parse(line) as { msg: string }).msg);
}

/**
 * Real timers, except that once armed the adapter's silence watchdog (the
 * relay's idle timeout plus the adapter's grace) fires after 100 ms, so a test
 * need not sit through 35 s of silence. It shrinks one firing only.
 */
function shortWatchdog(): { timers: Timers; arm: () => void } {
  const watchdogMs = IDLE_TIMEOUT_MS + SILENCE_GRACE_MS;
  let armed = false;
  return {
    timers: {
      setTimeout: (callback, ms) => {
        if (!armed || ms !== watchdogMs) return setTimeout(callback, ms);
        return setTimeout(() => {
          armed = false;
          callback();
        }, 100);
      },
      clearTimeout: (handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    },
    arm: () => {
      armed = true;
    },
  };
}

describe('how the page link ends', () => {
  it('a silent relay: the watchdog closes with CLOSE_SILENT and the page resumes as itself', async () => {
    // Pings every 250 ms re-arm the watchdog, and the shortened one fires between two of them.
    world = await startWorld({ timings: { pingIntervalMs: 250 } });
    const watchdog = shortWatchdog();
    const sim = await world.page({ timers: watchdog.timers });
    const alice = await world.client(world.alice);
    const pageId = await attachAs(alice, sim, 'driver');
    await waitForTools(alice, pageId, SIM_TOOL_COUNT);

    watchdog.arm();
    await eventually(async () =>
      Promise.resolve(
        sim.logs.includes('warn heard nothing from the relay for too long; reconnecting'),
      ),
    );
    // The relay echoes the page's close code; 4000 here would have ended the session.
    await eventually(async () => Promise.resolve(sim.lastClose?.code === CLOSE_SILENT));
    expect(CLOSE_SILENT).not.toBe(CLOSE_DETACH);

    await eventually(async () => Promise.resolve(sim.logs.includes(`info resumed page ${pageId}`)));
    const state = await linked(sim);
    expect(state.pageId).toBe(pageId);
    expect(state.roster.map((a) => [a.userId, a.role])).toEqual([['alice', 'driver']]);
    expect(sim.connections).toBe(2);
    const messages = relayMessages(world);
    expect(messages).toContain('page asleep');
    expect(messages).not.toContain('page detached');

    // The attachment and the operator's grant both survived: Alice still drives.
    await waitForTools(alice, pageId, SIM_TOOL_COUNT);
    expect(await listPages(alice)).toMatchObject([
      { page: pageId, state: 'awake', role: 'driver' },
    ]);
    const set = await callTool(alice, 'call_page_tool', {
      page: pageId,
      tool: 'set_value',
      arguments: { value: 'after the silence' },
    });
    expect(set.isError, set.text).toBe(false);
    expect(sim.store.value).toBe('after the silence');
  });

  it('a detach mid-call: the running call fails with page_gone and the page is gone', async () => {
    world = await startWorld();
    const sim = await world.page();
    const alice = await world.client(world.alice);
    const pageId = await attachAs(alice, sim, 'driver');
    await waitForTools(alice, pageId, SIM_TOOL_COUNT);

    const pending = callTool(alice, 'call_page_tool', {
      page: pageId,
      tool: 'slow',
      arguments: { ms: 10_000 },
    });
    await eventually(async () => Promise.resolve(sim.store.calls.some((c) => c.tool === 'slow')));
    await sim.close();

    const outcome = await pending;
    // Not timeout: the page sent no 'cancelled' result, so the relay reports why the call ended.
    expect(errorCode(outcome), outcome.text).toBe('page_gone');
    expect(sim.lastClose?.code).toBe(CLOSE_DETACH);
    expect(
      sim.logs.some((line) => /^info call \S+ slow by Alice \(driver\): page detached$/.test(line)),
    ).toBe(true);
    expect(relayMessages(world)).toContain('page detached');
    expect(await listPages(alice)).toEqual([
      expect.objectContaining({ page: pageId, state: 'gone' }),
    ]);
  });
});

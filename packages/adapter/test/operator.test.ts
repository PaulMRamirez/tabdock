// M2 on the page: the write queue, the activity log (S7), and the
// operator's role switch, revoke (S8) and pause, driven through the core with
// the test relay socket from harness.ts.

import { MAX_TIMER_MS, RECONNECT_MIN_MS } from '@tabdock/protocol';
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_LIMIT,
  MAX_WAITING_WRITES,
  type RuntimeTool,
  UNWATCHED_HANDLER_GRACE_MS,
} from '../src/core.ts';
import {
  attachRequest,
  attachment,
  chromeTools,
  flush,
  GRANTS_KEY,
  invoke,
  link,
  PAUSED_KEY,
  results,
  REVOKED_KEY,
  runtimeTool,
  setup,
  welcome,
  type Harness,
} from './harness.ts';

function caller(userId: string, role: 'driver' | 'observer' = 'driver') {
  return {
    userId,
    displayName: userId.charAt(0).toUpperCase() + userId.slice(1),
    client: null,
    role,
  };
}

/** Results by call id, so a test can read outcomes without caring which came back first. */
function outcomes(socket: Awaited<ReturnType<typeof link>>): Record<string, string> {
  return Object.fromEntries(
    results(socket).map((frame) => [frame.callId, frame.error?.code ?? 'ok']),
  );
}

function storedGrants(h: Harness): unknown {
  return JSON.parse(h.storage.getItem(GRANTS_KEY) ?? 'null') as unknown;
}

/**
 * Makes a tool's handler wait until the test lets it go, and records how many
 * runs of the tools in `counted` overlap, so a test can prove writes never do.
 */
function holdHandlers(h: Harness, tools: string[], counted: string[] = tools) {
  const waiting: { tool: string; n: unknown; release: (value?: string) => void }[] = [];
  let active = 0;
  let most = 0;
  for (const tool of tools) {
    h.context.handlers.set(tool, (args) => {
      const counts = counted.includes(tool);
      if (counts) {
        active += 1;
        most = Math.max(most, active);
      }
      return new Promise<string>((resolve) => {
        waiting.push({
          tool,
          n: (args as { n?: unknown }).n,
          release: (value = 'done') => {
            if (counts) active -= 1;
            resolve(value);
          },
        });
      });
    });
  }
  return {
    waiting,
    get mostAtOnce() {
      return most;
    },
    /** Lets the oldest held run of this tool finish. */
    async release(tool: string): Promise<void> {
      const index = waiting.findIndex((run) => run.tool === tool);
      const [run] = waiting.splice(index, 1);
      if (index === -1 || !run) throw new Error(`no ${tool} run is waiting`);
      run.release();
      await flush();
    },
  };
}

/** chromeTools plus a second plain write, so a queue can hold two kinds of write. */
function queueTools(): RuntimeTool[] {
  return [
    ...chromeTools(),
    runtimeTool('add_item', { readOnlyHint: false, consequentialHint: false }),
  ];
}

describe('the write queue', () => {
  it('runs writes one at a time in arrival order while reads run beside them', async () => {
    const h = setup({ tools: queueTools() });
    const held = holdHandlers(h, ['set_value', 'add_item', 'get_value'], ['set_value', 'add_item']);
    const socket = await link(h);
    for (let n = 1; n <= 6; n += 1) {
      const tool = n % 2 === 0 ? 'add_item' : 'set_value';
      socket.deliver(invoke(tool, { callId: `w${n}`, arguments: { n } }));
      socket.deliver(invoke('get_value', { callId: `r${n}`, arguments: { n } }));
    }
    await flush();
    // One write and every read are with the page; five writes wait.
    expect(held.waiting.filter((run) => run.tool !== 'get_value').map((run) => run.n)).toEqual([1]);
    expect(held.waiting.filter((run) => run.tool === 'get_value')).toHaveLength(6);

    for (let n = 1; n <= 6; n += 1) {
      await held.release(n % 2 === 0 ? 'add_item' : 'set_value');
    }
    const writes = h.context.runs.filter((run) => run.tool !== 'get_value');
    expect(writes.map((run) => (run.args as { n: number }).n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(held.mostAtOnce).toBe(1);
    for (let n = 1; n <= 6; n += 1) await held.release('get_value');
    expect(Object.values(outcomes(socket))).toEqual(Array<string>(12).fill('ok'));
  });

  it('keeps arrival order when the tool list answers the first write last', async () => {
    const h = setup();
    const held = holdHandlers(h, ['set_value']);
    const socket = await link(h);
    const getTools = h.context.getTools.bind(h.context);
    let letFirstRead: () => void = () => undefined;
    let reads = 0;
    h.context.getTools = () => {
      reads += 1;
      if (reads !== 1) return getTools();
      return new Promise((resolve) => {
        letFirstRead = () => {
          resolve(getTools());
        };
      });
    };
    socket.deliver(invoke('set_value', { callId: 'first', arguments: { n: 1 } }));
    socket.deliver(invoke('set_value', { callId: 'second', arguments: { n: 2 } }));
    await flush();
    // The second write is ready to go, but the first arrived earlier and may write too.
    expect(h.context.runs).toHaveLength(0);
    letFirstRead();
    await flush();
    expect(h.context.runs.map((run) => run.args)).toEqual([{ n: 1 }]);
    await held.release('set_value');
    expect(h.context.runs.map((run) => run.args)).toEqual([{ n: 1 }, { n: 2 }]);
    await held.release('set_value');
    expect(outcomes(socket)).toEqual({ first: 'ok', second: 'ok' });
  });

  it('lets a queued write keep its deadline and leave the queue on cancel', async () => {
    const h = setup();
    const held = holdHandlers(h, ['set_value']);
    const socket = await link(h);
    socket.deliver(invoke('set_value', { callId: 'running' }));
    socket.deliver(invoke('set_value', { callId: 'short', deadlineMs: 1000 }));
    socket.deliver(invoke('set_value', { callId: 'cancelled' }));
    await flush();
    socket.deliver({ t: 'cancel', callId: 'cancelled', reason: 'client' });
    expect(outcomes(socket)).toEqual({ cancelled: 'cancelled' });
    // The deadline counts from arrival, not from reaching the front.
    await h.clock.advance(1000);
    expect(outcomes(socket)).toEqual({ cancelled: 'cancelled', short: 'timeout' });

    await held.release('set_value');
    expect(h.context.runs).toHaveLength(1);
    socket.deliver(invoke('set_value', { callId: 'later' }));
    await flush();
    expect(h.context.runs).toHaveLength(2);
  });

  it('turns a refused write away at once instead of queueing it', async () => {
    const h = setup();
    holdHandlers(h, ['set_value']);
    const socket = await link(h, {}, { alice: 'driver', olive: 'observer' });
    socket.deliver(invoke('set_value', { callId: 'running' }));
    socket.deliver(
      invoke('set_value', { callId: 'observer', caller: caller('olive', 'observer') }),
    );
    socket.deliver(invoke('nope', { callId: 'missing' }));
    await flush();
    expect(outcomes(socket)).toEqual({ observer: 'role_denied', missing: 'tool_not_found' });
  });

  it("checks the caller's role again when a write reaches the front", async () => {
    const h = setup();
    const held = holdHandlers(h, ['set_value']);
    const socket = await link(h, {}, { alice: 'driver', bob: 'driver' });
    socket.deliver(invoke('set_value', { callId: 'alice-1' }));
    socket.deliver(invoke('set_value', { callId: 'bob-1', caller: caller('bob') }));
    await flush();
    expect(h.dock.setRole('bob', 'observer')).toBe(true);
    await held.release('set_value');
    expect(outcomes(socket)).toEqual({ 'alice-1': 'ok', 'bob-1': 'role_denied' });
    expect(h.context.runs).toHaveLength(1);
  });

  it(`answers page_busy past ${MAX_WAITING_WRITES} waiting writes, as only a flooding relay sends them`, async () => {
    const h = setup();
    holdHandlers(h, ['set_value']);
    const socket = await link(h);
    for (let n = 0; n <= MAX_WAITING_WRITES + 1; n += 1) {
      socket.deliver(invoke('set_value', { callId: `w${n}` }));
    }
    await flush();
    // One runs, MAX_WAITING_WRITES wait, and the one after them is turned away.
    expect(outcomes(socket)).toEqual({ [`w${MAX_WAITING_WRITES + 1}`]: 'page_busy' });
    expect(h.context.runs).toHaveLength(1);
  });

  it('lets the next write go once a runtime that hands handlers the signal gives up on a cancelled or timed-out one', async () => {
    // The test runtime rejects at abort, as native WebMCP does after firing
    // the handler's own signal; a handler that ignores that signal is the page's bug.
    const h = setup();
    holdHandlers(h, ['set_value']);
    const socket = await link(h);
    socket.deliver(invoke('set_value', { callId: 'one', deadlineMs: 500 }));
    socket.deliver(invoke('set_value', { callId: 'two' }));
    socket.deliver(invoke('set_value', { callId: 'three' }));
    await flush();
    await h.clock.advance(500);
    expect(h.context.runs).toHaveLength(2);
    expect(h.context.runs[0]?.signal.aborted).toBe(true);
    socket.deliver({ t: 'cancel', callId: 'two' });
    await flush();
    expect(h.context.runs).toHaveLength(3);
    expect(outcomes(socket)).toEqual({ one: 'timeout', two: 'cancelled' });
    expect(h.dock.state.activity.map((entry) => entry.handlerRunning)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it.each([
    ['a client cancel', 'cancelled'],
    ['its deadline', 'timeout'],
    ['a revoke', 'cancelled'],
  ] as const)(
    'on the polyfill, whose handlers never see the signal, a write answered by %s keeps the page until its handler ends',
    async (how, code) => {
      const h = setup({ polyfill: true });
      const held = holdHandlers(h, ['set_value']);
      const socket = await link(h, {}, { alice: 'driver', bob: 'driver' });
      socket.deliver(
        invoke('set_value', { callId: 'first', caller: caller('bob'), deadlineMs: 500 }),
      );
      socket.deliver(invoke('set_value', { callId: 'second' }));
      await flush();
      expect(h.context.runs).toHaveLength(1);

      if (how === 'a client cancel') socket.deliver({ t: 'cancel', callId: 'first' });
      if (how === 'its deadline') await h.clock.advance(500);
      if (how === 'a revoke') expect(h.dock.revoke('bob')).toBe(true);
      await flush();
      // The relay hears at once, but the handler still runs, so the next write waits.
      expect(outcomes(socket)).toEqual({ first: code });
      expect(h.context.runs).toHaveLength(1);
      expect(h.dock.state.activity.find((entry) => entry.callId === 'first')).toMatchObject({
        outcome: code,
        handlerRunning: true,
      });

      await held.release('set_value');
      expect(h.context.runs.map((run) => run.args)).toEqual([{}, {}]);
      expect(h.dock.state.activity.find((entry) => entry.callId === 'first')).toMatchObject({
        outcome: code,
        handlerRunning: false,
      });
      await held.release('set_value');
      expect(outcomes(socket)).toEqual({ first: code, second: 'ok' });
      expect(held.mostAtOnce).toBe(1);
    },
  );

  it('waits for a runtime that never settles early, whatever answered the write', async () => {
    const h = setup();
    h.context.honoursAbort = false;
    const held = holdHandlers(h, ['set_value']);
    const socket = await link(h);
    socket.deliver(invoke('set_value', { callId: 'first' }));
    socket.deliver(invoke('set_value', { callId: 'second' }));
    await flush();
    socket.deliver({ t: 'cancel', callId: 'first' });
    await flush();
    expect(h.context.runs).toHaveLength(1);
    // A link that drops and comes back changes nothing: the handler still holds the page.
    socket.drop(1006);
    await h.clock.advance(RECONNECT_MIN_MS);
    const again = h.socket();
    again.accept();
    again.deliver(welcome(h.clock, { resumed: true, roster: [attachment('alice', 'driver')] }));
    again.deliver(invoke('set_value', { callId: 'third' }));
    await flush();
    expect(h.context.runs).toHaveLength(1);
    await held.release('set_value');
    expect(h.context.runs).toHaveLength(2);
    expect(held.mostAtOnce).toBe(1);
  });

  // The polyfill 5.1 also races each handler against its tool's registration,
  // so a page that unregisters a tool mid-run (a view going away in a
  // single-page app) makes executeTool reject at once while the handler runs on.
  it.each([
    ['while it runs', 'tool_error', 5000 + UNWATCHED_HANDLER_GRACE_MS],
    ['after a cancel', 'cancelled', 5000 + UNWATCHED_HANDLER_GRACE_MS],
    // Past its deadline the handler gets the grace from the moment it was lost.
    ['after its deadline', 'timeout', 3000 + UNWATCHED_HANDLER_GRACE_MS],
  ] as const)(
    'on the polyfill, a write whose tool is unregistered %s keeps the page until its deadline and a grace',
    async (when, code, freedAt) => {
      const h = setup({ polyfill: true, tools: queueTools() });
      holdHandlers(h, ['set_value', 'add_item']);
      const socket = await link(h);
      const deadlineMs = when === 'after its deadline' ? 1000 : 5000;
      socket.deliver(invoke('set_value', { callId: 'first', deadlineMs }));
      socket.deliver(invoke('add_item', { callId: 'second' }));
      await flush();
      if (when === 'after a cancel') socket.deliver({ t: 'cancel', callId: 'first' });
      await h.clock.advance(3000);
      expect(h.context.runs.map((run) => run.tool)).toEqual(['set_value']);

      h.context.unregister('set_value');
      await flush();
      // The relay hears how the call ended, but nothing will say when the handler does.
      expect(outcomes(socket)).toEqual({ first: code });
      if (when === 'while it runs') {
        expect(results(socket)[0]?.error?.message).toBe('Tool unregistered');
      }
      expect(h.dock.state.activity.find((entry) => entry.callId === 'first')).toMatchObject({
        outcome: code,
        handlerRunning: true,
      });
      await h.clock.advance(freedAt - 3000 - 1);
      expect(h.context.runs.map((run) => run.tool)).toEqual(['set_value']);
      expect(h.dock.state.activity.find((entry) => entry.callId === 'first')).toMatchObject({
        handlerRunning: true,
      });

      await h.clock.advance(1);
      expect(h.context.runs.map((run) => run.tool)).toEqual(['set_value', 'add_item']);
      expect(h.dock.state.activity.find((entry) => entry.callId === 'first')).toMatchObject({
        handlerRunning: false,
      });
      // One line, with nothing the page wrote in it.
      const released = h.logs.filter((line) => line.includes('stopped waiting'));
      expect(released).toEqual([
        'warn call first: stopped waiting for a handler whose tool was unregistered while it ran',
      ]);
    },
  );

  // A deadline within the timer maximum, plus the hold's grace, used to pass
  // it, and Chromium ran that timer at once, freeing the page under a handler
  // still running (ADR 0030).
  it('on the polyfill, holds the page for a write whose relay deadline is near the timer maximum', async () => {
    const h = setup({ polyfill: true, tools: queueTools(), browserTimers: true });
    holdHandlers(h, ['set_value', 'add_item']);
    const socket = await link(h);
    socket.deliver(invoke('set_value', { callId: 'first', deadlineMs: MAX_TIMER_MS - 1000 }));
    socket.deliver(invoke('add_item', { callId: 'second' }));
    await flush();
    h.context.unregister('set_value');
    await flush();
    expect(outcomes(socket)).toEqual({ first: 'tool_error' });
    await h.clock.advance(1000);
    expect(h.context.runs.map((run) => run.tool)).toEqual(['set_value']);
    expect(h.delays.filter((ms) => ms > MAX_TIMER_MS)).toEqual([]);
  });

  it.each([
    ['its handler throws', 'tool_error'],
    ['its tool is gone before the handler starts', 'tool_error'],
  ] as const)(
    'on the polyfill, a write whose runtime rejects because %s lets the next write go at once',
    async (how, code) => {
      const h = setup({ polyfill: true, tools: queueTools() });
      const held = holdHandlers(h, ['add_item']);
      h.context.handlers.set('set_value', () => {
        throw new Error('the page refused');
      });
      const socket = await link(h);
      // wipe is consequential, so the operator's prompt leaves time for the page to drop it.
      const first = how === 'its handler throws' ? 'set_value' : 'wipe';
      socket.deliver(invoke(first, { callId: 'first' }));
      socket.deliver(invoke('add_item', { callId: 'second' }));
      await flush();
      if (first === 'wipe') {
        h.context.unregister('wipe');
        await flush();
        expect(h.dock.confirm('first', true)).toBe(true);
      }
      await flush();
      expect(outcomes(socket)).toEqual({ first: code });
      expect(h.context.runs.map((run) => run.tool)).toEqual(
        first === 'wipe' ? ['add_item'] : ['set_value', 'add_item'],
      );
      expect(h.dock.state.activity.find((entry) => entry.callId === 'first')).toMatchObject({
        handlerRunning: false,
      });
      await held.release('add_item');
      expect(outcomes(socket)).toEqual({ first: code, second: 'ok' });
    },
  );
});

describe('call ids a relay reuses', () => {
  it.each([
    ['a revoke', 'cancelled'],
    ['a cancel', 'cancelled'],
    ['a pause', 'page_busy'],
  ] as const)(
    'a call reusing the id of a cancelled call whose handler lingers still answers to %s after that handler ends',
    async (how, code) => {
      // A runtime that never settles early keeps even a cancelled read's handler in view.
      const h = setup({ tools: queueTools() });
      h.context.honoursAbort = false;
      const held = holdHandlers(
        h,
        ['get_value', 'set_value', 'add_item'],
        ['set_value', 'add_item'],
      );
      const socket = await link(h, {}, { alice: 'driver', bob: 'driver' });
      socket.deliver(invoke('get_value', { callId: 'X' }));
      socket.deliver(invoke('add_item', { callId: 'busy', caller: caller('bob') }));
      await flush();
      socket.deliver({ t: 'cancel', callId: 'X' });
      await flush();
      // The relay reuses the id while the read's handler runs on; the new call waits behind Bob's write.
      socket.deliver(invoke('set_value', { callId: 'X' }));
      await flush();
      await held.release('get_value');
      const before = results(socket).length;

      if (how === 'a revoke') expect(h.dock.revoke('alice')).toBe(true);
      if (how === 'a cancel') socket.deliver({ t: 'cancel', callId: 'X' });
      if (how === 'a pause') h.dock.pause(true);
      await flush();
      expect(
        results(socket)
          .slice(before)
          .map((frame) => [frame.callId, frame.error?.code]),
      ).toEqual([['X', code]]);
      await held.release('add_item');
      expect(h.context.runs.filter((run) => run.tool === 'set_value')).toHaveLength(0);
    },
  );

  it('ignores an invoke that reuses the id of a write whose handler still holds the page', async () => {
    const h = setup({ polyfill: true });
    const held = holdHandlers(h, ['set_value', 'get_value']);
    const socket = await link(h);
    socket.deliver(invoke('set_value', { callId: 'X' }));
    await flush();
    socket.deliver({ t: 'cancel', callId: 'X' });
    await flush();
    socket.deliver(invoke('get_value', { callId: 'X' }));
    await flush();
    expect(h.context.runs.map((run) => run.tool)).toEqual(['set_value']);
    expect(h.logs).toContain('warn ignored a repeated invoke for call X');
    expect(h.dock.state.activity.map((entry) => entry.callId)).toEqual(['X']);

    // Once the handler lets go, the id is free again.
    await held.release('set_value');
    socket.deliver(invoke('get_value', { callId: 'X' }));
    await flush();
    expect(h.context.runs.map((run) => run.tool)).toEqual(['set_value', 'get_value']);
  });
});

describe('the activity log (S7)', () => {
  it('shows a call as running when it starts and settles it with its outcome and duration', async () => {
    const h = setup();
    const held = holdHandlers(h, ['get_value']);
    const socket = await link(h);
    const started = h.clock.now;
    socket.deliver(
      invoke('get_value', {
        caller: { ...caller('alice'), client: { name: 'claude-code', version: '2.1.287' } },
        arguments: { secret: 'argument-value-xyz' },
      }),
    );
    expect(h.dock.state.activity).toEqual([
      {
        callId: 'call-1',
        time: started,
        user: { userId: 'alice', displayName: 'Alice' },
        client: { name: 'claude-code', version: '2.1.287' },
        tool: 'get_value',
        outcome: 'running',
        // Nobody confirmed it in a client: it is not consequential (ADR 0026).
        confirmedBy: null,
        durationMs: null,
        handlerRunning: false,
      },
    ]);
    await h.clock.advance(250);
    await held.release('get_value');
    expect(h.dock.state.activity).toMatchObject([
      { callId: 'call-1', outcome: 'ok', durationMs: 250, time: started },
    ]);
    expect(JSON.stringify(h.dock.state.activity)).not.toContain('argument-value-xyz');
    expect(Object.isFrozen(h.dock.state.activity[0])).toBe(true);
  });

  it('records every outcome the page can give, newest first', async () => {
    const h = setup({ tools: [...chromeTools(), runtimeTool('slow', { readOnlyHint: true })] });
    h.context.handlers.set('set_value', () => {
      throw new Error('no');
    });
    h.context.handlers.set('slow', () => new Promise(() => undefined));
    const socket = await link(h);
    socket.deliver(invoke('get_value', { callId: 'ok' }));
    socket.deliver(invoke('set_value', { callId: 'tool-error' }));
    socket.deliver(invoke('get_value', { callId: 'role', caller: caller('stranger') }));
    socket.deliver(invoke('nope', { callId: 'missing' }));
    await flush();
    socket.deliver(invoke('wipe', { callId: 'denied' }));
    await flush();
    h.dock.confirm('denied', false);
    socket.deliver(invoke('slow', { callId: 'cancel' }));
    socket.deliver(invoke('slow', { callId: 'late', deadlineMs: 100 }));
    await flush();
    socket.deliver({ t: 'cancel', callId: 'cancel' });
    await h.clock.advance(100);
    h.dock.pause(true);
    socket.deliver(invoke('get_value', { callId: 'busy' }));
    await flush();
    expect(h.dock.state.activity.map((entry) => [entry.callId, entry.outcome])).toEqual([
      ['busy', 'page_busy'],
      ['late', 'timeout'],
      ['cancel', 'cancelled'],
      ['denied', 'denied_by_operator'],
      ['missing', 'tool_not_found'],
      ['role', 'role_denied'],
      ['tool-error', 'tool_error'],
      ['ok', 'ok'],
    ]);
  });

  it(`keeps only the newest ${ACTIVITY_LIMIT} calls`, async () => {
    const h = setup();
    const socket = await link(h);
    for (let n = 1; n <= ACTIVITY_LIMIT + 5; n += 1) {
      socket.deliver(invoke('get_value', { callId: `call-${n}` }));
    }
    await flush();
    const ids = h.dock.state.activity.map((entry) => entry.callId);
    expect(ids).toHaveLength(ACTIVITY_LIMIT);
    expect(ids[0]).toBe(`call-${ACTIVITY_LIMIT + 5}`);
    expect(ids.at(-1)).toBe('call-6');
    expect(h.dock.state.activity.every((entry) => entry.outcome === 'ok')).toBe(true);
  });

  it('settles a call the link took down as cancelled', async () => {
    const h = setup();
    holdHandlers(h, ['get_value']);
    const socket = await link(h);
    socket.deliver(invoke('get_value'));
    await flush();
    socket.drop(1006);
    expect(h.dock.state.activity[0]?.outcome).toBe('cancelled');
  });
});

describe("the operator's role switch", () => {
  it('records the new grant first, keeps it in storage, then sends set_role', async () => {
    const h = setup();
    const socket = await link(h, {}, { bob: 'observer' });
    expect(h.dock.setRole('bob', 'driver')).toBe(true);
    expect(storedGrants(h)).toEqual({ pageId: 'page-1', grants: { bob: { role: 'driver' } } });
    expect(socket.last()).toEqual({ t: 'set_role', userId: 'bob', role: 'driver' });

    // Until the relay lists Bob as a driver, the lesser role holds.
    socket.deliver(invoke('set_value', { callId: 'before', caller: caller('bob') }));
    await flush();
    socket.deliver({ t: 'roster', attachments: [attachment('bob', 'driver')] });
    socket.deliver(invoke('set_value', { callId: 'after', caller: caller('bob') }));
    await flush();
    expect(outcomes(socket)).toEqual({ before: 'role_denied', after: 'ok' });
  });

  it('holds a demotion at once, before the relay applies it or if it never does', async () => {
    const h = setup();
    const socket = await link(h, {}, { bob: 'driver' });
    expect(h.dock.setRole('bob', 'observer')).toBe(true);
    socket.deliver(invoke('set_value', { callId: 'write', caller: caller('bob') }));
    socket.deliver(invoke('get_value', { callId: 'read', caller: caller('bob') }));
    await flush();
    expect(outcomes(socket)).toEqual({ write: 'role_denied', read: 'ok' });
  });

  it('leaves a promotion the relay refuses at maxDrivers as an observer', async () => {
    const h = setup();
    const socket = await link(h, {}, { alice: 'driver', bob: 'observer' });
    expect(h.dock.setRole('bob', 'driver')).toBe(true);
    // The relay keeps Bob an observer, as one driver is all this page allows.
    socket.deliver({
      t: 'roster',
      attachments: [attachment('alice', 'driver'), attachment('bob', 'observer')],
    });
    socket.deliver(invoke('set_value', { caller: caller('bob') }));
    await flush();
    expect(outcomes(socket)).toEqual({ 'call-1': 'role_denied' });
  });

  it('promotes someone autoApprove attached, which is how they ever get to write', async () => {
    const h = setup({ core: { policy: { autoApprove: 'observer' } } });
    const socket = await link(h, { roster: [attachment('carol', 'observer')] }, {});
    expect(h.dock.setRole('carol', 'driver')).toBe(true);
    socket.deliver({ t: 'roster', attachments: [attachment('carol', 'driver')] });
    socket.deliver(invoke('set_value', { caller: caller('carol') }));
    await flush();
    expect(outcomes(socket)).toEqual({ 'call-1': 'ok' });
  });

  it('refuses a listed user the page never approved, so a demotion click cannot grant access', async () => {
    const h = setup();
    const socket = await link(h, { roster: [attachment('mallory', 'driver')] }, {});
    expect(h.dock.setRole('mallory', 'observer')).toBe(false);
    expect(h.dock.setRole('mallory', 'driver')).toBe(false);
    expect(socket.framesOf('set_role')).toEqual([]);
    expect(storedGrants(h)).toBeNull();
    socket.deliver(invoke('get_value', { caller: caller('mallory') }));
    await flush();
    expect(outcomes(socket)).toEqual({ 'call-1': 'role_denied' });
  });

  it('shows the role the page enforces for each listed user, which only lowers what the relay says', async () => {
    const h = setup();
    const socket = await link(h, {}, { alice: 'driver', bob: 'observer' });
    socket.deliver({
      t: 'roster',
      attachments: [
        attachment('mallory', 'driver'),
        attachment('alice', 'driver'),
        attachment('bob', 'driver'),
      ],
    });
    expect(h.dock.state.pageRoles).toEqual([
      { userId: 'mallory', role: null, revoked: false, inviteRole: null },
      { userId: 'alice', role: 'driver', revoked: false, inviteRole: null },
      { userId: 'bob', role: 'observer', revoked: false, inviteRole: null },
    ]);
    // A demotion holds on the page before the relay applies it, and a revoke at once.
    expect(h.dock.setRole('alice', 'observer')).toBe(true);
    expect(h.dock.revoke('bob')).toBe(true);
    expect(h.dock.state.pageRoles).toEqual([
      { userId: 'mallory', role: null, revoked: false, inviteRole: null },
      { userId: 'alice', role: 'observer', revoked: false, inviteRole: null },
      { userId: 'bob', role: null, revoked: true, inviteRole: null },
    ]);

    const auto = setup({ core: { policy: { autoApprove: 'observer' } } });
    await link(auto, { roster: [attachment('carol', 'driver')] }, {});
    expect(auto.dock.state.pageRoles).toEqual([
      { userId: 'carol', role: 'observer', revoked: false, inviteRole: null },
    ]);
  });

  it('refuses a confirmed consequential call whose caller was demoted while the prompt was up', async () => {
    const h = setup();
    const socket = await link(h, {}, { alice: 'driver', bob: 'driver' });
    socket.deliver(invoke('wipe', { callId: 'bob-wipe', caller: caller('bob') }));
    await flush();
    expect(h.dock.state.pendingConfirms.map((item) => item.callId)).toEqual(['bob-wipe']);
    // The relay checked Bob as a driver before sending the call; only the page sees this.
    expect(h.dock.setRole('bob', 'observer')).toBe(true);
    expect(h.dock.confirm('bob-wipe', true)).toBe(true);
    await flush();
    expect(outcomes(socket)).toEqual({ 'bob-wipe': 'role_denied' });
    expect(h.context.runs).toEqual([]);
  });

  it('refuses a user the roster does not list, a role that is not one, and a page not linked', async () => {
    const h = setup();
    const socket = await link(h, {}, { bob: 'observer' });
    expect(h.dock.setRole('zed', 'driver')).toBe(false);
    expect(h.dock.setRole('bob', 'admin' as never)).toBe(false);
    socket.drop(1006);
    expect(h.dock.setRole('bob', 'driver')).toBe(false);
    expect(socket.framesOf('set_role')).toEqual([]);
    expect(storedGrants(h)).toEqual({ pageId: 'page-1', grants: { bob: { role: 'observer' } } });
  });
});

describe('revoke (S8)', () => {
  it("ends one user's grant, request, prompt and running call, telling the relay first", async () => {
    const h = setup();
    holdHandlers(h, ['get_value']);
    const socket = await link(h, {}, { alice: 'driver', bob: 'driver' });
    socket.deliver(invoke('get_value', { callId: 'bob-read', caller: caller('bob') }));
    socket.deliver(invoke('wipe', { callId: 'bob-wipe', caller: caller('bob') }));
    socket.deliver(invoke('get_value', { callId: 'alice-read' }));
    socket.deliver({ ...attachRequest(h.clock, 'bob-again') });
    await flush();
    expect(h.dock.state.pendingConfirms.map((item) => item.callId)).toEqual(['bob-wipe']);
    const before = socket.sent.length;

    expect(h.dock.revoke('bob')).toBe(true);
    const after = socket.frames().slice(before);
    expect(after[0]).toEqual({ t: 'revoke', userId: 'bob' });
    // The relay ends Bob's request as it applies the revoke, so the page sends
    // no decision for it: one would only reach a request already gone (A4.3).
    expect(after.slice(1)).toEqual([
      {
        t: 'result',
        callId: 'bob-read',
        ok: false,
        error: { code: 'cancelled', message: 'the operator revoked this caller' },
      },
      {
        t: 'result',
        callId: 'bob-wipe',
        ok: false,
        error: { code: 'denied_by_operator', message: 'the operator revoked this caller' },
      },
    ]);
    expect(h.context.runs.find((run) => run.tool === 'get_value')?.signal.aborted).toBe(true);
    expect(h.dock.state.pendingConfirms).toEqual([]);
    expect(h.dock.state.pendingRequests).toEqual([]);
    expect(storedGrants(h)).toEqual({ pageId: 'page-1', grants: { alice: { role: 'driver' } } });

    // The relay has not sent its new roster yet, and Bob still gets nothing.
    socket.deliver(invoke('get_value', { callId: 'bob-later', caller: caller('bob') }));
    await flush();
    expect(outcomes(socket)['bob-later']).toBe('role_denied');
    expect(h.dock.setRole('bob', 'driver')).toBe(false);
  });

  it('revokes everyone with *, and grants made afterwards are still kept', async () => {
    const h = setup();
    const socket = await link(h, {}, { alice: 'driver', bob: 'observer' });
    expect(h.dock.revoke('*')).toBe(true);
    expect(socket.last()).toEqual({ t: 'revoke', userId: '*' });
    expect(h.storage.getItem(GRANTS_KEY)).toBeNull();
    socket.deliver({ t: 'roster', attachments: [] });

    socket.deliver({
      ...attachRequest(h.clock, 'carol-1'),
      user: { userId: 'carol', displayName: 'Carol' },
    });
    expect(h.dock.approve('carol-1', 'observer')).toBe(true);
    expect(storedGrants(h)).toEqual({ pageId: 'page-1', grants: { carol: { role: 'observer' } } });
    expect(h.dock.revoke('*')).toBe(true);
  });

  it('sends one revoke for * and no decision for any request it ends, however many wait', async () => {
    const h = setup();
    const socket = await link(h, {}, { alice: 'driver' });
    for (let i = 0; i < 21; i += 1) {
      socket.deliver({
        ...attachRequest(h.clock, `wait-${String(i)}`),
        user: { userId: `user${String(i)}`, displayName: `User ${String(i)}` },
      });
    }
    expect(h.dock.state.pendingRequests).toHaveLength(21);
    const before = socket.sent.length;
    expect(h.dock.revoke('*')).toBe(true);
    // Each would reach a request the relay's revoke had already ended (A4.3).
    expect(socket.frames().slice(before)).toEqual([{ t: 'revoke', userId: '*' }]);
    expect(h.dock.state.pendingRequests).toEqual([]);
  });

  it('refuses a malformed id and a user with nothing to revoke', async () => {
    const h = setup();
    const socket = await link(h);
    expect(h.dock.revoke('not an id')).toBe(false);
    expect(h.dock.revoke('zed')).toBe(false);
    expect(socket.framesOf('revoke')).toEqual([]);
    const empty = setup();
    await link(empty, {}, {});
    expect(empty.dock.revoke('*')).toBe(false);
  });

  it("keeps a revoked user out until the relay drops them, even under autoApprove 'observer'", async () => {
    const h = setup({ core: { policy: { autoApprove: 'observer' } } });
    const socket = await link(h, { roster: [attachment('carol', 'observer')] }, {});
    socket.deliver(invoke('get_value', { callId: 'before', caller: caller('carol') }));
    await flush();
    expect(h.dock.revoke('carol')).toBe(true);
    socket.deliver(invoke('get_value', { callId: 'crossing', caller: caller('carol') }));
    await flush();
    // The relay applies the revoke, then attaches Carol again on her next pair_page.
    socket.deliver({ t: 'roster', attachments: [] });
    socket.deliver({ t: 'roster', attachments: [attachment('carol', 'observer')] });
    socket.deliver(invoke('get_value', { callId: 'again', caller: caller('carol') }));
    await flush();
    expect(outcomes(socket)).toEqual({ before: 'ok', crossing: 'role_denied', again: 'ok' });
  });

  it('sends a revoke made while the link was down once the session resumes', async () => {
    const h = setup();
    const first = await link(h, {}, { bob: 'driver' });
    first.drop(1006);
    expect(h.dock.revoke('bob')).toBe(true);
    expect(storedGrants(h)).toBeNull();
    await h.clock.advance(RECONNECT_MIN_MS);
    const second = h.socket();
    second.accept();
    second.deliver(welcome(h.clock, { resumed: true, roster: [attachment('bob', 'driver')] }));
    await flush();
    expect(second.framesOf('revoke')).toEqual([{ t: 'revoke', userId: 'bob' }]);
    second.deliver(invoke('get_value', { caller: caller('bob') }));
    await flush();
    expect(outcomes(second)).toEqual({ 'call-1': 'role_denied' });
  });

  it.each(['none', 'observer'] as const)(
    "keeps a revoke made while the link is down across a reload, sends it on resume and refuses the user meanwhile (autoApprove '%s')",
    async (autoApprove) => {
      const policy = { autoApprove };
      const first = setup({ core: { policy } });
      const bob = [attachment('bob', 'observer')];
      const socket =
        autoApprove === 'observer'
          ? await link(first, { roster: bob }, {})
          : await link(first, {}, { bob: 'observer' });
      socket.drop(1006);
      expect(first.dock.revoke('bob')).toBe(true);
      expect(JSON.parse(first.storage.getItem(REVOKED_KEY) ?? 'null')).toEqual({
        pageId: 'page-1',
        users: ['bob'],
      });
      first.core.close('unload');

      // The reload resumes the session before the revoke ever reached the relay.
      const reloaded = setup({ storage: first.storage, core: { policy } });
      const second = await link(
        reloaded,
        { resumed: true, resumeToken: 'resume-2', roster: bob },
        {},
      );
      expect(second.framesOf('revoke')).toEqual([{ t: 'revoke', userId: 'bob' }]);
      second.deliver(invoke('get_value', { caller: caller('bob', 'observer') }));
      await flush();
      expect(outcomes(second)).toEqual({ 'call-1': 'role_denied' });
      expect(reloaded.dock.setRole('bob', 'driver')).toBe(false);

      // Once the relay drops Bob, nothing is pending any more.
      second.deliver({ t: 'roster', attachments: [] });
      expect(reloaded.storage.getItem(REVOKED_KEY)).toBeNull();
    },
  );

  it('forgets a pending revoke when the next session is a new one', async () => {
    const first = setup();
    const socket = await link(first, {}, { bob: 'driver' });
    socket.drop(1006);
    expect(first.dock.revoke('bob')).toBe(true);
    first.core.close('unload');
    const reloaded = setup({ storage: first.storage });
    const second = await link(reloaded, { roster: [attachment('bob', 'driver')] }, {});
    expect(second.framesOf('revoke')).toEqual([]);
    expect(reloaded.storage.getItem(REVOKED_KEY)).toBeNull();
  });

  it('lets an approval after a revoke bring the user back', async () => {
    const h = setup();
    const socket = await link(h, {}, { bob: 'driver' });
    expect(h.dock.revoke('bob')).toBe(true);
    // Bob pairs again before the relay's next roster, and the operator lets him in.
    socket.deliver(attachRequest(h.clock, 'bob-again'));
    expect(h.dock.approve('bob-again', 'observer')).toBe(true);
    socket.deliver(invoke('get_value', { caller: caller('bob', 'observer') }));
    await flush();
    expect(outcomes(socket)).toEqual({ 'call-1': 'ok' });
  });
});

describe('pause', () => {
  it('answers every new call page_busy and says why, while running calls finish', async () => {
    const h = setup({ tools: queueTools() });
    const held = holdHandlers(h, ['set_value', 'get_value']);
    const socket = await link(h);
    socket.deliver(invoke('set_value', { callId: 'running-write' }));
    socket.deliver(invoke('get_value', { callId: 'running-read' }));
    socket.deliver(invoke('add_item', { callId: 'queued-write' }));
    await flush();

    h.dock.pause(true);
    expect(h.dock.state.paused).toBe(true);
    expect(h.storage.getItem(PAUSED_KEY)).not.toBeNull();
    expect(results(socket)).toEqual([
      {
        t: 'result',
        callId: 'queued-write',
        ok: false,
        error: {
          code: 'page_busy',
          message: 'the operator paused this page, so it runs no calls for now',
        },
      },
    ]);
    socket.deliver(invoke('get_value', { callId: 'new-read' }));
    await flush();
    await held.release('set_value');
    await held.release('get_value');
    expect(outcomes(socket)).toEqual({
      'queued-write': 'page_busy',
      'new-read': 'page_busy',
      'running-write': 'ok',
      'running-read': 'ok',
    });
    // Only the two calls the page already had ever ran.
    expect(h.context.runs.map((run) => run.tool).sort()).toEqual(['get_value', 'set_value']);
  });

  it('answers a call waiting on the operator page_busy and takes its prompt down', async () => {
    const h = setup();
    const socket = await link(h);
    socket.deliver(invoke('wipe'));
    await flush();
    expect(h.dock.state.pendingConfirms).toHaveLength(1);
    h.dock.pause(true);
    expect(h.dock.state.pendingConfirms).toEqual([]);
    expect(outcomes(socket)).toEqual({ 'call-1': 'page_busy' });
    expect(h.dock.confirm('call-1', true)).toBe(false);
    expect(h.context.runs).toHaveLength(0);
  });

  it('survives a reload, and only false resumes', async () => {
    const first = setup();
    await link(first);
    first.dock.pause(true);
    first.core.close('unload');

    const reloaded = setup({ storage: first.storage });
    expect(reloaded.dock.state.paused).toBe(true);
    const socket = await link(reloaded, { resumed: true, resumeToken: 'resume-2' });
    socket.deliver(invoke('get_value', { callId: 'while-paused' }));
    await flush();
    for (const notFalse of ['false', 0, undefined, null]) {
      reloaded.dock.pause(notFalse as never);
      expect(reloaded.dock.state.paused).toBe(true);
    }
    reloaded.dock.pause(false);
    expect(reloaded.dock.state.paused).toBe(false);
    expect(first.storage.getItem(PAUSED_KEY)).toBeNull();
    socket.deliver(invoke('get_value', { callId: 'resumed' }));
    await flush();
    expect(outcomes(socket)).toEqual({ 'while-paused': 'page_busy', resumed: 'ok' });
    expect(reloaded.logs).toContain('info the operator resumed calls');
  });

  it('pauses before any link exists and keeps working without storage', async () => {
    const h = setup({
      core: {
        storage: {
          getItem: () => {
            throw new Error('blocked');
          },
          setItem: () => {
            throw new Error('blocked');
          },
          removeItem: () => {
            throw new Error('blocked');
          },
        },
      },
    });
    expect(h.dock.state.paused).toBe(false);
    h.dock.pause(true);
    const socket = await link(h);
    socket.deliver(invoke('get_value'));
    await flush();
    expect(outcomes(socket)).toEqual({ 'call-1': 'page_busy' });
    expect(h.logs.some((line) => line.startsWith('warn could not store the pause'))).toBe(true);
  });
});

// A1.1 and A1.4 end to end: an MCP client pairs with a sim page by the code it
// shows, the page's operator answers, and the client lists the page, its tools
// and calls one. Then the three ways pairing fails, plus an operator who says
// nothing at all.

import { DEFAULT_SIM_ORIGIN } from '@tabdock/sim-page';
import { untrustedHeader } from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachAs,
  callTool,
  delay,
  errorCode,
  linked,
  listPages,
  pairingCode,
  pairThroughOperator,
  SIM_TOOL_COUNT,
  startWorld,
  waitForTools,
  type World,
} from './helpers.ts';

let world: World | undefined;
async function setup(options: Parameters<typeof startWorld>[0] = {}): Promise<World> {
  world = await startWorld(options);
  return world;
}
afterEach(async () => {
  await world?.close();
  world = undefined;
});

describe('A1.1: pair by code, approve, list and call', () => {
  it('runs the whole path and returns the page handler result under the untrusted header', async () => {
    const w = await setup();
    const sim = await w.page();
    const alice = await w.client(w.alice);

    const empty = await callTool(alice, 'list_pages');
    expect(empty.text).toMatch(/not attached to any page/);

    const code = await pairingCode(sim);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    const pending = callTool(alice, 'pair_page', { code });
    const prompted = await sim.waitFor((s) => s.pendingRequests.length > 0);
    const request = prompted.pendingRequests[0];
    expect(request?.user).toEqual({ userId: 'alice', displayName: 'Alice' });
    expect(request?.via).toBe('code');
    expect(sim.dock.approve(request?.requestId ?? '', 'driver')).toBe(true);

    const paired = await pending;
    expect(paired.isError, paired.text).toBe(false);
    const pageId = (await linked(sim)).pageId;
    expect(paired.structured).toEqual({ page: pageId, origin: DEFAULT_SIM_ORIGIN, role: 'driver' });
    await sim.waitFor((s) => s.roster.some((a) => a.userId === 'alice' && a.role === 'driver'));
    // Single use: the page already shows a different code.
    expect(sim.state.pairing?.code).not.toBe(code);

    const tools = await waitForTools(alice, pageId, SIM_TOOL_COUNT);
    expect(tools.text.split('\n', 1)[0]).toContain('untrusted');
    const listed = (tools.structured as { tools: { name: string; allowed: boolean }[] }).tools;
    expect(listed.map((t) => t.name).sort()).toEqual([
      'echo',
      'fail',
      'get_value',
      'set_value',
      'slow',
      'wipe',
    ]);
    expect(listed.every((t) => t.allowed)).toBe(true);

    expect(await listPages(alice)).toEqual([
      {
        page: pageId,
        origin: DEFAULT_SIM_ORIGIN,
        title: 'Sim page',
        role: 'driver',
        state: 'awake',
        toolCount: SIM_TOOL_COUNT,
      },
    ]);

    const argument = 'a value only the page handler should see';
    const set = await callTool(alice, 'call_page_tool', {
      page: pageId,
      tool: 'set_value',
      arguments: { value: argument },
    });
    expect(set.isError, set.text).toBe(false);
    expect(set.text).toBe(
      `${untrustedHeader(DEFAULT_SIM_ORIGIN, 'set_value')}\n${JSON.stringify({ value: argument })}`,
    );
    expect(set.structured).toEqual({ value: argument });
    expect(sim.store.value).toBe(argument);

    const got = await callTool(alice, 'call_page_tool', { page: pageId, tool: 'get_value' });
    expect(got.structured).toEqual({ value: argument });

    // A handler error comes back labelled too, as page content rather than a relay code.
    const failed = await callTool(alice, 'call_page_tool', {
      page: pageId,
      tool: 'fail',
      arguments: { message: 'nope' },
    });
    expect(failed.isError).toBe(true);
    expect(failed.text.split('\n', 1)[0]).toBe(untrustedHeader(DEFAULT_SIM_ORIGIN, 'fail'));

    // S7: every call is in the audit log with who, what and how, and never the arguments.
    const audit = w.relay.audit.records();
    expect(audit.map((r) => [r.userId, r.tool, r.outcome])).toEqual([
      ['alice', 'set_value', 'ok'],
      ['alice', 'get_value', 'ok'],
      ['alice', 'fail', 'tool_error'],
    ]);
    expect(JSON.stringify(audit)).not.toContain(argument);

    // S11: no token, code, resume token or argument reached either side's log.
    // The adapter keeps its resume token in the tab's sessionStorage under this key.
    const resumeToken = sim.storage.getItem(`tabdock:resume:${w.relay.pageUrl}`);
    expect(resumeToken).toBeTruthy();
    const logs = [...w.relayLogs, ...sim.logs].join('\n');
    const secrets = [w.alice.token, w.bob.token, code, code.replace('-', ''), argument];
    for (const secret of [...secrets, resumeToken ?? '']) expect(logs).not.toContain(secret);
  });
});

describe('A1.4: pairing that must fail', () => {
  it('a wrong code returns pairing_expired and reaches no operator', async () => {
    const w = await setup();
    const sim = await w.page();
    const alice = await w.client(w.alice);
    const code = await pairingCode(sim);
    const wrong = code.startsWith('ZZZZZ') ? '00000-00000' : 'ZZZZZ-ZZZZZ';

    const outcome = await callTool(alice, 'pair_page', { code: wrong });
    expect(errorCode(outcome), outcome.text).toBe('pairing_expired');
    expect(sim.state.pendingRequests).toEqual([]);
    expect(sim.state.pairing?.code).toBe(code);
    expect(await listPages(alice)).toEqual([]);
  });

  it('an expired code returns pairing_expired', async () => {
    const w = await setup({ timings: { pairingTtlMs: 300 } });
    const sim = await w.page();
    const alice = await w.client(w.alice);
    const code = await pairingCode(sim);
    // The relay rotates an expired code, so the page moves on to a new one.
    await sim.waitFor((s) => s.pairing !== null && s.pairing.code !== code, 3000);

    const outcome = await callTool(alice, 'pair_page', { code });
    expect(errorCode(outcome), outcome.text).toBe('pairing_expired');
    expect(sim.state.pendingRequests).toEqual([]);
  });

  it('a code works once: a second user with the same code gets pairing_expired', async () => {
    const w = await setup();
    const sim = await w.page();
    const code = await pairingCode(sim);
    await attachAs(await w.client(w.alice), sim, 'driver');

    const outcome = await callTool(await w.client(w.bob), 'pair_page', { code });
    expect(errorCode(outcome), outcome.text).toBe('pairing_expired');
  });

  it('a denied approval returns denied_by_operator and attaches nobody', async () => {
    const w = await setup();
    const sim = await w.page();
    const alice = await w.client(w.alice);

    const { outcome } = await pairThroughOperator(alice, sim, 'deny');
    expect(errorCode(outcome), outcome.text).toBe('denied_by_operator');
    expect(await listPages(alice)).toEqual([]);
    expect(sim.state.roster).toEqual([]);
    const pageId = (await linked(sim)).pageId;
    const call = await callTool(alice, 'call_page_tool', { page: pageId, tool: 'get_value' });
    expect(errorCode(call)).toBe('not_attached');
  });

  it('silence: pair_page stops waiting with timeout, and the request then expires as a denial', async () => {
    // Shorter than the request's life, as in production (50 s against 60 s, ADR 0005).
    const w = await setup({ timings: { pairWaitMs: 300, attachRequestTtlMs: 1200 } });
    const sim = await w.page();
    const alice = await w.client(w.alice);
    const code = await pairingCode(sim);

    const outcome = await callTool(alice, 'pair_page', { code });
    expect(errorCode(outcome), outcome.text).toBe('timeout');
    expect(outcome.text).toMatch(/stays open/);
    const open = sim.state.pendingRequests[0];
    expect(open?.user.userId).toBe('alice');

    // Nobody answers; at its deadline the page drops the prompt as a denial.
    await sim.waitFor((s) => s.pendingRequests.length === 0, 3000);
    expect(sim.dock.approve(open?.requestId ?? '', 'driver')).toBe(false);
    await delay(100);
    expect(await listPages(alice)).toEqual([]);
    expect(sim.state.roster).toEqual([]);
  });

  it('an approval after pair_page stopped waiting still attaches (ADR 0005)', async () => {
    const w = await setup({ timings: { pairWaitMs: 200, attachRequestTtlMs: 5000 } });
    const sim = await w.page();
    const alice = await w.client(w.alice);
    const code = await pairingCode(sim);

    const outcome = await callTool(alice, 'pair_page', { code });
    expect(errorCode(outcome)).toBe('timeout');
    const request = sim.state.pendingRequests[0];
    expect(sim.dock.approve(request?.requestId ?? '', 'observer')).toBe(true);
    await sim.waitFor((s) => s.roster.length === 1);
    const pages = await listPages(alice);
    expect(pages.map((p) => [p.page, p.role])).toEqual([[(await linked(sim)).pageId, 'observer']]);
  });
});

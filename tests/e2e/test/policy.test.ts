// Roles, page policy and isolation end to end: autoApprove observer, the
// relay's role check (S5), the on-page prompt for consequential tools (S6),
// one user never seeing another's pages (S13), and the origin checks on the
// page socket (S1, S2).

import { afterEach, describe, expect, it } from 'vitest';
import {
  attachAs,
  callTool,
  errorCode,
  linked,
  listPages,
  pairingCode,
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

describe('autoApprove observer and the relay role check', () => {
  it('attaches as observer without a prompt, and the relay refuses a mutating tool', async () => {
    world = await startWorld();
    const sim = await world.page({ policy: { autoApprove: 'observer' } });
    let prompts = 0;
    sim.dock.on('state', (state) => {
      prompts = Math.max(prompts, state.pendingRequests.length);
    });
    const alice = await world.client(world.alice);

    const paired = await callTool(alice, 'pair_page', { code: await pairingCode(sim) });
    expect(paired.isError, paired.text).toBe(false);
    const pageId = (paired.structured as { page: string; role: string }).page;
    expect(paired.structured).toMatchObject({ role: 'observer' });
    expect(prompts).toBe(0);

    const tools = await waitForTools(alice, pageId, SIM_TOOL_COUNT);
    const allowed = Object.fromEntries(
      (tools.structured as { tools: { name: string; allowed: boolean }[] }).tools.map((t) => [
        t.name,
        t.allowed,
      ]),
    );
    expect(allowed).toMatchObject({ get_value: true, set_value: false, wipe: false });

    const before = sim.store.calls.length;
    const refused = await callTool(alice, 'call_page_tool', {
      page: pageId,
      tool: 'set_value',
      arguments: { value: 'observer write' },
    });
    expect(errorCode(refused), refused.text).toBe('role_denied');
    // The relay's own wording: the call never left the relay.
    expect(refused.text).toMatch(/you are an observer on this page/);
    expect(sim.store.calls.length).toBe(before);
    expect(sim.store.value).toBeNull();

    const read = await callTool(alice, 'call_page_tool', { page: pageId, tool: 'get_value' });
    expect(read.isError, read.text).toBe(false);
    expect(world.relay.audit.records().map((r) => [r.tool, r.outcome])).toEqual([
      ['set_value', 'role_denied'],
      ['get_value', 'ok'],
    ]);
  });
});

describe('consequential tools', () => {
  it('prompt the operator on the page, and deny returns denied_by_operator', async () => {
    world = await startWorld();
    const sim = await world.page();
    const alice = await world.client(world.alice);
    const pageId = await attachAs(alice, sim, 'driver');
    await waitForTools(alice, pageId, SIM_TOOL_COUNT);
    await callTool(alice, 'call_page_tool', {
      page: pageId,
      tool: 'set_value',
      arguments: { value: 'keep me' },
    });

    const pending = callTool(alice, 'call_page_tool', { page: pageId, tool: 'wipe' });
    const prompted = await sim.waitFor((s) => s.pendingConfirms.length > 0);
    const confirm = prompted.pendingConfirms[0];
    expect(confirm?.tool).toBe('wipe');
    expect(confirm?.caller).toMatchObject({
      userId: 'alice',
      displayName: 'Alice',
      role: 'driver',
    });
    expect(sim.dock.confirm(confirm?.callId ?? '', false)).toBe(true);

    const denied = await pending;
    expect(errorCode(denied), denied.text).toBe('denied_by_operator');
    expect(sim.store.value).toBe('keep me');
    expect(sim.store.calls.some((c) => c.tool === 'wipe')).toBe(false);

    // The same prompt, allowed this time, runs the handler.
    const second = callTool(alice, 'call_page_tool', { page: pageId, tool: 'wipe' });
    const again = await sim.waitFor((s) => s.pendingConfirms.length > 0);
    expect(sim.dock.confirm(again.pendingConfirms[0]?.callId ?? '', true)).toBe(true);
    const allowed = await second;
    expect(allowed.isError, allowed.text).toBe(false);
    expect(allowed.structured).toEqual({ wiped: true });
    expect(sim.store.value).toBeNull();
  });

  it('an unanswered prompt is a denial, and the client hears denied_by_operator, not timeout', async () => {
    // A short page deadline; the relay keeps its default grace past it.
    world = await startWorld({ timings: { callDeadlineMs: 400 } });
    const sim = await world.page();
    const alice = await world.client(world.alice);
    const pageId = await attachAs(alice, sim, 'driver');
    await waitForTools(alice, pageId, SIM_TOOL_COUNT);
    await callTool(alice, 'call_page_tool', {
      page: pageId,
      tool: 'set_value',
      arguments: { value: 'keep me' },
    });

    const pending = callTool(alice, 'call_page_tool', { page: pageId, tool: 'wipe' });
    const prompted = await sim.waitFor((s) => s.pendingConfirms.length > 0);
    expect(prompted.pendingConfirms[0]?.tool).toBe('wipe');
    // Nobody answers the prompt.
    const denied = await pending;
    expect(errorCode(denied), denied.text).toBe('denied_by_operator');
    expect(sim.state.pendingConfirms).toEqual([]);
    expect(sim.store.calls.some((c) => c.tool === 'wipe')).toBe(false);
    expect(sim.store.value).toBe('keep me');
    expect(world.relay.audit.records().at(-1)).toMatchObject({
      tool: 'wipe',
      outcome: 'denied_by_operator',
    });
  });
});

describe('isolation between users (S13)', () => {
  it('two users on one relay see only their own pages, and a foreign page reads as unknown', async () => {
    world = await startWorld();
    const pageA = await world.page({ title: 'Page A' });
    const pageB = await world.page({ title: 'Page B' });
    const alice = await world.client(world.alice);
    const bob = await world.client(world.bob);
    const idA = await attachAs(alice, pageA, 'driver');
    const idB = await attachAs(bob, pageB, 'driver');

    expect((await listPages(alice)).map((p) => [p.page, p.title])).toEqual([[idA, 'Page A']]);
    expect((await listPages(bob)).map((p) => [p.page, p.title])).toEqual([[idB, 'Page B']]);

    const unknown = 'pg_0000000000';
    for (const page of [idB, unknown]) {
      const tools = await callTool(alice, 'list_page_tools', { page });
      const call = await callTool(alice, 'call_page_tool', { page, tool: 'get_value' });
      const detach = await callTool(alice, 'detach_page', { page });
      for (const outcome of [tools, call, detach]) {
        expect(errorCode(outcome), outcome.text).toBe('not_attached');
        // The same words for both, so a guessed id confirms nothing.
        expect(outcome.text).toBe(`not_attached: you are not attached to page ${page}`);
      }
    }
    expect(pageB.store.calls).toEqual([]);
    // Bob's attachment survived Alice's attempt to detach it.
    expect(await listPages(bob)).toHaveLength(1);
  });

  it('a second user on the same page needs their own approval', async () => {
    world = await startWorld();
    const sim = await world.page();
    const alice = await world.client(world.alice);
    const bob = await world.client(world.bob);
    const pageId = await attachAs(alice, sim, 'driver');

    expect(await listPages(bob)).toEqual([]);
    const call = await callTool(bob, 'call_page_tool', { page: pageId, tool: 'get_value' });
    expect(errorCode(call)).toBe('not_attached');

    await attachAs(bob, sim, 'observer');
    const roster = await sim.waitFor((s) => s.roster.length === 2);
    expect(roster.roster.map((a) => [a.userId, a.role]).sort()).toEqual([
      ['alice', 'driver'],
      ['bob', 'observer'],
    ]);
  });
});

describe('page socket origin checks (S1, S2)', () => {
  it('refuses a page from an origin outside the allowlist and one with no Origin header', async () => {
    world = await startWorld();
    for (const origin of ['https://evil.example', null]) {
      const sim = await world.page({ origin });
      await expect.poll(() => sim.lastSocketError).toMatch(/403/);
      expect(sim.state.link).not.toBe('linked');
      await sim.close();
    }
    const good = await world.page();
    expect((await linked(good)).pageId).toMatch(/^pg_/);
  });
});

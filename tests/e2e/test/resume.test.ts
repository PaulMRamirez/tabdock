// A1.3 end to end: a page that reloads inside the resume window comes back as
// the same page with its attachments, and one that stays away past the window
// is gone for good. The sim page reloads the way a browser does: the socket
// closes as going away, a fresh page boots on the same sessionStorage. Moving
// to another page of the site in that tab is not a reload (ADR 0011).

import { storageKey } from '@tabdock/adapter/core';
import { DEFAULT_SIM_ORIGIN } from '@tabdock/sim-page';
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

describe('A1.3: reload and the resume window', () => {
  it('a reload inside the window keeps the page id, the attachment and working calls', async () => {
    world = await startWorld();
    const sim = await world.page();
    const alice = await world.client(world.alice);
    const pageId = await attachAs(alice, sim, 'driver');
    await waitForTools(alice, pageId, SIM_TOOL_COUNT);
    const set = await callTool(alice, 'call_page_tool', {
      page: pageId,
      tool: 'set_value',
      arguments: { value: 'before reload' },
    });
    expect(set.isError, set.text).toBe(false);
    const tokenKey = storageKey('resume', world.relay.pageUrl, sim.url);
    const tokenBefore = sim.storage.getItem(tokenKey);

    // The tab is away for a moment: the relay sees it asleep and keeps the attachment.
    const reloading = sim.reload({ awayMs: 1000 });
    await eventually(async () => (await listPages(alice))[0]?.state === 'asleep');
    const asleep = await callTool(alice, 'call_page_tool', { page: pageId, tool: 'get_value' });
    expect(errorCode(asleep), asleep.text).toBe('page_asleep');
    await reloading;

    const state = await linked(sim);
    expect(state.pageId).toBe(pageId);
    expect(state.roster.map((a) => [a.userId, a.role])).toEqual([['alice', 'driver']]);
    expect(sim.logs).toContain(`info resumed page ${pageId}`);
    // Every welcome rotates the token, so a copied token works at most once.
    expect(sim.storage.getItem(tokenKey)).not.toBe(tokenBefore);

    await waitForTools(alice, pageId, SIM_TOOL_COUNT);
    expect(await listPages(alice)).toMatchObject([
      { page: pageId, state: 'awake', role: 'driver' },
    ]);
    const got = await callTool(alice, 'call_page_tool', { page: pageId, tool: 'get_value' });
    expect(got.isError, got.text).toBe(false);
    expect(got.structured).toEqual({ value: 'before reload' });
  });

  it('a plain reload with no pause also resumes', async () => {
    world = await startWorld();
    const sim = await world.page();
    const alice = await world.client(world.alice);
    const pageId = await attachAs(alice, sim, 'observer');

    await sim.reload();
    expect((await linked(sim)).pageId).toBe(pageId);
    await waitForTools(alice, pageId, SIM_TOOL_COUNT);
    const got = await callTool(alice, 'call_page_tool', { page: pageId, tool: 'get_value' });
    expect(got.isError, got.text).toBe(false);
  });

  it('a page away for longer than the window is gone, and comes back as a new page', async () => {
    world = await startWorld({ timings: { resumeWindowMs: 200 } });
    const sim = await world.page();
    const alice = await world.client(world.alice);
    const pageId = await attachAs(alice, sim, 'driver');

    await sim.reload({ awayMs: 800 });
    const state = await linked(sim);
    expect(state.pageId).not.toBe(pageId);
    expect(state.roster).toEqual([]);
    expect(sim.logs).toContain(`info linked as page ${state.pageId}`);

    // The old page is remembered only as gone, so the caller learns what happened.
    expect(await listPages(alice)).toEqual([
      expect.objectContaining({ page: pageId, state: 'gone', toolCount: 0 }),
    ]);
    const old = await callTool(alice, 'call_page_tool', { page: pageId, tool: 'get_value' });
    expect(errorCode(old), old.text).toBe('page_gone');
    // The new page has no attachments; Alice must pair again.
    const fresh = await callTool(alice, 'call_page_tool', {
      page: state.pageId,
      tool: 'get_value',
    });
    expect(errorCode(fresh), fresh.text).toBe('not_attached');
  });
});

describe('ADR 0011: one approval covers one page', () => {
  it("a reload of the same path resumes; another path of the origin in the tab pairs afresh, even with the first page's token", async () => {
    world = await startWorld();
    const sim = await world.page({ path: '/board', title: 'Board' });
    const alice = await world.client(world.alice);
    const boardId = await attachAs(alice, sim, 'driver');
    await waitForTools(alice, boardId, SIM_TOOL_COUNT);

    await sim.reload();
    const reloaded = await linked(sim);
    expect(reloaded.pageId).toBe(boardId);
    expect(reloaded.roster.map((a) => [a.userId, a.role])).toEqual([['alice', 'driver']]);

    // The operator moves to the settings page in the same tab: a new session, nobody attached.
    await sim.navigate('/settings');
    const settings = await linked(sim);
    expect(settings.pageId).not.toBe(boardId);
    expect(settings.roster).toEqual([]);
    expect(sim.logs).toContain(`info linked as page ${settings.pageId}`);
    const refused = await callTool(alice, 'call_page_tool', {
      page: settings.pageId,
      tool: 'get_value',
    });
    expect(errorCode(refused), refused.text).toBe('not_attached');
    expect(await listPages(alice)).toMatchObject([
      { page: boardId, state: 'asleep', role: 'driver' },
    ]);

    // A script on the settings page, or an older adapter, presents the board's token.
    const boardToken = sim.storage.getItem(
      storageKey('resume', world.relay.pageUrl, `${DEFAULT_SIM_ORIGIN}/board`),
    );
    if (boardToken === null) throw new Error('the board kept no resume token');
    sim.storage.setItem(storageKey('resume', world.relay.pageUrl, sim.url), boardToken);
    await sim.reload();
    const presented = await linked(sim);
    expect(presented.pageId).not.toBe(boardId);
    expect(presented.pageId).not.toBe(settings.pageId);
    expect(presented.roster).toEqual([]);
    expect(sim.logs).toContain(`info linked as page ${presented.pageId}`);
    expect(world.relayLogs.filter((line) => line.includes('resume refused'))).toEqual([
      expect.stringContaining('different page'),
    ]);
    expect(world.relayLogs.join('\n')).not.toContain(boardToken);

    // The board's session was left asleep, so going back to it resumes with Alice attached.
    await sim.navigate('/board');
    const back = await linked(sim);
    expect(back.pageId).toBe(boardId);
    expect(back.roster.map((a) => [a.userId, a.role])).toEqual([['alice', 'driver']]);
    await waitForTools(alice, boardId, SIM_TOOL_COUNT);
    const got = await callTool(alice, 'call_page_tool', { page: boardId, tool: 'get_value' });
    expect(got.isError, got.text).toBe(false);
  });
});

// The same calls through each WebMCP runtime the M0 baseline measured: the
// MCP-B polyfill 5.1 (string input, no consequentialHint), Chrome 153 and 154
// (string input, string schemas) and Chrome 155 and 156 (object input). The
// adapter detects the input form per page (ADR 0001) and applies ADR 0002's
// option C, so a client sees the same results from all three.

import { DEFAULT_SIM_ORIGIN, RUNTIME_PROFILES } from '@tabdock/sim-page';
import { untrustedHeader } from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachAs,
  callTool,
  errorCode,
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

describe.each(RUNTIME_PROFILES)('runtime %s', (profile) => {
  it('lists object schemas and returns the handler results for calls', async () => {
    world = await startWorld();
    const sim = await world.page({ profile, policy: { consequentialTools: ['wipe'] } });
    const alice = await world.client(world.alice);
    const pageId = await attachAs(alice, sim, 'driver');

    const tools = await waitForTools(alice, pageId, SIM_TOOL_COUNT);
    const setValue = (
      tools.structured as { tools: { name: string; inputSchema: unknown }[] }
    ).tools.find((t) => t.name === 'set_value');
    // Chrome 153 and 154 hand the adapter a JSON string; clients always get an object.
    expect(setValue?.inputSchema).toMatchObject({ type: 'object', required: ['value'] });

    const set = await callTool(alice, 'call_page_tool', {
      page: pageId,
      tool: 'set_value',
      arguments: { value: `set on ${profile}` },
    });
    expect(set.isError, set.text).toBe(false);
    expect(set.structured).toEqual({ value: `set on ${profile}` });

    const nested = { list: [1, 'two', { three: true }], text: 'quotes " and \\ survive' };
    const echo = await callTool(alice, 'call_page_tool', {
      page: pageId,
      tool: 'echo',
      arguments: nested,
    });
    expect(echo.text).toBe(
      `${untrustedHeader(DEFAULT_SIM_ORIGIN, 'echo')}\n${JSON.stringify(nested)}`,
    );
    expect(echo.structured).toEqual(nested);
    // Each handler ran once: the input-form probe never runs a handler twice.
    expect(sim.store.calls.map((c) => c.tool)).toEqual(['set_value', 'echo']);
  });
});

describe('the polyfill without a consequentialTools list (ADR 0002 option C)', () => {
  it('treats every mutating tool as consequential and says how to fix it', async () => {
    world = await startWorld();
    const sim = await world.page({
      profile: 'polyfill-5.1',
      operator: { askAttach: () => 'driver', askConfirm: () => false },
    });
    const alice = await world.client(world.alice);
    const paired = await callTool(alice, 'pair_page', {
      code: (await sim.waitFor((s) => s.pairing !== null)).pairing?.code,
    });
    expect(paired.isError, paired.text).toBe(false);
    const pageId = (paired.structured as { page: string }).page;
    await waitForTools(alice, pageId, SIM_TOOL_COUNT);
    expect(sim.state.notice).toMatch(/consequentialTools/);

    const set = await callTool(alice, 'call_page_tool', {
      page: pageId,
      tool: 'set_value',
      arguments: { value: 'needs a yes' },
    });
    expect(errorCode(set), set.text).toBe('denied_by_operator');
    expect(sim.store.value).toBeNull();

    const read = await callTool(alice, 'call_page_tool', { page: pageId, tool: 'get_value' });
    expect(read.isError, read.text).toBe(false);
  });
});

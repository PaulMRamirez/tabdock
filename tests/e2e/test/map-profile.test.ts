// A6.1, the map profile on the sim page through the real relay (ADR 0038),
// on both MCP revisions: every profile tool answers labelled text that
// parses with its schema, never structured content (S10); walking every
// stop and observation lands where each says; arguments outside the
// profile's bounds are refused before the page sees them; MAP_PAGE_POLICY
// prompts for reset_edits alone on every runtime, MCP-B 6 included, while an
// empty list still fails safe (S6, ADR 0034), and a write the page refuses
// ends as a labelled tool_error on each; an observer reads everything and writes
// nothing (S5); each first-class entry carries its description whole; and the
// state the page publishes holds what get_view and get_clock answer, read
// through get_page_state (ADR 0040).

import type { Client } from '@modelcontextprotocol/client';
import { MAX_FIRST_CLASS_DESCRIPTION_CHARS, untrustedHeader } from '@tabdock/protocol';
import {
  ALL_RUNTIME_PROFILES,
  DEFAULT_SIM_ORIGIN,
  HANDLER_FAILED_TEXT,
  MCPB6_FAILED_TEXT,
  type MapSimPage,
} from '@tabdock/sim-page';
import {
  CaptureTextSchema,
  GLOBE,
  MAP_EDIT_TOOLS,
  MAP_PROFILE_TOOLS,
  MAP_RESULT_SCHEMAS,
  type MapPageState,
  MapPageStateSchema,
  type MapStopView,
  type MapView,
} from '@tabdock/sim-page/map';
import { afterEach, describe, expect, it } from 'vitest';
import { firstClassDescription } from '../../../packages/relay/src/first-class.ts';
import { readPageState, stateBody, waitPageState } from '../src/state-helpers.ts';
import {
  attachAs,
  callTool,
  errorCode,
  startWorld,
  type ToolOutcome,
  waitForTools,
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

const ALL_TOOLS = [...MAP_PROFILE_TOOLS, ...MAP_EDIT_TOOLS];
const READS: readonly string[] = MAP_PROFILE_TOOLS.filter((tool) => tool.readOnly).map(
  (tool) => tool.name,
);
const PROFILE_WRITES = MAP_PROFILE_TOOLS.filter((tool) => !tool.readOnly).map((tool) => tool.name);

/** Arguments for each tool that the Moon fixture accepts. */
const ARGS: Record<string, Record<string, unknown>> = {
  get_view: {},
  set_view: { lon: 12.5, lat: -3.25, widthM: 750_000 },
  capture_view: { maxWidthPx: 512 },
  get_clock: {},
  set_clock: { time: '2026-01-01T06:30:00Z', rate: 120 },
  list_layers: {},
  set_layer: { id: 'names', visible: false },
  features_in_view: { limit: 3 },
  list_walkthroughs: {},
  get_stop: { walkthroughId: 'flyby', index: 2 },
  go_to_stop: { walkthroughId: 'maria', index: 1 },
  list_observations: { from: '2026-01-01T03:00:00Z' },
  get_observation: { id: 'obs-3' },
  view_from_observation: { id: 'obs-4' },
  edit_stop: { walkthroughId: 'maria', index: 0, text: 'Edited caption.' },
  reset_edits: {},
};

async function driver(
  w: World,
  modern: boolean,
  options: Parameters<World['mapPage']>[0] = {},
): Promise<{ sim: MapSimPage; alice: Client; pageId: string }> {
  const sim = await w.mapPage(options);
  const alice = await w.client(w.alice, 'alice-laptop', { modern });
  const pageId = await attachAs(alice, sim, 'driver');
  await waitForTools(alice, pageId, (await sim.context.getTools()).length);
  return { sim, alice, pageId };
}

function call(
  client: Client,
  pageId: string,
  tool: string,
  args: Record<string, unknown> = ARGS[tool] ?? {},
): Promise<ToolOutcome> {
  return callTool(client, 'call_page_tool', { page: pageId, tool, arguments: args });
}

function body<T>(outcome: ToolOutcome, schema: { parse(value: unknown): T }): T {
  expect(outcome.isError, outcome.text).toBe(false);
  return schema.parse(outcome.structured);
}

/** Angles within 1e-6 degrees and metres within a relative 1e-6, as ADR 0041's walk asks. */
function expectSameView(view: MapView, stop: MapStopView): void {
  const fields: Partial<MapView> = { ...view };
  delete fields.profile;
  delete fields.bounds;
  expect(Object.keys(fields).sort()).toEqual(Object.keys(stop).sort());
  expect(fields.body).toBe(stop.body);
  expect(fields.projection).toBe(stop.projection);
  for (const key of ['lon', 'lat', 'headingDeg', 'pitchDeg', 'fovDeg'] as const) {
    expect(Math.abs((fields[key] ?? 0) - (stop[key] ?? 0)), key).toBeLessThanOrEqual(1e-6);
  }
  for (const key of ['widthM', 'altitudeM'] as const) {
    const a = fields[key] ?? 0;
    const b = stop[key] ?? 0;
    expect(Math.abs(a - b), key).toBeLessThanOrEqual(1e-6 * Math.max(Math.abs(a), Math.abs(b), 1));
  }
}

describe('a member driver on a map page', () => {
  it.each(ERAS)(
    '1. calls every profile tool, each answer labelled text that parses with its schema and no structured content (%s)',
    async (_label, modern) => {
      world = await startWorld();
      const { alice, pageId } = await driver(world, modern);
      for (const { name } of MAP_PROFILE_TOOLS) {
        const result = await alice.callTool({
          name: 'call_page_tool',
          arguments: { page: pageId, tool: name, arguments: ARGS[name] },
        });
        expect(result.isError ?? false, name).toBe(false);
        // Page text travels only behind the label, never as structured content (S10).
        expect(result.structuredContent, name).toBeUndefined();
        expect(result.content, name).toHaveLength(1);
        const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
        const [label, ...rest] = text.split('\n');
        expect(label, name).toBe(untrustedHeader(DEFAULT_SIM_ORIGIN, name));
        const parsed = MAP_RESULT_SCHEMAS[name].safeParse(JSON.parse(rest.join('\n')));
        expect(parsed.error?.issues ?? [], name).toEqual([]);
      }
    },
  );

  it.each(ERAS)(
    "2. walks every stop and every observation, landing on each stop's view and each photo's viewpoint (%s)",
    async (_label, modern) => {
      world = await startWorld();
      const { sim, alice, pageId } = await driver(world, modern);
      const listed = body(
        await call(alice, pageId, 'list_walkthroughs'),
        MAP_RESULT_SCHEMAS.list_walkthroughs,
      );
      let stops = 0;
      for (const walkthrough of listed.walkthroughs) {
        for (let index = 0; index < walkthrough.stopCount; index += 1) {
          const moved = body(
            await call(alice, pageId, 'go_to_stop', { walkthroughId: walkthrough.id, index }),
            MAP_RESULT_SCHEMAS.go_to_stop,
          );
          const view = body(await call(alice, pageId, 'get_view'), MAP_RESULT_SCHEMAS.get_view);
          const stop = body(await call(alice, pageId, 'get_stop', {}), MAP_RESULT_SCHEMAS.get_stop);
          expect([stop.walkthroughId, stop.index]).toEqual([walkthrough.id, index]);
          expectSameView(view, stop.view);
          expect(moved.view).toEqual(view);
          expect(moved.observationId).toBe(stop.observationId);
          if (stop.clock) {
            const clock = body(
              await call(alice, pageId, 'get_clock'),
              MAP_RESULT_SCHEMAS.get_clock,
            );
            expect(clock).toMatchObject(stop.clock);
          }
          // The page's own state agrees with what the tools said.
          expect(sim.world.state()).toMatchObject({
            view,
            walkthrough: { id: walkthrough.id, stopIndex: index },
            observationId: stop.observationId,
          });
          stops += 1;
        }
      }
      expect(stops).toBe(7);

      const found = body(
        await call(alice, pageId, 'list_observations', {}),
        MAP_RESULT_SCHEMAS.list_observations,
      );
      expect(found.observations.map((observation) => observation.id)).toEqual([
        'obs-1',
        'obs-2',
        'obs-3',
        'obs-4',
      ]);
      for (const { id } of found.observations) {
        const moved = body(
          await call(alice, pageId, 'view_from_observation', { id }),
          MAP_RESULT_SCHEMAS.view_from_observation,
        );
        const view = body(await call(alice, pageId, 'get_view'), MAP_RESULT_SCHEMAS.get_view);
        const observation = body(
          await call(alice, pageId, 'get_observation', { id }),
          MAP_RESULT_SCHEMAS.get_observation,
        );
        expect(moved).toEqual({ observationId: id, view });
        expect(observation.onScreen).toBe(true);
        const { viewpoint } = observation;
        expect(view.projection).toBe(GLOBE);
        expectSameView(view, {
          ...viewpoint,
          projection: GLOBE,
          widthM: view.widthM,
        });
      }
    },
  );

  it.each(ERAS)(
    '3. is refused arguments outside the profile before the page sees them, and by the page past what the relay checks (%s)',
    async (_label, modern) => {
      world = await startWorld();
      const { sim, alice, pageId } = await driver(world, modern);
      sim.world.calls.length = 0;
      for (const args of [{ lat: 95 }, { headingDeg: 360 }, {}, { lat: 1, zoom: 2 }]) {
        const refused = await call(alice, pageId, 'set_view', args);
        expect(errorCode(refused), refused.text).toBe('invalid_arguments');
      }
      const tooWide = await call(alice, pageId, 'capture_view', { maxWidthPx: 4096 });
      expect(errorCode(tooWide), tooWide.text).toBe('invalid_arguments');
      expect(sim.world.calls).toEqual([]);
      expect(sim.world.view().lat).toBe(0);

      // The relay's advisory check drops pattern and format (ADR 0010), so
      // these reach the page, whose own check refuses them.
      for (const [tool, args] of [
        ['get_observation', { id: 'obs 1' }],
        ['set_clock', { time: '2026-01-01T06:00:00' }],
      ] as const) {
        const refused = await call(alice, pageId, tool, args);
        // A tool_error carries the page's words, so it arrives behind the label.
        expect(refused.isError, refused.text).toBe(true);
        expect(refused.text.split('\n', 1)[0]).toBe(untrustedHeader(DEFAULT_SIM_ORIGIN, tool));
      }
      expect(sim.world.calls.map((entry) => entry.tool)).toEqual(['get_observation', 'set_clock']);
    },
  );
});

describe('the map page policy on every runtime (S6, ADR 0034)', () => {
  const writes = [...PROFILE_WRITES, 'edit_stop'];

  // MCP-B 6 included: npm's latest since 8 October, which a copier of the
  // map page or of guide page 16 installs (ADR 0047).
  it.each(
    ALL_RUNTIME_PROFILES.flatMap((profile) =>
      ERAS.map(([label, modern]) => [profile, label, modern] as const),
    ),
  )(
    '4. MAP_PAGE_POLICY prompts for reset_edits alone on %s (%s)',
    async (profile, _label, modern) => {
      world = await startWorld();
      const { sim, alice, pageId } = await driver(world, modern, { profile });
      for (const name of writes) {
        const outcome = await call(alice, pageId, name);
        expect(outcome.isError, `${name}: ${outcome.text}`).toBe(false);
      }
      // A write the page's handler refuses, which the relay's advisory check
      // lets through, ends as a tool_error behind the label on every runtime;
      // only the polyfill 5.1 passes the handler's words on (guide page 16).
      const refused = await call(alice, pageId, 'set_clock', { time: '2026-01-01T06:00:00' });
      expect(refused.isError, refused.text).toBe(true);
      const [label, ...words] = refused.text.split('\n');
      expect(label).toBe(untrustedHeader(DEFAULT_SIM_ORIGIN, 'set_clock'));
      expect(words.join('\n')).toContain(
        profile === 'mcpb-6' ? MCPB6_FAILED_TEXT : HANDLER_FAILED_TEXT,
      );
      expect(refused.text.includes('refused its arguments')).toBe(profile === 'polyfill-5.1');
      expect(sim.prompts).toEqual([]);
      expect(sim.state.notice).toBeNull();

      const pending = call(alice, pageId, 'reset_edits');
      const state = await sim.waitFor((s) => s.pendingConfirms.length > 0);
      const prompt = state.pendingConfirms[0];
      expect(prompt?.tool).toBe('reset_edits');
      expect(sim.dock.confirm(prompt?.callId ?? '', false)).toBe(true);
      const denied = await pending;
      expect(errorCode(denied), denied.text).toBe('denied_by_operator');
      expect(sim.prompts.map((asked) => asked.tool)).toEqual(['reset_edits']);
      // The edit stands, since the reset never ran.
      expect(sim.world.stop('maria', 0).text).toBe('Edited caption.');
    },
  );

  it.each(ERAS)(
    '4. an empty list on the polyfill 5.1 still prompts for every write and says why, and allow with no consequential tool prompts for none (%s)',
    async (_label, modern) => {
      world = await startWorld();
      const empty = await driver(world, modern, {
        profile: 'polyfill-5.1',
        policy: { consequentialTools: [] },
      });
      expect(empty.sim.state.notice).not.toBeNull();
      // Every write, the profile's five and both editing tools, so a fallback narrowed to some writes fails here.
      const everyWrite = [...PROFILE_WRITES, 'edit_stop', 'reset_edits'];
      for (const name of everyWrite) {
        const pending = call(empty.alice, empty.pageId, name);
        // Whichever comes first: a write that runs unprompted answers before any prompt shows.
        const first = await Promise.race([
          pending.then(() => 'answered' as const),
          empty.sim
            .waitFor((s) => s.pendingConfirms.some((asked) => asked.tool === name))
            .then(
              () => 'prompted' as const,
              () => 'answered' as const,
            ),
        ]);
        expect(first, `${name} prompts before it runs`).toBe('prompted');
        const prompt = empty.sim.state.pendingConfirms.find((asked) => asked.tool === name);
        expect(empty.sim.dock.confirm(prompt?.callId ?? '', false), name).toBe(true);
        const denied = await pending;
        expect(errorCode(denied), `${name}: ${denied.text}`).toBe('denied_by_operator');
      }
      expect(empty.sim.prompts.map((asked) => asked.tool)).toEqual(everyWrite);
      // No denied write reached the page's handlers.
      expect(empty.sim.world.calls).toEqual([]);
      await empty.sim.close();

      const allow = await world.mapPage({
        profile: 'polyfill-5.1',
        policy: { consequential: 'allow' },
        editTools: false,
      });
      const bob = await world.client(world.bob, 'bob-laptop', { modern });
      const pageId = await attachAs(bob, allow, 'driver');
      await waitForTools(bob, pageId, MAP_PROFILE_TOOLS.length);
      for (const name of PROFILE_WRITES) {
        const outcome = await call(bob, pageId, name);
        expect(outcome.isError, `${name}: ${outcome.text}`).toBe(false);
      }
      expect(allow.prompts).toEqual([]);
      expect(allow.state.notice).toBeNull();
    },
  );
});

describe('an observer on a map page (S5)', () => {
  it.each(ERAS)(
    '5. reads every profile tool and is refused every write (%s)',
    async (_label, modern) => {
      world = await startWorld();
      const sim = await world.mapPage();
      const bob = await world.client(world.bob, 'bob-laptop', { modern });
      const pageId = await attachAs(bob, sim, 'observer');
      await waitForTools(bob, pageId, ALL_TOOLS.length);
      for (const name of READS) {
        const outcome = await call(bob, pageId, name);
        expect(outcome.isError, `${name}: ${outcome.text}`).toBe(false);
      }
      const before = JSON.stringify(sim.world.state());
      for (const name of [...PROFILE_WRITES, 'edit_stop', 'reset_edits']) {
        const outcome = await call(bob, pageId, name);
        expect(errorCode(outcome), `${name}: ${outcome.text}`).toBe('role_denied');
      }
      expect(JSON.stringify(sim.world.state())).toBe(before);
      // No write reached the page's handlers.
      expect(sim.world.calls.filter((entry) => !READS.includes(entry.tool))).toEqual([]);
      expect(sim.prompts).toEqual([]);
    },
  );
});

describe('first-class map tools (ADR 0025)', () => {
  it.each(ERAS)(
    '6. lists all sixteen by name with every description whole (%s)',
    async (_label, modern) => {
      world = await startWorld({ firstClassTools: true });
      const { sim, alice, pageId } = await driver(world, modern);
      const listed = (await alice.listTools()).tools;
      for (const tool of ALL_TOOLS) {
        const entry = listed.find((candidate) => candidate.name === `${pageId}__${tool.name}`);
        expect(entry, tool.name).toBeDefined();
        expect(entry?.description?.endsWith(JSON.stringify(tool.description)), tool.name).toBe(
          true,
        );
      }
      // A first-class call reaches the same handler.
      const view = await callTool(alice, `${pageId}__get_view`);
      expect(view.isError, view.text).toBe(false);
      expect(view.structured).toEqual(sim.world.view());

      // Even with an origin as long as a first-class entry keeps, nothing is cut.
      const origin = `https://${'o'.repeat(100)}.example`;
      for (const tool of ALL_TOOLS) {
        const description = firstClassDescription(pageId, origin, {
          name: tool.name,
          description: tool.description,
          inputSchema: { type: 'object' },
        });
        expect(description.length, tool.name).toBeLessThanOrEqual(
          MAX_FIRST_CLASS_DESCRIPTION_CHARS,
        );
        expect(description.endsWith(JSON.stringify(tool.description)), tool.name).toBe(true);
      }
    },
  );
});

/**
 * The page's state as the relay holds it, read with get_page_state and then
 * waited on until `wanted` holds of it, for up to 5 s: the adapter sends at
 * most one state frame each 500 ms, so a write's state can trail its result.
 */
async function publishedState(
  client: Client,
  pageId: string,
  wanted: (state: MapPageState) => boolean,
): Promise<{ version: number; state: MapPageState }> {
  const deadline = Date.now() + 5_000;
  let body = stateBody(await readPageState(client, pageId));
  for (;;) {
    const parsed = MapPageStateSchema.safeParse(body.value);
    if (parsed.success && wanted(parsed.data)) return { version: body.version, state: parsed.data };
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`the page published no such state; version ${body.version}`);
    body = stateBody(await waitPageState(client, pageId, body.version, Math.min(left, 2_000)));
  }
}

describe('the state a map page publishes (ADR 0040)', () => {
  it.each(ERAS)(
    '7. holds the view and clock get_view and get_clock return, read alike through get_page_state (%s)',
    async (_label, modern) => {
      world = await startWorld();
      const { sim, alice, pageId } = await driver(world, modern);
      // Published as soon as the page links, before any write.
      const first = await publishedState(alice, pageId, () => true);
      expect(first.state).toEqual(sim.world.state());

      body(
        await call(alice, pageId, 'go_to_stop', { walkthroughId: 'flyby', index: 2 }),
        MAP_RESULT_SCHEMAS.go_to_stop,
      );
      const view = body(await call(alice, pageId, 'get_view'), MAP_RESULT_SCHEMAS.get_view);
      const clock = body(await call(alice, pageId, 'get_clock'), MAP_RESULT_SCHEMAS.get_clock);
      const state = sim.world.state();
      expect(state.view).toEqual(view);
      expect(state.clock).toEqual(clock);
      expect(state.walkthrough).toEqual({ id: 'flyby', stopIndex: 2 });
      expect(state.observationId).toBe('obs-3');

      // The same comparison through the relay, in the profile's own shape.
      const atStop = await publishedState(
        alice,
        pageId,
        (published) => published.walkthrough?.stopIndex === 2,
      );
      expect(atStop.version).toBeGreaterThan(first.version);
      expect(atStop.state.view).toEqual(view);
      expect(atStop.state.clock).toEqual(clock);
      expect(atStop.state).toEqual(state);

      // A reload is a new document, which publishes the world again.
      await sim.reload();
      await sim.waitFor((dock) => dock.link === 'linked');
      await waitForTools(alice, pageId, (await sim.context.getTools()).length);
      const reloaded = await publishedState(alice, pageId, () => true);
      expect(reloaded.version).toBeGreaterThan(atStop.version);
      expect(reloaded.state).toEqual(state);
    },
    30_000,
  );
});

describe('capture_view without a capture function', () => {
  it('answers its text form, as a page that returns no images does', async () => {
    world = await startWorld();
    const { alice, pageId } = await driver(world, true);
    const text = CaptureTextSchema.parse((await call(alice, pageId, 'capture_view')).structured);
    expect(text.view.profile).toBe('tabdock.map.v1');
    expect(text.description).toMatch(/^A equirectangular view of moon/);
  });
});

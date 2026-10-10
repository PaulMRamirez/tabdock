// The map profile's worked example on its own, with no relay (ADR 0038): the
// tools a page registers, their descriptions and schemas, what each returns
// on every measured runtime, and that a handler refuses for itself what its
// schema refuses, since the relay's check is advisory and drops pattern and
// format. A world filled to every cap still answers within what the relay
// returns uncut.

import { MAX_RESULT_CHARS } from '@tabdock/protocol';
import { describe, expect, it } from 'vitest';
import {
  CaptureEnvelopeSchema,
  CaptureImageTextSchema,
  CaptureTextSchema,
  createMapEditTools,
  createMapTools,
  createMapWorld,
  GLOBE,
  MAP_DEFAULT_FEATURES,
  MAP_EDIT_TOOLS,
  MAP_MAX_DESCRIPTION_CHARS,
  MAP_MAX_FEATURES,
  MAP_MAX_FOOTPRINT_POSITIONS,
  MAP_MAX_ID_CHARS,
  MAP_MAX_KIND_CHARS,
  MAP_MAX_LAYERS,
  MAP_MAX_NOTE_CHARS,
  MAP_MAX_NOTES,
  MAP_MAX_OBSERVATIONS,
  MAP_MAX_STOPS,
  MAP_MAX_TEXT_CHARS,
  MAP_MAX_TITLE_CHARS,
  MAP_MAX_URL_CHARS,
  MAP_MAX_WALKTHROUGHS,
  MAP_PAGE_POLICY,
  MAP_PROFILE,
  MAP_PROFILE_TOOLS,
  MAP_RESULT_SCHEMAS,
  type MapCapture,
  mapAnnotations,
  mapInputs,
  type MapToolDefinition,
  MapWorld,
  type MapWorldData,
  moonWorldData,
  toInputSchema,
  widthFromAltitude,
} from '../src/map/index.ts';
import { FakeModelContext, RUNTIME_PROFILES, type RuntimeProfile } from '../src/index.ts';

const STOPS = { maria: 3, flyby: 4 };
const OBSERVATIONS = ['obs-1', 'obs-2', 'obs-3', 'obs-4'];

/** Arguments that every runtime accepts for each tool, against the Moon fixture. */
const VALID_ARGS: Record<string, Record<string, unknown>> = {
  get_view: {},
  set_view: { lon: 10, lat: 5 },
  capture_view: {},
  get_clock: {},
  set_clock: { time: '2026-01-01T06:00:00Z' },
  list_layers: {},
  set_layer: { id: 'elevation', visible: true },
  features_in_view: { limit: 5 },
  list_walkthroughs: {},
  get_stop: { walkthroughId: 'maria', index: 1 },
  go_to_stop: { walkthroughId: 'flyby', index: 2 },
  list_observations: { walkthroughId: 'flyby' },
  get_observation: { id: 'obs-3' },
  view_from_observation: { id: 'obs-2' },
  edit_stop: { walkthroughId: 'maria', index: 0, title: 'Tranquility' },
  reset_edits: {},
};

function toolsOf(world: MapWorld, capture?: MapCapture): MapToolDefinition[] {
  return [...createMapTools(world, { capture }), ...createMapEditTools(world)];
}

function byName(tools: MapToolDefinition[], name: string): MapToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

function call(tools: MapToolDefinition[], name: string, args: unknown): Promise<unknown> {
  return Promise.resolve(
    byName(tools, name).execute(args, { signal: new AbortController().signal }),
  );
}

/** The input form each runtime takes: a JSON string on the polyfill 5.1 and Chrome 154, an object elsewhere. */
function inputFor(profile: RuntimeProfile, args: Record<string, unknown>): unknown {
  return profile === 'polyfill-5.1' || profile === 'chrome-154' ? JSON.stringify(args) : args;
}

describe('the tools a map page registers', () => {
  it('(a) are the profile fourteen in the table order, then the two editing tools, with their titles, annotations and schemas', () => {
    const world = createMapWorld();
    const tools = createMapTools(world);
    expect(tools.map((tool) => tool.name)).toEqual(MAP_PROFILE_TOOLS.map((tool) => tool.name));
    expect(tools.map((tool) => tool.name)).toEqual([
      'get_view',
      'set_view',
      'capture_view',
      'get_clock',
      'set_clock',
      'list_layers',
      'set_layer',
      'features_in_view',
      'list_walkthroughs',
      'get_stop',
      'go_to_stop',
      'list_observations',
      'get_observation',
      'view_from_observation',
    ]);
    const inputs = mapInputs({ bodies: world.bodies, projections: world.projections });
    const all = toolsOf(world);
    for (const [index, meta] of [...MAP_PROFILE_TOOLS, ...MAP_EDIT_TOOLS].entries()) {
      const tool = all[index];
      expect(tool?.name).toBe(meta.name);
      expect(tool?.title).toBe(meta.title);
      expect(tool?.description).toBe(meta.description);
      expect(tool?.annotations).toEqual(mapAnnotations(meta));
      expect(tool?.inputSchema).toEqual(toInputSchema(inputs[meta.name]));
      expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(tool?.inputSchema).not.toHaveProperty('$schema');
    }
    // Reads say so; writes say they are not consequential, all but reset_edits.
    const annotations = Object.fromEntries(all.map((tool) => [tool.name, tool.annotations]));
    expect(annotations.get_view).toEqual({ readOnlyHint: true });
    expect(annotations.get_observation).toEqual({ readOnlyHint: true, untrustedContentHint: true });
    expect(annotations.set_view).toEqual({ readOnlyHint: false, consequentialHint: false });
    expect(annotations.edit_stop).toEqual({ readOnlyHint: false, consequentialHint: false });
    expect(annotations.reset_edits).toEqual({ readOnlyHint: false, consequentialHint: true });
    expect(
      all.filter((tool) => tool.annotations?.untrustedContentHint === true).map((t) => t.name),
    ).toEqual([
      'capture_view',
      'list_layers',
      'features_in_view',
      'list_walkthroughs',
      'get_stop',
      'list_observations',
      'get_observation',
    ]);
    expect(MAP_PAGE_POLICY.consequentialTools).toEqual(['reset_edits']);
  });

  it('(a) carry each fixed bound as a keyword, in forms valid in JSON Schema 2019-09 as in 2020-12', () => {
    const world = createMapWorld();
    const schemas = Object.fromEntries(toolsOf(world).map((tool) => [tool.name, tool.inputSchema]));
    expect(schemas.set_view).toMatchObject({
      minProperties: 1,
      properties: {
        body: { enum: ['moon'] },
        projection: { enum: ['globe', 'equirectangular'] },
        lat: { minimum: -90, maximum: 90 },
        headingDeg: { minimum: 0, exclusiveMaximum: 360 },
        widthM: { exclusiveMinimum: 0, maximum: 1e10 },
      },
    });
    expect(schemas.set_clock).toMatchObject({
      minProperties: 1,
      properties: { time: { type: 'string', maxLength: 30, format: 'date-time' } },
    });
    expect(schemas.go_to_stop).toMatchObject({
      required: ['index'],
      properties: { index: { type: 'integer', minimum: 0, maximum: MAP_MAX_STOPS - 1 } },
    });
    expect(schemas.edit_stop).toMatchObject({ minProperties: 3 });
    expect(schemas.set_layer).toMatchObject({
      minProperties: 2,
      properties: { id: { maxLength: MAP_MAX_ID_CHARS } },
    });
    const json = JSON.stringify(schemas);
    for (const keyword of ['prefixItems', '$ref', '$defs', '$schema', '"pattern":"^(']) {
      expect(json).not.toContain(keyword);
    }
  });

  it('(b) are each described in one plain ASCII line of at most 200 characters', () => {
    for (const tool of toolsOf(createMapWorld())) {
      expect(tool.description.length, tool.name).toBeLessThanOrEqual(MAP_MAX_DESCRIPTION_CHARS);
      expect(tool.description, tool.name).toMatch(/^[\x20-\x7e]+$/);
      // The word the relay keeps for its own prefix never appears in page words.
      expect(tool.description.toLowerCase(), tool.name).not.toContain('tabdock');
      for (const property of Object.values(
        (tool.inputSchema as { properties?: Record<string, { description?: string }> })
          .properties ?? {},
      )) {
        expect(property.description ?? '').toMatch(/^[\x20-\x7e]*$/);
      }
    }
  });

  it('carry no clock group on a page with no clock, and only the groups asked for', () => {
    const data = moonWorldData();
    data.clock = null;
    for (const walkthrough of data.walkthroughs) {
      for (const stop of walkthrough.stops) stop.clock = null;
    }
    const names = createMapTools(new MapWorld(data)).map((tool) => tool.name);
    expect(names).not.toContain('get_clock');
    expect(names).not.toContain('set_clock');
    expect(names).toHaveLength(12);
    expect(
      createMapTools(createMapWorld(), { groups: ['walkthroughs'] }).map((tool) => tool.name),
    ).toEqual(['get_view', 'set_view', 'list_walkthroughs', 'get_stop', 'go_to_stop']);
  });
});

describe.each(RUNTIME_PROFILES)('(c) every tool through executeTool on %s', (profile) => {
  it('returns the string a runtime returns, which parses with its result schema', async () => {
    const world = createMapWorld();
    const context = new FakeModelContext({ profile });
    for (const tool of toolsOf(world)) await context.registerTool(tool);
    const listed = await context.getTools();
    for (const name of Object.keys(VALID_ARGS)) {
      const entry = listed.find((tool) => tool.name === name);
      if (!entry) throw new Error(`${name} is not listed on ${profile}`);
      const text = await context.executeTool(entry, inputFor(profile, VALID_ARGS[name] ?? {}));
      expect(typeof text, name).toBe('string');
      const schema = MAP_RESULT_SCHEMAS[name as keyof typeof MAP_RESULT_SCHEMAS];
      const parsed = schema.safeParse(JSON.parse(text));
      expect(parsed.error?.issues ?? [], name).toEqual([]);
    }
  });
});

describe('(d) handlers', () => {
  const refusals: [string, string, Record<string, unknown>][] = [
    ['latitude 91', 'set_view', { lat: 91 }],
    ['heading 360', 'set_view', { headingDeg: 360 }],
    ['an unknown key', 'set_view', { lat: 1, zoom: 3 }],
    ['an empty set_view', 'set_view', {}],
    ['widthM with altitudeM', 'set_view', { projection: 'globe', widthM: 1e6, altitudeM: 1e6 }],
    ['altitudeM on equirectangular', 'set_view', { projection: 'equirectangular', altitudeM: 1e5 }],
    ['altitudeM on the 2D map in view', 'set_view', { altitudeM: 1e5 }],
    ['an unknown body', 'set_view', { body: 'mars' }],
    ['a time without Z', 'set_clock', { time: '2026-01-01T06:00:00' }],
    ['a time that is no date', 'set_clock', { time: '2026-02-30T06:00:00Z' }],
    ['a time off the clock', 'set_clock', { time: '2027-01-01T00:00:00Z' }],
    ['an index past the last stop', 'go_to_stop', { walkthroughId: 'maria', index: 3 }],
    ['a stop index that is not whole', 'get_stop', { walkthroughId: 'maria', index: 0.5 }],
    ['an id with a space', 'get_observation', { id: 'obs 1' }],
    ['an unknown observation', 'view_from_observation', { id: 'obs-9' }],
    ['an unknown layer', 'set_layer', { id: 'nope', visible: true }],
    ['a set_layer with nothing to set', 'set_layer', { id: 'albedo' }],
    ['a limit of 201', 'features_in_view', { limit: 201 }],
    [
      'from after to',
      'list_observations',
      { from: '2026-01-01T09:00:00Z', to: '2026-01-01T01:00:00Z' },
    ],
    ['a capture wider than 2048', 'capture_view', { maxWidthPx: 4096 }],
    ['an edit with no title or text', 'edit_stop', { walkthroughId: 'maria', index: 0 }],
    ['an edit past the last stop', 'edit_stop', { walkthroughId: 'maria', index: 7, text: 'x' }],
  ];

  it.each(refusals)('refuse %s with no relay to check first', async (_label, name, args) => {
    const world = createMapWorld();
    const before = JSON.stringify(world.state());
    await expect(call(toolsOf(world), name, args)).rejects.toThrow();
    expect(JSON.stringify(world.state())).toBe(before);
  });

  it('name what they refused by path, never by the value sent', async () => {
    const tools = toolsOf(createMapWorld());
    const secret = 'Zq7Mark9Wq';
    const errors = await Promise.all([
      call(tools, 'set_view', { [secret]: 1 }).catch((error: unknown) => error),
      call(tools, 'get_observation', { id: `${secret} x` }).catch((error: unknown) => error),
      call(tools, 'set_clock', { time: `${secret}Z` }).catch((error: unknown) => error),
      call(tools, 'set_layer', { id: secret, visible: true }).catch((error: unknown) => error),
    ]);
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(secret);
    }
    expect((errors[0] as Error).message).toBe(
      'set_view refused its arguments: (root): holds fields it does not take; (root): give at least one field',
    );
  });

  it('honour an aborted signal before they run', async () => {
    const world = createMapWorld();
    const abort = new AbortController();
    abort.abort(new Error('stopped'));
    await expect(
      byName(toolsOf(world), 'set_view').execute({ lat: 3 }, { signal: abort.signal }),
    ).rejects.toThrow('stopped');
    expect(world.view().lat).toBe(0);
  });
});

describe('(e) the reads', () => {
  it('change nothing in the world, so an observer can use every one (S5)', async () => {
    const world = createMapWorld();
    world.goToStop('flyby', 1);
    const tools = toolsOf(world);
    const snapshot = (): string =>
      JSON.stringify({
        state: world.state(),
        layers: world.layers(),
        walkthroughs: world.walkthroughs(),
        stops: Object.entries(STOPS).flatMap(([id, count]) =>
          Array.from({ length: count }, (_, index) => world.stop(id, index)),
        ),
        observations: world.observations(),
        each: OBSERVATIONS.map((id) => world.observation(id)),
        features: world.featuresInView({ limit: MAP_MAX_FEATURES }),
        clock: world.clock(),
      });
    const before = snapshot();
    const reads = MAP_PROFILE_TOOLS.filter((meta) => meta.readOnly).map((meta) => meta.name);
    expect(reads).toEqual([
      'get_view',
      'capture_view',
      'get_clock',
      'list_layers',
      'features_in_view',
      'list_walkthroughs',
      'get_stop',
      'list_observations',
      'get_observation',
    ]);
    for (const name of reads) {
      await call(tools, name, VALID_ARGS[name]);
      await call(tools, name, name === 'get_observation' ? { id: 'obs-1' } : {});
    }
    expect(snapshot()).toBe(before);
  });

  it('hand out copies, so a caller that changes a result changes no state', () => {
    const world = createMapWorld();
    const layers = world.layers();
    const first = layers[0];
    if (first) first.visible = false;
    world.observation('obs-1').notes.push('changed');
    expect(world.layers()[0]?.visible).toBe(true);
    expect(world.observation('obs-1').notes).toHaveLength(1);
  });
});

describe('(f) moving the page', () => {
  it("go_to_stop then get_view gives each stop's view", async () => {
    const world = createMapWorld();
    const tools = toolsOf(world);
    for (const [walkthroughId, count] of Object.entries(STOPS)) {
      for (let index = 0; index < count; index += 1) {
        const moved = await call(tools, 'go_to_stop', { walkthroughId, index });
        const stop = MAP_RESULT_SCHEMAS.get_stop.parse(
          await call(tools, 'get_stop', { walkthroughId, index }),
        );
        const view = MAP_RESULT_SCHEMAS.get_view.parse(await call(tools, 'get_view', {}));
        const { profile, bounds, ...fields } = view;
        expect(profile).toBe(MAP_PROFILE);
        expect(fields).toEqual(stop.view);
        expect(moved).toMatchObject({
          walkthroughId,
          index,
          view,
          observationId: stop.observationId,
        });
        // A stop that sets the clock sets it exactly, and get_stop defaults to the current stop.
        if (stop.clock) expect(world.clock()).toMatchObject(stop.clock);
        expect(await call(tools, 'get_stop', {})).toEqual(stop);
        expect(world.state().walkthrough).toEqual({ id: walkthroughId, stopIndex: index });
        if (bounds === null) expect(view.projection).toBe(GLOBE);
      }
    }
  });

  it("view_from_observation gives the observation's viewpoint, and puts it on screen", async () => {
    const world = createMapWorld();
    const tools = toolsOf(world);
    for (const id of OBSERVATIONS) {
      const observation = MAP_RESULT_SCHEMAS.get_observation.parse(
        await call(tools, 'get_observation', { id }),
      );
      expect(observation.onScreen).toBe(false);
      const moved = MAP_RESULT_SCHEMAS.view_from_observation.parse(
        await call(tools, 'view_from_observation', { id }),
      );
      expect(moved.observationId).toBe(id);
      const view = MAP_RESULT_SCHEMAS.get_view.parse(await call(tools, 'get_view', {}));
      const { viewpoint } = observation;
      expect(view).toMatchObject({
        projection: GLOBE,
        body: viewpoint.body,
        lon: viewpoint.lon,
        lat: viewpoint.lat,
        altitudeM: viewpoint.altitudeM,
        headingDeg: viewpoint.headingDeg,
        pitchDeg: viewpoint.pitchDeg,
        fovDeg: viewpoint.fovDeg,
      });
      expect(view.widthM).toBeCloseTo(widthFromAltitude(viewpoint.altitudeM, viewpoint.fovDeg), 6);
      expect(world.observation(id).onScreen).toBe(true);
      expect(world.state().observationId).toBe(id);
    }
    // Any other move takes the observation off screen.
    await call(tools, 'set_view', { lon: 1 });
    expect(world.observationId).toBeNull();
  });

  it('set_view reads back exactly as written, on a globe by width or by altitude', async () => {
    const world = createMapWorld();
    const tools = toolsOf(world);
    const flat = MAP_RESULT_SCHEMAS.set_view.parse(
      await call(tools, 'set_view', { lon: -20, lat: 10, widthM: 123_456, headingDeg: 45 }),
    );
    expect(flat).toMatchObject({ lon: -20, lat: 10, widthM: 123_456, headingDeg: 45 });
    expect(flat).not.toHaveProperty('altitudeM');
    const globe = MAP_RESULT_SCHEMAS.set_view.parse(
      await call(tools, 'set_view', { projection: 'globe', altitudeM: 250_000, fovDeg: 35 }),
    );
    expect(globe).toMatchObject({ projection: 'globe', altitudeM: 250_000, fovDeg: 35 });
    expect(await call(tools, 'get_view', {})).toEqual(globe);
    const wide = MAP_RESULT_SCHEMAS.set_view.parse(
      await call(tools, 'set_view', { widthM: 99_000 }),
    );
    expect(wide).toMatchObject({ widthM: 99_000, fovDeg: 35 });
  });

  it('showing a base layer hides the other base layers', async () => {
    const world = createMapWorld();
    await call(toolsOf(world), 'set_layer', { id: 'elevation', visible: true });
    expect(world.layers().filter((layer) => layer.visible && layer.kind === 'base')).toEqual([
      expect.objectContaining({ id: 'elevation' }),
    ]);
  });
});

describe('(g) features_in_view', () => {
  it('keeps to its limit and reports total and truncated, the most prominent first, then the nearest', async () => {
    const world = createMapWorld();
    const tools = toolsOf(world);
    // The whole near side on a globe, so every near side feature is in view.
    await call(tools, 'set_view', { projection: 'globe', lon: 0, lat: 0, widthM: 6_200_000 });
    const all = MAP_RESULT_SCHEMAS.features_in_view.parse(
      await call(tools, 'features_in_view', {}),
    );
    expect(all.truncated).toBe(false);
    expect(all.total).toBe(all.features.length);
    // Korolev and Mare Orientale lie past the limb.
    expect(all.features.map((feature) => feature.id)).toEqual([
      'mare-tranquillitatis',
      'mare-imbrium',
      'oceanus-procellarum',
      'mare-serenitatis',
      'mare-crisium',
      'copernicus',
      'tycho',
      'aristarchus',
      'plato',
      'apollo-11',
    ]);
    const two = MAP_RESULT_SCHEMAS.features_in_view.parse(
      await call(tools, 'features_in_view', { limit: 2 }),
    );
    expect(two).toEqual({ features: all.features.slice(0, 2), total: all.total, truncated: true });
    const craters = MAP_RESULT_SCHEMAS.features_in_view.parse(
      await call(tools, 'features_in_view', { kind: 'crater' }),
    );
    expect(craters.features.every((feature) => feature.kind === 'crater')).toBe(true);
    expect(craters).toMatchObject({ total: 4, truncated: false });
    expect(craters.features.map((feature) => feature.id)).toEqual([
      'copernicus',
      'tycho',
      'aristarchus',
      'plato',
    ]);
    expect(MAP_DEFAULT_FEATURES).toBe(50);
  });

  it('finds nothing in a view of empty ground', () => {
    const world = createMapWorld();
    world.setView({ lon: 120, lat: -60, widthM: 10_000 });
    expect(world.featuresInView()).toEqual({ features: [], total: 0, truncated: false });
  });
});

describe('(h) the clock', () => {
  it('runs on the injected now while playing, and stops where it is when paused', () => {
    let now = 1_000_000;
    const world = createMapWorld({ now: () => now });
    expect(world.clock()?.time).toBe('2026-01-01T00:00:00.000Z');
    now += 10_000;
    expect(world.clock()?.time).toBe('2026-01-01T00:00:00.000Z');
    world.setClock({ playing: true });
    now += 10_000;
    // Ten real seconds at 60 simulated seconds each.
    expect(world.clock()?.time).toBe('2026-01-01T00:10:00.000Z');
    world.setClock({ playing: false });
    now += 60_000;
    expect(world.clock()).toMatchObject({ time: '2026-01-01T00:10:00.000Z', playing: false });
    world.setClock({ rate: -120, playing: true });
    now += 1_000;
    expect(world.clock()?.time).toBe('2026-01-01T00:08:00.000Z');
    // It stops at the start rather than running off its range.
    now += 3_600_000;
    expect(world.clock()?.time).toBe('2026-01-01T00:00:00.000Z');
  });

  it('refuses a time outside its start and end', () => {
    const world = createMapWorld();
    expect(() => world.setClock({ time: '2025-12-31T23:59:59Z' })).toThrow(
      "that time is outside the clock's start and end",
    );
    expect(world.setClock({ time: '2026-01-02T00:00:00Z' }).time).toBe('2026-01-02T00:00:00.000Z');
  });
});

describe('(i) capture_view', () => {
  it('returns the text form without a capture function', async () => {
    const result = await call(toolsOf(createMapWorld()), 'capture_view', {});
    const parsed = CaptureTextSchema.parse(result);
    expect(parsed.description).toMatch(
      /^A equirectangular view of moon centred on latitude 0\.000/,
    );
    expect(parsed.visibleLayers).toEqual(['albedo', 'graticule', 'names', 'path', 'footprints']);
    expect(result).not.toHaveProperty('image');
  });

  it("returns ADR 0039's envelope with one, asking for the size and format given", async () => {
    const asked: unknown[] = [];
    const capture: MapCapture = (request) => {
      asked.push(request);
      return Promise.resolve({ mimeType: 'image/jpeg', data: 'AAAA', widthPx: 640, heightPx: 360 });
    };
    const world = createMapWorld();
    const tools = toolsOf(world, capture);
    const envelope = CaptureEnvelopeSchema.parse(
      await call(tools, 'capture_view', { maxWidthPx: 640, format: 'jpeg' }),
    );
    expect(envelope.image).toEqual({ mimeType: 'image/jpeg', data: 'AAAA' });
    expect(CaptureImageTextSchema.parse(JSON.parse(envelope.text))).toMatchObject({
      view: world.view(),
      widthPx: 640,
      heightPx: 360,
    });
    await call(tools, 'capture_view', {});
    expect(asked).toEqual([
      { maxWidthPx: 640, format: 'jpeg' },
      { maxWidthPx: 1024, format: 'png' },
    ]);
  });
});

/** A string of exactly `length` characters that needs no escaping in JSON. */
function long(prefix: string, length: number): string {
  return `${prefix}${'x'.repeat(Math.max(0, length - prefix.length))}`.slice(0, length);
}

function id(prefix: string, n: number): string {
  return long(`${prefix}-${String(n)}-`, MAP_MAX_ID_CHARS);
}

/** A world at every cap the profile sets, its strings as long as allowed. */
function fullWorld(): MapWorldData {
  const data = moonWorldData();
  const walkthroughIds = Array.from({ length: MAP_MAX_WALKTHROUGHS }, (_, n) => id('w', n));
  const ring = (lon: number, lat: number, count: number): [number, number][] => {
    const points: [number, number][] = Array.from({ length: count - 1 }, (_, n) => [
      lon + Math.cos((2 * Math.PI * n) / (count - 1)),
      lat + Math.sin((2 * Math.PI * n) / (count - 1)),
    ]);
    return [...points, points[0] ?? [lon, lat]];
  };
  data.layers = Array.from({ length: MAP_MAX_LAYERS }, (_, n) => ({
    id: id('layer', n),
    title: long('Layer ', MAP_MAX_TITLE_CHARS),
    kind: n === 0 ? 'base' : 'overlay',
    visible: true,
    opacity: 0.123456789,
  }));
  data.features = Array.from({ length: 2 * MAP_MAX_FEATURES }, (_, n) => ({
    id: id('feature', n),
    name: long('Feature ', MAP_MAX_TITLE_CHARS),
    kind: long('k', MAP_MAX_KIND_CHARS),
    lon: 0.123456789012345 + (n % 20) * 0.01,
    lat: -0.123456789012345 - Math.floor(n / 20) * 0.01,
    rank: n,
    body: 'moon',
  }));
  const stop = data.walkthroughs[1]?.stops[0];
  if (!stop) throw new Error('the fixture has no flyby');
  data.walkthroughs = walkthroughIds.map((walkthroughId, n) => ({
    id: walkthroughId,
    title: long('Walkthrough ', MAP_MAX_TITLE_CHARS),
    stops: Array.from({ length: n === 0 ? MAP_MAX_STOPS : 1 }, () => ({
      ...stop,
      title: long('Stop ', MAP_MAX_TITLE_CHARS),
      text: long('Text ', MAP_MAX_TEXT_CHARS),
      observationId: id('obs', 0),
    })),
  }));
  data.observations = Array.from({ length: 2 * MAP_MAX_OBSERVATIONS }, (_, n) => ({
    id: id('obs', n),
    title: long('Observation ', MAP_MAX_TITLE_CHARS),
    kind: long('k', MAP_MAX_KIND_CHARS),
    time: '2026-01-01T02:00:00.000Z',
    walkthroughId: walkthroughIds[n % MAP_MAX_WALKTHROUGHS] ?? null,
    viewpoint: {
      body: 'moon',
      lon: 23.123456789012,
      lat: 0.123456789012,
      altitudeM: 123_456.789012,
      headingDeg: 359.123456789,
      pitchDeg: -89.123456789,
      fovDeg: 30.123456789,
    },
    footprint: {
      type: 'MultiPolygon',
      coordinates: [[ring(23, 0, MAP_MAX_FOOTPRINT_POSITIONS / 2)], [ring(24, 1, 500)]],
    },
    source: {
      name: long('Source ', MAP_MAX_TITLE_CHARS),
      url: long('https://example.com/', MAP_MAX_URL_CHARS),
      credit: long('Credit ', MAP_MAX_TITLE_CHARS),
    },
    notes: Array.from({ length: MAP_MAX_NOTES }, () => long('Note ', MAP_MAX_NOTE_CHARS)),
  }));
  return data;
}

describe('(j) a world filled to every cap', () => {
  it('answers every tool within what the relay returns uncut, and publishes state under 2,048 bytes', async () => {
    const world = new MapWorld(fullWorld());
    const tools = toolsOf(world);
    // Every feature in view, and the long walkthrough current.
    const overFeatures = (): void => {
      world.setView({ lon: 0.2, lat: -0.2, widthM: 500_000 });
    };
    world.goToStop(id('w', 0), MAP_MAX_STOPS - 1);
    const room = MAX_RESULT_CHARS - 1000;
    const largest: Record<string, number> = {};
    const args: Record<string, Record<string, unknown>> = {
      ...VALID_ARGS,
      features_in_view: { limit: MAP_MAX_FEATURES },
      list_observations: { limit: MAP_MAX_OBSERVATIONS },
      get_observation: { id: id('obs', 0) },
      view_from_observation: { id: id('obs', 0) },
      get_stop: { walkthroughId: id('w', 0), index: MAP_MAX_STOPS - 1 },
      go_to_stop: { walkthroughId: id('w', 0), index: MAP_MAX_STOPS - 1 },
      set_layer: { id: id('layer', 3), visible: true },
      edit_stop: {
        walkthroughId: id('w', 0),
        index: 0,
        title: long('T', MAP_MAX_TITLE_CHARS),
        text: long('X', MAP_MAX_TEXT_CHARS),
      },
    };
    for (const tool of tools) {
      overFeatures();
      const result = await call(tools, tool.name, args[tool.name] ?? {});
      const chars = JSON.stringify(result).length;
      largest[tool.name] = chars;
      expect(chars, tool.name).toBeLessThan(room);
    }
    overFeatures();
    const features = MAP_RESULT_SCHEMAS.features_in_view.parse(
      await call(tools, 'features_in_view', { limit: MAP_MAX_FEATURES }),
    );
    expect(largest.features_in_view).toBe(JSON.stringify(features).length);
    expect(features).toMatchObject({ total: 2 * MAP_MAX_FEATURES, truncated: true });
    expect(features.features).toHaveLength(MAP_MAX_FEATURES);
    expect(largest.list_observations).toBeGreaterThan(50_000);
    world.goToStop(id('w', 0), MAP_MAX_STOPS - 1);
    world.viewFromObservation(id('obs', 0));
    const state = JSON.stringify(world.state());
    expect(new TextEncoder().encode(state).length).toBeLessThan(2048);
  });

  it('refuses data past a cap, so a world cannot answer beyond the profile', () => {
    const data = moonWorldData();
    data.layers = Array.from({ length: MAP_MAX_LAYERS + 1 }, (_, n) => ({
      id: `l${String(n)}`,
      title: 'L',
      kind: 'overlay' as const,
      visible: true,
      opacity: 1,
    }));
    expect(() => new MapWorld(data)).toThrow(/breaks the profile at layers/);
    const notes = moonWorldData();
    const first = notes.observations[0];
    if (first) first.notes = Array.from({ length: MAP_MAX_NOTES + 1 }, () => 'n');
    expect(() => new MapWorld(notes)).toThrow(/breaks the profile at observations/);
  });
});

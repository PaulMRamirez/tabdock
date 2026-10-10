// MapWorld: a map page's state in memory, the worked example of the profile
// (ADR 0038) that the sim page's map tools and the canvas page both drive.
// It is deterministic, with its clock read through an injected now(), so a
// test or a capture gets the same answer for the same state. Every write
// returns the state it produced and tells subscribers once; reads change
// nothing, which is what lets an observer use every read (S5).

import { z } from 'zod';
import {
  altitudeFromWidth,
  angularDistanceDeg,
  isInView,
  type MapViewport,
  viewBounds,
  widthFromAltitude,
} from './geometry.ts';
import {
  BodySchema,
  GLOBE,
  IsoTimeSchema,
  isUtcIsoTime,
  MAP_DEFAULT_FEATURES,
  MAP_DEFAULT_OBSERVATIONS,
  MAP_MAX_DISTANCE_M,
  MAP_MAX_LAYERS,
  MAP_MAX_STOPS,
  MAP_MAX_TEXT_CHARS,
  MAP_MAX_WALKTHROUGHS,
  MAP_PROFILE,
  MapFeatureSchema,
  MapIdSchema,
  MapLayerSchema,
  MapObservationSchema,
  MapStopClockSchema,
  MapStopViewSchema,
  ProjectionSchema,
  RateSchema,
  TitleSchema,
  type MapClock,
  type MapFeature,
  type MapLayer,
  type MapObservation,
  type MapPageState,
  type MapStop,
  type MapStopClock,
  type MapStopView,
  type MapView,
  type ObservationSummary,
  type WalkthroughSummary,
} from './profile.ts';

/** The field of view a globe gets when a 2D view becomes one without naming its own. */
export const MAP_DEFAULT_FOV_DEG = 60;
/** The handler runs a world keeps for tests, newest last; older ones drop, so a long session holds no more. */
export const MAP_MAX_CALLS_KEPT = 1000;

// Years 0000 to 9999, which toISOString writes in the profile's four-digit form.
const EARLIEST_MS = Date.parse('0000-01-01T00:00:00.000Z');
const LATEST_MS = Date.parse('9999-12-31T23:59:59.999Z');

const BodyDataSchema = z.object({ name: BodySchema, radiusM: z.number().gt(0).max(1e9) });

const ClockDataSchema = z.object({
  start: IsoTimeSchema.nullable(),
  end: IsoTimeSchema.nullable(),
  time: IsoTimeSchema,
  rate: RateSchema,
  playing: z.boolean(),
});

const StopDataSchema = z.object({
  title: TitleSchema,
  text: z.string().max(MAP_MAX_TEXT_CHARS),
  view: MapStopViewSchema,
  clock: MapStopClockSchema.nullable(),
  observationId: MapIdSchema.nullable(),
});

/** Everything a world starts from. Its shape holds the profile's caps, so a world cannot answer past them. */
export const MapWorldDataSchema = z.object({
  bodies: z.array(BodyDataSchema).min(1).max(16),
  projections: z.array(ProjectionSchema).min(1).max(16),
  view: MapStopViewSchema,
  clock: ClockDataSchema.nullable(),
  layers: z.array(MapLayerSchema).max(MAP_MAX_LAYERS),
  /** rank orders features by prominence, lowest first. */
  features: z.array(MapFeatureSchema.extend({ body: BodySchema, rank: z.number() })),
  walkthroughs: z
    .array(
      z.object({
        id: MapIdSchema,
        title: TitleSchema,
        stops: z.array(StopDataSchema).min(1).max(MAP_MAX_STOPS),
      }),
    )
    .max(MAP_MAX_WALKTHROUGHS),
  observations: z.array(MapObservationSchema.omit({ onScreen: true })),
});
export type MapWorldData = z.input<typeof MapWorldDataSchema>;
type WorldData = z.output<typeof MapWorldDataSchema>;
type StopData = WorldData['walkthroughs'][number]['stops'][number];
type ObservationData = WorldData['observations'][number];

export interface MapWorldOptions {
  /** The clock's real time source, Date.now unless set. */
  readonly now?: () => number;
  /** The drawing surface's size; 960 by 540 unless set. */
  readonly viewport?: MapViewport;
}

interface Camera {
  body: string;
  projection: string;
  lon: number;
  lat: number;
  widthM: number;
  headingDeg: number;
  pitchDeg: number;
  /** Kept exactly as last set on a globe, so a view reads back as it was written; null on a 2D map. */
  altitudeM: number | null;
  fovDeg: number | null;
}

interface Clock {
  readonly startMs: number | null;
  readonly endMs: number | null;
  /** The time at anchorAt; a playing clock runs on from there at rate. */
  anchorMs: number;
  anchorAt: number;
  rate: number;
  playing: boolean;
}

export interface SetViewPatch {
  body?: string | undefined;
  projection?: string | undefined;
  lon?: number | undefined;
  lat?: number | undefined;
  widthM?: number | undefined;
  altitudeM?: number | undefined;
  headingDeg?: number | undefined;
  pitchDeg?: number | undefined;
  fovDeg?: number | undefined;
}

export interface SetClockPatch {
  time?: string | undefined;
  rate?: number | undefined;
  playing?: boolean | undefined;
}

export interface GoToStopResult {
  walkthroughId: string;
  index: number;
  stopCount: number;
  view: MapView;
  clock: MapClock | null;
  observationId: string | null;
}

/** A refusal in the world's own words; it never quotes what the caller sent. */
class MapRefusal extends Error {}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function cameraFrom(view: MapStopView): Camera {
  return {
    body: view.body,
    projection: view.projection,
    lon: view.lon,
    lat: view.lat,
    widthM: view.widthM,
    headingDeg: view.headingDeg,
    pitchDeg: view.pitchDeg,
    altitudeM: view.altitudeM ?? null,
    fovDeg: view.fovDeg ?? null,
  };
}

/** A camera as a stop's view, the fields in get_view's order. */
function stopViewOf(camera: Camera): MapStopView {
  const view: MapStopView = {
    body: camera.body,
    projection: camera.projection,
    lon: camera.lon,
    lat: camera.lat,
    widthM: camera.widthM,
    headingDeg: camera.headingDeg,
    pitchDeg: camera.pitchDeg,
  };
  if (camera.projection === GLOBE && camera.altitudeM !== null && camera.fovDeg !== null) {
    view.altitudeM = camera.altitudeM;
    view.fovDeg = camera.fovDeg;
  }
  return view;
}

export class MapWorld {
  /** Each handler run, newest last, so a test can see what reached the page. */
  readonly calls: { tool: string; input: unknown }[] = [];
  readonly #data: WorldData;
  readonly #now: () => number;
  #viewport: MapViewport;
  #camera: Camera;
  readonly #clock: Clock | null;
  readonly #layers: MapLayer[];
  #current: { walkthroughId: string; stopIndex: number } | null = null;
  #observationId: string | null = null;
  readonly #edits = new Map<string, { title?: string; text?: string }>();
  readonly #listeners = new Set<() => void>();

  constructor(data: MapWorldData, options: MapWorldOptions = {}) {
    const parsed = MapWorldDataSchema.safeParse(data);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `the map world's data breaks the profile at ${issue?.path.join('.') ?? '(root)'}: ${issue?.message ?? 'invalid'}`,
      );
    }
    this.#data = parsed.data;
    this.#now = options.now ?? Date.now;
    this.#viewport = options.viewport ?? { widthPx: 960, heightPx: 540 };
    checkReferences(this.#data);
    this.#camera = cameraFrom(this.#data.view);
    const clock = this.#data.clock;
    this.#clock = clock && {
      startMs: clock.start === null ? null : Date.parse(clock.start),
      endMs: clock.end === null ? null : Date.parse(clock.end),
      anchorMs: Date.parse(clock.time),
      anchorAt: this.#now(),
      rate: clock.rate,
      playing: clock.playing,
    };
    this.#layers = this.#data.layers.map((layer) => ({ ...layer }));
  }

  /** The bodies this world shows, which narrow set_view's body. */
  get bodies(): readonly [string, ...string[]] {
    const [first, ...rest] = this.#data.bodies.map((body) => body.name);
    return [first ?? '', ...rest];
  }

  get projections(): readonly [string, ...string[]] {
    const [first, ...rest] = this.#data.projections;
    return [first ?? '', ...rest];
  }

  get hasClock(): boolean {
    return this.#clock !== null;
  }

  get viewport(): MapViewport {
    return { ...this.#viewport };
  }

  /** The radius of the body in view, in metres. */
  get radiusM(): number {
    return this.#radius(this.#camera.body);
  }

  #radius(body: string): number {
    return this.#data.bodies.find((entry) => entry.name === body)?.radiusM ?? 1;
  }

  /** Called on every discrete change, never per animation frame. Returns the way to stop. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #changed(): void {
    // A listener that throws fails the write that told it, which the
    // worked example accepts: its listener only redraws.
    for (const listener of [...this.#listeners]) listener();
  }

  /** Notes one handler run; the handlers call this before they check anything. */
  record(tool: string, input: unknown): void {
    this.calls.push({ tool, input });
    if (this.calls.length > MAP_MAX_CALLS_KEPT) this.calls.shift();
  }

  setViewport(viewport: MapViewport): void {
    if (!(viewport.widthPx > 0 && viewport.heightPx > 0)) {
      throw new MapRefusal('a viewport has a width and height above zero');
    }
    this.#viewport = { widthPx: viewport.widthPx, heightPx: viewport.heightPx };
    this.#changed();
  }

  view(): MapView {
    const camera = this.#camera;
    return {
      profile: MAP_PROFILE,
      ...stopViewOf(camera),
      bounds: viewBounds(camera, this.#viewport, this.#radius(camera.body)),
    };
  }

  setView(patch: SetViewPatch): MapView {
    const before = this.#camera;
    const projection = patch.projection ?? before.projection;
    const body = patch.body ?? before.body;
    if (!this.#data.projections.includes(projection)) {
      throw new MapRefusal('this page draws no such projection');
    }
    if (!this.#data.bodies.some((entry) => entry.name === body)) {
      throw new MapRefusal('this page shows no such body');
    }
    const globe = projection === GLOBE;
    if (!globe && (patch.altitudeM !== undefined || patch.fovDeg !== undefined)) {
      throw new MapRefusal('altitudeM and fovDeg apply only to a globe');
    }
    if (patch.widthM !== undefined && patch.altitudeM !== undefined) {
      throw new MapRefusal('give widthM or altitudeM, not both');
    }
    const next: Camera = {
      body,
      projection,
      lon: patch.lon ?? before.lon,
      lat: patch.lat ?? before.lat,
      widthM: patch.widthM ?? before.widthM,
      headingDeg: patch.headingDeg ?? before.headingDeg,
      pitchDeg: patch.pitchDeg ?? before.pitchDeg,
      altitudeM: null,
      fovDeg: null,
    };
    if (globe) {
      const fovDeg = patch.fovDeg ?? before.fovDeg ?? MAP_DEFAULT_FOV_DEG;
      next.fovDeg = fovDeg;
      if (patch.altitudeM !== undefined) {
        next.altitudeM = patch.altitudeM;
        next.widthM = widthFromAltitude(patch.altitudeM, fovDeg);
      } else if (patch.widthM !== undefined || before.altitudeM === null) {
        next.altitudeM = altitudeFromWidth(next.widthM, fovDeg);
      } else {
        // A new field of view alone keeps the camera where it is, as a zoom lens does.
        next.altitudeM = before.altitudeM;
        next.widthM = widthFromAltitude(before.altitudeM, fovDeg);
      }
      if (!(next.widthM > 0 && next.widthM <= MAP_MAX_DISTANCE_M)) {
        throw new MapRefusal('that altitude and field of view show more than this page can');
      }
      if (next.altitudeM > MAP_MAX_DISTANCE_M) {
        throw new MapRefusal('that width and field of view put the camera too far out');
      }
    }
    this.#camera = next;
    this.#observationId = null;
    this.#changed();
    return this.view();
  }

  #timeMs(clock: Clock): number {
    if (!clock.playing) return clock.anchorMs;
    const raw = clock.anchorMs + (this.#now() - clock.anchorAt) * clock.rate;
    const low = clock.startMs ?? EARLIEST_MS;
    const high = clock.endMs ?? LATEST_MS;
    return Math.round(Math.min(high, Math.max(low, raw)));
  }

  clock(): MapClock | null {
    const clock = this.#clock;
    if (!clock) return null;
    return {
      time: iso(this.#timeMs(clock)),
      rate: clock.rate,
      playing: clock.playing,
      start: clock.startMs === null ? null : iso(clock.startMs),
      end: clock.endMs === null ? null : iso(clock.endMs),
    };
  }

  #withinClock(clock: Clock, ms: number): boolean {
    return ms >= (clock.startMs ?? EARLIEST_MS) && ms <= (clock.endMs ?? LATEST_MS);
  }

  setClock(patch: SetClockPatch): MapClock {
    const clock = this.#clock;
    if (!clock) throw new MapRefusal('this page has no clock');
    let at: number | null = null;
    if (patch.time !== undefined) {
      if (!isUtcIsoTime(patch.time)) throw new MapRefusal('a time is UTC ISO 8601 ending in Z');
      at = Date.parse(patch.time);
      if (!this.#withinClock(clock, at)) {
        throw new MapRefusal("that time is outside the clock's start and end");
      }
    }
    // The time so far is kept before rate or playing change what comes next.
    clock.anchorMs = at ?? this.#timeMs(clock);
    clock.anchorAt = this.#now();
    if (patch.rate !== undefined) clock.rate = patch.rate;
    if (patch.playing !== undefined) clock.playing = patch.playing;
    this.#changed();
    const now = this.clock();
    if (!now) throw new MapRefusal('this page has no clock');
    return now;
  }

  layers(): MapLayer[] {
    return this.#layers.map((layer) => ({ ...layer }));
  }

  setLayer(
    id: string,
    patch: { visible?: boolean | undefined; opacity?: number | undefined },
  ): { id: string; visible: boolean; opacity: number } {
    const layer = this.#layers.find((entry) => entry.id === id);
    if (!layer) throw new MapRefusal('no layer has that id');
    if (patch.opacity !== undefined) layer.opacity = patch.opacity;
    if (patch.visible !== undefined) layer.visible = patch.visible;
    if (patch.visible === true && layer.kind === 'base') {
      for (const other of this.#layers) {
        if (other !== layer && other.kind === 'base') other.visible = false;
      }
    }
    this.#changed();
    return { id: layer.id, visible: layer.visible, opacity: layer.opacity };
  }

  featuresInView(options: { limit?: number | undefined; kind?: string | undefined } = {}): {
    features: MapFeature[];
    total: number;
    truncated: boolean;
  } {
    const limit = options.limit ?? MAP_DEFAULT_FEATURES;
    const camera = this.#camera;
    const radiusM = this.#radius(camera.body);
    const found = this.#data.features
      .filter(
        (feature) =>
          feature.body === camera.body &&
          (options.kind === undefined || feature.kind === options.kind) &&
          isInView(camera, this.#viewport, radiusM, feature.lon, feature.lat),
      )
      .map((feature) => ({
        feature,
        distance: angularDistanceDeg(camera.lon, camera.lat, feature.lon, feature.lat),
      }))
      .sort((a, b) => a.feature.rank - b.feature.rank || a.distance - b.distance);
    return {
      features: found.slice(0, limit).map(({ feature }) => ({
        id: feature.id,
        name: feature.name,
        kind: feature.kind,
        lon: feature.lon,
        lat: feature.lat,
      })),
      total: found.length,
      truncated: found.length > limit,
    };
  }

  walkthroughs(): {
    walkthroughs: WalkthroughSummary[];
    current: { walkthroughId: string; stopIndex: number } | null;
  } {
    return {
      walkthroughs: this.#data.walkthroughs.map((walkthrough) => ({
        id: walkthrough.id,
        title: walkthrough.title,
        stopCount: walkthrough.stops.length,
      })),
      current: this.#current && { ...this.#current },
    };
  }

  #walkthrough(walkthroughId: string | undefined): WorldData['walkthroughs'][number] {
    const id = walkthroughId ?? this.#current?.walkthroughId;
    if (id === undefined) throw new MapRefusal('no walkthrough is current, so give walkthroughId');
    const walkthrough = this.#data.walkthroughs.find((entry) => entry.id === id);
    if (!walkthrough) throw new MapRefusal('no walkthrough has that id');
    return walkthrough;
  }

  #stopData(walkthroughId: string, index: number): StopData {
    const walkthrough = this.#walkthrough(walkthroughId);
    const stop = walkthrough.stops[index];
    if (!stop) {
      throw new MapRefusal(
        `that walkthrough's stops run from 0 to ${String(walkthrough.stops.length - 1)}`,
      );
    }
    return stop;
  }

  /** One stop, with its edits; the current one unless named, or a named walkthrough's first. */
  stop(walkthroughId?: string, index?: number): MapStop {
    const walkthrough = this.#walkthrough(walkthroughId);
    const current = this.#current?.walkthroughId === walkthrough.id ? this.#current : null;
    const at = index ?? current?.stopIndex ?? 0;
    const stop = this.#stopData(walkthrough.id, at);
    const edit = this.#edits.get(editKey(walkthrough.id, at));
    return {
      walkthroughId: walkthrough.id,
      index: at,
      stopCount: walkthrough.stops.length,
      title: edit?.title ?? stop.title,
      text: edit?.text ?? stop.text,
      view: { ...stop.view },
      clock: stop.clock && { ...stop.clock },
      observationId: stop.observationId,
    };
  }

  goToStop(walkthroughId: string | undefined, index: number): GoToStopResult {
    const walkthrough = this.#walkthrough(walkthroughId);
    const stop = this.#stopData(walkthrough.id, index);
    this.#camera = cameraFrom(stop.view);
    const clock = this.#clock;
    if (clock && stop.clock) this.#setStopClock(clock, stop.clock);
    this.#current = { walkthroughId: walkthrough.id, stopIndex: index };
    this.#observationId = stop.observationId;
    this.#changed();
    return {
      walkthroughId: walkthrough.id,
      index,
      stopCount: walkthrough.stops.length,
      view: this.view(),
      clock: this.clock(),
      observationId: this.#observationId,
    };
  }

  #setStopClock(clock: Clock, stopClock: MapStopClock): void {
    clock.anchorMs = Date.parse(stopClock.time);
    clock.anchorAt = this.#now();
    clock.rate = stopClock.rate;
    clock.playing = stopClock.playing;
  }

  observations(
    filter: {
      walkthroughId?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      limit?: number | undefined;
    } = {},
  ): { observations: ObservationSummary[]; total: number; truncated: boolean } {
    const limit = filter.limit ?? MAP_DEFAULT_OBSERVATIONS;
    const from = filter.from === undefined ? -Infinity : Date.parse(filter.from);
    const to = filter.to === undefined ? Infinity : Date.parse(filter.to);
    if (from > to) throw new MapRefusal('from is after to');
    const found = this.#data.observations
      .filter((observation) => {
        const at = Date.parse(observation.time);
        return (
          at >= from &&
          at <= to &&
          (filter.walkthroughId === undefined || observation.walkthroughId === filter.walkthroughId)
        );
      })
      .sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || (a.id < b.id ? -1 : 1));
    return {
      observations: found.slice(0, limit).map((observation) => ({
        id: observation.id,
        title: observation.title,
        kind: observation.kind,
        time: observation.time,
        walkthroughId: observation.walkthroughId,
      })),
      total: found.length,
      truncated: found.length > limit,
    };
  }

  #observation(id: string): ObservationData {
    const observation = this.#data.observations.find((entry) => entry.id === id);
    if (!observation) throw new MapRefusal('no observation has that id');
    return observation;
  }

  observation(id: string): MapObservation {
    const observation = this.#observation(id);
    return {
      ...structuredClone(observation),
      onScreen: this.#observationId === id,
    };
  }

  /** The camera at an observation's viewpoint, on the globe where this page has one. */
  viewFromObservation(id: string): { observationId: string; view: MapView } {
    const { viewpoint } = this.#observation(id);
    const globe = this.#data.projections.includes(GLOBE);
    const widthM = widthFromAltitude(viewpoint.altitudeM, viewpoint.fovDeg);
    if (!(widthM > 0 && widthM <= MAP_MAX_DISTANCE_M)) {
      throw new MapRefusal("that observation's viewpoint shows more than this page can");
    }
    this.#camera = {
      body: viewpoint.body,
      projection: globe ? GLOBE : this.#camera.projection,
      lon: viewpoint.lon,
      lat: viewpoint.lat,
      widthM,
      headingDeg: viewpoint.headingDeg,
      pitchDeg: viewpoint.pitchDeg,
      altitudeM: globe ? viewpoint.altitudeM : null,
      fovDeg: globe ? viewpoint.fovDeg : null,
    };
    this.#observationId = id;
    this.#changed();
    return { observationId: id, view: this.view() };
  }

  editStop(
    walkthroughId: string,
    index: number,
    patch: { title?: string | undefined; text?: string | undefined },
  ): { walkthroughId: string; index: number; edited: ('title' | 'text')[] } {
    this.#stopData(walkthroughId, index);
    const key = editKey(walkthroughId, index);
    const edit = { ...this.#edits.get(key) };
    const edited: ('title' | 'text')[] = [];
    if (patch.title !== undefined) {
      edit.title = patch.title;
      edited.push('title');
    }
    if (patch.text !== undefined) {
      edit.text = patch.text;
      edited.push('text');
    }
    if (edited.length === 0) throw new MapRefusal('give a title or a text');
    this.#edits.set(key, edit);
    this.#changed();
    return { walkthroughId, index, edited };
  }

  /** Discards every edit, returning how many stops had one. */
  resetEdits(): { reset: number } {
    const reset = this.#edits.size;
    this.#edits.clear();
    if (reset > 0) this.#changed();
    return { reset };
  }

  /** The current stop, or null. */
  get current(): { walkthroughId: string; stopIndex: number } | null {
    return this.#current && { ...this.#current };
  }

  /** The id of the observation on screen, or null. */
  get observationId(): string | null {
    return this.#observationId;
  }

  /** The ids of the layers shown, in drawing order. */
  visibleLayers(): string[] {
    return this.#layers.filter((layer) => layer.visible).map((layer) => layer.id);
  }

  /** Every feature of the body in view, for drawing. */
  bodyFeatures(): MapFeature[] {
    return this.#data.features
      .filter((feature) => feature.body === this.#camera.body)
      .map(({ id, name, kind, lon, lat }) => ({ id, name, kind, lon, lat }));
  }

  /** Every observation of the body in view, with whether it is on screen, for drawing. */
  bodyObservations(): MapObservation[] {
    return this.#data.observations
      .filter((observation) => observation.viewpoint.body === this.#camera.body)
      .map((observation) => this.observation(observation.id));
  }

  /** The stops' views of one walkthrough, for drawing its path. */
  stopViews(walkthroughId: string): MapStopView[] {
    return this.#walkthrough(walkthroughId).stops.map((stop) => ({ ...stop.view }));
  }

  /** What the page publishes (ADR 0040): the view and clock as the tools return them, and ids only. */
  state(): MapPageState {
    const current = this.#current;
    return {
      view: this.view(),
      clock: this.clock(),
      walkthrough: current && { id: current.walkthroughId, stopIndex: current.stopIndex },
      observationId: this.#observationId,
    };
  }
}

function editKey(walkthroughId: string, index: number): string {
  return `${walkthroughId}\n${String(index)}`;
}

/** Ids are unique, every name a stop or a view gives exists, and every set time lies on the clock. */
function checkReferences(data: WorldData): void {
  const unique = (ids: readonly string[], what: string): void => {
    if (new Set(ids).size !== ids.length) throw new Error(`the map world's ${what} ids repeat`);
  };
  unique(
    data.bodies.map((body) => body.name),
    'body',
  );
  unique(
    data.layers.map((layer) => layer.id),
    'layer',
  );
  unique(
    data.features.map((feature) => feature.id),
    'feature',
  );
  unique(
    data.walkthroughs.map((walkthrough) => walkthrough.id),
    'walkthrough',
  );
  unique(
    data.observations.map((observation) => observation.id),
    'observation',
  );
  const bodies = new Set(data.bodies.map((body) => body.name));
  const observations = new Set(data.observations.map((observation) => observation.id));
  const walkthroughs = new Set(data.walkthroughs.map((walkthrough) => walkthrough.id));
  const views = [data.view, ...data.walkthroughs.flatMap((w) => w.stops.map((stop) => stop.view))];
  for (const view of views) {
    if (!bodies.has(view.body) || !data.projections.includes(view.projection)) {
      throw new Error("a view in the map world's data names a body or projection it lacks");
    }
  }
  for (const feature of data.features) {
    if (!bodies.has(feature.body)) throw new Error('a feature names a body the world lacks');
  }
  for (const observation of data.observations) {
    if (!bodies.has(observation.viewpoint.body)) {
      throw new Error('an observation names a body the world lacks');
    }
    if (observation.walkthroughId !== null && !walkthroughs.has(observation.walkthroughId)) {
      throw new Error('an observation names a walkthrough the world lacks');
    }
  }
  const clock = data.clock;
  const within = (time: string): boolean => {
    const at = Date.parse(time);
    return (
      clock !== null &&
      (clock.start === null || at >= Date.parse(clock.start)) &&
      (clock.end === null || at <= Date.parse(clock.end))
    );
  };
  if (clock && !within(clock.time)) throw new Error("the map world's clock starts off its range");
  for (const stop of data.walkthroughs.flatMap((walkthrough) => walkthrough.stops)) {
    if (stop.observationId !== null && !observations.has(stop.observationId)) {
      throw new Error('a stop names an observation the world lacks');
    }
    if (stop.clock && !within(stop.clock.time)) {
      throw new Error("a stop sets a time off the world's clock, or the world has no clock");
    }
  }
}

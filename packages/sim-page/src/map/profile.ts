// The map and globe tool profile, tabdock.map.v1 (ADR 0038): its names,
// groups, annotations and descriptions, and the zod schemas that are at once
// the page's own argument check and, converted, the JSON Schema clients see.
// It is a convention among pages, not protocol: nothing in the relay or the
// adapter reads a name here, since a hostile page can register these names
// with any behaviour, and roles and prompts must keep depending on
// annotations and policy alone.

import type { PolicyInput } from '@tabdock/protocol';
import { z } from 'zod';

/** The marker get_view carries, so one read tells a client the page follows this profile and which version. */
export const MAP_PROFILE = 'tabdock.map.v1';

/** One ASCII line each, so a first-class listing shows every description whole (ADR 0038, decision 16). */
export const MAP_MAX_DESCRIPTION_CHARS = 200;
export const MAP_MAX_FEATURES = 200;
export const MAP_DEFAULT_FEATURES = 50;
export const MAP_MAX_OBSERVATIONS = 200;
export const MAP_DEFAULT_OBSERVATIONS = 100;
export const MAP_MAX_LAYERS = 100;
export const MAP_MAX_WALKTHROUGHS = 50;
export const MAP_MAX_STOPS = 1000;
export const MAP_MAX_ID_CHARS = 64;
export const MAP_MAX_KIND_CHARS = 40;
export const MAP_MAX_TITLE_CHARS = 200;
export const MAP_MAX_TEXT_CHARS = 4000;
export const MAP_MAX_URL_CHARS = 2048;
export const MAP_MAX_FOOTPRINT_POSITIONS = 1000;
export const MAP_MAX_NOTES = 10;
export const MAP_MAX_NOTE_CHARS = 500;
export const MAP_MAX_CAPTURE_DESCRIPTION_CHARS = 2000;
export const MAP_MIN_CAPTURE_WIDTH_PX = 64;
export const MAP_DEFAULT_CAPTURE_WIDTH_PX = 1024;
export const MAP_MAX_CAPTURE_WIDTH_PX = 2048;
/** Widths and altitudes in metres stay below this, far past any body's size. */
export const MAP_MAX_DISTANCE_M = 1e10;
/** Simulated seconds per real second, either way. */
export const MAP_MAX_RATE = 1e6;
/** The projection name reserved for a 3D globe; every other name is a 2D map. */
export const GLOBE = 'globe';

export const MAP_TOOL_GROUPS = [
  'view',
  'capture',
  'clock',
  'layers',
  'features',
  'walkthroughs',
  'observations',
] as const;
export type MapToolGroup = (typeof MAP_TOOL_GROUPS)[number];

export const MAP_TOOL_NAMES = [
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
] as const;
export type MapToolName = (typeof MAP_TOOL_NAMES)[number];

/** The worked examples' own editing tools, beside the profile and not part of it. */
export const MAP_EDIT_TOOL_NAMES = ['edit_stop', 'reset_edits'] as const;
export type MapEditToolName = (typeof MAP_EDIT_TOOL_NAMES)[number];

export interface MapToolInfo {
  readonly name: MapToolName | MapEditToolName;
  /** null for the editing tools, which belong to no group of the profile. */
  readonly group: MapToolGroup | null;
  readonly readOnly: boolean;
  /** Results quote text authors or third parties wrote, or carry an image. */
  readonly untrustedContent: boolean;
  readonly consequential: boolean;
  readonly title: string;
  readonly description: string;
}

function read(
  name: MapToolName,
  group: MapToolGroup,
  title: string,
  description: string,
  untrustedContent = false,
): MapToolInfo {
  return {
    name,
    group,
    readOnly: true,
    untrustedContent,
    consequential: false,
    title,
    description,
  };
}

function write(
  name: MapToolName | MapEditToolName,
  group: MapToolGroup | null,
  title: string,
  description: string,
  consequential = false,
): MapToolInfo {
  return {
    name,
    group,
    readOnly: false,
    untrustedContent: false,
    consequential,
    title,
    description,
  };
}

/** The fourteen profile tools in the table's order (ADR 0038). */
export const MAP_PROFILE_TOOLS: readonly MapToolInfo[] = [
  read(
    'get_view',
    'view',
    'Get view',
    'Return the camera view: body, projection, centre lon and lat in degrees, widthM across the centre, headingDeg, pitchDeg, bounds, and altitudeM and fovDeg on a globe.',
  ),
  write(
    'set_view',
    'view',
    'Set view',
    "Move the camera to any of get_view's fields but profile and bounds: widthM or altitudeM, not both, and altitudeM or fovDeg only on a globe. Returns the view it set.",
  ),
  read(
    'capture_view',
    'capture',
    'Capture view',
    'Return a png or jpeg image of the view at most maxWidthPx wide (64 to 2048, default 1024) with the view as JSON text, or that text alone where the page returns no images.',
    true,
  ),
  read(
    'get_clock',
    'clock',
    'Get clock',
    'Return the clock: time as UTC ISO 8601, rate in simulated seconds per real second, whether it is playing, and the start and end the time may be set between.',
  ),
  write(
    'set_clock',
    'clock',
    'Set clock',
    "Set the clock's time (UTC ISO 8601 ending in Z, between get_clock's start and end), rate (-1e6 to 1e6) or playing. Returns the clock it set.",
  ),
  read(
    'list_layers',
    'layers',
    'List layers',
    'List the layers: id, title, kind (base or overlay), whether visible, and opacity from 0 to 1.',
    true,
  ),
  write(
    'set_layer',
    'layers',
    'Set layer',
    "Show, hide or fade one layer by id. Showing a base layer hides the other base layers. Returns the layer's id, visible and opacity.",
  ),
  read(
    'features_in_view',
    'features',
    'Features in view',
    'List named features in the view, most prominent first, then nearest the centre: at most limit (1 to 200, default 50), with total and truncated. kind filters them.',
    true,
  ),
  read(
    'list_walkthroughs',
    'walkthroughs',
    'List walkthroughs',
    'List the guided walkthroughs with id, title and stopCount, and the current walkthroughId and stopIndex, or null.',
    true,
  ),
  read(
    'get_stop',
    'walkthroughs',
    'Get stop',
    'Return one walkthrough stop by index from 0, the current stop by default: its title, text, view, clock or null, and observationId or null.',
    true,
  ),
  write(
    'go_to_stop',
    'walkthroughs',
    'Go to stop',
    'Move the page to the stop at index (0 to stopCount - 1) of walkthroughId, the current walkthrough by default. Returns the stop, its view and the clock.',
  ),
  read(
    'list_observations',
    'observations',
    'List observations',
    'List observations such as photos by time: id, title, kind, time and walkthroughId, filtered by walkthroughId or from and to times, at most limit (1 to 200, default 100).',
    true,
  ),
  read(
    'get_observation',
    'observations',
    'Get observation',
    'Return one observation: its camera viewpoint, its GeoJSON footprint or null, its source and quality notes, and whether it is on screen.',
    true,
  ),
  write(
    'view_from_observation',
    'observations',
    'View from observation',
    "Move the camera to an observation's viewpoint, on the globe where the page has one, to compare the photo with the render. Returns the observationId and the view.",
  ),
];

/** edit_stop and reset_edits: a write and the worked examples' one consequential tool. */
export const MAP_EDIT_TOOLS: readonly MapToolInfo[] = [
  write(
    'edit_stop',
    null,
    'Edit stop',
    "Change a walkthrough stop's title or text until reset_edits. Returns which fields it changed.",
  ),
  write(
    'reset_edits',
    null,
    'Reset edits',
    'Discard every edit_stop change made since the page loaded. This cannot be undone.',
    true,
  ),
];

/** What a page registers for a tool: reads say so, writes say they are not consequential unless one is. */
export function mapAnnotations(info: MapToolInfo): Record<string, boolean> {
  if (info.readOnly) {
    return info.untrustedContent
      ? { readOnlyHint: true, untrustedContentHint: true }
      : { readOnlyHint: true };
  }
  return { readOnlyHint: false, consequentialHint: info.consequential };
}

/**
 * The worked examples' policy. The profile marks no tool consequential, and
 * on runtimes that drop the hint (MCP-B 5.x, Chrome 153) a page that names
 * none has every write prompt (ADR 0034), which would ask the operator at
 * every camera move; so a map page names its own consequential tools, here
 * the one irreversible tool, and never passes an empty list.
 */
export const MAP_PAGE_POLICY = {
  consequentialTools: ['reset_edits'],
} as const satisfies PolicyInput;

// Building blocks. Every fixed bound is a JSON Schema keyword, so the
// relay's advisory check reports a mistake in its own words; that check
// drops pattern and format, so handlers parse with these same schemas.

export const MapIdSchema = z
  .string()
  .min(1)
  .max(MAP_MAX_ID_CHARS)
  .regex(/^[A-Za-z0-9_.:-]+$/);
/** Lower-case English IAU names, such as moon or mars. */
export const BodySchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);
export const ProjectionSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9-]*$/);
export const KindSchema = z
  .string()
  .min(1)
  .max(MAP_MAX_KIND_CHARS)
  .regex(/^[a-z][a-z0-9_-]*$/);
export const LonSchema = z.number().min(-180).max(180);
export const LatSchema = z.number().min(-90).max(90);
export const WidthMSchema = z.number().gt(0).max(MAP_MAX_DISTANCE_M);
export const AltitudeMSchema = z.number().min(0).max(MAP_MAX_DISTANCE_M);
export const HeadingDegSchema = z.number().min(0).lt(360);
export const PitchDegSchema = z.number().min(-90).max(90);
export const FovDegSchema = z.number().gt(0).lt(180);
export const RateSchema = z.number().min(-MAP_MAX_RATE).max(MAP_MAX_RATE);
export const OpacitySchema = z.number().min(0).max(1);
export const StopIndexSchema = z
  .int()
  .min(0)
  .max(MAP_MAX_STOPS - 1);
export const TitleSchema = z.string().max(MAP_MAX_TITLE_CHARS);

const UTC_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/**
 * A UTC ISO 8601 time: YYYY-MM-DDTHH:MM:SS, an optional fraction of up to
 * three digits, then Z, naming a real instant (no 30 February).
 */
export function isUtcIsoTime(text: string): boolean {
  const match = UTC_TIME.exec(text);
  if (!match) return false;
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) return false;
  // Date.parse rolls 30 February over into March; the instant must read back as written.
  return new Date(ms).toISOString().slice(0, 19) === text.slice(0, 19);
}

/**
 * zod's own datetime check would put a pattern of about 400 characters into
 * every listing (docs/notes/verified.md), so the strict rule is a refinement
 * the handler runs, and clients see format and a length.
 */
export const IsoTimeSchema = z
  .string()
  .max(30)
  .refine(isUtcIsoTime, { message: 'a time is UTC ISO 8601 ending in Z' })
  .meta({ format: 'date-time' });

/** The JSON Schema clients see for a tool: zod's input form, without the $schema marker every listing would repeat. */
export function toInputSchema(schema: z.ZodType): Record<string, unknown> {
  const json: Record<string, unknown> = { ...z.toJSONSchema(schema, { io: 'input' }) };
  delete json.$schema;
  return json;
}

/** At least `count` fields, which JSON Schema states as minProperties and zod as a refinement. */
function minFields(count: number) {
  return (value: Record<string, unknown>, ctx: z.RefinementCtx): void => {
    const given = Object.values(value).filter((field) => field !== undefined).length;
    if (given < count) {
      ctx.addIssue({
        code: 'custom',
        message: count === 1 ? 'give at least one field' : `give at least ${String(count)} fields`,
      });
    }
  };
}

export interface MapInputOptions {
  /** The bodies the page shows, which narrow body to their names; any IAU-style name unless given. */
  readonly bodies?: readonly [string, ...string[]];
  /** The projections the page draws, likewise. */
  readonly projections?: readonly [string, ...string[]];
}

/**
 * Each tool's argument schema, the profile's fourteen and the two editing
 * tools, as zod. Cross-field rules are refinements only a handler runs; the
 * converted schemas carry every fixed bound and use only keywords valid in
 * both JSON Schema 2019-09 and 2020-12, since the SDK's validator defaults to
 * 2019-09 (no prefixItems, no $ref).
 */
export function mapInputs(options: MapInputOptions = {}) {
  for (const body of options.bodies ?? []) BodySchema.parse(body);
  for (const projection of options.projections ?? []) ProjectionSchema.parse(projection);
  const body = options.bodies ? z.enum(options.bodies) : BodySchema;
  const projection = options.projections ? z.enum(options.projections) : ProjectionSchema;
  return {
    get_view: z.strictObject({}),
    set_view: z
      .strictObject({
        body: body.optional(),
        projection: projection.optional(),
        lon: LonSchema.optional(),
        lat: LatSchema.optional(),
        widthM: WidthMSchema.optional().describe(
          'Ground distance across the view through its centre',
        ),
        altitudeM: AltitudeMSchema.optional().describe(
          "Height above the body's mean radius, globe only",
        ),
        headingDeg: HeadingDegSchema.optional().describe(
          'Clockwise from north, at the top of the view',
        ),
        pitchDeg: PitchDegSchema.optional().describe('-90 looks straight down, 0 at the horizon'),
        fovDeg: FovDegSchema.optional().describe('Horizontal field of view, globe only'),
      })
      .superRefine(minFields(1))
      .superRefine((value, ctx) => {
        if (value.widthM !== undefined && value.altitudeM !== undefined) {
          ctx.addIssue({ code: 'custom', message: 'give widthM or altitudeM, not both' });
        }
        const flat = value.projection !== undefined && value.projection !== GLOBE;
        if (flat && (value.altitudeM !== undefined || value.fovDeg !== undefined)) {
          ctx.addIssue({ code: 'custom', message: 'altitudeM and fovDeg apply only to a globe' });
        }
      })
      .meta({ minProperties: 1 }),
    capture_view: z.strictObject({
      maxWidthPx: z
        .int()
        .min(MAP_MIN_CAPTURE_WIDTH_PX)
        .max(MAP_MAX_CAPTURE_WIDTH_PX)
        .optional()
        .describe('Widest image to return, in pixels'),
      format: z.enum(['png', 'jpeg']).optional(),
    }),
    get_clock: z.strictObject({}),
    set_clock: z
      .strictObject({
        time: IsoTimeSchema.optional(),
        rate: RateSchema.optional().describe('Simulated seconds per real second'),
        playing: z.boolean().optional(),
      })
      .superRefine(minFields(1))
      .meta({ minProperties: 1 }),
    list_layers: z.strictObject({}),
    set_layer: z
      .strictObject({
        id: MapIdSchema,
        visible: z.boolean().optional(),
        opacity: OpacitySchema.optional(),
      })
      .superRefine(minFields(2))
      .meta({ minProperties: 2 }),
    features_in_view: z.strictObject({
      limit: z.int().min(1).max(MAP_MAX_FEATURES).optional(),
      kind: KindSchema.optional(),
    }),
    list_walkthroughs: z.strictObject({}),
    get_stop: z.strictObject({
      walkthroughId: MapIdSchema.optional(),
      index: StopIndexSchema.optional(),
    }),
    go_to_stop: z.strictObject({
      walkthroughId: MapIdSchema.optional(),
      index: StopIndexSchema,
    }),
    list_observations: z.strictObject({
      walkthroughId: MapIdSchema.optional(),
      from: IsoTimeSchema.optional(),
      to: IsoTimeSchema.optional(),
      limit: z.int().min(1).max(MAP_MAX_OBSERVATIONS).optional(),
    }),
    get_observation: z.strictObject({ id: MapIdSchema }),
    view_from_observation: z.strictObject({ id: MapIdSchema }),
    edit_stop: z
      .strictObject({
        walkthroughId: MapIdSchema,
        index: StopIndexSchema,
        title: z.string().min(1).max(MAP_MAX_TITLE_CHARS).optional(),
        text: z.string().max(MAP_MAX_TEXT_CHARS).optional(),
      })
      .superRefine(minFields(3))
      .meta({ minProperties: 3 }),
    reset_edits: z.strictObject({}),
  } as const;
}

export type MapInputs = ReturnType<typeof mapInputs>;

/** The sixteen JSON Schemas, as clients see them. */
export function mapInputSchemas(
  options: MapInputOptions = {},
): Record<keyof MapInputs, Record<string, unknown>> {
  const inputs = mapInputs(options);
  const out = {} as Record<keyof MapInputs, Record<string, unknown>>;
  for (const name of Object.keys(inputs) as (keyof MapInputs)[]) {
    out[name] = toInputSchema(inputs[name]);
  }
  return out;
}

// Result shapes. The relay never parses these; clients, walkers and tests
// do. They are plain objects, not strict, since a page may add result
// fields within v1.

export const BoundsSchema = z.object({
  west: LonSchema,
  south: LatSchema,
  east: LonSchema,
  north: LatSchema,
});

/** altitudeM and fovDeg describe a globe's camera, so they are present exactly when the projection is a globe. */
function globeFieldsRule(
  value: { projection: string; altitudeM?: number | undefined; fovDeg?: number | undefined },
  ctx: z.RefinementCtx,
): void {
  const globe = value.projection === GLOBE;
  if (globe !== (value.altitudeM !== undefined) || globe !== (value.fovDeg !== undefined)) {
    ctx.addIssue({
      code: 'custom',
      message: 'altitudeM and fovDeg are present exactly on a globe',
    });
  }
}

const viewFields = {
  body: BodySchema,
  projection: ProjectionSchema,
  lon: LonSchema,
  lat: LatSchema,
  widthM: WidthMSchema,
  headingDeg: HeadingDegSchema,
  pitchDeg: PitchDegSchema,
  altitudeM: AltitudeMSchema.optional(),
  fovDeg: FovDegSchema.optional(),
};

export const MapViewSchema = z
  .object({
    profile: z.literal(MAP_PROFILE),
    ...viewFields,
    bounds: BoundsSchema.nullable(),
  })
  .superRefine(globeFieldsRule);
export type MapView = z.infer<typeof MapViewSchema>;

/** A stop's view: get_view's fields without the marker and bounds, which depend on the screen. */
export const MapStopViewSchema = z.object(viewFields).superRefine(globeFieldsRule);
export type MapStopView = z.infer<typeof MapStopViewSchema>;

export const MapClockSchema = z.object({
  time: IsoTimeSchema,
  rate: RateSchema,
  playing: z.boolean(),
  start: IsoTimeSchema.nullable(),
  end: IsoTimeSchema.nullable(),
});
export type MapClock = z.infer<typeof MapClockSchema>;

export const MapLayerSchema = z.object({
  id: MapIdSchema,
  title: TitleSchema,
  kind: z.enum(['base', 'overlay']),
  visible: z.boolean(),
  opacity: OpacitySchema,
});
export type MapLayer = z.infer<typeof MapLayerSchema>;

export const ListLayersResultSchema = z.object({
  layers: z.array(MapLayerSchema).max(MAP_MAX_LAYERS),
});

export const SetLayerResultSchema = z.object({
  id: MapIdSchema,
  visible: z.boolean(),
  opacity: OpacitySchema,
});

export const MapFeatureSchema = z.object({
  id: MapIdSchema,
  name: TitleSchema,
  kind: KindSchema,
  lon: LonSchema,
  lat: LatSchema,
});
export type MapFeature = z.infer<typeof MapFeatureSchema>;

export const FeaturesInViewResultSchema = z.object({
  features: z.array(MapFeatureSchema).max(MAP_MAX_FEATURES),
  total: z.int().min(0),
  truncated: z.boolean(),
});

export const WalkthroughSummarySchema = z.object({
  id: MapIdSchema,
  title: TitleSchema,
  stopCount: z.int().min(1).max(MAP_MAX_STOPS),
});
export type WalkthroughSummary = z.infer<typeof WalkthroughSummarySchema>;

export const CurrentStopSchema = z.object({
  walkthroughId: MapIdSchema,
  stopIndex: StopIndexSchema,
});

export const ListWalkthroughsResultSchema = z.object({
  walkthroughs: z.array(WalkthroughSummarySchema).max(MAP_MAX_WALKTHROUGHS),
  current: CurrentStopSchema.nullable(),
});

/** A stop's clock: where the page sets the clock on arriving, without the clock's own range. */
export const MapStopClockSchema = z.object({
  time: IsoTimeSchema,
  rate: RateSchema,
  playing: z.boolean(),
});
export type MapStopClock = z.infer<typeof MapStopClockSchema>;

export const MapStopSchema = z.object({
  walkthroughId: MapIdSchema,
  index: StopIndexSchema,
  stopCount: z.int().min(1).max(MAP_MAX_STOPS),
  title: TitleSchema,
  text: z.string().max(MAP_MAX_TEXT_CHARS),
  view: MapStopViewSchema,
  clock: MapStopClockSchema.nullable(),
  observationId: MapIdSchema.nullable(),
});
export type MapStop = z.infer<typeof MapStopSchema>;

export const GoToStopResultSchema = z.object({
  walkthroughId: MapIdSchema,
  index: StopIndexSchema,
  stopCount: z.int().min(1).max(MAP_MAX_STOPS),
  view: MapViewSchema,
  clock: MapClockSchema.nullable(),
  observationId: MapIdSchema.nullable(),
});

export const ObservationSummarySchema = z.object({
  id: MapIdSchema,
  title: TitleSchema,
  kind: KindSchema,
  time: IsoTimeSchema,
  walkthroughId: MapIdSchema.nullable(),
});
export type ObservationSummary = z.infer<typeof ObservationSummarySchema>;

export const ListObservationsResultSchema = z.object({
  observations: z.array(ObservationSummarySchema).max(MAP_MAX_OBSERVATIONS),
  total: z.int().min(0),
  truncated: z.boolean(),
});

export const MapViewpointSchema = z.object({
  body: BodySchema,
  lon: LonSchema,
  lat: LatSchema,
  altitudeM: AltitudeMSchema,
  headingDeg: HeadingDegSchema,
  pitchDeg: PitchDegSchema,
  fovDeg: FovDegSchema,
});
export type MapViewpoint = z.infer<typeof MapViewpointSchema>;

/** A [longitude, latitude] pair, in GeoJSON's order (RFC 7946). */
const PositionSchema = z.tuple([LonSchema, LatSchema]);

/** A closed linear ring of four or more positions, its first and last the same (RFC 7946 section 3.1.6). */
const RingSchema = z
  .array(PositionSchema)
  .min(4)
  .refine(
    (ring) => {
      const first = ring[0];
      const last = ring.at(-1);
      return (
        first !== undefined && last !== undefined && first[0] === last[0] && first[1] === last[1]
      );
    },
    { message: 'a ring ends where it starts' },
  );

/**
 * A GeoJSON Polygon or MultiPolygon. One that crosses the antimeridian is cut
 * into a MultiPolygon (RFC 7946 section 3.1.9). Exterior rings should run
 * counterclockwise, but RFC 7946 tells readers not to refuse those that do
 * not, so this checks only closure and size.
 */
export const FootprintSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('Polygon'), coordinates: z.array(RingSchema).min(1) }),
    z.object({
      type: z.literal('MultiPolygon'),
      coordinates: z.array(z.array(RingSchema).min(1)).min(1),
    }),
  ])
  .refine((footprint) => footprintPositions(footprint) <= MAP_MAX_FOOTPRINT_POSITIONS, {
    message: `a footprint holds at most ${String(MAP_MAX_FOOTPRINT_POSITIONS)} positions`,
  });
export type Footprint = z.infer<typeof FootprintSchema>;

/** How many positions a footprint holds, every ring of every polygon counted. */
export function footprintPositions(footprint: {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: unknown[];
}): number {
  const polygons = (
    footprint.type === 'Polygon' ? [footprint.coordinates] : footprint.coordinates
  ) as unknown[][][];
  return polygons.reduce(
    (sum, polygon) => sum + polygon.reduce((inner, ring) => inner + ring.length, 0),
    0,
  );
}

export const MapSourceSchema = z.object({
  name: TitleSchema,
  url: z.string().max(MAP_MAX_URL_CHARS).nullable(),
  credit: TitleSchema.nullable(),
});

export const MapObservationSchema = z.object({
  id: MapIdSchema,
  title: TitleSchema,
  kind: KindSchema,
  time: IsoTimeSchema,
  walkthroughId: MapIdSchema.nullable(),
  viewpoint: MapViewpointSchema,
  footprint: FootprintSchema.nullable(),
  source: MapSourceSchema,
  notes: z.array(z.string().max(MAP_MAX_NOTE_CHARS)).max(MAP_MAX_NOTES),
  onScreen: z.boolean(),
});
export type MapObservation = z.infer<typeof MapObservationSchema>;

export const ViewFromObservationResultSchema = z.object({
  observationId: MapIdSchema,
  view: MapViewSchema,
});

/** capture_view's text form, for a page that returns no images. */
export const CaptureTextSchema = z.object({
  description: z.string().max(MAP_MAX_CAPTURE_DESCRIPTION_CHARS),
  view: MapViewSchema,
  visibleLayers: z.array(MapIdSchema).max(MAP_MAX_LAYERS),
  observationId: MapIdSchema.nullable(),
});

/** The JSON text beside a captured image (ADR 0039's envelope). */
export const CaptureImageTextSchema = z.object({
  view: MapViewSchema,
  visibleLayers: z.array(MapIdSchema).max(MAP_MAX_LAYERS),
  observationId: MapIdSchema.nullable(),
  widthPx: z.int().min(1).max(MAP_MAX_CAPTURE_WIDTH_PX),
  heightPx: z.int().min(1),
});

/** capture_view's image form: ADR 0039's envelope, one image and its text. */
export const CaptureEnvelopeSchema = z.strictObject({
  image: z.strictObject({
    mimeType: z.enum(['image/png', 'image/jpeg']),
    data: z.string().min(1),
  }),
  text: z.string(),
});

export const EditStopResultSchema = z.object({
  walkthroughId: MapIdSchema,
  index: StopIndexSchema,
  edited: z
    .array(z.enum(['title', 'text']))
    .min(1)
    .max(2),
});

export const ResetEditsResultSchema = z.object({ reset: z.int().min(0) });

/**
 * What a map page publishes as its state (ADR 0040): the view and clock as
 * get_view and get_clock return them, the current stop and the observation
 * on screen. No titles or text, so following a room never pushes author
 * prose to every client.
 */
export const MapPageStateSchema = z.object({
  view: MapViewSchema,
  clock: MapClockSchema.nullable(),
  walkthrough: z.object({ id: MapIdSchema, stopIndex: StopIndexSchema }).nullable(),
  observationId: MapIdSchema.nullable(),
});
export type MapPageState = z.infer<typeof MapPageStateSchema>;

/**
 * Each tool's result shape, by name. capture_view's is its text form; a page
 * that declares it an image tool returns CaptureEnvelopeSchema's shape.
 */
export const MAP_RESULT_SCHEMAS = {
  get_view: MapViewSchema,
  set_view: MapViewSchema,
  capture_view: CaptureTextSchema,
  get_clock: MapClockSchema,
  set_clock: MapClockSchema,
  list_layers: ListLayersResultSchema,
  set_layer: SetLayerResultSchema,
  features_in_view: FeaturesInViewResultSchema,
  list_walkthroughs: ListWalkthroughsResultSchema,
  get_stop: MapStopSchema,
  go_to_stop: GoToStopResultSchema,
  list_observations: ListObservationsResultSchema,
  get_observation: MapObservationSchema,
  view_from_observation: ViewFromObservationResultSchema,
  edit_stop: EditStopResultSchema,
  reset_edits: ResetEditsResultSchema,
} as const satisfies Record<MapToolName | MapEditToolName, z.ZodType>;

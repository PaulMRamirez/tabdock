// The map profile's result shapes (tabdock.map.v1, docs/guide/16-map-pages.md)
// that the walk reads, copied so that this directory needs nothing from the
// Tabdock workspace but @tabdock/adapter/testing. Each keeps the name and the
// rules of its original in packages/sim-page/src/map/profile.ts, refinements
// included, and this repository's ci-check-files.test.ts holds every one
// equal to it as JSON Schema and on sample values, so a copy that drifts
// fails there; a copier keeps them as they are, or updates them from the
// guide page when the profile's version changes.

import { z } from 'zod';

export const MAP_PROFILE = 'tabdock.map.v1';
export const MAP_MAX_OBSERVATIONS = 150;
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
export const MAP_MAX_CAPTURE_WIDTH_PX = 2048;
export const MAP_MAX_DISTANCE_M = 1e10;
export const MAP_MAX_RATE = 1e6;
export const GLOBE = 'globe';

export const MapIdSchema = z
  .string()
  .min(1)
  .max(MAP_MAX_ID_CHARS)
  .regex(/^[A-Za-z0-9_.:-]+$/);
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

/**
 * No control character but tab, line feed and carriage return, and no lone
 * surrogate: the profile's rule for text, which its caps are sized by. JSON
 * Schema cannot state it, so the copy carries the refinement itself.
 */
export function isPlainText(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20) {
      if (code !== 0x09 && code !== 0x0a && code !== 0x0d) return false;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function plainText(max: number, min = 0) {
  const sized = min > 0 ? z.string().min(min).max(max) : z.string().max(max);
  return sized.refine(isPlainText, {
    message: 'text holds no control character but tab and line breaks',
  });
}

export const TitleSchema = plainText(MAP_MAX_TITLE_CHARS);

const UTC_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/** A UTC ISO 8601 time ending in Z that names a real instant (no 30 February). */
export function isUtcIsoTime(text: string): boolean {
  if (!UTC_TIME.test(text)) return false;
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) return false;
  return new Date(ms).toISOString().slice(0, 19) === text.slice(0, 19);
}

export const IsoTimeSchema = z
  .string()
  .max(30)
  .refine(isUtcIsoTime, { message: 'a time is UTC ISO 8601 ending in Z' })
  .meta({ format: 'date-time' });

export const BoundsSchema = z.object({
  west: LonSchema,
  south: LatSchema,
  east: LonSchema,
  north: LatSchema,
});

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

export const WalkthroughSummarySchema = z.object({
  id: MapIdSchema,
  title: TitleSchema,
  stopCount: z.int().min(1).max(MAP_MAX_STOPS),
});

export const CurrentStopSchema = z.object({
  walkthroughId: MapIdSchema,
  stopIndex: StopIndexSchema,
});

export const ListWalkthroughsResultSchema = z.object({
  walkthroughs: z.array(WalkthroughSummarySchema).max(MAP_MAX_WALKTHROUGHS),
  current: CurrentStopSchema.nullable(),
});

export const MapStopClockSchema = z.object({
  time: IsoTimeSchema,
  rate: RateSchema,
  playing: z.boolean(),
});

export const MapStopSchema = z.object({
  walkthroughId: MapIdSchema,
  index: StopIndexSchema,
  stopCount: z.int().min(1).max(MAP_MAX_STOPS),
  title: TitleSchema,
  text: plainText(MAP_MAX_TEXT_CHARS),
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

const PositionSchema = z.tuple([LonSchema, LatSchema]);

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

export const MapSourceSchema = z.object({
  name: TitleSchema,
  url: plainText(MAP_MAX_URL_CHARS).nullable(),
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
  notes: z.array(plainText(MAP_MAX_NOTE_CHARS)).max(MAP_MAX_NOTES),
  onScreen: z.boolean(),
});
export type MapObservation = z.infer<typeof MapObservationSchema>;

export const ViewFromObservationResultSchema = z.object({
  observationId: MapIdSchema,
  view: MapViewSchema,
});

export const CaptureImageTextSchema = z.object({
  view: MapViewSchema,
  visibleLayers: z.array(MapIdSchema).max(MAP_MAX_LAYERS),
  visibleLayersOmitted: z.int().min(1).max(MAP_MAX_LAYERS).optional(),
  observationId: MapIdSchema.nullable(),
  widthPx: z.int().min(1).max(MAP_MAX_CAPTURE_WIDTH_PX),
  heightPx: z.int().min(1),
});

export const MapPageStateSchema = z.object({
  view: MapViewSchema,
  clock: MapClockSchema.nullable(),
  walkthrough: z.object({ id: MapIdSchema, stopIndex: StopIndexSchema }).nullable(),
  observationId: MapIdSchema.nullable(),
});
export type MapPageState = z.infer<typeof MapPageStateSchema>;

/** Every copied schema by its original's name, for the drift test. */
export const COPIED_SCHEMAS = {
  MapViewSchema,
  MapStopViewSchema,
  MapClockSchema,
  ListWalkthroughsResultSchema,
  MapStopSchema,
  GoToStopResultSchema,
  ListObservationsResultSchema,
  MapObservationSchema,
  ViewFromObservationResultSchema,
  CaptureImageTextSchema,
  MapPageStateSchema,
} as const;

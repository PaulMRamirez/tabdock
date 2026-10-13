// Draws the map demo's world on a plain 2D canvas, with no map library:
// space around the globe and past the flat map's poles, the ocean, the land,
// the lakes, a 30 degree graticule, the observations' outlines, the names
// that fit and a north arrow turned by the heading, in that order, each
// layer at its own opacity. It always draws from straight
// above and leaves pitch as a number the tools report. It reads only the
// scene it is given (the world's state, or a drag's view before it lands),
// sets its colours, line widths and one font itself and reads no clock,
// random number or window size, so one view always draws, and captures, to
// the same pixels in one browser. It follows tests/map-page's drawing but
// imports nothing from it.

import {
  type MapCamera,
  type MapFeature,
  type MapLayer,
  type MapObservation,
  type MapViewport,
  type MapWorld,
  projectToScreen,
} from '@tabdock/sim-page/map';
import { type Geography, type Ring, ringTwiceArea } from './decode.ts';
import {
  densify,
  flatProjector,
  type FlatProjector,
  globeProjector,
  type GlobeProjector,
  globeRing,
  isGlobe,
  type LonLat,
  type Pixel,
} from './projection.ts';

export const COLORS = {
  space: '#0b1020',
  ocean: '#24577f',
  land: '#e6dcbf',
  coast: '#6b5a39',
  limb: '#8ec5ff',
  graticule: '#ffffff',
  outline: '#ff9f43',
  onScreen: '#ff5f1f',
  dot: '#ffd43b',
  label: '#ffffff',
  halo: '#0b1020',
  arrow: '#ffffff',
} as const;

/** The label font's size, coast width and dot radius in viewport pixels, before DrawOptions.scale. */
const LABEL_PX = 13;
const COAST_WIDTH = 0.8;
const DOT_RADIUS = 3;

/** What one frame draws: the world's state, with a view that may be a drag's, not yet the world's. */
export interface MapScene {
  readonly view: MapCamera;
  readonly radiusM: number;
  readonly layers: readonly MapLayer[];
  readonly features: readonly MapFeature[];
  readonly observations: readonly MapObservation[];
}

/** The world as it stands, or with `view` in place of its own while a drag is under way. */
export function sceneOf(world: MapWorld, view?: MapCamera): MapScene {
  return {
    view: view ?? world.view(),
    radiusM: world.radiusM,
    layers: world.layers(),
    features: world.bodyFeatures(),
    observations: world.bodyObservations(),
  };
}

interface Box {
  readonly west: number;
  readonly east: number;
  readonly south: number;
  readonly north: number;
}

interface PreparedRing {
  readonly points: readonly LonLat[];
  readonly cut: readonly boolean[];
  /** The ring in 2 degree steps, for the globe's lines. */
  readonly dense: readonly LonLat[];
  readonly denseCut: readonly boolean[];
  /**
   * The same steps counterclockwise, for the globe's fill: an even-odd fill
   * adds up each ring's own inside, so a hole is filled as the water it
   * holds, and globeRing reads the inside as what lies on a ring's left.
   */
  readonly fill: readonly LonLat[];
}

interface PreparedPolygon {
  readonly rings: readonly PreparedRing[];
  readonly box: Box;
}

/** The geography, densified and boxed once, so a frame only projects. */
export interface PreparedEarth {
  readonly land: readonly PreparedPolygon[];
  readonly lakes: readonly PreparedPolygon[];
  readonly graticule: readonly (readonly LonLat[])[];
  /** Each feature's rank, lower first, so the more prominent names win a crowded place. */
  readonly ranks: ReadonlyMap<string, number>;
}

function boxOf(rings: readonly (readonly LonLat[])[]): Box {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
  }
  return { west, east, south, north };
}

function prepareRing(ring: readonly LonLat[]): PreparedRing {
  const sparse = densify(ring, Infinity);
  const dense = densify(ring);
  const fill = ringTwiceArea(ring) < 0 ? [...dense.points].reverse() : dense.points;
  return {
    points: sparse.points,
    cut: sparse.cut,
    dense: dense.points,
    denseCut: dense.cut,
    fill,
  };
}

export function preparePolygon(rings: readonly (readonly LonLat[])[]): PreparedPolygon {
  return { rings: rings.map(prepareRing), box: boxOf(rings) };
}

function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let value = from; value <= to + 1e-9; value += step) out.push(value);
  return out;
}

export function prepareEarth(
  geography: Geography,
  ranks: ReadonlyMap<string, number>,
): PreparedEarth {
  const meridians = range(-180, 150, 30).map((lon) =>
    range(-90, 90, 2).map((lat): LonLat => [lon, lat]),
  );
  const parallels = range(-60, 60, 30).map((lat) =>
    range(-180, 180, 2).map((lon): LonLat => [lon, lat]),
  );
  return {
    land: geography.land.map(preparePolygon),
    lakes: geography.lakes.map((lake) => preparePolygon(lake.rings)),
    graticule: [...meridians, ...parallels],
    ranks,
  };
}

function layerAlpha(scene: MapScene, id: string): number | null {
  const layer = scene.layers.find((entry) => entry.id === id);
  return layer?.visible ? layer.opacity : null;
}

/** Whether a box, as one copy of the flat map draws it, can reach the viewport. */
function copyReaches(flat: FlatProjector, viewport: MapViewport, box: Box, copy: number): boolean {
  const corners = [
    flat.project(box.west, box.south, copy),
    flat.project(box.west, box.north, copy),
    flat.project(box.east, box.south, copy),
    flat.project(box.east, box.north, copy),
  ];
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  return (
    Math.max(...xs) >= 0 &&
    Math.min(...xs) <= viewport.widthPx &&
    Math.max(...ys) >= 0 &&
    Math.min(...ys) <= viewport.heightPx
  );
}

/** Adds every ring of a polygon, in every copy that reaches the view, to the current path. */
function tracePolygonFlat(
  ctx: CanvasRenderingContext2D,
  flat: FlatProjector,
  viewport: MapViewport,
  polygon: PreparedPolygon,
): boolean {
  let traced = false;
  for (const copy of flat.copies) {
    if (!copyReaches(flat, viewport, polygon.box, copy)) continue;
    for (const ring of polygon.rings) {
      ring.points.forEach(([lon, lat], index) => {
        const at = flat.project(lon, lat, copy);
        if (index === 0) ctx.moveTo(at.x, at.y);
        else ctx.lineTo(at.x, at.y);
      });
      ctx.closePath();
    }
    traced = true;
  }
  return traced;
}

function strokeRingFlat(
  ctx: CanvasRenderingContext2D,
  flat: FlatProjector,
  viewport: MapViewport,
  polygon: PreparedPolygon,
): void {
  for (const copy of flat.copies) {
    if (!copyReaches(flat, viewport, polygon.box, copy)) continue;
    for (const ring of polygon.rings) {
      let drawing = false;
      ring.points.forEach(([lon, lat], index) => {
        const at = flat.project(lon, lat, copy);
        if (drawing && ring.cut[index - 1] !== true) ctx.lineTo(at.x, at.y);
        else ctx.moveTo(at.x, at.y);
        drawing = true;
      });
    }
  }
}

function traceOutline(ctx: CanvasRenderingContext2D, outline: readonly Pixel[]): void {
  outline.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.closePath();
}

function traceLimb(ctx: CanvasRenderingContext2D, globe: GlobeProjector): void {
  ctx.moveTo(globe.cx + globe.radiusPx, globe.cy);
  ctx.arc(globe.cx, globe.cy, globe.radiusPx, 0, 2 * Math.PI);
  ctx.closePath();
}

/** Adds a polygon's visible part on the globe to the current path, for an even-odd fill. */
function tracePolygonGlobe(
  ctx: CanvasRenderingContext2D,
  globe: GlobeProjector,
  polygon: PreparedPolygon,
): boolean {
  let traced = false;
  for (const ring of polygon.rings) {
    const shown = globeRing(globe, ring.fill);
    if (shown.kind === 'hidden') {
      // Only a ring round the whole visible half, counterclockwise, shows anything: all of it.
      if (shown.turns === 1) {
        traceLimb(ctx, globe);
        traced = true;
      }
      continue;
    }
    traceOutline(ctx, shown.outline);
    if (shown.holdsAntipode) traceLimb(ctx, globe);
    traced = true;
  }
  return traced;
}

/** Strokes a line through lon and lat points where the globe shows it, ending runs on the limb. */
function strokeGlobe(
  ctx: CanvasRenderingContext2D,
  globe: GlobeProjector,
  points: readonly LonLat[],
  cut?: readonly boolean[],
): void {
  let previous: ReturnType<GlobeProjector['project']> | null = null;
  points.forEach(([lon, lat], index) => {
    const at = globe.project(lon, lat);
    const joined = previous !== null && cut?.[index - 1] !== true;
    if (at.facing >= 0) {
      if (joined && previous && previous.facing >= 0) {
        ctx.lineTo(at.x, at.y);
      } else if (joined && previous) {
        const t = previous.facing / (previous.facing - at.facing);
        ctx.moveTo(previous.x + (at.x - previous.x) * t, previous.y + (at.y - previous.y) * t);
        ctx.lineTo(at.x, at.y);
      } else {
        ctx.moveTo(at.x, at.y);
      }
    } else if (joined && previous && previous.facing >= 0) {
      const t = previous.facing / (previous.facing - at.facing);
      ctx.lineTo(previous.x + (at.x - previous.x) * t, previous.y + (at.y - previous.y) * t);
    }
    previous = at;
  });
}

function strokeLineFlat(
  ctx: CanvasRenderingContext2D,
  flat: FlatProjector,
  points: readonly LonLat[],
): void {
  for (const copy of flat.copies) {
    points.forEach(([lon, lat], index) => {
      const at = flat.project(lon, lat, copy);
      if (index === 0) ctx.moveTo(at.x, at.y);
      else ctx.lineTo(at.x, at.y);
    });
  }
}

function drawGround(
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  viewport: MapViewport,
  earth: PreparedEarth,
  globe: GlobeProjector | null,
  flat: FlatProjector | null,
  scale: number,
): void {
  if (globe) {
    ctx.fillStyle = COLORS.space;
    ctx.fillRect(0, 0, viewport.widthPx, viewport.heightPx);
    ctx.fillStyle = COLORS.ocean;
    ctx.beginPath();
    traceLimb(ctx, globe);
    ctx.fill();
  } else if (flat) {
    // Past either pole there is no Earth to draw, so space shows there, as
    // around the globe, and a map zoomed far out reads as a strip of world,
    // not an endless sea. The sea is each copy's band from pole to pole, in
    // one path, so no seam shows where two copies meet.
    ctx.fillStyle = COLORS.space;
    ctx.fillRect(0, 0, viewport.widthPx, viewport.heightPx);
    ctx.fillStyle = COLORS.ocean;
    ctx.beginPath();
    for (const copy of flat.copies) {
      const corners: readonly LonLat[] = [
        [-180, -90],
        [180, -90],
        [180, 90],
        [-180, 90],
      ];
      corners.forEach(([lon, lat], index) => {
        const at = flat.project(lon, lat, copy);
        if (index === 0) ctx.moveTo(at.x, at.y);
        else ctx.lineTo(at.x, at.y);
      });
      ctx.closePath();
    }
    ctx.fill();
  }
  const fillLayer = (polygons: readonly PreparedPolygon[], alpha: number, color: string): void => {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    for (const polygon of polygons) {
      ctx.beginPath();
      const traced = globe
        ? tracePolygonGlobe(ctx, globe, polygon)
        : flat !== null && tracePolygonFlat(ctx, flat, viewport, polygon);
      if (traced) ctx.fill('evenodd');
    }
    ctx.strokeStyle = COLORS.coast;
    ctx.lineWidth = COAST_WIDTH * scale;
    ctx.beginPath();
    for (const polygon of polygons) {
      if (globe) {
        for (const ring of polygon.rings) strokeGlobe(ctx, globe, ring.dense, ring.denseCut);
      } else if (flat) {
        strokeRingFlat(ctx, flat, viewport, polygon);
      }
    }
    ctx.stroke();
  };
  const land = layerAlpha(scene, 'land');
  if (land !== null) fillLayer(earth.land, land, COLORS.land);
  const lakes = layerAlpha(scene, 'lakes');
  if (lakes !== null) fillLayer(earth.lakes, lakes, COLORS.ocean);
  if (globe) {
    // A thin rim of light marks the limb, so the globe reads as a sphere against space.
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = COLORS.limb;
    ctx.lineWidth = 1.5 * scale;
    ctx.beginPath();
    traceLimb(ctx, globe);
    ctx.stroke();
  }
}

function drawGraticule(
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  earth: PreparedEarth,
  globe: GlobeProjector | null,
  flat: FlatProjector | null,
  scale: number,
): void {
  const alpha = layerAlpha(scene, 'graticule');
  if (alpha === null) return;
  ctx.globalAlpha = alpha * 0.6;
  ctx.strokeStyle = COLORS.graticule;
  ctx.lineWidth = 0.75 * scale;
  ctx.beginPath();
  for (const line of earth.graticule) {
    if (globe) strokeGlobe(ctx, globe, line);
    else if (flat) strokeLineFlat(ctx, flat, line);
  }
  ctx.stroke();
}

function footprintRings(observation: MapObservation): Ring[] {
  const footprint = observation.footprint;
  if (!footprint) return [];
  const polygons = footprint.type === 'Polygon' ? [footprint.coordinates] : footprint.coordinates;
  return polygons.flat().map((ring) => ring.map(([lon, lat]) => [lon, lat] as [number, number]));
}

function drawOutlines(
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  viewport: MapViewport,
  globe: GlobeProjector | null,
  flat: FlatProjector | null,
  scale: number,
): void {
  const alpha = layerAlpha(scene, 'outlines');
  if (alpha === null) return;
  ctx.globalAlpha = alpha;
  for (const observation of scene.observations) {
    const polygon = preparePolygon(footprintRings(observation));
    ctx.strokeStyle = observation.onScreen ? COLORS.onScreen : COLORS.outline;
    ctx.lineWidth = (observation.onScreen ? 3 : 1.5) * scale;
    ctx.beginPath();
    if (globe) {
      for (const ring of polygon.rings) strokeGlobe(ctx, globe, ring.dense, ring.denseCut);
    } else if (flat) {
      strokeRingFlat(ctx, flat, viewport, polygon);
    }
    ctx.stroke();
  }
}

interface Placed {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

function overlaps(a: Placed, b: Placed): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * A dot for each feature in view and its name where the name fits: the
 * most prominent first, each to the right of its dot, or to the left near
 * the right edge, and none over another or the north arrow. Points go through projectToScreen,
 * so a name is drawn exactly where features_in_view calls it in view.
 */
function drawNames(
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  viewport: MapViewport,
  earth: PreparedEarth,
  scale: number,
): void {
  const alpha = layerAlpha(scene, 'names');
  if (alpha === null) return;
  const shown = scene.features
    .map((feature) => ({
      feature,
      at: projectToScreen(scene.view, viewport, scene.radiusM, feature.lon, feature.lat),
    }))
    .filter(
      (entry): entry is { feature: MapFeature; at: Pixel } =>
        entry.at !== null &&
        entry.at.x >= 0 &&
        entry.at.x <= viewport.widthPx &&
        entry.at.y >= 0 &&
        entry.at.y <= viewport.heightPx,
    )
    .sort(
      (a, b) =>
        (earth.ranks.get(a.feature.id) ?? 9) - (earth.ranks.get(b.feature.id) ?? 9) ||
        (a.feature.id < b.feature.id ? -1 : 1),
    );
  ctx.globalAlpha = alpha;
  ctx.font = `${String(LABEL_PX * scale)}px sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  // The north arrow's corner is taken before any name, so none is drawn under it.
  const placed: Placed[] = [
    { left: viewport.widthPx - 60 * scale, top: 0, right: viewport.widthPx, bottom: 60 * scale },
  ];
  for (const { feature, at } of shown) {
    ctx.fillStyle = COLORS.dot;
    ctx.strokeStyle = COLORS.halo;
    ctx.lineWidth = 1.5 * scale;
    ctx.beginPath();
    ctx.arc(at.x, at.y, DOT_RADIUS * scale, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
    const width = ctx.measureText(feature.name).width;
    const gap = 7 * scale;
    const toLeft = at.x + gap + width > viewport.widthPx;
    const left = toLeft ? at.x - gap - width : at.x + gap;
    const box: Placed = {
      left: left - 2 * scale,
      top: at.y - 9 * scale,
      right: left + width + 2 * scale,
      bottom: at.y + 9 * scale,
    };
    if (placed.some((other) => overlaps(other, box))) continue;
    placed.push(box);
    ctx.textAlign = 'left';
    ctx.lineWidth = 3 * scale;
    ctx.strokeText(feature.name, left, at.y);
    ctx.fillStyle = COLORS.label;
    ctx.fillText(feature.name, left, at.y);
  }
}

/** A north arrow in the corner, on a dark disc, turned so it points where north is drawn. */
function drawNorthArrow(
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  viewport: MapViewport,
  scale: number,
): void {
  const heading = (scene.view.headingDeg * Math.PI) / 180;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.translate(viewport.widthPx - 34 * scale, 34 * scale);
  ctx.scale(scale, scale);
  ctx.fillStyle = 'rgba(11, 16, 32, 0.55)';
  ctx.beginPath();
  ctx.arc(0, 0, 22, 0, 2 * Math.PI);
  ctx.fill();
  ctx.rotate(-heading);
  ctx.fillStyle = COLORS.arrow;
  ctx.beginPath();
  ctx.moveTo(0, -16);
  ctx.lineTo(8, 10);
  ctx.lineTo(0, 4);
  ctx.lineTo(-8, 10);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export interface DrawOptions {
  /**
   * How many viewport pixels a screen pixel spans, at least 1: the screen
   * passes it so names, dots and lines stay legible on a narrow canvas, and a
   * capture passes one from its own width alone (captureLabelScale), so a
   * capture still depends on the world and the width asked for, never on the
   * window.
   */
  readonly scale?: number;
}

/** One frame of the scene, on a context whose transform maps the viewport onto its canvas. */
export function drawMap(
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  viewport: MapViewport,
  earth: PreparedEarth,
  options: DrawOptions = {},
): void {
  const scale = Math.max(1, options.scale ?? 1);
  const globe = isGlobe(scene.view) ? globeProjector(scene.view, viewport, scene.radiusM) : null;
  const flat = globe ? null : flatProjector(scene.view, viewport, scene.radiusM);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, viewport.widthPx, viewport.heightPx);
  ctx.clip();
  ctx.globalAlpha = 1;
  drawGround(ctx, scene, viewport, earth, globe, flat, scale);
  drawGraticule(ctx, scene, earth, globe, flat, scale);
  drawOutlines(ctx, scene, viewport, globe, flat, scale);
  drawNames(ctx, scene, viewport, earth, scale);
  drawNorthArrow(ctx, scene, viewport, scale);
  ctx.restore();
}

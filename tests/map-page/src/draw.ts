// Draws a MapWorld on a plain 2D canvas, with no map library: the body as a
// disc or a plane, a 30 degree graticule, features, the flyby path and the
// photo footprints, each layer at its own opacity, and a north arrow turned
// by the heading. It always draws from straight above and leaves pitch as a
// number the tools report, since a tilted camera is a 3D engine's work. Its
// output depends on the world's state alone, so two captures of one view are
// the same bytes. A 2D canvas keeps its pixels between frames; a WebGL page
// must read its canvas in the same task as its render, or create the context
// with preserveDrawingBuffer, or a capture comes back blank.

import { GLOBE, type MapViewport, type MapWorld, projectToScreen } from '@tabdock/sim-page/map';

const COLORS = {
  space: '#0b0d12',
  albedo: '#8a8d93',
  elevation: '#6f6a5f',
  graticule: '#d0d4da',
  feature: '#ffd43b',
  label: '#f8f9fa',
  path: '#4dabf7',
  footprint: '#ff8787',
  onScreen: '#ff6b6b',
  arrow: '#f8f9fa',
} as const;

type Point = readonly [number, number];

/** Draws a line through lon and lat points, broken wherever a globe hides one. */
function polyline(
  ctx: CanvasRenderingContext2D,
  world: MapWorld,
  viewport: MapViewport,
  points: readonly Point[],
): void {
  const view = world.view();
  let drawing = false;
  ctx.beginPath();
  for (const [lon, lat] of points) {
    const at = projectToScreen(view, viewport, world.radiusM, lon, lat);
    if (!at) {
      drawing = false;
      continue;
    }
    if (drawing) ctx.lineTo(at.x, at.y);
    else ctx.moveTo(at.x, at.y);
    drawing = true;
  }
  ctx.stroke();
}

function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let value = from; value <= to + 1e-9; value += step) out.push(value);
  return out;
}

function layerAlpha(world: MapWorld, id: string): number | null {
  const layer = world.layers().find((entry) => entry.id === id);
  return layer?.visible ? layer.opacity : null;
}

function drawGround(ctx: CanvasRenderingContext2D, world: MapWorld, viewport: MapViewport): void {
  const view = world.view();
  const base = world.layers().find((layer) => layer.kind === 'base' && layer.visible);
  const color = base?.id === 'elevation' ? COLORS.elevation : COLORS.albedo;
  ctx.globalAlpha = base ? base.opacity : 0;
  ctx.fillStyle = color;
  if (view.projection === GLOBE) {
    const radiusPx = world.radiusM / (view.widthM / viewport.widthPx);
    ctx.beginPath();
    ctx.arc(viewport.widthPx / 2, viewport.heightPx / 2, radiusPx, 0, 2 * Math.PI);
    ctx.fill();
  } else {
    ctx.fillRect(0, 0, viewport.widthPx, viewport.heightPx);
  }
}

function drawGraticule(
  ctx: CanvasRenderingContext2D,
  world: MapWorld,
  viewport: MapViewport,
): void {
  const alpha = layerAlpha(world, 'graticule');
  if (alpha === null) return;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = COLORS.graticule;
  ctx.lineWidth = 1;
  for (const lon of range(-180, 150, 30)) {
    polyline(
      ctx,
      world,
      viewport,
      range(-90, 90, 2).map((lat) => [lon, lat]),
    );
  }
  for (const lat of range(-60, 60, 30)) {
    polyline(
      ctx,
      world,
      viewport,
      range(-180, 180, 2).map((lon) => [lon, lat]),
    );
  }
}

function drawFootprints(
  ctx: CanvasRenderingContext2D,
  world: MapWorld,
  viewport: MapViewport,
): void {
  const alpha = layerAlpha(world, 'footprints');
  if (alpha === null) return;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 2;
  for (const observation of world.bodyObservations()) {
    const footprint = observation.footprint;
    if (!footprint) continue;
    ctx.strokeStyle = observation.onScreen ? COLORS.onScreen : COLORS.footprint;
    ctx.lineWidth = observation.onScreen ? 3 : 2;
    const polygons = footprint.type === 'Polygon' ? [footprint.coordinates] : footprint.coordinates;
    for (const ring of polygons.flat()) polyline(ctx, world, viewport, ring);
  }
}

function drawPath(ctx: CanvasRenderingContext2D, world: MapWorld, viewport: MapViewport): void {
  const alpha = layerAlpha(world, 'path');
  if (alpha === null) return;
  const stops = world.walkthroughs().walkthroughs.find((walkthrough) => walkthrough.id === 'flyby');
  if (!stops) return;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = COLORS.path;
  ctx.lineWidth = 2;
  polyline(
    ctx,
    world,
    viewport,
    world.stopViews(stops.id).map((view) => [view.lon, view.lat]),
  );
}

function drawFeatures(ctx: CanvasRenderingContext2D, world: MapWorld, viewport: MapViewport): void {
  const view = world.view();
  const names = layerAlpha(world, 'names');
  ctx.font = '12px sans-serif';
  ctx.textBaseline = 'middle';
  for (const feature of world.bodyFeatures()) {
    const at = projectToScreen(view, viewport, world.radiusM, feature.lon, feature.lat);
    if (!at) continue;
    ctx.globalAlpha = 1;
    ctx.fillStyle = COLORS.feature;
    ctx.beginPath();
    ctx.arc(at.x, at.y, 3, 0, 2 * Math.PI);
    ctx.fill();
    if (names !== null) {
      ctx.globalAlpha = names;
      ctx.fillStyle = COLORS.label;
      ctx.fillText(feature.name, at.x + 6, at.y);
    }
  }
}

/** A north arrow in the corner, turned so it points where north is drawn. */
function drawNorthArrow(
  ctx: CanvasRenderingContext2D,
  world: MapWorld,
  viewport: MapViewport,
): void {
  const heading = (world.view().headingDeg * Math.PI) / 180;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.translate(viewport.widthPx - 32, 32);
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

export function drawMap(
  ctx: CanvasRenderingContext2D,
  world: MapWorld,
  viewport: MapViewport,
): void {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = COLORS.space;
  ctx.fillRect(0, 0, viewport.widthPx, viewport.heightPx);
  drawGround(ctx, world, viewport);
  drawGraticule(ctx, world, viewport);
  drawFootprints(ctx, world, viewport);
  drawPath(ctx, world, viewport);
  drawFeatures(ctx, world, viewport);
  drawNorthArrow(ctx, world, viewport);
  ctx.restore();
}

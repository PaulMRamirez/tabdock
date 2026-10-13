// How the map demo's drawing turns longitude and latitude into canvas pixels,
// with the profile's own geometry (packages/sim-page/src/map/geometry.ts)
// underneath, so what the tools call in view is what the canvas draws.
//
// The flat map is the profile's local equirectangular projection, drawn
// without its longitude wrap in copies 360 degrees apart: Natural Earth cuts
// its rings at the antimeridian, so each copy is a plain polygon and the
// canvas clips the rest.
//
// The globe is orthographic. A ring is densified to 2 degree steps; a point
// past the limb is carried onto the limb at the angle of its own projection,
// and where a ring crosses the limb the crossing itself is added, so the
// carried ring runs along the limb wherever the land runs behind the globe.
// A ring that holds the point opposite the view's centre (the antipode) then
// winds the other way round what it shows, and the drawing adds the limb
// circle under the even-odd rule, so a continent wrapping behind the globe
// fills only its visible part. Whether it holds the antipode is read from the
// carried ring itself, by which way it runs round the disc, rather than from
// a separate test, so the two always agree, even when an edge of the data
// runs through the antipode.

import { GLOBE, type MapCamera, type MapViewport, metresPerDegree } from '@tabdock/sim-page/map';

const RAD = Math.PI / 180;
/** The densified ring's largest step and the limb arcs' largest step, in degrees. */
export const STEP_DEG = 2;
/** The share of the disc a carried ring must run clockwise round to hold the antipode. */
export const ANTIPODE_SHARE = 0.01;
/** Copies of the flat map each side of the first, at most, for a view near a pole. */
const MAX_COPIES_EACH_SIDE = 8;

export type LonLat = readonly [number, number];

/** A point on the canvas, x right and y down from the viewport's top left. */
export interface Pixel {
  readonly x: number;
  readonly y: number;
}

/**
 * Whether the data adds the edge from a to b rather than the coast: a cut
 * along the antimeridian or Antarctica's closing run along the South Pole.
 * Coast lines skip these, and fills keep them.
 */
export function isCutEdge(a: LonLat, b: LonLat): boolean {
  return (a[0] === b[0] && Math.abs(a[0]) === 180) || (a[1] === b[1] && a[1] === -90);
}

/**
 * A ring in steps of at most STEP_DEG in longitude and latitude, and for
 * each step whether it lies along an edge the data added (isCutEdge).
 */
export function densify(
  ring: readonly LonLat[],
  stepDeg = STEP_DEG,
): { points: LonLat[]; cut: boolean[] } {
  const points: LonLat[] = [];
  const cut: boolean[] = [];
  for (let index = 0; index + 1 < ring.length; index += 1) {
    const a = ring[index];
    const b = ring[index + 1];
    if (!a || !b) continue;
    const isCut = isCutEdge(a, b);
    const steps = Math.max(
      1,
      Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / stepDeg),
    );
    for (let step = 0; step < steps; step += 1) {
      const t = step / steps;
      points.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      cut.push(isCut);
    }
  }
  const last = ring.at(-1);
  if (last) points.push([last[0], last[1]]);
  return { points, cut };
}

/** Metres per pixel, and the heading's sine and cosine, which every projection here reads. */
function frame(view: MapCamera, viewport: MapViewport) {
  const heading = view.headingDeg * RAD;
  return {
    metresPerPx: view.widthM / viewport.widthPx,
    cos: Math.cos(heading),
    sin: Math.sin(heading),
    cx: viewport.widthPx / 2,
    cy: viewport.heightPx / 2,
  };
}

/**
 * The flat map's projection for one copy: `copy` 0 is the data as stored,
 * and -1 and 1 the copies 360 degrees west and east. Within 180 degrees of
 * the centre, copy 0 is projectToScreen exactly.
 */
export interface FlatProjector {
  project(lon: number, lat: number, copy: number): Pixel;
  /** The copies that can show anything, west to east. */
  readonly copies: readonly number[];
}

export function flatProjector(
  view: MapCamera,
  viewport: MapViewport,
  radiusM: number,
): FlatProjector {
  const f = frame(view, viewport);
  const perDegree = metresPerDegree(radiusM);
  const eastPerDegree = perDegree * Math.cos(view.lat * RAD);
  const project = (lon: number, lat: number, copy: number): Pixel => {
    const east = (lon - view.lon + 360 * copy) * eastPerDegree;
    const north = (lat - view.lat) * perDegree;
    // The heading is the direction shown at the top, so the ground turns the other way.
    const right = east * f.cos - north * f.sin;
    const up = east * f.sin + north * f.cos;
    return { x: f.cx + right / f.metresPerPx, y: f.cy - up / f.metresPerPx };
  };
  // The view's half diagonal in degrees of longitude, so a turned view is covered too.
  const halfDiagonalM = (Math.hypot(viewport.widthPx, viewport.heightPx) / 2) * f.metresPerPx;
  const reachDeg = eastPerDegree > 0 ? halfDiagonalM / eastPerDegree : Infinity;
  const west = Math.max(-MAX_COPIES_EACH_SIDE, Math.ceil((view.lon - reachDeg - 180) / 360));
  const east = Math.min(MAX_COPIES_EACH_SIDE, Math.floor((view.lon + reachDeg + 180) / 360));
  const copies: number[] = [];
  // Adding 0 turns a -0 from Math.ceil into 0, so the copies read plainly.
  for (let copy = west; copy <= east; copy += 1) copies.push(copy + 0);
  return { project, copies };
}

/** A point on the globe as drawn: where it lands on the plane, and whether it faces the camera. */
export interface GlobePoint extends Pixel {
  /** The cosine of the angle from the view's centre: 0 or above when visible. */
  readonly facing: number;
}

export interface GlobeProjector {
  /** The plane's projection of any point, hidden ones included. */
  project(lon: number, lat: number): GlobePoint;
  /** The limb: the globe's outline on the canvas. */
  readonly cx: number;
  readonly cy: number;
  readonly radiusPx: number;
}

/** The orthographic projection projectToScreen draws, keeping hidden points rather than dropping them. */
export function globeProjector(
  view: MapCamera,
  viewport: MapViewport,
  radiusM: number,
): GlobeProjector {
  const f = frame(view, viewport);
  const phi0 = view.lat * RAD;
  const sinPhi0 = Math.sin(phi0);
  const cosPhi0 = Math.cos(phi0);
  const project = (lon: number, lat: number): GlobePoint => {
    const phi = lat * RAD;
    const dLambda = (lon - view.lon) * RAD;
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);
    const cosD = Math.cos(dLambda);
    const east = radiusM * cosPhi * Math.sin(dLambda);
    const north = radiusM * (cosPhi0 * sinPhi - sinPhi0 * cosPhi * cosD);
    const right = east * f.cos - north * f.sin;
    const up = east * f.sin + north * f.cos;
    return {
      x: f.cx + right / f.metresPerPx,
      y: f.cy - up / f.metresPerPx,
      facing: sinPhi0 * sinPhi + cosPhi0 * cosPhi * cosD,
    };
  };
  return { project, cx: f.cx, cy: f.cy, radiusPx: radiusM / f.metresPerPx };
}

/** An angle wrapped into -PI to PI, the shorter way round. */
function wrapAngle(angle: number): number {
  let wrapped = angle % (2 * Math.PI);
  if (wrapped > Math.PI) wrapped -= 2 * Math.PI;
  if (wrapped <= -Math.PI) wrapped += 2 * Math.PI;
  return wrapped;
}

/**
 * One ring on the globe. `visible` rings carry the outline to fill, carried
 * onto the limb where the ring runs behind, and whether that outline holds
 * the antipode; a ring wholly behind the globe carries how many times it
 * winds round the view, which is 1 only for a ring around the whole visible
 * half, counterclockwise.
 */
export type GlobeRing =
  { kind: 'visible'; outline: Pixel[]; holdsAntipode: boolean } | { kind: 'hidden'; turns: number };

/** Angles here are counterclockwise from the right, as on a page whose y runs up. */
function angleOf(globe: GlobeProjector, point: Pixel): number {
  return Math.atan2(globe.cy - point.y, point.x - globe.cx);
}

function limbPoint(globe: GlobeProjector, angle: number): Pixel {
  return {
    x: globe.cx + globe.radiusPx * Math.cos(angle),
    y: globe.cy - globe.radiusPx * Math.sin(angle),
  };
}

/** Where the step from a to b crosses the limb, one of them facing the camera and the other not. */
function crossing(globe: GlobeProjector, a: GlobePoint, b: GlobePoint): Pixel {
  // Both are linear in the point on the sphere, so the plane's crossing lies
  // along the chord, then sits on the limb in its own direction.
  const t = a.facing / (a.facing - b.facing);
  return limbPoint(globe, angleOf(globe, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }));
}

/** Appends the limb from one angle to another the shorter way, in steps of at most STEP_DEG. */
function alongLimb(globe: GlobeProjector, out: Pixel[], from: number, to: number): number {
  const turn = wrapAngle(to - from);
  const steps = Math.ceil(Math.abs(turn) / (STEP_DEG * RAD));
  for (let step = 1; step <= steps; step += 1) {
    out.push(limbPoint(globe, from + (turn * step) / steps));
  }
  return turn;
}

/** Twice the signed area of an outline, above zero when it runs counterclockwise on the page. */
function twiceAreaUp(outline: readonly Pixel[]): number {
  let twice = 0;
  for (let index = 0; index < outline.length; index += 1) {
    const a = outline[index];
    const b = outline[(index + 1) % outline.length];
    if (a && b) twice += a.x * b.y - b.x * a.y;
  }
  // The canvas's y runs down, which turns the sign.
  return -twice;
}

/** A densified, closed ring, wound with its region on its left, as projected for the globe. */
export function globeRing(globe: GlobeProjector, ring: readonly LonLat[]): GlobeRing {
  const points = ring.map(([lon, lat]) => globe.project(lon, lat));
  if (!points.some((point) => point.facing >= 0)) {
    let sweep = 0;
    for (let index = 0; index + 1 < points.length; index += 1) {
      const a = points[index];
      const b = points[index + 1];
      if (a && b) sweep += wrapAngle(angleOf(globe, b) - angleOf(globe, a));
    }
    return { kind: 'hidden', turns: Math.round(sweep / (2 * Math.PI)) };
  }
  const outline: Pixel[] = [];
  /** The angle of the last point carried onto the limb, or null while the ring is in view. */
  let limb: number | null = null;
  let previous: GlobePoint | null = null;
  for (const point of points) {
    if (point.facing >= 0) {
      if (previous && previous.facing < 0) {
        const entry = crossing(globe, previous, point);
        alongLimb(globe, outline, limb ?? angleOf(globe, entry), angleOf(globe, entry));
      }
      outline.push({ x: point.x, y: point.y });
      limb = null;
    } else {
      if (previous && previous.facing >= 0) {
        const exit = crossing(globe, previous, point);
        outline.push(exit);
        limb = angleOf(globe, exit);
      }
      // A point at the antipode itself has no direction; it keeps the last one.
      const here: number | null =
        point.x === globe.cx && point.y === globe.cy ? limb : angleOf(globe, point);
      if (limb === null) {
        const at: number = here ?? 0;
        outline.push(limbPoint(globe, at));
        limb = at;
      } else {
        limb += alongLimb(globe, outline, limb, here ?? limb);
      }
    }
    previous = point;
  }
  // A carried ring that runs clockwise winds round what lies outside it: the
  // antipode is inside the ring. Such a ring runs clockwise round the open
  // water of the visible half, a large share of the disc, since no land or
  // lake covers most of a hemisphere. A ring mostly behind the globe runs
  // back and forth along the limb in short chords that leave slivers of
  // either sign, well under a thousandth of the disc, so only a clockwise
  // share above ANTIPODE_SHARE counts.
  const disc = Math.PI * globe.radiusPx * globe.radiusPx;
  return {
    kind: 'visible',
    outline,
    holdsAntipode: twiceAreaUp(outline) / 2 < -ANTIPODE_SHARE * disc,
  };
}

/** Whether a view is a globe. */
export function isGlobe(view: MapCamera): boolean {
  return view.projection === GLOBE;
}

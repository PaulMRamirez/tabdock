// The math the sim world and the canvas page share, so what the world calls
// in view and what the canvas draws can never disagree. A 2D map is a local
// equirectangular projection centred on the view, so widthM is true ground
// distance across the centre; a globe is an orthographic projection around
// the centre, with points past the limb hidden. Both are seen from straight
// above and turned by the heading; pitch is reported as set but not drawn,
// which a page with a pitched 3D camera would compute for itself.

import { GLOBE } from './profile.ts';

export interface MapViewport {
  readonly widthPx: number;
  readonly heightPx: number;
}

/** The parts of a view the geometry reads. */
export interface MapCamera {
  readonly projection: string;
  readonly lon: number;
  readonly lat: number;
  readonly widthM: number;
  readonly headingDeg: number;
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface MapBounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

const RAD = Math.PI / 180;

/** Metres along a great circle per degree of arc, on a sphere of this radius. */
export function metresPerDegree(radiusM: number): number {
  return radiusM * RAD;
}

/** A longitude in -180 to 180; 180 itself stays 180, so a bound at the antimeridian keeps its side. */
export function wrapLon(lon: number): number {
  if (lon >= -180 && lon <= 180) return lon;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 && lon > 0 ? 180 : wrapped;
}

/** The shorter signed difference between two longitudes, in -180 to 180. */
function lonDelta(lon: number, from: number): number {
  const delta = (((lon - from + 180) % 360) + 360) % 360;
  return delta - 180;
}

/** On a globe, the altitude at which a camera with this field of view sees widthM across. */
export function altitudeFromWidth(widthM: number, fovDeg: number): number {
  return widthM / (2 * Math.tan((fovDeg * RAD) / 2));
}

/** The inverse of altitudeFromWidth. */
export function widthFromAltitude(altitudeM: number, fovDeg: number): number {
  return 2 * altitudeM * Math.tan((fovDeg * RAD) / 2);
}

/** Metres east and north of the view's centre, as drawn, or null behind a globe's limb. */
function offsets(
  view: MapCamera,
  radiusM: number,
  lon: number,
  lat: number,
): { east: number; north: number } | null {
  const phi0 = view.lat * RAD;
  const phi = lat * RAD;
  if (view.projection === GLOBE) {
    const dLambda = (lon - view.lon) * RAD;
    const cosC =
      Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * Math.cos(phi) * Math.cos(dLambda);
    if (cosC < 0) return null;
    return {
      east: radiusM * Math.cos(phi) * Math.sin(dLambda),
      north:
        radiusM *
        (Math.cos(phi0) * Math.sin(phi) - Math.sin(phi0) * Math.cos(phi) * Math.cos(dLambda)),
    };
  }
  return {
    east: lonDelta(lon, view.lon) * RAD * radiusM * Math.cos(phi0),
    north: (lat - view.lat) * RAD * radiusM,
  };
}

/** Where a point is drawn: x right and y down from the viewport's top left, or null when a globe hides it. */
export function projectToScreen(
  view: MapCamera,
  viewport: MapViewport,
  radiusM: number,
  lon: number,
  lat: number,
): ScreenPoint | null {
  const at = offsets(view, radiusM, lon, lat);
  if (!at) return null;
  const heading = view.headingDeg * RAD;
  // The heading is the direction shown at the top, so the ground turns the other way.
  const right = at.east * Math.cos(heading) - at.north * Math.sin(heading);
  const up = at.east * Math.sin(heading) + at.north * Math.cos(heading);
  const metresPerPx = view.widthM / viewport.widthPx;
  return {
    x: viewport.widthPx / 2 + right / metresPerPx,
    y: viewport.heightPx / 2 - up / metresPerPx,
  };
}

/** Whether a point is drawn inside the viewport. */
export function isInView(
  view: MapCamera,
  viewport: MapViewport,
  radiusM: number,
  lon: number,
  lat: number,
): boolean {
  const at = projectToScreen(view, viewport, radiusM, lon, lat);
  return (
    at !== null && at.x >= 0 && at.x <= viewport.widthPx && at.y >= 0 && at.y <= viewport.heightPx
  );
}

/**
 * The longitude and latitude drawn at a screen point, the longitude as an
 * offset from the centre that is not wrapped, or null past a globe's limb.
 */
function unproject(
  view: MapCamera,
  viewport: MapViewport,
  radiusM: number,
  x: number,
  y: number,
): { lonOffset: number; lat: number } | null {
  const metresPerPx = view.widthM / viewport.widthPx;
  const right = (x - viewport.widthPx / 2) * metresPerPx;
  const up = (viewport.heightPx / 2 - y) * metresPerPx;
  const heading = view.headingDeg * RAD;
  const east = right * Math.cos(heading) + up * Math.sin(heading);
  const north = -right * Math.sin(heading) + up * Math.cos(heading);
  const phi0 = view.lat * RAD;
  if (view.projection !== GLOBE) {
    return {
      lonOffset: east / (radiusM * Math.max(Math.cos(phi0), 1e-12) * RAD),
      lat: view.lat + north / (radiusM * RAD),
    };
  }
  const rho = Math.hypot(east, north);
  if (rho >= radiusM) return null;
  if (rho === 0) return { lonOffset: 0, lat: view.lat };
  const c = Math.asin(rho / radiusM);
  const phi = Math.asin(
    Math.cos(c) * Math.sin(phi0) + (north * Math.sin(c) * Math.cos(phi0)) / rho,
  );
  const lambda = Math.atan2(
    east * Math.sin(c),
    rho * Math.cos(phi0) * Math.cos(c) - north * Math.sin(phi0) * Math.sin(c),
  );
  return { lonOffset: lambda / RAD, lat: phi / RAD };
}

/** Points along the viewport's edges, which on a globe bend, so corners alone would miss the extremes. */
const EDGE_STEPS = 16;

/**
 * The view's bounding box: west greater than east when it crosses the
 * antimeridian (RFC 7946 section 5.2), the whole longitude range when a pole
 * is in view, and null when a globe's horizon is in view, since then the box
 * would hold ground no one can see.
 */
export function viewBounds(
  view: MapCamera,
  viewport: MapViewport,
  radiusM: number,
): MapBounds | null {
  const { widthPx: w, heightPx: h } = viewport;
  const points: [number, number][] = [];
  for (let step = 0; step <= EDGE_STEPS; step += 1) {
    const f = step / EDGE_STEPS;
    points.push([f * w, 0], [f * w, h], [0, f * h], [w, f * h]);
  }
  let minOffset = Infinity;
  let maxOffset = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const [x, y] of points) {
    const at = unproject(view, viewport, radiusM, x, y);
    if (!at) return null;
    minOffset = Math.min(minOffset, at.lonOffset);
    maxOffset = Math.max(maxOffset, at.lonOffset);
    south = Math.min(south, at.lat);
    north = Math.max(north, at.lat);
  }
  const northPole = north >= 90 || isInView(view, viewport, radiusM, view.lon, 90);
  const southPole = south <= -90 || isInView(view, viewport, radiusM, view.lon, -90);
  const allLongitudes = northPole || southPole || maxOffset - minOffset >= 360;
  return {
    west: allLongitudes ? -180 : wrapLon(view.lon + minOffset),
    south: southPole ? -90 : south,
    east: allLongitudes ? 180 : wrapLon(view.lon + maxOffset),
    north: northPole ? 90 : north,
  };
}

/**
 * Whether a ring of [longitude, latitude] positions runs counterclockwise,
 * as RFC 7946 asks of a polygon's exterior ring, by the sign of its area.
 */
export function ringIsCounterclockwise(ring: readonly (readonly [number, number])[]): boolean {
  let twiceArea = 0;
  for (let i = 0; i + 1 < ring.length; i += 1) {
    const [x1, y1] = ring[i] ?? [0, 0];
    const [x2, y2] = ring[i + 1] ?? [0, 0];
    twiceArea += x1 * y2 - x2 * y1;
  }
  return twiceArea > 0;
}

/** The angle between two points on a sphere, in degrees, for ordering features by distance from the centre. */
export function angularDistanceDeg(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const phi1 = lat1 * RAD;
  const phi2 = lat2 * RAD;
  const dPhi = phi2 - phi1;
  const dLambda = (lon2 - lon1) * RAD;
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(a)))) / RAD;
}

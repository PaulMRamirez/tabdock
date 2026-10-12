// The canvas page's hand gestures as world writes, kept apart from the DOM
// so a unit test can drive them. Each is one discrete change, one write per
// drag and per wheel step, never per frame, so a page that publishes its
// state never does so per frame either.

import {
  GLOBE,
  MAP_MAX_DISTANCE_M,
  type MapView,
  type MapWorld,
  widthFromAltitude,
} from '@tabdock/sim-page/map';

/** How much one wheel step widens the view, or narrows it going the other way. */
const WHEEL_STEP = 1.25;
/** The narrowest view a wheel step zooms to, in metres. */
const NARROWEST_M = 1;

/** Moves the centre so the ground follows a drag of dx and dy drawing-buffer pixels. */
export function panBy(world: MapWorld, viewportWidthPx: number, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  const view = world.view();
  const metresPerPx = view.widthM / viewportWidthPx;
  const heading = (view.headingDeg * Math.PI) / 180;
  // The ground moves with the pointer, so the centre moves the other way.
  const east = -(dx * Math.cos(heading) - dy * Math.sin(heading)) * metresPerPx;
  const north = (dx * Math.sin(heading) + dy * Math.cos(heading)) * metresPerPx;
  const metresPerDegree = (world.radiusM * Math.PI) / 180;
  const lat = Math.max(-90, Math.min(90, view.lat + north / metresPerDegree));
  const cosLat = Math.max(Math.cos((view.lat * Math.PI) / 180), 1e-6);
  const lon = ((((view.lon + east / (metresPerDegree * cosLat) + 180) % 360) + 360) % 360) - 180;
  world.setView({ lon, lat });
}

/**
 * The widest view a wheel step asks for. On a globe the world refuses a
 * camera farther out than MAP_MAX_DISTANCE_M, and with a field of view
 * under about 53 degrees the altitude passes the width, so the width there
 * is the farthest camera's, a hair inside so rounding in the world's own
 * conversion never carries it past.
 */
function widestM(view: MapView): number {
  if (view.projection !== GLOBE || view.fovDeg === undefined) return MAP_MAX_DISTANCE_M;
  const farthest = widthFromAltitude(MAP_MAX_DISTANCE_M, view.fovDeg);
  return Math.min(MAP_MAX_DISTANCE_M, farthest) * (1 - 1e-9);
}

/** One wheel step out, or in, within what the world can show; a step that changes nothing writes nothing. */
export function zoomBy(world: MapWorld, out: boolean): void {
  const view = world.view();
  const asked = view.widthM * (out ? WHEEL_STEP : 1 / WHEEL_STEP);
  const widthM = Math.min(widestM(view), Math.max(NARROWEST_M, asked));
  if (widthM === view.widthM) return;
  world.setView({ widthM });
}

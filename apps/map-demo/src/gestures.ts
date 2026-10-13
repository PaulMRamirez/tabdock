// The map demo's hand gestures, keys and buttons as world writes, kept apart
// from the DOM so a unit test can drive them. Each is one discrete change,
// one write per drag, wheel step, key or button press, never per frame, so
// the page never publishes its state per frame either. A drag shows its view as it
// goes (draggedView) and writes it once, when the pointer lifts. They follow
// tests/map-page's gestures, extended, and import nothing from it.

import {
  GLOBE,
  MAP_MAX_DISTANCE_M,
  type MapView,
  type MapWorld,
  widthFromAltitude,
} from '@tabdock/sim-page/map';

/** How much one wheel step or button press widens the view, or narrows it going the other way. */
export const ZOOM_STEP = 1.25;
/** The button's step: two wheel steps, since a press is slower than a wheel. */
export const BUTTON_ZOOM_STEP = ZOOM_STEP * ZOOM_STEP;
/** The narrowest view a hand zoom asks for, in metres: the data is drawn to 0.1 degree, about 11 km. */
export const NARROWEST_HAND_M = 20_000;
/** The widest, where Earth is a small disc; the tools may ask for more. */
export const WIDEST_HAND_M = 100_000_000;

/** The view with its centre moved so the ground follows a drag of dx and dy viewport pixels. */
export function draggedView(
  view: MapView,
  radiusM: number,
  viewportWidthPx: number,
  dx: number,
  dy: number,
): MapView {
  if (dx === 0 && dy === 0) return view;
  const metresPerPx = view.widthM / viewportWidthPx;
  const heading = (view.headingDeg * Math.PI) / 180;
  // The ground moves with the pointer, so the centre moves the other way.
  const east = -(dx * Math.cos(heading) - dy * Math.sin(heading)) * metresPerPx;
  const north = (dx * Math.sin(heading) + dy * Math.cos(heading)) * metresPerPx;
  const metresPerDegree = (radiusM * Math.PI) / 180;
  const lat = Math.max(-90, Math.min(90, view.lat + north / metresPerDegree));
  const cosLat = Math.max(Math.cos((view.lat * Math.PI) / 180), 1e-6);
  const lon = ((((view.lon + east / (metresPerDegree * cosLat) + 180) % 360) + 360) % 360) - 180;
  return { ...view, lon, lat };
}

/**
 * What one wheel step over the map asks for: a zoom only while Ctrl or Cmd is
 * held, which is also how Chromium, Firefox and Safari deliver a trackpad
 * pinch, so a plain wheel scrolls the page past the map as on any page.
 */
export function wheelZoom(event: {
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly deltaY: number;
}): 'in' | 'out' | null {
  if (!(event.ctrlKey || event.metaKey) || event.deltaY === 0) return null;
  return event.deltaY > 0 ? 'out' : 'in';
}

/** How far one arrow key moves the ground, in viewport pixels: an eighth of the map's width. */
export const KEY_PAN_PX = 120;

export type KeyAction =
  | { readonly kind: 'pan'; readonly dx: number; readonly dy: number }
  | { readonly kind: 'zoom'; readonly out: boolean };

/**
 * What a key does on the focused map, so a keyboard can do all a pointer
 * can: an arrow pans toward its side, as a drag the other way would, and
 * plus or minus zoom by a button's step. Any other key, or one held with a
 * modifier the browser uses for its own shortcuts, does nothing here.
 */
export function keyAction(event: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}): KeyAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  switch (event.key) {
    case 'ArrowLeft':
      return { kind: 'pan', dx: KEY_PAN_PX, dy: 0 };
    case 'ArrowRight':
      return { kind: 'pan', dx: -KEY_PAN_PX, dy: 0 };
    case 'ArrowUp':
      return { kind: 'pan', dx: 0, dy: KEY_PAN_PX };
    case 'ArrowDown':
      return { kind: 'pan', dx: 0, dy: -KEY_PAN_PX };
    case '+':
    case '=':
      return { kind: 'zoom', out: false };
    case '-':
    case '_':
      return { kind: 'zoom', out: true };
    default:
      return null;
  }
}

/** One write for a whole drag; a drag that moved nothing writes nothing. */
export function panBy(world: MapWorld, viewportWidthPx: number, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  const { lon, lat } = draggedView(world.view(), world.radiusM, viewportWidthPx, dx, dy);
  world.setView({ lon, lat });
}

/**
 * The widest view a zoom asks for: WIDEST_HAND_M, and on a globe no farther
 * than the world allows. It refuses a camera farther out than
 * MAP_MAX_DISTANCE_M, and with a field of view under about 53 degrees the
 * altitude passes the width, so the width there is the farthest camera's, a
 * hair inside so rounding in the world's own conversion never carries it past.
 */
function widestM(view: MapView): number {
  if (view.projection !== GLOBE || view.fovDeg === undefined) return WIDEST_HAND_M;
  const farthest = widthFromAltitude(MAP_MAX_DISTANCE_M, view.fovDeg);
  return Math.min(WIDEST_HAND_M, farthest * (1 - 1e-9));
}

/** One step out, or in, by `step`, within what the world can show; a step that changes nothing writes nothing. */
export function zoomBy(world: MapWorld, out: boolean, step = ZOOM_STEP): void {
  const view = world.view();
  const asked = view.widthM * (out ? step : 1 / step);
  // A view the tools set past either end is only ever brought back toward the range.
  const widthM = out
    ? Math.max(view.widthM, Math.min(widestM(view), asked))
    : Math.min(view.widthM, Math.max(NARROWEST_HAND_M, asked));
  if (widthM === view.widthM) return;
  world.setView({ widthM });
}

/** Turns a flat map into a globe and back, keeping the centre and the width across it. */
export function toggleGlobe(world: MapWorld, flatProjection: string): void {
  const view = world.view();
  world.setView({ projection: view.projection === GLOBE ? flatProjection : GLOBE });
}

/** Moves to the tour's next or previous stop, or its first when none is current; past either end, nothing. */
export function stepStop(world: MapWorld, walkthroughId: string, by: 1 | -1): void {
  const listed = world.walkthroughs();
  const tour = listed.walkthroughs.find((entry) => entry.id === walkthroughId);
  if (!tour) return;
  const current = listed.current?.walkthroughId === walkthroughId ? listed.current.stopIndex : null;
  const next = current === null ? 0 : current + by;
  if (next < 0 || next >= tour.stopCount) return;
  world.goToStop(walkthroughId, next);
}

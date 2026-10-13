// The map demo's gestures, keys and buttons against the world they write
// to: each is one write or none, a drag's preview is the view its release
// writes, a plain wheel leaves the page to scroll, an arrow key pans the way
// it points, a zoom stays within what a hand should reach and what the world
// can show and never throws, the projection button keeps the centre and
// width, and the stop buttons stop at either end of the tour.

import { GLOBE, MAP_MAX_DISTANCE_M, type MapWorld } from '@tabdock/sim-page/map';
import { describe, expect, it } from 'vitest';
import { createEarthWorld, FLAT, TOUR_ID } from './earth.ts';
import {
  draggedView,
  KEY_PAN_PX,
  keyAction,
  NARROWEST_HAND_M,
  panBy,
  stepStop,
  toggleGlobe,
  WIDEST_HAND_M,
  wheelZoom,
  zoomBy,
} from './gestures.ts';

const VIEWPORT = { widthPx: 960, heightPx: 540 };

function writes(world: MapWorld, run: () => void): number {
  let count = 0;
  const stop = world.subscribe(() => {
    count += 1;
  });
  try {
    run();
  } finally {
    stop();
  }
  return count;
}

describe('the map demo gestures', () => {
  it('zooms on a wheel only with Ctrl or Cmd held, as a pinch arrives, and leaves a plain wheel to scroll', () => {
    const plain = { ctrlKey: false, metaKey: false };
    expect(wheelZoom({ ...plain, deltaY: 100 })).toBeNull();
    expect(wheelZoom({ ...plain, deltaY: -100 })).toBeNull();
    expect(wheelZoom({ ctrlKey: true, metaKey: false, deltaY: 3 })).toBe('out');
    expect(wheelZoom({ ctrlKey: true, metaKey: false, deltaY: -3 })).toBe('in');
    expect(wheelZoom({ ctrlKey: false, metaKey: true, deltaY: -100 })).toBe('in');
    expect(wheelZoom({ ctrlKey: true, metaKey: false, deltaY: 0 })).toBeNull();
  });

  it('pans the way an arrow key points, zooms on plus and minus, and leaves modified keys alone', () => {
    const none = { ctrlKey: false, metaKey: false, altKey: false };
    const world = createEarthWorld({ viewport: VIEWPORT });
    world.goToStop(TOUR_ID, 1);
    const start = world.view();
    const pressed = (key: string): void => {
      const action = keyAction({ ...none, key });
      if (action?.kind !== 'pan') throw new Error(`${key} does not pan`);
      expect(
        writes(world, () => {
          panBy(world, VIEWPORT.widthPx, action.dx, action.dy);
        }),
      ).toBe(1);
    };
    pressed('ArrowRight');
    expect(world.view().lon).toBeGreaterThan(start.lon);
    pressed('ArrowLeft');
    expect(world.view().lon).toBeCloseTo(start.lon, 9);
    pressed('ArrowUp');
    expect(world.view().lat).toBeGreaterThan(start.lat);
    pressed('ArrowDown');
    expect(world.view().lat).toBeCloseTo(start.lat, 9);
    // An eighth of the map's width each time.
    expect(KEY_PAN_PX).toBe(VIEWPORT.widthPx / 8);
    expect(keyAction({ ...none, key: '+' })).toEqual({ kind: 'zoom', out: false });
    expect(keyAction({ ...none, key: '=' })).toEqual({ kind: 'zoom', out: false });
    expect(keyAction({ ...none, key: '-' })).toEqual({ kind: 'zoom', out: true });
    expect(keyAction({ ...none, key: 'a' })).toBeNull();
    expect(keyAction({ ...none, key: 'Tab' })).toBeNull();
    // The browser's own shortcuts, such as Ctrl and plus for its zoom, stay the browser's.
    expect(keyAction({ ...none, ctrlKey: true, key: '+' })).toBeNull();
    expect(keyAction({ ...none, metaKey: true, key: 'ArrowLeft' })).toBeNull();
    expect(keyAction({ ...none, altKey: true, key: 'ArrowLeft' })).toBeNull();
  });

  it('writes a drag once, at the view its preview showed, and a drag of nothing not at all', () => {
    const world = createEarthWorld({ viewport: VIEWPORT });
    world.goToStop(TOUR_ID, 1);
    const preview = draggedView(world.view(), world.radiusM, VIEWPORT.widthPx, 120, -40);
    expect(
      writes(world, () => {
        panBy(world, VIEWPORT.widthPx, 120, -40);
      }),
    ).toBe(1);
    expect(world.view().lon).toBeCloseTo(preview.lon, 9);
    expect(world.view().lat).toBeCloseTo(preview.lat, 9);
    // The ground follows the pointer: dragging right moves the centre west.
    expect(preview.lon).toBeLessThan(50.5);
    expect(
      writes(world, () => {
        panBy(world, VIEWPORT.widthPx, 0, 0);
      }),
    ).toBe(0);
  });

  it("zooms one write a step, within a hand's range, and never throws on a narrow globe", () => {
    const world = createEarthWorld({ viewport: VIEWPORT });
    world.setView({ projection: GLOBE, fovDeg: 1, widthM: 1_000_000 });
    for (let step = 0; step < 200; step += 1) zoomBy(world, true);
    const out = world.view();
    expect(out.widthM).toBeLessThanOrEqual(WIDEST_HAND_M);
    expect(out.altitudeM).toBeLessThanOrEqual(MAP_MAX_DISTANCE_M);
    expect(
      writes(world, () => {
        zoomBy(world, true);
      }),
    ).toBe(0);
    for (let step = 0; step < 200; step += 1) zoomBy(world, false);
    expect(world.view().widthM).toBe(NARROWEST_HAND_M);
    expect(
      writes(world, () => {
        zoomBy(world, false);
      }),
    ).toBe(0);
  });

  it("brings a view the tools set past a hand's range back only toward it", () => {
    const world = createEarthWorld({ viewport: VIEWPORT });
    world.setView({ projection: FLAT, widthM: 1e9 });
    expect(
      writes(world, () => {
        zoomBy(world, true);
      }),
    ).toBe(0);
    expect(
      writes(world, () => {
        zoomBy(world, false);
      }),
    ).toBe(1);
    expect(world.view().widthM).toBeLessThan(1e9);
  });

  it('turns a flat map into a globe and back, keeping the centre and the width', () => {
    const world = createEarthWorld({ viewport: VIEWPORT });
    world.goToStop(TOUR_ID, 3);
    const flat = world.view();
    toggleGlobe(world, FLAT);
    const globe = world.view();
    expect(globe.projection).toBe(GLOBE);
    expect(globe).toMatchObject({ lon: flat.lon, lat: flat.lat, widthM: flat.widthM });
    toggleGlobe(world, FLAT);
    expect(world.view()).toMatchObject({ projection: FLAT, lon: flat.lon, widthM: flat.widthM });
    expect(world.view().altitudeM).toBeUndefined();
  });

  it('steps through the tour and stops at either end', () => {
    const world = createEarthWorld({ viewport: VIEWPORT });
    stepStop(world, TOUR_ID, 1);
    expect(world.current).toEqual({ walkthroughId: TOUR_ID, stopIndex: 0 });
    expect(
      writes(world, () => {
        stepStop(world, TOUR_ID, -1);
      }),
    ).toBe(0);
    for (let step = 0; step < 10; step += 1) stepStop(world, TOUR_ID, 1);
    expect(world.current?.stopIndex).toBe(5);
    stepStop(world, TOUR_ID, -1);
    expect(world.current?.stopIndex).toBe(4);
  });
});

// The canvas page's drag and wheel against the world they write to. A
// gesture runs in an event listener, where a refusal nothing catches is an
// uncaught page error and stops the gesture, so each must ask only for
// views the world can show: on a globe with a narrow field of view the
// camera reaches the farthest altitude the profile allows well before the
// view's width does.

import {
  createMapWorld,
  GLOBE,
  MAP_MAX_DISTANCE_M,
  type MapView,
  type MapWorld,
} from '@tabdock/sim-page/map';
import { describe, expect, it } from 'vitest';
import { panBy, zoomBy } from '../src/gestures.ts';

const VIEWPORT_WIDTH_PX = 960;

/** Wheel steps as a person would give them, counting the writes the world announces. */
function wheel(world: MapWorld, out: boolean, steps: number): { view: MapView; writes: number } {
  let writes = 0;
  const stop = world.subscribe(() => {
    writes += 1;
  });
  try {
    for (let step = 0; step < steps; step += 1) zoomBy(world, out);
  } finally {
    stop();
  }
  return { view: world.view(), writes };
}

describe('zooming the canvas page with the wheel', () => {
  it('stops at the farthest camera on a globe with a narrow field of view, and never throws', () => {
    const world = createMapWorld();
    world.goToStop('flyby', 0);
    const start = world.view();
    expect(start.projection).toBe(GLOBE);
    // Narrower than about 53 degrees, the altitude passes the width.
    expect(start.fovDeg).toBeLessThan(53);
    const far = wheel(world, true, 200).view;
    expect(far.altitudeM).toBeLessThanOrEqual(MAP_MAX_DISTANCE_M);
    expect(far.altitudeM).toBeGreaterThan(MAP_MAX_DISTANCE_M * 0.999);
    expect(far.fovDeg).toBe(start.fovDeg);
    // A step past the farthest changes nothing and tells nobody.
    expect(wheel(world, true, 3)).toEqual({ view: far, writes: 0 });
    // And all the way back in, to a metre across.
    expect(wheel(world, false, 400).view.widthM).toBe(1);
  });

  it('stops where the width reaches its cap on a globe with a wide field of view', () => {
    const world = createMapWorld();
    world.setView({ projection: GLOBE, fovDeg: 120 });
    const far = wheel(world, true, 200).view;
    expect(far.widthM).toBeLessThanOrEqual(MAP_MAX_DISTANCE_M);
    expect(far.widthM).toBeGreaterThan(MAP_MAX_DISTANCE_M * 0.999);
    expect(far.altitudeM).toBeLessThan(far.widthM);
  });

  it('stops at the widest view on a 2D map', () => {
    const world = createMapWorld();
    expect(world.view().projection).not.toBe(GLOBE);
    const far = wheel(world, true, 200).view;
    expect(far.widthM).toBe(MAP_MAX_DISTANCE_M);
    expect(wheel(world, true, 3).writes).toBe(0);
  });
});

describe('dragging the canvas page', () => {
  it('moves the centre against the drag, wrapping at the antimeridian and stopping at a pole', () => {
    const world = createMapWorld();
    world.setView({ lon: 179, lat: 0, widthM: 100_000, headingDeg: 0 });
    // Dragging the ground left moves the centre east, across the antimeridian.
    panBy(world, VIEWPORT_WIDTH_PX, -VIEWPORT_WIDTH_PX, 0);
    const east = world.view();
    expect(east.lon).toBeGreaterThan(-180);
    expect(east.lon).toBeLessThan(-170);
    expect(east.lat).toBeCloseTo(0, 9);
    // Dragging the ground down far enough moves the centre to the north pole, no further.
    for (let step = 0; step < 200; step += 1) panBy(world, VIEWPORT_WIDTH_PX, 0, 960);
    expect(world.view().lat).toBe(90);
  });

  it('writes nothing for a click that does not move', () => {
    const world = createMapWorld();
    let writes = 0;
    world.subscribe(() => {
      writes += 1;
    });
    panBy(world, VIEWPORT_WIDTH_PX, 0, 0);
    expect(writes).toBe(0);
  });
});

// The drawing's projections against the profile's own (ADR 0050): the flat
// map's first copy is projectToScreen within 180 degrees of the centre, under
// any heading, and its copies cover the view; the globe draws a point where
// projectToScreen does and keeps hidden ones for the limb; a ring crossing
// the limb is closed along it; a ring wholly behind the globe shows nothing;
// a ring holding the antipode is known by its winding; and the edges the data
// adds along 180 degrees and the South Pole are told from the coast.

import { GLOBE, type MapCamera, projectToScreen } from '@tabdock/sim-page/map';
import { describe, expect, it } from 'vitest';
import { earthGeography, EARTH_RADIUS_M, FLAT } from './earth.ts';
import { ringTwiceArea } from './decode.ts';
import {
  ANTIPODE_SHARE,
  densify,
  flatProjector,
  globeProjector,
  globeRing,
  isCutEdge,
  type LonLat,
} from './projection.ts';

const VIEWPORT = { widthPx: 960, heightPx: 540 };
const R = EARTH_RADIUS_M;

function camera(patch: Partial<MapCamera>): MapCamera {
  return { projection: FLAT, lon: 0, lat: 0, widthM: 20_000_000, headingDeg: 0, ...patch };
}

/** A circle of `radiusDeg` around a point, counterclockwise, closed, in 2 degree steps. */
function circle(lon: number, lat: number, radiusDeg: number): LonLat[] {
  const points: LonLat[] = [];
  for (let step = 0; step <= 180; step += 1) {
    const angle = (step / 180) * 2 * Math.PI;
    points.push([lon + radiusDeg * Math.cos(angle), lat + radiusDeg * Math.sin(angle)]);
  }
  return points;
}

describe('the flat map', () => {
  it('draws copy 0 where projectToScreen does, within 180 degrees of the centre and under a heading', () => {
    for (const view of [
      camera({ lon: 30, lat: 20, headingDeg: 0 }),
      camera({ lon: -170, lat: -45, headingDeg: 135, widthM: 5_000_000 }),
      camera({ lon: 179.9, lat: 60, headingDeg: 300, widthM: 900_000 }),
    ]) {
      const flat = flatProjector(view, VIEWPORT, R);
      for (const [lon, lat] of [
        [view.lon, view.lat],
        [-179, 50],
        [120, -80],
        [45.5, 10],
        [180, -16],
      ] as const) {
        const delta = lon - view.lon;
        // Copy 0 within 180 degrees of the centre; past that, the copy that brings it back.
        const copy = delta > 180 ? -1 : delta < -180 ? 1 : 0;
        if (Math.abs(delta) < 180) expect(copy).toBe(0);
        const mine = flat.project(lon, lat, copy);
        const theirs = projectToScreen(view, VIEWPORT, R, lon, lat);
        expect(theirs).not.toBeNull();
        expect(mine.x).toBeCloseTo(theirs?.x ?? NaN, 6);
        expect(mine.y).toBeCloseTo(theirs?.y ?? NaN, 6);
      }
    }
  });

  it('draws copies 360 degrees apart, as many as the view can show and no more', () => {
    const narrow = flatProjector(camera({ lon: 0, widthM: 1_000_000 }), VIEWPORT, R);
    expect(narrow.copies).toEqual([0]);
    const seam = flatProjector(camera({ lon: 179, widthM: 3_000_000 }), VIEWPORT, R);
    expect(seam.copies).toEqual([0, 1]);
    const wide = flatProjector(camera({ lon: 0, widthM: 100_000_000 }), VIEWPORT, R);
    expect(wide.copies.length).toBeGreaterThanOrEqual(3);
    const a = wide.project(10, 0, 0);
    const b = wide.project(10, 0, 1);
    const metresPerPx = 100_000_000 / VIEWPORT.widthPx;
    expect((b.x - a.x) * metresPerPx).toBeCloseTo(2 * Math.PI * R, 0);
    // Near a pole the copies would be endless; they stop at eight each side.
    const polar = flatProjector(camera({ lat: 89.999, widthM: 10_000_000 }), VIEWPORT, R);
    expect(polar.copies).toEqual([-8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('the globe', () => {
  const view = camera({ projection: GLOBE, lon: 20, lat: 10, widthM: 30_000_000, headingDeg: 30 });
  const globe = globeProjector(view, VIEWPORT, R);

  it('draws a visible point where projectToScreen does, and keeps a hidden one facing away', () => {
    for (const [lon, lat] of [
      [20, 10],
      [80, 40],
      [-50, -30],
    ] as const) {
      const mine = globe.project(lon, lat);
      const theirs = projectToScreen(view, VIEWPORT, R, lon, lat);
      expect(mine.facing).toBeGreaterThanOrEqual(0);
      expect(mine.x).toBeCloseTo(theirs?.x ?? NaN, 6);
      expect(mine.y).toBeCloseTo(theirs?.y ?? NaN, 6);
    }
    const behind = globe.project(-160, -10);
    expect(behind.facing).toBeLessThan(0);
    expect(projectToScreen(view, VIEWPORT, R, -160, -10)).toBeNull();
    expect(Math.hypot(behind.x - globe.cx, behind.y - globe.cy)).toBeLessThanOrEqual(
      globe.radiusPx,
    );
  });

  it('closes a ring that crosses the limb along the limb, filling only what faces the camera', () => {
    // A circle of 20 degrees centred 90 degrees from the view's centre: half in view.
    const shown = globeRing(globe, circle(110, 10, 20));
    expect(shown.kind).toBe('visible');
    if (shown.kind !== 'visible') return;
    expect(shown.holdsAntipode).toBe(false);
    const onLimb = shown.outline.filter(
      (point) =>
        Math.abs(Math.hypot(point.x - globe.cx, point.y - globe.cy) - globe.radiusPx) < 1e-6,
    );
    expect(onLimb.length).toBeGreaterThan(5);
    for (const point of shown.outline) {
      expect(Math.hypot(point.x - globe.cx, point.y - globe.cy)).toBeLessThanOrEqual(
        globe.radiusPx + 1e-6,
      );
    }
  });

  it('shows nothing of a ring wholly behind the globe, unless it runs round all that faces the camera', () => {
    expect(globeRing(globe, circle(-100, -40, 10))).toEqual({ kind: 'hidden', turns: 0 });
    // Round the antipode (-160, -10), holding it: it winds clockwise round the disc, and shows nothing.
    expect(globeRing(globe, circle(-160, -10, 15))).toEqual({ kind: 'hidden', turns: -1 });
    // The same ring run the other way holds everything but that cap, the whole visible half among it.
    expect(globeRing(globe, circle(-160, -10, 15).reverse())).toEqual({
      kind: 'hidden',
      turns: 1,
    });
  });

  it('knows a ring that holds the antipode, so the limb is added and only its visible part fills', () => {
    // Everything but a cap of 60 degrees round the view's centre, as a ring
    // run with that everything on its left: clockwise round the cap.
    const around = circle(20, 10, 60).reverse();
    const shown = globeRing(globe, around);
    expect(shown.kind).toBe('visible');
    if (shown.kind === 'visible') expect(shown.holdsAntipode).toBe(true);
    // The same ring the other way holds the cap, and not the antipode.
    const cap = globeRing(globe, circle(20, 10, 60));
    expect(cap.kind === 'visible' && cap.holdsAntipode).toBe(false);
  });

  it('agrees on the antipode for every land ring at views where an edge of the data runs through it', () => {
    // At longitude 0 the antipode sits on the data's cut along 180 degrees.
    for (const lat of [-68, 16.5, 0, 66]) {
      const at = globeProjector(
        camera({ projection: GLOBE, lat, widthM: 30_000_000 }),
        VIEWPORT,
        R,
      );
      const disc = Math.PI * at.radiusPx * at.radiusPx;
      for (const polygon of earthGeography().land) {
        for (const ring of polygon) {
          const steps = densify(ring).points;
          const fill = ringTwiceArea(ring) < 0 ? [...steps].reverse() : steps;
          const shown = globeRing(at, fill);
          if (shown.kind !== 'visible') continue;
          let twice = 0;
          shown.outline.forEach((a, index) => {
            const b = shown.outline[(index + 1) % shown.outline.length] ?? a;
            twice += b.x * a.y - a.x * b.y;
          });
          // Either clearly counterclockwise (it shows land) or clockwise round
          // most of the disc (it holds the antipode); never in between.
          const share = twice / 2 / disc;
          expect(share > -ANTIPODE_SHARE || share < -0.3, `lat ${String(lat)}`).toBe(true);
          expect(shown.holdsAntipode).toBe(share < -ANTIPODE_SHARE);
        }
      }
    }
  });
});

describe('the edges the data adds', () => {
  it('are the runs along 180 degrees and along the South Pole, and no coast', () => {
    expect(isCutEdge([180, -84], [180, -90])).toBe(true);
    expect(isCutEdge([-180, 65], [-180, 66])).toBe(true);
    expect(isCutEdge([180, -90], [-180, -90])).toBe(true);
    expect(isCutEdge([179.9, 65], [180, 66])).toBe(false);
    expect(isCutEdge([10, -70], [12, -70])).toBe(false);
  });

  it('are kept through densifying, which steps no more than 2 degrees', () => {
    const { points, cut } = densify([
      [170, -85],
      [180, -85],
      [180, -90],
      [-180, -90],
      [-170, -85],
      [170, -85],
    ]);
    expect(points.at(-1)).toEqual([170, -85]);
    expect(cut).toHaveLength(points.length - 1);
    for (let index = 0; index + 1 < points.length; index += 1) {
      const [a0 = 0, a1 = 0] = points[index] ?? [];
      const [b0 = 0, b1 = 0] = points[index + 1] ?? [];
      expect(Math.max(Math.abs(b0 - a0), Math.abs(b1 - a1))).toBeLessThanOrEqual(2 + 1e-9);
    }
    // The cut along 180 and the run along the pole are marked; the coasts are not.
    expect(cut.filter(Boolean).length).toBe(3 + 180);
  });
});

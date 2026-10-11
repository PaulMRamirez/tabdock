// The math the sim world and the canvas page share (ADR 0038): the centre is
// drawn at the centre, a globe hides what is behind it, a box across the
// antimeridian runs west to east the long way round as RFC 7946 writes it,
// and the fixture's footprints follow GeoJSON's winding rule.

import { describe, expect, it } from 'vitest';
import {
  altitudeFromWidth,
  angularDistanceDeg,
  createMapWorld,
  FootprintSchema,
  isInView,
  type MapCamera,
  moonWorldData,
  MOON_RADIUS_M,
  projectToScreen,
  ringIsCounterclockwise,
  viewBounds,
  widthFromAltitude,
  wrapLon,
} from '../src/map/index.ts';

const VIEWPORT = { widthPx: 960, heightPx: 540 };

function camera(overrides: Partial<MapCamera> = {}): MapCamera {
  return {
    projection: 'equirectangular',
    lon: 0,
    lat: 0,
    widthM: 1_000_000,
    headingDeg: 0,
    ...overrides,
  };
}

describe('projectToScreen', () => {
  it.each([
    ['a 2D map', camera({ lon: 31.4, lat: 8.5, headingDeg: 30 })],
    ['a globe', camera({ projection: 'globe', lon: -150, lat: -60, headingDeg: 300 })],
  ])('draws the centre at the middle of the viewport on %s', (_label, view) => {
    const at = projectToScreen(view, VIEWPORT, MOON_RADIUS_M, view.lon, view.lat);
    expect(at?.x).toBeCloseTo(480, 9);
    expect(at?.y).toBeCloseTo(270, 9);
  });

  it('hides the antipode on a globe, and shows it on a 2D map', () => {
    const globe = camera({ projection: 'globe', lon: 20, lat: 10, widthM: 10_000_000 });
    expect(projectToScreen(globe, VIEWPORT, MOON_RADIUS_M, -160, -10)).toBeNull();
    expect(isInView(globe, VIEWPORT, MOON_RADIUS_M, -160, -10)).toBe(false);
    expect(projectToScreen(camera(), VIEWPORT, MOON_RADIUS_M, -160, -10)).not.toBeNull();
  });

  it('puts north at the top at heading 0, and on the left at heading 90', () => {
    const north = (headingDeg: number) =>
      projectToScreen(camera({ headingDeg }), VIEWPORT, MOON_RADIUS_M, 0, 1);
    expect(north(0)?.x).toBeCloseTo(480, 9);
    expect(north(0)?.y ?? 0).toBeLessThan(270);
    expect(north(90)?.x ?? 0).toBeLessThan(480);
    expect(north(90)?.y).toBeCloseTo(270, 9);
  });

  it('draws widthM across the viewport through its centre', () => {
    const view = camera({ lat: 40, widthM: 300_000 });
    const metresPerDegreeOfLon = ((Math.PI * MOON_RADIUS_M) / 180) * Math.cos((40 * Math.PI) / 180);
    const halfWidthDeg = 150_000 / metresPerDegreeOfLon;
    expect(projectToScreen(view, VIEWPORT, MOON_RADIUS_M, halfWidthDeg, 40)?.x).toBeCloseTo(960, 6);
  });
});

describe('viewBounds', () => {
  it('runs west to east the long way round across the antimeridian, west greater than east', () => {
    const bounds = viewBounds(camera({ lon: 179, widthM: 1_000_000 }), VIEWPORT, MOON_RADIUS_M);
    expect(bounds).not.toBeNull();
    expect(bounds?.west ?? 0).toBeGreaterThan(bounds?.east ?? 0);
    expect(bounds?.west ?? 0).toBeGreaterThan(160);
    expect(bounds?.east ?? 0).toBeLessThan(-160);
    const globe = viewBounds(
      camera({ projection: 'globe', lon: -179.5, widthM: 300_000 }),
      VIEWPORT,
      MOON_RADIUS_M,
    );
    expect(globe?.west ?? 0).toBeGreaterThan(globe?.east ?? 0);
  });

  it('is symmetric about a centre on the equator with heading 0', () => {
    const bounds = viewBounds(camera(), VIEWPORT, MOON_RADIUS_M);
    expect(bounds?.west).toBeCloseTo(-(bounds?.east ?? 0), 9);
    expect(bounds?.south).toBeCloseTo(-(bounds?.north ?? 0), 9);
  });

  it('takes every longitude when a pole is in view', () => {
    for (const view of [
      camera({ lat: 89, widthM: 1_000_000 }),
      camera({ projection: 'globe', lat: -85, widthM: 1_000_000 }),
    ]) {
      const bounds = viewBounds(view, VIEWPORT, MOON_RADIUS_M);
      expect(bounds).toMatchObject({ west: -180, east: 180 });
      expect(Math.abs(view.lat > 0 ? (bounds?.north ?? 0) : (bounds?.south ?? 0))).toBe(90);
    }
  });

  it("is null once a globe's horizon is in view", () => {
    const globe = camera({ projection: 'globe', widthM: 2 * MOON_RADIUS_M });
    expect(viewBounds(globe, VIEWPORT, MOON_RADIUS_M)).toBeNull();
    expect(viewBounds({ ...globe, widthM: 1_000_000 }, VIEWPORT, MOON_RADIUS_M)).not.toBeNull();
  });
});

describe('the camera on a globe', () => {
  it('relates altitude and width through the field of view, each the inverse of the other', () => {
    for (const fovDeg of [1, 30, 60, 120, 179]) {
      for (const widthM of [1, 1_000, 2_500_000, 1e10]) {
        const altitudeM = altitudeFromWidth(widthM, fovDeg);
        expect(widthFromAltitude(altitudeM, fovDeg) / widthM).toBeCloseTo(1, 12);
      }
    }
    // A 90 degree view from 1 km up sees 2 km across.
    expect(widthFromAltitude(1000, 90)).toBeCloseTo(2000, 9);
  });
});

describe('the fixture', () => {
  it("draws every footprint's rings counterclockwise and closed, cut at the antimeridian", () => {
    const data = moonWorldData();
    for (const observation of data.observations) {
      const footprint = FootprintSchema.parse(observation.footprint);
      const polygons =
        footprint.type === 'Polygon' ? [footprint.coordinates] : footprint.coordinates;
      for (const polygon of polygons) {
        expect(ringIsCounterclockwise(polygon[0] ?? [])).toBe(true);
        for (const ring of polygon) {
          for (const [lon] of ring) expect(Math.abs(lon)).toBeLessThanOrEqual(180);
        }
      }
    }
    expect(data.observations.map((observation) => observation.footprint?.type)).toContain(
      'MultiPolygon',
    );
    expect(
      ringIsCounterclockwise(
        [...(data.observations[0]?.footprint?.coordinates[0] as [number, number][])].reverse(),
      ),
    ).toBe(false);
  });

  it('starts at the same view every time, and orders features by angle from the centre', () => {
    expect(createMapWorld().view()).toEqual(createMapWorld().view());
    expect(angularDistanceDeg(0, 0, 90, 0)).toBeCloseTo(90, 9);
    expect(angularDistanceDeg(179, 0, -179, 0)).toBeCloseTo(2, 9);
    expect(wrapLon(181)).toBeCloseTo(-179, 9);
    expect(wrapLon(180)).toBe(180);
    expect(wrapLon(540)).toBe(180);
  });
});

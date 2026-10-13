// The vendored geography (ADR 0050): its compact form reads back exactly what
// was written, the module holds the counts and the credit the generator
// wrote, every ring is closed, on the globe and wound as RFC 7946 asks, and
// every name is drawn on its own water. A damaged ring stops the page
// instead of drawing something else. The generator and the module's size
// budget are held in test/vendor.test.ts, which reads files.

import { describe, expect, it } from 'vitest';
import {
  decodeGeography,
  decodeRing,
  encodeRing,
  polygonContains,
  ringContains,
  ringTwiceArea,
} from './decode.ts';
import { ATTRIBUTION, GEOGRAPHY, NATURAL_EARTH } from './data/natural-earth-110m.ts';

const geography = decodeGeography(GEOGRAPHY);

describe('the compact ring form', () => {
  it('reads back every position it wrote, closed, steps of every size and sign included', () => {
    const tenths: [number, number][] = [
      [1800, 900],
      [-1800, -900],
      [0, 0],
      [15, -16],
      [-1, 1],
      [1023, -800],
    ];
    const ring = decodeRing(encodeRing(tenths));
    const closed = [...tenths, [1800, 900]];
    expect(ring).toEqual(closed.map(([lon = 0, lat = 0]) => [lon / 10, lat / 10]));
  });

  it('writes only letters that need no escaping, one letter for a small step', () => {
    const text = encodeRing([
      [100, 200],
      [101, 199],
      [103, 199],
    ]);
    expect(text).toMatch(/^[A-Za-z0-9+/]+$/);
    // The first position takes two letters a number, the two steps one each.
    expect(text.length).toBe(4 + 4);
  });

  it('refuses a damaged ring rather than drawing something else', () => {
    const good = encodeRing([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    expect(() => decodeRing(`${good}*`)).toThrow(/alphabet/);
    expect(() => decodeRing(good.slice(0, -1))).toThrow(/part way/);
    expect(() => decodeRing('g')).toThrow(/part way/);
    expect(() =>
      decodeRing(
        encodeRing([
          [0, 0],
          [10, 0],
        ]),
      ),
    ).toThrow(/three/);
    expect(() =>
      decodeRing(
        encodeRing([
          [0, 0],
          [1801, 0],
          [0, 1],
        ]),
      ),
    ).toThrow(/off the globe/);
  });
});

describe('the vendored module', () => {
  it('holds Natural Earth v5.1.2 and the credit its terms suggest', () => {
    expect(NATURAL_EARTH).toEqual({ tag: 'v5.1.2', commit: 'f1890d9', released: '2022-05-13' });
    expect(ATTRIBUTION).toBe(
      'Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com.',
    );
  });

  it('holds 127 land polygons, 24 lakes and one hole in the land', () => {
    expect(geography.land).toHaveLength(127);
    expect(geography.lakes).toHaveLength(24);
    const holes = geography.land.flatMap((polygon) => polygon.slice(1));
    expect(holes).toEqual([geography.caspian.ring]);
    const positions = [...geography.land.flat(), ...geography.lakes.flatMap((lake) => lake.rings)]
      .map((ring) => ring.length)
      .reduce((sum, count) => sum + count, 0);
    expect(positions).toBe(5568);
  });

  it('closes every ring, keeps it on the globe and winds exteriors counterclockwise, holes clockwise', () => {
    const exteriors = [
      ...geography.land.map((polygon) => polygon[0]),
      ...geography.lakes.map((lake) => lake.rings[0]),
    ];
    const holes = geography.land.flatMap((polygon) => polygon.slice(1));
    for (const ring of [...exteriors, ...holes]) {
      if (!ring) throw new Error('a polygon has no rings');
      expect(ring.length).toBeGreaterThanOrEqual(4);
      expect(ring.at(-1)).toEqual(ring[0]);
      for (const [lon, lat] of ring) {
        expect(Math.abs(lon)).toBeLessThanOrEqual(180);
        expect(Math.abs(lat)).toBeLessThanOrEqual(90);
      }
    }
    for (const ring of exteriors) expect(ringTwiceArea(ring ?? [])).toBeGreaterThan(0);
    for (const ring of holes) expect(ringTwiceArea(ring)).toBeLessThan(0);
  });

  it('puts the Caspian Sea, as a hole, where it lies, and its name on its water', () => {
    const { ring, lon, lat } = geography.caspian;
    for (const [x, y] of ring) {
      expect(x).toBeGreaterThanOrEqual(46);
      expect(x).toBeLessThanOrEqual(55);
      expect(y).toBeGreaterThanOrEqual(36);
      expect(y).toBeLessThanOrEqual(48);
    }
    expect(ringContains(ring, lon, lat)).toBe(true);
    // On water: inside no land polygon, the one around it included.
    expect(geography.land.some((polygon) => polygonContains(polygon, lon, lat))).toBe(false);
  });

  it('draws each lake name on its own water, under a unique id', () => {
    for (const lake of geography.lakes) {
      expect(polygonContains(lake.rings, lake.lon, lake.lat), lake.name).toBe(true);
      expect(lake.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(lake.name.trim()).toBe(lake.name);
    }
    expect(new Set(geography.lakes.map((lake) => lake.id)).size).toBe(24);
    expect(geography.lakes.map((lake) => lake.name)).toContain('Lake Baikal');
  });
});

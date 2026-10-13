// Writes src/data/natural-earth-110m.ts, the map demo's geography (ADR
// 0050), from Natural Earth's 1:110 million land and lakes at tag v5.1.2.
// It runs by hand, never in CI and never in the page:
//   node apps/map-demo/scripts/vendor-natural-earth.ts             fetch both files at the tag
//   node apps/map-demo/scripts/vendor-natural-earth.ts --from DIR  read them from DIR instead
// It stops unless each file's SHA-256 is the one pinned here, so a changed
// upstream file stops the run rather than slipping in, and the same files
// always give the same bytes, so a rerun at the tag shows no diff.
//
// Natural Earth is in the public domain ("No permission is needed to use
// Natural Earth. Crediting the authors is unnecessary."); the page credits it
// anyway, with the line the terms suggest, which the module exports.

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import { z } from 'zod';
import { encodeRing, ringContains, ringTwiceArea, TENTHS_PER_DEGREE } from '../src/decode.ts';

const TAG = 'v5.1.2';
/** The tag's commit and the release date its CHANGELOG gives. */
const COMMIT = 'f1890d9';
const RELEASED = '2022-05-13';
const BASE = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${TAG}/geojson/`;

const FILES = {
  land: {
    name: 'ne_110m_land.geojson',
    sha256: '9e0729ee253ca7d7a5c4ae9395fb1902264c5377c52e224d13dd85010e2835d9',
  },
  lakes: {
    name: 'ne_110m_lakes.geojson',
    sha256: 'eb02ecc86c82004fccbf979058bfabbbd6c2d07968c7844d38eb1c9152d2ffc9',
  },
} as const;

export const ATTRIBUTION =
  'Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com.';

const appDir = resolve(import.meta.dirname, '..');
export const DATA_MODULE = join(appDir, 'src/data/natural-earth-110m.ts');

/** Where the Caspian Sea lies, so the land's one hole is named only once it is checked to be there. */
const CASPIAN_BOX = { west: 46, east: 55, south: 36, north: 48 };

const PositionSchema = z.array(z.number()).min(2);
const PolygonSchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(z.array(PositionSchema).min(4)).min(1),
});
const LandSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(z.object({ geometry: PolygonSchema })).min(1),
});
const LakesSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z
    .array(
      z.object({
        properties: z.object({ name: z.string().min(1).max(80), scalerank: z.number() }),
        geometry: PolygonSchema,
      }),
    )
    .min(1),
});

type Tenths = [number, number];

async function load(name: string, sha256: string, from: string | null): Promise<unknown> {
  let bytes: Uint8Array;
  if (from === null) {
    const response = await fetch(`${BASE}${name}`);
    if (!response.ok) throw new Error(`${name}: the fetch answered ${String(response.status)}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } else {
    bytes = await readFile(join(from, name));
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== sha256) {
    throw new Error(
      `${name}: its SHA-256 is not the one pinned for ${TAG}, so nothing was written`,
    );
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

/**
 * A ring rounded to tenths, open, with repeated positions dropped, or null
 * when fewer than three distinct positions remain or it holds no area.
 * Exterior rings come out counterclockwise and holes clockwise, as RFC 7946
 * asks; the files hold the shapefile order, which is the other way round.
 */
export function quantizeRing(ring: readonly (readonly number[])[], hole: boolean): Tenths[] | null {
  const out: Tenths[] = [];
  for (const position of ring) {
    const lon = Math.max(-1800, Math.min(1800, Math.round((position[0] ?? 0) * TENTHS_PER_DEGREE)));
    const lat = Math.max(-900, Math.min(900, Math.round((position[1] ?? 0) * TENTHS_PER_DEGREE)));
    const last = out.at(-1);
    if (last && last[0] === lon && last[1] === lat) continue;
    out.push([lon, lat]);
  }
  // Stored open: the closing position, and any run equal to the first, goes.
  for (;;) {
    const first = out[0];
    const last = out.at(-1);
    if (out.length < 2 || !first || !last || first[0] !== last[0] || first[1] !== last[1]) break;
    out.pop();
  }
  if (out.length < 3) return null;
  const area = ringTwiceArea([...out, out[0] ?? [0, 0]]);
  if (area === 0) return null;
  const counterclockwise = area > 0;
  if (counterclockwise === hole) out.reverse();
  return out;
}

function degrees(ring: readonly Tenths[]): [number, number][] {
  const closed = [...ring, ring[0] ?? [0, 0]];
  return closed.map(([lon, lat]) => [lon / TENTHS_PER_DEGREE, lat / TENTHS_PER_DEGREE]);
}

/** The distance from a point to a segment, in degrees with longitude scaled by the latitude's cosine. */
function segmentDistance(
  px: number,
  py: number,
  [x1, y1]: readonly [number, number],
  [x2, y2]: readonly [number, number],
): number {
  const scale = Math.cos((py * Math.PI) / 180);
  const ax = (x1 - px) * scale;
  const ay = y1 - py;
  const bx = (x2 - px) * scale;
  const by = y2 - py;
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/**
 * A point inside a ring to draw its name at: of the points on the 0.1
 * degree grid that lie inside, the one farthest from the shore, the first in
 * scan order on a tie, so a long thin lake gets a point on its own water and
 * the same ring always gets the same point.
 */
export function labelPoint(ring: readonly Tenths[]): [number, number] {
  const closed = degrees(ring);
  const box = bounds(ring);
  let best: [number, number] | null = null;
  let farthest = -1;
  for (let lat = Math.round(box.south * 10); lat <= Math.round(box.north * 10); lat += 1) {
    for (let lon = Math.round(box.west * 10); lon <= Math.round(box.east * 10); lon += 1) {
      const x = lon / 10;
      const y = lat / 10;
      if (!ringContains(closed, x, y)) continue;
      let nearest = Infinity;
      for (let index = 0; index + 1 < closed.length; index += 1) {
        const a = closed[index];
        const b = closed[index + 1];
        if (a && b) nearest = Math.min(nearest, segmentDistance(x, y, a, b));
      }
      if (nearest > farthest) {
        farthest = nearest;
        best = [x, y];
      }
    }
  }
  if (!best) throw new Error('found no point inside a ring to draw its name at');
  return best;
}

/** A lake's id from its name: plain ASCII letters and digits in lower case, joined by hyphens. */
export function lakeId(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function bounds(ring: readonly Tenths[]): {
  west: number;
  east: number;
  south: number;
  north: number;
} {
  const lons = ring.map(([lon]) => lon / TENTHS_PER_DEGREE);
  const lats = ring.map(([, lat]) => lat / TENTHS_PER_DEGREE);
  return {
    west: Math.min(...lons),
    east: Math.max(...lons),
    south: Math.min(...lats),
    north: Math.max(...lats),
  };
}

export interface Vendored {
  land: string[][];
  lakes: { id: string; name: string; rank: number; lon: number; lat: number; rings: string[] }[];
  caspian: { polygon: number; ring: number; lon: number; lat: number };
  positions: number;
}

/** The two parsed files as the module's data. */
export function vendor(landJson: unknown, lakesJson: unknown): Vendored {
  const landFile = LandSchema.parse(landJson);
  const lakesFile = LakesSchema.parse(lakesJson);
  let positions = 0;
  const land: string[][] = [];
  const holes: { polygon: number; ring: number; tenths: Tenths[] }[] = [];
  for (const feature of landFile.features) {
    const [exterior, ...rest] = feature.geometry.coordinates;
    const outer = exterior ? quantizeRing(exterior, false) : null;
    if (!outer) continue;
    const rings = [outer];
    for (const hole of rest) {
      const inner = quantizeRing(hole, true);
      if (!inner) continue;
      holes.push({ polygon: land.length, ring: rings.length, tenths: inner });
      rings.push(inner);
    }
    positions += rings.reduce((sum, ring) => sum + ring.length + 1, 0);
    land.push(rings.map(encodeRing));
  }
  const [hole, ...others] = holes;
  if (!hole || others.length > 0) throw new Error('expected the land to hold exactly one hole');
  const box = bounds(hole.tenths);
  if (
    box.west < CASPIAN_BOX.west ||
    box.east > CASPIAN_BOX.east ||
    box.south < CASPIAN_BOX.south ||
    box.north > CASPIAN_BOX.north
  ) {
    throw new Error("the land's one hole is not where the Caspian Sea lies");
  }
  const [caspianLon, caspianLat] = labelPoint(hole.tenths);
  const lakes: Vendored['lakes'] = [];
  for (const feature of lakesFile.features) {
    const [exterior, ...rest] = feature.geometry.coordinates;
    if (!exterior || rest.length > 0) throw new Error('expected each lake to be one ring');
    const ring = quantizeRing(exterior, false);
    if (!ring) continue;
    const name = feature.properties.name.trim();
    const [lon, lat] = labelPoint(ring);
    positions += ring.length + 1;
    lakes.push({
      id: lakeId(name),
      name,
      rank: feature.properties.scalerank,
      lon,
      lat,
      rings: [encodeRing(ring)],
    });
  }
  if (new Set(lakes.map((lake) => lake.id)).size !== lakes.length) {
    throw new Error("two lakes' names give the same id");
  }
  return {
    land,
    lakes,
    caspian: { polygon: hole.polygon, ring: hole.ring, lon: caspianLon, lat: caspianLat },
    positions,
  };
}

/** The module's text before prettier formats it. */
export function moduleText(data: Vendored): string {
  return `// Generated by apps/map-demo/scripts/vendor-natural-earth.ts; do not edit.
//
// Natural Earth 1:110m land and lakes, tag ${TAG} (commit ${COMMIT}, released
// ${RELEASED}), from github.com/nvkelso/natural-earth-vector:
//   ${BASE}${FILES.land.name}
//     SHA-256 ${FILES.land.sha256}
//   ${BASE}${FILES.lakes.name}
//     SHA-256 ${FILES.lakes.sha256}
// Natural Earth is in the public domain. Positions are rounded to 0.1 degree
// and stored as src/decode.ts describes: ${String(data.land.length)} land polygons and
// ${String(data.lakes.length)} lakes, ${String(data.positions)} positions in all.

import type { StoredGeography } from '../decode.ts';

/** The credit Natural Earth's terms suggest, which the page shows. */
export const ATTRIBUTION = ${JSON.stringify(ATTRIBUTION)};

export const NATURAL_EARTH = { tag: '${TAG}', commit: '${COMMIT}', released: '${RELEASED}' } as const;

export const GEOGRAPHY: StoredGeography = ${JSON.stringify({
    land: data.land,
    lakes: data.lakes,
    caspian: data.caspian,
  })};
`;
}

async function main(): Promise<void> {
  const at = process.argv.indexOf('--from');
  const from = at >= 0 ? resolve(process.argv[at + 1] ?? '.') : null;
  const landJson = await load(FILES.land.name, FILES.land.sha256, from);
  const lakesJson = await load(FILES.lakes.name, FILES.lakes.sha256, from);
  const data = vendor(landJson, lakesJson);
  const options = (await prettier.resolveConfig(DATA_MODULE)) ?? {};
  const text = await prettier.format(moduleText(data), { ...options, filepath: DATA_MODULE });
  await writeFile(DATA_MODULE, text);
  console.log(
    `Wrote ${DATA_MODULE}: ${String(data.land.length)} land polygons, ${String(data.lakes.length)} lakes, ${String(data.positions)} positions, ${String(Buffer.byteLength(text))} bytes`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

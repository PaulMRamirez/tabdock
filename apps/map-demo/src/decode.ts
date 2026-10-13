// The vendored geography's compact form, read and written (ADR 0050). Each
// ring is stored open, its positions integer tenths of a degree, the first
// one whole and each after it as the step from the one before, every number
// zigzag coded and written five bits to a base64 letter with a sixth bit
// saying another letter follows, as source maps write theirs. A 0.1 degree
// step is about 11 km, under a pixel on the widest view the page shows, and
// most steps take one letter, so Earth's land and lakes fit in about 15 KB
// of text that needs no escaping. The generator encodes (scripts/
// vendor-natural-earth.ts) and the page decodes, so both live here and a
// round trip is one test.

/** The letters, in value order; none needs escaping in a quoted string. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALUE_OF = new Map(
  Array.from({ length: ALPHABET.length }, (_, value) => [ALPHABET.charAt(value), value] as const),
);
const MORE = 32;
const LOW_BITS = 31;

/** Tenths of a degree in a stored position. */
export const TENTHS_PER_DEGREE = 10;
const MAX_LON_TENTHS = 180 * TENTHS_PER_DEGREE;
const MAX_LAT_TENTHS = 90 * TENTHS_PER_DEGREE;

/** A [longitude, latitude] pair in degrees, in GeoJSON's order. */
export type Position = [number, number];
/** A closed ring, its last position the same as its first (RFC 7946 section 3.1.6). */
export type Ring = Position[];

function zigzag(value: number): number {
  return value >= 0 ? value * 2 : -value * 2 - 1;
}

function unzigzag(value: number): number {
  return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
}

/**
 * One open ring of integer tenths, each [lon, lat], as text. The generator
 * has already rounded, dropped repeats and fixed the winding.
 */
export function encodeRing(tenths: readonly (readonly [number, number])[]): string {
  let out = '';
  let lastLon = 0;
  let lastLat = 0;
  for (const [lon, lat] of tenths) {
    if (!Number.isInteger(lon) || !Number.isInteger(lat)) {
      throw new Error('a stored position is whole tenths of a degree');
    }
    for (const step of [lon - lastLon, lat - lastLat]) {
      let rest = zigzag(step);
      do {
        const low = rest & LOW_BITS;
        rest = Math.floor(rest / MORE);
        out += ALPHABET.charAt(rest > 0 ? low | MORE : low);
      } while (rest > 0);
    }
    lastLon = lon;
    lastLat = lat;
  }
  return out;
}

/**
 * The text back as a closed ring in degrees. It throws on a letter outside
 * the alphabet, a number cut short, an odd count, a position out of range or
 * fewer than three distinct positions, so a damaged module stops the page
 * rather than drawing something else.
 */
export function decodeRing(text: string): Ring {
  const numbers: number[] = [];
  let value = 0;
  let scale = 1;
  let open = false;
  for (const letter of text) {
    const bits = VALUE_OF.get(letter);
    if (bits === undefined) throw new Error('a stored ring holds a letter outside its alphabet');
    value += (bits & LOW_BITS) * scale;
    scale *= MORE;
    open = (bits & MORE) !== 0;
    if (!open) {
      numbers.push(unzigzag(value));
      value = 0;
      scale = 1;
    }
  }
  if (open || numbers.length % 2 !== 0) throw new Error('a stored ring ends part way');
  const ring: Ring = [];
  let lon = 0;
  let lat = 0;
  for (let index = 0; index < numbers.length; index += 2) {
    lon += numbers[index] ?? 0;
    lat += numbers[index + 1] ?? 0;
    if (Math.abs(lon) > MAX_LON_TENTHS || Math.abs(lat) > MAX_LAT_TENTHS) {
      throw new Error('a stored position lies off the globe');
    }
    ring.push([lon / TENTHS_PER_DEGREE, lat / TENTHS_PER_DEGREE]);
  }
  if (ring.length < 3) throw new Error('a stored ring has fewer than three positions');
  const first = ring[0];
  if (first) ring.push([first[0], first[1]]);
  return ring;
}

/** One lake as the module stores it. */
export interface StoredLake {
  readonly id: string;
  readonly name: string;
  /** Natural Earth's scalerank: lower is more prominent. */
  readonly rank: number;
  /** Where its name is drawn, inside the lake. */
  readonly lon: number;
  readonly lat: number;
  readonly rings: readonly string[];
}

/** The generated module's data, as decodeGeography reads it. */
export interface StoredGeography {
  /** Each land polygon: its exterior ring, then any holes. */
  readonly land: readonly (readonly string[])[];
  readonly lakes: readonly StoredLake[];
  /** The land's one hole, which is the Caspian Sea, by polygon and ring index. */
  readonly caspian: {
    readonly polygon: number;
    readonly ring: number;
    readonly lon: number;
    readonly lat: number;
  };
}

export interface Lake {
  readonly id: string;
  readonly name: string;
  readonly rank: number;
  readonly lon: number;
  readonly lat: number;
  readonly rings: readonly Ring[];
}

export interface Geography {
  /** Each polygon's exterior ring runs counterclockwise and its holes clockwise (RFC 7946). */
  readonly land: readonly (readonly Ring[])[];
  readonly lakes: readonly Lake[];
  readonly caspian: { readonly ring: Ring; readonly lon: number; readonly lat: number };
}

export function decodeGeography(stored: StoredGeography): Geography {
  const land = stored.land.map((polygon) => polygon.map(decodeRing));
  const caspianRing = land[stored.caspian.polygon]?.[stored.caspian.ring];
  if (!caspianRing || stored.caspian.ring === 0) {
    throw new Error("the stored Caspian Sea names no hole in the land's rings");
  }
  return {
    land,
    lakes: stored.lakes.map((lake) => ({
      id: lake.id,
      name: lake.name,
      rank: lake.rank,
      lon: lake.lon,
      lat: lake.lat,
      rings: lake.rings.map(decodeRing),
    })),
    caspian: { ring: caspianRing, lon: stored.caspian.lon, lat: stored.caspian.lat },
  };
}

/**
 * Twice a ring's signed area in the longitude and latitude plane: above
 * zero when it runs counterclockwise. Natural Earth cuts its rings at the
 * antimeridian and closes Antarctica along -90, so the plane's answer is
 * the sphere's for this data.
 */
export function ringTwiceArea(ring: readonly (readonly [number, number])[]): number {
  let twice = 0;
  for (let index = 0; index + 1 < ring.length; index += 1) {
    const [x1, y1] = ring[index] ?? [0, 0];
    const [x2, y2] = ring[index + 1] ?? [0, 0];
    twice += x1 * y2 - x2 * y1;
  }
  return twice;
}

/** Whether a point lies inside a closed ring, in the longitude and latitude plane, by the even-odd rule. */
export function ringContains(
  ring: readonly (readonly [number, number])[],
  lon: number,
  lat: number,
): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi, yi] = ring[index] ?? [0, 0];
    const [xj, yj] = ring[previous] ?? [0, 0];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Whether a point lies on land or water a polygon covers: inside its exterior and none of its holes. */
export function polygonContains(polygon: readonly Ring[], lon: number, lat: number): boolean {
  const [exterior, ...holes] = polygon;
  if (!exterior || !ringContains(exterior, lon, lat)) return false;
  return !holes.some((hole) => ringContains(hole, lon, lat));
}

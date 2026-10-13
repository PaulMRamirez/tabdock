// The map demo's world (ADR 0050): Earth from the vendored Natural Earth data,
// on a flat map and a globe, with no clock. Its features are the 24 lakes at
// the label points the generator found, the Caspian Sea and Madagascar; its
// one walkthrough is a six-stop tour of things the data draws, each with one
// short fact, checked against a source on 13 October 2026 and rounded with
// "about"; and its three observations outline the Caspian, Baikal and the
// Great Lakes from the data itself, marked as outlines, not photographs.
// Nothing here names a border, a country's claim, a person or a brand, and a
// lake whose name differs by the country on its shore carries every name in
// use (DISPLAY_NAMES), so the page takes no side (ADR 0050, decision 5).

import {
  type Footprint,
  GLOBE,
  MapWorld,
  type MapWorldData,
  type MapWorldOptions,
  type MapStopView,
  widthFromAltitude,
} from '@tabdock/sim-page/map';
import { GEOGRAPHY, NATURAL_EARTH } from './data/natural-earth-110m.ts';
import { decodeGeography, type Geography, type Ring } from './decode.ts';

/** Earth's mean radius in metres (IUGG). */
export const EARTH_RADIUS_M = 6_371_008.8;
export const EARTH = 'earth';
/** The flat map's projection: the profile's local equirectangular one. */
export const FLAT = 'equirectangular';
export const TOUR_ID = 'earth';
/** The globe's field of view at every stop and observation. */
const FOV_DEG = 60;

/** Madagascar's label point, on its land (src/earth.test.ts checks it). */
const MADAGASCAR = { lon: 46.7, lat: -19.3 } as const;

/**
 * Names the page shows in place of Natural Earth's, by feature id. The lake
 * Natural Earth calls Lake Malawi is Lake Nyasa in Tanzania and Lago Niassa
 * in Mozambique, a naming tied to a boundary dispute, so it carries all
 * three. The generated module stays a pure rerun of the generator; any other
 * name is reviewed in src/earth.test.ts, which lists all 26.
 */
const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  'lake-malawi': 'Lake Malawi (Lake Nyasa, Lago Niassa)',
};

/** The observations' time: the day the data was released. */
const DATA_TIME = `${NATURAL_EARTH.released}T00:00:00.000Z`;

const SOURCE = {
  name: `Natural Earth 1:110m, ${NATURAL_EARTH.tag}`,
  url: 'https://github.com/nvkelso/natural-earth-vector',
  credit: 'Made with Natural Earth.',
} as const;

const OUTLINE_NOTES = [
  "An outline drawn from Natural Earth's public-domain data, not a photograph.",
  'Its time is the day that data was released.',
];

let decoded: Geography | null = null;

/** The vendored geography, decoded once. */
export function earthGeography(): Geography {
  decoded ??= decodeGeography(GEOGRAPHY);
  return decoded;
}

function flat(lon: number, lat: number, widthM: number): MapStopView {
  return { body: EARTH, projection: FLAT, lon, lat, widthM, headingDeg: 0, pitchDeg: -90 };
}

function globe(lon: number, lat: number, altitudeM: number): MapStopView {
  return {
    body: EARTH,
    projection: GLOBE,
    lon,
    lat,
    widthM: widthFromAltitude(altitudeM, FOV_DEG),
    headingDeg: 0,
    pitchDeg: -90,
    altitudeM,
    fovDeg: FOV_DEG,
  };
}

/** A ring with its winding turned, so a hole in the land becomes an exterior ring of its own. */
function reversed(ring: Ring): Ring {
  return ring.map(([lon, lat]) => [lon, lat] as [number, number]).reverse();
}

function lakeRings(geography: Geography, ids: readonly string[]): Ring[][] {
  return ids.map((id) => {
    const lake = geography.lakes.find((entry) => entry.id === id);
    if (!lake) throw new Error(`the vendored data has no lake ${id}`);
    return lake.rings.map((ring) => ring.map(([lon, lat]) => [lon, lat] as [number, number]));
  });
}

function outline(
  id: string,
  title: string,
  centre: { lon: number; lat: number; altitudeM: number },
  footprint: Footprint,
): MapWorldData['observations'][number] {
  return {
    id,
    title,
    kind: 'outline',
    time: DATA_TIME,
    walkthroughId: TOUR_ID,
    viewpoint: {
      body: EARTH,
      lon: centre.lon,
      lat: centre.lat,
      altitudeM: centre.altitudeM,
      headingDeg: 0,
      pitchDeg: -90,
      fovDeg: FOV_DEG,
    },
    footprint,
    source: { ...SOURCE },
    notes: [...OUTLINE_NOTES],
  };
}

/** The tour's stops, in order; each text is plain and well under the profile's caps. */
const STOPS: readonly {
  title: string;
  text: string;
  view: MapStopView;
  observationId: string | null;
}[] = [
  {
    title: 'Earth from afar',
    text: 'Earth from about 23,000 km up, over the Atlantic. Water covers about 71 percent of its surface. The land drawn here is Natural Earth at 1:110 million.',
    view: globe(-30, 20, 23_000_000),
    observationId: null,
  },
  {
    title: 'The Caspian Sea',
    text: 'The largest inland body of water on Earth, about 371,000 square kilometres. In this data it is a gap in the land rather than one of the lakes.',
    view: flat(50.5, 41.8, 2_400_000),
    observationId: 'caspian-outline',
  },
  {
    title: 'Lake Baikal',
    text: 'The deepest lake on Earth, about 1,642 metres at its deepest, seen on the globe from about 1,600 km up.',
    view: globe(107.9, 53.6, 1_600_000),
    observationId: 'baikal-outline',
  },
  {
    title: 'The Great Lakes',
    text: 'Five lakes drawn from the data. Lake Superior, the largest of them, is counted alone the largest freshwater lake on Earth by area.',
    view: flat(-84, 45, 2_000_000),
    observationId: 'great-lakes-outline',
  },
  {
    title: 'Lake Victoria',
    text: "Africa's largest lake by area. Its one outflow, the Victoria Nile, leaves from its northern shore.",
    view: flat(33, -1.2, 900_000),
    observationId: null,
  },
  {
    title: 'Madagascar',
    text: 'The fourth largest island on Earth, after Greenland, New Guinea and Borneo, seen on the globe from about 3,000 km up.',
    view: globe(46.8, -19, 3_000_000),
    observationId: null,
  },
];

/** The ids of the five Great Lakes in the vendored data. */
export const GREAT_LAKES = [
  'lake-superior',
  'lake-michigan',
  'lake-huron',
  'lake-erie',
  'lake-ontario',
] as const;

/** Everything the world starts from, built from the decoded geography. */
export function earthWorldData(geography: Geography = earthGeography()): MapWorldData {
  const [baikal] = lakeRings(geography, ['lake-baikal']);
  return {
    bodies: [{ name: EARTH, radiusM: EARTH_RADIUS_M }],
    projections: [FLAT, GLOBE],
    view: { ...(STOPS[0]?.view ?? flat(0, 0, 40_000_000)) },
    clock: null,
    layers: [
      { id: 'land', title: 'Land', kind: 'base', visible: true, opacity: 1 },
      { id: 'lakes', title: 'Lakes', kind: 'overlay', visible: true, opacity: 1 },
      {
        id: 'graticule',
        title: 'Graticule, 30 degrees',
        kind: 'overlay',
        visible: true,
        opacity: 0.5,
      },
      { id: 'outlines', title: 'Observation outlines', kind: 'overlay', visible: true, opacity: 1 },
      { id: 'names', title: 'Names', kind: 'overlay', visible: true, opacity: 1 },
    ],
    features: [
      {
        id: 'caspian-sea',
        name: 'Caspian Sea',
        kind: 'inland_sea',
        lon: geography.caspian.lon,
        lat: geography.caspian.lat,
        rank: 0,
        body: EARTH,
      },
      {
        id: 'madagascar',
        name: 'Madagascar',
        kind: 'island',
        lon: MADAGASCAR.lon,
        lat: MADAGASCAR.lat,
        rank: 0,
        body: EARTH,
      },
      ...geography.lakes.map((lake) => ({
        id: lake.id,
        name: DISPLAY_NAMES[lake.id] ?? lake.name,
        kind: 'lake',
        lon: lake.lon,
        lat: lake.lat,
        rank: lake.rank,
        body: EARTH,
      })),
    ],
    walkthroughs: [
      {
        id: TOUR_ID,
        title: 'A short tour of Earth',
        stops: STOPS.map((stop) => ({ ...stop, view: { ...stop.view }, clock: null })),
      },
    ],
    observations: [
      outline(
        'caspian-outline',
        'Outline of the Caspian Sea',
        { lon: 50.5, lat: 41.8, altitudeM: 2_000_000 },
        { type: 'Polygon', coordinates: [reversed(geography.caspian.ring)] },
      ),
      outline(
        'baikal-outline',
        'Outline of Lake Baikal',
        { lon: 107.9, lat: 53.6, altitudeM: 1_400_000 },
        { type: 'Polygon', coordinates: baikal ?? [] },
      ),
      outline(
        'great-lakes-outline',
        'Outlines of the Great Lakes',
        { lon: -84, lat: 45, altitudeM: 1_800_000 },
        { type: 'MultiPolygon', coordinates: lakeRings(geography, GREAT_LAKES) },
      ),
    ],
  };
}

/** Each feature's rank, lower first, so the drawing places the more prominent names first. */
export function featureRanks(data: MapWorldData = earthWorldData()): Map<string, number> {
  return new Map(data.features.map((feature) => [feature.id, feature.rank]));
}

/** A world over Earth, its viewport fixed by the caller and its clock unused. */
export function createEarthWorld(options: MapWorldOptions = {}): MapWorld {
  return new MapWorld(earthWorldData(), options);
}

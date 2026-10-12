// The worked examples' fixture: the Moon, with a near side walkthrough on a
// 2D map and a synthetic flyby on the globe whose four stops each show one
// observation. Feature positions are approximate real ones, planetocentric
// and east-positive; the observations are made up and say so, and one
// footprint crosses the antimeridian so readers meet the MultiPolygon case.

import { widthFromAltitude } from './geometry.ts';
import type { MapStopView } from './profile.ts';
import { MapWorld, type MapWorldData, type MapWorldOptions } from './world.ts';

/** The Moon's mean radius in metres. */
export const MOON_RADIUS_M = 1_737_400;

function flat(lon: number, lat: number, widthM: number): MapStopView {
  return {
    body: 'moon',
    projection: 'equirectangular',
    lon,
    lat,
    widthM,
    headingDeg: 0,
    pitchDeg: -90,
  };
}

function globe(
  lon: number,
  lat: number,
  altitudeM: number,
  fovDeg: number,
  headingDeg: number,
  pitchDeg: number,
): MapStopView {
  return {
    body: 'moon',
    projection: 'globe',
    lon,
    lat,
    widthM: widthFromAltitude(altitudeM, fovDeg),
    headingDeg,
    pitchDeg,
    altitudeM,
    fovDeg,
  };
}

/** A square footprint around a point, its ring counterclockwise as RFC 7946 asks. */
function square(lon: number, lat: number, half: number): [number, number][] {
  return [
    [lon - half, lat - half],
    [lon + half, lat - half],
    [lon + half, lat + half],
    [lon - half, lat + half],
    [lon - half, lat - half],
  ];
}

const SYNTHETIC = { name: 'Synthetic test data', url: null, credit: null };
const NOTE = 'Synthetic: no real photo exists for this record.';

/** A fresh copy of the fixture's data, for a test that changes it before building a world. */
export function moonWorldData(): MapWorldData {
  return {
    bodies: [{ name: 'moon', radiusM: MOON_RADIUS_M }],
    projections: ['globe', 'equirectangular'],
    view: flat(0, 0, 3_000_000),
    clock: {
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-02T00:00:00.000Z',
      time: '2026-01-01T00:00:00.000Z',
      rate: 60,
      playing: false,
    },
    layers: [
      { id: 'albedo', title: 'Albedo', kind: 'base', visible: true, opacity: 1 },
      { id: 'elevation', title: 'Shaded relief', kind: 'base', visible: false, opacity: 1 },
      {
        id: 'graticule',
        title: 'Graticule, 30 degrees',
        kind: 'overlay',
        visible: true,
        opacity: 0.6,
      },
      { id: 'names', title: 'Feature names', kind: 'overlay', visible: true, opacity: 1 },
      { id: 'path', title: 'Flyby path', kind: 'overlay', visible: true, opacity: 1 },
      { id: 'footprints', title: 'Photo footprints', kind: 'overlay', visible: true, opacity: 0.8 },
    ],
    features: [
      {
        id: 'oceanus-procellarum',
        name: 'Oceanus Procellarum',
        kind: 'mare',
        lon: -57.4,
        lat: 18.4,
        rank: 1,
      },
      { id: 'mare-imbrium', name: 'Mare Imbrium', kind: 'mare', lon: -15.6, lat: 32.8, rank: 1 },
      {
        id: 'mare-tranquillitatis',
        name: 'Mare Tranquillitatis',
        kind: 'mare',
        lon: 31.4,
        lat: 8.5,
        rank: 1,
      },
      {
        id: 'mare-serenitatis',
        name: 'Mare Serenitatis',
        kind: 'mare',
        lon: 17.5,
        lat: 28,
        rank: 2,
      },
      { id: 'mare-crisium', name: 'Mare Crisium', kind: 'mare', lon: 59.1, lat: 17, rank: 2 },
      {
        id: 'mare-orientale',
        name: 'Mare Orientale',
        kind: 'mare',
        lon: -92.8,
        lat: -19.4,
        rank: 2,
      },
      { id: 'tycho', name: 'Tycho', kind: 'crater', lon: -11.36, lat: -43.31, rank: 3 },
      { id: 'copernicus', name: 'Copernicus', kind: 'crater', lon: -20.08, lat: 9.62, rank: 3 },
      { id: 'aristarchus', name: 'Aristarchus', kind: 'crater', lon: -47.49, lat: 23.73, rank: 4 },
      { id: 'plato', name: 'Plato', kind: 'crater', lon: -9.3, lat: 51.6, rank: 4 },
      { id: 'korolev', name: 'Korolev', kind: 'crater', lon: -157.4, lat: -4, rank: 4 },
      {
        id: 'apollo-11',
        name: 'Apollo 11 landing site',
        kind: 'landing_site',
        lon: 23.473,
        lat: 0.674,
        rank: 5,
      },
    ].map((feature) => ({ ...feature, body: 'moon' })),
    walkthroughs: [
      {
        id: 'maria',
        title: 'The near side maria',
        stops: [
          {
            title: 'Mare Tranquillitatis',
            text: 'The Sea of Tranquility, where Apollo 11 landed in July 1969.',
            view: flat(31.4, 8.5, 900_000),
            clock: null,
            observationId: null,
          },
          {
            title: 'Mare Serenitatis',
            text: 'The Sea of Serenity, north of Tranquility, with Apollo 17 on its eastern rim.',
            view: flat(17.5, 28, 700_000),
            clock: null,
            observationId: null,
          },
          {
            title: 'Mare Imbrium',
            text: 'The Sea of Showers, one of the largest impact basins in the solar system.',
            view: flat(-15.6, 32.8, 1_200_000),
            clock: null,
            observationId: null,
          },
        ],
      },
      {
        id: 'flyby',
        title: 'A synthetic low flyby',
        stops: [
          {
            title: 'Over the Apollo 11 site',
            text: 'The first stop looks straight down at Tranquility Base.',
            view: globe(23.473, 0.674, 150_000, 40, 0, -90),
            clock: { time: '2026-01-01T02:00:00.000Z', rate: 60, playing: false },
            observationId: 'obs-1',
          },
          {
            title: 'Taurus-Littrow',
            text: 'An oblique look at the valley Apollo 17 explored.',
            view: globe(30.77, 20.19, 250_000, 40, 30, -70),
            clock: { time: '2026-01-01T04:00:00.000Z', rate: 60, playing: false },
            observationId: 'obs-2',
          },
          {
            title: 'Across the antimeridian',
            text: 'On the far side, where longitude 180 meets -180.',
            view: globe(179.5, -10, 350_000, 45, 90, -80),
            clock: { time: '2026-01-01T08:00:00.000Z', rate: 60, playing: false },
            observationId: 'obs-3',
          },
          {
            title: 'Tycho',
            text: 'A young crater whose rays cross much of the near side.',
            view: globe(-11.36, -43.31, 450_000, 50, 180, -60),
            clock: { time: '2026-01-01T12:00:00.000Z', rate: 60, playing: false },
            observationId: 'obs-4',
          },
        ],
      },
    ],
    observations: [
      {
        id: 'obs-1',
        title: 'Photo near the Apollo 11 site',
        kind: 'photo',
        time: '2026-01-01T02:00:00.000Z',
        walkthroughId: 'flyby',
        viewpoint: {
          body: 'moon',
          lon: 23.473,
          lat: 0.674,
          altitudeM: 100_000,
          headingDeg: 0,
          pitchDeg: -90,
          fovDeg: 30,
        },
        footprint: { type: 'Polygon', coordinates: [square(23.473, 0.674, 0.9)] },
        source: SYNTHETIC,
        notes: [NOTE],
      },
      {
        id: 'obs-2',
        title: 'Oblique photo of Taurus-Littrow',
        kind: 'photo',
        time: '2026-01-01T04:00:00.000Z',
        walkthroughId: 'flyby',
        viewpoint: {
          body: 'moon',
          lon: 30.77,
          lat: 20.19,
          altitudeM: 200_000,
          headingDeg: 45,
          pitchDeg: -60,
          fovDeg: 40,
        },
        footprint: {
          type: 'Polygon',
          coordinates: [
            [
              [30.2, 19.4],
              [32.6, 19.9],
              [32.1, 22.3],
              [29.9, 21.6],
              [30.2, 19.4],
            ],
          ],
        },
        source: SYNTHETIC,
        notes: [NOTE, 'Oblique, so the far edge is less sharp than the near one.'],
      },
      {
        id: 'obs-3',
        title: 'Photo across the antimeridian',
        kind: 'photo',
        time: '2026-01-01T08:00:00.000Z',
        walkthroughId: 'flyby',
        viewpoint: {
          body: 'moon',
          lon: 179.5,
          lat: -10,
          altitudeM: 300_000,
          headingDeg: 90,
          pitchDeg: -75,
          fovDeg: 45,
        },
        // Cut at the antimeridian into two polygons (RFC 7946 section 3.1.9).
        footprint: {
          type: 'MultiPolygon',
          coordinates: [
            [
              [
                [178.2, -11.4],
                [180, -11.4],
                [180, -8.6],
                [178.2, -8.6],
                [178.2, -11.4],
              ],
            ],
            [
              [
                [-180, -11.4],
                [-179.2, -11.4],
                [-179.2, -8.6],
                [-180, -8.6],
                [-180, -11.4],
              ],
            ],
          ],
        },
        source: SYNTHETIC,
        notes: [NOTE],
      },
      {
        id: 'obs-4',
        title: 'Photo of Tycho',
        kind: 'photo',
        time: '2026-01-01T12:00:00.000Z',
        walkthroughId: 'flyby',
        viewpoint: {
          body: 'moon',
          lon: -11.36,
          lat: -43.31,
          altitudeM: 400_000,
          headingDeg: 180,
          pitchDeg: -45,
          fovDeg: 50,
        },
        footprint: { type: 'Polygon', coordinates: [square(-11.36, -43.31, 2.5)] },
        source: SYNTHETIC,
        notes: [NOTE, 'Low sun, so the rim casts long shadows.'],
      },
    ],
  };
}

/** A world over the Moon fixture. */
export function createMapWorld(options: MapWorldOptions = {}): MapWorld {
  return new MapWorld(moonWorldData(), options);
}

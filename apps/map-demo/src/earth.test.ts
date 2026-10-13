// The map demo's world (ADR 0050): it parses under the profile's own schema,
// registers fourteen tools (no clock), and its tour and observations hold to
// the profile's caps and to the data: each stop shows the thing it is about,
// each outline is a ring of the vendored data wound as RFC 7946 asks, and
// every word is plain text, short enough for a phone and free of the dashes
// the house style keeps out.

import {
  createMapEditTools,
  createMapTools,
  isPlainText,
  MAP_MAX_FOOTPRINT_POSITIONS,
  MAP_MAX_TEXT_CHARS,
  MAP_MAX_TITLE_CHARS,
  MapObservationSchema,
  MapPageStateSchema,
  MapWorldDataSchema,
  ringIsCounterclockwise,
} from '@tabdock/sim-page/map';
import { describe, expect, it } from 'vitest';
import { polygonContains, ringContains } from './decode.ts';
import {
  createEarthWorld,
  earthGeography,
  earthWorldData,
  featureRanks,
  GREAT_LAKES,
  TOUR_ID,
} from './earth.ts';

const VIEWPORT = { widthPx: 960, heightPx: 540 };
const DASHES = /[\u2013\u2014]/;
/** What a stop's card shows on a phone without scrolling past it. */
const STOP_TEXT_MAX = 240;

/** What each stop is about, by the features it must show. */
const SUBJECTS: readonly (readonly string[])[] = [
  ['lake-victoria', 'lago-titicaca'],
  ['caspian-sea'],
  ['lake-baikal'],
  [...GREAT_LAKES],
  ['lake-victoria'],
  ['madagascar'],
];

describe("the map demo's world", () => {
  it('parses under the profile and starts on the tour', () => {
    expect(MapWorldDataSchema.safeParse(earthWorldData()).success).toBe(true);
    const world = createEarthWorld({ viewport: VIEWPORT });
    expect(world.hasClock).toBe(false);
    expect(world.projections).toEqual(['equirectangular', 'globe']);
    world.goToStop(TOUR_ID, 0);
    const state = MapPageStateSchema.parse(world.state());
    expect(state).toMatchObject({ clock: null, walkthrough: { id: TOUR_ID, stopIndex: 0 } });
  });

  it('registers the profile with no clock group, and the two editing tools: fourteen', () => {
    const world = createEarthWorld({ viewport: VIEWPORT });
    const names = [...createMapTools(world), ...createMapEditTools(world)].map((tool) => tool.name);
    expect(names).toEqual([
      'get_view',
      'set_view',
      'capture_view',
      'list_layers',
      'set_layer',
      'features_in_view',
      'list_walkthroughs',
      'get_stop',
      'go_to_stop',
      'list_observations',
      'get_observation',
      'view_from_observation',
      'edit_stop',
      'reset_edits',
    ]);
  });

  it('shows at each stop of the tour the thing the stop is about', () => {
    const world = createEarthWorld({ viewport: VIEWPORT });
    const { stopCount } = world.walkthroughs().walkthroughs[0] ?? { stopCount: 0 };
    expect(stopCount).toBe(SUBJECTS.length);
    SUBJECTS.forEach((subject, index) => {
      world.goToStop(TOUR_ID, index);
      const shown = world.featuresInView({ limit: 200 }).features.map((feature) => feature.id);
      for (const id of subject) expect(shown, `stop ${String(index)}`).toContain(id);
    });
  });

  it('writes every stop as plain text within the profile caps, short and without dashes', () => {
    const world = createEarthWorld({ viewport: VIEWPORT });
    for (let index = 0; index < SUBJECTS.length; index += 1) {
      const stop = world.stop(TOUR_ID, index);
      for (const words of [stop.title, stop.text]) {
        expect(isPlainText(words)).toBe(true);
        expect(words).not.toMatch(DASHES);
        expect(words.trim()).toBe(words);
      }
      expect(stop.title.length).toBeLessThanOrEqual(MAP_MAX_TITLE_CHARS);
      expect(stop.text.length).toBeLessThanOrEqual(Math.min(MAP_MAX_TEXT_CHARS, STOP_TEXT_MAX));
      expect(stop.clock).toBeNull();
    }
  });

  it('outlines three features from the data itself, marked as outlines and credited', () => {
    const geography = earthGeography();
    const dataRings = [
      ...geography.land.flat(),
      ...geography.lakes.flatMap((lake) => lake.rings),
    ].map((ring) => JSON.stringify(ring));
    const world = createEarthWorld({ viewport: VIEWPORT });
    const listed = world.observations({ walkthroughId: TOUR_ID });
    expect(listed.observations.map((entry) => entry.id)).toEqual([
      'baikal-outline',
      'caspian-outline',
      'great-lakes-outline',
    ]);
    for (const { id } of listed.observations) {
      const observation = MapObservationSchema.parse(world.observation(id));
      expect(observation.kind).toBe('outline');
      expect(observation.source.credit).toBe('Made with Natural Earth.');
      expect(observation.notes.join(' ')).toContain('not a photograph');
      const footprint = observation.footprint;
      if (!footprint) throw new Error(`${id} has no footprint`);
      const polygons =
        footprint.type === 'Polygon' ? [footprint.coordinates] : footprint.coordinates;
      let positions = 0;
      for (const polygon of polygons) {
        for (const ring of polygon) {
          positions += ring.length;
          expect(ringIsCounterclockwise(ring), id).toBe(true);
          // The ring itself, or the Caspian hole run the other way.
          const asData = [JSON.stringify(ring), JSON.stringify([...ring].reverse())];
          expect(
            asData.some((text) => dataRings.includes(text)),
            id,
          ).toBe(true);
        }
      }
      expect(positions).toBeLessThanOrEqual(MAP_MAX_FOOTPRINT_POSITIONS);
      // The viewpoint looks down on the outline it names.
      const { lon, lat } = observation.viewpoint;
      const box = polygons.flat(2);
      expect(lon).toBeGreaterThanOrEqual(Math.min(...box.map(([x]) => x)));
      expect(lon).toBeLessThanOrEqual(Math.max(...box.map(([x]) => x)));
      expect(lat).toBeGreaterThanOrEqual(Math.min(...box.map(([, y]) => y)));
      expect(lat).toBeLessThanOrEqual(Math.max(...box.map(([, y]) => y)));
    }
  });

  it('puts Madagascar on land and the Caspian Sea on its own water, ranked first', () => {
    const geography = earthGeography();
    const world = createEarthWorld({ viewport: VIEWPORT });
    const features = new Map(world.bodyFeatures().map((feature) => [feature.id, feature]));
    const madagascar = features.get('madagascar');
    const caspian = features.get('caspian-sea');
    if (!madagascar || !caspian) throw new Error('a named feature is missing');
    expect(
      geography.land.some((polygon) => polygonContains(polygon, madagascar.lon, madagascar.lat)),
    ).toBe(true);
    expect(ringContains(geography.caspian.ring, caspian.lon, caspian.lat)).toBe(true);
    expect(features.size).toBe(26);
    const ranks = featureRanks();
    expect(ranks.get('madagascar')).toBe(0);
    expect(ranks.get('caspian-sea')).toBe(0);
    for (const feature of features.values()) {
      expect(isPlainText(feature.name)).toBe(true);
      expect(feature.name).not.toMatch(DASHES);
      expect(feature.name.length).toBeLessThanOrEqual(MAP_MAX_TITLE_CHARS);
    }
  });

  // ADR 0050 shows no contested name, so every name the page and its tools
  // give is listed here, reviewed: a regenerated module that adds or renames
  // a lake fails this until someone reads the new name. The lake Natural
  // Earth calls Lake Malawi is Lake Nyasa in Tanzania and Lago Niassa in
  // Mozambique, so it carries all three.
  it('names exactly the 26 reviewed features, with every name in use where names differ', () => {
    const world = createEarthWorld({ viewport: VIEWPORT });
    expect(
      Object.fromEntries(world.bodyFeatures().map((feature) => [feature.id, feature.name])),
    ).toStrictEqual({
      'caspian-sea': 'Caspian Sea',
      madagascar: 'Madagascar',
      'lake-baikal': 'Lake Baikal',
      'lake-winnipeg': 'Lake Winnipeg',
      'great-slave-lake': 'Great Slave Lake',
      'lake-ontario': 'Lake Ontario',
      'lake-erie': 'Lake Erie',
      'lake-superior': 'Lake Superior',
      'lake-victoria': 'Lake Victoria',
      'lake-ladoga': 'Lake Ladoga',
      'lake-balkhash': 'Lake Balkhash',
      'lake-tanganyika': 'Lake Tanganyika',
      'lake-malawi': 'Lake Malawi (Lake Nyasa, Lago Niassa)',
      vanern: 'Vänern',
      'lake-okeechobee': 'Lake Okeechobee',
      'lago-de-nicaragua': 'Lago de Nicaragua',
      'lake-tana': 'Lake Tana',
      'lago-titicaca': 'Lago Titicaca',
      'cedar-lake': 'Cedar Lake',
      'lake-onega': 'Lake Onega',
      'great-salt-lake': 'Great Salt Lake',
      'great-bear-lake': 'Great Bear Lake',
      'lake-athabasca': 'Lake Athabasca',
      'reindeer-lake': 'Reindeer Lake',
      'lake-huron': 'Lake Huron',
      'lake-michigan': 'Lake Michigan',
    });
    // The tools give the same names: features_in_view over the whole Earth.
    world.setView({ projection: 'equirectangular', lon: 0, lat: 0, widthM: 40_000_000 });
    const named = world.featuresInView({ limit: 200 }).features;
    expect(named.find((feature) => feature.id === 'lake-malawi')?.name).toBe(
      'Lake Malawi (Lake Nyasa, Lago Niassa)',
    );
  });
});

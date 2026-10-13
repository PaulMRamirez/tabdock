// The words around the map: the view line names the projection, centre,
// width and height in plain units, and the tour panel shows the current stop
// with any edit, says so once the map has left that stop, or says the tour
// has not begun.

import { describe, expect, it } from 'vitest';
import { createEarthWorld, TOUR_ID } from './earth.ts';
import { MOVED_TEXT, showsStop, stopWords, viewLine } from './panel.ts';

const VIEWPORT = { widthPx: 960, heightPx: 540 };

describe('the words around the map', () => {
  it('names the view in plain units', () => {
    const world = createEarthWorld({ viewport: VIEWPORT });
    world.goToStop(TOUR_ID, 0);
    expect(viewLine(world.view())).toBe(
      'Globe, centred on 20.0° N, 30.0° W, 26,558 km across, 23,000 km up',
    );
    world.goToStop(TOUR_ID, 4);
    world.setView({ headingDeg: 90 });
    expect(viewLine(world.view())).toBe(
      'Flat map, centred on 1.2° S, 33.0° E, 2,600 km across, heading 90°',
    );
  });

  it('shows the current stop with its edits, or that the tour has not begun', () => {
    const world = createEarthWorld({ viewport: VIEWPORT });
    expect(stopWords(world, TOUR_ID).title).toBe('Pick a stop');
    world.goToStop(TOUR_ID, 2);
    expect(stopWords(world, TOUR_ID)).toMatchObject({ place: 'Stop 3 of 6', title: 'Lake Baikal' });
    world.editStop(TOUR_ID, 2, { title: 'Baikal' });
    expect(stopWords(world, TOUR_ID).title).toBe('Baikal');
  });

  it('says so once the map leaves the stop, by a client or the visitor, and not for a hair', () => {
    const world = createEarthWorld({ viewport: VIEWPORT });
    // Every stop, gone to, shows itself.
    for (let index = 0; index < 6; index += 1) {
      world.goToStop(TOUR_ID, index);
      expect(
        showsStop(world.view(), world.stop(TOUR_ID, index).view),
        `stop ${String(index)}`,
      ).toBe(true);
      expect(stopWords(world, TOUR_ID).text).toBe(world.stop(TOUR_ID, index).text);
    }
    // The review's case: the last stop, then set_view to Baikal from 2,000 km up.
    world.setView({ lon: 107.9, lat: 53.6, altitudeM: 2_000_000 });
    expect(stopWords(world, TOUR_ID)).toEqual({
      place: 'Stop 6 of 6, map moved',
      title: 'Madagascar',
      text: MOVED_TEXT,
    });
    world.goToStop(TOUR_ID, 2);
    expect(stopWords(world, TOUR_ID).place).toBe('Stop 3 of 6');
    // A pan, a zoom or the other projection each leaves it.
    const at = world.view();
    for (const patch of [
      { lon: at.lon + 1 },
      { widthM: at.widthM * 1.25 },
      { projection: 'equirectangular' },
    ]) {
      world.goToStop(TOUR_ID, 2);
      world.setView(patch);
      expect(stopWords(world, TOUR_ID).place, JSON.stringify(patch)).toBe('Stop 3 of 6, map moved');
    }
    // Rounding, or a nudge well under the tolerances, does not.
    world.goToStop(TOUR_ID, 2);
    world.setView({ lon: at.lon + 0.005, lat: at.lat - 0.005, widthM: at.widthM * 1.005 });
    expect(stopWords(world, TOUR_ID).place).toBe('Stop 3 of 6');
    // Across the antimeridian a view a hair away is still the stop.
    expect(
      showsStop({ ...at, lon: 179.999 }, { ...world.stop(TOUR_ID, 2).view, lon: -179.999 }),
    ).toBe(true);
  });
});

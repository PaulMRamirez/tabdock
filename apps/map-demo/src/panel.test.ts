// The words around the map: the view line names the projection, centre,
// width and height in plain units, and the tour panel shows the current stop
// with any edit, or says the tour has not begun.

import { describe, expect, it } from 'vitest';
import { createEarthWorld, TOUR_ID } from './earth.ts';
import { stopWords, viewLine } from './panel.ts';

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
      'Flat map, centred on 1.2° S, 33.0° E, 900 km across, heading 90°',
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
});

// What the copied schemas hold that their JSON Schema cannot show, so the
// drift test in this repository's ci-check-files.test.ts would miss its loss:
// the profile's plain-text rule on every text a result carries (no control
// character but tab and line breaks, and no lone surrogate), and
// list_observations' cap of 150 observations, which the walk asks for whole.

import { describe, expect, it } from 'vitest';
import {
  isPlainText,
  ListObservationsResultSchema,
  MAP_MAX_OBSERVATIONS,
  MapObservationSchema,
  MapStopSchema,
} from '../src/profile.ts';
import { PAGE_ID, scriptedPage } from './scripted-page.ts';
import { walkPage } from '../src/walk.ts';

const PLAIN = ['', 'Mare Tranquillitatis', 'tab\tand\nlines\r\n', 'a pair 🌕 of halves'];
const NOT_PLAIN = [
  'nul \u0000',
  'bell \u0007',
  'escape \u001b[2J',
  'lone \ud83c high',
  'lone \udf15 low',
  'ends high \ud83c',
];

const STOP = {
  walkthroughId: 'tour',
  index: 0,
  stopCount: 1,
  title: 'A stop',
  text: 'Words.',
  view: {
    body: 'moon',
    projection: 'equirectangular',
    lon: 0,
    lat: 0,
    widthM: 1000,
    headingDeg: 0,
    pitchDeg: -90,
  },
  clock: null,
  observationId: null,
};

function summary(index: number): Record<string, unknown> {
  return {
    id: `obs-${String(index)}`,
    title: 'A photo',
    kind: 'photo',
    time: '2026-01-01T00:00:00Z',
    walkthroughId: null,
  };
}

describe('the plain-text rule', () => {
  it('takes tab, line breaks and surrogate pairs, and refuses other controls and lone halves', () => {
    for (const text of PLAIN) expect(isPlainText(text), JSON.stringify(text)).toBe(true);
    for (const text of NOT_PLAIN) expect(isPlainText(text), JSON.stringify(text)).toBe(false);
  });

  it('holds in the copied schemas, for titles, texts, notes and sources', () => {
    expect(MapStopSchema.safeParse(STOP).success).toBe(true);
    for (const bad of NOT_PLAIN) {
      expect(MapStopSchema.safeParse({ ...STOP, title: bad }).success, 'title').toBe(false);
      expect(MapStopSchema.safeParse({ ...STOP, text: bad }).success, 'text').toBe(false);
    }
    const observation = {
      ...summary(1),
      viewpoint: {
        body: 'moon',
        lon: 0,
        lat: 0,
        altitudeM: 1,
        headingDeg: 0,
        pitchDeg: -90,
        fovDeg: 60,
      },
      footprint: null,
      source: { name: 'Synthetic', url: null, credit: null },
      notes: ['A note.'],
      onScreen: false,
    };
    expect(MapObservationSchema.safeParse(observation).success).toBe(true);
    expect(MapObservationSchema.safeParse({ ...observation, notes: ['\u0000'] }).success).toBe(
      false,
    );
    expect(
      MapObservationSchema.safeParse({
        ...observation,
        source: { name: 'x', url: 'https://a\u0007', credit: null },
      }).success,
    ).toBe(false);
  });
});

describe("list_observations' cap", () => {
  it(`takes ${String(MAP_MAX_OBSERVATIONS)} observations and refuses one more`, () => {
    expect(MAP_MAX_OBSERVATIONS).toBe(150);
    const list = (count: number) => ({
      observations: Array.from({ length: count }, (_, index) => summary(index)),
      total: count,
      truncated: false,
    });
    expect(ListObservationsResultSchema.safeParse(list(150)).success).toBe(true);
    expect(ListObservationsResultSchema.safeParse(list(151)).success).toBe(false);
  });

  it('is what the walk asks for, so a page under the cap is listed in one call', async () => {
    const asked: unknown[] = [];
    const { call } = scriptedPage();
    await walkPage(
      async (tool, args) => {
        if (tool === 'call_page_tool' && args.tool === 'list_observations')
          asked.push(args.arguments);
        return call(tool, args);
      },
      PAGE_ID,
      { stateTimeoutMs: 100 },
    );
    expect(asked).toEqual([{ limit: 150 }]);
  });
});

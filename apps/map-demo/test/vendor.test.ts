// The generator (scripts/vendor-natural-earth.ts) and what it wrote: rings
// rounded to tenths, repeats and the closing position dropped, wound as RFC
// 7946 asks; lake ids in plain ASCII; and the module inside ADR 0050's
// budget of 24,000 bytes.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DATA_MODULE, lakeId, quantizeRing } from '../scripts/vendor-natural-earth.ts';
import { ringTwiceArea } from '../src/decode.ts';

/** ADR 0050's budget for the generated module. */
const DATA_BUDGET_BYTES = 24_000;

describe('the generator', () => {
  it('rounds to tenths, drops repeats and the closing position, and winds as RFC 7946 asks', () => {
    // Clockwise in the plane, as the shapefile order holds an exterior ring.
    const clockwise = [
      [0, 0],
      [0, 1.04],
      [0.01, 1.0],
      [1, 1],
      [1, 0],
      [0, 0],
    ];
    const exterior = quantizeRing(clockwise, false);
    expect(exterior).toEqual([
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ]);
    const hole = quantizeRing(clockwise, true);
    expect(hole && ringTwiceArea([...hole, hole[0] ?? [0, 0]])).toBeLessThan(0);
    expect(
      quantizeRing(
        [
          [0, 0],
          [0.01, 0.01],
          [0.02, 0],
          [0, 0],
        ],
        false,
      ),
    ).toBeNull();
  });

  it('gives a lake an ASCII id from its name', () => {
    expect(lakeId('Vänern')).toBe('vanern');
    expect(lakeId('Lago de Nicaragua')).toBe('lago-de-nicaragua');
    expect(lakeId('Great Slave Lake')).toBe('great-slave-lake');
  });
});

describe('the vendored module', () => {
  it('stays inside its budget of 24,000 bytes', () => {
    const bytes = readFileSync(DATA_MODULE).length;
    expect(bytes).toBeLessThanOrEqual(DATA_BUDGET_BYTES);
  });
});

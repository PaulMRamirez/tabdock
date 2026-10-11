// The walk stays under the relay's default rates (ADR 0041, decision 3): on a
// fake clock, the 101st page call within a minute waits until the oldest has
// left the window, and takes asked for at once are counted one at a time.

import { describe, expect, it } from 'vitest';
import { createPacer, PAGE_CALLS_PER_MINUTE, REQUESTS_PER_MINUTE } from '../src/pacer.ts';

/** A clock that moves only when the pacer sleeps on it, recording each sleep. */
function fakeClock(start = 1_000_000): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  slept: number[];
} {
  let at = start;
  const slept: number[] = [];
  return {
    now: () => at,
    sleep: (ms) => {
      slept.push(ms);
      at += ms;
      return Promise.resolve();
    },
    slept,
  };
}

describe('createPacer', () => {
  it('keeps under the relay defaults: 100 page calls and 200 requests a minute', () => {
    expect(PAGE_CALLS_PER_MINUTE).toBeLessThan(120);
    expect(REQUESTS_PER_MINUTE).toBeLessThan(240);
  });

  it('lets the 101st take within 60 s wait until the oldest leaves the window', async () => {
    const clock = fakeClock();
    const pacer = createPacer({ perMinute: 100, now: clock.now, sleep: clock.sleep });
    const start = clock.now();
    for (let index = 0; index < 100; index += 1) await pacer.take();
    expect(clock.slept).toEqual([]);
    await pacer.take();
    expect(clock.slept).toEqual([60_000]);
    expect(clock.now() - start).toBe(60_000);
  });

  it('counts takes asked for together one at a time', async () => {
    const clock = fakeClock();
    const pacer = createPacer({ perMinute: 2, now: clock.now, sleep: clock.sleep });
    await Promise.all([pacer.take(), pacer.take(), pacer.take(), pacer.take()]);
    // Two fit at once; the third and the fourth each wait for one to leave.
    expect(clock.slept).toEqual([60_000]);
    const pacer3 = createPacer({ perMinute: 3, now: clock.now, sleep: clock.sleep });
    await Promise.all(Array.from({ length: 7 }, () => pacer3.take()));
    expect(clock.slept).toEqual([60_000, 60_000, 60_000]);
  });

  it('refuses a rate that is not a whole number above zero', () => {
    expect(() => createPacer({ perMinute: 0 })).toThrow(
      'perMinute must be a whole number, 1 or more',
    );
    expect(() => createPacer({ perMinute: Number.NaN })).toThrow();
  });
});

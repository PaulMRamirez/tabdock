// The sliding-window limiter on its own (S3, S9): its counting, and what it
// costs. Every limit in the relay runs through it on the one event loop that
// also serves /mcp, /pair and the page link, so one record() must cost about
// the same however many keys it holds, and the keys it holds must stay
// bounded whoever chooses them. Work is counted in Map operations and steps
// of Map iteration rather than timed, so a slow machine cannot hide it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlidingWindowLimiter } from '../src/rate-limit.ts';

const WINDOW = 60_000;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Counts every Map lookup, write and removal, and every step any Map
 * iterator takes, while `run` runs: what a walk over the limiter's keys
 * would cost, whichever way it walked them.
 */
function mapWork(run: () => void): number {
  const iteratorProto = Object.getPrototypeOf(new Map().keys()) as { next: () => unknown };
  const spies = [
    vi.spyOn(Map.prototype, 'get'),
    vi.spyOn(Map.prototype, 'set'),
    vi.spyOn(Map.prototype, 'delete'),
    vi.spyOn(Map.prototype, 'has'),
    vi.spyOn(iteratorProto, 'next'),
  ];
  try {
    run();
    return spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

describe('SlidingWindowLimiter', () => {
  it('allows `limit` hits per key in any window, and frees each one a window after it', () => {
    const limiter = new SlidingWindowLimiter(2, WINDOW);
    expect(limiter.allows('a', 0)).toBe(true);
    limiter.record('a', 0);
    limiter.record('a', 10);
    expect(limiter.allows('a', 20)).toBe(false);
    // Another key is counted apart.
    expect(limiter.allows('b', 20)).toBe(true);
    // The first hit leaves the window at exactly WINDOW after it.
    expect(limiter.allows('a', WINDOW - 1)).toBe(false);
    expect(limiter.allows('a', WINDOW)).toBe(true);
    limiter.record('a', WINDOW);
    expect(limiter.allows('a', WINDOW + 5)).toBe(false);
    expect(limiter.allows('a', WINDOW + 10)).toBe(true);
  });

  it('keeps counting a key through the windows where it is quiet and others are not', () => {
    const limiter = new SlidingWindowLimiter(1, WINDOW);
    limiter.record('other', 0);
    limiter.record('steady', WINDOW / 2);
    // Others keep coming while 'steady' waits out its window.
    for (let at = WINDOW / 2 + 1; at < 1.5 * WINDOW; at += 997) {
      limiter.record(`other ${String(at)}`, at);
      expect(limiter.allows('steady', at)).toBe(false);
    }
    expect(limiter.allows('steady', 1.5 * WINDOW - 1)).toBe(false);
    expect(limiter.allows('steady', 1.5 * WINDOW)).toBe(true);
  });

  it('a caller that records past its limit stays blocked exactly as long as before', () => {
    const limiter = new SlidingWindowLimiter(3, WINDOW);
    for (let at = 0; at < 10; at += 1) limiter.record('a', at * 100);
    // Ten hits at 0 to 900: the eighth (700) is the one whose expiry frees a slot.
    expect(limiter.allows('a', 700 + WINDOW - 1)).toBe(false);
    expect(limiter.allows('a', 700 + WINDOW)).toBe(true);
  });

  it('forgets keys whose hits have all left the window', () => {
    const limiter = new SlidingWindowLimiter(5, WINDOW);
    for (let i = 0; i < 1000; i += 1) limiter.record(`old ${String(i)}`, 0);
    // Two windows on, a few records later, none of the old keys is held.
    limiter.record('new', WINDOW);
    limiter.record('newer', 2 * WINDOW);
    expect(limiter.size).toBeLessThanOrEqual(2);
    expect(limiter.allows('old 0', 2 * WINDOW)).toBe(true);
  });

  it('does a bounded amount of work per record past 10,000 keys, all inside one window', () => {
    const limiter = new SlidingWindowLimiter(30, WINDOW);
    // Distinct keys at one instant, so nothing leaves the window to be swept.
    for (let i = 0; i <= 10_000; i += 1) limiter.record(`key ${String(i)}`, 1000);
    const records = 20;
    const work = mapWork(() => {
      for (let i = 0; i < records; i += 1) limiter.record(`late ${String(i)}`, 1000);
    });
    // A handful of Map operations each, never a walk over ten thousand keys.
    expect(work).toBeLessThan(records * 10);
  });

  it('holds a bounded number of keys whoever chooses them, at a bounded cost', () => {
    const limiter = new SlidingWindowLimiter(30, WINDOW, 100);
    const records = 5000;
    const work = mapWork(() => {
      for (let i = 0; i < records; i += 1) limiter.record(`random ${String(i)}`, 1000);
    });
    expect(limiter.size).toBeLessThanOrEqual(200);
    expect(work).toBeLessThan(records * 10);
    // The newest keys are still counted.
    const counted = new SlidingWindowLimiter(1, WINDOW, 100);
    for (let i = 0; i < 1000; i += 1) counted.record(`random ${String(i)}`, 1000);
    expect(counted.allows('random 999', 1001)).toBe(false);
  });
});

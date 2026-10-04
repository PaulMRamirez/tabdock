// The budget for lines someone can cause at will (repeated-lines.ts, A4.3):
// a few per key a window in full, the rest counted into one summary when the
// window ends, with the keys tracked in a window capped.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/log.ts';
import {
  createRepeatedLog,
  errorKind,
  type HeldBack,
  MAX_REPEATED_KINDS,
  RepeatedLines,
} from '../src/repeated-lines.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('RepeatedLines', () => {
  it('lets a key write its lines, counts the rest by reason, and starts afresh each window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T00:00:10Z'));
    const summaries: [string | null, HeldBack][] = [];
    const lines = new RepeatedLines({
      linesPerKey: 2,
      windowMs: 60_000,
      maxKeys: 10,
      summary: (key, held) => summaries.push([key, held]),
    });
    expect(lines.take('a', 'x', undefined)).toBe(true);
    expect(lines.take('a', 'x', undefined)).toBe(true);
    expect(lines.take('a', 'x', undefined)).toBe(false);
    expect(lines.take('a', 'y', undefined)).toBe(false);
    // A line some other bound held back counts too, without spending the key's lines.
    lines.hold('b', 'z', undefined);
    expect(lines.take('b', 'z', undefined)).toBe(true);
    expect(summaries).toEqual([]);
    // The counts go out when the clock's minute ends, with no line after them.
    vi.advanceTimersByTime(50_000);
    expect(summaries).toEqual([
      ['a', { repeated: 2, reasons: { x: 1, y: 1 } }],
      ['b', { repeated: 1, reasons: { z: 1 } }],
    ]);
    expect(lines.take('a', 'x', undefined)).toBe(true);
  });

  it('writes nothing for keys past its cap in a window, and counts them together', () => {
    const summaries: [string | null, HeldBack][] = [];
    const lines = new RepeatedLines({
      linesPerKey: 1,
      windowMs: 60_000,
      maxKeys: 2,
      summary: (key, held) => summaries.push([key, held]),
    });
    const now = Date.UTC(2026, 9, 4, 0, 0, 10);
    expect(lines.take('a', 'r', undefined, now)).toBe(true);
    expect(lines.take('b', 'r', undefined, now)).toBe(true);
    expect(lines.take('c', 'r', undefined, now)).toBe(false);
    expect(lines.take('d', 's', undefined, now)).toBe(false);
    lines.flush();
    expect(summaries).toEqual([[null, { repeated: 2, reasons: { r: 1, s: 1 } }]]);
  });
});

describe('createRepeatedLog', () => {
  it('writes the first line of each kind a window in full, then one count of the rest', () => {
    const written: Record<string, unknown>[] = [];
    const log = createRepeatedLog(
      createLogger({ sink: (line) => written.push(JSON.parse(line) as Record<string, unknown>) }),
      60_000,
    );
    for (let i = 0; i < 5; i += 1) log.write('warn', 'refused', { n: i }, 'full');
    log.write('info', 'refused', { n: 9 }, 'idle');
    log.write('info', 'closed', { n: 10 });
    log.close();
    expect(written.map((entry) => [entry.level, entry.msg, entry.n ?? entry.repeated])).toEqual([
      ['warn', 'refused', 0],
      ['info', 'refused', 9],
      ['info', 'closed', 10],
      ['warn', 'refused (full), repeated', 4],
    ]);
    expect(MAX_REPEATED_KINDS).toBe(256);
  });
});

describe('errorKind', () => {
  it("names an error by its class and its message's fixed start, never what follows", () => {
    expect(
      errorKind(new Error('Rejected inbound request (method-header-mismatch): Bad Request: x')),
    ).toBe('Error: Rejected inbound request');
    expect(errorKind(new TypeError('Unsupported Media Type: Content-Type must be json'))).toBe(
      'TypeError: Unsupported Media Type',
    );
    expect(errorKind(new Error(`${'A'.repeat(2_000_000)}: tail`))).toBe(`Error: ${'A'.repeat(48)}`);
    expect(errorKind(new Error(': nothing first'))).toBe('Error');
    expect(errorKind('a string')).toBe('string');
  });
});

// The page state budget against the heap it stands for (S9, ADR 0040). A
// page needs no account to publish, so the budget, not a value's size, is
// what keeps pages from filling the heap. For every shape of value that
// holds the most per byte, or the most beside its text, the relay charges a
// page at least the heap its state really holds, measured in a process that
// can collect garbage on demand, and a hosted relay's every page slot at the
// largest state stays within TABDOCK_MAX_STATE_BYTES's default with nothing
// withheld. The relay keeps only the canonical text, never the parsed
// object, which is what makes the charge honest.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATE_BYTES } from '../src/config.ts';
import { HOSTED_LIMITS } from '../src/index.ts';

const PROBE = resolve(import.meta.dirname, 'fixtures/state-heap-probe.ts');
const SHAPES = ['ascii', 'twoByte', 'keys', 'tiny'] as const;

interface Measured {
  shape: string;
  heapPerPage: number;
  chargedPerPage: number;
  charged: number;
  withheld: number;
}

function probe(shape: string, pages: number): Promise<Measured> {
  return new Promise((resolveProbe, reject) => {
    const child = spawn(process.execPath, ['--expose-gc', PROBE, shape, String(pages)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.once('exit', (code) => {
      const line = out.split('\n').find((text) => text.startsWith('{"shape"'));
      if (code !== 0 || line === undefined) reject(new Error(`probe ${shape} failed:\n${out}`));
      else resolveProbe(JSON.parse(line) as Measured);
    });
  });
}

describe('the page state budget and the heap (S9, ADR 0040)', () => {
  it('charges a page at least the heap its state holds, and fits every hosted page at the largest state', async () => {
    const pages = HOSTED_LIMITS.pageSessions ?? 100;
    // One at a time: four relays measuring the heap at once on a small machine skew each other.
    const measured: Measured[] = [];
    for (const shape of SHAPES) measured.push(await probe(shape, pages));
    for (const { shape, heapPerPage, chargedPerPage, charged, withheld } of measured) {
      const report = JSON.stringify({ shape, heapPerPage, chargedPerPage });
      expect(heapPerPage, report).toBeGreaterThan(0);
      expect(chargedPerPage, report).toBeGreaterThan(heapPerPage);
      // A hosted relay's every page slot at the largest state fits the default budget whole.
      expect(withheld, report).toBe(0);
      expect(charged, report).toBeLessThanOrEqual(STATE_BYTES);
      expect(heapPerPage * pages, report).toBeLessThan(STATE_BYTES);
    }
  }, 180_000);
});

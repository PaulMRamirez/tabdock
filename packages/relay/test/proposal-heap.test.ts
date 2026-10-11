// The proposal budget against the heap it stands for (S9, ADR 0042). A
// proposal outlives the request that made it by up to ten minutes, outside
// any request's charge, so limits.proposalBytes is what bounds the heap
// proposals and their kept results hold. For every shape of arguments that
// holds the most per byte, per value or per key, at ADR 0042's caps, and for
// a kept result at its cut, each charge is at least the heap the proposal
// really holds, measured in a process that can collect garbage on demand.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const PROBE = resolve(import.meta.dirname, 'fixtures/proposal-heap-probe.ts');
const SHAPES = [
  'ascii',
  'twoByte',
  'nodes',
  'keys',
  'tiny',
  'resultAscii',
  'resultTwoByte',
] as const;

interface Measured {
  shape: string;
  heapPerProposal: number;
  chargedPerProposal: number;
}

function probe(shape: string, count: number): Promise<Measured> {
  return new Promise((resolveProbe, reject) => {
    const child = spawn(process.execPath, ['--expose-gc', PROBE, shape, String(count)], {
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

describe('the proposal budget and the heap (S9, ADR 0042)', () => {
  it('charges each proposal and each kept result at least the heap it holds', async () => {
    // One at a time: several processes measuring the heap at once skew each other.
    const measured: Measured[] = [];
    for (const shape of SHAPES) measured.push(await probe(shape, 200));
    for (const { shape, heapPerProposal, chargedPerProposal } of measured) {
      const report = JSON.stringify({ shape, heapPerProposal, chargedPerProposal });
      expect(heapPerProposal, report).toBeGreaterThan(0);
      expect(chargedPerProposal, report).toBeGreaterThan(heapPerProposal);
    }
  }, 180_000);
});

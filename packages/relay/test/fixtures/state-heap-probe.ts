// node --expose-gc state-heap-probe.ts <shape> <pages>: opens that many
// pages on an in-process relay with every limit at its default but room for
// the pages, has each publish one value of the shape at the largest size a
// state may have, and prints, as one JSON line, the heap each page's state
// holds beside what the relay charged each against limits.stateBytes (read
// from its debug line) and how many values it withheld. state-heap.test.ts
// runs it, since only a process started with --expose-gc can collect
// garbage on demand and measure what stays.

import { MAX_STATE_BYTES } from '@tabdock/protocol';
import { createDevTokenAuth, createRelay } from '../../src/index.ts';
import { connectPage, type TestPage } from '../helpers/page-client.ts';

const collect = (globalThis as { gc?: () => void }).gc;
if (collect === undefined) throw new Error('run with --expose-gc');

/** {"t":"..."} is 8 bytes around its text. */
const ROOM = MAX_STATE_BYTES - 8;

/** Values whose canonical JSON is as large as a state may be, each held its own way. */
const SHAPES: Record<string, (n: number) => Record<string, unknown>> = {
  /** One byte a character, so the most characters, which V8 keeps at a byte each. */
  ascii: (n) => ({ t: `${String(n).padStart(6, '0')}${'a'.repeat(ROOM - 6)}` }),
  /** Characters past Latin-1 two bytes each in UTF-8, which V8 keeps at two bytes each too. */
  twoByte: (n) => ({ t: `${String(n).padStart(6, '0')}${'Ā'.repeat((ROOM - 6) / 2)}` }),
  /** Many small keys: the parsed object is many times its text, and only the text is kept. */
  keys: (n) => {
    const value: Record<string, unknown> = { n };
    // Counted as it grows, since writing it out at every key would hold the
    // event loop long enough for the relay to drop every page as silent.
    let length = JSON.stringify(value).length;
    for (let key = 0; ; key += 1) {
      const name = `k${key.toString(36)}`;
      // ,"name":0
      if (length + name.length + 5 > MAX_STATE_BYTES) break;
      value[name] = 0;
      length += name.length + 5;
    }
    return value;
  },
  /** Next to nothing: what a page's entry costs besides its text. */
  tiny: (n) => ({ n }),
};

const shape = process.argv[2] ?? 'ascii';
const make = SHAPES[shape];
if (make === undefined) throw new Error(`no shape ${shape}`);
const count = Number(process.argv[3] ?? 100);

let charged = 0;
let withheld = 0;
const relay = await createRelay({
  auth: createDevTokenAuth([
    { token: 'tabdock-state-heap-probe-not-a-secret', userId: 'probe', displayName: 'P' },
  ]),
  // Room for every page from this one address; the state budget stays at its default.
  limits: { pageSessions: 1000, pageSessionsPerAddress: 1000, pageSocketsPerAddress: 1000 },
  rateLimits: { toolsFramesPerAddress: 10_000, stateFramesPerAddress: 10_000 },
  logLevel: 'debug',
  logSink: (line) => {
    const held = /"allPagesStateBytes":(\d+)/.exec(line);
    if (held !== null) charged = Number(held[1]);
    if (line.includes('page state withheld')) withheld += 1;
  },
});

async function settle(): Promise<number> {
  let least = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 6; round += 1) {
    collect?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    least = Math.min(least, process.memoryUsage().heapUsed);
  }
  return least;
}

const pages: TestPage[] = [];
for (let n = 0; n <= count; n += 1) pages.push(await connectPage(relay.pageUrl));
// One page publishes first, so what the first value costs once (maps, code) is in the baseline.
const [first, ...rest] = pages;
if (first === undefined) throw new Error('no page');
first.send({ t: 'state', value: make(count) });
await first.sync();
// Built ahead and kept past the last reading, so they are in both and only
// what the relay keeps of each is measured. Each is written once first:
// that flattens the strings built by joining, which sending would otherwise
// do after the first reading, adding a copy on this side to what is measured.
const values = rest.map((_, n) => make(n));
for (const value of values) JSON.stringify(value);
const before = await settle();
const chargedBefore = charged;
for (const [n, page] of rest.entries()) {
  page.send({ t: 'state', value: values[n] });
  await page.sync();
}
const after = await settle();
process.stdout.write(
  `${JSON.stringify({
    shape,
    values: values.length,
    heapPerPage: Math.round((after - before) / count),
    chargedPerPage: Math.round((charged - chargedBefore) / count),
    charged,
    withheld,
  })}\n`,
);
for (const page of pages) page.ws.terminate();
await relay.close();
process.exit(0);

// node --expose-gc tool-heap-probe.ts <shape> <pages>: lists one shape of
// tools on that many pages of an in-process relay and prints, as one JSON
// line, the heap each page's tools hold beside what the relay charged each
// against limits.toolBytes (heldBytes in hub.ts, read from its debug line).
// tool-heap.test.ts runs it, since only a process started with --expose-gc
// can collect garbage on demand and measure what stays.

import { createDevTokenAuth, createRelay } from '../../src/index.ts';
import { connectPage, type TestPage } from '../helpers/page-client.ts';
import { framesFor, HEAP_SHAPES, type HeapShape } from '../helpers/tool-shapes.ts';

const collect = (globalThis as { gc?: () => void }).gc;
if (collect === undefined) throw new Error('run with --expose-gc');
const shape = process.argv[2] as HeapShape;
const make = HEAP_SHAPES[shape];
const count = Number(process.argv[3] ?? 10);

let charged = 0;
const relay = await createRelay({
  auth: createDevTokenAuth([
    { token: 'tabdock-heap-probe-token-not-a-secret', userId: 'probe', displayName: 'P' },
  ]),
  // Room for every page and frame; the budget itself is what is being measured.
  limits: {
    pageSessions: 1000,
    pageSessionsPerAddress: 1000,
    pageSocketsPerAddress: 1000,
    toolBytes: 2 ** 40,
  },
  rateLimits: { toolsFramesPerAddress: 10_000, toolsFramesPerSocket: 10_000 },
  logLevel: 'debug',
  logSink: (line) => {
    const held = /"allPagesHeldBytes":(\d+)/.exec(line);
    if (held !== null) charged = Number(held[1]);
  },
});

async function open(): Promise<TestPage> {
  const page = await connectPage(relay.pageUrl, { tools: make() });
  for (let frame = 1; frame < framesFor(shape); frame += 1) {
    page.send({ t: 'tools', tools: make() });
    await page.sync();
  }
  return page;
}

async function settle(): Promise<number> {
  for (let round = 0; round < 6; round += 1) {
    collect?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return process.memoryUsage().heapUsed;
}

// One page first, so what every page costs once (code, maps, caches) is in the baseline.
const pages = [await open()];
const before = await settle();
const chargedBefore = charged;
for (let index = 0; index < count; index += 1) pages.push(await open());
const after = await settle();
process.stdout.write(
  `${JSON.stringify({
    shape,
    heapPerPage: Math.round((after - before) / count),
    chargedPerPage: Math.round((charged - chargedBefore) / count),
  })}\n`,
);
for (const page of pages) page.ws.terminate();
await relay.close();
process.exit(0);

// The budget for what all pages' tool lists may hold (S9, ADR 0018): every
// page is charged the size of the tools frame that listed its tools, a frame
// that would take the relay past limits.toolBytes closes its socket with 1008,
// a page replacing its own list is charged only the difference, and a page
// that falls asleep or goes frees what it held.

import { MAX_FRAME_BYTES, type PageTool } from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { connectPage, type TestPage } from './helpers/page-client.ts';
import { eventually, startRelay, type TestRelay } from './helpers/relay.ts';

let current: TestRelay | undefined;
const pages: TestPage[] = [];

afterEach(async () => {
  for (const page of pages.splice(0)) page.ws.terminate();
  await current?.close();
  current = undefined;
});

/** About 60 kB a tool: ten of them list about 600 kB, past half of a 1 MiB budget. */
function bulky(prefix: string, count = 10): PageTool[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `${prefix}_${String(index)}`,
    description: 'd'.repeat(9000),
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 50 }, (_, field) => [
          `f${String(field)}`,
          { type: 'string', description: 'x'.repeat(1000) },
        ]),
      ),
    },
    annotations: { readOnlyHint: true },
  }));
}

describe('the tool list budget (S9, ADR 0018)', () => {
  it('closes with 1008 a page whose tools would pass what all pages may hold, and frees a sleeper', async () => {
    current = await startRelay({ limits: { toolBytes: MAX_FRAME_BYTES } });
    const first = await connectPage(current.relay.pageUrl, { tools: bulky('a') });
    pages.push(first);
    await first.sync();
    // Listing its own tools again costs it only the difference.
    first.send({ t: 'tools', tools: bulky('a') });
    await first.sync();

    const second = await connectPage(current.relay.pageUrl);
    pages.push(second);
    second.send({ t: 'tools', tools: bulky('b') });
    expect((await second.closed).code).toBe(1008);
    expect(current.lines.join('\n')).toContain(
      'closing page socket: its tools would pass what all pages may hold',
    );

    // The first page falls asleep, and what it held is free again.
    first.ws.terminate();
    // The refused page fell asleep first; the second sleeper is this one.
    await eventually(
      () =>
        (current?.lines.filter((line) => line.includes('"msg":"page asleep"')).length ?? 0) >= 2,
    );
    const third = await connectPage(current.relay.pageUrl, { tools: bulky('c') });
    pages.push(third);
    await third.sync();
    expect(third.ws.readyState).toBe(third.ws.OPEN);
  });

  it('lets one page list a whole frame of tools at the smallest budget', async () => {
    current = await startRelay({ limits: { toolBytes: MAX_FRAME_BYTES } });
    const page = await connectPage(current.relay.pageUrl, { tools: bulky('a', 16) });
    pages.push(page);
    await page.sync();
    expect(page.ws.readyState).toBe(page.ws.OPEN);
  });
});

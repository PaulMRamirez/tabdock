// The budget for what all pages' tool lists may hold (S9, ADR 0018): every
// page is charged an upper bound on the heap its listed tools hold (heldBytes
// in hub.ts), not the size of the frame that listed them, so a small frame of
// empty objects counts for what its copies cost while long text the relay
// replaces counts for little. A frame that would take the relay past
// limits.toolBytes closes its socket with 1008, a page replacing its own list
// is charged only the difference, and a page that falls asleep or goes frees
// what it held. tool-heap.test.ts checks the bound against the heap itself.

import { encodeFrame, MAX_FRAME_BYTES, type PageTool } from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { TOOL_NODE_HEAP_BYTES } from '../src/hub.ts';
import { connectPage, type TestPage } from './helpers/page-client.ts';
import { eventually, startRelay, type TestRelay } from './helpers/relay.ts';

let current: TestRelay | undefined;
const pages: TestPage[] = [];

afterEach(async () => {
  for (const page of pages.splice(0)) page.ws.terminate();
  await current?.close();
  current = undefined;
});

/**
 * 400 empty objects a tool, about 1.2 kB on the wire and at least 400 values
 * held: twelve of them list about 15 kB and hold past half of a 1 MiB budget.
 */
function dense(prefix: string, count = 12): PageTool[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `${prefix}_${String(index)}`,
    description: 'd',
    inputSchema: { anyOf: Array.from({ length: 400 }, () => ({})) },
  }));
}

/** About 60 kB a tool on the wire, nearly all of it text the relay cuts or replaces. */
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
  it('charges what the tools hold, not the frame size, and closes with 1008 a page that would pass the budget', async () => {
    const frameBytes = Buffer.byteLength(encodeFrame({ t: 'tools', tools: dense('a') }));
    // Two such frames are a few percent of the budget on the wire, but hold more than all of it.
    expect(2 * frameBytes).toBeLessThan(MAX_FRAME_BYTES / 20);
    expect(2 * 12 * 400 * TOOL_NODE_HEAP_BYTES).toBeGreaterThan(MAX_FRAME_BYTES);
    current = await startRelay({ limits: { toolBytes: MAX_FRAME_BYTES }, logLevel: 'debug' });
    const first = await connectPage(current.relay.pageUrl, { tools: dense('a') });
    pages.push(first);
    await first.sync();
    // Listing its own tools again costs it only the difference.
    first.send({ t: 'tools', tools: dense('a') });
    await first.sync();
    expect(first.ws.readyState).toBe(first.ws.OPEN);
    const charged = current.lines
      .filter((line) => line.includes('"msg":"page tools updated"'))
      .map((line) => (JSON.parse(line) as { heldBytes: number }).heldBytes);
    expect(charged).toHaveLength(2);
    expect(charged[0]).toBeGreaterThan(MAX_FRAME_BYTES / 2);
    expect(charged[1]).toBe(charged[0]);

    const second = await connectPage(current.relay.pageUrl);
    pages.push(second);
    second.send({ t: 'tools', tools: dense('b') });
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
    const third = await connectPage(current.relay.pageUrl, { tools: dense('c') });
    pages.push(third);
    await third.sync();
    expect(third.ws.readyState).toBe(third.ws.OPEN);
  });

  it('lets one page list a whole frame of tools whose text the relay cuts, at the smallest budget', async () => {
    const tools = bulky('a', 16);
    expect(Buffer.byteLength(encodeFrame({ t: 'tools', tools }))).toBeGreaterThan(
      MAX_FRAME_BYTES * 0.9,
    );
    current = await startRelay({ limits: { toolBytes: MAX_FRAME_BYTES } });
    const page = await connectPage(current.relay.pageUrl, { tools });
    pages.push(page);
    await page.sync();
    expect(page.ws.readyState).toBe(page.ws.OPEN);
  });
});

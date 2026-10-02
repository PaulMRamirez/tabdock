// Measures the WebMCP runtime and MCP-B's local relay for docs/notes/baseline.md.
//   pnpm --filter @tabdock/e2e baseline
// Writes the raw numbers and shapes to docs/notes/baseline.raw.json.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startDemoServer } from '@tabdock/demo/server';
import { launchChromium, startBaseline, waitForTools } from './harness.ts';
import { measurePage } from './measure-page.ts';

// BASELINE_LABEL names a variant run, for example against native WebMCP in a newer Chrome.
const label = process.env.BASELINE_LABEL;
const outFile = fileURLToPath(
  new URL(`../../../docs/notes/baseline.raw${label ? `.${label}` : ''}.json`, import.meta.url),
);

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? Number.NaN;
}

async function measureInPage() {
  const demo = await startDemoServer();
  const browser = await launchChromium(true);
  try {
    const page = await browser.newPage();
    await page.goto(demo.url);
    await page.waitForSelector('html[data-tools="ready"]');
    return { browserVersion: browser.version(), page: await page.evaluate(measurePage) };
  } finally {
    await browser.close();
    await demo.close();
  }
}

async function measureThroughRelay() {
  const changes: number[] = [];
  const baseline = await startBaseline({
    onToolListChanged: () => changes.push(performance.now()),
  });
  try {
    const { client, page } = baseline;
    const listed = await client.listTools(undefined, { cacheMode: 'refresh' });
    const callSample = await client.callTool({ name: 'get_view', arguments: {} });
    const errorSample = await client.callTool({
      name: 'highlight_item',
      arguments: { id: 'item-999' },
    });
    const badArgsSample = await client.callTool({ name: 'move_view', arguments: { x: 'left' } });

    // Round trips for a read-only call, MCP client to page handler and back.
    const timings: number[] = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      await client.callTool({ name: 'get_view', arguments: {} });
      timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);

    // A tool registered after load: how long until the MCP client hears about it?
    changes.length = 0;
    const start = performance.now();
    await page.evaluate(() => {
      const mc = (
        document as unknown as {
          modelContext: { registerTool: (tool: object) => Promise<void> };
        }
      ).modelContext;
      return mc.registerTool({
        name: 'late_tool',
        description: 'Registered after the relay connected',
        inputSchema: { type: 'object' },
        execute: () => 'late',
      });
    });
    await waitForTools(client, ['late_tool'], 10_000);
    const visibleMs = performance.now() - start;
    const firstChange = changes[0];

    return {
      toolsVisibleAfterLoadMs: baseline.toolsVisibleAfterMs,
      serverInfo: client.getServerVersion(),
      serverCapabilities: client.getServerCapabilities(),
      listedTools: listed.tools.map((t) => ({ name: t.name, annotations: t.annotations ?? null })),
      clearBoardAsListed: listed.tools.find((t) => t.name === 'clear_board') ?? null,
      callSample,
      errorSample,
      badArgsSample,
      getViewRoundTripMs: {
        n: timings.length,
        p50: Math.round(percentile(timings, 50) * 10) / 10,
        p95: Math.round(percentile(timings, 95) * 10) / 10,
        max: Math.round((timings.at(-1) ?? Number.NaN) * 10) / 10,
      },
      lateToolListChangedMs: firstChange === undefined ? null : Math.round(firstChange - start),
      lateToolVisibleMs: Math.round(visibleMs),
    };
  } finally {
    await baseline.close();
  }
}

const inPage = await measureInPage();
const relay = await measureThroughRelay();
const result = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  ...inPage,
  relay,
};
await writeFile(outFile, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
console.log(`\nWrote ${outFile}`);

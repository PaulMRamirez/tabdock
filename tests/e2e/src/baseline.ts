// Measures the WebMCP runtime and MCP-B's local relay for docs/notes/baseline.md.
//   pnpm --filter @tabdock/e2e baseline
// Writes the raw numbers and shapes to docs/notes/baseline.raw.json.
//
// BASELINE_MCPB=6 measures MCP-B's 6.0 beta instead (M5 decision D4): the demo
// page on the beta polyfill (src/mcpb6-page.ts) and the beta local relay with
// its own embed, since embed and runtime must share a major. That run writes
// docs/notes/baseline.raw.mcpb6-beta.json unless BASELINE_LABEL names another.

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MCPB6_LOCAL_RELAY_CLI, MCPB6_POLYFILL_SCRIPT } from '@tabdock/mcpb6';
import { startDemoServer } from '@tabdock/demo/server';
import type { Page } from '@playwright/test';
import {
  type Baseline,
  type BaselineOptions,
  DEMO_TOOL_NAMES,
  freePort,
  launchChromium,
  RELAY_CLI,
  relayHome,
  startBaseline,
  waitForTools,
} from './harness.ts';
import { measureLifecycle } from './measure-lifecycle.ts';
import { measurePage } from './measure-page.ts';
import { mcpb6InitScript } from './mcpb6-page.ts';

const mcpb6 = process.env.BASELINE_MCPB === '6';
if (process.env.BASELINE_MCPB !== undefined && !mcpb6) {
  throw new Error('BASELINE_MCPB takes 6 or nothing');
}
// BASELINE_LABEL names a variant run, for example against native WebMCP in a newer Chrome.
const label = process.env.BASELINE_LABEL ?? (mcpb6 ? 'mcpb6-beta' : undefined);
const outFile = fileURLToPath(
  new URL(`../../../docs/notes/baseline.raw${label ? `.${label}` : ''}.json`, import.meta.url),
);

/** The name and version of the package a file under its dist/ belongs to. */
function packageOf(file: string): string {
  let dir = dirname(file);
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (manifest.name) return `${manifest.name}@${manifest.version ?? '?'}`;
    } catch {
      // No manifest here; keep climbing.
    }
    const parent = dirname(dir);
    if (parent === dir) return 'unknown';
    dir = parent;
  }
}

/** Which MCP-B packages this run used, read from the files themselves rather than assumed. */
function mcpbPackages(): { polyfill: string; localRelay: string } {
  if (mcpb6) {
    return {
      polyfill: packageOf(MCPB6_POLYFILL_SCRIPT),
      localRelay: packageOf(MCPB6_LOCAL_RELAY_CLI),
    };
  }
  // The demo bundles its own polyfill, so resolve it from there.
  const demo = createRequire(import.meta.resolve('@tabdock/demo/server'));
  return {
    polyfill: packageOf(demo.resolve('@mcp-b/webmcp-polyfill')),
    localRelay: packageOf(RELAY_CLI),
  };
}

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? Number.NaN;
}

/**
 * The 6.0 polyfill keeps a context it finds, so on a browser with native
 * WebMCP this run would measure Chrome under 6's name. It refuses instead.
 */
async function checkOnMcpb6(page: Page): Promise<void> {
  const probe = await page.evaluate(() => window.__mcpb6);
  if (!probe?.installed || probe.hadContextBefore) {
    throw new Error(
      'BASELINE_MCPB=6 needs a browser without native WebMCP, so the 6.0 polyfill is what runs',
    );
  }
}

async function measureInPage() {
  const demo = await startDemoServer();
  const browser = await launchChromium(true);
  try {
    const page = await browser.newPage();
    if (mcpb6) await page.addInitScript({ content: mcpb6InitScript({ recordCalls: false }) });
    await page.goto(demo.url);
    await page.waitForSelector('html[data-tools="ready"]');
    if (mcpb6) await checkOnMcpb6(page);
    const measured = await page.evaluate(measurePage);
    const lifecycle = await page.evaluate(measureLifecycle, measured.inputMode);
    return {
      browserVersion: browser.version(),
      // 5.1.0 sets this on its context; ADR 0001 keys its waits on it.
      polyfillMarker: await page.evaluate(() => {
        const context = (document as unknown as { modelContext?: object }).modelContext;
        const marker: unknown = context ? Reflect.get(context, '__isWebMCPPolyfill') : null;
        return marker ?? null;
      }),
      page: { ...measured, lifecycle },
    };
  } finally {
    await browser.close();
    await demo.close();
  }
}

/**
 * startBaseline's chain with the 6.0 beta: its local relay, the demo page on
 * its polyfill, and its embed and widget served where the demo serves 5.1.0's,
 * so the page's ?mcpb hook loads them unchanged.
 */
async function startMcpb6Baseline(options: BaselineOptions = {}): Promise<Baseline> {
  const cleanups: (() => Promise<unknown>)[] = [];
  const closeAll = async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
  };
  try {
    const demo = await startDemoServer();
    cleanups.push(demo.close);
    const relayPort = await freePort();
    const pageOrigin = new URL(demo.url).origin;
    const home = await relayHome();
    cleanups.push(home.remove);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCPB6_LOCAL_RELAY_CLI, '--port', String(relayPort), '--widget-origin', pageOrigin],
      env: home.env,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'tabdock-m5-baseline', version: '0.0.0' });
    if (options.onToolListChanged) {
      const notify = options.onToolListChanged;
      client.setNotificationHandler('notifications/tools/list_changed', () => {
        notify();
      });
    }
    cleanups.push(() => client.close());
    await client.connect(transport);

    const browser = await launchChromium(options.headless ?? true);
    cleanups.push(() => browser.close());
    const page = await browser.newPage();
    const browserDir = join(dirname(MCPB6_LOCAL_RELAY_CLI), 'browser');
    // Keeps the demo server's own headers (frame-ancestors among them) and swaps the bytes.
    await page.route(/\/vendor\/webmcp-local-relay\/(embed\.js|widget\.html)$/, async (route) => {
      const name = new URL(route.request().url()).pathname.split('/').pop() ?? '';
      const response = await route.fetch();
      await route.fulfill({ response, body: readFileSync(join(browserDir, name)) });
    });
    await page.addInitScript({ content: mcpb6InitScript({ recordCalls: false }) });
    const started = performance.now();
    await page.goto(`${demo.url}?mcpb=${String(relayPort)}`);
    await page.waitForSelector('html[data-tools="ready"]');
    await checkOnMcpb6(page);
    await waitForTools(client, DEMO_TOOL_NAMES, 20_000, 5);
    const toolsVisibleAfterMs = Math.round(performance.now() - started);

    return { demo, relayPort, client, browser, page, toolsVisibleAfterMs, close: closeAll };
  } catch (error) {
    await closeAll();
    throw error;
  }
}

async function measureThroughRelay() {
  const changes: number[] = [];
  const start = mcpb6 ? startMcpb6Baseline : startBaseline;
  const baseline = await start({
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
    // Failed calls (every call on runtimes the relay cannot drive) are counted, not timed.
    const timings: number[] = [];
    let failedCalls = 0;
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      const result = await client.callTool({ name: 'get_view', arguments: {} });
      if (result.isError) failedCalls++;
      else timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);

    // A tool registered after load: how long until the MCP client hears about it?
    changes.length = 0;
    const lateStart = performance.now();
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
    // Fine polling, so the visibility time measures the relay rather than this loop.
    await waitForTools(client, ['late_tool'], 10_000, 5);
    const visibleMs = performance.now() - lateStart;
    const firstChange = changes[0];
    // Its handler returns plain text, which 6 serializes as JSON: what reaches the client?
    const lateToolCallSample = await client.callTool({ name: 'late_tool', arguments: {} });
    // getTools() with the embed's hidden iframe in the page: 6 also asks same-origin
    // frames for their tools, and this shows whether a frame that never answers costs a call.
    const getToolsWithEmbedMs = await page.evaluate(async () => {
      const mc = (document as unknown as { modelContext: { getTools(): Promise<unknown[]> } })
        .modelContext;
      const times: number[] = [];
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        await mc.getTools();
        times.push(Math.round((performance.now() - start) * 10) / 10);
      }
      return times;
    });

    return {
      toolsVisibleAfterLoadMs: baseline.toolsVisibleAfterMs,
      serverInfo: client.getServerVersion(),
      serverCapabilities: client.getServerCapabilities(),
      listedTools: listed.tools.map((t) => ({ name: t.name, annotations: t.annotations ?? null })),
      clearBoardAsListed: listed.tools.find((t) => t.name === 'clear_board') ?? null,
      callSample,
      errorSample,
      badArgsSample,
      lateToolCallSample,
      getToolsWithEmbedMs,
      getViewRoundTripMs: {
        n: timings.length,
        failed: failedCalls,
        p50: Math.round(percentile(timings, 50) * 10) / 10,
        p95: Math.round(percentile(timings, 95) * 10) / 10,
        max: Math.round((timings.at(-1) ?? Number.NaN) * 10) / 10,
      },
      lateToolListChangedMs: firstChange === undefined ? null : Math.round(firstChange - lateStart),
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
  mcpb: mcpbPackages(),
  ...inPage,
  relay,
};
await writeFile(outFile, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
console.log(`\nWrote ${outFile}`);

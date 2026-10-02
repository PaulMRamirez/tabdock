// Shared setup for the M0 baseline: the demo page in headless Chromium, MCP-B's
// local relay as a stdio MCP server, and an MCP client built on the official SDK.
// The client stands in for Claude Code; docs/checklists/M0.md covers the real one.

import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { chromium, type Browser, type Page } from '@playwright/test';
import { startDemoServer, type DemoServer } from '@tabdock/demo/server';

export const DEMO_TOOL_NAMES = [
  'add_item',
  'clear_board',
  'get_view',
  'highlight_item',
  'list_items',
  'move_view',
] as const;

/** The relay's CLI sits beside its main entry; its package exports do not expose it. */
export const RELAY_CLI = fileURLToPath(
  new URL('./cli.mjs', import.meta.resolve('@mcp-b/webmcp-local-relay')),
);

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('Could not allocate a port'));
      });
    });
  });
}

export interface Baseline {
  demo: DemoServer;
  relayPort: number;
  client: Client;
  browser: Browser;
  page: Page;
  /** Milliseconds from page navigation until the relay listed every demo tool. */
  toolsVisibleAfterMs: number;
  close: () => Promise<void>;
}

export interface BaselineOptions {
  headless?: boolean;
  /** Called for every tools/list_changed notification the relay sends. */
  onToolListChanged?: () => void;
  /** Receives the relay's stderr lines, which it uses for its own logging. */
  onRelayLog?: (line: string) => void;
}

export async function startBaseline(options: BaselineOptions = {}): Promise<Baseline> {
  const demo = await startDemoServer();
  const relayPort = await freePort();
  const pageOrigin = new URL(demo.url).origin;

  // Restricting the widget origin is the relay's recommended setting; its default is '*'.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [RELAY_CLI, '--port', String(relayPort), '--widget-origin', pageOrigin],
    stderr: 'pipe',
  });
  if (options.onRelayLog) {
    const log = options.onRelayLog;
    transport.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) log(line);
    });
  }
  const client = new Client({ name: 'tabdock-m0-baseline', version: '0.0.0' });
  if (options.onToolListChanged) {
    const notify = options.onToolListChanged;
    client.setNotificationHandler('notifications/tools/list_changed', () => {
      notify();
    });
  }
  await client.connect(transport);

  const browser = await launchChromium(options.headless ?? true);
  const page = await browser.newPage();
  const started = performance.now();
  await page.goto(`${demo.url}?mcpb=${relayPort}`);
  await page.waitForSelector('html[data-tools="ready"]');
  await waitForTools(client, DEMO_TOOL_NAMES);
  const toolsVisibleAfterMs = Math.round(performance.now() - started);

  return {
    demo,
    relayPort,
    client,
    browser,
    page,
    toolsVisibleAfterMs,
    close: async () => {
      await browser.close();
      await client.close();
      await demo.close();
    },
  };
}

/**
 * Uses CHROMIUM_EXECUTABLE when set (for example a newer Chrome with the
 * WebMCP flag), otherwise the Chromium that matches the installed Playwright.
 */
export function launchChromium(headless: boolean): Promise<Browser> {
  const executablePath = process.env.CHROMIUM_EXECUTABLE;
  return chromium.launch({ headless, ...(executablePath ? { executablePath } : {}) });
}

/** Polls the relay until every named tool is listed. The SDK caches lists, so each poll refreshes. */
export async function waitForTools(
  client: Client,
  names: readonly string[],
  timeoutMs = 20_000,
): Promise<string[]> {
  const deadline = performance.now() + timeoutMs;
  let listed: string[] = [];
  while (performance.now() < deadline) {
    const { tools } = await client.listTools(undefined, { cacheMode: 'refresh' });
    listed = tools.map((t) => t.name);
    if (names.every((name) => listed.includes(name))) return listed;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Relay listed [${listed.join(', ')}], still missing some of [${names.join(', ')}]`,
  );
}

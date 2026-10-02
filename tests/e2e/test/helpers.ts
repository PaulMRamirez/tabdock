// One Tabdock world per test: a real relay on a free port with throwaway dev
// tokens, sim pages running the real adapter core over `ws` with an Origin
// header, and MCP clients from the official SDK over Streamable HTTP with a
// bearer header. Nothing is mocked between the client and the page handler.

import { randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { type ErrorCode, isErrorCode, type Role } from '@tabdock/protocol';
import {
  createDevTokenAuth,
  createRelay,
  type DevTokenUser,
  type Relay,
  type RelayOptions,
} from '@tabdock/relay';
import type { DockState } from '@tabdock/adapter/core';
import { type SimPage, type SimPageOptions, startSimPage } from '@tabdock/sim-page';
import { expect } from 'vitest';

/** Fresh random tokens on every run, so no usable credential ever sits in the repo. */
function devUser(userId: string, displayName: string): DevTokenUser {
  return { userId, displayName, token: `${userId}-${randomBytes(24).toString('base64url')}` };
}

export interface World {
  relay: Relay;
  alice: DevTokenUser;
  bob: DevTokenUser;
  /** Every line the relay logged, at debug level. */
  relayLogs: string[];
  /** Every sim page started in this world, including closed ones. */
  pages: SimPage[];
  page(options?: Omit<SimPageOptions, 'relayUrl'>): Promise<SimPage>;
  client(user: DevTokenUser, name?: string): Promise<Client>;
  close(): Promise<void>;
}

export async function startWorld(
  options: { timings?: RelayOptions['timings'] } = {},
): Promise<World> {
  const alice = devUser('alice', 'Alice');
  const bob = devUser('bob', 'Bob');
  const relayLogs: string[] = [];
  const relay = await createRelay({
    auth: createDevTokenAuth([alice, bob]),
    port: 0,
    // The sim pages send an Origin header like a browser, so the dev flag stays off (S1).
    allowMissingOrigin: false,
    logLevel: 'debug',
    logSink: (line) => {
      relayLogs.push(line);
    },
    timings: options.timings,
  });
  const pages: SimPage[] = [];
  const clients: Client[] = [];
  return {
    relay,
    alice,
    bob,
    relayLogs,
    pages,
    async page(pageOptions = {}) {
      const sim = await startSimPage({ relayUrl: relay.pageUrl, ...pageOptions });
      pages.push(sim);
      return sim;
    },
    async client(user, name = 'tabdock-e2e') {
      const transport = new StreamableHTTPClientTransport(new URL(relay.mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${user.token}` } },
      });
      const client = new Client({ name, version: '0.0.0' });
      await client.connect(transport);
      clients.push(client);
      return client;
    },
    async close() {
      for (const sim of pages) await sim.close();
      for (const client of clients) await client.close();
      await relay.close();
    },
  };
}

export interface ToolOutcome {
  isError: boolean;
  text: string;
  structured: unknown;
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome> {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  return { isError: result.isError === true, text, structured: result.structuredContent };
}

/** The SPEC section 7 code at the start of a Tabdock error, or null for anything else. */
export function errorCode(outcome: ToolOutcome): ErrorCode | null {
  if (!outcome.isError) return null;
  const code = outcome.text.split(':', 1)[0] ?? '';
  return isErrorCode(code) ? code : null;
}

export async function linked(sim: SimPage): Promise<DockState & { pageId: string }> {
  const state = await sim.waitFor((s) => s.link === 'linked' && s.pairing !== null);
  if (state.pageId === null) throw new Error('linked without a page id');
  return { ...state, pageId: state.pageId };
}

/** The code the page shows right now, read the way an operator reads the widget. */
export async function pairingCode(sim: SimPage): Promise<string> {
  const state = await linked(sim);
  if (!state.pairing) throw new Error('no pairing code');
  return state.pairing.code;
}

/**
 * pair_page with the page's code, then the operator answers through the
 * page's own handle. Returns the pair_page outcome and the request id.
 */
export async function pairThroughOperator(
  client: Client,
  sim: SimPage,
  answer: Role | 'deny',
): Promise<{ outcome: ToolOutcome; requestId: string }> {
  const code = await pairingCode(sim);
  const pending = callTool(client, 'pair_page', { code });
  const state = await sim.waitFor((s) => s.pendingRequests.length > 0);
  const request = state.pendingRequests[0];
  if (!request) throw new Error('no attach request reached the page');
  const answered =
    answer === 'deny' ? sim.dock.deny(request.requestId) : sim.dock.approve(request.requestId, answer);
  expect(answered).toBe(true);
  return { outcome: await pending, requestId: request.requestId };
}

/** pairThroughOperator for the common case: approved, and the page id it attached to. */
export async function attachAs(client: Client, sim: SimPage, role: Role): Promise<string> {
  const { outcome } = await pairThroughOperator(client, sim, role);
  expect(outcome.isError, outcome.text).toBe(false);
  return (outcome.structured as { page: string }).page;
}

/**
 * Waits until the relay lists `count` tools for the page. The adapter shares
 * its tools right after the welcome, so a fast test can otherwise outrun it.
 */
export async function waitForTools(
  client: Client,
  pageId: string,
  count: number,
  timeoutMs = 5000,
): Promise<ToolOutcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const outcome = await callTool(client, 'list_page_tools', { page: pageId });
    const tools = (outcome.structured as { tools?: unknown[] } | undefined)?.tools ?? [];
    if (!outcome.isError && tools.length === count) return outcome;
    if (Date.now() > deadline) {
      throw new Error(`the relay listed ${String(tools.length)} tools, not ${String(count)}`);
    }
    await delay(25);
  }
}

export interface PageListing {
  page: string;
  origin: string;
  title: string;
  role: Role;
  state: 'awake' | 'asleep' | 'gone';
  toolCount: number;
}

export async function listPages(client: Client): Promise<PageListing[]> {
  const outcome = await callTool(client, 'list_pages');
  expect(outcome.isError, outcome.text).toBe(false);
  return (outcome.structured as { pages: PageListing[] }).pages;
}

/** Polls until check passes, for state that settles over the network. */
export async function eventually(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${String(timeoutMs)} ms`);
    await delay(25);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The six tools every sim page offers by default (packages/sim-page/src/default-tools.ts). */
export const SIM_TOOL_COUNT = 6;

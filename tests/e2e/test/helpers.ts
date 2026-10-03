// One Tabdock world per test: a real relay on a free port with throwaway dev
// tokens, sim pages running the real adapter core over `ws` with an Origin
// header, and MCP clients from the official SDK over Streamable HTTP with a
// bearer header. Nothing is mocked between the client and the page handler.

import { randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  type ErrorCode,
  isErrorCode,
  parseRelayFrame,
  type RelayFrame,
  type Role,
} from '@tabdock/protocol';
import {
  createDevTokenAuth,
  createRelay,
  type DevTokenUser,
  type Relay,
  type RelayOptions,
} from '@tabdock/relay';
import type { DockState } from '@tabdock/adapter/core';
import {
  type FakeToolDefinition,
  type SimPage,
  type SimPageOptions,
  startSimPage,
} from '@tabdock/sim-page';
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
  client(user: DevTokenUser, name?: string, options?: ClientOptions): Promise<Client>;
  close(): Promise<void>;
}

export interface ClientOptions {
  /**
   * Pin MCP revision 2026-07-28, whose requests name the client every time.
   * Without it the SDK speaks the 2025 revision and gets a session from the
   * relay's sessionful leg (ADR 0009).
   */
  modern?: boolean;
}

export interface WorldOptions {
  timings?: RelayOptions['timings'];
  limits?: RelayOptions['limits'];
  rateLimits?: RelayOptions['rateLimits'];
  /** The M3 spike's measurements (ADR 0014); off unless a test asks. */
  spike?: boolean;
}

export async function startWorld(options: WorldOptions = {}): Promise<World> {
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
    limits: options.limits,
    rateLimits: options.rateLimits,
    spike: options.spike,
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
    async client(user, name = 'tabdock-e2e', clientOptions = {}) {
      const transport = new StreamableHTTPClientTransport(new URL(relay.mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${user.token}` } },
      });
      const client = new Client(
        { name, version: '0.0.0' },
        clientOptions.modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
      );
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
    answer === 'deny'
      ? sim.dock.deny(request.requestId)
      : sim.dock.approve(request.requestId, answer);
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
 * pair_page from another client of a user the page already lists, which the
 * relay answers at once without asking the operator. The code is single use
 * and the page hears of its successor on the page link while the client hears
 * the answer over HTTP, so this waits for the new code to reach the page: a
 * pairing right after must not pick up the code that just died.
 */
export async function pairAgain(client: Client, sim: SimPage): Promise<ToolOutcome> {
  const code = await pairingCode(sim);
  const outcome = await callTool(client, 'pair_page', { code });
  await sim.waitFor((s) => s.pairing !== null && s.pairing.code !== code);
  return outcome;
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

/** The relay's log lines as objects; the relay writes one JSON object per line. */
export function relayEntries(lines: readonly string[]): { msg: string; [key: string]: unknown }[] {
  return lines.map((line) => JSON.parse(line) as { msg: string; [key: string]: unknown });
}

/**
 * Call ids in the order the relay logged them joining a page's write queue
 * (its 'call queued' debug line), which is the order mutating calls arrived.
 */
export function queuedCallIds(lines: readonly string[]): string[] {
  return relayEntries(lines)
    .filter((entry) => entry.msg === 'call queued')
    .map((entry) => (typeof entry.callId === 'string' ? entry.callId : ''));
}

/**
 * Every frame the relay sends to the sim page from now on, recorded off the
 * page's own socket beside the adapter's handler, so a test sees the wire as
 * the page did. Only valid frames are kept; the adapter checks the rest.
 */
export function watchFrames(sim: SimPage): RelayFrame[] {
  const socket = sim.socket;
  if (!socket) throw new Error('the sim page has no socket to watch');
  const frames: RelayFrame[] = [];
  socket.on('message', (data, isBinary) => {
    if (isBinary || !Buffer.isBuffer(data)) return;
    const parsed = parseRelayFrame(data.toString('utf8'));
    if (parsed.kind === 'ok') frames.push(parsed.frame);
  });
  return frames;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

/** A promise a test settles itself, such as a gate that holds a page handler. */
export function deferred<T = void>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A string field of a tool's input, as a sim page handler receives it. */
export function inputField(input: unknown, key: string): string {
  const value =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)[key]
      : undefined;
  return typeof value === 'string' ? value : '';
}

/** What one run of a hold tool's handler went through. */
export interface HoldRecord {
  /** Resolves when the handler starts, saying whether the runtime handed it an AbortSignal. */
  started: Deferred<{ hasSignal: boolean }>;
  /** Resolves when that signal fires; it never does on a runtime that passes none. */
  aborted: Deferred<void>;
}

export function holdRecord(): HoldRecord {
  return { started: deferred(), aborted: deferred() };
}

/**
 * A page tool whose handler keeps running until the runtime aborts it, so a
 * test can act while a call is in flight and see whether the page's handler
 * was told to stop. It gives up by itself after 20 s, so a failing test leaves
 * nothing behind.
 */
export function holdTool(
  record: HoldRecord,
  options: { name?: string; readOnly?: boolean } = {},
): FakeToolDefinition {
  return {
    name: options.name ?? 'hold',
    description: 'Run until cancelled.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: options.readOnly ?? false },
    execute: (_input, runtime) =>
      new Promise((resolve, reject) => {
        const signal = runtime?.signal;
        record.started.resolve({ hasSignal: signal !== undefined });
        const timer = setTimeout(() => {
          resolve({ held: 'gave up waiting' });
        }, 20_000);
        timer.unref();
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            record.aborted.resolve();
            reject(signal.reason as Error);
          },
          { once: true },
        );
      }),
  };
}

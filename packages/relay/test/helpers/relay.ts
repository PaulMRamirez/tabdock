// Starts a relay on a free port with three dev users, short timings and a log
// sink that keeps every line, plus an MCP client that talks to it the way a
// real one does: Streamable HTTP with a bearer header, through the official SDK.

import {
  Client,
  type FetchLike,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { Role } from '@tabdock/protocol';
import { expect, onTestFinished } from 'vitest';
import {
  createDevTokenAuth,
  createRelay,
  DEFAULT_RATE_LIMITS,
  type DevTokenUser,
  type Relay,
  type RelayOptions,
} from '../../src/index.ts';
import type { TestPage } from './page-client.ts';

export const ALICE: DevTokenUser = {
  userId: 'alice',
  displayName: 'Alice',
  token: 'alice-dev-token-6b1f0c9e4d2a7358',
};
export const BOB: DevTokenUser = {
  userId: 'bob',
  displayName: 'Bob',
  token: 'bob-dev-token-93e7a1c5f0d24b68aa',
};
export const CAROL: DevTokenUser = {
  userId: 'carol',
  displayName: 'Carol',
  token: 'carol-dev-token-0f5c2b8d6e1a4973',
};

export const FAST_TIMINGS = {
  pairingTtlMs: 5000,
  attachRequestTtlMs: 5000,
  pairWaitMs: 3000,
  resumeWindowMs: 5000,
  pingIntervalMs: 5000,
  idleTimeoutMs: 10_000,
  helloTimeoutMs: 2000,
  callDeadlineMs: 3000,
  callDeadlineGraceMs: 100,
  goneTombstoneMs: 5000,
};

export interface TestRelay {
  relay: Relay;
  /** Every log line the relay wrote. */
  lines: string[];
  close(): Promise<void>;
}

export async function startRelay(options: Partial<RelayOptions> = {}): Promise<TestRelay> {
  const lines: string[] = [];
  const relay = await createRelay({
    auth: createDevTokenAuth([ALICE, BOB, CAROL]),
    port: 0,
    logLevel: 'debug',
    logSink: (line) => {
      lines.push(line);
    },
    ...options,
    timings: { ...FAST_TIMINGS, ...options.timings },
  });
  return { relay, lines, close: () => relay.close() };
}

/**
 * Keeps what a timed-out test opens late out of the next test. Vitest runs
 * afterEach once a test times out but leaves the test itself running, so a
 * relay, page or client it was still opening would land in the slots the
 * next test fills, and nothing would close it. A file calls `end()` first in
 * its afterEach and opens through `keep`, which closes anything that arrives
 * after an `end()` and throws instead of handing it back.
 */
export class TestFence {
  #ended = 0;

  end(): void {
    this.#ended += 1;
  }

  async keep<T>(opening: Promise<T>, close: (late: T) => unknown): Promise<T> {
    const started = this.#ended;
    const opened = await opening;
    if (this.#ended !== started) {
      await close(opened);
      throw new Error('opened after its test had ended');
    }
    return opened;
  }
}

export interface ClientOptions {
  name?: string;
  version?: string;
  /** Speak 2026-07-28, which names the client in every request's _meta. */
  modern?: boolean;
  /** Stands in for fetch, so a test can send a body the SDK itself could never serialise. */
  fetch?: FetchLike;
}

export async function connectClient(
  relay: Relay,
  user: DevTokenUser,
  options: ClientOptions = {},
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(relay.mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${user.token}` } },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const client = new Client(
    { name: options.name ?? 'relay-test', version: options.version ?? '1.0.0' },
    options.modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  await client.connect(transport);
  return client;
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

/** Pairs with the page's current code and has the page approve with `role` (null leaves it out). */
export async function pairAndApprove(
  client: Client,
  page: TestPage,
  role: Role | null = 'driver',
): Promise<ToolOutcome> {
  const pending = callTool(client, 'pair_page', { code: page.code });
  const request = await page.next('attach_request');
  page.send({
    t: 'attach_decision',
    requestId: request.requestId,
    allow: true,
    ...(role === null ? {} : { role }),
  });
  const outcome = await pending;
  expect(outcome.isError, outcome.text).toBe(false);
  return outcome;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The 2025-era session a client holds; undefined for a 2026-07-28 client, which has none. */
export function sessionIdOf(client: Client): string | undefined {
  const transport = client.transport;
  return transport instanceof StreamableHTTPClientTransport ? transport.sessionId : undefined;
}

/**
 * Starts the rest of this test at the start of a window of the relay's line
 * budgets. Those budgets (repeated-lines.ts, auth-log.ts) turn with the wall
 * clock's own windows, Math.floor(now / windowMs), not with a test, so a test
 * that counts what one window wrote or held back would find its counts split
 * in two whenever a window happened to end while it ran. Date.now() is set
 * back to the start of the window it is in and runs on at the real pace from
 * there, so the relay's timers and its clock still agree and the test has the
 * whole window. Back, not forward: a stand-in provider's token takes its iat
 * from Date.now(), which jose checks against new Date(), so a clock set
 * forward would mint tokens from the future. Wrapping whatever Date.now is,
 * rather than spying on it, lets a test still spy on it later. Call it before
 * the relay starts; the clock is put back once the test and its afterEach
 * hooks, which close the relay, are done.
 */
export function atWindowStart(windowMs: number = DEFAULT_RATE_LIMITS.windowMs): void {
  const own = Object.getOwnPropertyDescriptor(Date, 'now');
  if (own === undefined) throw new Error('Date.now is not an own property of Date');
  const clock = Date.now.bind(Date);
  const offset = -(clock() % windowMs);
  Object.defineProperty(Date, 'now', { ...own, value: () => clock() + offset });
  onTestFinished(() => {
    Object.defineProperty(Date, 'now', own);
  });
}

/** Polls until `check` holds, for effects that land a few event loop turns later. */
export async function eventually(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`condition not met within ${String(timeoutMs)} ms`);
    await delay(10);
  }
}

// Starts a relay on a free port with three dev users, short timings and a log
// sink that keeps every line, plus an MCP client that talks to it the way a
// real one does: Streamable HTTP with a bearer header, through the official SDK.

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Role } from '@tabdock/protocol';
import { expect } from 'vitest';
import {
  createDevTokenAuth,
  createRelay,
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
  goneTombstoneMs: 5000,
};

export interface TestRelay {
  relay: Relay;
  /** Every log line the relay wrote. */
  lines: string[];
  close(): Promise<void>;
}

export async function startRelay(
  options: Omit<Partial<RelayOptions>, 'timings'> & { timings?: Partial<typeof FAST_TIMINGS> } = {},
): Promise<TestRelay> {
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

export interface ClientOptions {
  name?: string;
  version?: string;
  /** Speak 2026-07-28, which names the client in every request's _meta. */
  modern?: boolean;
}

export async function connectClient(
  relay: Relay,
  user: DevTokenUser,
  options: ClientOptions = {},
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(relay.mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${user.token}` } },
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

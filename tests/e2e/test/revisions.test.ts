// The client matrix of A5.2 (ADR 0027): every SDK generation the relay
// claims, on the leg each one picks, against the real adapter core on the sim
// page with first-class tools on (ADR 0025). Four v1 SDKs, installed as exact
// npm aliases, open a session at the revision each one speaks (1.10.2 at
// 2024-11-05, best effort; 1.12.3 at 2025-03-26; 1.24.0 at 2025-06-18; 1.32.0
// at 2025-11-25), and client 2.3.0 speaks 2025-11-25 on a session in legacy
// mode and 2026-07-28 with none in auto and pinned mode. Each one pairs with
// the page, lists its tools through list_page_tools and tools/list, calls one
// through call_page_tool and another by its first-class name, and hears its
// own list change on its own channel: the GET stream of its session, or a
// subscriptions/listen stream without one.
//
// A recording proxy in front of the relay (src/mcp-proxy.ts) shows what each
// client really sent, request by request as it arrived, so the revision and
// the leg are asserted from the wire and not only from what the relay says;
// the relay's `mcp client` line, the page's roster and the audit record then
// have to agree with it.

import { Client as ClientV2, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { SimPage } from '@tabdock/sim-page';
import { Client as Client1102 } from 'mcp-sdk-1.10.2/client/index.js';
import { StreamableHTTPClientTransport as Http1102 } from 'mcp-sdk-1.10.2/client/streamableHttp.js';
import { ToolListChangedNotificationSchema as Changed1102 } from 'mcp-sdk-1.10.2/types.js';
import { Client as Client1123 } from 'mcp-sdk-1.12.3/client/index.js';
import { StreamableHTTPClientTransport as Http1123 } from 'mcp-sdk-1.12.3/client/streamableHttp.js';
import { ToolListChangedNotificationSchema as Changed1123 } from 'mcp-sdk-1.12.3/types.js';
import { Client as Client1240 } from 'mcp-sdk-1.24.0/client/index.js';
import { StreamableHTTPClientTransport as Http1240 } from 'mcp-sdk-1.24.0/client/streamableHttp.js';
import { ToolListChangedNotificationSchema as Changed1240 } from 'mcp-sdk-1.24.0/types.js';
import { Client as Client1320 } from 'mcp-sdk-1.32.0/client/index.js';
import { StreamableHTTPClientTransport as Http1320 } from 'mcp-sdk-1.32.0/client/streamableHttp.js';
import { ToolListChangedNotificationSchema as Changed1320 } from 'mcp-sdk-1.32.0/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { type McpProxy, type RecordedRequest, startMcpProxy } from '../src/mcp-proxy.ts';
import {
  eventually,
  linked,
  relayEntries,
  SIM_TOOL_COUNT,
  startWorld,
  type World,
} from './helpers.ts';

/** What one call answered, read the same way whatever SDK the client is. */
interface Outcome {
  isError: boolean;
  text: string;
  structured: unknown;
}

/** One client of the matrix, behind the few operations the matrix needs. */
interface MatrixClient {
  call(name: string, args?: Record<string, unknown>): Promise<Outcome>;
  toolNames(): Promise<string[]>;
  /** Counts tool list changes the client's own handler hears. */
  heard(): number;
  /** Opens the channel the client hears changes on, where it does not open one itself. */
  openChannel(): Promise<void>;
  sessionId(): string | undefined;
  close(): Promise<void>;
}

function outcomeOf(result: unknown): Outcome {
  const fields = (typeof result === 'object' && result !== null ? result : {}) as {
    content?: { type?: string; text?: string }[];
    isError?: boolean;
    structuredContent?: unknown;
  };
  const text = (fields.content ?? [])
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .join('\n');
  return { isError: fields.isError === true, text, structured: fields.structuredContent };
}

/**
 * The part of a v1 SDK's Client the matrix uses. Each alias brings its own
 * types (and its own zod), so they meet here at the few calls the matrix makes.
 */
interface V1Client {
  connect(transport: unknown): Promise<void>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  listTools(): Promise<{ tools: { name: string }[] }>;
  setNotificationHandler(schema: unknown, handler: () => void): void;
  close(): Promise<void>;
}

interface V1Kit {
  Client: new (
    info: { name: string; version: string },
    options: { capabilities: Record<string, unknown> },
  ) => unknown;
  Transport: new (url: URL, options: { requestInit: RequestInit }) => unknown;
  changed: unknown;
}

const V1_KITS: Record<string, V1Kit> = {
  '1.10.2': {
    Client: Client1102,
    Transport: Http1102,
    changed: Changed1102,
  },
  '1.12.3': {
    Client: Client1123,
    Transport: Http1123,
    changed: Changed1123,
  },
  '1.24.0': {
    Client: Client1240,
    Transport: Http1240,
    changed: Changed1240,
  },
  '1.32.0': {
    Client: Client1320,
    Transport: Http1320,
    changed: Changed1320,
  },
};

async function connectV1(version: string, url: string, token: string, name: string) {
  const kit = V1_KITS[version];
  if (kit === undefined) throw new Error(`no v1 SDK ${version} in the matrix`);
  const transport = new kit.Transport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }) as { sessionId?: string };
  const client = new kit.Client({ name, version: '0.0.0' }, { capabilities: {} }) as V1Client;
  let heard = 0;
  client.setNotificationHandler(kit.changed, () => {
    heard += 1;
  });
  await client.connect(transport);
  const matrix: MatrixClient = {
    call: async (tool, args = {}) =>
      outcomeOf(await client.callTool({ name: tool, arguments: args })),
    toolNames: async () => (await client.listTools()).tools.map((tool) => tool.name),
    heard: () => heard,
    // A v1 client opens its session's GET stream itself once initialize is acknowledged.
    openChannel: () => Promise.resolve(),
    sessionId: () => transport.sessionId,
    close: () => client.close(),
  };
  return matrix;
}

type V2Mode = 'legacy' | 'auto' | 'pinned';

async function connectV2(mode: V2Mode, url: string, token: string, name: string) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new ClientV2(
    { name, version: '0.0.0' },
    mode === 'legacy'
      ? {}
      : { versionNegotiation: { mode: mode === 'auto' ? 'auto' : { pin: '2026-07-28' } } },
  );
  let heard = 0;
  client.setNotificationHandler('notifications/tools/list_changed', () => {
    heard += 1;
  });
  await client.connect(transport);
  let subscription: Awaited<ReturnType<ClientV2['listen']>> | undefined;
  const matrix: MatrixClient = {
    call: async (tool, args = {}) =>
      outcomeOf(await client.callTool({ name: tool, arguments: args })),
    toolNames: async () =>
      (await client.listTools(undefined, { cacheMode: 'refresh' })).tools.map((tool) => tool.name),
    heard: () => heard,
    openChannel: async () => {
      // Without a session there is no GET stream; a 2026-07-28 client asks to listen.
      if (mode === 'legacy') return;
      subscription = await client.listen({ toolsListChanged: true });
      expect(subscription.honoredFilter.toolsListChanged).toBe(true);
    },
    sessionId: () => transport.sessionId,
    close: async () => {
      await subscription?.close();
      await client.close();
    },
  };
  return matrix;
}

interface Row {
  label: string;
  /** The client's name, as the roster and the `mcp client` line must show it. */
  name: string;
  connect(url: string, token: string, name: string): Promise<MatrixClient>;
  /** The revision the client asks for in initialize; null on the strict leg. */
  asks: string | null;
  /** The revision the exchange settles on. */
  revision: string;
  leg: 'session' | 'strict';
  /** Whether the client asks server/discover first. */
  discovers: boolean;
}

const ROWS: Row[] = [
  ...(
    [
      ['1.10.2', '2024-11-05'],
      ['1.12.3', '2025-03-26'],
      ['1.24.0', '2025-06-18'],
      ['1.32.0', '2025-11-25'],
    ] as const
  ).map(([version, revision]): Row => ({
    label: `@modelcontextprotocol/sdk ${version}`,
    name: `matrix-sdk-${version}`,
    connect: (url, token, name) => connectV1(version, url, token, name),
    asks: revision,
    revision,
    leg: 'session',
    discovers: false,
  })),
  {
    label: '@modelcontextprotocol/client 2.3.0, legacy',
    name: 'matrix-client-legacy',
    connect: (url, token, name) => connectV2('legacy', url, token, name),
    asks: '2025-11-25',
    revision: '2025-11-25',
    leg: 'session',
    discovers: false,
  },
  {
    label: '@modelcontextprotocol/client 2.3.0, auto',
    name: 'matrix-client-auto',
    connect: (url, token, name) => connectV2('auto', url, token, name),
    asks: null,
    revision: '2026-07-28',
    leg: 'strict',
    discovers: true,
  },
  {
    label: '@modelcontextprotocol/client 2.3.0, pinned to 2026-07-28',
    name: 'matrix-client-pinned',
    connect: (url, token, name) => connectV2('pinned', url, token, name),
    asks: null,
    revision: '2026-07-28',
    leg: 'strict',
    discovers: true,
  },
];

let world: World | undefined;
let proxy: McpProxy | undefined;
let client: MatrixClient | undefined;

afterEach(async () => {
  await client?.close().catch(() => undefined);
  client = undefined;
  await world?.close();
  world = undefined;
  await proxy?.close();
  proxy = undefined;
});

/** pair_page with the page's code through any matrix client, the operator allowing a driver. */
async function pair(through: MatrixClient, sim: SimPage): Promise<string> {
  const state = await linked(sim);
  if (!state.pairing) throw new Error('no pairing code');
  const pending = through.call('pair_page', { code: state.pairing.code });
  const asked = await sim.waitFor((s) => s.pendingRequests.length > 0);
  const request = asked.pendingRequests[0];
  if (!request) throw new Error('no attach request reached the page');
  expect(sim.dock.approve(request.requestId, 'driver')).toBe(true);
  const outcome = await pending;
  expect(outcome.isError, outcome.text).toBe(false);
  return (outcome.structured as { page: string }).page;
}

function rpcMethods(request: RecordedRequest): (string | null)[] {
  return request.messages.map((message) => message.method);
}

describe('the client matrix (A5.2), with first-class tools on', () => {
  it.each(ROWS)(
    '$label pairs, lists, calls by both routes and hears its own list change',
    async (row) => {
      world = await startWorld({ firstClassTools: true, timings: { sseKeepAliveMs: 100 } });
      proxy = await startMcpProxy({ upstream: world.relay.url, record: true });
      const sim = await world.page();
      client = await row.connect(proxy.url, world.alice.token, row.name);
      await client.openChannel();
      if (row.leg === 'session') {
        // The relay holds back a GET stream's head until its first bytes, a
        // keep-alive at the latest; once it is back the stream is the session's.
        await eventually(async () =>
          Promise.resolve(
            proxy?.requests().some((r) => r.method === 'GET' && r.status === 200) === true,
          ),
        );
      }

      const pageId = await pair(client, sim);
      // Attaching changed the member's list, and the first change goes at once (ADR 0032).
      await eventually(async () => Promise.resolve((client?.heard() ?? 0) > 0));

      const listed = await client.call('list_page_tools', { page: pageId });
      expect(listed.isError, listed.text).toBe(false);
      const descriptors = (listed.structured as { tools: { name: string; firstClass: unknown }[] })
        .tools;
      expect(descriptors).toHaveLength(SIM_TOOL_COUNT);
      expect(descriptors.find((tool) => tool.name === 'set_value')?.firstClass).toBe(
        `${pageId}__set_value`,
      );
      const names = await client.toolNames();
      expect(names).toEqual(
        expect.arrayContaining(['call_page_tool', `${pageId}__get_value`, `${pageId}__set_value`]),
      );

      const value = `set by ${row.name}`;
      const byName = await client.call(`${pageId}__set_value`, { value });
      expect(byName.isError, byName.text).toBe(false);
      expect(sim.store.value).toBe(value);
      const fixed = await client.call('call_page_tool', {
        page: pageId,
        tool: 'get_value',
        arguments: {},
      });
      expect(fixed.isError, fixed.text).toBe(false);
      expect(fixed.text).toContain('[tabdock: untrusted content from');
      expect(fixed.structured).toEqual({ value });

      // The wire, as each request arrived.
      const wire = proxy.requests();
      const posts = wire.filter((r) => r.method === 'POST');
      const messages = posts.flatMap((r) => r.messages);
      const named = messages.filter((message) => message.client !== null);
      expect(new Set(named.map((message) => message.client))).toEqual(new Set([row.name]));
      // Each route as the relay received it, and the first-class name a tools/list answer gave.
      expect(
        messages.filter((message) => message.method === 'tools/call').map((m) => m.tool),
      ).toEqual(['pair_page', 'list_page_tools', `${pageId}__set_value`, 'call_page_tool']);
      expect(wire.some((r) => r.listed.includes(`${pageId}__set_value`))).toBe(true);
      if (row.leg === 'session') {
        expect(client.sessionId()).toBeDefined();
        const [first] = posts;
        expect(first ? rpcMethods(first) : []).toEqual(['initialize']);
        expect(first?.messages[0]?.version).toBe(row.asks);
        expect(first?.negotiated).toBe(row.revision);
        expect(first?.openedSession).toBe('s1');
        // Every later request names that session and no other, and from
        // 2025-06-18, which brought the header, says the negotiated revision.
        const header = row.revision >= '2025-06-18' ? row.revision : null;
        for (const later of wire.slice(1)) {
          expect(later.session, `${later.method} ${String(rpcMethods(later))}`).toBe('s1');
          expect(later.versionHeader, `${later.method} ${String(rpcMethods(later))}`).toBe(header);
        }
        expect(messages.some((message) => message.method === 'server/discover')).toBe(false);
        expect(
          messages.every((message) => message.method === 'initialize' || message.version === null),
        ).toBe(true);
        const stream = wire.find((r) => r.method === 'GET');
        expect(stream?.status).toBe(200);
        expect(stream?.heard).toContain('notifications/tools/list_changed');
      } else {
        expect(client.sessionId()).toBeUndefined();
        expect(messages.some((message) => message.method === 'initialize')).toBe(false);
        expect(wire.every((r) => r.session === null && r.openedSession === null)).toBe(true);
        expect(wire.some((r) => r.method === 'GET')).toBe(false);
        for (const post of posts) {
          expect(post.versionHeader).toBe('2026-07-28');
          for (const message of post.messages.filter((m) => m.request)) {
            expect(message.version, String(message.method)).toBe('2026-07-28');
          }
        }
        if (row.discovers)
          expect(posts[0] ? rpcMethods(posts[0]) : []).toEqual(['server/discover']);
        const listen = posts.find((r) => rpcMethods(r).includes('subscriptions/listen'));
        expect(listen?.status).toBe(200);
        expect(listen?.heard).toContain('notifications/tools/list_changed');
      }

      // The relay, the page and the audit agree with the wire.
      const lines = relayEntries(world.relayLogs).filter(
        (entry) => entry.msg === 'mcp client' && entry.client === row.name,
      );
      expect(lines).toEqual([
        expect.objectContaining({ userId: 'alice', leg: row.leg, revision: row.revision }),
      ]);
      const roster = await sim.waitFor((s) =>
        s.roster.some(
          (entry) =>
            entry.userId === 'alice' && entry.clients.some((seen) => seen.name === row.name),
        ),
      );
      expect(roster.roster.find((entry) => entry.userId === 'alice')?.role).toBe('driver');
      expect(
        world.relay.audit
          .records()
          .filter((record) => record.outcome === 'ok')
          .map((record) => [record.tool, record.client?.name]),
      ).toEqual([
        ['set_value', row.name],
        ['get_value', row.name],
      ]);
    },
  );
});

// The sessionful leg for 2025-era clients (ADR 0009): one session per client,
// bound to the user who opened it, with idle expiry and per-user and global caps.

import type { Client } from '@modelcontextprotocol/client';
import { type AuthInfo, McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/log.ts';
import { McpSessions } from '../src/sessions.ts';
import { connectPage, type TestPage, TOOLS } from './helpers/page-client.ts';
import {
  type OpenStream,
  initializeBody,
  openSession,
  openStream,
  rawCall,
  rawPost,
  rawStatus,
} from './helpers/raw-mcp.ts';
import {
  ALICE,
  BOB,
  CAROL,
  callTool,
  connectClient,
  type ClientOptions,
  delay,
  eventually,
  pairAndApprove,
  sessionIdOf,
  startRelay,
  type TestRelay,
} from './helpers/relay.ts';

let current: TestRelay | undefined;
const pages: TestPage[] = [];
const clients: Client[] = [];
const streams: OpenStream[] = [];

async function setup(options: Parameters<typeof startRelay>[0] = {}): Promise<TestRelay> {
  // A listening stream's headers go out with its first keep-alive, so keep that short.
  current = await startRelay({ ...options, timings: { sseKeepAliveMs: 50, ...options.timings } });
  return current;
}

async function client(user = ALICE, options: ClientOptions = {}): Promise<Client> {
  if (!current) throw new Error('no relay');
  const connected = await connectClient(current.relay, user, options);
  clients.push(connected);
  return connected;
}

async function stream(user: typeof ALICE, sessionId: string): Promise<OpenStream> {
  if (!current) throw new Error('no relay');
  const opened = await openStream(current.relay, user, sessionId);
  streams.push(opened);
  return opened;
}

afterEach(async () => {
  for (const opened of streams.splice(0)) opened.close();
  for (const connected of clients.splice(0)) await connected.close();
  for (const opened of pages.splice(0)) opened.ws.terminate();
  await current?.close();
  current = undefined;
});

const NOT_FOUND = {
  jsonrpc: '2.0',
  error: { code: -32001, message: 'Session not found' },
  id: null,
};

describe('sessions for 2025-era clients', () => {
  it('a 2025-era client keeps one session for all its calls; a 2026-07-28 client has none', async () => {
    await setup();
    const legacy = await client(ALICE);
    const modern = await client(ALICE, { modern: true });
    const id = sessionIdOf(legacy);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await callTool(legacy, 'list_pages');
    await callTool(legacy, 'list_pages');
    expect(sessionIdOf(legacy)).toBe(id);
    expect((await callTool(modern, 'list_pages')).isError).toBe(false);
    expect(sessionIdOf(modern)).toBeUndefined();
  });

  it("answers another user's session id with the same 404 as an unknown one, before any tool runs (S13)", async () => {
    const { relay } = await setup();
    const opened = await connectPage(relay.pageUrl, { tools: TOOLS });
    pages.push(opened);
    const alice = await client(ALICE);
    await pairAndApprove(alice, opened);
    const id = await openSession(relay, ALICE);

    const stolen = await rawCall(relay, BOB, id, 'call_page_tool', {
      page: opened.pageId,
      tool: 'get_view',
    });
    const unknown = await rawCall(relay, BOB, '00000000-0000-4000-8000-000000000000', 'list_pages');
    expect(stolen.status).toBe(404);
    expect(JSON.parse(stolen.body)).toEqual(NOT_FOUND);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toBe(stolen.body);
    expect(await rawStatus(relay, BOB, 'GET', id)).toBe(404);
    expect(await rawStatus(relay, BOB, 'DELETE', id)).toBe(404);
    expect(opened.all('invoke')).toHaveLength(0);

    // The owner's session is untouched and still answers as Alice.
    const own = await rawCall(relay, ALICE, id, 'call_page_tool', {
      page: opened.pageId,
      tool: 'get_view',
    });
    expect(own.status).toBe(200);
    expect(opened.all('invoke').map((frame) => frame.caller.userId)).toEqual(['alice']);
  });

  it('DELETE ends a session, and the id answers 404 after', async () => {
    const { relay } = await setup();
    const id = await openSession(relay, ALICE);
    expect((await rawCall(relay, ALICE, id, 'list_pages')).status).toBe(200);
    expect(await rawStatus(relay, ALICE, 'DELETE', id)).toBe(200);
    expect((await rawCall(relay, ALICE, id, 'list_pages')).status).toBe(404);
  });

  it('only an initialize can start a session; anything else without an id opens nothing', async () => {
    const { relay } = await setup({ limits: { sessions: 1 } });
    const listed = await rawPost(relay, ALICE, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    expect(listed.status).toBe(400);
    await listed.text();
    expect(await rawStatus(relay, ALICE, 'GET')).toBe(400);
    // An initialize the SDK refuses (no text/event-stream in Accept) leaves nothing behind.
    const refused = await rawPost(relay, ALICE, initializeBody(), { accept: 'application/json' });
    expect(refused.status).toBe(406);
    await refused.text();
    // With room for one session only, a real one still opens.
    await openSession(relay, ALICE);
  });

  it('names the client from its initialize in the roster and the audit', async () => {
    const { relay } = await setup();
    const opened = await connectPage(relay.pageUrl, {
      tools: TOOLS,
      onInvoke: () => ({ ok: true, content: '{}' }),
    });
    pages.push(opened);
    const laptop = await client(ALICE, { name: 'laptop-app', version: '3.0.0' });
    await pairAndApprove(laptop, opened);
    expect(opened.all('attach_request')[0]?.client).toEqual({
      name: 'laptop-app',
      version: '3.0.0',
    });
    await callTool(laptop, 'call_page_tool', { page: opened.pageId, tool: 'get_view' });
    expect(opened.all('roster').at(-1)?.attachments[0]?.clients).toEqual([
      { name: 'laptop-app', version: '3.0.0' },
    ]);
    expect(relay.audit.records().at(-1)?.client).toEqual({ name: 'laptop-app', version: '3.0.0' });
  });
});

describe('session limits (ADR 0009)', () => {
  it("a new session past the per-user cap evicts that user's least recently used idle one", async () => {
    const { relay } = await setup({ limits: { sessionsPerUser: 2 } });
    const first = await openSession(relay, ALICE);
    const second = await openSession(relay, ALICE);
    const bobs = await openSession(relay, BOB);
    await delay(5);
    // Using the first makes the second the least recently used.
    expect((await rawCall(relay, ALICE, first, 'list_pages')).status).toBe(200);
    const third = await openSession(relay, ALICE);
    expect((await rawCall(relay, ALICE, second, 'list_pages')).status).toBe(404);
    for (const id of [first, third]) {
      expect((await rawCall(relay, ALICE, id, 'list_pages')).status).toBe(200);
    }
    expect((await rawCall(relay, BOB, bobs, 'list_pages')).status).toBe(200);
  });

  it('with every session of the user busy, a new one is refused with 429', async () => {
    const { relay, lines } = await setup({ limits: { sessionsPerUser: 2 } });
    const first = await openSession(relay, ALICE);
    const second = await openSession(relay, ALICE);
    const listening = await stream(ALICE, first);
    await stream(ALICE, second);
    expect(listening.status).toBe(200);

    const refused = await rawPost(relay, ALICE, initializeBody());
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: { code: -32000 } });
    expect(lines.some((line) => line.includes('the user holds the most sessions allowed'))).toBe(
      true,
    );
    // Other users are not affected.
    await openSession(relay, BOB);

    // Once a stream closes its session is idle, and the next initialize evicts it.
    listening.close();
    await eventually(async () => {
      const response = await rawPost(relay, ALICE, initializeBody());
      await response.text();
      return response.status === 200;
    });
    expect((await rawCall(relay, ALICE, first, 'list_pages')).status).toBe(404);
    expect((await rawCall(relay, ALICE, second, 'list_pages')).status).toBe(200);
  });

  it('initializes that overlap cannot overshoot the per-user cap together', async () => {
    // Straight to the session store, whose unread answers keep each new session busy.
    const sessions = new McpSessions({
      createServer: () => new McpServer({ name: 'test', version: '0' }),
      ownerOf: (authInfo) => authInfo?.clientId ?? null,
      perUser: 2,
      total: 10,
      idleMs: 60_000,
      keepAliveMs: 60_000,
      maxRequestBodySize: 4096,
      log: createLogger({ sink: () => undefined }),
    });
    const authInfo: AuthInfo = { token: '', clientId: 'alice', scopes: [] };
    const initialize = (): Request =>
      new Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(initializeBody()),
      });
    try {
      const answers = await Promise.all(
        [1, 2, 3].map(() => sessions.handle(initialize(), authInfo)),
      );
      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 200, 429]);
      expect(sessions.size).toBe(2);
    } finally {
      await sessions.closeAll();
    }
    expect(sessions.size).toBe(0);
  });

  it('past the relay-wide cap, initialize gets 503 and nothing is evicted', async () => {
    const { relay, lines } = await setup({ limits: { sessions: 2 } });
    const alices = await openSession(relay, ALICE);
    const bobs = await openSession(relay, BOB);
    const refused = await rawPost(relay, CAROL, initializeBody());
    expect(refused.status).toBe(503);
    await refused.text();
    expect(lines.some((line) => line.includes('the relay holds the most sessions allowed'))).toBe(
      true,
    );
    expect((await rawCall(relay, ALICE, alices, 'list_pages')).status).toBe(200);
    expect((await rawCall(relay, BOB, bobs, 'list_pages')).status).toBe(200);
    // Ending one makes room.
    expect(await rawStatus(relay, BOB, 'DELETE', bobs)).toBe(200);
    await openSession(relay, CAROL);
  });

  it('closes a session after sessionIdleMs with no response open, never while one is', async () => {
    const { relay } = await setup({ timings: { sessionIdleMs: 150 } });
    const idle = await openSession(relay, ALICE);
    const busy = await openSession(relay, ALICE);
    const listening = await stream(ALICE, busy);
    await delay(400);
    expect((await rawCall(relay, ALICE, idle, 'list_pages')).status).toBe(404);
    expect((await rawCall(relay, ALICE, busy, 'list_pages')).status).toBe(200);
    listening.close();
    await delay(400);
    expect((await rawCall(relay, ALICE, busy, 'list_pages')).status).toBe(404);
  });

  it('closing the relay ends every session and its streams', async () => {
    const { relay } = await setup();
    const id = await openSession(relay, ALICE);
    const listening = await stream(ALICE, id);
    await relay.close();
    current = undefined;
    await listening.ended;
  });
});

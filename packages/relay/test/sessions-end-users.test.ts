// A member list change ends the 2025-era sessions held under the user ids it
// ended (ADR 0043, S8), and only those held then: the change can give an id
// to someone new, whose session opened a moment later is theirs. Straight to
// the session store, as a reload's endUsers reaches it: an idle session
// closes at once; one still answering serves nothing new, closes when its
// last response is done, and at the grace at the latest.

import { type AuthInfo, McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/log.ts';
import { McpSessions } from '../src/sessions.ts';
import { initializeBody } from './helpers/raw-mcp.ts';
import { delay, eventually } from './helpers/relay.ts';

const PROTOCOL = '2025-11-25';
const URL_ = 'http://127.0.0.1/mcp';

const stores: McpSessions[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.closeAll();
});

function store(): McpSessions {
  const sessions = new McpSessions({
    createServer: () => new McpServer({ name: 'test', version: '0' }),
    ownerOf: (authInfo) => authInfo?.clientId ?? null,
    perUser: 5,
    total: 20,
    idleMs: 60_000,
    keepAliveMs: 60_000,
    maxRequestBodySize: 4096,
    log: createLogger({ sink: () => undefined }),
  });
  stores.push(sessions);
  return sessions;
}

function as(userId: string): AuthInfo {
  return { token: '', clientId: userId, scopes: [] };
}

function post(body: unknown, sessionId?: string): Request {
  return new Request(URL_, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId === undefined
        ? {}
        : { 'Mcp-Session-Id': sessionId, 'Mcp-Protocol-Version': PROTOCOL }),
    },
    body: JSON.stringify(body),
  });
}

/** An initialized session of `userId`, its answers read, so it holds nothing open. */
async function open(sessions: McpSessions, userId: string): Promise<string> {
  const answer = await sessions.handle(post(initializeBody()), as(userId));
  await answer.text();
  const id = answer.headers.get('mcp-session-id');
  if (answer.status !== 200 || id === null) throw new Error('initialize refused');
  const ack = await sessions.handle(
    post({ jsonrpc: '2.0', method: 'notifications/initialized' }, id),
    as(userId),
  );
  await ack.text();
  return id;
}

/** A listening GET stream on the session, held open until cancelled, as the SDK client keeps one. */
async function listening(sessions: McpSessions, userId: string, id: string): Promise<Response> {
  const answer = await sessions.handle(
    new Request(URL_, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'Mcp-Session-Id': id,
        'Mcp-Protocol-Version': PROTOCOL,
      },
    }),
    as(userId),
  );
  expect(answer.status).toBe(200);
  return answer;
}

async function listTools(sessions: McpSessions, userId: string, id: string): Promise<number> {
  const answer = await sessions.handle(
    post({ jsonrpc: '2.0', id: 7, method: 'tools/list' }, id),
    as(userId),
  );
  await answer.text();
  return answer.status;
}

describe('McpSessions.endUsers (ADR 0043)', () => {
  it('closes an idle session of an ended id at once, and leaves every other user alone', async () => {
    const sessions = store();
    await open(sessions, 'bob');
    const alice = await open(sessions, 'alice');
    expect(sessions.endUsers(new Set(['bob']), 60_000)).toBe(1);
    expect(sessions.size).toBe(1);
    expect(await listTools(sessions, 'alice', alice)).toBe(200);
  });

  it('serves nothing new on a session still answering, and closes it when its last response is done', async () => {
    const sessions = store();
    const id = await open(sessions, 'bob');
    const stream = await listening(sessions, 'bob', id);
    expect(sessions.endUsers(new Set(['bob']), 60_000)).toBe(1);
    // Still open for the answer it is writing, but no request reaches it.
    expect(sessions.size).toBe(1);
    expect(await listTools(sessions, 'bob', id)).toBe(404);
    await stream.body?.cancel();
    await eventually(() => sessions.size === 0);
  });

  it('closes a session still answering at the grace at the latest', async () => {
    const sessions = store();
    const id = await open(sessions, 'bob');
    const stream = await listening(sessions, 'bob', id);
    sessions.endUsers(new Set(['bob']), 50);
    await eventually(() => sessions.size === 0);
    await stream.body?.cancel().catch(() => undefined);
  });

  it('leaves a session opened under the id after the change, which belongs to whoever holds it now', async () => {
    const sessions = store();
    const before = await open(sessions, 'bob');
    const stream = await listening(sessions, 'bob', before);
    sessions.endUsers(new Set(['bob']), 50);
    const after = await open(sessions, 'bob');
    await delay(150);
    expect(await listTools(sessions, 'bob', after)).toBe(200);
    expect(await listTools(sessions, 'bob', before)).toBe(404);
    expect(sessions.size).toBe(1);
    await stream.body?.cancel().catch(() => undefined);
  });
});

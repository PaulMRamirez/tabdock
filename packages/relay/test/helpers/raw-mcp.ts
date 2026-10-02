// 2025-era Streamable HTTP by hand, for session tests that need exact control:
// when a session opens, whether a listening GET stream is open, and which
// session id a request presents. The SDK client opens a GET stream on its own
// right after initialize, which keeps its session busy.

import type { DevTokenUser, Relay } from '../../src/index.ts';

const PROTOCOL = '2025-11-25';

function headers(user: DevTokenUser, sessionId?: string, accept?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${user.token}`,
    'Content-Type': 'application/json',
    Accept: accept ?? 'application/json, text/event-stream',
    ...(sessionId === undefined
      ? {}
      : { 'Mcp-Session-Id': sessionId, 'Mcp-Protocol-Version': PROTOCOL }),
  };
}

export function rawPost(
  relay: Relay,
  user: DevTokenUser,
  body: unknown,
  options: { sessionId?: string; accept?: string } = {},
): Promise<Response> {
  return fetch(relay.mcpUrl, {
    method: 'POST',
    headers: headers(user, options.sessionId, options.accept),
    body: JSON.stringify(body),
  });
}

export function initializeBody(name = 'raw-client'): unknown {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name, version: '1.0.0' } },
  };
}

/** Initializes a session and acknowledges it, as a client does; returns its id. */
export async function openSession(
  relay: Relay,
  user: DevTokenUser,
  name?: string,
): Promise<string> {
  const response = await rawPost(relay, user, initializeBody(name));
  const text = await response.text();
  const id = response.headers.get('mcp-session-id');
  if (response.status !== 200 || id === null) {
    throw new Error(`initialize answered ${String(response.status)}: ${text}`);
  }
  const ack = await rawPost(
    relay,
    user,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { sessionId: id },
  );
  await ack.text();
  return id;
}

export interface RawResult {
  status: number;
  /** The JSON-RPC result, when the call got one. */
  result?: { content?: { type: string; text?: string }[]; isError?: boolean };
  /** The whole body as text, for refusals. */
  body: string;
}

let nextId = 100;

/** One tools/call on a session; its answer arrives as an SSE event. */
export async function rawCall(
  relay: Relay,
  user: DevTokenUser,
  sessionId: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<RawResult> {
  nextId += 1;
  const id = nextId;
  const response = await rawPost(
    relay,
    user,
    { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
    { sessionId },
  );
  const body = await response.text();
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const message = JSON.parse(line.slice(6)) as { id?: number; result?: RawResult['result'] };
    if (message.id === id) return { status: response.status, body, result: message.result ?? {} };
  }
  return { status: response.status, body };
}

/** A GET or DELETE on a session, answered with its status only. */
export async function rawStatus(
  relay: Relay,
  user: DevTokenUser,
  method: 'GET' | 'DELETE',
  sessionId?: string,
): Promise<number> {
  const response = await fetch(relay.mcpUrl, {
    method,
    headers: headers(user, sessionId, method === 'GET' ? 'text/event-stream' : undefined),
  });
  await response.body?.cancel();
  return response.status;
}

export interface OpenStream {
  status: number;
  /** Resolves when the stream ends, from either side. */
  ended: Promise<void>;
  close(): void;
}

/** The listening GET stream a 2025-era client keeps open on its session. */
export async function openStream(
  relay: Relay,
  user: DevTokenUser,
  sessionId: string,
): Promise<OpenStream> {
  const abort = new AbortController();
  const response = await fetch(relay.mcpUrl, {
    method: 'GET',
    headers: headers(user, sessionId, 'text/event-stream'),
    signal: abort.signal,
  });
  const reader = response.body?.getReader();
  const ended = (async () => {
    if (!reader) return;
    try {
      while (!(await reader.read()).done) {
        // Keep-alive comments only.
      }
    } catch {
      // Ended by close().
    }
  })();
  return {
    status: response.status,
    ended,
    close: () => {
      abort.abort();
    },
  };
}

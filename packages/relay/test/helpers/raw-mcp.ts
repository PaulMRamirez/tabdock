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

export function initializeBody(
  name = 'raw-client',
  capabilities: Record<string, unknown> = {},
): unknown {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: PROTOCOL, capabilities, clientInfo: { name, version: '1.0.0' } },
  };
}

/**
 * Initializes a session and acknowledges it, as a client does; returns its
 * id. `capabilities` are what the client declares, none by default.
 */
export async function openSession(
  relay: Relay,
  user: DevTokenUser,
  name?: string,
  capabilities?: Record<string, unknown>,
): Promise<string> {
  const response = await rawPost(relay, user, initializeBody(name, capabilities));
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

export interface OpenListen extends OpenStream {
  /** Whether the relay answered with an event stream, the listen's only success. */
  streaming: boolean;
  /** The body of an answer that was not a stream, such as a refusal; '' for a stream. */
  text: string;
}

let nextListen = 0;

/** What a test changes about a listen, to send one the SDK or the relay refuses. */
export interface ListenOptions {
  /** Spaces put inside the body, making it this many bytes larger. */
  pad?: number;
  /** In place of the usual params, notifications and _meta included. */
  params?: Record<string, unknown>;
  /** false sends it without an id, as a notification. */
  id?: false;
  /** Over the usual headers, such as another Content-Type. */
  headers?: Record<string, string>;
}

/**
 * A 2026-07-28 subscriptions/listen, as the SDK client sends it, held open
 * until close(); an answer that is not a stream is read whole into `text`.
 */
export async function openListen(
  relay: Relay,
  user: DevTokenUser,
  options: ListenOptions = {},
): Promise<OpenListen> {
  nextListen += 1;
  const abort = new AbortController();
  const message = {
    jsonrpc: '2.0',
    ...(options.id === false ? {} : { id: `listen:${String(nextListen)}` }),
    method: 'subscriptions/listen',
    params: options.params ?? {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'raw-listen', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
      notifications: { toolsListChanged: true },
    },
  };
  const json = JSON.stringify(message);
  const body = options.pad === undefined ? json : `${json.slice(0, -1)}${' '.repeat(options.pad)}}`;
  const response = await fetch(relay.mcpUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Method': 'subscriptions/listen',
      'Mcp-Protocol-Version': '2026-07-28',
      ...options.headers,
    },
    body,
    signal: abort.signal,
  });
  const streaming = (response.headers.get('content-type') ?? '').startsWith('text/event-stream');
  if (!streaming) {
    const text = await response.text();
    return { status: response.status, streaming, text, ended: Promise.resolve(), close: () => {} };
  }
  const reader = response.body?.getReader();
  const ended = (async () => {
    if (!reader) return;
    try {
      while (!(await reader.read()).done) {
        // The acknowledgement and keep-alive comments only.
      }
    } catch {
      // Ended by close().
    }
  })();
  return {
    status: response.status,
    streaming,
    text: '',
    ended,
    close: () => {
      abort.abort();
    },
  };
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

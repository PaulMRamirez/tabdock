// JSON-RPC exchanges with /mcp by hand, on either leg, read back exactly as
// they crossed the wire: the golden test of the fixed tools and the
// first-class tests compare what a client receives, before any SDK client
// normalises it. A 2025-era exchange runs on a session opened with
// openSession (raw-mcp.ts); a 2026-07-28 one carries the envelope the SDK
// client sends, with the headers it sends beside it.

import type { DevTokenUser, Relay } from '../../src/index.ts';

export const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';

/** What came back: the HTTP status and the JSON-RPC message answering the request, if any. */
export interface WireAnswer {
  status: number;
  /** The JSON-RPC response whose id matches, or null when none came (a refusal without one, say). */
  message: {
    id?: unknown;
    result?: Record<string, unknown>;
    error?: Record<string, unknown>;
  } | null;
  /** The whole body, for a refusal's words. */
  body: string;
}

let nextId = 5000;

/** The JSON-RPC message with this id in a JSON body or among an event stream's data lines. */
function answerOf(body: string, id: number): WireAnswer['message'] {
  const candidates: unknown[] = [];
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      candidates.push(JSON.parse(trimmed));
    } catch {
      // Not JSON after all; read it as an event stream.
    }
  }
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      candidates.push(JSON.parse(line.slice(6)));
    } catch {
      // A data line that is not JSON belongs to no answer.
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const message = candidate as NonNullable<WireAnswer['message']>;
    if (message.id === id) return message;
  }
  return null;
}

export interface ModernOptions {
  /** The client's name in the envelope. */
  client?: string;
  /** Capabilities declared in the envelope. */
  capabilities?: Record<string, unknown>;
  /** Headers over the usual ones, an Origin for instance. */
  headers?: Record<string, string>;
  /** The envelope's protocol version, and the header's, when not 2026-07-28. */
  version?: string;
}

/** One 2026-07-28 request, as the SDK client sends it. */
export async function modernExchange(
  relay: Relay,
  user: DevTokenUser,
  method: string,
  params: Record<string, unknown> = {},
  options: ModernOptions = {},
): Promise<WireAnswer> {
  nextId += 1;
  const id = nextId;
  const version = options.version ?? MODERN;
  const meta = {
    'io.modelcontextprotocol/protocolVersion': version,
    'io.modelcontextprotocol/clientInfo': { name: options.client ?? 'wire-test', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': options.capabilities ?? {},
  };
  const name = typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {};
  const response = await fetch(relay.mcpUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Protocol-Version': version,
      'Mcp-Method': method,
      ...name,
      ...options.headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } }),
  });
  const body = await response.text();
  return { status: response.status, message: answerOf(body, id), body };
}

/** One request on a 2025-era session opened with openSession. */
export async function legacyExchange(
  relay: Relay,
  user: DevTokenUser,
  sessionId: string,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<WireAnswer> {
  nextId += 1;
  const id = nextId;
  const response = await fetch(relay.mcpUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId,
      'Mcp-Protocol-Version': LEGACY,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const body = await response.text();
  return { status: response.status, message: answerOf(body, id), body };
}

/** A 2025-era initialize, its answer read whole; the session it opened, if any, is left open. */
export async function legacyInitialize(
  relay: Relay,
  user: DevTokenUser,
  capabilities: Record<string, unknown> = {},
  client = 'wire-test',
): Promise<WireAnswer & { sessionId: string | null }> {
  nextId += 1;
  const id = nextId;
  const response = await fetch(relay.mcpUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: LEGACY,
        capabilities,
        clientInfo: { name: client, version: '1.0.0' },
      },
    }),
  });
  const body = await response.text();
  const sessionId = response.headers.get('mcp-session-id');
  if (sessionId !== null) {
    const ack = await fetch(relay.mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${user.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': sessionId,
        'Mcp-Protocol-Version': LEGACY,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    await ack.text();
  }
  return { status: response.status, message: answerOf(body, id), body, sessionId };
}

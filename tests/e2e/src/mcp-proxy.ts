// A loopback proxy in front of a relay's /mcp, for the checks of ADR 0027
// that need to see or change what crosses the wire without touching the
// relay: the client matrix and the Claude Code check record each request as
// it arrives (a relay holds back a GET stream's headers until its first
// bytes, so a proxy that records on the answer misses the GET), and the
// conformance run adds the bearer header the suite cannot send (its server
// mode takes no header, and the relay never takes a token in a URL, S11).
//
// It copies bytes, never MCP messages: the request goes up as it came, raw
// header lines and all, so a foreign Host or Origin, or two Origin lines,
// reach the relay exactly as the client wrote them and the suite's rebinding
// scenario tests the relay itself; only hop-by-hop headers are dropped, and
// with a bearer configured the client's own Authorization is replaced. The
// suite's rebinding probe sends a foreign Host and a foreign Origin together,
// so either of the relay's guards alone would refuse it; `soleGuard` leaves
// one guard to refuse it alone, by sending the relay's own Host in place of
// the client's or by dropping every Origin line, so a run through each fails
// when that guard is lost. It logs nothing, anywhere: what it
// records stays in memory for the caller, and a record never holds a token,
// a session id or a tool's arguments. It does hold the name a tools/call
// asks for and the names a tools/list answer gives, which the relay's own
// audit records too, so a check can tell which route a client took.

import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request as httpRequest,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

/** Headers that belong to one connection and are never forwarded (RFC 9110 section 7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** The most of a body read for the record; the rest still goes through untouched. */
const MAX_RECORDED_BODY_BYTES = 256 * 1024;

/** One JSON-RPC message of a recorded request: what a revision check needs, nothing more. */
export interface RecordedMessage {
  method: string | null;
  /** Whether it carried an id, so a request rather than a notification or a response. */
  request: boolean;
  /** `initialize`'s protocolVersion, or the 2026-07-28 envelope's. */
  version: string | null;
  /** The client's name, from `initialize` or the envelope. */
  client: string | null;
  /** The tool a tools/call names, and never its arguments; null for any other message. */
  tool: string | null;
}

/** What one JSON-RPC response on an answer said: a result, a tool's error result, or an error. */
export type AnswerOutcome = 'result' | 'tool-error' | 'error';

export interface RecordedRequest {
  /** The order requests arrived in, from 1. */
  seq: number;
  method: string;
  /** The MCP-Protocol-Version header, as sent. */
  versionHeader: string | null;
  /** The Mcp-Method header, as sent. */
  methodHeader: string | null;
  /** Which session the request named, as a label (s1, s2, ...) and never the id itself. */
  session: string | null;
  /** Whether it carried an Origin header. */
  origin: boolean;
  messages: RecordedMessage[];
  /** The answer's status, once its head came back. */
  status: number | null;
  /** The session the answer opened, as a label, when it named one. */
  openedSession: string | null;
  /** Notification methods heard on the answer's body, in order. */
  heard: string[];
  /** The protocolVersion an answer's result named: `initialize`'s negotiated revision. */
  negotiated: string | null;
  /** The tool names a tools/list result on the answer gave, in order. */
  listed: string[];
  /** Each JSON-RPC response heard on the answer, in order. */
  outcomes: AnswerOutcome[];
}

export interface McpProxy {
  /** The proxy's /mcp URL, on 127.0.0.1. */
  url: string;
  /** Everything recorded so far, in the order requests arrived; empty unless `record` was set. */
  requests(): RecordedRequest[];
  close(): Promise<void>;
}

export interface McpProxyOptions {
  /** The relay's origin, such as http://127.0.0.1:8787; every request goes there. */
  upstream: string;
  /** A bearer token to send on every request in place of the client's own; never recorded. */
  bearer?: string;
  /** Record each request as it arrives. */
  record?: boolean;
  /**
   * Which of the relay's rebinding guards a request must meet alone: 'origin'
   * sends every request with the relay's own Host, so only the Origin check
   * can refuse a foreign Origin; 'host' drops every Origin line, so only the
   * Host checks (the allowlist and, without a public URL, the rule that a
   * request was made on this machine) can refuse a foreign Host.
   */
  soleGuard?: 'origin' | 'host';
}

function firstHeader(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function stringAt(value: unknown, ...path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : null;
}

function parsedAll(texts: string[]): unknown[] {
  const messages: unknown[] = [];
  for (const text of texts) {
    try {
      const parsed = JSON.parse(text) as unknown;
      messages.push(...(Array.isArray(parsed) ? (parsed as unknown[]) : [parsed]));
    } catch {
      // Not JSON: nothing a revision check reads.
    }
  }
  return messages.filter((message) => typeof message === 'object' && message !== null);
}

/** The parts of each JSON-RPC message a revision check reads; never params beyond them. */
function messagesOf(body: string): RecordedMessage[] {
  return parsedAll([body]).map((message) => {
    const method = stringAt(message, 'method');
    const request = (message as Record<string, unknown>).id !== undefined;
    const version =
      (method === 'initialize' ? stringAt(message, 'params', 'protocolVersion') : null) ??
      stringAt(message, 'params', '_meta', 'io.modelcontextprotocol/protocolVersion');
    const client =
      (method === 'initialize' ? stringAt(message, 'params', 'clientInfo', 'name') : null) ??
      stringAt(message, 'params', '_meta', 'io.modelcontextprotocol/clientInfo', 'name');
    const tool = method === 'tools/call' ? stringAt(message, 'params', 'name') : null;
    return { method, request, version, client, tool };
  });
}

/** The names of a tools/list result's tools, or none for any other message. */
function listedNames(message: unknown): string[] {
  const tools = (message as { result?: { tools?: unknown } }).result?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    const name = stringAt(tool, 'name');
    return name === null ? [] : [name];
  });
}

/** What a JSON-RPC response said, or null for a message that is not one. */
function outcomeOf(message: unknown): AnswerOutcome | null {
  const fields = message as Record<string, unknown>;
  if (fields.id === undefined || typeof fields.method === 'string') return null;
  if (fields.error !== undefined) return 'error';
  const result = fields.result as { isError?: unknown } | undefined;
  return result?.isError === true ? 'tool-error' : 'result';
}

/** The raw header lines of a message, without hop-by-hop ones and those `drop` names. */
function forwardable(raw: string[], drop: ReadonlySet<string> = new Set()): string[] {
  const kept: string[] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index] ?? '';
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || drop.has(lower)) continue;
    kept.push(name, raw[index + 1] ?? '');
  }
  return kept;
}

export async function startMcpProxy(options: McpProxyOptions): Promise<McpProxy> {
  const upstream = new URL(options.upstream);
  const recorded: RecordedRequest[] = [];
  let arrived = 0;
  const sessions = new Map<string, string>();
  const label = (id: string | null): string | null => {
    if (id === null) return null;
    let known = sessions.get(id);
    if (known === undefined) {
      known = `s${String(sessions.size + 1)}`;
      sessions.set(id, known);
    }
    return known;
  };
  const dropped = new Set<string>();
  if (options.bearer !== undefined) dropped.add('authorization');
  if (options.soleGuard === 'origin') dropped.add('host');
  if (options.soleGuard === 'host') dropped.add('origin');

  /** Reads an answer's JSON-RPC messages into its record as they pass, an event stream a line at a time. */
  const readAnswer = (answer: IncomingMessage, entry: RecordedRequest): void => {
    entry.status = answer.statusCode ?? null;
    entry.openedSession = label(firstHeader(answer.headers, 'mcp-session-id'));
    const stream = (answer.headers['content-type'] ?? '').startsWith('text/event-stream');
    let pending = '';
    let read = 0;
    const take = (texts: string[]): void => {
      for (const message of parsedAll(texts)) {
        const method = stringAt(message, 'method');
        if (method !== null && (message as Record<string, unknown>).id === undefined) {
          entry.heard.push(method);
        }
        entry.negotiated = stringAt(message, 'result', 'protocolVersion') ?? entry.negotiated;
        entry.listed.push(...listedNames(message));
        const outcome = outcomeOf(message);
        if (outcome !== null) entry.outcomes.push(outcome);
      }
    };
    answer.on('data', (chunk: Buffer) => {
      read += chunk.length;
      if (!stream) {
        if (read <= MAX_RECORDED_BODY_BYTES) pending += chunk.toString('utf8');
        return;
      }
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = (lines.pop() ?? '').slice(-MAX_RECORDED_BODY_BYTES);
      take(lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5)));
    });
    answer.on('end', () => {
      if (!stream) take([pending]);
    });
  };

  const handle = (incoming: IncomingMessage, outgoing: ServerResponse): void => {
    const headers = forwardable(incoming.rawHeaders, dropped);
    if (options.soleGuard === 'origin') headers.unshift('Host', upstream.host);
    if (options.bearer !== undefined) headers.push('Authorization', `Bearer ${options.bearer}`);
    const entry: RecordedRequest | null =
      options.record === true
        ? {
            seq: (arrived += 1),
            method: incoming.method ?? 'GET',
            versionHeader: firstHeader(incoming.headers, 'mcp-protocol-version'),
            methodHeader: firstHeader(incoming.headers, 'mcp-method'),
            session: label(firstHeader(incoming.headers, 'mcp-session-id')),
            origin: incoming.headers.origin !== undefined,
            messages: [],
            status: null,
            openedSession: null,
            heard: [],
            negotiated: null,
            listed: [],
            outcomes: [],
          }
        : null;
    const up = httpRequest({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port,
      method: incoming.method,
      path: incoming.url,
      // An array keeps every header line as the client wrote it, Host included,
      // and stops Node adding a Host of its own.
      headers,
    });
    up.on('response', (answer) => {
      if (entry !== null) readAnswer(answer, entry);
      outgoing.writeHead(answer.statusCode ?? 502, forwardable(answer.rawHeaders));
      // Each chunk goes on as it comes, so an event stream reaches the client unbuffered.
      outgoing.flushHeaders();
      answer.pipe(outgoing);
      answer.on('error', () => outgoing.destroy());
    });
    up.on('error', () => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502, { 'Content-Type': 'text/plain' });
        outgoing.end('proxy: the relay did not answer');
      } else {
        outgoing.destroy();
      }
    });
    // A client that goes takes its request to the relay with it, as a direct connection would.
    outgoing.on('close', () => {
      if (!outgoing.writableFinished) up.destroy();
    });
    let body = '';
    incoming.on('data', (chunk: Buffer) => {
      if (entry !== null && body.length < MAX_RECORDED_BODY_BYTES) body += chunk.toString('utf8');
    });
    // Recorded once the request has wholly arrived, before any answer, as a client sent it.
    incoming.on('end', () => {
      if (entry === null) return;
      entry.messages = messagesOf(body);
      recorded.push(entry);
    });
    incoming.pipe(up);
  };

  const server = createServer(handle);
  // An event stream may stay quiet far longer than Node's defaults allow.
  server.requestTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    requests: () =>
      recorded
        .map((entry) => ({
          ...entry,
          heard: [...entry.heard],
          listed: [...entry.listed],
          outcomes: [...entry.outcomes],
        }))
        .sort((one, other) => one.seq - other.seq),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

// One node:http server for everything: /page upgrades to the page link through
// `ws`, /mcp goes through the official MCP SDK, /healthz answers ok, and the
// auth plugin may add GET routes such as its metadata document. Checks run
// before any protocol code sees a request: origin, subprotocol and the socket
// limits for pages (S1, S2, S9), Host and the auth plugin for MCP clients, so
// every unauthenticated /mcp request gets the plugin's challenge before either
// leg runs. Before all of them, a Host header that is not a host and optional
// port (RFC 9110) makes the request a 400, and an allowlist matches a Host
// only as written, never as the URL parser would rewrite it. /mcp has two legs
// behind those checks, composed as the SDK documents (ADR 0009): 2025-era
// traffic goes to the sessionful leg in sessions.ts, everything else to a
// strict 2026-07-28 handler, whose subscriptions/listen streams pass the
// relay's own bounds first (listen-streams.ts). In public URL mode (ADR 0014)
// the public host passes the Host check for /mcp and the QR flow at /pair
// (pair.ts) is served behind the same check, while /page still takes only
// requests made on this machine. Without a public URL, in local mode (ADR 0022) and with dev tokens
// alike, /mcp and /page take only requests made on this machine, so a tunnel
// pointed at a loopback relay, even one that rewrites Host, cannot expose it.
// Those checks trust a Host header any program can write, so they hold only
// while the relay listens on loopback: it resolves its host name itself and
// listens on the address only when that is loopback (S12). Hosted mode (ADR
// 0018) is the one exception: in production behind a host edge that
// terminates TLS and names the client in one configured header, the relay may
// bind 0.0.0.0, /page takes upgrades for the public host alone (the edge's
// forwarding headers are expected there), and the Host allowlist still guards
// /mcp, /pair and the plugin's routes, so the platform's own name for the app
// gets 403 everywhere but /healthz. Requests are logged by route, never by raw
// path or query, so no secret a URL carries reaches a log, and a line a
// signed-in client can cause at will on /mcp is written once per kind a window,
// the rest counted (repeated-lines.ts, A4.3), as is each /page upgrade refused,
// within its address's budget (hub.ts). Every 2026-07-28 request spends the
// caller's request budget once, and an /mcp response its client leaves unread
// is cut off once it stops moving (response-stalls.ts, ADRs 0030 and 0032).
// The client address that /page and /pair count by, and that /mcp's refusal
// line names, comes from one place (client-address.ts), which answers 400 on
// a route that counts by address when a host edge names no client (ADR 0018).
// With an audit directory (production, local mode, or TABDOCK_AUDIT_DIR) the
// audit log is a FileAuditLog there, bracketed by relay_start and relay_stop
// records so a restart shows as a gap (ADR 0019); production refuses to start
// without one, or if relay_start does not reach the disk. The plugin says who
// someone is and the relay decides whether an invitee may in (ADR 0020). The
// M3 spike's measurements (spike.ts) hook in here when TABDOCK_SPIKE is on;
// nothing over HTTP controls them.

import { lookup } from 'node:dns/promises';
import { createServer, type IncomingMessage, type ServerResponse, STATUS_CODES } from 'node:http';
import { type AddressInfo, isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import { type NodeIncomingMessageLike, toNodeHandler } from '@modelcontextprotocol/node';
import {
  type AuthInfo,
  createMcpHandler,
  isJSONRPCRequest,
  isJsonContentType,
  isLegacyRequest,
  isSpecType,
  type McpHandlerRequestOptions,
  type McpHttpHandler,
  ProtocolErrorCode,
  readRequestBody,
} from '@modelcontextprotocol/server';
import {
  AUDIT_VERSION,
  type AuditCallEvent,
  type AuditEvent,
  InviteeIdSchema,
  MAX_FRAME_BYTES,
  SUBPROTOCOL,
} from '@tabdock/protocol';
import { WebSocketServer } from 'ws';
import { FileAuditLog } from './audit-file.ts';
import { createAuthRefusalLog } from './auth-log.ts';
import {
  type AuthOutcome,
  AuthOutcomeSchema,
  type AuthRefusal,
  type AuthRoute,
  notAllowedRefusal,
} from './auth.ts';
import { createClientAddresses, loggedAddress } from './client-address.ts';
import {
  HOSTED_WILDCARD_HOST,
  isLoopbackAddress,
  LOOPBACK_HOSTNAMES,
  NO_ORIGIN,
  parseHostHeader,
  type RelayOptions,
  type ResolvedConfig,
  resolveConfig,
} from './config.ts';
import { parseFirstClassName } from './first-class.ts';
import { EMPTY_FIRST_CLASS, PageHub } from './hub.ts';
import { ListenStreams } from './listen-streams.ts';
import { createLogger, type Logger } from './log.ts';
import {
  type AuthExtra,
  AuthExtraSchema,
  BUDGET_CODE,
  createClientLines,
  createMcpFactory,
  createRequestBudget,
  envelopeOf,
  FIXED_TOOL_NAMES,
  RELAY_VERSION,
  userIdOf,
} from './mcp.ts';
import { PageToolNotifier } from './page-tool-notifier.ts';
import { createPairFlow, PAIR_ROUTES, type PairFlow } from './pair.ts';
import { createRepeatedLog, errorKind } from './repeated-lines.ts';
import { requestHeapBytes } from './request-heap.ts';
import { inSlices, ResponseStalls } from './response-stalls.ts';
import { type InviteeSessionOptions, McpSessions } from './sessions.ts';
import { createSignInGate } from './sign-in-gate.ts';
import { Spike, type SpikeControl } from './spike.ts';
import { type AuditLog, callRecords, createMemoryStore, recordAudit } from './store.ts';

export interface Relay {
  /** http://127.0.0.1:<port> */
  readonly url: string;
  /** ws://127.0.0.1:<port>/page */
  readonly pageUrl: string;
  /** http://127.0.0.1:<port>/mcp */
  readonly mcpUrl: string;
  /** The public origin in public URL mode, else null. */
  readonly publicUrl: string | null;
  /** `<publicUrl>/mcp`, the connector URL, in public URL mode; else null. */
  readonly publicMcpUrl: string | null;
  /** The newest audit records: records() its calls, as before ADR 0019, and events() every type. */
  readonly audit: { records(): AuditCallEvent[]; events(): AuditEvent[] };
  /**
   * The spike's marker control while TABDOCK_SPIKE is on, else null. Reached
   * from the relay's own process only (main.ts reads it from stdin).
   */
  readonly spike: SpikeControl | null;
  close(): Promise<void>;
}

/**
 * Whether a request's Host header, if it has one, is no host at all, or is
 * one of several. Such a request is malformed (400, RFC 9112 section 3.2)
 * before any route or allowlist reads its Host: Node keeps only the first of
 * several Host lines, while a proxy in front may have routed on another. A
 * missing Host is left to the checks that need one, which refuse it.
 */
function malformedHost(request: IncomingMessage): boolean {
  let lines = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === 'host') lines += 1;
  }
  if (lines > 1) return true;
  const host = request.headers.host;
  return host !== undefined && parseHostHeader(host) === null;
}

/**
 * Whether an upgrade names the public host, exactly as written but for case
 * and port: in hosted mode the only Host a page reaches the relay by through
 * the edge (ADR 0018).
 */
function forPublicHost(request: IncomingMessage, config: ResolvedConfig): boolean {
  if (config.publicUrl === null || request.headers.host === undefined) return false;
  return parseHostHeader(request.headers.host) === new URL(config.publicUrl).hostname;
}

/**
 * Whether a request was made on this machine rather than through a tunnel or
 * proxy. The Host must be a loopback name exactly as written, and no proxy
 * header may be present: a tunnel told to rewrite Host still adds
 * X-Forwarded-For, while a browser's WebSocket can set neither. Every /page
 * upgrade must pass it (ADR 0014), and so must every /mcp request on a relay
 * without a public URL (ADR 0022).
 */
function madeLocally(request: IncomingMessage): boolean {
  const host = request.headers.host === undefined ? null : parseHostHeader(request.headers.host);
  if (host === null || !LOOPBACK_HOSTNAMES.includes(host)) return false;
  return !Object.keys(request.headers).some(
    (name) => name === 'forwarded' || name.startsWith('x-forwarded-'),
  );
}

/**
 * What kind of error reached a catch-all, for a log line that leaves out its
 * message: a library's message may quote the request URL with its query.
 */
function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * MCP bodies above this are refused before parsing. A page link frame is at
 * most MAX_FRAME_BYTES, so a call cannot usefully carry more than about that.
 */
const MAX_MCP_BODY_BYTES = 2 * MAX_FRAME_BYTES;

/**
 * A subscriptions/listen body above this is refused before it costs anything.
 * A real one is about 300 bytes; a stream lives as long as its client keeps
 * it, and whatever the request carried may stay with it (A4.3).
 */
const MAX_LISTEN_BODY_BYTES = 16 * 1024;

/** A JSON-RPC error answer, shaped as the SDK shapes its own. */
function jsonRpcError(status: number, code: number, message: string, id: unknown = null): Response {
  const echoed = typeof id === 'string' || typeof id === 'number' ? id : null;
  return Response.json({ jsonrpc: '2.0', error: { code, message }, id: echoed }, { status });
}

/** The SDK's own words for a body over a limit, so either answer reads the same. */
function tooLarge(limit: number, id: unknown = null): Response {
  return jsonRpcError(
    413,
    -32000,
    `Payload Too Large: Request body must not exceed ${String(limit)} bytes`,
    id,
  );
}

/**
 * A 2026-07-28 request's body, read once, here, so the SDK is handed the
 * parsed value and never reads or copies the request again: 'unread' when
 * the SDK should answer from the request itself (no POST, or a Content-Type
 * it refuses before reading anything), 'answered' when the body is over the
 * cap or not JSON.
 */
type ModernBody =
  | { kind: 'unread' }
  | { kind: 'answered'; response: Response }
  | { kind: 'parsed'; message: unknown; bytes: number };

async function readModernBody(request: Request): Promise<ModernBody> {
  if (request.method !== 'POST' || !isJsonContentType(request.headers.get('content-type'))) {
    return { kind: 'unread' };
  }
  let read: Awaited<ReturnType<typeof readRequestBody>>;
  try {
    read = await readRequestBody(request, MAX_MCP_BODY_BYTES);
  } catch {
    // A body that failed midway: the SDK's own read fails the same way and answers it.
    return { kind: 'unread' };
  }
  if (read.tooLarge) {
    // The rest is never wanted; cancelled, it holds nothing while the answer goes out.
    await request.body?.cancel().catch(() => undefined);
    return { kind: 'answered', response: tooLarge(MAX_MCP_BODY_BYTES) };
  }
  try {
    return {
      kind: 'parsed',
      message: JSON.parse(read.text) as unknown,
      bytes: Buffer.byteLength(read.text),
    };
  } catch {
    // isLegacyRequest sends a body that is not JSON to the 2025-era leg, so this is only defence.
    return {
      kind: 'answered',
      response: jsonRpcError(400, -32700, 'Parse error: the request body is not valid JSON'),
    };
  }
}

/**
 * A 2026-07-28 message that spends a request of its caller's budget as it
 * arrives, before the SDK sees it (S9, ADRs 0030 and 0032): every JSON-RPC
 * request but a subscriptions/listen, which spends in listen-streams.ts.
 * tools/call is no exception, so neither a name the relay does not serve nor
 * params the SDK refuses before any tool runs, a requestState that is not a
 * string for one, make a request free, whatever checks the SDK makes there.
 * `toolAnswers` says whether one past the budget still goes on, to be
 * refused in the dispatcher with its audit record: a tools/call the SDK's
 * own schema takes, whose requestState the SDK will not refuse first, naming
 * one of the five fixed tools, refused in that tool's own words as in M4,
 * or, while first-class tools are on, a first-class name, refused as
 * call_page_tool is, so both routes answer and record a call past the budget
 * alike (SPEC section 7, ADR 0025's notes). relay.ts answers any other
 * request past the budget itself. A notification carries no request, and a
 * batch, a response or anything else that is not one request spends only if
 * the SDK refuses it (refusedBySdk).
 */
function arrivalOf(
  message: unknown,
  firstClassTools: boolean,
): { id: string | number; toolAnswers: boolean } | null {
  if (!isJSONRPCRequest(message)) return null;
  if (message.method === 'subscriptions/listen') return null;
  return { id: message.id, toolAnswers: answeredInTool(message, firstClassTools) };
}

/** Whether the SDK hands this request to the dispatcher for a fixed tool or a first-class name. */
function answeredInTool(message: unknown, firstClassTools: boolean): boolean {
  if (!isSpecType.CallToolRequest(message)) return false;
  // The SDK refuses a present requestState that is not a string before any handler runs.
  const state: unknown = (message.params as { requestState?: unknown }).requestState;
  if (state !== undefined && typeof state !== 'string') return false;
  const { name } = message.params;
  return FIXED_TOOL_NAMES.has(name) || (firstClassTools && parseFirstClassName(name) !== null);
}

/** A subscriptions/listen request's JSON-RPC id, or null for any other message. */
function listenOf(message: unknown): { id: unknown } | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null;
  const fields = message as Record<string, unknown>;
  return fields.method === 'subscriptions/listen' ? { id: fields.id } : null;
}

/**
 * Whether the 2026-07-28 handler refused a request before any tool ran: a
 * 4xx, from its validation ladder, its body checks or its Content-Type check.
 * 499 is the SDK's own word for a client gone mid-call, whose tool already
 * counted it.
 */
function refusedBySdk(response: Response): boolean {
  return response.status >= 400 && response.status < 500 && response.status !== 499;
}

/**
 * Every revision /mcp serves, newest first (ADR 0027): 2026-07-28 on the
 * strict leg, the 2025 revisions on a session, and 2024-11-05 as best effort.
 */
export const SERVED_REVISIONS: readonly string[] = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

/**
 * The strict leg's answer to a revision it does not serve, with every
 * revision /mcp serves in its data.supported, as 2026-07-28 says a server
 * MUST list them (ADR 0027): the SDK fills the list from the strict leg's
 * own revisions, and the endpoint serves the 2025 ones too. Nothing else in
 * the answer changes, and any other answer passes untouched. If a later SDK
 * lists them all itself, this goes.
 */
async function withServedRevisions(response: Response): Promise<Response> {
  if (response.status !== 400) return response;
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) return response;
  const body = await response.text();
  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    return new Response(body, response);
  }
  const error =
    typeof message === 'object' && message !== null
      ? (message as Record<string, unknown>).error
      : undefined;
  if (
    typeof error !== 'object' ||
    error === null ||
    (error as Record<string, unknown>).code !== ProtocolErrorCode.UnsupportedProtocolVersion
  ) {
    return new Response(body, response);
  }
  const fields = error as Record<string, unknown>;
  const data =
    typeof fields.data === 'object' && fields.data !== null
      ? (fields.data as Record<string, unknown>)
      : {};
  fields.data = { ...data, supported: [...SERVED_REVISIONS] };
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify(message), { status: response.status, headers });
}

/** The allowlist's refusal of an Origin, in the shape of the SDK's own guard (ADR 0027). */
const ORIGIN_REFUSAL = JSON.stringify({
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Invalid Origin' },
  id: null,
});

/** Paths the relay answers whatever its mode; any other is logged as OTHER_ROUTE. */
const FIXED_ROUTES: readonly string[] = ['/healthz', '/mcp', '/page', ...PAIR_ROUTES];
const OTHER_ROUTE = '(other)';

function pathOf(rawUrl: string | undefined): string | null {
  const raw = rawUrl ?? '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  return URL.parse(raw, 'http://relay.invalid')?.pathname ?? null;
}

function offeredProtocols(header: string | undefined): string[] {
  return (header ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Answers an upgrade we refuse, on the raw socket, before ws ever sees it. */
function refuseUpgrade(socket: Duplex, status: number, message: string): void {
  socket.on('error', () => {
    // The peer may already be gone; there is nothing left to tell it.
  });
  socket.end(
    `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? ''}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${String(Buffer.byteLength(message))}\r\n\r\n${message}`,
  );
}

function send(
  response: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(response.req.method === 'HEAD' ? undefined : body);
}

function formatHost(address: string): string {
  return address.includes(':') ? `[${address}]` : address;
}

/**
 * The literal address to listen on. resolveConfig judged only a name, and
 * localhost means whatever the hosts file or resolver says: one that maps it
 * elsewhere, or a search domain added to a lookup that found no hosts entry,
 * would put a loopback relay, local mode's above all, on the network, where
 * any client can send the Host and headers madeLocally and validateHost look
 * for. So the name is resolved once here, every address it gives must be
 * loopback, and the relay listens on that literal, never on the name, which a
 * second lookup could answer differently (S12, ADR 0022).
 */
async function listenAddress(config: ResolvedConfig): Promise<string> {
  const host = config.host.replace(/^\[(.*)\]$/, '$1');
  const addresses =
    isIP(host) === 0 ? (await lookup(host, { all: true })).map((entry) => entry.address) : [host];
  const offLoopback = addresses.find((address) => !isLoopbackAddress(address));
  if (config.loopback && offLoopback !== undefined) {
    throw new Error(
      `refusing to listen on ${offLoopback}: the host ${config.host} (TABDOCK_HOST) resolves there, and the relay listens only on loopback (SPEC S12, ADR 0022); fix the hosts file or resolver, or set TABDOCK_HOST to 127.0.0.1 or ::1`,
    );
  }
  const [first] = addresses;
  if (first === undefined) throw new Error(`the host ${config.host} (TABDOCK_HOST) has no address`);
  return first;
}

/**
 * The persistent audit log the configuration asks for, or null for the memory
 * ring. Production must keep one (S7, ADR 0019): a relay that cannot write
 * its audit directory refuses to start rather than serve unrecorded.
 */
function openAudit(
  config: ResolvedConfig,
  options: RelayOptions,
  log: Logger,
): FileAuditLog | null {
  const { dir, retentionDays, maxBytes } = config.audit;
  if (dir !== null && options.store !== undefined) {
    throw new Error(
      'give the relay an audit directory (TABDOCK_AUDIT_DIR) or a store of its own, not both',
    );
  }
  if (dir === null) {
    if (config.env === 'production' && options.store === undefined) {
      throw new Error(
        'production keeps a persistent audit log: set TABDOCK_AUDIT_DIR to an absolute directory, on a host its persistent volume (SPEC S7, ADR 0019)',
      );
    }
    return null;
  }
  return FileAuditLog.open({ dir, retentionDays, maxBytes, log });
}

export async function createRelay(options: RelayOptions): Promise<Relay> {
  const config = resolveConfig(options);
  const log = createLogger({
    ...(options.logSink ? { sink: options.logSink } : {}),
    ...(options.logLevel ? { level: options.logLevel } : {}),
  });
  const auth = options.auth;
  // Before the plugin starts, so a directory the relay cannot use sets nothing going.
  const fileAudit = openAudit(config, options, log);
  // Then, before anything else exists: a plugin that cannot work (an identity
  // provider Claude could not sign in with, say) stops the relay from starting.
  try {
    await auth.start?.({ log });
  } catch (error) {
    // Anything it set going before it threw, such as a timer, stops with it.
    auth.stop?.();
    await fileAudit?.close();
    throw error;
  }
  const store = options.store ?? createMemoryStore(fileAudit ? { audit: fileAudit } : {});
  // Only a log that outlives the process marks its starts and stops; a memory
  // ring forgets everything at a restart anyway.
  if (fileAudit !== null) {
    recordAudit(fileAudit, log, {
      v: AUDIT_VERSION,
      type: 'relay_start',
      at: Date.now(),
      version: RELAY_VERSION,
      env: config.env,
      mode: config.mode,
      invites: config.invites,
    });
    // Production serves no one until its first record is on disk (ADR 0019).
    if (!fileAudit.sync() && config.env === 'production') {
      await fileAudit.close();
      auth.stop?.();
      throw new Error(
        `production could not write and sync its relay_start record in the audit directory ${fileAudit.dir} (TABDOCK_AUDIT_DIR); refusing to start unrecorded (ADR 0019)`,
      );
    }
  }
  /** relay_stop, then the log closes: after the hub, whose shutdown audits the calls it fails. */
  const closeAudit = async (audit: AuditLog): Promise<void> => {
    if (fileAudit !== null) {
      recordAudit(audit, log, { v: AUDIT_VERSION, type: 'relay_stop', at: Date.now() });
    }
    await audit.close?.();
  };
  const spike = config.spike ? new Spike(log, MAX_MCP_BODY_BYTES) : null;
  const hub = new PageHub(config, store, log, spike);
  const addresses = createClientAddresses(config, log);
  const refusals = createAuthRefusalLog(log);
  let pair: PairFlow | null = null;
  if (config.publicUrl !== null) {
    try {
      // resolveConfig refused public URL mode without either of these.
      if (options.pairClient === undefined || auth.browserSignIn === undefined) {
        throw new Error('public URL mode needs the /pair sign-in client and a provider plugin');
      }
      pair = createPairFlow({
        publicUrl: config.publicUrl,
        client: options.pairClient,
        signIn: auth.browserSignIn,
        hub,
        config,
        log,
        signInGate: createSignInGate(config, log),
      });
    } catch (error) {
      await hub.shutdown();
      await closeAudit(store.audit);
      auth.stop?.();
      throw error;
    }
  }

  // One request budget for the five tools, the listen streams and the
  // 2026-07-28 requests the SDK refuses alike (ADR 0018).
  const budget = createRequestBudget(config);
  // Lines a signed-in client can cause at will on /mcp: one per kind a window, the rest counted (A4.3).
  const mcpLines = createRepeatedLog(log, config.rateLimits.windowMs);
  // Which revision each client speaks, one line per user, client and leg an hour (ADR 0027).
  const clientLines = createClientLines(log);
  // Responses a client leaves unread are cut off once they stop moving (ADR 0030).
  const stalls = new ResponseStalls({ lines: mcpLines });
  // What each /mcp request's body holds on the heap, measured before either
  // leg reads it, so a call or pairing that waits on a page is charged it
  // (request-heap.ts, ADR 0018's notes). Keyed by the request's own auth
  // object, which handleMcp makes once per request and the SDK hands each
  // tool handler as ctx.http.authInfo.
  const heldBytes = new WeakMap<AuthInfo, number>();
  // Whether each 2026-07-28 request spent its budget as it arrived, under the
  // same key, so the dispatcher neither spends again nor serves one past it.
  const paidOnArrival = new WeakMap<AuthInfo, boolean>();
  const refusedLine = (userId: string): void => {
    mcpLines.write('warn', 'mcp request refused: past the request budget', { userId });
  };
  const factory = createMcpFactory(hub, config, {
    spike,
    budget,
    heldBytesOf: (authInfo) => (authInfo === undefined ? 0 : (heldBytes.get(authInfo) ?? 0)),
    paidOnArrival: (authInfo) => (authInfo === undefined ? undefined : paidOnArrival.get(authInfo)),
    refusedLine,
    clientLines,
  });
  /**
   * A strict 2026-07-28 handler. One serves every request but a listen; each
   * user's listens get one of their own (listen-streams.ts, ADR 0025). The
   * relay's own caps for listen streams refuse first: a stream marked to
   * give way stays open until the SDK has served the listen it gives way
   * to, so a handler may hold up to twice the relay's total for a moment,
   * and its cap sits there, above anything the gate lets one user hold; the
   * SDK's default of 1024 would otherwise bind before a larger setting.
   */
  const strictHandler = (): McpHttpHandler =>
    createMcpHandler(factory, {
      legacy: 'reject',
      maxRequestBodySize: MAX_MCP_BODY_BYTES,
      keepAliveMs: config.timings.sseKeepAliveMs,
      maxSubscriptions: 2 * config.limits.sessions,
      onerror: (error) => {
        // Most are refusals of what a client sent, quoting it; redact() cuts the message short.
        mcpLines.write('warn', 'mcp handler error', { error }, errorKind(error));
      },
    });
  const mcp = strictHandler();
  // The invitee tier (ADRs 0016 and 0017), for 2025-era sessions and listen streams alike.
  const invitees: InviteeSessionOptions = {
    pool: config.limits.inviteeSessions,
    perInvitee: config.limits.sessionsPerInvitee,
    isInvitee: (userId) => InviteeIdSchema.safeParse(userId).success,
    holds: (userId) => hub.holds(userId),
  };
  const sessions = new McpSessions({
    createServer: (authInfo, request) => factory({ era: 'legacy', authInfo, requestInfo: request }),
    ownerOf: userIdOf,
    perUser: config.limits.sessionsPerUser,
    total: config.limits.sessions,
    invitees,
    idleMs: config.timings.sessionIdleMs,
    keepAliveMs: config.timings.sseKeepAliveMs,
    maxRequestBodySize: MAX_MCP_BODY_BYTES,
    log,
    lines: mcpLines,
    windowMs: config.rateLimits.windowMs,
  });
  const listens = new ListenStreams({
    perUser: config.limits.sessionsPerUser,
    total: config.limits.sessions,
    invitees,
    budget,
    log,
    lines: mcpLines,
    createHandler: strictHandler,
  });
  // The marker concerns every member, who all list it (spike.ts).
  spike?.setNotifier(() => {
    listens.notifyAll();
    return sessions.notifyAll((userId) => !invitees.isInvitee(userId));
  });
  // A member hears of a change to their own first-class list only, on their
  // own sessions and listen streams, at most once every 10 s and only when
  // the list changed (page-tool-notifier.ts, ADRs 0025 and 0032).
  const notifier = config.firstClassTools
    ? new PageToolNotifier({
        digestOf: (userId) => hub.firstClassList(userId).digest,
        emptyDigest: EMPTY_FIRST_CLASS.digest,
        send: (userId) => {
          sessions.notifyUser(userId);
          listens.notifyUser(userId);
        },
      })
    : null;
  if (notifier !== null) {
    hub.onFirstClassChange((userId) => {
      notifier.changed(userId);
    });
  }
  /**
   * The 2026-07-28 leg (A4.3). The body is read once, here, and the SDK
   * handed the parsed value, so no copy of a body stays queued in the
   * request for as long as a stream it opened lives. A listen over its own
   * cap is refused before it costs anything, and every other listen passes
   * the relay's bounds (listen-streams.ts) to its user's own handler. Every
   * other request spends one request of its caller's budget as it arrives
   * (arrivalOf), tools/call included: each builds a server of its own
   * (createMcpFactory), so 50 tools/list on a budget of 3 all answered in
   * M4, and a tools/call with an unknown name or a requestState that is not
   * a string still passed in M5's first build. Past the budget it is
   * answered 429 in the budget's own words, with no audit record, since it
   * asks nothing of a page, as a refused listen is; only a call that a fixed
   * tool will answer goes on, so that tool refuses it with its record (S7).
   * A body that is not one request and that the SDK refuses reached no tool
   * either, so it spends one then: refusals cost like calls, and a flood of
   * them runs dry. Each request counts once. Each request also names its
   * client for the hour's `mcp client` line, and an answer to a revision the
   * leg does not serve lists every revision /mcp serves (ADR 0027).
   */
  const strictLeg = async (
    request: Request,
    options?: McpHandlerRequestOptions,
  ): Promise<Response> => {
    const extra = AuthExtraSchema.safeParse(options?.authInfo?.extra);
    // Without an authenticated user the SDK's factory refuses the request anyway.
    if (!extra.success) return mcp.fetch(request, options);
    const caller = { userId: extra.data.userId, kind: extra.data.kind };
    const body = await readModernBody(request);
    let response: Response;
    let spent = false;
    if (body.kind === 'unread') {
      response = await mcp.fetch(request, options);
    } else if (body.kind === 'answered') {
      response = body.response;
    } else {
      const envelope = isJSONRPCRequest(body.message) ? envelopeOf(body.message) : null;
      if (envelope !== null) {
        clientLines.write({ userId: caller.userId, leg: 'strict', ...envelope });
      }
      const listen = listenOf(body.message);
      const parsed = { ...options, parsedBody: body.message };
      const arrival = listen === null ? arrivalOf(body.message, config.firstClassTools) : null;
      if (arrival !== null) {
        spent = true;
        const paid = budget.spend(caller.userId, caller.kind);
        if (options?.authInfo !== undefined) paidOnArrival.set(options.authInfo, paid);
        if (!paid && !arrival.toolAnswers) {
          refusedLine(caller.userId);
          return jsonRpcError(429, BUDGET_CODE, budget.refusal(caller.kind), arrival.id);
        }
      }
      if (listen === null) {
        response = await mcp.fetch(request, parsed);
      } else if (body.bytes > MAX_LISTEN_BODY_BYTES) {
        response = tooLarge(MAX_LISTEN_BODY_BYTES, listen.id);
      } else {
        return listens.open(caller, listen.id, request.signal, (own) => own.fetch(request, parsed));
      }
    }
    if (!spent && refusedBySdk(response)) budget.spend(caller.userId, caller.kind);
    return response;
  };
  const modern = async (request: Request, options?: McpHandlerRequestOptions): Promise<Response> =>
    withServedRevisions(await strictLeg(request, options));
  const legs = {
    fetch: async (request: Request, options?: McpHandlerRequestOptions): Promise<Response> => {
      if (request.method === 'POST' && options?.authInfo !== undefined) {
        // A copy, read here and dropped, since each leg reads the request itself.
        // A body that fails midway is charged nothing: the leg's own read fails
        // the same way and answers it before any tool runs.
        const bytes = await request
          .clone()
          .arrayBuffer()
          .catch(() => null);
        const charge = bytes === null ? 0 : requestHeapBytes(new Uint8Array(bytes));
        const { requestBytesPerUser } = config.limits;
        const extra = AuthExtraSchema.safeParse(options.authInfo.extra);
        if (charge > requestBytesPerUser && extra.success) {
          // It could never wait on a page, and neither leg parses it: a body of
          // empty objects holds twenty times its size once parsed. It costs a
          // request of the budget, as any refused before a tool runs does.
          await request.body?.cancel().catch(() => undefined);
          budget.spend(extra.data.userId, extra.data.kind);
          mcpLines.write('info', 'mcp request refused: it would hold more than one user may', {
            userId: extra.data.userId,
          });
          return jsonRpcError(
            413,
            -32000,
            `Payload Too Large: this request would hold ${String(Math.ceil(charge / 1024))} KiB of the relay's memory, more than one user's requests may hold together (${String(requestBytesPerUser / 1024)} KiB)`,
          );
        }
        heldBytes.set(options.authInfo, charge);
      }
      const legacy = await isLegacyRequest(request, undefined, {
        maxRequestBodySize: MAX_MCP_BODY_BYTES,
      });
      const forward = (forwarded: Request): Promise<Response> =>
        legacy ? sessions.handle(forwarded, options?.authInfo) : modern(forwarded, options);
      const userId = userIdOf(options?.authInfo);
      return spike && userId !== null
        ? spike.observe(request, { userId, legacy }, forward)
        : forward(request);
    },
  };
  // Every answer goes to the adapter in slices, so a client reading a large
  // one shows progress as each slice is written (response-stalls.ts, ADR 0032).
  const sliced = {
    fetch: async (request: Request, options?: McpHandlerRequestOptions): Promise<Response> =>
      inSlices(await legs.fetch(request, options)),
  };
  const mcpNode = toNodeHandler(sliced, {
    maxRequestBodySize: MAX_MCP_BODY_BYTES,
    onerror: (error) => {
      // undici's message for a Request it cannot build quotes the URL, query and all.
      const kind = errorClass(error);
      mcpLines.write('error', 'mcp adapter error', { errorClass: kind }, kind);
    },
  });
  /**
   * The DNS rebinding guard: a loopback relay only answers Host names that
   * mean loopback, plus the public host in public URL mode, each exactly as
   * written. The answer keeps the shape of the SDK's own guard.
   */
  const validateHost = (request: IncomingMessage, response: ServerResponse): boolean => {
    const host = request.headers.host === undefined ? null : parseHostHeader(request.headers.host);
    if (host !== null && config.allowedHosts.includes(host)) return true;
    send(
      response,
      403,
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Invalid Host' },
        id: null,
      }),
      { 'Content-Type': 'application/json' },
    );
    return false;
  };
  const authRoutes: ReadonlyMap<string, AuthRoute> = auth.routes ?? new Map();
  const knownRoutes = new Set([...FIXED_ROUTES, ...authRoutes.keys()]);
  /**
   * The name a request is logged under: a route the relay knows, or one word
   * for anything else, so a secret someone puts in a path or query (a nonce
   * in the wrong place, a code in a link) never reaches a log line.
   */
  const routeOf = (path: string | null): string =>
    path !== null && knownRoutes.has(path) ? path : OTHER_ROUTE;

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
    // The hub answers WebSocket pings itself, within what it holds for a page
    // that is not reading; ws would queue a pong for every one (ADR 0024).
    autoPong: false,
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  });

  /** The plugin's answer, checked like any other boundary; null after answering a broken plugin. */
  async function authenticate(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<AuthOutcome | null> {
    let outcome: unknown;
    try {
      outcome = await auth.authenticate(request);
    } catch (error) {
      log.error('auth plugin failed', { plugin: auth.name, error });
      send(response, 500, 'Authentication failed');
      return null;
    }
    const parsed = AuthOutcomeSchema.safeParse(outcome);
    if (!parsed.success) {
      log.error('auth plugin gave a malformed answer', { plugin: auth.name });
      send(response, 500, 'Authentication failed');
      return null;
    }
    return parsed.data;
  }

  /**
   * The relay's own refusal of a user the plugin vouched for: ADR 0020 admits
   * an invitee only with invites on (config.invites), into the invitee tier
   * (ADRs 0016 and 0017), where it sees only the pages it holds and pairs
   * only by invite. With invites off every invitee gets M3's 403.
   */
  function notAdmitted(outcome: Extract<AuthOutcome, { kind: 'user' }>): AuthRefusal | null {
    return outcome.user.account.kind === 'invitee' && !config.invites
      ? notAllowedRefusal(outcome.oauthClientId)
      : null;
  }

  async function handleMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Where the spike's call timestamps start: before the Host check, sign-in and the SDK.
    const receivedAt = performance.now();
    // In every mode, hosted included (ADR 0018): the edge passes on the Host a client sent.
    if (!validateHost(request, response)) return;
    // Named in refusal lines only: /mcp never counts by address (ADR 0016),
    // so a header that names no client is no reason to refuse it.
    const client = addresses.of(request);
    // ADR 0027 (S12): a present Origin must be exactly an allowed one, checked
    // before anything that spends, challenges or answers, on either leg. Node
    // joins two Origin lines with a comma, which matches no origin. A request
    // with none passes: the header is a browser's, and Claude Code sends none.
    const origin = request.headers.origin;
    if (origin !== undefined && !config.isMcpOriginAllowed(origin)) {
      mcpLines.write('info', 'mcp request refused: origin not allowed', {
        origin: origin.slice(0, 200),
        address: loggedAddress(client),
      });
      send(response, 403, ORIGIN_REFUSAL, { 'Content-Type': 'application/json' });
      return;
    }
    // Before the plugin, so a proxied request never even gets a challenge.
    if (config.publicUrl === null && !madeLocally(request)) {
      mcpLines.write('info', 'mcp request refused: not made on this machine', {
        address: loggedAddress(client),
      });
      send(response, 403, 'This relay serves only clients on its own machine');
      return;
    }
    const outcome = await authenticate(request, response);
    if (outcome === null) return;
    const refuse = (refusal: AuthRefusal): void => {
      // The reason is a fixed phrase; the credential itself never gets here.
      refusals.refused(refusal, client);
      send(response, refusal.status, refusal.body, refusal.headers);
    };
    if (outcome.kind === 'refused') {
      refuse(outcome);
      return;
    }
    const notIn = notAdmitted(outcome);
    if (notIn !== null) {
      refuse(notIn);
      return;
    }
    const extra: AuthExtra = {
      userId: outcome.user.userId,
      displayName: outcome.user.displayName,
      kind: outcome.user.account.kind,
      email: outcome.user.account.email,
      oauthClientId: outcome.oauthClientId,
    };
    // The SDK requires a token field; the real one stays out of everything downstream.
    const authInfo: AuthInfo = {
      token: '',
      clientId: outcome.user.userId,
      scopes: [],
      extra: { ...extra, ...(spike ? { receivedAt } : {}) },
    };
    // toNodeHandler forwards req.auth as authInfo. IncomingMessage needs the cast
    // under exactOptionalPropertyTypes (method is string | undefined there).
    const withAuth = request as IncomingMessage & { auth?: AuthInfo };
    withAuth.auth = authInfo;
    // Until it finishes or closes: one the client leaves unread is cut off (ADR 0030).
    stalls.track(response, outcome.user.userId);
    await mcpNode(withAuth as NodeIncomingMessageLike, response);
  }

  /** A plugin's GET route, such as its metadata document, behind the same Host check as /mcp. */
  async function handleAuthRoute(
    handler: AuthRoute,
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!validateHost(request, response)) return;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      return;
    }
    // Only the path and method reach the plugin; the base is a placeholder.
    const answer = await handler(
      new Request(new URL(path, 'http://relay.invalid'), { method: request.method }),
    );
    const body = request.method === 'HEAD' ? undefined : Buffer.from(await answer.arrayBuffer());
    response.writeHead(answer.status, Object.fromEntries(answer.headers.entries()));
    response.end(body);
  }

  const server = createServer((request, response) => {
    const path = pathOf(request.url);
    const route = async (): Promise<void> => {
      const authRoute = path === null ? undefined : authRoutes.get(path);
      if (path === null || malformedHost(request)) {
        send(response, 400, 'Bad request');
      } else if (path === '/healthz') {
        if (request.method === 'GET' || request.method === 'HEAD') send(response, 200, 'ok');
        else send(response, 405, 'Method not allowed');
      } else if (path === '/mcp') {
        await handleMcp(request, response);
      } else if (path === '/page') {
        send(response, 426, 'Upgrade required', { Upgrade: 'websocket' });
      } else if (authRoute !== undefined) {
        await handleAuthRoute(authRoute, path, request, response);
      } else if (pair !== null && PAIR_ROUTES.includes(path)) {
        // The DNS rebinding guard, as for /mcp: the public host or a loopback name.
        if (!validateHost(request, response)) return;
        // /pair counts sign-ins by address, so a request whose client the
        // edge did not name is malformed here (ADR 0018).
        const client = addresses.of(request);
        if (!client.ok) {
          log.info('pair request refused: no client address', { problem: client.problem });
          send(response, 400, 'Bad request');
          return;
        }
        await pair.handle(path, request, response, client.key);
      } else {
        send(response, 404, 'Not found');
      }
    };
    route().catch((error: unknown) => {
      log.error('request failed', { route: routeOf(path), error });
      if (!response.headersSent) send(response, 500, 'Internal error');
      else response.destroy();
    });
  });
  // Node stops collecting header lines past maxHeadersCount (2000 entries) and
  // drops the rest unseen, so a second Host line or a proxy header placed after
  // a thousand filler lines would slip past malformedHost and madeLocally. Count
  // every line; maxHeaderSize still caps the whole header at 16 KiB (431).
  server.maxHeadersCount = 0;

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (pathOf(request.url) !== '/page') {
      refuseUpgrade(socket, 404, 'Not found');
      return;
    }
    // What the per-address page limits count by (S9): in hosted mode the client the edge names (ADR 0018).
    const client = addresses.of(request);
    // Each refusal's line is written within its address's budget (ADR 0023's notes).
    const lineKey = client.ok ? client.key : `(${client.problem})`;
    if (malformedHost(request)) {
      hub.connectionLine(lineKey, 'info', 'page socket refused: malformed Host', {
        address: loggedAddress(client),
      });
      refuseUpgrade(socket, 400, 'Bad request');
      return;
    }
    // /page counts by address, so a client the edge did not name is a malformed request.
    if (!client.ok) {
      hub.connectionLine(lineKey, 'info', 'page socket refused: no client address', {
        problem: client.problem,
      });
      refuseUpgrade(socket, 400, 'Bad request');
      return;
    }
    // Logged as the address, counted by its limit key, which in hosted mode groups an IPv6 /56.
    const { address, key } = client;
    if (config.hosted) {
      // ADR 0018: behind a host edge pages attach through the public URL,
      // which names the public host; the edge's own forwarding headers are
      // expected, and the client address above came from its one trusted header.
      if (!forPublicHost(request, config)) {
        hub.connectionLine(key, 'info', 'page socket refused: not the public host', { address });
        refuseUpgrade(socket, 403, 'Pages attach through the public URL only');
        return;
      }
    } else if (!madeLocally(request)) {
      // ADR 0014: every request through a tunnel arrives from loopback, so the
      // address says nothing; the Host and proxy headers do. Without a host
      // edge pages attach only from this machine, and a relay without a public
      // URL never takes a proxied page (ADR 0022).
      hub.connectionLine(key, 'info', 'page socket refused: not made on this machine', {
        address,
      });
      refuseUpgrade(socket, 403, 'Pages attach only from the relay machine itself');
      return;
    }
    if (!offeredProtocols(request.headers['sec-websocket-protocol']).includes(SUBPROTOCOL)) {
      hub.connectionLine(key, 'info', 'page socket refused: subprotocol missing', { address });
      refuseUpgrade(socket, 400, `The ${SUBPROTOCOL} subprotocol is required`);
      return;
    }
    // S1: the origin is read from this header and nowhere else.
    const header = request.headers.origin;
    let origin: string;
    if (header === undefined) {
      if (!config.allowMissingOrigin) {
        hub.connectionLine(key, 'info', 'page socket refused: no Origin header', { address });
        refuseUpgrade(socket, 403, 'An Origin header is required');
        return;
      }
      origin = NO_ORIGIN;
    } else if (!config.isOriginAllowed(header)) {
      hub.connectionLine(key, 'info', 'page socket refused: origin not allowed', {
        address,
        origin: header.slice(0, 200),
      });
      refuseUpgrade(socket, 403, 'Origin not allowed');
      return;
    } else {
      origin = header;
    }
    // S9: refused before upgrading, so the page gets a plain HTTP status.
    const refusal = hub.admitSocket(key);
    if (refusal) {
      refuseUpgrade(socket, refusal.status, refusal.message);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      hub.acceptSocket(ws, origin, key);
    });
  });

  try {
    // The argument check worker loads in about 100 ms; a relay that listened
    // first would let its first calls through unchecked. If it cannot start,
    // the relay serves anyway and keeps restarting it (ADR 0010).
    await hub.ready();
    const address = await listenAddress(config);
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(config.port, address, () => {
        server.off('error', rejectListen);
        resolveListen();
      });
    });
  } catch (error) {
    // A port in use or a host off loopback must not leave the MCP handler,
    // the socket server or the check worker behind.
    pair?.close();
    wss.close();
    await hub.shutdown();
    await closeAudit(store.audit);
    await mcp.close();
    await listens.closeAll();
    await sessions.closeAll();
    notifier?.close();
    stalls.close();
    mcpLines.close();
    clientLines.close();
    auth.stop?.();
    throw error;
  }
  const bound = server.address() as AddressInfo;
  // Bound to the wildcard in hosted mode, the relay is still reached on this machine through loopback.
  const reachable = bound.address === HOSTED_WILDCARD_HOST ? '127.0.0.1' : bound.address;
  const hostPort = `${formatHost(reachable)}:${String(bound.port)}`;
  const url = `http://${hostPort}`;
  log.info('relay listening', {
    url,
    bound: `${formatHost(bound.address)}:${String(bound.port)}`,
    mode: config.mode,
    publicUrl: config.publicUrl,
    env: config.env,
    auth: auth.name,
    origins: config.originPolicy,
    mcpOrigins: config.mcpOriginPolicy,
    allowMissingOrigin: config.allowMissingOrigin,
    spike: config.spike,
    firstClassTools: config.firstClassTools,
  });
  if (spike) {
    log.warn(
      'spike measurements are on (TABDOCK_SPIKE): every tools/list, client stream, call timing and pairing milestone is logged, and a marker tool can be added from the terminal (ADR 0014)',
    );
  }

  let closing: Promise<void> | null = null;
  return {
    url,
    pageUrl: `ws://${hostPort}/page`,
    mcpUrl: `${url}/mcp`,
    publicUrl: config.publicUrl,
    publicMcpUrl: config.publicMcpUrl,
    audit: {
      records: () => callRecords(store.audit.records()),
      events: () => store.audit.records(),
    },
    spike,
    close() {
      closing ??= (async () => {
        pair?.close();
        await hub.shutdown();
        // After the hub, whose shutdown audits the calls it fails (ADR 0019).
        await closeAudit(store.audit);
        for (const ws of wss.clients) ws.terminate();
        await new Promise<void>((resolveClose) => {
          wss.close(() => {
            resolveClose();
          });
        });
        await mcp.close();
        await listens.closeAll();
        await sessions.closeAll();
        notifier?.close();
        stalls.close();
        clientLines.close();
        auth.stop?.();
        // The counts of repeated refusals still held go out before the last line.
        refusals.close();
        mcpLines.close();
        server.closeAllConnections();
        await new Promise<void>((resolveClose) => {
          server.close(() => {
            resolveClose();
          });
        });
        log.info('relay closed');
      })();
      return closing;
    },
  };
}

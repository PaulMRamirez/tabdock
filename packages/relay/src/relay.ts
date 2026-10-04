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
// strict 2026-07-28 handler. In public URL mode (ADR 0014) the public host
// passes the Host check for /mcp and the QR flow at /pair (pair.ts) is served
// behind the same check, while /page still takes only requests made on this
// machine. Without a public URL, in local mode (ADR 0022) and with dev tokens
// alike, /mcp and /page take only requests made on this machine, so a tunnel
// pointed at a loopback relay, even one that rewrites Host, cannot expose it.
// Those checks trust a Host header any program can write, so they hold only
// while the relay listens on loopback: it resolves its host name itself and
// listens on the address only when that is loopback (S12). Requests are
// logged by route, never by raw path or query, so no secret a URL carries
// reaches a log. The M3 spike's measurements (spike.ts) hook in here when
// TABDOCK_SPIKE is on; nothing over HTTP controls them.

import { lookup } from 'node:dns/promises';
import { createServer, type IncomingMessage, type ServerResponse, STATUS_CODES } from 'node:http';
import { type AddressInfo, isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import { type NodeIncomingMessageLike, toNodeHandler } from '@modelcontextprotocol/node';
import {
  type AuthInfo,
  createMcpHandler,
  isLegacyRequest,
  type McpHandlerRequestOptions,
} from '@modelcontextprotocol/server';
import {
  type AuditCallEvent,
  type AuditEvent,
  MAX_FRAME_BYTES,
  SUBPROTOCOL,
} from '@tabdock/protocol';
import { WebSocketServer } from 'ws';
import { type AuthOutcome, AuthOutcomeSchema, type AuthRoute } from './auth.ts';
import { clientAddress } from './client-address.ts';
import {
  isLoopbackAddress,
  LOOPBACK_HOSTNAMES,
  NO_ORIGIN,
  parseHostHeader,
  type RelayOptions,
  type ResolvedConfig,
  resolveConfig,
} from './config.ts';
import { PageHub } from './hub.ts';
import { createLogger } from './log.ts';
import { type AuthExtra, createMcpFactory, userIdOf } from './mcp.ts';
import { createPairFlow, PAIR_ROUTES, type PairFlow } from './pair.ts';
import { McpSessions } from './sessions.ts';
import { Spike, type SpikeControl } from './spike.ts';
import { callRecords, createMemoryStore } from './store.ts';

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

export async function createRelay(options: RelayOptions): Promise<Relay> {
  const config = resolveConfig(options);
  const log = createLogger({
    ...(options.logSink ? { sink: options.logSink } : {}),
    ...(options.logLevel ? { level: options.logLevel } : {}),
  });
  const auth = options.auth;
  // First, before anything else exists: a plugin that cannot work (an identity
  // provider Claude could not sign in with, say) stops the relay from starting.
  await auth.start?.();
  const store = options.store ?? createMemoryStore();
  const spike = config.spike ? new Spike(log, MAX_MCP_BODY_BYTES) : null;
  const hub = new PageHub(config, store, log, spike);
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
      });
    } catch (error) {
      await hub.shutdown();
      await store.audit.close?.();
      throw error;
    }
  }

  const factory = createMcpFactory(hub, config, spike);
  const mcp = createMcpHandler(factory, {
    legacy: 'reject',
    maxRequestBodySize: MAX_MCP_BODY_BYTES,
    keepAliveMs: config.timings.sseKeepAliveMs,
    onerror: (error) => {
      log.warn('mcp handler error', { error });
    },
  });
  spike?.setModernNotifier(() => {
    mcp.notify.toolsChanged();
  });
  const sessions = new McpSessions({
    createServer: (authInfo, request) => factory({ era: 'legacy', authInfo, requestInfo: request }),
    ownerOf: userIdOf,
    perUser: config.limits.sessionsPerUser,
    total: config.limits.sessions,
    idleMs: config.timings.sessionIdleMs,
    keepAliveMs: config.timings.sseKeepAliveMs,
    maxRequestBodySize: MAX_MCP_BODY_BYTES,
    log,
  });
  const legs = {
    fetch: async (request: Request, options?: McpHandlerRequestOptions): Promise<Response> => {
      const legacy = await isLegacyRequest(request, undefined, {
        maxRequestBodySize: MAX_MCP_BODY_BYTES,
      });
      const forward = (forwarded: Request): Promise<Response> =>
        legacy ? sessions.handle(forwarded, options?.authInfo) : mcp.fetch(forwarded, options);
      const userId = userIdOf(options?.authInfo);
      return spike && userId !== null
        ? spike.observe(request, { userId, legacy }, forward)
        : forward(request);
    },
  };
  const mcpNode = toNodeHandler(legs, {
    maxRequestBodySize: MAX_MCP_BODY_BYTES,
    onerror: (error) => {
      // undici's message for a Request it cannot build quotes the URL, query and all.
      log.error('mcp adapter error', { errorClass: errorClass(error) });
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

  async function handleMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Where the spike's call timestamps start: before the Host check, sign-in and the SDK.
    const receivedAt = performance.now();
    if (config.loopback && !validateHost(request, response)) return;
    // Before the plugin, so a proxied request never even gets a challenge.
    if (config.publicUrl === null && !madeLocally(request)) {
      log.info('mcp request refused: not made on this machine', {
        address: request.socket.remoteAddress,
      });
      send(response, 403, 'This relay serves only clients on its own machine');
      return;
    }
    const outcome = await authenticate(request, response);
    if (outcome === null) return;
    if (outcome.kind === 'refused') {
      // The reason is the plugin's fixed phrase; the credential itself never gets here.
      const event =
        outcome.status === 401
          ? 'mcp request refused: not authenticated'
          : outcome.status === 403
            ? 'mcp request refused: not allowed'
            : 'mcp request refused: sign-in unavailable';
      log.info(event, { reason: outcome.reason, address: request.socket.remoteAddress });
      send(response, outcome.status, outcome.body, outcome.headers);
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
    await mcpNode(withAuth as NodeIncomingMessageLike, response);
  }

  /** A plugin's GET route, such as its metadata document, behind the same Host check as /mcp. */
  async function handleAuthRoute(
    handler: AuthRoute,
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (config.loopback && !validateHost(request, response)) return;
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
        await pair.handle(path, request, response);
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
    // What the per-address page limits count by (S9); the socket's peer until hosted mode (ADR 0018).
    const address = clientAddress(request);
    if (pathOf(request.url) !== '/page') {
      refuseUpgrade(socket, 404, 'Not found');
      return;
    }
    if (malformedHost(request)) {
      log.info('page socket refused: malformed Host', { address });
      refuseUpgrade(socket, 400, 'Bad request');
      return;
    }
    // ADR 0014: every request through the tunnel arrives from loopback, so the
    // address says nothing; the Host and proxy headers do. Pages attach only
    // from this machine until M4 brings a host and a trusted client address,
    // and a relay without a public URL never takes a proxied page (ADR 0022).
    if (!madeLocally(request)) {
      log.info('page socket refused: not made on this machine', { address });
      refuseUpgrade(socket, 403, 'Pages attach only from the relay machine itself');
      return;
    }
    if (!offeredProtocols(request.headers['sec-websocket-protocol']).includes(SUBPROTOCOL)) {
      log.info('page socket refused: subprotocol missing', { address });
      refuseUpgrade(socket, 400, `The ${SUBPROTOCOL} subprotocol is required`);
      return;
    }
    // S1: the origin is read from this header and nowhere else.
    const header = request.headers.origin;
    let origin: string;
    if (header === undefined) {
      if (!config.allowMissingOrigin) {
        log.info('page socket refused: no Origin header', { address });
        refuseUpgrade(socket, 403, 'An Origin header is required');
        return;
      }
      origin = NO_ORIGIN;
    } else if (!config.isOriginAllowed(header)) {
      log.info('page socket refused: origin not allowed', {
        address,
        origin: header.slice(0, 200),
      });
      refuseUpgrade(socket, 403, 'Origin not allowed');
      return;
    } else {
      origin = header;
    }
    // S9: refused before upgrading, so the page gets a plain HTTP status.
    const refusal = hub.admitSocket(address);
    if (refusal) {
      refuseUpgrade(socket, refusal.status, refusal.message);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      hub.acceptSocket(ws, origin, address);
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
    await store.audit.close?.();
    await mcp.close();
    await sessions.closeAll();
    throw error;
  }
  const bound = server.address() as AddressInfo;
  const hostPort = `${formatHost(bound.address)}:${String(bound.port)}`;
  const url = `http://${hostPort}`;
  log.info('relay listening', {
    url,
    publicUrl: config.publicUrl,
    env: config.env,
    auth: auth.name,
    origins: config.originPolicy,
    allowMissingOrigin: config.allowMissingOrigin,
    spike: config.spike,
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
        await store.audit.close?.();
        for (const ws of wss.clients) ws.terminate();
        await new Promise<void>((resolveClose) => {
          wss.close(() => {
            resolveClose();
          });
        });
        await mcp.close();
        await sessions.closeAll();
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

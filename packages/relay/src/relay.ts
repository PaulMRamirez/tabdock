// One node:http server for everything: /page upgrades to the page link through
// `ws`, /mcp goes through the official MCP SDK, /healthz answers ok. Checks run
// before any protocol code sees a request: origin, subprotocol and the socket
// limits for pages (S1, S2, S9), Host and the auth plugin for MCP clients. /mcp
// has two legs behind those checks, composed as the SDK documents (ADR 0009):
// 2025-era traffic goes to the sessionful leg in sessions.ts, everything else to
// a strict 2026-07-28 handler.

import { createServer, type IncomingMessage, type ServerResponse, STATUS_CODES } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  localhostHostValidation,
  type NodeIncomingMessageLike,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import {
  type AuthInfo,
  createMcpHandler,
  isLegacyRequest,
  type McpHandlerRequestOptions,
} from '@modelcontextprotocol/server';
import { MAX_FRAME_BYTES, SUBPROTOCOL, type User, UserSchema } from '@tabdock/protocol';
import { WebSocketServer } from 'ws';
import { NO_ORIGIN, type RelayOptions, resolveConfig } from './config.ts';
import { PageHub } from './hub.ts';
import { createLogger } from './log.ts';
import { type AuthExtra, createMcpFactory, userIdOf } from './mcp.ts';
import { McpSessions } from './sessions.ts';
import { type AuditRecord, createMemoryStore } from './store.ts';

export interface Relay {
  /** http://127.0.0.1:<port> */
  readonly url: string;
  /** ws://127.0.0.1:<port>/page */
  readonly pageUrl: string;
  /** http://127.0.0.1:<port>/mcp */
  readonly mcpUrl: string;
  readonly audit: { records(): AuditRecord[] };
  close(): Promise<void>;
}

/**
 * MCP bodies above this are refused before parsing. A page link frame is at
 * most MAX_FRAME_BYTES, so a call cannot usefully carry more than about that.
 */
const MAX_MCP_BODY_BYTES = 2 * MAX_FRAME_BYTES;

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

export async function createRelay(options: RelayOptions): Promise<Relay> {
  const config = resolveConfig(options);
  const log = createLogger({
    ...(options.logSink ? { sink: options.logSink } : {}),
    ...(options.logLevel ? { level: options.logLevel } : {}),
  });
  const auth = options.auth;
  const store = options.store ?? createMemoryStore();
  const hub = new PageHub(config, store, log);

  const factory = createMcpFactory(hub, config);
  const mcp = createMcpHandler(factory, {
    legacy: 'reject',
    maxRequestBodySize: MAX_MCP_BODY_BYTES,
    keepAliveMs: config.timings.sseKeepAliveMs,
    onerror: (error) => {
      log.warn('mcp handler error', { error });
    },
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
    fetch: async (request: Request, options?: McpHandlerRequestOptions): Promise<Response> =>
      (await isLegacyRequest(request, undefined, { maxRequestBodySize: MAX_MCP_BODY_BYTES }))
        ? sessions.handle(request, options?.authInfo)
        : mcp.fetch(request, options),
  };
  const mcpNode = toNodeHandler(legs, {
    maxRequestBodySize: MAX_MCP_BODY_BYTES,
    onerror: (error) => {
      log.error('mcp adapter error', { error });
    },
  });
  // DNS rebinding guard: a loopback relay only answers Host names that mean loopback.
  const validateHost = localhostHostValidation();

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  });

  async function handleMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (config.loopback && !validateHost(request, response)) return;
    let user: User | null;
    try {
      user = await auth.authenticate(request);
    } catch (error) {
      log.error('auth plugin failed', { plugin: auth.name, error });
      send(response, 500, 'Authentication failed');
      return;
    }
    const parsed = user === null ? null : UserSchema.safeParse(user);
    if (!parsed?.success) {
      log.info('mcp request refused: not authenticated', {
        address: request.socket.remoteAddress,
      });
      send(response, 401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer realm="tabdock"' });
      return;
    }
    const extra: AuthExtra = {
      userId: parsed.data.userId,
      displayName: parsed.data.displayName,
      clientAddress: request.socket.remoteAddress ?? 'unknown',
    };
    // The SDK requires a token field; the real one stays out of everything downstream.
    const authInfo: AuthInfo = {
      token: '',
      clientId: parsed.data.userId,
      scopes: [],
      extra: { ...extra },
    };
    // toNodeHandler forwards req.auth as authInfo. IncomingMessage needs the cast
    // under exactOptionalPropertyTypes (method is string | undefined there).
    const withAuth = request as IncomingMessage & { auth?: AuthInfo };
    withAuth.auth = authInfo;
    await mcpNode(withAuth as NodeIncomingMessageLike, response);
  }

  const server = createServer((request, response) => {
    const path = pathOf(request.url);
    const route = async (): Promise<void> => {
      if (path === null) {
        send(response, 400, 'Bad request');
      } else if (path === '/healthz') {
        if (request.method === 'GET' || request.method === 'HEAD') send(response, 200, 'ok');
        else send(response, 405, 'Method not allowed');
      } else if (path === '/mcp') {
        await handleMcp(request, response);
      } else if (path === '/page') {
        send(response, 426, 'Upgrade required', { Upgrade: 'websocket' });
      } else {
        send(response, 404, 'Not found');
      }
    };
    route().catch((error: unknown) => {
      log.error('request failed', { path, error });
      if (!response.headersSent) send(response, 500, 'Internal error');
      else response.destroy();
    });
  });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const address = request.socket.remoteAddress ?? 'unknown';
    if (pathOf(request.url) !== '/page') {
      refuseUpgrade(socket, 404, 'Not found');
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
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(config.port, config.host.replace(/^\[(.*)\]$/, '$1'), () => {
        server.off('error', rejectListen);
        resolveListen();
      });
    });
  } catch (error) {
    // A port in use must not leave the MCP handler or the socket server behind.
    wss.close();
    await mcp.close();
    await sessions.closeAll();
    throw error;
  }
  const bound = server.address() as AddressInfo;
  const hostPort = `${formatHost(bound.address)}:${String(bound.port)}`;
  const url = `http://${hostPort}`;
  log.info('relay listening', {
    url,
    env: config.env,
    auth: auth.name,
    origins: config.originPolicy,
    allowMissingOrigin: config.allowMissingOrigin,
  });

  let closing: Promise<void> | null = null;
  return {
    url,
    pageUrl: `ws://${hostPort}/page`,
    mcpUrl: `${url}/mcp`,
    audit: { records: () => store.audit.records() },
    close() {
      closing ??= (async () => {
        await hub.shutdown();
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

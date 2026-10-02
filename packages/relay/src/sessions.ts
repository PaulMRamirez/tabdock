// The sessionful leg for 2025-era MCP clients (ADR 0009), composed the way the
// SDK documents: isLegacyRequest routes the request here, and each session is
// one WebStandardStreamableHTTPServerTransport with one McpServer, created only
// for an initialize request. The SDK keeps no session store and does not tie a
// session to the user who opened it: handed a stolen session id, it runs the
// call on the owner's server. So every session records its owner, and anyone
// else presenting its id gets the same 404 as an unknown id before the SDK sees
// the request (S13). Idle expiry and the caps are ours as well.

import { randomUUID } from 'node:crypto';
import {
  type AuthInfo,
  type HandleRequestOptions,
  isInitializeRequest,
  type McpServer,
  readRequestBody,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import type { Logger } from './log.ts';

export interface SessionOptions {
  /** Builds the McpServer for a new session, for the user who opens it. */
  createServer: (authInfo: AuthInfo, request: Request) => McpServer;
  /** The authenticated user's id, or null if the request somehow carries none. */
  ownerOf: (authInfo: AuthInfo | undefined) => string | null;
  /** Sessions one user may hold; a new one evicts their least recently used idle one. */
  perUser: number;
  /** Sessions in total; past this, initialize gets 503. */
  total: number;
  /** A session with no response open for this long is closed. */
  idleMs: number;
  /** Keep-alive comment interval on the session's event streams. */
  keepAliveMs: number;
  maxRequestBodySize: number;
  log: Logger;
}

interface Session {
  id: string;
  userId: string;
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  /** False until the SDK accepts the initialize request; no request can name the session before. */
  ready: boolean;
  /** Responses still streaming, a client's listening GET stream included. Idle means none. */
  open: number;
  lastActive: number;
  idleTimer: NodeJS.Timeout | null;
  closed: boolean;
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, { status });
}

/** One answer for an unknown session and for someone else's, so neither says which it was. */
function sessionNotFound(): Response {
  return jsonRpcError(404, -32001, 'Session not found');
}

/**
 * The same response, with `done` called once when its body has been sent,
 * failed, or been abandoned by the client (the request's signal aborts when
 * the Node response closes early).
 */
function trackBody(response: Response, signal: AbortSignal, done: () => void): Response {
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    signal.removeEventListener('abort', finish);
    done();
  };
  const body = response.body;
  if (body === null) {
    finish();
    return response;
  }
  if (signal.aborted) finish();
  else signal.addEventListener('abort', finish, { once: true });
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const tracked = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });
  return new Response(tracked, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export class McpSessions {
  readonly #options: SessionOptions;
  readonly #sessions = new Map<string, Session>();
  #closed = false;

  constructor(options: SessionOptions) {
    this.#options = options;
  }

  /** Open sessions, including one whose initialize is still being answered. */
  get size(): number {
    return this.#sessions.size;
  }

  async handle(request: Request, authInfo: AuthInfo | undefined): Promise<Response> {
    const userId = this.#options.ownerOf(authInfo);
    // Only reachable if the HTTP layer forgot to authenticate.
    if (userId === null || authInfo === undefined) return jsonRpcError(401, -32001, 'Unauthorized');

    const sessionId = request.headers.get('mcp-session-id');
    if (sessionId !== null) {
      const session = this.#sessions.get(sessionId);
      if (!session?.ready || session.closed || session.userId !== userId) {
        if (session?.ready && session.userId !== userId) {
          this.#options.log.warn('MCP session id presented by another user', { userId });
        }
        return sessionNotFound();
      }
      return this.#dispatch(session, request, { authInfo });
    }

    // Without a session id only an initialize can start one; read the body to tell.
    if (request.method !== 'POST') {
      return jsonRpcError(400, -32000, 'Bad Request: Mcp-Session-Id header is required');
    }
    const body = await readRequestBody(request, this.#options.maxRequestBodySize);
    if (body.tooLarge) return jsonRpcError(413, -32000, 'Request body too large');
    let message: unknown;
    try {
      message = JSON.parse(body.text);
    } catch {
      return jsonRpcError(400, -32700, 'Parse error: Invalid JSON');
    }
    if (!isInitializeRequest(message)) {
      return jsonRpcError(400, -32000, 'Bad Request: Mcp-Session-Id header is required');
    }
    return this.#open(userId, authInfo, request, message);
  }

  async #open(
    userId: string,
    authInfo: AuthInfo,
    request: Request,
    initialize: unknown,
  ): Promise<Response> {
    if (this.#closed) return jsonRpcError(503, -32000, 'The relay is shutting down');
    const refusal = this.#makeRoom(userId);
    if (refusal) return refusal;

    const id = randomUUID();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      onsessioninitialized: () => {
        const opened = this.#sessions.get(id);
        if (opened) opened.ready = true;
      },
      onsessionclosed: () => {
        this.#options.log.info('MCP session ended by the client', { userId });
      },
      maxRequestBodySize: this.#options.maxRequestBodySize,
      keepAliveMs: this.#options.keepAliveMs,
    });
    const server = this.#options.createServer(authInfo, request);
    const session: Session = {
      id,
      userId,
      transport,
      server,
      ready: false,
      open: 0,
      lastActive: Date.now(),
      idleTimer: null,
      closed: false,
    };
    // Counted from now, so initializes that overlap cannot overshoot a cap together.
    this.#sessions.set(id, session);
    transport.onclose = () => {
      this.#forget(session);
    };
    try {
      await server.connect(transport);
    } catch (error) {
      this.#forget(session);
      throw error;
    }
    const response = await this.#dispatch(session, request, { authInfo, parsedBody: initialize });
    if (!session.ready) {
      // The SDK refused the initialize (a wrong Accept or Content-Type header, say).
      void this.#close(session, 'initialize refused');
    } else {
      this.#options.log.debug('MCP session opened', { userId, sessions: this.#sessions.size });
    }
    return response;
  }

  /** null when there is room for one more session of this user, else the refusal. */
  #makeRoom(userId: string): Response | null {
    const { perUser, total, log } = this.#options;
    const mine = [...this.#sessions.values()].filter((session) => session.userId === userId);
    if (mine.length >= perUser) {
      const idle = mine
        .filter((session) => session.ready && session.open === 0)
        .sort((a, b) => a.lastActive - b.lastActive)[0];
      if (!idle) {
        log.warn('MCP session refused: the user holds the most sessions allowed', { userId });
        return jsonRpcError(
          429,
          -32000,
          `Too many open sessions for this user (${String(perUser)}); close one and try again`,
        );
      }
      void this.#close(idle, 'evicted for a newer session of the same user');
    }
    if (this.#sessions.size >= total) {
      log.warn('MCP session refused: the relay holds the most sessions allowed', { userId });
      return jsonRpcError(503, -32000, 'Too many open sessions on this relay; try again later');
    }
    return null;
  }

  async #dispatch(
    session: Session,
    request: Request,
    options: HandleRequestOptions,
  ): Promise<Response> {
    session.open += 1;
    session.lastActive = Date.now();
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
    let response: Response;
    try {
      response = await session.transport.handleRequest(request, options);
    } catch (error) {
      this.#release(session);
      throw error;
    }
    return trackBody(response, request.signal, () => {
      this.#release(session);
    });
  }

  #release(session: Session): void {
    session.open -= 1;
    session.lastActive = Date.now();
    if (session.open > 0 || session.closed) return;
    session.idleTimer = setTimeout(() => {
      void this.#close(session, 'idle');
    }, this.#options.idleMs);
    session.idleTimer.unref();
  }

  #forget(session: Session): void {
    session.closed = true;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
    if (this.#sessions.get(session.id) === session) this.#sessions.delete(session.id);
  }

  /** Removes the session now; closing its transport ends its streams and aborts its handlers. */
  #close(session: Session, reason: string): Promise<void> {
    if (session.closed) return Promise.resolve();
    this.#forget(session);
    this.#options.log.info('MCP session closed', {
      userId: session.userId,
      reason,
      sessions: this.#sessions.size,
    });
    return session.server.close().catch((error: unknown) => {
      this.#options.log.warn('MCP session did not close cleanly', { error });
    });
  }

  async closeAll(): Promise<void> {
    this.#closed = true;
    await Promise.all(
      [...this.#sessions.values()].map((session) => this.#close(session, 'shutdown')),
    );
  }
}

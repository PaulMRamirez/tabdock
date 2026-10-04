// The sessionful leg for 2025-era MCP clients (ADR 0009), composed the way the
// SDK documents: isLegacyRequest routes the request here, and each session is
// one WebStandardStreamableHTTPServerTransport with one McpServer, created only
// for an initialize request. The SDK keeps no session store and does not tie a
// session to the user who opened it: handed a stolen session id, it runs the
// call on the owner's server. So every session records its owner, and anyone
// else presenting its id gets the same 404 as an unknown id before the SDK sees
// the request (S13). Idle expiry and the caps are ours as well. Nothing here
// spends a request budget (ADR 0018 counts tool calls, never initialize), so
// the lines a client can cause at will, refusals and sessions it opens and
// drops in a loop, go through the relay's budget for repeated lines
// (repeated-lines.ts): one per kind a window, the rest counted (A4.3).

import { randomUUID } from 'node:crypto';
import {
  type AuthInfo,
  type HandleRequestOptions,
  isInitializeRequest,
  type McpServer,
  readRequestBody,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import type { Logger, LogFields, LogLevel } from './log.ts';
import type { RepeatedLog } from './repeated-lines.ts';

/**
 * The invitee tier's sessions (ADRs 0016 and 0017): an invitee may hold one
 * session until it holds an attachment and perInvitee after, all invitees
 * together hold at most pool of them, and when the relay is full an invitee's
 * session goes before anyone else is refused. With invites on, anyone who
 * signs up at the provider is an invitee, so these keep strangers from
 * filling the relay's sessions or pushing out the owner's people. Who gives
 * way to whom follows rankOf: a stranger (an invitee holding no attachment)
 * below a guest (one holding an attachment) below a member.
 */
export interface InviteeSessionOptions {
  /** Sessions all invitees may hold together (RelayLimits.inviteeSessions). */
  pool: number;
  /** Sessions one invitee holding an attachment may hold (RelayLimits.sessionsPerInvitee). */
  perInvitee: number;
  /** Whether a user id is an invitee's, which ADR 0017 makes a matter of its shape. */
  isInvitee: (userId: string) => boolean;
  /** Whether the user holds an attachment to any page (PageHub.holds). */
  holds: (userId: string) => boolean;
}

/**
 * Where an account stands when room runs short. A stranger, an invitee
 * holding no attachment, is anyone who signed up at the provider; a guest is
 * an invitee the operator let in, through an invite; a member is on the
 * allowlist. A stream or session gives way only to someone ranked above its
 * holder, so strangers, however many accounts they open, never push out a
 * guest or a member (A4.3). Without the tier everyone ranks as a member.
 */
export const STRANGER = 0;
export const GUEST = 1;
export const MEMBER = 2;
export type TierRank = typeof STRANGER | typeof GUEST | typeof MEMBER;
/** Lowest first, the order in which holders give way. */
export const RANKS: readonly TierRank[] = [STRANGER, GUEST, MEMBER];

export function rankOf(userId: string, invitees: InviteeSessionOptions | undefined): TierRank {
  if (invitees?.isInvitee(userId) !== true) return MEMBER;
  return invitees.holds(userId) ? GUEST : STRANGER;
}

export interface SessionOptions {
  /** Builds the McpServer for a new session, for the user who opens it. */
  createServer: (authInfo: AuthInfo, request: Request) => McpServer;
  /** The authenticated user's id, or null if the request somehow carries none. */
  ownerOf: (authInfo: AuthInfo | undefined) => string | null;
  /** Sessions one user may hold; a new one evicts their least recently used idle one. */
  perUser: number;
  /** Sessions in total; past this, initialize gets 503. */
  total: number;
  /** The invitee tier; without it, every user's sessions count alike. */
  invitees?: InviteeSessionOptions | undefined;
  /** A session with no response open for this long is closed. */
  idleMs: number;
  /** Keep-alive comment interval on the session's event streams. */
  keepAliveMs: number;
  maxRequestBodySize: number;
  log: Logger;
  /**
   * Where the lines a client can cause at will go: refusals, and sessions
   * opened and dropped in a loop, none of which spends a request budget. The
   * relay's own collapses repeats (repeated-lines.ts); without it every line
   * goes to log.
   */
  lines?: RepeatedLog | undefined;
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
export function trackBody(response: Response, signal: AbortSignal, done: () => void): Response {
  return closableBody(response, signal, done).response;
}

/** A tracked response, and a way for the relay itself to end it. */
export interface ClosableBody {
  response: Response;
  /**
   * Ends the body from the relay's side: `done` runs at once, the stream
   * underneath is cancelled, which makes the SDK tear down whatever it served
   * on it (a listen subscription with its keep-alive timer, say), and the
   * client then sees the body end.
   */
  close: () => void;
}

/** trackBody, plus close() (ClosableBody). */
export function closableBody(
  response: Response,
  signal: AbortSignal,
  done: () => void,
): ClosableBody {
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
    return { response, close: finish };
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
  return {
    response: new Response(tracked, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    close: () => {
      finish();
      // A read waiting in pull() then ends as done, which closes the body the client reads.
      reader.cancel().catch(() => {
        // Already cancelled or errored: nothing is left to end.
      });
    },
  };
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
          this.#line('warn', 'MCP session id presented by another user', { userId });
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
        this.#line('info', 'MCP session ended by the client', { userId });
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

  /** Whether a session is an invitee's, which the tier's rules bound and evict first. */
  #isInvitee(session: Session): boolean {
    return this.#options.invitees?.isInvitee(session.userId) === true;
  }

  /** The least recently active of these sessions, idle ones before busy ones; undefined for none. */
  #idlest(sessions: Session[], idleOnly: boolean): Session | undefined {
    const ready = sessions.filter((session) => session.ready);
    const idle = ready.filter((session) => session.open === 0);
    const pick = idle.length > 0 || idleOnly ? idle : ready;
    return pick.sort((a, b) => a.lastActive - b.lastActive)[0];
  }

  /**
   * The session to close so a newcomer of this rank fits, or undefined when
   * none may go: first one held by someone ranked below the newcomer, the
   * lowest ranked first, idle before busy, since a session whose listening
   * stream stays open is never idle and would otherwise hold its place for
   * good; failing that, an idle one held by someone of the newcomer's own
   * rank. Least recently active first each time. So a busy session gives way
   * only to someone ranked above its holder, and a guest's never to a
   * stranger (A4.3).
   */
  #giveWay(sessions: Session[], rank: TierRank): Session | undefined {
    const { invitees } = this.#options;
    const ofRank = (wanted: TierRank): Session[] =>
      sessions.filter((session) => rankOf(session.userId, invitees) === wanted);
    for (const lower of RANKS.filter((each) => each < rank)) {
      const evicted = this.#idlest(ofRank(lower), false);
      if (evicted !== undefined) return evicted;
    }
    return this.#idlest(ofRank(rank), true);
  }

  /** null when there is room for one more session of this user, else the refusal. */
  #makeRoom(userId: string): Response | null {
    const { total, invitees } = this.#options;
    const rank = rankOf(userId, invitees);
    // The tier's rules when this user is an invitee, else null.
    const tier = rank === MEMBER ? null : (invitees ?? null);
    // An invitee holds one session until it holds an attachment (ADR 0016).
    const perUser =
      tier === null
        ? this.#options.perUser
        : Math.min(this.#options.perUser, tier.holds(userId) ? tier.perInvitee : 1);
    const all = [...this.#sessions.values()];
    const mine = all.filter((session) => session.userId === userId);
    if (mine.length >= perUser) {
      const idle = this.#idlest(mine, true);
      if (!idle) {
        this.#line('warn', 'MCP session refused: the user holds the most sessions allowed', {
          userId,
        });
        return jsonRpcError(
          429,
          -32000,
          `Too many open sessions for this user (${String(perUser)}); close one and try again`,
        );
      }
      void this.#close(idle, 'evicted for a newer session of the same user');
    }
    const open = (): Session[] => [...this.#sessions.values()].filter((session) => !session.closed);
    // Invitees share a small pool of their own: a stranger's session makes
    // room for a guest, busy or not, and otherwise only an idle one goes.
    if (tier !== null) {
      const pool = open().filter((session) => this.#isInvitee(session));
      if (pool.length >= tier.pool) {
        const evicted = this.#giveWay(pool, rank);
        if (!evicted) {
          this.#line('warn', 'MCP session refused: invitees hold the most sessions allowed', {
            userId,
          });
          return jsonRpcError(503, -32000, 'Too many open sessions on this relay; try again later');
        }
        void this.#close(evicted, 'evicted for a newer invitee session');
      }
    }
    if (this.#sessions.size >= total) {
      // When the relay is full an invitee's session goes before anyone is
      // refused (ADR 0016), so long as its holder ranks below the newcomer.
      const tiered = open().filter((session) => this.#isInvitee(session));
      const evicted = this.#giveWay(tiered, rank);
      if (evicted === undefined) {
        this.#line('warn', 'MCP session refused: the relay holds the most sessions allowed', {
          userId,
        });
        return jsonRpcError(503, -32000, 'Too many open sessions on this relay; try again later');
      }
      void this.#close(evicted, 'evicted for a newer session: the relay is full');
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
    this.#line(
      'info',
      'MCP session closed',
      { userId: session.userId, reason, sessions: this.#sessions.size },
      reason,
    );
    return session.server.close().catch((error: unknown) => {
      this.#line('warn', 'MCP session did not close cleanly', { error });
    });
  }

  /** A line a client can cause at will, through the relay's budget for them when it has one. */
  #line(level: LogLevel, message: string, fields: LogFields, detail?: string): void {
    const { lines, log } = this.#options;
    if (lines) lines.write(level, message, fields, detail);
    else log[level](message, fields);
  }

  async closeAll(): Promise<void> {
    this.#closed = true;
    await Promise.all(
      [...this.#sessions.values()].map((session) => this.#close(session, 'shutdown')),
    );
  }
}

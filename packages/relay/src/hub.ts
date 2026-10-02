// The page hub: every page socket, pairing ticket, attach request, attachment
// and in-flight call passes through here. The MCP side (mcp.ts) asks questions
// on behalf of an authenticated user; every answer is computed from that user's
// own attachments, so an unknown page and someone else's page look the same (S13).

import {
  type AttachmentView,
  type ClientInfo,
  CLOSE_DETACH,
  CLOSE_REPLACED,
  encodeFrame,
  type ErrorCode,
  type JsonObject,
  type Limits,
  MAX_DESCRIPTION_CHARS,
  MAX_FRAME_BYTES,
  MAX_RESULT_CHARS,
  type PageErrorCode,
  type PageFrame,
  type PageTool,
  type Pairing,
  parsePageFrame,
  type RelayFrame,
  type Role,
  type ToolAnnotations,
  truncate,
} from '@tabdock/protocol';
import type { RawData, WebSocket } from 'ws';
import type { ResolvedConfig } from './config.ts';
import type { Logger } from './log.ts';
import { SlidingWindowLimiter } from './rate-limit.ts';
import {
  digest,
  digestHex,
  formatPairingCode,
  newId,
  newPairingCode,
  newResumeToken,
  normalisePairingCode,
  sameDigest,
} from './secrets.ts';
import type {
  AttachmentRecord,
  AttachRequestRecord,
  AuditOutcome,
  PageRecord,
  PageState,
  RelayStore,
} from './store.ts';

type FrameOf<T extends PageFrame['t']> = Extract<PageFrame, { t: T }>;

/** Who is asking, as the MCP side established it. */
export interface CallerIdentity {
  userId: string;
  displayName: string;
  client: ClientInfo | null;
  /** The HTTP peer address, for per-address rate limits. */
  address: string;
}

export interface HubError {
  kind: 'error';
  code: ErrorCode;
  message: string;
}

export type PairOutcome =
  { kind: 'attached'; pageId: string; origin: string; role: Role; existing: boolean } | HubError;

export interface PageListing {
  page: string;
  origin: string;
  title: string;
  role: Role;
  state: PageState;
  toolCount: number;
}

export interface ToolListing {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonObject;
  annotations: ToolAnnotations;
  allowed: boolean;
}

export type ToolsOutcome =
  { kind: 'tools'; pageId: string; origin: string; role: Role; tools: ToolListing[] } | HubError;

export type CallOutcome =
  | { kind: 'ok'; origin: string; content: string }
  /** The page's handler failed; its message is page-supplied text. */
  | { kind: 'tool_error'; origin: string; message: string }
  /** The MCP client abandoned the call. */
  | { kind: 'cancelled' }
  | HubError;

export type DetachOutcome = { kind: 'detached'; pageId: string } | HubError;

interface InflightCall {
  userId: string;
  settle: (outcome: CallOutcome) => void;
}

interface Conn {
  ws: WebSocket;
  origin: string;
  address: string;
  pageId: string | null;
  closing: boolean;
  helloTimer: NodeJS.Timeout | null;
  pingTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  inflight: Map<string, InflightCall>;
}

const CLOSE_POLICY = 1008;
const CLOSE_GOING_AWAY = 1001;
/** A newer socket resumed this page's session. */
export const CLOSE_RESUMED_ELSEWHERE = CLOSE_REPLACED;
const CLOSE_GRACE_MS = 2000;
const MAX_ROSTER_CLIENTS = 20;

/**
 * Page error codes become SPEC section 7 codes. tool_error is not here: it
 * stays a labelled page result. The messages are the relay's own, so no page
 * text reaches the client without the untrusted header.
 */
const PAGE_ERRORS: Record<Exclude<PageErrorCode, 'tool_error'>, HubError> = {
  tool_not_found: { kind: 'error', code: 'tool_not_found', message: 'the page has no such tool' },
  role_denied: {
    kind: 'error',
    code: 'role_denied',
    message: 'the page refused this call for your role',
  },
  denied_by_operator: {
    kind: 'error',
    code: 'denied_by_operator',
    message: 'the page operator denied this call',
  },
  cancelled: { kind: 'error', code: 'timeout', message: 'the page cancelled the call' },
  timeout: { kind: 'error', code: 'timeout', message: 'the call ran out of time on the page' },
  page_busy: { kind: 'error', code: 'page_busy', message: 'the page is busy; try again shortly' },
};

function hubError(code: ErrorCode, message: string): HubError {
  return { kind: 'error', code, message };
}

function notAttached(pageId: string): HubError {
  return hubError('not_attached', `you are not attached to page ${pageId}`);
}

function rawToText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function sameClient(a: ClientInfo, b: ClientInfo): boolean {
  return a.name === b.name && a.version === b.version;
}

/** A page's inputSchema longer than this once serialised, after its text is cut, is replaced (S9). */
export const MAX_SCHEMA_CHARS = 8192;
/**
 * Deeper than any real input schema. JSON.stringify recurses, so a schema nested
 * a few thousand levels deep would break every listing that serialises it.
 */
export const MAX_SCHEMA_DEPTH = 64;
/**
 * Schema keywords that clients show as prose. A string there is cut like any
 * other; anything else is replaced, because an array or object there would put
 * several capped strings into what a client shows as one description (S10).
 */
const SCHEMA_TEXT_KEYS = new Set(['description', 'title']);
/**
 * Keywords whose value maps names (property names, definition names, patterns)
 * to schemas: a "title" key in there is a property called title, not prose, and
 * must keep its schema.
 */
const SCHEMA_NAME_MAP_KEYS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependentRequired',
  'dependencies',
]);
/** Keywords whose value is instance data, where keys mean nothing to JSON Schema. */
const SCHEMA_DATA_KEYS = new Set(['enum', 'const', 'default', 'examples']);

/** What a value is to JSON Schema, so keyword rules apply only where keys are keywords. */
type SchemaPosition = 'schema' | 'names' | 'data';

class SchemaTooDeep extends Error {}
class SchemaKeyTooLong extends Error {}

/**
 * Every string anywhere in a schema is page text: enum values, defaults,
 * examples, patterns and comments reach the model as surely as descriptions do,
 * so all of them are cut to the description cap (S10).
 */
function cutSchemaText(value: unknown, depth: number, position: SchemaPosition): unknown {
  if (depth > MAX_SCHEMA_DEPTH) throw new SchemaTooDeep();
  if (typeof value === 'string') return truncate(value, MAX_DESCRIPTION_CHARS).text;
  if (Array.isArray(value)) return value.map((item) => cutSchemaText(item, depth + 1, position));
  if (typeof value !== 'object' || value === null) return value;
  // fromEntries defines own properties, so a "__proto__" key stays a plain key.
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      // A key cannot be cut without changing what it names, so a long one removes the schema.
      if (key.length > MAX_DESCRIPTION_CHARS) throw new SchemaKeyTooLong();
      return [key, cutSchemaEntry(key, item, depth + 1, position)];
    }),
  );
}

function cutSchemaEntry(
  key: string,
  item: unknown,
  depth: number,
  position: SchemaPosition,
): unknown {
  if (position === 'names') return cutSchemaText(item, depth, 'schema');
  if (position === 'data') return cutSchemaText(item, depth, 'data');
  if (SCHEMA_TEXT_KEYS.has(key) && typeof item !== 'string') {
    return `[tabdock: non-string ${key} removed]`;
  }
  const next = SCHEMA_NAME_MAP_KEYS.has(key)
    ? 'names'
    : SCHEMA_DATA_KEYS.has(key)
      ? 'data'
      : 'schema';
  return cutSchemaText(item, depth, next);
}

function removedSchema(why: string): JsonObject {
  return { type: 'object', description: `[tabdock: schema removed, ${why}]` };
}

/**
 * Page text in a schema is capped like a description (S10), and a schema too
 * big or too deep to pass along, or with a key too long to pass, is replaced by
 * a stub that says so (S9).
 */
function cutSchema(schema: JsonObject): JsonObject {
  let cut: JsonObject;
  try {
    cut = cutSchemaText(schema, 0, 'schema') as JsonObject;
  } catch (error) {
    if (error instanceof SchemaTooDeep) {
      return removedSchema(`nested more than ${String(MAX_SCHEMA_DEPTH)} levels deep`);
    }
    if (error instanceof SchemaKeyTooLong) {
      return removedSchema(`a key longer than ${String(MAX_DESCRIPTION_CHARS)} characters`);
    }
    throw error;
  }
  const size = JSON.stringify(cut).length;
  return size > MAX_SCHEMA_CHARS ? removedSchema(`${String(size)} characters`) : cut;
}

/** Every page-written string in a tool is capped once, as it arrives, before any client sees it. */
function cutTool(tool: PageTool): PageTool {
  return {
    ...tool,
    description: truncate(tool.description, MAX_DESCRIPTION_CHARS).text,
    inputSchema: cutSchema(tool.inputSchema),
  };
}

export class PageHub {
  readonly #config: ResolvedConfig;
  readonly #store: RelayStore;
  readonly #log: Logger;
  readonly #conns = new Set<Conn>();
  readonly #live = new Map<string, Conn>();
  readonly #pairingTimers = new Map<string, NodeJS.Timeout>();
  /** asleep to gone, then gone to forgotten. */
  readonly #lifecycleTimers = new Map<string, NodeJS.Timeout>();
  readonly #requestTimers = new Map<string, NodeJS.Timeout>();
  /** Every pair_page waiting on a request, by requestId: a retry or a second device joins the first. */
  readonly #pairWaiters = new Map<string, Set<(outcome: PairOutcome) => void>>();
  readonly #userLimiter: SlidingWindowLimiter;
  readonly #addressLimiter: SlidingWindowLimiter;
  #closed = false;

  constructor(config: ResolvedConfig, store: RelayStore, log: Logger) {
    this.#config = config;
    this.#store = store;
    this.#log = log;
    const { pairAttemptsPerUser, pairAttemptsPerAddress, windowMs } = config.rateLimits;
    this.#userLimiter = new SlidingWindowLimiter(pairAttemptsPerUser, windowMs);
    this.#addressLimiter = new SlidingWindowLimiter(pairAttemptsPerAddress, windowMs);
  }

  // Page side

  /** Takes a socket that already passed the origin and subprotocol checks. */
  acceptSocket(ws: WebSocket, origin: string, address: string): void {
    if (this.#closed) {
      ws.close(CLOSE_GOING_AWAY, 'relay shutting down');
      return;
    }
    const conn: Conn = {
      ws,
      origin,
      address,
      pageId: null,
      closing: false,
      helloTimer: null,
      pingTimer: null,
      idleTimer: null,
      inflight: new Map(),
    };
    this.#conns.add(conn);
    conn.helloTimer = setTimeout(() => {
      this.#log.info('closing page socket: no hello in time', { origin, address });
      this.#closeSocket(conn, CLOSE_POLICY, 'hello timeout');
    }, this.#config.timings.helloTimeoutMs);
    conn.helloTimer.unref();
    ws.on('message', (data, isBinary) => {
      this.#onMessage(conn, data, isBinary);
    });
    ws.on('close', (code) => {
      this.#onClose(conn, code);
    });
    ws.on('error', (error) => {
      this.#log.warn('page socket error', { pageId: conn.pageId, error });
    });
  }

  #onMessage(conn: Conn, data: RawData, isBinary: boolean): void {
    if (conn.closing) return;
    conn.idleTimer?.refresh();
    if (isBinary) {
      this.#log.warn('closing page socket: binary frame', { pageId: conn.pageId });
      this.#closeSocket(conn, CLOSE_POLICY, 'binary frames are not accepted');
      return;
    }
    const parsed = parsePageFrame(rawToText(data));
    if (parsed.kind === 'unknown') {
      this.#log.warn('ignored a frame of unknown type', {
        pageId: conn.pageId,
        frameType: parsed.type,
      });
      return;
    }
    if (parsed.kind === 'invalid') {
      this.#log.warn('closing page socket: malformed frame', {
        pageId: conn.pageId,
        reason: parsed.reason,
      });
      this.#closeSocket(conn, CLOSE_POLICY, 'malformed frame');
      return;
    }
    const frame = parsed.frame;
    const pageId = conn.pageId;
    if (pageId === null) {
      if (frame.t === 'hello') {
        this.#hello(conn, frame);
      } else {
        this.#log.warn('closing page socket: first frame was not hello', { frameType: frame.t });
        this.#closeSocket(conn, CLOSE_POLICY, 'first frame must be hello');
      }
      return;
    }
    switch (frame.t) {
      case 'hello':
        this.#log.warn('closing page socket: second hello', { pageId });
        this.#closeSocket(conn, CLOSE_POLICY, 'hello sent twice');
        return;
      case 'tools':
        this.#tools(pageId, frame);
        return;
      case 'attach_decision':
        this.#decision(pageId, frame);
        return;
      case 'set_role':
        this.#setRole(pageId, frame);
        return;
      case 'revoke':
        this.#revoke(conn, pageId, frame);
        return;
      case 'rotate_pairing':
        this.#rotateTicket(pageId, 'asked by page');
        return;
      case 'result':
        this.#result(conn, pageId, frame);
        return;
      case 'ping':
        this.#send(conn, { t: 'pong' });
        return;
      case 'pong':
        return;
    }
  }

  #hello(conn: Conn, frame: FrameOf<'hello'>): void {
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    const now = Date.now();
    let page: PageRecord | undefined;
    if (frame.resumeToken !== undefined) {
      const candidate = this.#store.pages.findByResumeTokenHash(digestHex(frame.resumeToken));
      if (candidate && candidate.state !== 'gone' && candidate.origin === conn.origin) {
        page = candidate;
      } else {
        // The token stays a secret even when it is refused; only the reason is logged.
        this.#log.warn('resume refused; starting a new page session', {
          origin: conn.origin,
          reason:
            candidate === undefined
              ? 'unknown token'
              : candidate.state === 'gone'
                ? 'page gone'
                : 'different origin',
        });
      }
    }

    const resumed = page !== undefined;
    if (page) {
      const previous = this.#live.get(page.pageId);
      if (previous && previous !== conn) {
        this.#live.delete(page.pageId);
        this.#failInflight(
          previous,
          hubError('page_asleep', 'the page reloaded before it answered'),
        );
        this.#closeSocket(previous, CLOSE_RESUMED_ELSEWHERE, 'session resumed elsewhere');
        // The reloaded page never saw these requests, so nobody is left to answer them.
        this.#dropRequests(page.pageId);
      }
      this.#clearTimer(this.#lifecycleTimers, page.pageId);
      // The adapter lists its tools again right after the welcome. Until then any
      // held here belong to a replaced socket, and a toolCount from them would
      // tell list_pages callers the page is ready while calls still wait.
      page.tools = [];
      page.toolsPending = true;
      page.title = frame.title;
      page.url = frame.url;
      page.adapterVersion = frame.adapterVersion;
      page.policy = frame.policy;
    } else {
      let pageId = newId('pg');
      while (this.#store.pages.get(pageId)) pageId = newId('pg');
      page = {
        pageId,
        origin: conn.origin,
        title: frame.title,
        url: frame.url,
        adapterVersion: frame.adapterVersion,
        policy: frame.policy,
        tools: [],
        toolsPending: false,
        state: 'awake',
        resumeTokenHash: '',
        connectedAt: now,
        asleepAt: null,
        goneAt: null,
        formerAttachments: [],
      };
    }

    // Every welcome rotates the token, so a copied token works at most once.
    const resumeToken = newResumeToken();
    page.resumeTokenHash = digestHex(resumeToken);
    page.state = 'awake';
    page.asleepAt = null;
    page.connectedAt = now;
    this.#store.pages.put(page);
    conn.pageId = page.pageId;
    this.#live.set(page.pageId, conn);

    this.#send(conn, {
      t: 'welcome',
      pageId: page.pageId,
      resumeToken,
      resumed,
      pairing: this.#issueTicket(page.pageId),
      roster: this.#roster(page.pageId),
      limits: this.#limits(),
    });
    this.#startHeartbeat(conn);
    this.#log.info('page connected', { pageId: page.pageId, origin: page.origin, resumed });
  }

  #limits(): Limits {
    const { timings } = this.#config;
    return {
      maxFrameBytes: MAX_FRAME_BYTES,
      maxResultChars: MAX_RESULT_CHARS,
      maxDescriptionChars: MAX_DESCRIPTION_CHARS,
      pingIntervalMs: timings.pingIntervalMs,
      idleTimeoutMs: timings.idleTimeoutMs,
      resumeWindowMs: timings.resumeWindowMs,
      attachRequestTtlMs: timings.attachRequestTtlMs,
    };
  }

  #startHeartbeat(conn: Conn): void {
    const { pingIntervalMs, idleTimeoutMs } = this.#config.timings;
    conn.pingTimer = setInterval(() => {
      this.#send(conn, { t: 'ping' });
    }, pingIntervalMs);
    conn.pingTimer.unref();
    conn.idleTimer = setTimeout(() => {
      this.#log.info('closing silent page socket', { pageId: conn.pageId });
      this.#closeSocket(conn, CLOSE_GOING_AWAY, 'idle timeout');
    }, idleTimeoutMs);
    conn.idleTimer.unref();
  }

  #tools(pageId: string, frame: FrameOf<'tools'>): void {
    const page = this.#store.pages.get(pageId);
    if (!page) return;
    // WebMCP itself refuses duplicate names, so a duplicate is a page bug: keep the first.
    const seen = new Set<string>();
    const tools: PageTool[] = [];
    for (const tool of frame.tools) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      tools.push(cutTool(tool));
    }
    if (tools.length !== frame.tools.length) {
      this.#log.warn('page listed a tool name twice; kept the first', { pageId });
    }
    page.tools = tools;
    page.toolsPending = false;
    this.#store.pages.put(page);
    this.#log.debug('page tools updated', { pageId, toolCount: tools.length });
  }

  #onClose(conn: Conn, code: number): void {
    this.#conns.delete(conn);
    this.#clearConnTimers(conn);
    const detached = code === CLOSE_DETACH;
    this.#failInflight(
      conn,
      detached
        ? hubError('page_gone', 'the page detached before it answered')
        : hubError('page_asleep', 'the page disconnected before it answered'),
    );
    const pageId = conn.pageId;
    // A socket replaced by a resumed one no longer speaks for its page.
    if (pageId === null || this.#live.get(pageId) !== conn) return;
    this.#live.delete(pageId);
    if (this.#closed) return;
    this.#sleep(pageId);
    // A deliberate detach will not come back, so skip the resume window.
    if (detached) {
      this.#log.info('page detached', { pageId });
      this.#gone(pageId);
    }
  }

  #sleep(pageId: string): void {
    const page = this.#store.pages.get(pageId);
    if (!page) return;
    page.state = 'asleep';
    page.asleepAt = Date.now();
    // Nobody can list or call an asleep page's tools, and the adapter sends them
    // again after the welcome on resume, so they are not held (up to a 1 MB frame
    // of them) for the whole resume window.
    page.tools = [];
    this.#store.pages.put(page);
    this.#store.tickets.deleteForPage(pageId);
    this.#clearTimer(this.#pairingTimers, pageId);
    this.#dropRequests(pageId);
    this.#setTimer(this.#lifecycleTimers, pageId, this.#config.timings.resumeWindowMs, () => {
      this.#gone(pageId);
    });
    this.#log.info('page asleep', { pageId });
  }

  #dropRequests(pageId: string): void {
    for (const request of this.#store.requests.listForPage(pageId)) {
      this.#endRequest(
        request.requestId,
        hubError(
          'page_asleep',
          'the page disconnected before the operator answered; pair again with the code it shows when it is back',
        ),
      );
    }
  }

  #gone(pageId: string): void {
    const page = this.#store.pages.get(pageId);
    if (page?.state !== 'asleep') return;
    const attachments = this.#store.attachments.listForPage(pageId);
    for (const attachment of attachments) this.#store.attachments.delete(pageId, attachment.userId);
    page.state = 'gone';
    page.goneAt = Date.now();
    page.resumeTokenHash = '';
    page.tools = [];
    page.formerAttachments = attachments.map(({ userId, role }) => ({ userId, role }));
    this.#store.pages.put(page);
    this.#setTimer(this.#lifecycleTimers, pageId, this.#config.timings.goneTombstoneMs, () => {
      this.#store.pages.delete(pageId);
      this.#log.debug('gone page forgotten', { pageId });
    });
    this.#log.info('page gone', { pageId, attachmentsDeleted: attachments.length });
  }

  // Pairing tickets

  #issueTicket(pageId: string): Pairing {
    const code = newPairingCode();
    const { pairingTtlMs } = this.#config.timings;
    const expiresAt = Date.now() + pairingTtlMs;
    this.#store.tickets.put({ pageId, codeHash: digest(code), expiresAt });
    this.#setTimer(this.#pairingTimers, pageId, pairingTtlMs, () => {
      this.#rotateTicket(pageId, 'expired');
    });
    return { code: formatPairingCode(code), expiresAt };
  }

  #rotateTicket(pageId: string, reason: string): void {
    const conn = this.#live.get(pageId);
    if (!conn || conn.closing) {
      this.#store.tickets.deleteForPage(pageId);
      this.#clearTimer(this.#pairingTimers, pageId);
      return;
    }
    this.#send(conn, { t: 'pairing', ...this.#issueTicket(pageId) });
    this.#log.debug('pairing code rotated', { pageId, reason });
  }

  /** Looks the code up by its hash, then confirms in constant time (S3). */
  #matchTicket(normalised: string, now: number): string | null {
    const hash = digest(normalised);
    const ticket = this.#store.tickets.findByCodeHash(hash.toString('hex'));
    if (!ticket || !sameDigest(ticket.codeHash, hash) || ticket.expiresAt <= now) return null;
    return ticket.pageId;
  }

  // Attachments

  #decision(pageId: string, frame: FrameOf<'attach_decision'>): void {
    const request = this.#store.requests.get(frame.requestId);
    // A page may only answer its own requests; anything else is stale or forged.
    if (request?.pageId !== pageId) {
      this.#log.warn('ignored a decision for an unknown attach request', { pageId });
      return;
    }
    if (!frame.allow) {
      this.#log.info('attach request denied', { pageId, userId: request.userId });
      this.#endRequest(request.requestId, {
        kind: 'error',
        code: 'denied_by_operator',
        message: 'the page operator denied the attach request',
      });
      return;
    }
    const attachment = this.#grant(request, frame.role ?? 'observer');
    const page = this.#store.pages.get(pageId);
    this.#endRequest(request.requestId, {
      kind: 'attached',
      pageId,
      origin: page?.origin ?? '',
      role: attachment.role,
      existing: false,
    });
  }

  #grant(
    request: Pick<AttachRequestRecord, 'pageId' | 'userId' | 'displayName' | 'client'>,
    wanted: Role,
  ): AttachmentRecord {
    const existing = this.#store.attachments.get(request.pageId, request.userId);
    if (existing) return existing;
    const attachment: AttachmentRecord = {
      pageId: request.pageId,
      userId: request.userId,
      displayName: request.displayName,
      role: this.#cappedRole(request.pageId, request.userId, wanted),
      grantedAt: Date.now(),
      lastUsedAt: null,
      expiresAt: null,
      clients: request.client ? [request.client] : [],
    };
    this.#store.attachments.put(attachment);
    this.#log.info('attached', {
      pageId: attachment.pageId,
      userId: attachment.userId,
      role: attachment.role,
    });
    this.#sendRoster(request.pageId);
    return attachment;
  }

  /** maxDrivers counts users, so one person's phone and laptop share a single driver seat. */
  #cappedRole(pageId: string, userId: string, wanted: Role): Role {
    if (wanted !== 'driver') return wanted;
    const page = this.#store.pages.get(pageId);
    const drivers = this.#store.attachments
      .listForPage(pageId)
      .filter((attachment) => attachment.role === 'driver' && attachment.userId !== userId).length;
    if (page && drivers >= page.policy.maxDrivers) {
      this.#log.info('driver limit reached; granting observer', { pageId, userId });
      return 'observer';
    }
    return 'driver';
  }

  #setRole(pageId: string, frame: FrameOf<'set_role'>): void {
    const attachment = this.#store.attachments.get(pageId, frame.userId);
    if (!attachment) {
      this.#log.warn('ignored set_role for a user who is not attached', { pageId });
      return;
    }
    const role = this.#cappedRole(pageId, frame.userId, frame.role);
    if (role !== attachment.role) {
      attachment.role = role;
      this.#store.attachments.put(attachment);
      this.#log.info('role changed', { pageId, userId: frame.userId, role });
    }
    // Sent even when nothing changed, so the page shows a capped grant as it really is.
    this.#sendRoster(pageId);
  }

  #revoke(conn: Conn, pageId: string, frame: FrameOf<'revoke'>): void {
    const targets =
      frame.userId === '*'
        ? this.#store.attachments.listForPage(pageId)
        : [this.#store.attachments.get(pageId, frame.userId)].filter(
            (attachment) => attachment !== undefined,
          );
    const users = new Set(targets.map((attachment) => attachment.userId));
    if (frame.userId !== '*') users.add(frame.userId);
    for (const attachment of targets) this.#store.attachments.delete(pageId, attachment.userId);
    // Revocation is immediate (S8): calls already on the page are cancelled now.
    this.#cancelCallsOf(conn, users, 'revoked', 'the page operator revoked your attachment');
    for (const request of this.#store.requests.listForPage(pageId)) {
      if (frame.userId === '*' || users.has(request.userId)) {
        this.#endRequest(request.requestId, {
          kind: 'error',
          code: 'denied_by_operator',
          message: 'the page operator revoked access',
        });
      }
    }
    this.#log.info('attachments revoked', { pageId, count: targets.length });
    this.#sendRoster(pageId);
  }

  #roster(pageId: string): AttachmentView[] {
    return this.#store.attachments.listForPage(pageId).map((attachment) => ({
      userId: attachment.userId,
      displayName: attachment.displayName,
      role: attachment.role,
      grantedAt: attachment.grantedAt,
      lastUsedAt: attachment.lastUsedAt,
      expiresAt: attachment.expiresAt,
      clients: attachment.clients.slice(0, MAX_ROSTER_CLIENTS),
    }));
  }

  #sendRoster(pageId: string): void {
    const conn = this.#live.get(pageId);
    if (conn) this.#send(conn, { t: 'roster', attachments: this.#roster(pageId) });
  }

  #endRequest(requestId: string, outcome: PairOutcome): void {
    this.#store.requests.delete(requestId);
    this.#clearTimer(this.#requestTimers, requestId);
    for (const waiter of [...(this.#pairWaiters.get(requestId) ?? [])]) waiter(outcome);
  }

  // Calls

  #result(conn: Conn, pageId: string, frame: FrameOf<'result'>): void {
    // Looked up on this socket only, so one page cannot answer another page's call.
    const call = conn.inflight.get(frame.callId);
    if (!call) {
      this.#log.debug('ignored a late or unknown result', { pageId });
      return;
    }
    const origin = conn.origin;
    if (frame.ok) {
      call.settle({ kind: 'ok', origin, content: frame.content ?? '' });
      return;
    }
    const error = frame.error;
    if (!error || error.code === 'tool_error') {
      call.settle({
        kind: 'tool_error',
        origin,
        message: error?.message ?? 'the tool failed without a message',
      });
      return;
    }
    call.settle(PAGE_ERRORS[error.code]);
  }

  #cancelCallsOf(
    conn: Conn,
    users: ReadonlySet<string>,
    reason: 'revoked' | 'client',
    message: string,
  ): void {
    for (const [callId, call] of [...conn.inflight]) {
      if (!users.has(call.userId)) continue;
      this.#send(conn, { t: 'cancel', callId, reason });
      call.settle(hubError('not_attached', message));
    }
  }

  #failInflight(conn: Conn, outcome: CallOutcome): void {
    for (const call of [...conn.inflight.values()]) call.settle(outcome);
  }

  // MCP side

  listPages(userId: string): PageListing[] {
    const listings: PageListing[] = [];
    for (const attachment of this.#store.attachments.listForUser(userId)) {
      const page = this.#store.pages.get(attachment.pageId);
      if (!page) continue;
      listings.push({
        page: page.pageId,
        origin: page.origin,
        title: page.title,
        role: attachment.role,
        state: page.state,
        toolCount: page.tools.length,
      });
    }
    for (const page of this.#store.pages.all()) {
      if (page.state !== 'gone') continue;
      const former = page.formerAttachments.find((entry) => entry.userId === userId);
      if (!former) continue;
      listings.push({
        page: page.pageId,
        origin: page.origin,
        title: page.title,
        role: former.role,
        state: 'gone',
        toolCount: 0,
      });
    }
    return listings;
  }

  #access(
    userId: string,
    pageId: string,
  ): { kind: 'ok'; page: PageRecord; attachment: AttachmentRecord; conn: Conn } | HubError {
    const attachment = this.#store.attachments.get(pageId, userId);
    const page = this.#store.pages.get(pageId);
    if (attachment && page) {
      const conn = this.#live.get(pageId);
      if (page.state === 'awake' && conn && !conn.closing) {
        if (page.toolsPending) {
          return hubError(
            'page_asleep',
            'the page is reconnecting and its tools are not listed yet; try again in a moment',
          );
        }
        return { kind: 'ok', page, attachment, conn };
      }
      return hubError(
        'page_asleep',
        'the page is asleep (its tab disconnected); it keeps your attachment if it comes back within the resume window',
      );
    }
    if (page?.state === 'gone' && page.formerAttachments.some((entry) => entry.userId === userId)) {
      return hubError(
        'page_gone',
        'the page closed and did not come back; its attachments are gone',
      );
    }
    return notAttached(pageId);
  }

  listPageTools(userId: string, pageId: string): ToolsOutcome {
    const access = this.#access(userId, pageId);
    if (access.kind === 'error') return access;
    const { page, attachment } = access;
    return {
      kind: 'tools',
      pageId,
      origin: page.origin,
      role: attachment.role,
      tools: page.tools.map((tool) => {
        const annotations = tool.annotations ?? {};
        return {
          name: tool.name,
          ...(tool.title === undefined ? {} : { title: tool.title }),
          // S10: the description and schema were already cut when the tools frame arrived (cutTool).
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations,
          allowed: attachment.role === 'driver' || annotations.readOnlyHint === true,
        };
      }),
    };
  }

  async pairPage(caller: CallerIdentity, code: string, signal: AbortSignal): Promise<PairOutcome> {
    const now = Date.now();
    if (
      !this.#userLimiter.allows(caller.userId, now) ||
      !this.#addressLimiter.allows(caller.address, now)
    ) {
      this.#log.warn('pairing attempt rate limited', {
        userId: caller.userId,
        address: caller.address,
      });
      return hubError('rate_limited', 'too many pairing attempts; wait a minute and try again');
    }
    this.#userLimiter.record(caller.userId, now);
    this.#addressLimiter.record(caller.address, now);

    const normalised = normalisePairingCode(code);
    const pageId = normalised === null ? null : this.#matchTicket(normalised, now);
    const page = pageId === null ? undefined : this.#store.pages.get(pageId);
    const conn = pageId === null ? undefined : this.#live.get(pageId);
    // Wrong and expired look the same: telling them apart would confirm a code once existed.
    if (!page || page.state !== 'awake' || !conn || conn.closing) {
      this.#log.info('pairing refused: no live code matched', { userId: caller.userId });
      return hubError('pairing_expired', 'code is invalid or expired');
    }

    // Single use: the matched code dies here and the page gets a fresh one.
    this.#rotateTicket(page.pageId, 'used');

    const existing = this.#store.attachments.get(page.pageId, caller.userId);
    if (existing) {
      this.#touchClients(existing, caller.client);
      return {
        kind: 'attached',
        pageId: page.pageId,
        origin: page.origin,
        role: existing.role,
        existing: true,
      };
    }

    const request = {
      pageId: page.pageId,
      userId: caller.userId,
      displayName: caller.displayName,
      client: caller.client,
    };
    if (page.policy.autoApprove === 'observer') {
      const attachment = this.#grant(request, 'observer');
      return {
        kind: 'attached',
        pageId: page.pageId,
        origin: page.origin,
        role: attachment.role,
        existing: false,
      };
    }

    // One person has at most one request per page. A retry after the wait ran
    // out, or the same person on a second device, waits on the request the
    // operator already sees, so the page never gets duplicates to answer.
    const pending = this.#store.requests
      .listForPage(page.pageId)
      .find((candidate) => candidate.userId === caller.userId);
    if (pending) {
      this.#log.info('pair_page joined a pending attach request', {
        pageId: pending.pageId,
        userId: pending.userId,
        requestId: pending.requestId,
      });
      return this.#waitForDecision(pending, signal);
    }

    const { attachRequestTtlMs } = this.#config.timings;
    const record: AttachRequestRecord = {
      ...request,
      requestId: newId('rq'),
      via: 'code',
      expiresAt: now + attachRequestTtlMs,
    };
    this.#store.requests.put(record);
    this.#setTimer(this.#requestTimers, record.requestId, attachRequestTtlMs, () => {
      this.#log.info('attach request expired unanswered', {
        pageId: record.pageId,
        userId: record.userId,
      });
      this.#endRequest(record.requestId, {
        kind: 'error',
        code: 'timeout',
        message: 'the operator did not answer in time, so the request was denied',
      });
    });
    this.#send(conn, {
      t: 'attach_request',
      requestId: record.requestId,
      user: { userId: record.userId, displayName: record.displayName },
      via: record.via,
      client: record.client,
      expiresAt: record.expiresAt,
    });
    this.#log.info('attach request sent', {
      pageId: record.pageId,
      userId: record.userId,
      requestId: record.requestId,
    });
    return this.#waitForDecision(record, signal);
  }

  #waitForDecision(record: AttachRequestRecord, signal: AbortSignal): Promise<PairOutcome> {
    return new Promise((resolve) => {
      const finish = (outcome: PairOutcome): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        const waiters = this.#pairWaiters.get(record.requestId);
        waiters?.delete(finish);
        if (waiters?.size === 0) this.#pairWaiters.delete(record.requestId);
        resolve(outcome);
      };
      // Past the wait the request stays open (ADR 0005): a late approval still attaches.
      const timer = setTimeout(() => {
        finish(
          hubError(
            'timeout',
            `the operator has not answered yet. The request stays open on the page until ${new Date(record.expiresAt).toISOString()}; if they approve it, the page will show up in list_pages.`,
          ),
        );
      }, this.#config.timings.pairWaitMs);
      timer.unref();
      const onAbort = (): void => {
        finish(
          hubError('timeout', 'the client stopped waiting; the request stays open on the page'),
        );
      };
      let waiters = this.#pairWaiters.get(record.requestId);
      if (!waiters) {
        waiters = new Set();
        this.#pairWaiters.set(record.requestId, waiters);
      }
      waiters.add(finish);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async callPageTool(
    caller: CallerIdentity,
    pageId: string,
    tool: string,
    args: JsonObject,
    signal: AbortSignal,
  ): Promise<CallOutcome> {
    const started = Date.now();
    let auditOutcome: AuditOutcome = 'relay_error';
    try {
      const outcome = await this.#call(caller, pageId, tool, args, signal);
      auditOutcome = outcome.kind === 'error' ? outcome.code : outcome.kind;
      return outcome;
    } catch (error) {
      // The SDK still answers the client with an error result; the log keeps the cause.
      this.#log.error('call failed inside the relay', { pageId, error });
      throw error;
    } finally {
      // In finally, so every attempt leaves a record even when the relay itself fails (S7).
      const record = {
        at: started,
        pageId,
        origin: this.#store.pages.get(pageId)?.origin ?? null,
        userId: caller.userId,
        client: caller.client,
        tool,
        outcome: auditOutcome,
        durationMs: Date.now() - started,
      };
      this.#store.audit.append(record);
      // Arguments are never part of the record (S7), and the logger redacts them anyway.
      this.#log.info('call', { audit: record });
    }
  }

  #call(
    caller: CallerIdentity,
    pageId: string,
    toolName: string,
    args: JsonObject,
    signal: AbortSignal,
  ): Promise<CallOutcome> {
    const access = this.#access(caller.userId, pageId);
    if (access.kind === 'error') return Promise.resolve(access);
    const { page, attachment, conn } = access;
    const tool = page.tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      return Promise.resolve(
        hubError('tool_not_found', `page ${pageId} has no tool named ${toolName}`),
      );
    }
    // S5, relay half: observers run only tools the page marked read-only.
    if (attachment.role === 'observer' && tool.annotations?.readOnlyHint !== true) {
      return Promise.resolve(
        hubError(
          'role_denied',
          `you are an observer on this page, and ${toolName} is not marked read-only`,
        ),
      );
    }

    const callId = newId('cl');
    const { callDeadlineMs: deadlineMs, callDeadlineGraceMs } = this.#config.timings;
    let encoded: string;
    try {
      encoded = encodeFrame({
        t: 'invoke',
        callId,
        tool: tool.name,
        arguments: args,
        caller: {
          userId: caller.userId,
          displayName: caller.displayName,
          client: caller.client,
          role: attachment.role,
        },
        deadlineMs,
      });
    } catch {
      // JSON.stringify recurses: arguments nested a few thousand levels deep overflow the stack.
      return Promise.resolve(
        hubError('invalid_arguments', 'the arguments could not be encoded for the page link'),
      );
    }
    // The adapter drops any frame over the cap by closing the socket, so an
    // oversized call must stop here rather than knock the page offline.
    if (Buffer.byteLength(encoded, 'utf8') > MAX_FRAME_BYTES) {
      return Promise.resolve(
        hubError(
          'invalid_arguments',
          `the arguments are too large to forward; one page link frame carries at most ${String(MAX_FRAME_BYTES)} bytes`,
        ),
      );
    }
    attachment.lastUsedAt = Date.now();
    this.#touchClients(attachment, caller.client);

    return new Promise((resolve) => {
      const finish = (outcome: CallOutcome): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        conn.inflight.delete(callId);
        resolve(outcome);
      };
      // The page's deadline starts later, when the invoke arrives, and its answer
      // then (denied_by_operator for an unanswered confirmation, S6) must reach
      // the client; the grace keeps this timer from always winning that race.
      const timer = setTimeout(() => {
        this.#send(conn, { t: 'cancel', callId, reason: 'timeout' });
        finish(hubError('timeout', `the page did not answer within ${String(deadlineMs)} ms`));
      }, deadlineMs + callDeadlineGraceMs);
      timer.unref();
      const onAbort = (): void => {
        this.#send(conn, { t: 'cancel', callId, reason: 'client' });
        finish({ kind: 'cancelled' });
      };
      conn.inflight.set(callId, { userId: caller.userId, settle: finish });
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      conn.ws.send(encoded);
    });
  }

  /** Records the calling client on the attachment, newest first; a new client changes the roster. */
  #touchClients(attachment: AttachmentRecord, client: ClientInfo | null): void {
    let changed = false;
    if (client) {
      const index = attachment.clients.findIndex((seen) => sameClient(seen, client));
      if (index === -1) changed = true;
      else attachment.clients.splice(index, 1);
      attachment.clients.unshift(client);
      attachment.clients.length = Math.min(attachment.clients.length, MAX_ROSTER_CLIENTS);
    }
    this.#store.attachments.put(attachment);
    if (changed) this.#sendRoster(attachment.pageId);
  }

  detachPage(userId: string, pageId: string): DetachOutcome {
    const attachment = this.#store.attachments.get(pageId, userId);
    if (attachment) {
      this.#store.attachments.delete(pageId, userId);
      const conn = this.#live.get(pageId);
      if (conn) {
        this.#cancelCallsOf(conn, new Set([userId]), 'client', 'you detached from this page');
      }
      this.#sendRoster(pageId);
      this.#log.info('detached', { pageId, userId });
      return { kind: 'detached', pageId };
    }
    const page = this.#store.pages.get(pageId);
    if (page?.state === 'gone') {
      const remaining = page.formerAttachments.filter((entry) => entry.userId !== userId);
      if (remaining.length !== page.formerAttachments.length) {
        page.formerAttachments = remaining;
        this.#store.pages.put(page);
        return { kind: 'detached', pageId };
      }
    }
    return notAttached(pageId);
  }

  // Plumbing

  #send(conn: Conn, frame: RelayFrame): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    conn.ws.send(encodeFrame(frame));
  }

  #closeSocket(conn: Conn, code: number, reason: string, graceMs = CLOSE_GRACE_MS): void {
    if (conn.closing) return;
    conn.closing = true;
    this.#clearConnTimers(conn);
    conn.ws.close(code, reason);
    // A peer that never completes the closing handshake is cut off.
    const kill = setTimeout(() => {
      conn.ws.terminate();
    }, graceMs);
    kill.unref();
    conn.ws.once('close', () => {
      clearTimeout(kill);
    });
  }

  #clearConnTimers(conn: Conn): void {
    for (const timer of [conn.helloTimer, conn.pingTimer, conn.idleTimer]) {
      if (timer) clearTimeout(timer);
    }
    conn.helloTimer = null;
    conn.pingTimer = null;
    conn.idleTimer = null;
  }

  #setTimer(map: Map<string, NodeJS.Timeout>, key: string, ms: number, run: () => void): void {
    this.#clearTimer(map, key);
    const timer = setTimeout(() => {
      map.delete(key);
      run();
    }, ms);
    timer.unref();
    map.set(key, timer);
  }

  #clearTimer(map: Map<string, NodeJS.Timeout>, key: string): void {
    const timer = map.get(key);
    if (timer) clearTimeout(timer);
    map.delete(key);
  }

  /** Cancels everything in flight, closes every page socket and stops every timer. */
  async shutdown(): Promise<void> {
    this.#closed = true;
    for (const waiter of [...this.#pairWaiters.values()].flatMap((waiters) => [...waiters])) {
      waiter(hubError('timeout', 'the relay is shutting down'));
    }
    const closing: Promise<void>[] = [];
    for (const conn of [...this.#conns]) {
      for (const callId of [...conn.inflight.keys()]) {
        this.#send(conn, { t: 'cancel', callId, reason: 'shutdown' });
      }
      this.#failInflight(conn, hubError('page_asleep', 'the relay is shutting down'));
      if (conn.ws.readyState === conn.ws.CLOSED) continue;
      closing.push(
        new Promise((resolve) => {
          conn.ws.once('close', () => {
            resolve();
          });
        }),
      );
      this.#closeSocket(conn, CLOSE_GOING_AWAY, 'relay shutting down', 500);
    }
    for (const map of [this.#pairingTimers, this.#lifecycleTimers, this.#requestTimers]) {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    }
    await Promise.all(closing);
  }
}

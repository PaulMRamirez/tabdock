// The page hub: every page socket, pairing ticket, attach request, attachment
// and call passes through here. The MCP side (mcp.ts) asks questions on behalf
// of an authenticated user; every answer is computed from that user's own
// attachments, so an unknown page and someone else's page look the same (S13).
// Mutating calls wait in a per-page queue and run one at a time in arrival
// order (SPEC section 5); read-only calls go straight to the page. The section 9
// limits and attachment idle expiry follow ADR 0009, argument checks ADR 0008
// and ADR 0010: they run in a worker thread with a time budget, never here.

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
import { createHash } from 'node:crypto';
import type { RawData, WebSocket } from 'ws';
import {
  ArgumentChecker,
  type PreparedSchema,
  prepareForCheck,
  type UncheckedReason,
} from './argument-checker.ts';
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
  newSingleUseSecret,
  normalisePairingCode,
  sameDigest,
  SINGLE_USE_SECRET_PATTERN,
} from './secrets.ts';
import type { CallMarks, SpikeHooks } from './spike.ts';
import type {
  AttachmentRecord,
  AttachRequestRecord,
  AuditOutcome,
  PageRecord,
  PageState,
  RelayStore,
  SingleUseTicketRecord,
} from './store.ts';

type FrameOf<T extends PageFrame['t']> = Extract<PageFrame, { t: T }>;

/** Who is asking, as the MCP side established it. */
export interface CallerIdentity {
  userId: string;
  displayName: string;
  client: ClientInfo | null;
}

export interface HubError {
  kind: 'error';
  code: ErrorCode;
  message: string;
}

export type PairOutcome =
  { kind: 'attached'; pageId: string; origin: string; role: Role; existing: boolean } | HubError;

/** What /pair shows for a live QR nonce before anyone claims it; looking uses nothing up. */
export interface PairPreview {
  /** From the page socket's Origin header (S1), never from the page's own words. */
  origin: string;
  /** Written by the page (S10): capped here, and shown as the page's own words. */
  title: string;
  titleCut: boolean;
  /** The code the widget shows beside the QR code, for the person to compare. */
  code: string;
  expiresAt: number;
}

/**
 * A QR claim: refused at once, or claimed, with `settled` resolving when the
 * operator decides, the request runs out, or the page goes (ADR 0005's wait
 * does not apply: the phone polls instead of holding a request open).
 */
export type ClaimOutcome =
  HubError | { kind: 'claimed'; pageId: string; settled: Promise<PairOutcome> };

/** A page title longer than this is cut before /pair shows it (S10). */
export const MAX_PAIR_TITLE_CHARS = 120;

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The first `max` characters as people see them, so no emoji or accent is cut in half. */
function firstCharacters(text: string, max: number): { text: string; cut: boolean } {
  let count = 0;
  for (const { index } of GRAPHEMES.segment(text)) {
    if (count === max) return { text: text.slice(0, index), cut: true };
    count += 1;
  }
  return { text, cut: false };
}

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

/** Why a page socket was refused before it was upgraded. */
export interface SocketRefusal {
  status: 429 | 503;
  message: string;
}

/** One call_page_tool call from arrival until it settles. */
interface PendingCall {
  callId: string;
  pageId: string;
  caller: CallerIdentity;
  toolName: string;
  args: JsonObject;
  mutating: boolean;
  /** Its deadline counts from here, however long it waits in the queue. */
  arrivedAt: number;
  /**
   * Whether its arrival sent the page a roster for the moved expiry. That
   * roster could not name its client, which is named only once every check
   * has passed, so a new name may follow it at once (#nameClient).
   */
  rosterAtArrival: boolean;
  /** Whether it waited behind another call; one that went straight out keeps its whole deadline. */
  waited: boolean;
  /**
   * A mutating call holds its place in the queue from arrival while its
   * argument check runs; the queue stops at it until the check answers.
   */
  checking: boolean;
  /** The socket its invoke went out on; null while it waits in the queue. */
  conn: Conn | null;
  /** Filled in for the spike's timing (spike.ts); null otherwise. */
  marks: CallMarks | null;
  timer: NodeJS.Timeout | null;
  done: boolean;
  settle: (outcome: CallOutcome) => void;
}

/** A page's mutating calls: at most one on the page, the rest waiting in arrival order. */
interface PageQueue {
  running: PendingCall | null;
  waiting: PendingCall[];
}

interface ArgCheckEntry {
  /** The page's own schema prepared for the check worker; null when it is too deep to check. */
  schema: PreparedSchema | null;
  /** Set once the worker could not compile it; calls then go on unchecked without asking. */
  uncompilable: boolean;
  /** Why calls to this tool already went unchecked, so each reason is logged once. */
  warned: Set<UncheckedReason>;
}

/**
 * One tool as the last tools frame left it. A page re-lists every tool on each
 * change, so a tool whose JSON is the same as before reuses all of this and
 * costs the main thread no walk at all.
 */
interface ListedTool {
  /**
   * A hash of the tool's JSON as the page sent it; null when it was not walked
   * (a node cap) or could not be serialised, so it is never reused.
   */
  raw: string | null;
  /** Listed with a stub for a node cap, the tool's or the frame's; a later walk keeps nothing from it. */
  capped: boolean;
  /** As clients are shown it, cut (S10). */
  tool: PageTool;
  check: ArgCheckEntry;
}

/** Logged once per tool and reason; fixed words, never the schema or the arguments. */
const UNCHECKED_WARNINGS: Record<UncheckedReason, string> = {
  failed: 'an argument check failed to run; calls it fails on go to the page unchecked',
  timeout: 'an argument check ran out of time; calls it overruns go to the page unchecked',
  busy: 'an argument check could not start in time behind another; calls go to the page unchecked while the checker is busy',
  unavailable:
    'no argument check worker was ready; calls go to the page unchecked until one starts',
};

function sameSchema(a: PreparedSchema | null, b: PreparedSchema | null): boolean {
  return a === null || b === null ? a === b : a.hash === b.hash;
}

/** The page sessions one remote address created and still holds, awake or asleep. */
interface AddressSessions {
  pages: Set<string>;
  /** Those asleep, oldest asleep first: a page joins at the end when it falls asleep. */
  asleep: Set<string>;
}

function firstOf(set: ReadonlySet<string> | undefined): string | undefined {
  return set?.values().next().value;
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
  /** Calls whose invoke went out on this socket and that have not settled yet. */
  inflight: Map<string, PendingCall>;
  /** When this socket's recent tools frames arrived, for toolsFramesPerSocket. */
  toolsFrames: number[];
}

const CLOSE_POLICY = 1008;
const CLOSE_GOING_AWAY = 1001;
/** The standard "try again later": a page refused for want of room reconnects with backoff. */
const CLOSE_TRY_AGAIN_LATER = 1013;
/** A newer socket resumed this page's session. */
export const CLOSE_RESUMED_ELSEWHERE = CLOSE_REPLACED;
const CLOSE_GRACE_MS = 2000;
const MAX_ROSTER_CLIENTS = 20;
/**
 * Each call moves its attachment's expiresAt, but the roster carrying it is
 * re-sent at most this often for that alone: a client calling fast must not
 * keep the operator's roster rows moving under their pointer.
 */
export const EXPIRY_ROSTER_REFRESH_MS = 60_000;

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

/** "8 hours", "30 minutes", "300 ms": the unit that divides evenly, for messages. */
export function formatDuration(ms: number): string {
  for (const [size, unit] of [
    [3_600_000, 'hour'],
    [60_000, 'minute'],
    [1000, 'second'],
  ] as const) {
    if (ms % size === 0) {
      const count = ms / size;
      return `${String(count)} ${unit}${count === 1 ? '' : 's'}`;
    }
  }
  return `${String(ms)} ms`;
}

/**
 * The page a hello url names: its origin and path, whatever the query or
 * fragment. Text that is not an absolute URL names its page by what comes
 * before any '?' or '#', so it still matches itself.
 */
function pageAddress(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/, 1)[0] ?? '';
  }
}

/**
 * Why a presented resume token cannot resume its session, or null when it
 * can. The origin that counts is the socket's Origin header (S1). One
 * approval covers one page (ADR 0011), so the hello must also name the page
 * the session began on: another path of the same origin, or a url naming
 * another origin, is another page, however its token was obtained.
 */
function resumeRefusal(
  candidate: PageRecord | undefined,
  origin: string,
  url: string,
): string | null {
  if (candidate === undefined) return 'unknown token';
  if (candidate.state === 'gone') return 'page gone';
  if (candidate.origin !== origin) return 'different origin';
  if (pageAddress(candidate.url) !== pageAddress(url)) return 'different page';
  return null;
}

function attachmentKey(pageId: string, userId: string): string {
  // Both are ids of letters, digits, '_' and '-', so a space cannot be ambiguous.
  return `${pageId} ${userId}`;
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
function cutTool(tool: PageTool, inputSchema = cutSchema(tool.inputSchema)): PageTool {
  return {
    ...tool,
    description: truncate(tool.description, MAX_DESCRIPTION_CHARS).text,
    inputSchema,
  };
}

/**
 * Schema nodes (objects, arrays and plain values) the main thread walks for
 * one tools frame, across all its tools that changed. Cutting a schema,
 * preparing it for the check and hashing it are each linear in its nodes, and
 * a 1 MB frame can hold a third of a million, so tools past this are listed
 * with a stub, like an oversized schema, and go unchecked (S9, ADR 0010).
 */
export const MAX_FRAME_SCHEMA_NODES = 20_000;

/**
 * The most of a frame's walk one tool may take. A tool over it is listed with a
 * stub and goes unchecked on its own, having cost the frame no more than this
 * and one node, and is reused by hash while unchanged, so large tools on an
 * honest page cannot leave the tools after them unchecked once it re-lists.
 */
export const MAX_TOOL_SCHEMA_NODES = 5_000;

/**
 * A schema's nodes, counted no further than `limit + 1` and no deeper than the
 * walks that follow ever go (each stops past MAX_SCHEMA_DEPTH), so every one
 * of them visits at most this many. `deep` says something lies below that.
 */
function schemaNodes(schema: JsonObject, limit: number): { nodes: number; deep: boolean } {
  let nodes = 0;
  let deep = false;
  const visit = (value: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > limit || typeof value !== 'object' || value === null) return;
    if (depth > MAX_SCHEMA_DEPTH) {
      deep = true;
      return;
    }
    const items = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    for (const item of items) {
      visit(item, depth + 1);
      if (nodes > limit) return;
    }
  };
  visit(schema, 0);
  return { nodes, deep };
}

/** A hash of a tool's JSON as the page sent it; null when it is nested too deep to serialise. */
function rawToolHash(tool: PageTool): string | null {
  try {
    return createHash('sha256').update(JSON.stringify(tool)).digest('hex');
  } catch {
    return null;
  }
}

export class PageHub {
  readonly #config: ResolvedConfig;
  readonly #store: RelayStore;
  readonly #log: Logger;
  readonly #conns = new Set<Conn>();
  readonly #live = new Map<string, Conn>();
  /** Open page sockets per remote address, for pageSocketsPerAddress. */
  readonly #socketsByAddress = new Map<string, number>();
  /**
   * The address that created each awake or asleep page; its size is the page
   * sessions held (pageSessions). A page stays counted there until it is gone,
   * even if it resumes from elsewhere.
   */
  readonly #pageAddress = new Map<string, string>();
  /** Page sessions per creating address, for pageSessionsPerAddress. */
  readonly #sessionsByAddress = new Map<string, AddressSessions>();
  /** Every asleep page, oldest asleep first, so making room never scans the store. */
  readonly #asleep = new Set<string>();
  /** Gone pages still remembered for page_gone, oldest first, at most pageSessions of them. */
  readonly #tombstones = new Set<string>();
  readonly #pairingTimers = new Map<string, NodeJS.Timeout>();
  /** asleep to gone, then gone to forgotten. */
  readonly #lifecycleTimers = new Map<string, NodeJS.Timeout>();
  readonly #requestTimers = new Map<string, NodeJS.Timeout>();
  /** One per attachment, keyed by attachmentKey: fires when it has gone unused for attachmentIdleMs. */
  readonly #expiryTimers = new Map<string, NodeJS.Timeout>();
  /** Every pair_page waiting on a request, by requestId: a retry or a second device joins the first. */
  readonly #pairWaiters = new Map<string, Set<(outcome: PairOutcome) => void>>();
  readonly #queues = new Map<string, PageQueue>();
  /** Pages whose queue is being advanced right now, so a settle inside it does not advance it again. */
  readonly #pumping = new Set<string>();
  /**
   * Each page's tools as its last tools frame left them, with their argument
   * checks prepared from the page's own schemas (ADR 0008).
   */
  readonly #listed = new Map<string, Map<string, ListedTool>>();
  /** The only place CfWorker runs: a worker thread with a time budget per check (ADR 0010). */
  readonly #checker: ArgumentChecker;
  /** When each page last got a roster, for EXPIRY_ROSTER_REFRESH_MS. */
  readonly #rosterSentAt = new Map<string, number>();
  /** When each page last got a roster for what a call alone changed (expiry or a new client). */
  readonly #callRosterAt = new Map<string, number>();
  /** A roster held back by the refresh step, so a new client still reaches the page. */
  readonly #rosterTimers = new Map<string, NodeJS.Timeout>();
  /**
   * Each page's current code as its widget shows it, kept in public URL mode
   * only and in memory only, so /pair can show it beside the page's title; the
   * store keeps nothing but its digest.
   */
  readonly #liveCodes = new Map<string, string>();
  /**
   * Pairing attempts are counted per user and per page, never per address:
   * behind a tunnel every caller arrives from the same one (S3, ADR 0016).
   */
  readonly #userLimiter: SlidingWindowLimiter;
  readonly #pageLimiter: SlidingWindowLimiter;
  readonly #callLimiter: SlidingWindowLimiter;
  /** Tools frames per remote address, shared by its sockets and kept across reconnects. */
  readonly #toolsFrameLimiter: SlidingWindowLimiter;
  /** The M3 spike's pairing milestones (spike.ts), when TABDOCK_SPIKE is on. */
  readonly #spike: SpikeHooks | null;
  #closed = false;

  constructor(
    config: ResolvedConfig,
    store: RelayStore,
    log: Logger,
    spike: SpikeHooks | null = null,
  ) {
    this.#config = config;
    this.#store = store;
    this.#log = log;
    this.#spike = spike;
    const {
      pairAttemptsPerUser,
      pairAttemptsPerPage,
      callsPerUserPerPage,
      windowMs,
      toolsFramesPerAddress,
      toolsFramesWindowMs,
    } = config.rateLimits;
    this.#userLimiter = new SlidingWindowLimiter(pairAttemptsPerUser, windowMs);
    this.#pageLimiter = new SlidingWindowLimiter(pairAttemptsPerPage, windowMs);
    this.#callLimiter = new SlidingWindowLimiter(callsPerUserPerPage, windowMs);
    this.#toolsFrameLimiter = new SlidingWindowLimiter(toolsFramesPerAddress, toolsFramesWindowMs);
    this.#checker = new ArgumentChecker({ budgetMs: config.timings.argumentCheckMs, log });
  }

  /**
   * Resolves once the argument check worker is ready, or has failed to start;
   * the relay waits on it before listening so its first calls are checked. A
   * worker that fails is restarted with backoff, and calls go on unchecked.
   */
  async ready(): Promise<void> {
    await this.#checker.ready();
  }

  // Page side

  /**
   * Whether one more page socket from this address fits, asked before the
   * upgrade so a refusal is a plain HTTP status. Only open sockets count here:
   * whether a socket resumes a session or needs room for a new one is known only
   * at its hello (#makeRoom). ws completes the upgrade in the same turn, so
   * acceptSocket counts this socket before any other upgrade is asked about.
   */
  admitSocket(address: string): SocketRefusal | null {
    const { pageSocketsPerAddress, pageSessions } = this.#config.limits;
    if ((this.#socketsByAddress.get(address) ?? 0) >= pageSocketsPerAddress) {
      this.#log.warn('page socket refused: too many from one address', { address });
      return { status: 429, message: 'Too many page sockets from this address' };
    }
    // Ending asleep pages frees no sockets, so open ones alone are refused outright.
    if (this.#conns.size >= pageSessions) {
      this.#log.warn('page socket refused: the relay holds the most page sockets allowed', {
        address,
      });
      return { status: 503, message: 'The relay holds as many pages as it can; try again later' };
    }
    return null;
  }

  /**
   * Room for one new page session, made at its hello; a resume only wakes its
   * own record and never needs any. An address at pageSessionsPerAddress ends
   * its own page asleep longest, so churn from one address never ends anyone
   * else's page. At pageSessions the relay ends that address's own sleeper if it
   * has one, else the page asleep longest, as at the end of its resume window.
   * Returns why there is no room when nothing asleep can make way.
   */
  #makeRoom(address: string): string | null {
    const { pageSessionsPerAddress, pageSessions } = this.#config.limits;
    const own = this.#sessionsByAddress.get(address);
    if ((own?.pages.size ?? 0) >= pageSessionsPerAddress) {
      const oldest = firstOf(own?.asleep);
      if (oldest === undefined) {
        this.#log.warn('page session refused: too many from one address', { address });
        return 'too many pages from this address; try again later';
      }
      this.#log.info("ended this address's page asleep longest to make room for its new one", {
        pageId: oldest,
      });
      this.#gone(oldest);
    }
    if (this.#pageAddress.size >= pageSessions) {
      const oldest = firstOf(own?.asleep) ?? firstOf(this.#asleep);
      if (oldest === undefined) {
        this.#log.warn('page session refused: the relay holds the most page sessions allowed', {
          address,
        });
        return 'the relay holds as many pages as it can; try again later';
      }
      this.#log.info('ended the page asleep longest to make room for a new one', {
        pageId: oldest,
      });
      this.#gone(oldest);
    }
    return null;
  }

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
      toolsFrames: [],
    };
    this.#conns.add(conn);
    this.#socketsByAddress.set(address, (this.#socketsByAddress.get(address) ?? 0) + 1);
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
        if (this.#toolsFrameAllowed(conn)) this.#tools(pageId, frame);
        return;
      case 'attach_decision':
        this.#decision(pageId, frame);
        return;
      case 'set_role':
        this.#setRole(pageId, frame);
        return;
      case 'revoke':
        this.#revoke(pageId, frame);
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
      const refused = resumeRefusal(candidate, conn.origin, frame.url);
      if (refused === null) {
        page = candidate;
      } else {
        // The token stays a secret even when it is refused; only the reason is
        // logged. A refused token's session is left as it was, still resumable
        // by its own page.
        this.#log.warn('resume refused; starting a new page session', {
          origin: conn.origin,
          reason: refused,
        });
      }
    }

    const resumed = page !== undefined;
    if (page) {
      const previous = this.#live.get(page.pageId);
      if (previous && previous !== conn) {
        this.#live.delete(page.pageId);
        this.#failPageCalls(
          page.pageId,
          previous,
          hubError('page_asleep', 'the page reloaded before it answered'),
        );
        this.#closeSocket(previous, CLOSE_RESUMED_ELSEWHERE, 'session resumed elsewhere');
        // The reloaded page never saw these requests, so nobody is left to answer them.
        this.#dropRequests(page.pageId);
      }
      this.#clearTimer(this.#lifecycleTimers, page.pageId);
      this.#asleep.delete(page.pageId);
      const creator = this.#pageAddress.get(page.pageId);
      if (creator !== undefined) this.#sessionsByAddress.get(creator)?.asleep.delete(page.pageId);
      // The adapter lists its tools again right after the welcome. Until then any
      // held here belong to a replaced socket, and a toolCount from them would
      // tell list_pages callers the page is ready while calls still wait.
      page.tools = [];
      page.toolsPending = true;
      this.#listed.delete(page.pageId);
      page.title = frame.title;
      page.url = frame.url;
      page.adapterVersion = frame.adapterVersion;
      page.policy = frame.policy;
    } else {
      const noRoom = this.#makeRoom(conn.address);
      if (noRoom !== null) {
        this.#closeSocket(conn, CLOSE_TRY_AGAIN_LATER, noRoom);
        return;
      }
      let pageId = newId('pg');
      while (this.#store.pages.get(pageId)) pageId = newId('pg');
      this.#pageAddress.set(pageId, conn.address);
      let sessions = this.#sessionsByAddress.get(conn.address);
      if (!sessions) {
        sessions = { pages: new Set(), asleep: new Set() };
        this.#sessionsByAddress.set(conn.address, sessions);
      }
      sessions.pages.add(pageId);
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
    this.#rosterSentAt.set(page.pageId, now);
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

  /**
   * A tools frame costs main-thread time: parsing it, then hashing and walking
   * each changed tool's schema, up to MAX_TOOL_SCHEMA_NODES per tool and
   * MAX_FRAME_SCHEMA_NODES in all (ADR 0008, ADR 0010). So each socket gets a
   * budget of them, and so does each remote address across all its sockets and
   * reconnects, since one address may hold many sockets (S9). Past either the
   * socket is closed as a policy breach, which leaves the page asleep and
   * resumable like any other close.
   */
  #toolsFrameAllowed(conn: Conn): boolean {
    const now = Date.now();
    const { toolsFramesPerSocket, toolsFramesWindowMs } = this.#config.rateLimits;
    conn.toolsFrames = conn.toolsFrames.filter((at) => at > now - toolsFramesWindowMs);
    if (conn.toolsFrames.length >= toolsFramesPerSocket) {
      this.#log.warn('closing page socket: too many tools frames', { pageId: conn.pageId });
      this.#closeSocket(conn, CLOSE_POLICY, 'too many tools frames');
      return false;
    }
    if (!this.#toolsFrameLimiter.allows(conn.address, now)) {
      this.#log.warn('closing page socket: too many tools frames from its address', {
        pageId: conn.pageId,
        address: conn.address,
      });
      this.#closeSocket(conn, CLOSE_POLICY, 'too many tools frames from this address');
      return false;
    }
    this.#toolsFrameLimiter.record(conn.address, now);
    conn.toolsFrames.push(now);
    return true;
  }

  #tools(pageId: string, frame: FrameOf<'tools'>): void {
    const page = this.#store.pages.get(pageId);
    if (!page) return;
    // WebMCP itself refuses duplicate names, so a duplicate is a page bug: keep the first.
    const seen = new Set<string>();
    const tools: PageTool[] = [];
    const previous = this.#listed.get(pageId);
    const listed = new Map<string, ListedTool>();
    let nodesLeft = MAX_FRAME_SCHEMA_NODES;
    let overTool = 0;
    let overFrame = 0;
    for (const tool of frame.tools) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      const before = previous?.get(tool.name);
      // Hashed only when the hash can match: a tool of that name was walked and hashed last time.
      const raw = before?.raw ? rawToolHash(tool) : null;
      if (before && raw !== null && before.raw === raw) {
        listed.set(tool.name, before);
        tools.push(before.tool);
        continue;
      }
      // The count stops one node past the limit, and the frame is charged what
      // was counted, so the walk per frame stays within the frame's cap plus one
      // node per tool however many large tools it lists.
      const limit = Math.min(nodesLeft, MAX_TOOL_SCHEMA_NODES);
      const { nodes, deep } = schemaNodes(tool.inputSchema, limit);
      nodesLeft = Math.max(0, nodesLeft - nodes);
      if (nodes > limit) {
        // Over its own limit, it alone is stubbed and later tools are walked;
        // past what is left of the frame's, so is every tool after it.
        const own = limit === MAX_TOOL_SCHEMA_NODES;
        if (own) overTool += 1;
        else overFrame += 1;
        const stub = cutTool(
          tool,
          removedSchema(
            own
              ? `more than ${String(MAX_TOOL_SCHEMA_NODES)} schema nodes`
              : `the page's tools hold more than ${String(MAX_FRAME_SCHEMA_NODES)} schema nodes in all`,
          ),
        );
        const check = { schema: null, uncompilable: false, warned: new Set<UncheckedReason>() };
        // Over its own limit it always will be, so it is kept by hash and reused
        // unchanged without another walk, leaving the frame to the tools after it.
        // One stubbed only for the frame's lack of room is walked again next time.
        listed.set(tool.name, {
          raw: own ? (raw ?? rawToolHash(tool)) : null,
          capped: true,
          tool: stub,
          check,
        });
        tools.push(stub);
        continue;
      }
      const cut = cutTool(tool);
      // From the page's own schema, not the cut copy, so a long enum value still
      // matches. Prepared here and compiled in the worker, at the tool's first call.
      const schema = prepareForCheck(tool.inputSchema);
      // The same schema again keeps what is known about it, so nothing is logged twice.
      let check = before?.capped === false ? before.check : undefined;
      if (!check || !sameSchema(check.schema, schema)) {
        if (schema === null) this.#warnUncheckable(pageId, tool.name);
        check = { schema, uncompilable: false, warned: new Set() };
      }
      // Hashed for the next frame only when the count covered all of it, so the
      // hash costs no more than the walk did; a schema too deep is walked again.
      listed.set(tool.name, {
        raw: deep ? null : (raw ?? rawToolHash(tool)),
        capped: false,
        tool: cut,
        check,
      });
      tools.push(cut);
    }
    if (tools.length !== frame.tools.length) {
      this.#log.warn('page listed a tool name twice; kept the first', { pageId });
    }
    if (overTool > 0) {
      this.#log.warn(
        'page tools hold more schema than the relay walks per tool; each such tool is listed without its schema and goes to the page unchecked',
        { pageId, toolCount: overTool },
      );
    }
    if (overFrame > 0) {
      this.#log.warn(
        'page tools hold more schema than the relay walks per frame; the rest are listed without their schemas and go to the page unchecked',
        { pageId, toolCount: overFrame },
      );
    }
    page.tools = tools;
    page.toolsPending = false;
    this.#store.pages.put(page);
    this.#listed.set(pageId, listed);
    this.#log.debug('page tools updated', { pageId, toolCount: tools.length });
  }

  #onClose(conn: Conn, code: number): void {
    this.#conns.delete(conn);
    const sockets = (this.#socketsByAddress.get(conn.address) ?? 1) - 1;
    if (sockets > 0) this.#socketsByAddress.set(conn.address, sockets);
    else this.#socketsByAddress.delete(conn.address);
    this.#clearConnTimers(conn);
    const detached = code === CLOSE_DETACH;
    const outcome = detached
      ? hubError('page_gone', 'the page detached before it answered')
      : hubError('page_asleep', 'the page disconnected before it answered');
    const pageId = conn.pageId;
    // A socket replaced by a resumed one no longer speaks for its page or its queue.
    if (pageId === null || this.#live.get(pageId) !== conn) {
      this.#failInflight(conn, outcome);
      return;
    }
    this.#failPageCalls(pageId, conn, outcome);
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
    this.#listed.delete(pageId);
    this.#store.pages.put(page);
    this.#asleep.add(pageId);
    const creator = this.#pageAddress.get(pageId);
    if (creator !== undefined) this.#sessionsByAddress.get(creator)?.asleep.add(pageId);
    this.#dropTicket(pageId);
    // The welcome on resume carries the roster as it is by then.
    this.#clearTimer(this.#rosterTimers, pageId);
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
    for (const attachment of attachments) {
      this.#store.attachments.delete(pageId, attachment.userId);
      this.#clearTimer(this.#expiryTimers, attachmentKey(pageId, attachment.userId));
    }
    page.state = 'gone';
    page.goneAt = Date.now();
    page.resumeTokenHash = '';
    page.tools = [];
    page.formerAttachments = attachments.map(({ userId, role }) => ({ userId, role }));
    // A gone record keeps only what list_pages, page_gone and detach_page read.
    page.url = '';
    page.adapterVersion = '';
    page.policy = { ...page.policy, consequentialTools: [] };
    this.#store.pages.put(page);
    this.#listed.delete(pageId);
    this.#rosterSentAt.delete(pageId);
    this.#callRosterAt.delete(pageId);
    this.#asleep.delete(pageId);
    const creator = this.#pageAddress.get(pageId);
    this.#pageAddress.delete(pageId);
    if (creator !== undefined) {
      const sessions = this.#sessionsByAddress.get(creator);
      sessions?.pages.delete(pageId);
      sessions?.asleep.delete(pageId);
      if (sessions?.pages.size === 0) this.#sessionsByAddress.delete(creator);
    }
    this.#tombstones.add(pageId);
    this.#setTimer(this.#lifecycleTimers, pageId, this.#config.timings.goneTombstoneMs, () => {
      this.#forget(pageId);
    });
    // Bounded by count as well as time, so pages that detach fast cannot pile them up.
    for (const oldest of this.#tombstones) {
      if (this.#tombstones.size <= this.#config.limits.pageSessions) break;
      this.#clearTimer(this.#lifecycleTimers, oldest);
      this.#forget(oldest);
    }
    this.#log.info('page gone', { pageId, attachmentsDeleted: attachments.length });
  }

  /** A gone page is dropped for good; its former users hear not_attached from then on. */
  #forget(pageId: string): void {
    this.#tombstones.delete(pageId);
    this.#store.pages.delete(pageId);
    this.#log.debug('gone page forgotten', { pageId });
  }

  // Pairing tickets

  #issueTicket(pageId: string): Pairing {
    const code = newPairingCode();
    const { pairingTtlMs } = this.#config.timings;
    const now = Date.now();
    const expiresAt = now + pairingTtlMs;
    this.#store.tickets.put({ pageId, codeHash: digest(code), expiresAt });
    this.#setTimer(this.#pairingTimers, pageId, pairingTtlMs, () => {
      this.#rotateTicket(pageId, 'expired');
    });
    const shown = formatPairingCode(code);
    const url = this.#issuePairNonce(pageId, shown, now, expiresAt);
    // One milestone for the code and its nonce, which live and die together.
    this.#spike?.pairingIssued(pageId);
    return { code: shown, ...(url === null ? {} : { url }), expiresAt };
  }

  /**
   * In public URL mode, a QR nonce beside the code (S11): 128 bits, bound to
   * the page, single use, living exactly as long as the code and replaced with
   * it. Its URL carries it in the fragment, which a browser never sends, so it
   * reaches no server or tunnel log. Null, and no URL, otherwise.
   */
  #issuePairNonce(pageId: string, shown: string, now: number, expiresAt: number): string | null {
    this.#store.singleUse.deleteForPage('pair', pageId);
    const { publicUrl } = this.#config;
    if (publicUrl === null) return null;
    const nonce = newSingleUseSecret();
    this.#store.singleUse.put({
      kind: 'pair',
      secretHash: digest(nonce),
      pageId,
      createdAt: now,
      expiresAt,
    });
    this.#liveCodes.set(pageId, shown);
    return `${publicUrl}/pair#${nonce}`;
  }

  /** The page has no live code or nonce any more, until its next welcome. */
  #dropTicket(pageId: string): void {
    this.#store.tickets.deleteForPage(pageId);
    this.#store.singleUse.deleteForPage('pair', pageId);
    this.#liveCodes.delete(pageId);
    this.#clearTimer(this.#pairingTimers, pageId);
  }

  #rotateTicket(pageId: string, reason: string): void {
    const conn = this.#live.get(pageId);
    if (!conn || conn.closing) {
      this.#dropTicket(pageId);
      return;
    }
    this.#send(conn, { t: 'pairing', ...this.#issueTicket(pageId) });
    this.#log.debug('pairing code rotated', { pageId, reason });
  }

  /**
   * A live QR nonce, found by its digest and confirmed in constant time, as
   * codes are (S3). `take` removes it in the same step, so two claims racing
   * for one nonce cannot both have it. Unknown, used and expired look alike.
   */
  #pairTicket(nonce: string, now: number, take: boolean): SingleUseTicketRecord | null {
    if (!SINGLE_USE_SECRET_PATTERN.test(nonce)) return null;
    const hash = digest(nonce);
    const hashHex = hash.toString('hex');
    const ticket = take
      ? this.#store.singleUse.take('pair', hashHex)
      : this.#store.singleUse.find('pair', hashHex);
    if (!ticket || !sameDigest(ticket.secretHash, hash) || ticket.expiresAt <= now) return null;
    return ticket;
  }

  /** The page and its socket, while it is awake and its socket is not closing. */
  #livePage(pageId: string): { page: PageRecord; conn: Conn } | null {
    const page = this.#store.pages.get(pageId);
    const conn = this.#live.get(pageId);
    if (page?.state !== 'awake' || !conn || conn.closing) return null;
    return { page, conn };
  }

  /** Looks the code up by its hash, then confirms in constant time (S3). */
  #matchTicket(normalised: string, now: number): string | null {
    const hash = digest(normalised);
    const ticket = this.#store.tickets.findByCodeHash(hash.toString('hex'));
    if (!ticket || !sameDigest(ticket.codeHash, hash) || ticket.expiresAt <= now) return null;
    return ticket.pageId;
  }

  // Attachments

  /** Whether the page already holds as many users as it may (S9). */
  #pageFull(pageId: string): boolean {
    return this.#store.attachments.listForPage(pageId).length >= this.#config.limits.usersPerPage;
  }

  #pageFullError(when: string): HubError {
    return hubError(
      'page_busy',
      `the page ${when} ${String(this.#config.limits.usersPerPage)} users attached, the most it allows; its operator can revoke someone to make room`,
    );
  }

  #decision(pageId: string, frame: FrameOf<'attach_decision'>): void {
    const request = this.#store.requests.get(frame.requestId);
    // A page may only answer its own requests; anything else is stale or forged.
    if (request?.pageId !== pageId) {
      this.#log.warn('ignored a decision for an unknown attach request', { pageId });
      return;
    }
    if (!frame.allow) {
      this.#log.info('attach request denied', { pageId, userId: request.userId });
      this.#spike?.pairingDecided(pageId, request.userId, false);
      this.#endRequest(request.requestId, {
        kind: 'error',
        code: 'denied_by_operator',
        message: 'the page operator denied the attach request',
      });
      return;
    }
    if (!this.#store.attachments.get(pageId, request.userId) && this.#pageFull(pageId)) {
      this.#log.info('approval refused: the page filled up while the operator decided', {
        pageId,
        userId: request.userId,
      });
      this.#spike?.pairingDecided(pageId, request.userId, false);
      this.#endRequest(request.requestId, this.#pageFullError('filled up meanwhile and has'));
      return;
    }
    const attachment = this.#grant(request, frame.role ?? 'observer');
    this.#spike?.pairingDecided(pageId, request.userId, true);
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
    request: Pick<AttachRequestRecord, 'pageId' | 'userId' | 'displayName' | 'client'> &
      Partial<Pick<AttachRequestRecord, 'joined'>>,
    wanted: Role,
  ): AttachmentRecord {
    const existing = this.#store.attachments.get(request.pageId, request.userId);
    if (existing) return existing;
    const now = Date.now();
    // Newest first, as every roster lists clients; a joined device came after the first.
    const clients = [...(request.joined ?? [])].reverse();
    if (request.client) clients.push(request.client);
    const attachment: AttachmentRecord = {
      pageId: request.pageId,
      userId: request.userId,
      displayName: request.displayName,
      role: this.#cappedRole(request.pageId, request.userId, wanted),
      grantedAt: now,
      lastUsedAt: null,
      expiresAt: now + this.#config.timings.attachmentIdleMs,
      clients: clients.slice(0, MAX_ROSTER_CLIENTS),
    };
    this.#store.attachments.put(attachment);
    this.#armExpiry(attachment);
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

  #revoke(pageId: string, frame: FrameOf<'revoke'>): void {
    const targets =
      frame.userId === '*'
        ? this.#store.attachments.listForPage(pageId)
        : [this.#store.attachments.get(pageId, frame.userId)].filter(
            (attachment) => attachment !== undefined,
          );
    const users = new Set(targets.map((attachment) => attachment.userId));
    if (frame.userId !== '*') users.add(frame.userId);
    // Revocation is immediate (S8): calls on the page are cancelled now, queued ones dropped.
    this.#endAttachments(pageId, users, 'revoked', 'the page operator revoked your attachment');
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

  /**
   * Deletes these users' attachments to a page and ends their calls: a call on
   * the page gets a cancel frame, a queued one never reaches it, and both
   * answer not_attached with `message`. The client's own MCP session is left
   * alone, so it hears the answer rather than waiting on a closed stream.
   */
  #endAttachments(
    pageId: string,
    users: ReadonlySet<string>,
    reason: 'revoked' | 'client',
    message: string,
  ): void {
    for (const userId of users) {
      this.#store.attachments.delete(pageId, userId);
      this.#clearTimer(this.#expiryTimers, attachmentKey(pageId, userId));
    }
    const outcome = hubError('not_attached', message);
    // Queued calls first, so a running one settling does not hand the page a call that is ending.
    for (const call of [...(this.#queues.get(pageId)?.waiting ?? [])]) {
      if (users.has(call.caller.userId)) call.settle(outcome);
    }
    const conn = this.#live.get(pageId);
    for (const call of [...(conn?.inflight.values() ?? [])]) {
      if (!users.has(call.caller.userId)) continue;
      if (conn) this.#send(conn, { t: 'cancel', callId: call.callId, reason });
      call.settle(outcome);
    }
  }

  #armExpiry(attachment: AttachmentRecord): void {
    const { pageId, userId, expiresAt } = attachment;
    const key = attachmentKey(pageId, userId);
    if (expiresAt === null) {
      this.#clearTimer(this.#expiryTimers, key);
      return;
    }
    this.#setTimer(this.#expiryTimers, key, Math.max(0, expiresAt - Date.now()), () => {
      this.#expireIfDue(pageId, userId);
    });
  }

  /** Ends an attachment past its expiresAt like a revoke, without an audit record. True if it ended. */
  #expireIfDue(pageId: string, userId: string): boolean {
    const attachment = this.#store.attachments.get(pageId, userId);
    if (!attachment || attachment.expiresAt === null) return false;
    if (attachment.expiresAt > Date.now()) {
      // The timer ran early or a call moved the expiry meanwhile.
      this.#armExpiry(attachment);
      return false;
    }
    const idle = formatDuration(this.#config.timings.attachmentIdleMs);
    this.#endAttachments(
      pageId,
      new Set([userId]),
      'revoked',
      `your attachment expired after ${idle} without a call; pair again to use the page`,
    );
    this.#log.info('attachment expired', { pageId, userId });
    this.#sendRoster(pageId);
    return true;
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
    // Whatever a held-back roster was for, this one carries it.
    this.#clearTimer(this.#rosterTimers, pageId);
    const conn = this.#live.get(pageId);
    if (!conn) return;
    this.#send(conn, { t: 'roster', attachments: this.#roster(pageId) });
    this.#rosterSentAt.set(pageId, Date.now());
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
    if (call.marks) call.marks.resultIn = performance.now();
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

  /** Every call of this page ends with `outcome`: the queued ones first, then those on `conn`. */
  #failPageCalls(pageId: string, conn: Conn, outcome: CallOutcome): void {
    for (const call of [...(this.#queues.get(pageId)?.waiting ?? [])]) call.settle(outcome);
    this.#failInflight(conn, outcome);
  }

  #failInflight(conn: Conn, outcome: CallOutcome): void {
    for (const call of [...conn.inflight.values()]) call.settle(outcome);
  }

  // MCP side

  listPages(userId: string): PageListing[] {
    const listings: PageListing[] = [];
    for (const attachment of this.#store.attachments.listForUser(userId)) {
      if (this.#expireIfDue(attachment.pageId, userId)) continue;
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
    for (const pageId of this.#tombstones) {
      const page = this.#store.pages.get(pageId);
      if (page?.state !== 'gone') continue;
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
    // An expiry timer may run late; an attachment past its time is over either way.
    this.#expireIfDue(pageId, userId);
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
    const limited = this.#pairingLimited(caller.userId, now);
    if (limited) return limited;

    const normalised = normalisePairingCode(code);
    const pageId = normalised === null ? null : this.#matchTicket(normalised, now);
    const live = pageId === null ? null : this.#livePage(pageId);
    // Wrong and expired look the same: telling them apart would confirm a code once existed.
    if (!live) {
      this.#log.info('pairing refused: no live code matched', { userId: caller.userId });
      return hubError('pairing_expired', 'code is invalid or expired');
    }
    const started = this.#startPairing(caller, live.page, live.conn, 'code', now);
    return started.kind === 'pending' ? this.#waitForDecision(started.record, signal) : started;
  }

  /**
   * What /pair shows for a QR nonce: the page's origin, its title as the page
   * wrote it, and the code its widget shows, so the person can check the phone
   * is about to join the page in front of them. Uses nothing up; null for an
   * unknown, used or expired nonce alike.
   */
  previewPairNonce(nonce: string): PairPreview | null {
    const ticket = this.#pairTicket(nonce, Date.now(), false);
    const live = ticket === null ? null : this.#livePage(ticket.pageId);
    const code = ticket === null ? undefined : this.#liveCodes.get(ticket.pageId);
    if (!ticket || !live || code === undefined) return null;
    // The first look at a nonce is the phone's scan, where A3.3's figure starts.
    this.#spike?.pairingScanned(ticket.pageId);
    const title = firstCharacters(live.page.title, MAX_PAIR_TITLE_CHARS);
    return {
      origin: live.page.origin,
      title: title.text,
      titleCut: title.cut,
      code,
      expiresAt: ticket.expiresAt,
    };
  }

  /**
   * A signed-in member's QR claim from /pair: the nonce is used up at once
   * and the page gets a fresh code and nonce, then everything goes as for
   * pair_page (via 'qr'): the same limits, one pending request per user and
   * page, the operator's approval, and silence as a denial.
   */
  claimPairNonce(caller: CallerIdentity, nonce: string): ClaimOutcome {
    const now = Date.now();
    const limited = this.#pairingLimited(caller.userId, now);
    if (limited) return limited;
    const ticket = this.#pairTicket(nonce, now, true);
    const live = ticket === null ? null : this.#livePage(ticket.pageId);
    if (!ticket || !live) {
      this.#log.info('qr pairing refused: no live nonce matched', { userId: caller.userId });
      return hubError('pairing_expired', 'this pairing link is invalid or expired');
    }
    const started = this.#startPairing(caller, live.page, live.conn, 'qr', now);
    if (started.kind === 'error') return started;
    return {
      kind: 'claimed',
      pageId: ticket.pageId,
      settled:
        started.kind === 'pending' ? this.#waitForEnd(started.record) : Promise.resolve(started),
    };
  }

  /** Counts one pairing attempt for the user, or refuses it past the limit (S3). */
  #pairingLimited(userId: string, now: number): HubError | null {
    if (!this.#userLimiter.allows(userId, now)) {
      this.#log.warn('pairing attempt rate limited', { userId });
      return hubError('rate_limited', 'too many pairing attempts; wait a minute and try again');
    }
    this.#userLimiter.record(userId, now);
    return null;
  }

  /**
   * Everything after a live code or nonce matched: it is spent and replaced,
   * the page's own pairing limit is counted, and then the caller is already
   * attached, joins their pending request, is refused for a full page, is let
   * in by autoApprove, or gets a new request the operator sees.
   */
  #startPairing(
    caller: CallerIdentity,
    page: PageRecord,
    conn: Conn,
    via: AttachRequestRecord['via'],
    now: number,
  ): PairOutcome | { kind: 'pending'; record: AttachRequestRecord } {
    // Before the rotation below, which issues the next ticket: the spike times
    // this claim from the ticket that matched, not from its replacement.
    this.#spike?.pairingClaimed(page.pageId, caller.userId, via);
    // Single use: the matched code or nonce dies here and the page gets a fresh pair.
    this.#rotateTicket(page.pageId, 'used');

    // Every pairing that lands on a page counts against it, whoever sends it, so
    // a page whose codes leak cannot be buried in prompts.
    if (!this.#pageLimiter.allows(page.pageId, now)) {
      this.#log.warn('pairing refused: too many pairings for one page', {
        pageId: page.pageId,
        userId: caller.userId,
      });
      this.#spike?.pairingDecided(page.pageId, caller.userId, false);
      return hubError(
        'rate_limited',
        'too many pairing attempts on this page; wait a minute and try again',
      );
    }
    this.#pageLimiter.record(page.pageId, now);

    this.#expireIfDue(page.pageId, caller.userId);
    const existing = this.#store.attachments.get(page.pageId, caller.userId);
    if (existing) {
      // Named at once: this device used a code the operator just showed, so it cannot churn.
      const named = this.#recordClient(existing, caller.client);
      this.#store.attachments.put(existing);
      if (named) this.#sendRoster(page.pageId);
      // Already in: as good as approved, so the next call is this pairing's first.
      this.#spike?.pairingDecided(page.pageId, caller.userId, true);
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

    // One person has at most one request per page. A retry after the wait ran
    // out, or the same person on a second device, waits on the request the
    // operator already sees, so the page never gets duplicates to answer. A
    // page that fills up meanwhile is caught when the operator approves.
    const pending = this.#store.requests
      .listForPage(page.pageId)
      .find((candidate) => candidate.userId === caller.userId);
    if (pending) {
      const joining = caller.client;
      const known = [pending.client, ...pending.joined].some(
        (seen) => seen !== null && joining !== null && sameClient(seen, joining),
      );
      // Bounded like the roster's own list; each join already spent a fresh code.
      if (joining && !known && pending.joined.length < MAX_ROSTER_CLIENTS) {
        pending.joined.push(joining);
        this.#store.requests.put(pending);
      }
      this.#log.info('pairing joined a pending attach request', {
        pageId: pending.pageId,
        userId: pending.userId,
        requestId: pending.requestId,
        via,
      });
      return { kind: 'pending', record: pending };
    }

    // S9: a full page is refused before its operator is asked anything.
    if (this.#pageFull(page.pageId)) {
      this.#log.info('pairing refused: the page holds the most users allowed', {
        pageId: page.pageId,
        userId: caller.userId,
      });
      this.#spike?.pairingDecided(page.pageId, caller.userId, false);
      return this.#pageFullError('already has');
    }

    if (page.policy.autoApprove === 'observer') {
      const attachment = this.#grant(request, 'observer');
      this.#spike?.pairingDecided(page.pageId, caller.userId, true);
      return {
        kind: 'attached',
        pageId: page.pageId,
        origin: page.origin,
        role: attachment.role,
        existing: false,
      };
    }

    const { attachRequestTtlMs } = this.#config.timings;
    const record: AttachRequestRecord = {
      ...request,
      requestId: newId('rq'),
      via,
      joined: [],
      expiresAt: now + attachRequestTtlMs,
    };
    this.#store.requests.put(record);
    this.#setTimer(this.#requestTimers, record.requestId, attachRequestTtlMs, () => {
      this.#log.info('attach request expired unanswered', {
        pageId: record.pageId,
        userId: record.userId,
      });
      this.#spike?.pairingDecided(record.pageId, record.userId, false);
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
      via,
    });
    return { kind: 'pending', record };
  }

  /**
   * Waits for the request itself to end: approval, denial, its lifetime run
   * out, the page gone or asleep, or shutdown. Every one of those calls
   * #endRequest or answers the waiters directly, so this always settles.
   */
  #waitForEnd(record: AttachRequestRecord): Promise<PairOutcome> {
    return new Promise((resolve) => {
      const finish = (outcome: PairOutcome): void => {
        const waiters = this.#pairWaiters.get(record.requestId);
        waiters?.delete(finish);
        if (waiters?.size === 0) this.#pairWaiters.delete(record.requestId);
        resolve(outcome);
      };
      let waiters = this.#pairWaiters.get(record.requestId);
      if (!waiters) {
        waiters = new Set();
        this.#pairWaiters.set(record.requestId, waiters);
      }
      waiters.add(finish);
    });
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
    marks: CallMarks | null = null,
  ): Promise<CallOutcome> {
    const started = Date.now();
    let auditOutcome: AuditOutcome = 'relay_error';
    try {
      const outcome = await this.#call(caller, pageId, tool, args, signal, marks);
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
      this.#spike?.callFinished(pageId, caller.userId, auditOutcome);
    }
  }

  /**
   * Everything a call must pass, in order: access, the rate limit (so a refused
   * call still counts and nobody spins on invalid calls for free), the tool, the
   * role, the frame size, the queue depth for a mutating call, and the
   * arguments. A mutating call takes its place in its page's queue on arrival,
   * before its argument check answers, so a later write whose check is quicker
   * or skipped never overtakes it (SPEC section 5); a read-only one goes to the
   * page once its check answers.
   */
  async #call(
    caller: CallerIdentity,
    pageId: string,
    toolName: string,
    args: JsonObject,
    signal: AbortSignal,
    marks: CallMarks | null,
  ): Promise<CallOutcome> {
    const arrivedAt = Date.now();
    const access = this.#access(caller.userId, pageId);
    if (access.kind === 'error') return access;
    const { page, attachment } = access;

    const rateKey = attachmentKey(pageId, caller.userId);
    if (!this.#callLimiter.allows(rateKey, arrivedAt)) {
      this.#log.warn('call rate limited', { pageId, userId: caller.userId });
      const { callsPerUserPerPage, windowMs } = this.#config.rateLimits;
      return hubError(
        'rate_limited',
        `more than ${String(callsPerUserPerPage)} calls to this page in ${formatDuration(windowMs)}; wait and try again`,
      );
    }
    this.#callLimiter.record(rateKey, arrivedAt);

    // Every call moves the expiry, but only one that passes every check names
    // its client (#nameClient): refused calls must not add names to the roster.
    const rosterAtArrival = this.#touchAttachment(attachment, arrivedAt);
    const tool = page.tools.find((candidate) => candidate.name === toolName);
    if (!tool) return hubError('tool_not_found', `page ${pageId} has no tool named ${toolName}`);
    // S5, relay half: observers run only tools the page marked read-only.
    if (attachment.role === 'observer' && tool.annotations?.readOnlyHint !== true) {
      return hubError(
        'role_denied',
        `you are an observer on this page, and ${toolName} is not marked read-only`,
      );
    }

    const callId = newId('cl');
    const call: PendingCall = {
      callId,
      pageId,
      caller,
      toolName: tool.name,
      args,
      mutating: tool.annotations?.readOnlyHint !== true,
      arrivedAt,
      rosterAtArrival,
      waited: false,
      checking: false,
      conn: null,
      marks,
      timer: null,
      done: false,
      settle: () => undefined,
    };
    // Checked before anything waits: the size cannot grow later, as the role and deadline only shrink.
    const encoded = this.#encodeInvoke(call, attachment.role, this.#config.timings.callDeadlineMs);
    if (encoded.kind === 'error') return encoded;

    if (!call.mutating) {
      // Read-only calls run side by side, so nothing is held while this one is checked.
      const argumentError = await this.#checkArguments(pageId, tool.name, args);
      if (argumentError) return argumentError;
      const current = this.#afterCheck(call);
      if (current.kind === 'error') return current;
      // The page may have re-listed the tool as mutating meanwhile; it then joins the queue now.
      if (current.mutating) {
        const busy = this.#queueFull(call);
        if (busy) return busy;
      }
      return this.#run(call, signal, current.attachment);
    }

    const busy = this.#queueFull(call);
    if (busy) return busy;
    call.checking = true;
    const outcome = this.#run(call, signal, null);
    // A call its client cancelled already never took a place, so it needs no check.
    if (!call.done) await this.#checkQueued(call, args);
    return outcome;
  }

  /**
   * page_busy when queueDepth mutating calls already wait behind the one on the
   * page (S9). With nothing on the page, the queue's head is next rather than
   * waiting: it is only still being checked.
   */
  #queueFull(call: PendingCall): HubError | null {
    const queue = this.#queues.get(call.pageId);
    const queued = queue?.waiting.length ?? 0;
    const waiting = queue?.running || queued === 0 ? queued : queued - 1;
    if (waiting < this.#config.limits.queueDepth) return null;
    this.#log.warn('call refused: the page queue is full', {
      pageId: call.pageId,
      userId: call.caller.userId,
    });
    return hubError(
      'page_busy',
      `${String(waiting)} calls that change the page are already waiting their turn; try again shortly`,
    );
  }

  /**
   * The check waited on the worker (ADR 0010), so the operator may have revoked
   * or demoted the caller, or the page changed its tools, meanwhile. They are
   * looked at again here, before the call can go out or move up the queue, and
   * #dispatch looks once more just before the invoke is sent.
   */
  #afterCheck(
    call: PendingCall,
  ): { kind: 'ok'; attachment: AttachmentRecord; mutating: boolean } | HubError {
    if (this.#closed) return hubError('page_asleep', 'the relay is shutting down');
    const current = this.#recheck(call);
    if (current.kind === 'error') return current;
    call.mutating = current.tool.annotations?.readOnlyHint !== true;
    return { kind: 'ok', attachment: current.attachment, mutating: call.mutating };
  }

  /**
   * From here a call answers its client's cancel and times out at its deadline,
   * and it goes to the page or takes its place in the queue. `attachment` names
   * its client, given once every check has passed; a write still being checked
   * is named when its check answers (#checkQueued).
   */
  #run(
    call: PendingCall,
    signal: AbortSignal,
    attachment: AttachmentRecord | null,
  ): Promise<CallOutcome> {
    return new Promise((resolve) => {
      const onAbort = (): void => {
        // A queued call simply leaves the queue; the page never heard of it.
        if (call.conn) {
          this.#send(call.conn, { t: 'cancel', callId: call.callId, reason: 'client' });
        }
        call.settle({ kind: 'cancelled' });
      };
      call.settle = (outcome) => {
        if (call.done) return;
        call.done = true;
        if (call.timer) clearTimeout(call.timer);
        signal.removeEventListener('abort', onAbort);
        this.#detachCall(call);
        resolve(outcome);
      };
      if (signal.aborted) {
        call.settle({ kind: 'cancelled' });
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      this.#armCallTimer(call);
      if (attachment) this.#nameClient(call, attachment, Date.now());
      if (!call.mutating) {
        this.#dispatch(call);
        return;
      }
      let queue = this.#queues.get(call.pageId);
      if (!queue) {
        queue = { running: null, waiting: [] };
        this.#queues.set(call.pageId, queue);
      }
      queue.waiting.push(call);
      this.#log.debug('call queued', {
        pageId: call.pageId,
        userId: call.caller.userId,
        callId: call.callId,
        ahead: queue.waiting.length - 1 + (queue.running ? 1 : 0),
      });
      this.#pump(call.pageId);
      // Time spent on its own check is not waiting; #checkQueued looks once the check answers.
      if (!call.checking) this.#markWaited(call);
    });
  }

  /** A queued call the pump did not send at once waits behind another, so its deadline runs on. */
  #markWaited(call: PendingCall): void {
    if (!call.done && call.conn === null) call.waited = true;
  }

  /**
   * Settles a queued write's argument check: refused, it leaves the queue with
   * invalid_arguments; passed, it is looked at again and the queue moves on.
   */
  async #checkQueued(call: PendingCall, args: JsonObject): Promise<void> {
    const argumentError = await this.#checkArguments(call.pageId, call.toolName, args);
    // Cancelled, revoked, timed out or ended with its page meanwhile: it has answered already.
    if (call.done) return;
    if (argumentError) {
      call.settle(argumentError);
      return;
    }
    call.checking = false;
    const current = this.#afterCheck(call);
    if (current.kind === 'error') {
      call.settle(current);
      return;
    }
    this.#nameClient(call, current.attachment, Date.now());
    if (!current.mutating) {
      // The page re-listed the tool as read-only meanwhile, so it no longer waits for writes.
      const queue = this.#queues.get(call.pageId);
      const at = queue?.waiting.indexOf(call) ?? -1;
      if (at !== -1) queue?.waiting.splice(at, 1);
      this.#dispatch(call);
      this.#pump(call.pageId);
      return;
    }
    this.#pump(call.pageId);
    this.#markWaited(call);
  }

  /** The invoke frame for a call, or invalid_arguments when it cannot be sent at all. */
  #encodeInvoke(
    call: PendingCall,
    role: Role,
    deadlineMs: number,
  ): { kind: 'frame'; text: string } | HubError {
    let text: string;
    try {
      text = encodeFrame({
        t: 'invoke',
        callId: call.callId,
        tool: call.toolName,
        arguments: call.args,
        caller: {
          userId: call.caller.userId,
          displayName: call.caller.displayName,
          client: call.caller.client,
          role,
        },
        deadlineMs,
      });
    } catch {
      // JSON.stringify recurses: arguments nested a few thousand levels deep overflow the stack.
      return hubError('invalid_arguments', 'the arguments could not be encoded for the page link');
    }
    // The adapter drops any frame over the cap by closing the socket, so an
    // oversized call must stop here rather than knock the page offline.
    if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) {
      return hubError(
        'invalid_arguments',
        `the arguments are too large to forward; one page link frame carries at most ${String(MAX_FRAME_BYTES)} bytes`,
      );
    }
    return { kind: 'frame', text };
  }

  /**
   * ADR 0008 and ADR 0010: null when the arguments pass, when the tool's schema
   * cannot be checked, or when the worker did not answer within its budget.
   */
  async #checkArguments(
    pageId: string,
    toolName: string,
    args: JsonObject,
  ): Promise<HubError | null> {
    const entry = this.#listed.get(pageId)?.get(toolName)?.check;
    if (!entry?.schema || entry.uncompilable) return null;
    const result = await this.#checker.check(toolName, entry.schema, args);
    switch (result.kind) {
      case 'valid':
        return null;
      case 'invalid':
        return hubError('invalid_arguments', result.message);
      case 'uncompilable':
        this.#markUncompilable(pageId, toolName, entry);
        return null;
      case 'unchecked':
        if (!entry.warned.has(result.reason)) {
          entry.warned.add(result.reason);
          this.#log.warn(UNCHECKED_WARNINGS[result.reason], { pageId, tool: toolName });
        }
        return null;
    }
  }

  /** Calls checked at the same time all learn it; the first one logs it. */
  #markUncompilable(pageId: string, toolName: string, entry: ArgCheckEntry): void {
    if (entry.uncompilable) return;
    entry.uncompilable = true;
    this.#warnUncheckable(pageId, toolName);
  }

  /** Never the schema or the validator's message: both are page text. */
  #warnUncheckable(pageId: string, toolName: string): void {
    this.#log.warn('a tool schema cannot be checked; calls to it go to the page unchecked', {
      pageId,
      tool: toolName,
    });
  }

  /**
   * A queued call's timer ends it at its deadline, since the page never saw it.
   * Once its invoke is out, the timer waits the grace as well, so the page's own
   * answer at its deadline (denied_by_operator for an unanswered prompt, S6)
   * reaches the client. Both count from arrival.
   */
  #armCallTimer(call: PendingCall): void {
    const { callDeadlineMs, callDeadlineGraceMs } = this.#config.timings;
    if (call.timer) clearTimeout(call.timer);
    const due = call.arrivedAt + callDeadlineMs + (call.conn ? callDeadlineGraceMs : 0);
    call.timer = setTimeout(
      () => {
        if (call.conn) {
          this.#send(call.conn, { t: 'cancel', callId: call.callId, reason: 'timeout' });
          call.settle(
            hubError('timeout', `the page did not answer within ${String(callDeadlineMs)} ms`),
          );
        } else {
          call.settle(this.#queuedTooLong());
        }
      },
      Math.max(0, due - Date.now()),
    );
    call.timer.unref();
  }

  #queuedTooLong(): HubError {
    return hubError(
      'timeout',
      `the call waited ${String(this.#config.timings.callDeadlineMs)} ms behind other calls that change the page and never ran`,
    );
  }

  /**
   * What may have changed since a call arrived, looked at again: the
   * attachment, the page, the tool and the role.
   */
  #recheck(
    call: PendingCall,
  ): { kind: 'ok'; attachment: AttachmentRecord; conn: Conn; tool: PageTool } | HubError {
    const access = this.#access(call.caller.userId, call.pageId);
    if (access.kind === 'error') return access;
    const { page, attachment, conn } = access;
    const tool = page.tools.find((candidate) => candidate.name === call.toolName);
    if (!tool) {
      return hubError('tool_not_found', `page ${call.pageId} has no tool named ${call.toolName}`);
    }
    if (attachment.role === 'observer' && tool.annotations?.readOnlyHint !== true) {
      return hubError(
        'role_denied',
        `you are an observer on this page now, and ${call.toolName} is not marked read-only`,
      );
    }
    return { kind: 'ok', attachment, conn, tool };
  }

  /**
   * Sends a call to its page, checking again what may have changed while it
   * waited: the attachment, the page, the tool and the role. True if it went out.
   */
  #dispatch(call: PendingCall): boolean {
    const current = this.#recheck(call);
    if (current.kind === 'error') {
      call.settle(current);
      return false;
    }
    const { attachment, conn } = current;
    const { callDeadlineMs } = this.#config.timings;
    const remaining = call.waited ? callDeadlineMs - (Date.now() - call.arrivedAt) : callDeadlineMs;
    if (remaining <= 0) {
      call.settle(this.#queuedTooLong());
      return false;
    }
    const encoded = this.#encodeInvoke(call, attachment.role, remaining);
    if (encoded.kind === 'error') {
      call.settle(encoded);
      return false;
    }
    call.conn = conn;
    conn.inflight.set(call.callId, call);
    this.#armCallTimer(call);
    if (call.marks) call.marks.invokeOut = performance.now();
    conn.ws.send(encoded.text);
    return true;
  }

  /**
   * Starts the next queued call of a page if none of its mutating calls is on
   * the page. A head still being checked holds its place, and the calls behind
   * it wait with it, so writes reach the page in arrival order.
   */
  #pump(pageId: string): void {
    const queue = this.#queues.get(pageId);
    if (!queue || this.#pumping.has(pageId)) return;
    this.#pumping.add(pageId);
    const nextReady = (): PendingCall | undefined =>
      queue.waiting[0]?.checking === false ? queue.waiting.shift() : undefined;
    try {
      let next = queue.running ? undefined : nextReady();
      while (next) {
        queue.running = next;
        if (this.#dispatch(next)) break;
        // Refused at the front, it settled and freed the queue for the call behind it.
        next = nextReady();
      }
    } finally {
      this.#pumping.delete(pageId);
    }
    if (!queue.running && queue.waiting.length === 0 && this.#queues.get(pageId) === queue) {
      this.#queues.delete(pageId);
    }
  }

  /** Takes a settled call out of its socket's in-flight set and its page's queue. */
  #detachCall(call: PendingCall): void {
    call.conn?.inflight.delete(call.callId);
    const queue = this.#queues.get(call.pageId);
    if (!queue) return;
    const at = queue.waiting.indexOf(call);
    if (at !== -1) queue.waiting.splice(at, 1);
    if (queue.running === call) queue.running = null;
    this.#pump(call.pageId);
  }

  /**
   * Every call moves its attachment's expiry (ADR 0009), refused or not. A
   * moved expiry alone sends a roster only once the one the page shows has
   * fallen a refresh step behind. Returns whether it sent one.
   */
  #touchAttachment(attachment: AttachmentRecord, now: number): boolean {
    attachment.lastUsedAt = now;
    attachment.expiresAt = now + this.#config.timings.attachmentIdleMs;
    this.#armExpiry(attachment);
    this.#store.attachments.put(attachment);
    if (now - (this.#rosterSentAt.get(attachment.pageId) ?? 0) < this.#rosterStep()) return false;
    this.#sendCallRoster(attachment.pageId, now);
    return true;
  }

  /**
   * Records the client of a call that passed every check. A new client goes
   * out at once if no roster went out for a call in the last refresh step, or
   * if the last one was this call's own arrival roster, which could not name
   * it yet; otherwise with a trailing roster at the end of the step. A touch
   * sends at most one roster per step, so a client that renames itself on
   * every call adds at most one more per step and cannot keep the operator's
   * roster moving.
   */
  #nameClient(call: PendingCall, attachment: AttachmentRecord, now: number): void {
    const { pageId } = call;
    const named = this.#recordClient(attachment, call.caller.client);
    this.#store.attachments.put(attachment);
    if (!named || this.#rosterTimers.has(pageId)) return;
    const step = this.#rosterStep();
    const last = this.#callRosterAt.get(pageId) ?? 0;
    // A touch stamps its roster with the call's arrival time, and no other call
    // roster can follow within that millisecond (the step holds back touches
    // and names, and the touch's send cleared any trailing timer), so this
    // holds only while the arrival roster is still the last one for a call.
    const ownArrival = call.rosterAtArrival && last === call.arrivedAt;
    if (ownArrival || now - last >= step || now - (this.#rosterSentAt.get(pageId) ?? 0) >= step) {
      this.#sendCallRoster(pageId, now);
      return;
    }
    const since = now - last;
    this.#setTimer(this.#rosterTimers, pageId, step - since, () => {
      this.#sendCallRoster(pageId, Date.now());
    });
  }

  /** How often at most a roster goes out for what calls alone change. */
  #rosterStep(): number {
    return Math.min(
      EXPIRY_ROSTER_REFRESH_MS,
      Math.ceil(this.#config.timings.attachmentIdleMs / 10),
    );
  }

  #sendCallRoster(pageId: string, now: number): void {
    this.#sendRoster(pageId);
    this.#callRosterAt.set(pageId, now);
  }

  /** Records a client on the attachment, newest first; returns whether it was new. */
  #recordClient(attachment: AttachmentRecord, client: ClientInfo | null): boolean {
    if (!client) return false;
    const index = attachment.clients.findIndex((seen) => sameClient(seen, client));
    if (index !== -1) attachment.clients.splice(index, 1);
    attachment.clients.unshift(client);
    attachment.clients.length = Math.min(attachment.clients.length, MAX_ROSTER_CLIENTS);
    return index === -1;
  }

  detachPage(userId: string, pageId: string): DetachOutcome {
    this.#expireIfDue(pageId, userId);
    const attachment = this.#store.attachments.get(pageId, userId);
    if (attachment) {
      this.#endAttachments(pageId, new Set([userId]), 'client', 'you detached from this page');
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

  /**
   * Cancels everything in flight or queued, closes every page socket, stops
   * every timer and terminates the argument check worker.
   */
  async shutdown(): Promise<void> {
    this.#closed = true;
    // Checks still waiting on it come back unchecked, and their calls then see #closed.
    const checkerClosed = this.#checker.close();
    for (const waiter of [...this.#pairWaiters.values()].flatMap((waiters) => [...waiters])) {
      waiter(hubError('timeout', 'the relay is shutting down'));
    }
    const shuttingDown = hubError('page_asleep', 'the relay is shutting down');
    for (const queue of [...this.#queues.values()]) {
      for (const call of [...queue.waiting]) call.settle(shuttingDown);
    }
    const closing: Promise<void>[] = [];
    for (const conn of [...this.#conns]) {
      for (const callId of [...conn.inflight.keys()]) {
        this.#send(conn, { t: 'cancel', callId, reason: 'shutdown' });
      }
      this.#failInflight(conn, shuttingDown);
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
    for (const map of [
      this.#pairingTimers,
      this.#lifecycleTimers,
      this.#requestTimers,
      this.#expiryTimers,
      this.#rosterTimers,
    ]) {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    }
    this.#liveCodes.clear();
    await Promise.all([...closing, checkerClosed]);
  }
}

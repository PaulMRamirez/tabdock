// The page hub: every page socket, pairing ticket, attach request, attachment
// and call passes through here. The MCP side (mcp.ts) asks questions on behalf
// of an authenticated user; every answer is computed from that user's own
// attachments, so an unknown page and someone else's page look the same (S13).
// Mutating calls wait in a per-page queue and run one at a time in arrival
// order (SPEC section 5); read-only calls go straight to the page. The section 9
// limits and attachment idle expiry follow ADR 0009, argument checks ADR 0008
// and ADR 0010: they run in a worker thread with a time budget, never here.
// From M4 the hub also keeps a page's invites (ADRs 0016 and 0017): only their
// secrets' digests, their sponsor, what is pending on them and who is barred;
// every redemption still goes to the page as an attach request carrying the
// presented secret, since the adapter alone decides whether an invite is good.
// Every audit record (S7, ADR 0019) is written here, and a refusal that never
// reached a page passes the refusal budget first (audit-budget.ts). A page
// frame that changes nothing writes its lines only within a budget per socket
// and per address, past which they are counted, and never closes the page
// (ADR 0023); the lines each page connection writes have a budget per address
// too. What the hub sends a page that has stopped reading is held only up to
// a bound, past which the socket is closed, and a call whose invoke would
// fill that bound waits for room instead (ADR 0024 and its notes).

import {
  type AttachmentView,
  AttachRefusalSchema,
  type AttachVia,
  AUDIT_VERSION,
  type AuditCallEvent,
  type AuditEvent,
  type AuditEventOf,
  auditPageId,
  auditToolName,
  type ClientInfo,
  CLOSE_DETACH,
  CLOSE_REPLACED,
  encodeFrame,
  type ErrorCode,
  INVITE_BURN_REFUSALS,
  INVITE_PATH,
  type InviteListing,
  type InviteRefusalReason,
  InviteeIdSchema,
  InviteSecretSchema,
  inviteSecretOf,
  type JsonObject,
  type Limits,
  MAX_CONFIRMATION_FRAME_BYTES,
  MAX_DESCRIPTION_CHARS,
  MAX_FIRST_CLASS_CHARS_PER_USER,
  MAX_FIRST_CLASS_NAME_CHARS,
  MAX_FIRST_CLASS_TOOLS_PER_USER,
  MAX_FRAME_BYTES,
  MAX_INVITE_LIFETIME_MS,
  MAX_LIVE_INVITES_PER_PAGE,
  MAX_RESULT_CHARS,
  MEMBER_RESERVED_SEATS,
  MIN_INVITE_REMAINING_MS,
  type PageErrorCode,
  type PageFrame,
  type PageTool,
  type Pairing,
  parsePageFrame,
  type RelayFrame,
  type Role,
  type ToolAnnotations,
  truncate,
  UNVERIFIED_EMAIL,
} from '@tabdock/protocol';
import { createHash } from 'node:crypto';
import type { RawData, WebSocket } from 'ws';
import {
  ArgumentChecker,
  type PreparedSchema,
  prepareForCheck,
  type UncheckedReason,
} from './argument-checker.ts';
import { AuditRefusalBudget } from './audit-budget.ts';
import { foldName, type UserAccount } from './auth.ts';
import { MIN_REQUEST_BYTES, type ResolvedConfig } from './config.ts';
import {
  type FirstClassTool,
  firstClassEntry,
  firstClassName,
  firstClassToolPart,
} from './first-class.ts';
import type { LogFields, Logger, LogLevel } from './log.ts';
import { SlidingWindowLimiter } from './rate-limit.ts';
import { RepeatedLines } from './repeated-lines.ts';
import { childPosition, SCHEMA_TEXT_KEYS, type SchemaPosition } from './schema-keywords.ts';
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
import {
  type AttachmentRecord,
  type AttachRequestRecord,
  type AuditOutcome,
  type InviteRecord,
  type PageRecord,
  type PageState,
  recordAudit,
  type RelayStore,
  type SingleUseTicketRecord,
} from './store.ts';

type FrameOf<T extends PageFrame['t']> = Extract<PageFrame, { t: T }>;

/** How a pairing or redemption ended without an attachment, as its attach_refused record names it. */
type AttachRefusal = AuditEventOf<'attach_refused'>['outcome'];
type ExpireReason = AuditEventOf<'expire'>['reason'];
type InviteCloseReason = AuditEventOf<'invite_closed'>['reason'];

/** The fixed tools whose requests ADR 0018's per-user budget can refuse, with what each names. */
export type BudgetRefusal =
  | { tool: 'list_pages' }
  | { tool: 'list_page_tools' | 'detach_page'; page: string }
  | { tool: 'call_page_tool'; page: string; pageTool: string }
  | { tool: 'pair_page'; via: 'code' | 'invite' };

/** The lesser of two roles: an invite-made attachment never passes its invite's (ADR 0017). */
function lesserRole(a: Role, b: Role): Role {
  return a === 'observer' || b === 'observer' ? 'observer' : 'driver';
}

/** The code a refused pairing or redemption ended with, as its attach_refused record names it. */
function attachRefusalOf(code: ErrorCode): AttachRefusal {
  const parsed = AttachRefusalSchema.safeParse(code);
  // Every refusal a request can end with is one of them; anything else would be a relay bug.
  return parsed.success ? parsed.data : 'denied_by_operator';
}

/**
 * The digest a revoke bars an invitee's verified email by (ADR 0017): of the
 * address folded as display names are, so a second sign-up under another
 * capitalisation is the same address. Never logged or audited (ADR 0019).
 */
export function emailBarDigest(email: string): string {
  return digestHex(`invitee email ${foldName(email)}`);
}

/** Who is asking, as the MCP side established it. */
export interface CallerIdentity {
  userId: string;
  displayName: string;
  /** Member or invitee, and any verified email, as the auth plugin said (ADRs 0017 and 0020). */
  account: UserAccount;
  /** The access token's client_id, for the audit log's attach records (ADR 0019); null for none. */
  oauthClientId: string | null;
  client: ClientInfo | null;
}

export interface HubError {
  kind: 'error';
  code: ErrorCode;
  message: string;
}

export type PairOutcome =
  | {
      kind: 'attached';
      pageId: string;
      origin: string;
      role: Role;
      existing: boolean;
      /**
       * For an attachment an invite made, the sponsor's display name, so
       * pair_page can say "shared by <sponsor>" as /i does (ADR 0016).
       */
      sponsor?: string;
    }
  | HubError;

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

/** What /i shows for a live invite before anyone joins (ADR 0016); looking uses nothing up. */
export interface InvitePreview {
  /** From the page socket's Origin header (S1), never from the page's own words. */
  origin: string;
  /** Written by the page (S10): capped, and shown as the page's own words. */
  title: string;
  titleCut: boolean;
  /** The operator's label for the invite, page-written like the title. */
  label: string;
  /** observer for Can watch, driver for Can control. */
  role: Role;
  /** "Shared by": the sponsor's name, fixed when the invite was minted. */
  sponsor: string;
  expiresAt: number;
}

/**
 * The hub's invite surface (ADRs 0016 and 0017); /i, pair_page and the
 * invitee session pool call it. The page side arrives as invite_create and
 * invite_cancel frames, which a relay with invites off ignores, as it sends
 * no invites frame at all. With them on, by ADR 0017's notes: every
 * redemption reaches the page as an attach_request via invite with the
 * presented secret, autoApprove or not; an invites frame follows every
 * welcome, answers every invite_create and goes out on every change; and a
 * revoke of one user bars them from the invite that let them in but never
 * cancels it.
 */
export interface InviteHub {
  /**
   * pair_page's invite input: a link minted for one use, or its secret.
   * Counted like a code per user and per page, and per invite; waits for the
   * operator like pairPage when the invite needs a prompt.
   */
  redeemInvite(
    caller: CallerIdentity,
    invite: string,
    signal: AbortSignal,
    heldBytes?: number,
  ): Promise<PairOutcome>;
  /** What /i shows; null for an unknown, used, cancelled, expired or unsponsored secret alike. */
  previewInvite(secret: string): InvitePreview | null;
  /** /i's Join, like claimPairNonce: refused at once, or claimed with the outcome to come. */
  claimInvite(caller: CallerIdentity, secret: string): ClaimOutcome;
  /** Whether the user holds any attachment, which decides an invitee's session pool and audit budget. */
  holds(userId: string): boolean;
}

/** What #grant takes from an attach request, or from a caller let in without one. */
type GrantRequest = Pick<
  AttachRequestRecord,
  'pageId' | 'userId' | 'displayName' | 'account' | 'oauthClientId' | 'client' | 'via'
> &
  Partial<Pick<AttachRequestRecord, 'joined'>>;

/** A redemption that needs the page's answer, or one settled at once. */
type Started = PairOutcome | { kind: 'pending'; record: AttachRequestRecord };

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
  /**
   * With first-class tools on (ADR 0025), the caller's first-class name for
   * the tool, or null when their list leaves it off; absent with them off.
   */
  firstClass?: string | null;
}

export type ToolsOutcome =
  { kind: 'tools'; pageId: string; origin: string; role: Role; tools: ToolListing[] } | HubError;

/**
 * How a call ended. callPageTool names the page tool it reached in `tool`,
 * as the call resolved it, so a result's untrusted header reads the same
 * whichever route named the tool (ADR 0025).
 */
export type CallOutcome =
  | { kind: 'ok'; origin: string; content: string; tool?: string }
  /** The page's handler failed; its message is page-supplied text. */
  | { kind: 'tool_error'; origin: string; message: string; tool?: string }
  /** The MCP client abandoned the call. */
  | { kind: 'cancelled' }
  | HubError;

export type DetachOutcome = { kind: 'detached'; pageId: string } | HubError;

/** Why a page socket was refused before it was upgraded. */
export interface SocketRefusal {
  status: 429 | 503;
  message: string;
}

/**
 * Whether a call reached its page: such a call is always written to the
 * audit log in full, and one refused before only within the refusal budget
 * (S7, ADR 0019).
 */
interface CallTrace {
  reached: boolean;
  /** Returns what the call's request was charged against what waiting requests hold (#holdBytes). */
  release: (() => void) | null;
  /**
   * The page tool its record names: as the client wrote it until a
   * first-class name resolves, then the page tool's own name, so a call by
   * either route leaves the same line (S7, ADR 0025).
   */
  tool: string;
}

/** Why the relay tells a page to stop a call. */
type CancelReason = NonNullable<Extract<RelayFrame, { t: 'cancel' }>['reason']>;

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
  /** The socket its invoke went out on; null while it waits in the queue or for room. */
  conn: Conn | null;
  /** The socket whose queue it waits on for room to send its invoke (#hold); null otherwise. */
  heldOn: Conn | null;
  /** Its invoke frame's size when it arrived, a confirmation's room included, for the room check while it is held. */
  invokeBytes: number;
  /** Filled in for the spike's timing (spike.ts); null otherwise. */
  marks: CallMarks | null;
  /** Whether its invoke went out, which decides how its audit record is written. */
  trace: CallTrace;
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
  /** What it is charged against limits.toolBytes, kept while it is reused unchanged (heldBytes). */
  held: number;
  /**
   * Its first-class entry, built once from the cut copy with first-class
   * tools on (ADR 0025) and charged within `held`; null with them off, or
   * when its schema's root keeps it off every list.
   */
  firstClass: FirstClassTool | null;
}

/**
 * A page's first-class entries as its last tools frame left them, in the
 * page's order: those whose names fit MAX_FIRST_CLASS_NAME_CHARS and that no
 * other tool of the page maps to. `version` is new with every frame, so a
 * user's list built from an older one is known to be stale.
 */
interface PageFirstClass {
  version: number;
  entries: { toolName: string; readOnly: boolean; tool: FirstClassTool; chars: number }[];
}

/**
 * One member's first-class list (ADR 0025), kept while it still matches
 * their attachments: `key` names each attachment it was built from, its
 * role and its page's version, so any change to them shows as another key
 * on the next look and the list is built again before it is served.
 */
interface FirstClassSnapshot {
  key: string;
  tools: FirstClassTool[];
  /** Each page's listed tools by page tool name, to their first-class names, for list_page_tools. */
  names: Map<string, Map<string, string>>;
  /** SHA-256 of the list as clients receive it; the notifier compares it (page-tool-notifier.ts). */
  digest: string;
}

/** What a member with no first-class tools is served, and the digest every notifier starts from. */
export const EMPTY_FIRST_CLASS: Readonly<FirstClassList> = Object.freeze({
  tools: [],
  digest: createHash('sha256').update('[]').digest('hex'),
});

/** A user's first-class tools as tools/list carries them, with the list's digest. */
export interface FirstClassList {
  tools: readonly FirstClassTool[];
  digest: string;
}

/**
 * A page tool as a call names it: by its own name through call_page_tool,
 * or by the part of a first-class name after `<page id>__` (ADR 0025), which
 * the hub resolves at the step where it looks the tool up.
 */
export type PageToolRef = string | { firstClass: string };

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
  /** When this socket's recent frames that changed nothing arrived, for ignoredFramesPerSocket. */
  ignoredFrames: number[];
  /**
   * Frames handed to ws that ws has not yet handed the kernel, counted
   * exactly through each send's callback (#write): all of them, and those
   * that count toward closing a page that is not reading, which is every
   * frame but a call's invoke and cancel. Both counts start over, with a new
   * epoch, whenever the socket's queue is seen empty, since a callback comes
   * a tick after its bytes left (#observe).
   */
  queue: { epoch: number; frames: number; counted: number };
  /** Calls whose invoke waits for room on this socket, oldest first (#hold). */
  held: PendingCall[];
}

/**
 * Client addresses whose held-back lines one window tracks; past it the rest
 * share one count, as auth-log.ts does, since behind a host edge every IPv6
 * /56 is an address of its own.
 */
const MAX_ADDRESSES_HOLDING_LINES = 10_000;
/**
 * How long past a request's own lifetime a page's decision for it is still
 * expected once the relay has ended it: the page's timer runs on its own
 * clock and its answer crosses the network (#decision).
 */
const ENDED_REQUEST_GRACE_MS = 30_000;
/** Ended requests remembered at once; pairing limits keep the real number far below. */
const MAX_ENDED_REQUESTS = 10_000;

/** One line a frame's handler wrote, held until it is known whether the frame changed anything. */
interface HeldLine {
  level: LogLevel;
  message: string;
  fields: LogFields | undefined;
  /** An audit record's stderr copy, which is written whatever the frame did (ADR 0019). */
  kept: boolean;
}

/**
 * The hub's logger, which can hold the lines one page frame's handler writes
 * (hold) and then write them all, or only those it must keep (write).
 * Handlers run synchronously, so nothing else writes while lines are held.
 */
class FrameLog implements Logger {
  readonly #inner: Logger;
  #held: HeldLine[] | null = null;
  /**
   * The same logger for audit records' stderr copies, which are never held
   * back: while the audit disk fails they are the only copy (ADR 0019).
   */
  readonly kept: Logger;

  constructor(inner: Logger) {
    this.#inner = inner;
    this.kept = {
      debug: (message, fields) => {
        this.#line('debug', message, fields, true);
      },
      info: (message, fields) => {
        this.#line('info', message, fields, true);
      },
      warn: (message, fields) => {
        this.#line('warn', message, fields, true);
      },
      error: (message, fields) => {
        this.#line('error', message, fields, true);
      },
    };
  }

  debug(message: string, fields?: LogFields): void {
    this.#line('debug', message, fields, false);
  }

  info(message: string, fields?: LogFields): void {
    this.#line('info', message, fields, false);
  }

  warn(message: string, fields?: LogFields): void {
    this.#line('warn', message, fields, false);
  }

  error(message: string, fields?: LogFields): void {
    this.#line('error', message, fields, false);
  }

  /**
   * Runs a handler, holding every line it writes; its answer, and those
   * lines. A handler that throws has its lines written first, as they would
   * have been without holding them.
   */
  hold<T>(handle: () => T): { result: T; lines: HeldLine[] } {
    const outer = this.#held;
    const lines: HeldLine[] = [];
    this.#held = lines;
    try {
      return { result: handle(), lines };
    } catch (error) {
      this.#held = outer;
      this.write(lines, true);
      throw error;
    } finally {
      this.#held = outer;
    }
  }

  /** Writes held lines in order: all of them, or only those that must be kept. */
  write(lines: readonly HeldLine[], all: boolean): void {
    for (const { level, message, fields, kept } of lines) {
      if (all || kept) this.#inner[level](message, fields);
    }
  }

  #line(level: LogLevel, message: string, fields: LogFields | undefined, kept: boolean): void {
    if (this.#held === null) this.#inner[level](message, fields);
    else this.#held.push({ level, message, fields, kept });
  }
}

const CLOSE_POLICY = 1008;
const CLOSE_GOING_AWAY = 1001;
/** The standard "try again later": a page refused for want of room reconnects with backoff. */
const CLOSE_TRY_AGAIN_LATER = 1013;
/** A newer socket resumed this page's session. */
export const CLOSE_RESUMED_ELSEWHERE = CLOSE_REPLACED;
const CLOSE_GRACE_MS = 2000;
/**
 * What the relay keeps queued for one page that has not read it: the bytes
 * on its socket past what the kernel took, and the frames among them that
 * are not a call's (ADR 0024). /page takes no credential, and the relay
 * answers pings, revokes, invite frames and rotate_pairing with frames of
 * its own, so a socket that stopped reading while it sent them held every
 * answer in memory: 80 to 140 MiB of heap for a million pings. Each small
 * frame queued costs a few hundred bytes beside its own, so the frames are
 * counted as well as the bytes. Past either the page is closed.
 */
export const MAX_UNREAD_BYTES = 2 * MAX_FRAME_BYTES;
export const MAX_UNREAD_FRAMES = 256;
/**
 * The most a page's queue may hold, its own invoke included, for an invoke
 * to go out; one always goes onto an empty queue. Past it the call waits
 * for room (#hold), so a member's calls never close a page: a page that
 * stopped reading held every invoke sent it, 116 MiB for 120 calls of 1 MB,
 * and a page reading on a slow link was closed by the next pong once
 * invokes had filled its queue (ADR 0024's notes). Half MAX_UNREAD_BYTES,
 * so what invokes hold leaves a frame of the largest size of room for
 * everything else, and what else the relay sends a page is far smaller.
 */
export const INVOKE_ROOM = MAX_FRAME_BYTES;
const MAX_ROSTER_CLIENTS = 20;
/**
 * Each call moves its attachment's expiresAt, but the roster carrying it is
 * re-sent at most this often for that alone: a client calling fast must not
 * keep the operator's roster rows moving under their pointer.
 */
export const EXPIRY_ROSTER_REFRESH_MS = 60_000;
/**
 * Promotions and minted invites one page may make together per rate-limit
 * window. Each writes audit records the operator caused, which ADR 0019
 * writes in full, and a page session needs no credential, so a page with
 * one member attached could otherwise toggle a role or mint and cancel
 * invites fast enough to rotate every other record out of the log. Ten a
 * minute is more than a person clicking needs; what takes access away
 * (a demotion, a revoke, a cancel) is never counted or refused.
 */
export const OPERATOR_GRANTS_PER_PAGE = 10;

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

/** "2.5 MiB", for messages about memory. */
function mebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** A request's charge against what requests waiting on pages may hold, and its return. */
type HeldBytes = { kind: 'held'; release: () => void } | HubError;

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

class SchemaTooDeep extends Error {}
class SchemaKeyTooLong extends Error {}

/**
 * What a listed tool keeps on the heap, counted as it is cut: the values and
 * object keys of the copy clients are shown, and the characters of every
 * string it holds. limits.toolBytes is charged from this (heldBytes), never
 * from the frame's size on the wire (S9, ADR 0018).
 */
interface HeldTally {
  nodes: number;
  chars: number;
}

/**
 * Counts a string the cut copy keeps. A cut string is a new one that may
 * still point into the page's original, so both are counted.
 */
function holdText(text: string, tally: HeldTally): string {
  const cut = truncate(text, MAX_DESCRIPTION_CHARS);
  tally.nodes += 1;
  tally.chars += cut.truncated ? text.length + cut.text.length : text.length;
  return cut.text;
}

/** Counts a small value the relay made itself and keeps as it is, such as a stub schema. */
function holdValue(value: unknown, tally: HeldTally): void {
  tally.nodes += 1;
  if (typeof value === 'string') tally.chars += value.length;
  else if (Array.isArray(value)) for (const item of value) holdValue(item, tally);
  else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      tally.nodes += 1;
      tally.chars += key.length;
      holdValue(item, tally);
    }
  }
}

/**
 * Every string anywhere in a schema is page text: enum values, defaults,
 * examples, patterns and comments reach the model as surely as descriptions do,
 * so all of them are cut to the description cap (S10).
 */
function cutSchemaText(
  value: unknown,
  depth: number,
  position: SchemaPosition,
  tally: HeldTally,
): unknown {
  if (depth > MAX_SCHEMA_DEPTH) throw new SchemaTooDeep();
  if (typeof value === 'string') return holdText(value, tally);
  tally.nodes += 1;
  if (Array.isArray(value)) {
    return value.map((item) => cutSchemaText(item, depth + 1, position, tally));
  }
  if (typeof value !== 'object' || value === null) return value;
  // fromEntries defines own properties, so a "__proto__" key stays a plain key.
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      // A key cannot be cut without changing what it names, so a long one removes the schema.
      if (key.length > MAX_DESCRIPTION_CHARS) throw new SchemaKeyTooLong();
      // A key is a slot in its object, and its text when no other object shares it.
      tally.nodes += 1;
      tally.chars += key.length;
      return [key, cutSchemaEntry(key, item, depth + 1, position, tally)];
    }),
  );
}

function cutSchemaEntry(
  key: string,
  item: unknown,
  depth: number,
  position: SchemaPosition,
  tally: HeldTally,
): unknown {
  if (position === 'schema' && SCHEMA_TEXT_KEYS.has(key) && typeof item !== 'string') {
    const removed = `[tabdock: non-string ${key} removed]`;
    holdValue(removed, tally);
    return removed;
  }
  return cutSchemaText(item, depth, childPosition(key, position), tally);
}

function removedSchema(why: string): JsonObject {
  return { type: 'object', description: `[tabdock: schema removed, ${why}]` };
}

/**
 * Page text in a schema is capped like a description (S10), and a schema too
 * big or too deep to pass along, or with a key too long to pass, is replaced by
 * a stub that says so (S9).
 */
function cutSchema(schema: JsonObject, tally: HeldTally): JsonObject {
  // Counted apart, since a copy replaced by a stub is not kept.
  const counted: HeldTally = { nodes: 0, chars: 0 };
  const stub = (why: string): JsonObject => {
    const removed = removedSchema(why);
    holdValue(removed, tally);
    return removed;
  };
  let cut: JsonObject;
  try {
    cut = cutSchemaText(schema, 0, 'schema', counted) as JsonObject;
  } catch (error) {
    if (error instanceof SchemaTooDeep) {
      return stub(`nested more than ${String(MAX_SCHEMA_DEPTH)} levels deep`);
    }
    if (error instanceof SchemaKeyTooLong) {
      return stub(`a key longer than ${String(MAX_DESCRIPTION_CHARS)} characters`);
    }
    throw error;
  }
  const size = JSON.stringify(cut).length;
  if (size > MAX_SCHEMA_CHARS) return stub(`${String(size)} characters`);
  tally.nodes += counted.nodes;
  tally.chars += counted.chars;
  return cut;
}

/**
 * Every page-written string in a tool is capped once, as it arrives, before
 * any client sees it. What the copy keeps, a stub schema given in place of the
 * page's included, is added to the tally.
 */
function cutTool(tool: PageTool, tally: HeldTally, stubSchema?: JsonObject): PageTool {
  let inputSchema: JsonObject;
  if (stubSchema === undefined) {
    inputSchema = cutSchema(tool.inputSchema, tally);
  } else {
    holdValue(stubSchema, tally);
    inputSchema = stubSchema;
  }
  // The spread keeps the parsed tool's name, title and annotations as they are.
  holdValue(tool.name, tally);
  if (tool.title !== undefined) holdValue(tool.title, tally);
  if (tool.annotations !== undefined) holdValue(tool.annotations, tally);
  return { ...tool, description: holdText(tool.description, tally), inputSchema };
}

/**
 * What one listed tool is charged against limits.toolBytes (S9, ADR 0018): an
 * upper bound on the heap it holds, never its size on the wire. A frame of
 * small empty objects or arrays holds many times its size in the copies
 * clients are shown, while long text the relay cuts or replaces holds little
 * of it. Each value and key of the cut copy costs TOOL_NODE_HEAP_BYTES, which
 * covers an object, its hidden class when its keys are its own, and its slot
 * in its parent; each character kept, the prepared schema's included, costs
 * two bytes, since one character past Latin-1 makes V8 store a whole string at
 * two bytes each; and TOOL_HEAP_BYTES covers the rest of the tool's record
 * (its hashes, its check and the maps that hold them). The constants were
 * measured with a probe of node-dense, string-heavy and two-byte frames under
 * --expose-gc, and sit above the most any of them held (tool-heap.test.ts).
 */
function heldBytes(tally: HeldTally, preparedChars: number): number {
  return TOOL_HEAP_BYTES + tally.nodes * TOOL_NODE_HEAP_BYTES + 2 * (tally.chars + preparedChars);
}

/** Heap a listed tool holds besides its nodes and characters; see heldBytes. */
export const TOOL_HEAP_BYTES = 1024;
/** Heap one value or key of a tool's cut copy may hold; see heldBytes. */
export const TOOL_NODE_HEAP_BYTES = 128;

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
  /**
   * What each page's listed tools are charged against limits.toolBytes: an
   * upper bound on the heap their cut copies and prepared schemas hold
   * (heldBytes), which a frame's size on the wire is not (S9, ADR 0018).
   */
  readonly #toolBytes = new Map<string, number>();
  #toolBytesHeld = 0;
  /** Each awake page's first-class entries while first-class tools are on (ADR 0025). */
  readonly #firstClassPages = new Map<string, PageFirstClass>();
  #firstClassVersion = 0;
  /** Members' first-class lists, rebuilt whenever what they were built from changed. */
  readonly #firstClassLists = new Map<string, FirstClassSnapshot>();
  /** Told the users whose first-class list may have changed; the notifier reads it later. */
  #firstClassListener: ((userId: string) => void) | null = null;
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
  /**
   * What the /mcp requests waiting on a page hold on the heap, by user, in
   * all, and for invitees together, each charged what request-heap.ts
   * measures its body to hold, from when it may start waiting until it is
   * answered (#holdBytes).
   */
  readonly #heldBytes = new Map<string, number>();
  #heldTotal = 0;
  #heldByInvitees = 0;
  /** Tools frames per remote address, shared by its sockets and kept across reconnects. */
  readonly #toolsFrameLimiter: SlidingWindowLimiter;
  /**
   * Lines of frames that changed nothing, per remote address: written in full
   * up to ignoredFramesPerAddress a window, across the address's sockets and
   * reconnects, then held back and counted (#ignored, ADR 0023).
   */
  readonly #ignoredLines: RepeatedLines;
  /**
   * Lines each page connection writes, per remote address: written in full
   * up to connectionLinesPerAddress a window, then counted by message into
   * one line for the address (#connectionLine, ADR 0023's notes).
   */
  readonly #connectionLines: RepeatedLines;
  /** The hub's own lines, which a frame's handler can hold until it is known whether it changed anything. */
  readonly #frameLog: FrameLog;
  /**
   * Requests each page just had ended, by id, oldest first: a decision the
   * page sends for one is expected, since the page may not yet know (#decision).
   */
  readonly #endedRequests = new Map<string, { pageId: string; until: number }>();
  /**
   * Redemptions of one invite, whoever makes them (ADR 0017), keyed by page
   * and invite id, so only live invites, which a page holds ten of at most,
   * are ever keys.
   */
  readonly #inviteLimiter: SlidingWindowLimiter;
  /** One per live invite, keyed by inviteKey: fires at the invite's expiresAt. */
  readonly #inviteTimers = new Map<string, NodeJS.Timeout>();
  /** Promotions and mints per page (OPERATOR_GRANTS_PER_PAGE), kept across its reconnects. */
  readonly #grantLimiter: SlidingWindowLimiter;
  /** One warning per page and window once its grants run out, so a flood writes no line per frame. */
  readonly #grantWarnings: SlidingWindowLimiter;
  /** Refusals that reached no page pass this before the audit log (ADR 0019). */
  readonly #budget: AuditRefusalBudget;
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
    this.#frameLog = new FrameLog(log);
    this.#log = this.#frameLog;
    this.#spike = spike;
    const {
      pairAttemptsPerUser,
      pairAttemptsPerPage,
      callsPerUserPerPage,
      windowMs,
      toolsFramesPerAddress,
      toolsFramesWindowMs,
      ignoredFramesPerAddress,
      connectionLinesPerAddress,
      redemptionsPerInvite,
      auditRefusalsPerUser,
      auditRefusalsForStrangers,
    } = config.rateLimits;
    this.#userLimiter = new SlidingWindowLimiter(pairAttemptsPerUser, windowMs);
    this.#pageLimiter = new SlidingWindowLimiter(pairAttemptsPerPage, windowMs);
    this.#callLimiter = new SlidingWindowLimiter(callsPerUserPerPage, windowMs);
    this.#toolsFrameLimiter = new SlidingWindowLimiter(toolsFramesPerAddress, toolsFramesWindowMs);
    this.#ignoredLines = new RepeatedLines({
      linesPerKey: ignoredFramesPerAddress,
      windowMs,
      maxKeys: MAX_ADDRESSES_HOLDING_LINES,
      summary: (address, held) => {
        log.warn('page frames that changed nothing went unlogged', {
          ...(address === null ? { addresses: 'more than tracked' } : { address }),
          repeated: held.repeated,
          frames: held.reasons,
        });
      },
    });
    this.#connectionLines = new RepeatedLines({
      linesPerKey: connectionLinesPerAddress,
      windowMs,
      maxKeys: MAX_ADDRESSES_HOLDING_LINES,
      summary: (address, held) => {
        log.warn('page connection lines went unlogged', {
          ...(address === null ? { addresses: 'more than tracked' } : { address }),
          repeated: held.repeated,
          lines: held.reasons,
        });
      },
    });
    this.#inviteLimiter = new SlidingWindowLimiter(redemptionsPerInvite, windowMs);
    this.#grantLimiter = new SlidingWindowLimiter(OPERATOR_GRANTS_PER_PAGE, windowMs);
    this.#grantWarnings = new SlidingWindowLimiter(1, windowMs);
    this.#checker = new ArgumentChecker({ budgetMs: config.timings.argumentCheckMs, log });
    this.#budget = new AuditRefusalBudget({
      perUser: auditRefusalsPerUser,
      strangers: auditRefusalsForStrangers,
      windowMs,
      holds: (userId) => this.holds(userId),
      write: (event) => {
        this.#audit(event);
      },
    });
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
      this.connectionLine(address, 'warn', 'page socket refused: too many from one address', {
        address,
      });
      return { status: 429, message: 'Too many page sockets from this address' };
    }
    // Ending asleep pages frees no sockets, so open ones alone are refused outright.
    if (this.#conns.size >= pageSessions) {
      this.connectionLine(
        address,
        'warn',
        'page socket refused: the relay holds the most page sockets allowed',
        { address },
      );
      return { status: 503, message: 'The relay holds as many pages as it can; try again later' };
    }
    return null;
  }

  /**
   * A line one page connection writes, from an upgrade relay.ts refuses to
   * the page it made going: within connectionLinesPerAddress a window for
   * its remote address, and past that counted, by message, into one line
   * for the address when the window ends (ADR 0023's notes). /page needs no
   * credential and each connection writes a few such lines, so without this
   * a script wrote them as fast as it could connect, to the stderr copy that
   * carries the audit checkpoints (ADR 0019). The address is the key the
   * per-address limits count by; a request whose client the edge did not
   * name is keyed by what was wrong. Never held with a frame's own lines.
   */
  connectionLine(address: string, level: LogLevel, message: string, fields: LogFields): void {
    if (this.#connectionLines.take(address, message, undefined)) {
      this.#frameLog.kept[level](message, fields);
    }
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
        this.connectionLine(address, 'warn', 'page session refused: too many from one address', {
          address,
        });
        return 'too many pages from this address; try again later';
      }
      this.connectionLine(
        address,
        'info',
        "ended this address's page asleep longest to make room for its new one",
        { pageId: oldest },
      );
      this.#gone(oldest);
    }
    if (this.#pageAddress.size >= pageSessions) {
      const oldest = firstOf(own?.asleep) ?? firstOf(this.#asleep);
      if (oldest === undefined) {
        this.connectionLine(
          address,
          'warn',
          'page session refused: the relay holds the most page sessions allowed',
          { address },
        );
        return 'the relay holds as many pages as it can; try again later';
      }
      this.connectionLine(
        address,
        'info',
        'ended the page asleep longest to make room for a new one',
        { pageId: oldest },
      );
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
      ignoredFrames: [],
      queue: { epoch: 0, frames: 0, counted: 0 },
      held: [],
    };
    this.#conns.add(conn);
    this.#socketsByAddress.set(address, (this.#socketsByAddress.get(address) ?? 0) + 1);
    conn.helloTimer = setTimeout(() => {
      this.connectionLine(address, 'info', 'closing page socket: no hello in time', {
        origin,
        address,
      });
      this.#closeSocket(conn, CLOSE_POLICY, 'hello timeout');
    }, this.#config.timings.helloTimeoutMs);
    conn.helloTimer.unref();
    ws.on('message', (data, isBinary) => {
      this.#onMessage(conn, data, isBinary);
    });
    // The WebSocket ping control frame, which relay.ts stops ws answering on its
    // own: its pong is queued like any frame the relay sends, within the same bound.
    ws.on('ping', (data) => {
      if (conn.closing || ws.readyState !== ws.OPEN) return;
      if (!this.#roomFor(conn, data.length)) return;
      this.#write(conn, true, (written) => {
        ws.pong(data, false, written);
      });
    });
    ws.on('close', (code) => {
      this.#onClose(conn, code);
    });
    ws.on('error', (error) => {
      this.connectionLine(address, 'warn', 'page socket error', { pageId: conn.pageId, error });
    });
  }

  #onMessage(conn: Conn, data: RawData, isBinary: boolean): void {
    if (conn.closing) return;
    conn.idleTimer?.refresh();
    if (isBinary) {
      this.connectionLine(conn.address, 'warn', 'closing page socket: binary frame', {
        pageId: conn.pageId,
      });
      this.#closeSocket(conn, CLOSE_POLICY, 'binary frames are not accepted');
      return;
    }
    const text = rawToText(data);
    const parsed = parsePageFrame(text);
    if (parsed.kind === 'unknown') {
      const { pageId } = conn;
      // The first frame must be hello, whatever comes instead (ADR 0023).
      if (pageId === null) {
        this.connectionLine(
          conn.address,
          'warn',
          'closing page socket: first frame was not hello',
          { frameType: parsed.type },
        );
        this.#closeSocket(conn, CLOSE_POLICY, 'first frame must be hello');
        return;
      }
      // A newer adapter's frame, or junk: ignored, and logged within the budget.
      this.#mayChangeNothing(conn, 'unknown type', () => {
        this.#log.warn('ignored a frame of unknown type', { pageId, frameType: parsed.type });
        return false;
      });
      return;
    }
    if (parsed.kind === 'invalid') {
      this.connectionLine(conn.address, 'warn', 'closing page socket: malformed frame', {
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
        this.connectionLine(
          conn.address,
          'warn',
          'closing page socket: first frame was not hello',
          { frameType: frame.t },
        );
        this.#closeSocket(conn, CLOSE_POLICY, 'first frame must be hello');
      }
      return;
    }
    switch (frame.t) {
      case 'hello':
        this.connectionLine(conn.address, 'warn', 'closing page socket: second hello', { pageId });
        this.#closeSocket(conn, CLOSE_POLICY, 'hello sent twice');
        return;
      case 'tools':
        if (this.#toolsFrameAllowed(conn)) this.#tools(conn, pageId, frame);
        return;
      // Each of these says whether it changed anything; one that did not counts (#ignored).
      case 'attach_decision':
        this.#mayChangeNothing(conn, frame.t, () => this.#decision(pageId, frame));
        return;
      case 'set_role':
        this.#mayChangeNothing(conn, frame.t, () => this.#setRole(pageId, frame));
        return;
      case 'revoke':
        this.#mayChangeNothing(conn, frame.t, () => this.#revoke(pageId, frame));
        return;
      case 'rotate_pairing':
        this.#rotateTicket(pageId, 'asked by page');
        return;
      case 'invite_create':
      case 'invite_cancel':
        this.#mayChangeNothing(conn, frame.t, () => this.#inviteFrame(pageId, frame));
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

  /**
   * A page minting or cancelling an invite (ADR 0017). A relay with invites
   * off mints none and sends no invites frame at all (ADR 0017's notes), so a
   * page that sends one anyway is ignored, its secret's hash unlogged.
   * Answers whether it minted or closed an invite.
   */
  #inviteFrame(pageId: string, frame: FrameOf<'invite_create' | 'invite_cancel'>): boolean {
    if (!this.#config.invites) {
      this.#log.warn('ignored an invite frame: this relay mints no invites', {
        pageId,
        frameType: frame.t,
      });
      return false;
    }
    return frame.t === 'invite_create'
      ? this.#inviteCreate(pageId, frame)
      : this.#inviteCancel(pageId, frame);
  }

  // Invites (ADRs 0016 and 0017)

  /** `<public URL>/i`, where links start, or null where no invite can be minted. */
  #linkBase(): string | null {
    const { publicUrl } = this.#config;
    return publicUrl === null ? null : `${publicUrl}${INVITE_PATH}`;
  }

  /** The page's own terms back, with what only the relay knows: uses left, sponsor, pending, refusals. */
  #listing(invite: InviteRecord): InviteListing {
    return {
      inviteId: invite.inviteId,
      role: invite.role,
      label: invite.label,
      uses: invite.uses,
      // On the page's clock, as it asked, so the adapter matches its own record.
      expiresAt: invite.requestedExpiresAt,
      usesLeft: invite.usesLeft,
      sponsor: { ...invite.sponsor },
      pending: this.#pendingOn(invite).length > 0,
      refusals: invite.refusals,
    };
  }

  /** Redemptions of this invite still waiting on the operator. */
  #pendingOn(invite: InviteRecord): AttachRequestRecord[] {
    return this.#store.requests
      .listForPage(invite.pageId)
      .filter((request) => request.inviteId === invite.inviteId);
  }

  /** The page's live invites, after each welcome and on every change; refused answers an invite_create. */
  #sendInvites(pageId: string, refused?: { inviteId: string; reason: InviteRefusalReason }): void {
    if (!this.#config.invites) return;
    const conn = this.#live.get(pageId);
    if (!conn) return;
    this.#send(conn, {
      t: 'invites',
      linkBase: this.#linkBase(),
      invites: this.#store.invites.listForPage(pageId).map((invite) => this.#listing(invite)),
      ...(refused === undefined ? {} : { refused }),
    });
  }

  /**
   * The member attached longest, who sponsors whatever the page mints now
   * and stays its sponsor: /i shows the name, so it never moves to another
   * (ADR 0017). An attachment past its time sponsors nothing, and neither
   * does one let in by the invite of a member past theirs, so each member is
   * looked at through #chainInTime, which ends whoever is due as the timer
   * would; otherwise the page would list a link that #findInvite refuses on
   * arrival, at the cost of one of its grants.
   */
  #sponsorOf(pageId: string): AttachmentRecord | null {
    let sponsor: AttachmentRecord | null = null;
    for (const attachment of this.#store.attachments.listForPage(pageId)) {
      if (attachment.kind !== 'member') continue;
      // An earlier member's end may have ended this one already; the walk then says so.
      if (!this.#chainInTime(pageId, attachment.userId)) continue;
      if (sponsor === null || attachment.grantedAt < sponsor.grantedAt) sponsor = attachment;
    }
    return sponsor;
  }

  /**
   * Mints an invite as far as the page's policy, its sponsor and the bounds
   * allow, keeping only the digest of its secret, and answers with an invites
   * frame either way, so the adapter's invite() always settles. The relay
   * judges expiresAt on its own clock: one under MIN_INVITE_REMAINING_MS away
   * says the page's clock runs behind, and none lasts past 24 hours.
   * Answers whether it minted one.
   */
  #inviteCreate(pageId: string, frame: FrameOf<'invite_create'>): boolean {
    const page = this.#store.pages.get(pageId);
    if (!page) return false;
    const now = Date.now();
    const refuse = (reason: InviteRefusalReason): void => {
      this.#log.info('invite refused', { pageId, inviteId: frame.inviteId, reason });
      this.#sendInvites(pageId, { inviteId: frame.inviteId, reason });
    };
    // A secret digest is unique across the relay, so a lookup by it finds one invite.
    if (
      this.#store.invites.get(pageId, frame.inviteId) !== undefined ||
      this.#store.invites.findBySecretHash(frame.secretHash) !== undefined
    ) {
      refuse('duplicate');
      return false;
    }
    if (
      page.policy.invites === 'off' ||
      (frame.role === 'driver' && page.policy.invites !== 'all')
    ) {
      refuse('policy');
      return false;
    }
    if (this.#linkBase() === null) {
      refuse('no_public_url');
      return false;
    }
    const sponsor = this.#sponsorOf(pageId);
    if (sponsor === null) {
      refuse('no_sponsor');
      return false;
    }
    if (frame.expiresAt !== null && frame.expiresAt - now < MIN_INVITE_REMAINING_MS) {
      refuse('expired');
      return false;
    }
    // Past the page's grants, a mint is refused as one past the live limit is,
    // so the adapter's invite() still settles and the page sees why.
    if (
      this.#store.invites.listForPage(pageId).length >= MAX_LIVE_INVITES_PER_PAGE ||
      !this.#grantAllowed(pageId, now)
    ) {
      refuse('limit');
      return false;
    }
    const longest = now + MAX_INVITE_LIFETIME_MS;
    const invite: InviteRecord = {
      inviteId: frame.inviteId,
      pageId,
      role: frame.role,
      label: frame.label,
      uses: frame.uses,
      usesLeft: frame.uses,
      createdAt: now,
      requestedExpiresAt: frame.expiresAt,
      expiresAt: frame.expiresAt === null ? longest : Math.min(frame.expiresAt, longest),
      secretHash: frame.secretHash,
      sponsor: { userId: sponsor.userId, displayName: sponsor.displayName },
      pendingRequestId: null,
      refusals: 0,
      barredUserIds: [],
      barredEmailHashes: [],
    };
    this.#store.invites.put(invite);
    this.#armInviteExpiry(invite);
    this.#audit({
      v: AUDIT_VERSION,
      type: 'invite_minted',
      at: now,
      pageId,
      origin: page.origin,
      inviteId: invite.inviteId,
      role: invite.role,
      uses: invite.uses,
      expiresAt: invite.requestedExpiresAt,
      sponsor: sponsor.userId,
    });
    this.#log.info('invite minted', {
      pageId,
      inviteId: invite.inviteId,
      role: invite.role,
      uses: invite.uses,
    });
    this.#sendInvites(pageId);
    return true;
  }

  /**
   * Counts one promotion or mint against the page's OPERATOR_GRANTS_PER_PAGE,
   * or says it is past them. Keyed by page id, which only pairing gives an
   * attachment, so a page that starts a new session to reset it needs its
   * members to pair again, which their own limits bound.
   */
  #grantAllowed(pageId: string, now: number): boolean {
    if (this.#grantLimiter.allows(pageId, now)) {
      this.#grantLimiter.record(pageId, now);
      return true;
    }
    if (this.#grantWarnings.allows(pageId, now)) {
      this.#grantWarnings.record(pageId, now);
      this.#log.warn('promotion or invite refused: the page made too many this window', {
        pageId,
      });
    }
    return false;
  }

  /**
   * Closes one invite's link; the attachments it already made stay (ADR
   * 0017's notes). Answers whether a live invite was named.
   */
  #inviteCancel(pageId: string, frame: FrameOf<'invite_cancel'>): boolean {
    const invite = this.#store.invites.get(pageId, frame.inviteId);
    if (invite) this.#closeInvite(invite, 'cancelled', false);
    this.#sendInvites(pageId);
    return invite !== undefined;
  }

  #armInviteExpiry(invite: InviteRecord): void {
    const { pageId, inviteId } = invite;
    this.#setTimer(
      this.#inviteTimers,
      attachmentKey(pageId, inviteId),
      Math.max(0, invite.expiresAt - Date.now()),
      () => {
        const current = this.#store.invites.get(pageId, inviteId);
        if (current) this.#closeInvite(current, 'expired');
      },
    );
  }

  /**
   * An invite stops being live: its record and timer go, a redemption still
   * waiting on it ends, and the page hears of it unless the caller sends one
   * frame for several. The attachments it made stay; they keep their own cap,
   * sponsor and end (store.ts).
   */
  #closeInvite(invite: InviteRecord, reason: InviteCloseReason, send = true): void {
    const { pageId, inviteId } = invite;
    if (!this.#store.invites.delete(pageId, inviteId)) return;
    this.#clearTimer(this.#inviteTimers, attachmentKey(pageId, inviteId));
    this.#audit({
      v: AUDIT_VERSION,
      type: 'invite_closed',
      at: Date.now(),
      pageId,
      origin: this.#store.pages.get(pageId)?.origin ?? '',
      inviteId,
      reason,
    });
    this.#log.info('invite closed', { pageId, inviteId, reason });
    const outcome: HubError =
      reason === 'expired' || reason === 'used_up' || reason === 'burned'
        ? hubError('pairing_expired', 'this invite is no longer live')
        : reason === 'page_gone'
          ? hubError('page_gone', 'the page closed and did not come back')
          : reason === 'sponsor_gone'
            ? hubError(
                'denied_by_operator',
                'the member who shared this invite is no longer attached, so it closed',
              )
            : hubError('denied_by_operator', 'the page operator closed this invite');
    for (const request of this.#pendingOn(invite)) this.#endRequest(request.requestId, outcome);
    if (send) this.#sendInvites(pageId);
  }

  /** Bars an account, and its verified email when it has one, from an invite for the invite's life. */
  #bar(invite: InviteRecord, userId: string, emailHash: string | null): void {
    if (!invite.barredUserIds.includes(userId)) invite.barredUserIds.push(userId);
    if (emailHash !== null && !invite.barredEmailHashes.includes(emailHash)) {
      invite.barredEmailHashes.push(emailHash);
    }
    this.#store.invites.put(invite);
  }

  #barred(invite: InviteRecord, userId: string, account: UserAccount): boolean {
    if (invite.barredUserIds.includes(userId)) return true;
    return (
      account.kind === 'invitee' &&
      account.email !== null &&
      invite.barredEmailHashes.includes(emailBarDigest(account.email))
    );
  }

  /** Invite-made attachments may hold every seat but MEMBER_RESERVED_SEATS (S14). */
  #inviteSeatsFull(pageId: string, waiting: number): boolean {
    const made = this.#store.attachments
      .listForPage(pageId)
      .filter((attachment) => attachment.inviteId !== null).length;
    return made + waiting >= this.#config.limits.usersPerPage - MEMBER_RESERVED_SEATS;
  }

  /**
   * A live invite by its presented secret: found by digest and confirmed in
   * constant time, as codes and nonces are (S3), unexpired, with a use left
   * and still sponsored (#sponsored). Unknown, spent, cancelled, expired and
   * unsponsored look alike.
   */
  #findInvite(secret: string, now: number): InviteRecord | null {
    if (!InviteSecretSchema.safeParse(secret).success) return null;
    const hash = digest(secret);
    const invite = this.#store.invites.findBySecretHash(hash.toString('hex'));
    if (!invite || !sameDigest(Buffer.from(invite.secretHash, 'hex'), hash)) return null;
    if (invite.expiresAt <= now || invite.usesLeft <= 0) return null;
    return this.#sponsored(invite) ? invite : null;
  }

  /**
   * Whether the invite still has its sponsor: their attachment, and each one
   * above it, in time (#chainInTime). Ending any of those closes this invite
   * and answers what waits on it (#loseSponsors); otherwise a redemption in
   * the gap before a late timer would reach the page and could be approved.
   */
  #sponsored(invite: InviteRecord): boolean {
    return this.#chainInTime(invite.pageId, invite.sponsor.userId);
  }

  /**
   * Whether this user's attachment to the page, and each member's above it
   * through the invites that let them in, is there and within its time. An
   * expiry timer may run late, and an attachment past its time is over and
   * sponsors nothing however late its timer runs, so each one found due is
   * ended here as its timer would end it (#expireIfDue); that end takes the
   * invites it sponsored and the attachments they made with it
   * (#loseSponsors), so a guest below a lapsed member is ended too. A call,
   * list_page_tools, list_pages, detach_page, a pairing and a redemption run
   * it for their caller before relying on the attachment, and a mint for each
   * member before naming a sponsor.
   */
  #chainInTime(pageId: string, userId: string): boolean {
    const seen = new Set<string>();
    let next: string | null = userId;
    while (next !== null && !seen.has(next)) {
      seen.add(next);
      const attachment = this.#store.attachments.get(pageId, next);
      // A sponsor's end ends what their invites made, so a missing sponsor is only a guard.
      if (attachment === undefined || this.#expireIfDue(pageId, next)) return false;
      next = attachment.sponsorId;
    }
    return true;
  }

  /** A control invite's prompt was refused or ran out: three burn it (ADR 0016). */
  #inviteRefused(pageId: string, inviteId: string): void {
    const invite = this.#store.invites.get(pageId, inviteId);
    if (invite?.role !== 'driver') return;
    invite.refusals = Math.min(INVITE_BURN_REFUSALS, invite.refusals + 1);
    if (invite.refusals >= INVITE_BURN_REFUSALS) {
      this.#closeInvite(invite, 'burned');
      return;
    }
    this.#store.invites.put(invite);
    this.#sendInvites(pageId);
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
        this.connectionLine(conn.address, 'warn', 'resume refused; starting a new page session', {
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
      this.#dropListed(page.pageId);
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
    // Right after every welcome with invites on, so the page knows at once
    // whether it may mint and which of its invites the relay still holds.
    this.#sendInvites(page.pageId);
    this.#rosterSentAt.set(page.pageId, now);
    this.#startHeartbeat(conn);
    this.connectionLine(conn.address, 'info', 'page connected', {
      pageId: page.pageId,
      origin: page.origin,
      resumed,
    });
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
      this.connectionLine(conn.address, 'info', 'closing silent page socket', {
        pageId: conn.pageId,
      });
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
      this.connectionLine(conn.address, 'warn', 'closing page socket: too many tools frames', {
        pageId: conn.pageId,
      });
      this.#closeSocket(conn, CLOSE_POLICY, 'too many tools frames');
      return false;
    }
    if (!this.#toolsFrameLimiter.allows(conn.address, now)) {
      this.connectionLine(
        conn.address,
        'warn',
        'closing page socket: too many tools frames from its address',
        { pageId: conn.pageId, address: conn.address },
      );
      this.#closeSocket(conn, CLOSE_POLICY, 'too many tools frames from this address');
      return false;
    }
    this.#toolsFrameLimiter.record(conn.address, now);
    conn.toolsFrames.push(now);
    return true;
  }

  /**
   * Handles a frame that may change nothing. `handle` answers whether it
   * changed something (or was a frame the page was expected to send), and
   * every line it writes is held until then: written as usual if it did,
   * and otherwise only within the budget for frames that change nothing.
   */
  #mayChangeNothing(conn: Conn, kind: string, handle: () => boolean): void {
    const { result: changed, lines } = this.#frameLog.hold(handle);
    this.#frameLog.write(lines, changed || this.#ignored(conn, kind));
  }

  /**
   * Whether the lines of a frame that changed nothing may be written; one
   * that may not is counted by its kind, into a summary line for its address
   * when the window ends (ADR 0023). /page needs no credential, so without
   * a budget one socket could write a line to stderr for every 16-byte frame,
   * to the copy that keeps the audit checkpoints and, while the audit disk
   * fails, the records themselves (ADR 0019). Each socket may write the lines
   * of ignoredFramesPerSocket such frames a window, and each remote address
   * those of ignoredFramesPerAddress across its sockets and reconnects. Past
   * either the lines are held back, never the page: a frame that only logs
   * is no reason to close a socket, and whoever shares the page's address
   * can at most spend the address's lines, never end the operator's page
   * or the calls and requests waiting on it.
   */
  #ignored(conn: Conn, kind: string): boolean {
    const now = Date.now();
    const { ignoredFramesPerSocket, windowMs } = this.#config.rateLimits;
    conn.ignoredFrames = conn.ignoredFrames.filter((at) => at > now - windowMs);
    if (conn.ignoredFrames.length >= ignoredFramesPerSocket) {
      this.#ignoredLines.hold(conn.address, kind, undefined, now);
      return false;
    }
    if (!this.#ignoredLines.take(conn.address, kind, undefined, now)) return false;
    conn.ignoredFrames.push(now);
    return true;
  }

  #tools(conn: Conn, pageId: string, frame: FrameOf<'tools'>): void {
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
    const uncheckable: string[] = [];
    /** What the list as built would hold, in heldBytes's terms. */
    let charge = 0;
    for (const tool of frame.tools) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      const before = previous?.get(tool.name);
      // Hashed only when the hash can match: a tool of that name was walked and hashed last time.
      const raw = before?.raw ? rawToolHash(tool) : null;
      if (before && raw !== null && before.raw === raw) {
        listed.set(tool.name, before);
        tools.push(before.tool);
        charge += before.held;
        continue;
      }
      const tally: HeldTally = { nodes: 0, chars: 0 };
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
          tally,
          removedSchema(
            own
              ? `more than ${String(MAX_TOOL_SCHEMA_NODES)} schema nodes`
              : `the page's tools hold more than ${String(MAX_FRAME_SCHEMA_NODES)} schema nodes in all`,
          ),
        );
        const check = { schema: null, uncompilable: false, warned: new Set<UncheckedReason>() };
        const firstClass = this.#firstClassOf(pageId, page.origin, stub, tally);
        const held = heldBytes(tally, 0);
        // Over its own limit it always will be, so it is kept by hash and reused
        // unchanged without another walk, leaving the frame to the tools after it.
        // One stubbed only for the frame's lack of room is walked again next time.
        listed.set(tool.name, {
          raw: own ? (raw ?? rawToolHash(tool)) : null,
          capped: true,
          tool: stub,
          check,
          held,
          firstClass,
        });
        tools.push(stub);
        charge += held;
        continue;
      }
      const cut = cutTool(tool, tally);
      // From the page's own schema, not the cut copy, so a long enum value still
      // matches. Prepared here and compiled in the worker, at the tool's first call.
      const schema = prepareForCheck(tool.inputSchema);
      // The same schema again keeps what is known about it, so nothing is logged twice.
      let check = before?.capped === false ? before.check : undefined;
      if (!check || !sameSchema(check.schema, schema)) {
        if (schema === null) uncheckable.push(tool.name);
        check = { schema, uncompilable: false, warned: new Set() };
      }
      const firstClass = this.#firstClassOf(pageId, page.origin, cut, tally);
      const held = heldBytes(tally, check.schema?.text.length ?? 0);
      // Hashed for the next frame only when the count covered all of it, so the
      // hash costs no more than the walk did; a schema too deep is walked again.
      listed.set(tool.name, {
        raw: deep ? null : (raw ?? rawToolHash(tool)),
        capped: false,
        tool: cut,
        check,
        held,
        firstClass,
      });
      tools.push(cut);
      charge += held;
    }
    // One relay-wide budget for what every page's tools hold, so pages cannot
    // fill the heap however they shape their frames (S9, ADR 0018). Charged
    // what the list as built holds, so it is checked once it is built; the
    // page's own last list is replaced, so only the difference counts. The
    // frame already went against its address's tools-frame budget, and the
    // close leaves the page asleep like any other policy close, its last list
    // dropped with it.
    const held = this.#toolBytes.get(pageId) ?? 0;
    if (this.#toolBytesHeld - held + charge > this.#config.limits.toolBytes) {
      this.connectionLine(
        conn.address,
        'warn',
        'closing page socket: its tools would pass what all pages may hold',
        { pageId, address: conn.address },
      );
      this.#closeSocket(conn, CLOSE_POLICY, 'tools would pass the relay tool list budget');
      return;
    }
    for (const name of uncheckable) this.#warnUncheckable(pageId, name);
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
    this.#toolBytesHeld += charge - held;
    this.#toolBytes.set(pageId, charge);
    this.#log.debug('page tools updated', {
      pageId,
      toolCount: tools.length,
      heldBytes: charge,
      allPagesHeldBytes: this.#toolBytesHeld,
    });
    if (this.#config.firstClassTools) {
      this.#firstClassPages.set(pageId, this.#pageFirstClass(tools, listed));
      this.#firstClassChanged(this.#usersOf(pageId));
    }
  }

  /**
   * A tool's first-class entry (ADR 0025), built from the cut copy once, as
   * its frame arrives, and counted into the tool's tally, so what entries
   * hold is charged against limits.toolBytes with the rest of the tool:
   * the strings the relay wrote, and the schema's copy when it made one (a
   * schema without an x-mcp-header key is shared, not copied). Null with
   * first-class tools off, or when the schema's root keeps the tool off.
   */
  #firstClassOf(
    pageId: string,
    origin: string,
    cut: PageTool,
    tally: HeldTally,
  ): FirstClassTool | null {
    if (!this.#config.firstClassTools) return null;
    const built = firstClassEntry(pageId, origin, cut);
    if (built === null) return null;
    const { entry, copied } = built;
    holdValue(entry.name, tally);
    holdValue(entry.title, tally);
    holdValue(entry.description, tally);
    if (copied) holdValue(entry.inputSchema, tally);
    // The entry object, its keys, and its shared annotations and _meta.
    holdValue({ annotations: null, _meta: null }, tally);
    return entry;
  }

  /**
   * What a page offers by first-class name, in its own order: a tool is left
   * off when its whole name passes MAX_FIRST_CLASS_NAME_CHARS, or when
   * another of the page's tools maps to the same name, both then, so a page
   * cannot win a collision by the order it lists its tools in.
   */
  #pageFirstClass(tools: readonly PageTool[], listed: Map<string, ListedTool>): PageFirstClass {
    const mapped = new Map<string, number>();
    for (const tool of tools) {
      const part = firstClassToolPart(tool.name);
      mapped.set(part, (mapped.get(part) ?? 0) + 1);
    }
    const entries: PageFirstClass['entries'] = [];
    for (const tool of tools) {
      const entry = listed.get(tool.name)?.firstClass ?? null;
      if (entry === null || entry.name.length > MAX_FIRST_CLASS_NAME_CHARS) continue;
      if ((mapped.get(firstClassToolPart(tool.name)) ?? 0) > 1) continue;
      entries.push({
        toolName: tool.name,
        readOnly: tool.annotations?.readOnlyHint === true,
        tool: entry,
        chars: JSON.stringify(entry).length,
      });
    }
    this.#firstClassVersion += 1;
    return { version: this.#firstClassVersion, entries };
  }

  /** The users attached to a page now. */
  #usersOf(pageId: string): string[] {
    return this.#store.attachments.listForPage(pageId).map((attachment) => attachment.userId);
  }

  /**
   * These users' first-class lists may have changed. Their snapshots need
   * nothing here, since each is checked against what it was built from
   * before it is served; the listener, the notifier, only marks them, and
   * looks at their lists later, outside the change (page-tool-notifier.ts).
   * Invitees never hold a first-class name, so they are never marked.
   */
  #firstClassChanged(users: Iterable<string>): void {
    if (this.#firstClassListener === null) return;
    for (const userId of users) {
      if (!InviteeIdSchema.safeParse(userId).success) this.#firstClassListener(userId);
    }
  }

  /** Forgets a page's listed tools and what they were charged against limits.toolBytes. */
  #dropListed(pageId: string): void {
    this.#listed.delete(pageId);
    this.#toolBytesHeld -= this.#toolBytes.get(pageId) ?? 0;
    this.#toolBytes.delete(pageId);
    if (this.#firstClassPages.delete(pageId)) this.#firstClassChanged(this.#usersOf(pageId));
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
    this.#sleep(pageId, conn.address);
    // A deliberate detach will not come back, so skip the resume window.
    if (detached) {
      this.connectionLine(conn.address, 'info', 'page detached', { pageId });
      this.#gone(pageId);
    }
  }

  #sleep(pageId: string, address: string): void {
    const page = this.#store.pages.get(pageId);
    if (!page) return;
    page.state = 'asleep';
    page.asleepAt = Date.now();
    // Nobody can list or call an asleep page's tools, and the adapter sends them
    // again after the welcome on resume, so they are not held (up to a 1 MB frame
    // of them) for the whole resume window.
    page.tools = [];
    this.#dropListed(pageId);
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
    this.connectionLine(address, 'info', 'page asleep', { pageId });
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
    const now = Date.now();
    // Invites end with their page session, and so does everything they made (S14).
    for (const invite of this.#store.invites.listForPage(pageId)) {
      this.#closeInvite(invite, 'page_gone', false);
    }
    const attachments = this.#store.attachments.listForPage(pageId);
    for (const attachment of attachments) {
      this.#store.attachments.delete(pageId, attachment.userId);
      this.#clearTimer(this.#expiryTimers, attachmentKey(pageId, attachment.userId));
      this.#auditExpire(page, attachment.userId, 'page_gone', now);
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
    this.#dropListed(pageId);
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
    // Its creator's address, whichever socket it last had: the one that made the session.
    this.connectionLine(creator ?? '(no address)', 'info', 'page gone', {
      pageId,
      attachmentsDeleted: attachments.length,
    });
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

  /**
   * The page's answer to an attach request; false when it named none of the
   * page's, live or just ended. A decision for one the relay just ended (its
   * time run out, a revoke, its invite closed, the page full) is expected:
   * the page's own timer runs on its clock and an operator's click can cross
   * the end on the wire, so it is ignored without a warning and changes
   * nothing a budget counts.
   */
  #decision(pageId: string, frame: FrameOf<'attach_decision'>): boolean {
    const request = this.#store.requests.get(frame.requestId);
    // A page may only answer its own requests; anything else is stale or forged.
    if (request?.pageId !== pageId) {
      if (this.#justEnded(pageId, frame.requestId)) {
        this.#log.debug('ignored a decision for an attach request that already ended', { pageId });
        return true;
      }
      this.#log.warn('ignored a decision for an unknown attach request', { pageId });
      return false;
    }
    if (!frame.allow) {
      this.#log.info('attach request denied', { pageId, userId: request.userId });
      this.#spike?.pairingDecided(pageId, request.userId, false);
      this.#endRequest(request.requestId, {
        kind: 'error',
        code: 'denied_by_operator',
        message: 'the page operator denied the attach request',
      });
      // A control invite's prompt refused counts toward burning it.
      if (request.inviteId !== null) this.#inviteRefused(pageId, request.inviteId);
      return true;
    }
    const page = this.#store.pages.get(pageId);
    if (request.inviteId !== null) {
      this.#approveRedemption(request, frame.role ?? 'observer');
      return true;
    }
    if (!this.#store.attachments.get(pageId, request.userId) && this.#pageFull(pageId)) {
      this.#log.info('approval refused: the page filled up while the operator decided', {
        pageId,
        userId: request.userId,
      });
      this.#spike?.pairingDecided(pageId, request.userId, false);
      this.#endRequest(request.requestId, this.#pageFullError('filled up meanwhile and has'));
      return true;
    }
    const attachment = this.#grant(request, frame.role ?? 'observer');
    this.#spike?.pairingDecided(pageId, request.userId, true);
    this.#endRequest(request.requestId, {
      kind: 'attached',
      pageId,
      origin: page?.origin ?? '',
      role: attachment.role,
      existing: false,
    });
    return true;
  }

  /**
   * The page approved a redemption (ADR 0017). Whatever role the answer
   * names, the attachment never passes the invite's, and the driver seats
   * cap it as for anyone; it takes no seat members keep, ends at most 24
   * hours from now, and a use is spent only now, on approval. Someone
   * attached meanwhile keeps what they hold, and the invite keeps its use.
   */
  #approveRedemption(request: AttachRequestRecord, decided: Role): void {
    const { pageId, userId } = request;
    const invite =
      request.inviteId === null ? undefined : this.#store.invites.get(pageId, request.inviteId);
    const page = this.#store.pages.get(pageId);
    const origin = page?.origin ?? '';
    const existing = this.#store.attachments.get(pageId, userId);
    if (existing) {
      this.#endRequest(request.requestId, {
        kind: 'attached',
        pageId,
        origin,
        role: existing.role,
        existing: true,
        ...this.#sponsorNamed(existing),
      });
      return;
    }
    // Closing or burning an invite ends what waits on it, so this is only a guard.
    if (invite === undefined || this.#barred(invite, userId, request.account)) {
      this.#endRequest(
        request.requestId,
        hubError('pairing_expired', 'this invite is no longer live'),
      );
      return;
    }
    // The invite may have reached its end while the operator decided, with
    // its timer not yet run: its lifetime holds on the relay's own clock at
    // approval too (S14), so it closes now, which ends this request as its
    // timer would, and nothing is granted under it.
    if (invite.expiresAt <= Date.now()) {
      this.#closeInvite(invite, 'expired');
      if (this.#store.requests.get(request.requestId) !== undefined) {
        this.#endRequest(
          request.requestId,
          hubError('pairing_expired', 'this invite is no longer live'),
        );
      }
      return;
    }
    // The sponsor may have passed their end while the operator decided, with
    // the timer not yet run; ending them now closes the invite, which answers
    // this request as any sponsor's end does, so nothing is granted under it.
    if (!this.#sponsored(invite)) {
      if (this.#store.requests.get(request.requestId) !== undefined) {
        this.#endRequest(
          request.requestId,
          hubError('pairing_expired', 'this invite is no longer live'),
        );
      }
      return;
    }
    if (this.#pageFull(pageId) || this.#inviteSeatsFull(pageId, 0)) {
      this.#log.info('approval refused: the page filled up while the operator decided', {
        pageId,
        userId,
      });
      this.#endRequest(request.requestId, this.#pageFullError('filled up meanwhile and has'));
      return;
    }
    const attachment = this.#grant(request, lesserRole(invite.role, decided), invite);
    invite.usesLeft -= 1;
    this.#audit({
      v: AUDIT_VERSION,
      type: 'invite_redeemed',
      at: Date.now(),
      pageId,
      origin,
      inviteId: invite.inviteId,
      userId,
      kind: request.account.kind,
      usesLeft: invite.usesLeft,
    });
    this.#endRequest(request.requestId, {
      kind: 'attached',
      pageId,
      origin,
      role: attachment.role,
      existing: false,
      sponsor: invite.sponsor.displayName,
    });
    if (invite.usesLeft <= 0) {
      this.#closeInvite(invite, 'used_up');
    } else {
      this.#store.invites.put(invite);
      this.#sendInvites(pageId);
    }
  }

  /** "Shared by": the sponsor's name for an invite-made attachment, while they are attached. */
  #sponsorNamed(attachment: AttachmentRecord): { sponsor?: string } {
    if (attachment.sponsorId === null) return {};
    const sponsor = this.#store.attachments.get(attachment.pageId, attachment.sponsorId);
    return sponsor === undefined ? {} : { sponsor: sponsor.displayName };
  }

  /**
   * Makes an attachment, or returns the one the user already holds. One an
   * invite makes keeps the invite's role as its cap, its sponsor, the digest
   * of an invitee's verified email and an end 24 hours on (ADR 0017), since
   * the invite's own record may go first.
   */
  #grant(request: GrantRequest, wanted: Role, invite?: InviteRecord): AttachmentRecord {
    const existing = this.#store.attachments.get(request.pageId, request.userId);
    if (existing) return existing;
    const now = Date.now();
    // Newest first, as every roster lists clients; a joined device came after the first.
    const clients = [...(request.joined ?? [])].reverse();
    if (request.client) clients.push(request.client);
    const endsAt = invite === undefined ? null : now + MAX_INVITE_LIFETIME_MS;
    const idleEnd = now + this.#config.timings.attachmentIdleMs;
    const { account } = request;
    const attachment: AttachmentRecord = {
      pageId: request.pageId,
      userId: request.userId,
      displayName: request.displayName,
      kind: account.kind,
      role: this.#cappedRole(
        request.pageId,
        request.userId,
        invite === undefined ? wanted : lesserRole(invite.role, wanted),
      ),
      grantedAt: now,
      lastUsedAt: null,
      expiresAt: endsAt === null ? idleEnd : Math.min(idleEnd, endsAt),
      clients: clients.slice(0, MAX_ROSTER_CLIENTS),
      inviteId: invite?.inviteId ?? null,
      endsAt,
      inviteRole: invite?.role ?? null,
      sponsorId: invite?.sponsor.userId ?? null,
      emailHash:
        invite !== undefined && account.kind === 'invitee' && account.email !== null
          ? emailBarDigest(account.email)
          : null,
    };
    this.#store.attachments.put(attachment);
    this.#armExpiry(attachment);
    this.#firstClassChanged([attachment.userId]);
    const page = this.#store.pages.get(request.pageId);
    this.#audit({
      v: AUDIT_VERSION,
      type: 'attach',
      at: now,
      pageId: attachment.pageId,
      origin: page?.origin ?? '',
      userId: attachment.userId,
      kind: attachment.kind,
      role: attachment.role,
      via: request.via,
      clientId: request.oauthClientId,
      inviteId: attachment.inviteId,
      // The only record that names a person by address (ADR 0019); stderr drops it.
      ...(account.kind === 'invitee' ? { email: account.email ?? UNVERIFIED_EMAIL } : {}),
    });
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

  /** The operator's role change; false when nobody's role changed. */
  #setRole(pageId: string, frame: FrameOf<'set_role'>): boolean {
    const attachment = this.#store.attachments.get(pageId, frame.userId);
    if (!attachment) {
      this.#log.warn('ignored set_role for a user who is not attached', { pageId });
      return false;
    }
    // ADR 0017: an invite-made attachment never passes its invite's role,
    // whatever the page asks: a watch guest stays an observer.
    const wanted =
      attachment.inviteRole === null ? frame.role : lesserRole(attachment.inviteRole, frame.role);
    if (wanted !== frame.role) {
      this.#log.info('set_role refused: above the role of the invite that made the attachment', {
        pageId,
        userId: frame.userId,
      });
    }
    const capped = this.#cappedRole(pageId, frame.userId, wanted);
    // A promotion gives access, so it counts against the page's grants; a
    // demotion only takes access away and never waits on them.
    const role =
      capped === 'driver' && attachment.role !== 'driver' && !this.#grantAllowed(pageId, Date.now())
        ? attachment.role
        : capped;
    const changed = role !== attachment.role;
    if (changed) {
      const previous = attachment.role;
      attachment.role = role;
      this.#store.attachments.put(attachment);
      this.#firstClassChanged([frame.userId]);
      this.#log.info('role changed', { pageId, userId: frame.userId, role });
      this.#audit({
        v: AUDIT_VERSION,
        type: 'role',
        at: Date.now(),
        pageId,
        origin: this.#store.pages.get(pageId)?.origin ?? '',
        userId: frame.userId,
        role,
        previous,
      });
    }
    // Sent even when nothing changed, so the page shows a capped grant as it really is.
    this.#sendRoster(pageId);
    return changed;
  }

  /**
   * The operator's revoke (S8): attachments end now, with their calls, and
   * so does any request waiting on the page. Someone an invite let in, or
   * whose redemption was waiting, is barred from that invite for its life,
   * by account and verified email, so no redemption brings them back; the
   * invite itself stays unless the page cancels it. Revoke all also closes
   * every live invite (ADR 0017). Answers whether it ended anything: an
   * attachment, a waiting request or an invite.
   */
  #revoke(pageId: string, frame: FrameOf<'revoke'>): boolean {
    const everyone = frame.userId === '*';
    const now = Date.now();
    const targets = everyone
      ? this.#store.attachments.listForPage(pageId)
      : [this.#store.attachments.get(pageId, frame.userId)].filter(
          (attachment) => attachment !== undefined,
        );
    const users = new Set(targets.map((attachment) => attachment.userId));
    if (!everyone) users.add(frame.userId);
    let barred = false;
    for (const target of targets) {
      const invite =
        target.inviteId === null ? undefined : this.#store.invites.get(pageId, target.inviteId);
      if (invite !== undefined) {
        this.#bar(invite, target.userId, target.emailHash);
        barred = true;
      }
    }
    // Revocation is immediate (S8): calls on the page are cancelled now, queued ones dropped.
    this.#endAttachments(pageId, users, 'revoked', 'the page operator revoked your attachment');
    const origin = this.#store.pages.get(pageId)?.origin ?? '';
    for (const target of targets) {
      this.#audit({
        v: AUDIT_VERSION,
        type: 'revoke',
        at: now,
        pageId,
        origin,
        userId: target.userId,
        everyone,
      });
    }
    let ended = targets.length;
    for (const request of this.#store.requests.listForPage(pageId)) {
      if (everyone || users.has(request.userId)) {
        ended += 1;
        const invite =
          request.inviteId === null ? undefined : this.#store.invites.get(pageId, request.inviteId);
        if (invite !== undefined && !everyone) {
          const email = request.account.kind === 'invitee' ? request.account.email : null;
          this.#bar(invite, request.userId, email === null ? null : emailBarDigest(email));
          barred = true;
        }
        this.#endRequest(request.requestId, {
          kind: 'error',
          code: 'denied_by_operator',
          message: 'the page operator revoked access',
        });
      }
    }
    if (everyone) {
      for (const invite of this.#store.invites.listForPage(pageId)) {
        ended += 1;
        this.#closeInvite(invite, 'revoked', false);
      }
    }
    this.#log.info('attachments revoked', { pageId, count: targets.length });
    this.#loseSponsors(pageId, targets);
    this.#sendRoster(pageId);
    if (everyone || barred) this.#sendInvites(pageId);
    return ended > 0;
  }

  /**
   * A sponsor's attachment ended, however it ended, so their invites close
   * and the attachments those made end too (ADR 0017): a script can open a
   * page session claiming any allowed origin, so an invite is only good
   * while a member who shared it is still there. A member let in by such an
   * invite may have sponsored invites of their own, which end in turn.
   */
  #loseSponsors(pageId: string, ended: readonly AttachmentRecord[]): void {
    const queue = ended.filter((attachment) => attachment.kind === 'member');
    const seen = new Set<string>();
    let changed = false;
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const sponsor = next.userId;
      if (seen.has(sponsor)) continue;
      seen.add(sponsor);
      const invites = this.#store.invites
        .listForPage(pageId)
        .filter((invite) => invite.sponsor.userId === sponsor);
      for (const invite of invites) this.#closeInvite(invite, 'sponsor_gone', false);
      const made = this.#store.attachments
        .listForPage(pageId)
        .filter((attachment) => attachment.sponsorId === sponsor);
      if (made.length > 0) {
        this.#endAttachments(
          pageId,
          new Set(made.map((attachment) => attachment.userId)),
          'revoked',
          'the member who shared this page with you is no longer attached, so access through their invite ended',
        );
        const page = this.#store.pages.get(pageId);
        const now = Date.now();
        for (const attachment of made) {
          if (page) this.#auditExpire(page, attachment.userId, 'sponsor_gone', now);
        }
        queue.push(...made.filter((attachment) => attachment.kind === 'member'));
      }
      if (invites.length > 0 || made.length > 0) {
        changed = true;
        this.#audit({
          v: AUDIT_VERSION,
          type: 'sponsor_gone',
          at: Date.now(),
          pageId,
          origin: this.#store.pages.get(pageId)?.origin ?? '',
          sponsor,
          invites: invites.length,
          attachments: made.length,
        });
        this.#log.info('sponsor gone: their invites and what those made ended', {
          pageId,
          userId: sponsor,
          invites: invites.length,
          attachments: made.length,
        });
      }
    }
    if (changed) {
      this.#sendRoster(pageId);
      this.#sendInvites(pageId);
    }
  }

  #auditExpire(page: PageRecord, userId: string, reason: ExpireReason, at: number): void {
    this.#audit({
      v: AUDIT_VERSION,
      type: 'expire',
      at,
      pageId: page.pageId,
      origin: page.origin,
      userId,
      reason,
    });
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
    this.#firstClassChanged(users);
    const outcome = hubError('not_attached', message);
    // Queued calls first, so a running one settling does not hand the page a call that is ending.
    for (const call of [...(this.#queues.get(pageId)?.waiting ?? [])]) {
      if (users.has(call.caller.userId)) call.settle(outcome);
    }
    const conn = this.#live.get(pageId);
    // Those waiting for room never reached the page either.
    for (const call of [...(conn?.held ?? [])]) {
      if (users.has(call.caller.userId)) call.settle(outcome);
    }
    for (const call of [...(conn?.inflight.values() ?? [])]) {
      if (!users.has(call.caller.userId)) continue;
      if (conn) this.#sendCancel(conn, call.callId, reason);
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

  /**
   * Ends an attachment past its expiresAt like a revoke, with an expire
   * record: unused too long, or an invite-made one at its end, 24 hours
   * after redemption however much it is used (S14). True if it ended.
   */
  #expireIfDue(pageId: string, userId: string): boolean {
    const attachment = this.#store.attachments.get(pageId, userId);
    if (!attachment || attachment.expiresAt === null) return false;
    const now = Date.now();
    if (attachment.expiresAt > now) {
      // The timer ran early or a call moved the expiry meanwhile.
      this.#armExpiry(attachment);
      return false;
    }
    const ended = attachment.endsAt !== null && attachment.endsAt <= now;
    const idle = formatDuration(this.#config.timings.attachmentIdleMs);
    this.#endAttachments(
      pageId,
      new Set([userId]),
      'revoked',
      ended
        ? `your access through an invite ended ${formatDuration(MAX_INVITE_LIFETIME_MS)} after you joined; ask for a new invite to use the page`
        : `your attachment expired after ${idle} without a call; pair again to use the page`,
    );
    const page = this.#store.pages.get(pageId);
    if (page) this.#auditExpire(page, userId, ended ? 'ends_at' : 'idle', now);
    this.#log.info('attachment expired', { pageId, userId, reason: ended ? 'ends_at' : 'idle' });
    this.#loseSponsors(pageId, [attachment]);
    this.#sendRoster(pageId);
    return true;
  }

  #roster(pageId: string): AttachmentView[] {
    return this.#store.attachments.listForPage(pageId).map((attachment) => ({
      userId: attachment.userId,
      displayName: attachment.displayName,
      kind: attachment.kind,
      role: attachment.role,
      grantedAt: attachment.grantedAt,
      lastUsedAt: attachment.lastUsedAt,
      expiresAt: attachment.expiresAt,
      clients: attachment.clients.slice(0, MAX_ROSTER_CLIENTS),
      inviteId: attachment.inviteId,
      endsAt: attachment.endsAt,
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

  /**
   * Remembers a request that just ended for as long as its page may still
   * show it: the page's prompt lasts at most the request's lifetime from when
   * it arrived, and a request never ends before it is made, so the end plus
   * that lifetime and a grace for the page's clock and the wire covers it.
   * Ends come in time order, so the oldest is always first.
   */
  #rememberEnded(pageId: string, requestId: string): void {
    const now = Date.now();
    this.#forgetEnded(now);
    if (this.#endedRequests.size >= MAX_ENDED_REQUESTS) {
      const oldest = this.#endedRequests.keys().next().value;
      if (oldest !== undefined) this.#endedRequests.delete(oldest);
    }
    const until = now + this.#config.timings.attachRequestTtlMs + ENDED_REQUEST_GRACE_MS;
    this.#endedRequests.set(requestId, { pageId, until });
  }

  /** Whether this page had this request ended recently enough that a decision for it is expected. */
  #justEnded(pageId: string, requestId: string): boolean {
    this.#forgetEnded(Date.now());
    return this.#endedRequests.get(requestId)?.pageId === pageId;
  }

  #forgetEnded(now: number): void {
    for (const [requestId, ended] of this.#endedRequests) {
      if (ended.until > now) return;
      this.#endedRequests.delete(requestId);
    }
  }

  /**
   * A request the page saw ends, approved or not, and everyone waiting on it
   * hears how. A refusal writes its attach_refused record in full, since the
   * request reached the page, whose pairing limit bounds them (ADR 0019).
   */
  #endRequest(requestId: string, outcome: PairOutcome): void {
    const request = this.#store.requests.get(requestId);
    this.#store.requests.delete(requestId);
    this.#clearTimer(this.#requestTimers, requestId);
    if (request !== undefined) this.#rememberEnded(request.pageId, requestId);
    if (request !== undefined && outcome.kind === 'error' && !this.#closed) {
      this.#audit({
        v: AUDIT_VERSION,
        type: 'attach_refused',
        at: Date.now(),
        pageId: request.pageId,
        origin: this.#store.pages.get(request.pageId)?.origin ?? '',
        userId: request.userId,
        kind: request.account.kind,
        via: request.via,
        inviteId: request.inviteId,
        outcome: attachRefusalOf(outcome.code),
      });
    }
    if (request?.inviteId !== null && request?.inviteId !== undefined) {
      const invite = this.#store.invites.get(request.pageId, request.inviteId);
      if (invite?.pendingRequestId === requestId) {
        invite.pendingRequestId = this.#pendingOn(invite)[0]?.requestId ?? null;
        this.#store.invites.put(invite);
      }
      // Whether anything still waits on it shows in the page's list.
      if (invite !== undefined) this.#sendInvites(request.pageId);
    }
    for (const waiter of [...(this.#pairWaiters.get(requestId) ?? [])]) waiter(outcome);
  }

  // What requests waiting on a page hold

  /**
   * Charges a request that may wait on a page (a call, or a pairing waiting
   * for the operator) what its body is measured to hold on the heap,
   * `bytes`, until release. Past what one user's such requests may hold
   * together (limits.requestBytesPerUser) it is refused rate_limited, and an
   * invitee's past what one invitee may hold (#perInvitee) rate_limited too;
   * an invitee's past what invitees may hold together (#inviteePool)
   * `relayFull`; and anyone's past what all may hold (limits.requestBytes)
   * `relayFull` too: the request budget alone let one member hold 120 calls
   * of 1 MB arguments, about 2 MB of heap each, and crash a relay with the
   * image's 192 MiB heap (ADR 0018's notes). A request charged nothing, as
   * from a caller with no HTTP body, is always held.
   */
  #holdBytes(
    caller: CallerIdentity,
    bytes: number,
    relayFull: 'page_busy' | 'rate_limited',
  ): HeldBytes {
    if (bytes <= 0) return { kind: 'held', release: () => undefined };
    const { userId } = caller;
    const invitee = caller.account.kind === 'invitee';
    const { requestBytes, requestBytesPerUser } = this.#config.limits;
    const own = this.#heldBytes.get(userId) ?? 0;
    if (bytes > requestBytesPerUser) {
      this.#log.debug('request refused: it alone would hold more than a user may', { userId });
      return hubError(
        'rate_limited',
        `this request would hold ${mebibytes(bytes)} of the relay's memory while it waits, more than one user's requests may hold together (${mebibytes(requestBytesPerUser)}); send less`,
      );
    }
    if (own + bytes > requestBytesPerUser) {
      this.#log.debug('request refused: the user holds too much in requests waiting', { userId });
      return hubError(
        'rate_limited',
        `your requests waiting on pages already hold ${mebibytes(own)} of the relay's memory, and one user's may hold ${mebibytes(requestBytesPerUser)}; wait for some to finish`,
      );
    }
    if (invitee) {
      const share = this.#perInvitee();
      if (bytes > share) {
        this.#log.debug('request refused: it alone would hold more than an invitee may', {
          userId,
        });
        return hubError(
          'rate_limited',
          `this request would hold ${mebibytes(bytes)} of the relay's memory while it waits, more than one invited account's requests may hold together (${mebibytes(share)}); send less`,
        );
      }
      if (own + bytes > share) {
        this.#log.debug('request refused: the invitee holds its share in requests waiting', {
          userId,
        });
        return hubError(
          'rate_limited',
          `your requests waiting on pages already hold ${mebibytes(own)} of the relay's memory, and one invited account's may hold ${mebibytes(share)}; wait for some to finish`,
        );
      }
    }
    if (invitee && this.#heldByInvitees + bytes > this.#inviteePool()) {
      this.#log.debug('request refused: invitees hold all their requests waiting may', {
        userId,
      });
      return hubError(
        relayFull,
        "requests from invited accounts already hold all of the relay's memory they may while they wait; try again shortly",
      );
    }
    if (this.#heldTotal + bytes > requestBytes) {
      this.#log.debug('request refused: requests waiting hold all the relay allows', { userId });
      return hubError(
        relayFull,
        "requests waiting on pages hold as much of the relay's memory as it allows; try again shortly",
      );
    }
    this.#heldBytes.set(userId, own + bytes);
    this.#heldTotal += bytes;
    if (invitee) this.#heldByInvitees += bytes;
    let held = true;
    return {
      kind: 'held',
      release: () => {
        if (!held) return;
        held = false;
        this.#heldTotal -= bytes;
        if (invitee) this.#heldByInvitees -= bytes;
        const left = (this.#heldBytes.get(userId) ?? bytes) - bytes;
        if (left > 0) this.#heldBytes.set(userId, left);
        else this.#heldBytes.delete(userId);
      },
    };
  }

  /**
   * What invitees' waiting requests may hold together: a quarter of the
   * relay's total, or one call of the largest arguments where a quarter is
   * less, in every mode and with no setting of its own. Guests and strangers
   * rank below members (ADR 0016's notes), so guests calling a frozen tab can
   * no longer leave members page_busy everywhere, while members may still
   * use the whole (S9, ADR 0030).
   */
  #inviteePool(): number {
    return Math.max(Math.floor(this.#config.limits.requestBytes / 4), MIN_REQUEST_BYTES);
  }

  /**
   * What one invitee's waiting requests may hold: a quarter of the invitees'
   * pool, or one call of the largest arguments where that is less, and never
   * more than any user's share. Without it one guest calling a page that
   * holds calls filled the whole pool alone, and every other invitee on
   * every page met page_busy (S9, ADR 0032); now that takes four, at the
   * default total.
   */
  #perInvitee(): number {
    return Math.min(
      this.#config.limits.requestBytesPerUser,
      Math.max(Math.floor(this.#inviteePool() / 4), MIN_REQUEST_BYTES),
    );
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
    // Those still waiting for room first, so a write settling cannot send one of them.
    for (const call of [...conn.held]) call.settle(outcome);
    for (const call of [...conn.inflight.values()]) call.settle(outcome);
  }

  // MCP side

  /**
   * Whether the user holds an attachment to any page (InviteHub.holds). An
   * invitee's session pool and audit budget turn on it (ADRs 0016 and 0019),
   * and relay.ts hands it to the MCP sessions for that.
   */
  holds(userId: string): boolean {
    return this.#store.attachments.listForUser(userId).length > 0;
  }

  /**
   * Who to tell when a user's first-class list may have changed (relay.ts
   * hands it the notifier). Called inside the hub's own changes, so it must
   * only mark the user and look later.
   */
  onFirstClassChange(listener: (userId: string) => void): void {
    this.#firstClassListener = listener;
  }

  /**
   * The user's first-class tools (ADR 0025), for tools/list: none with the
   * flag off, for an invitee, or on an attachment an invite made (ADR 0016);
   * otherwise, in the order the user attached, each awake page's entries in
   * its own order, a driver all of them and an observer only those the page
   * marked readOnlyHint, until the next would take the list past
   * MAX_FIRST_CLASS_TOOLS_PER_USER tools or MAX_FIRST_CLASS_CHARS_PER_USER
   * characters. A list is kept while every attachment, role and page version
   * it was built from is still the same, and built again before it is served
   * otherwise, so a list answered after a revoke, an attachment's end or a
   * downgrade never shows what the change took away (S8, S13).
   */
  firstClassList(userId: string): FirstClassList {
    const snapshot = this.#firstClassSnapshot(userId);
    return snapshot === null ? EMPTY_FIRST_CLASS : snapshot;
  }

  #firstClassSnapshot(userId: string): FirstClassSnapshot | null {
    if (!this.#config.firstClassTools) return null;
    const parts: { pageId: string; role: Role; page: PageFirstClass }[] = [];
    const attachments = this.#store.attachments
      .listForUser(userId)
      .filter((attachment) => attachment.kind === 'member' && attachment.inviteId === null)
      .sort((a, b) => a.grantedAt - b.grantedAt);
    for (const { pageId } of attachments) {
      // One past its time is over however late its timer runs, and ends here.
      if (!this.#chainInTime(pageId, userId)) continue;
      const attachment = this.#store.attachments.get(pageId, userId);
      const page = this.#firstClassPages.get(pageId);
      if (attachment === undefined || page === undefined) continue;
      parts.push({ pageId, role: attachment.role, page });
    }
    const key = parts
      .map((part) => `${part.pageId}/${part.role}/${String(part.page.version)}`)
      .join(' ');
    if (parts.length === 0) {
      this.#firstClassLists.delete(userId);
      return null;
    }
    const kept = this.#firstClassLists.get(userId);
    if (kept?.key === key) return kept;
    const tools: FirstClassTool[] = [];
    const names = new Map<string, Map<string, string>>();
    let chars = 0;
    build: for (const { pageId, role, page } of parts) {
      for (const entry of page.entries) {
        // S5: an observer is shown, and may call, only what the page marked read-only.
        if (role === 'observer' && !entry.readOnly) continue;
        if (
          tools.length >= MAX_FIRST_CLASS_TOOLS_PER_USER ||
          chars + entry.chars > MAX_FIRST_CLASS_CHARS_PER_USER
        ) {
          break build;
        }
        tools.push(entry.tool);
        chars += entry.chars;
        let ofPage = names.get(pageId);
        if (ofPage === undefined) {
          ofPage = new Map();
          names.set(pageId, ofPage);
        }
        ofPage.set(entry.toolName, entry.tool.name);
      }
    }
    const snapshot: FirstClassSnapshot = {
      key,
      tools,
      names,
      digest: createHash('sha256').update(JSON.stringify(tools)).digest('hex'),
    };
    this.#firstClassLists.set(userId, snapshot);
    return snapshot;
  }

  listPages(userId: string): PageListing[] {
    const listings: PageListing[] = [];
    for (const attachment of this.#store.attachments.listForUser(userId)) {
      if (!this.#chainInTime(attachment.pageId, userId)) continue;
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
    // An expiry timer may run late; an attachment past its time is over either
    // way, and so is one whose sponsor, or a member above them, is past theirs.
    const attachment = this.#chainInTime(pageId, userId)
      ? this.#store.attachments.get(pageId, userId)
      : undefined;
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
    // With first-class tools on, each entry names the caller's first-class name for it, or null.
    const firstClass = this.#config.firstClassTools
      ? (this.#firstClassSnapshot(userId)?.names.get(pageId) ?? new Map<string, string>())
      : null;
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
          ...(firstClass === null ? {} : { firstClass: firstClass.get(tool.name) ?? null }),
        };
      }),
    };
  }

  /**
   * `heldBytes` as for callPageTool: the request waits for the operator, so
   * it is charged what it holds, and refused before its code is looked at
   * past what waiting requests may hold.
   */
  async pairPage(
    caller: CallerIdentity,
    code: string,
    signal: AbortSignal,
    heldBytes = 0,
  ): Promise<PairOutcome> {
    const now = Date.now();
    const limited = this.#pairingLimited(caller, 'code', now);
    if (limited) return limited;
    // Before the code is even looked at, so an invitee neither spends nor
    // rotates one: a code seen on a shared screen cannot summon prompts from
    // strangers (ADR 0016).
    const required = this.#inviteRequired(caller, 'code');
    if (required) return required;
    const held = this.#holdBytes(caller, heldBytes, 'rate_limited');
    if (held.kind === 'error') return this.#refusedBeforePage(caller, 'code', null, held);
    try {
      return await this.#pairByCode(caller, code, signal, now);
    } finally {
      held.release();
    }
  }

  async #pairByCode(
    caller: CallerIdentity,
    code: string,
    signal: AbortSignal,
    now: number,
  ): Promise<PairOutcome> {
    const normalised = normalisePairingCode(code);
    const pageId = normalised === null ? null : this.#matchTicket(normalised, now);
    const live = pageId === null ? null : this.#livePage(pageId);
    // Wrong and expired look the same: telling them apart would confirm a code once existed.
    if (!live) {
      this.#log.info('pairing refused: no live code matched', { userId: caller.userId });
      return this.#refusedBeforePage(
        caller,
        'code',
        null,
        hubError('pairing_expired', 'code is invalid or expired'),
      );
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
    const limited = this.#pairingLimited(caller, 'qr', now);
    if (limited) return limited;
    // After the attempt is counted and before the nonce is looked at, so an
    // invitee's claim at /pair/claim neither spends nor rotates it (ADR 0017).
    const required = this.#inviteRequired(caller, 'qr');
    if (required) return required;
    const ticket = this.#pairTicket(nonce, now, true);
    const live = ticket === null ? null : this.#livePage(ticket.pageId);
    if (!ticket || !live) {
      this.#log.info('qr pairing refused: no live nonce matched', { userId: caller.userId });
      return this.#refusedBeforePage(
        caller,
        'qr',
        null,
        hubError('pairing_expired', 'this pairing link is invalid or expired'),
      );
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

  // Redemption (ADRs 0016 and 0017)

  /**
   * pair_page's invite: a link minted for one use, or its secret. A link
   * this relay did not mint, a secret minted for several uses (a link pasted
   * into a chat stays in its history), and an unknown, spent, cancelled,
   * expired or unsponsored one all get one answer, so no answer says a
   * secret is live.
   */
  async redeemInvite(
    caller: CallerIdentity,
    invite: string,
    signal: AbortSignal,
    heldBytes = 0,
  ): Promise<PairOutcome> {
    // As for pairPage, before anything is spent: the request may wait for the operator.
    const held = this.#holdBytes(caller, heldBytes, 'rate_limited');
    if (held.kind === 'error') return this.#refusedBeforePage(caller, 'invite', null, held);
    try {
      const secret = inviteSecretOf(invite, this.#linkBase());
      const started = this.#redeem(caller, secret, true, Date.now());
      return started.kind === 'pending'
        ? await this.#waitForDecision(started.record, signal)
        : started;
    } finally {
      held.release();
    }
  }

  /**
   * What /i shows for a live invite: the page's origin, its title and the
   * invite's label as the page wrote them, what it lets someone do, and who
   * shared it. Uses nothing up; null for an unknown, spent, cancelled,
   * expired or unsponsored secret alike (#findInvite), and while its page is
   * not linked.
   */
  previewInvite(secret: string): InvitePreview | null {
    const invite = this.#findInvite(secret, Date.now());
    const live = invite === null ? null : this.#livePage(invite.pageId);
    if (invite === null || live === null) return null;
    const title = firstCharacters(live.page.title, MAX_PAIR_TITLE_CHARS);
    return {
      origin: live.page.origin,
      title: title.text,
      titleCut: title.cut,
      label: invite.label,
      role: invite.role,
      sponsor: invite.sponsor.displayName,
      expiresAt: invite.expiresAt,
    };
  }

  /** /i's Join, which takes any live invite, multi-use ones too, since its link never leaves the browser's fragment. */
  claimInvite(caller: CallerIdentity, secret: string): ClaimOutcome {
    const started = this.#redeem(caller, secret, false, Date.now());
    if (started.kind === 'error') return started;
    if (started.kind === 'pending') {
      return {
        kind: 'claimed',
        pageId: started.record.pageId,
        settled: this.#waitForEnd(started.record),
      };
    }
    return { kind: 'claimed', pageId: started.pageId, settled: Promise.resolve(started) };
  }

  /**
   * Everything a redemption must pass before its page hears of it: the
   * user's pairing limit, a live invite (minted for one use, when pair_page
   * asks, and still sponsored: #sponsored ends a sponsor, or a member above
   * them, past their time as the timer would), the invite's own limit, its
   * bars, a linked page, the page's pairing limit, and the invite still live
   * once the caller's own lapsed attachment has ended; then the caller is
   * already attached, joins the request they have waiting, is refused while
   * the invite's one prompt or its last uses are taken or the seats invites
   * may use are full, or raises a new request. Never autoApprove: the
   * adapter honours an invite only against its own record and the presented
   * secret (ADR 0017's notes).
   */
  #redeem(caller: CallerIdentity, secret: string | null, oneUse: boolean, now: number): Started {
    const limited = this.#pairingLimited(caller, 'invite', now);
    if (limited) return limited;
    const found = secret === null ? null : this.#findInvite(secret, now);
    const invite = found !== null && (!oneUse || found.uses === 1) ? found : null;
    if (secret === null || invite === null) {
      this.#log.info('redemption refused: no live invite matched', { userId: caller.userId });
      return this.#refusedBeforePage(
        caller,
        'invite',
        null,
        hubError('pairing_expired', 'this invite is invalid, used up or expired'),
      );
    }
    const refuse = (error: HubError): HubError =>
      this.#refusedBeforePage(caller, 'invite', invite.inviteId, error);
    const inviteKey = attachmentKey(invite.pageId, invite.inviteId);
    if (!this.#inviteLimiter.allows(inviteKey, now)) {
      this.#log.warn('redemption refused: too many for one invite', {
        pageId: invite.pageId,
        inviteId: invite.inviteId,
      });
      return refuse(
        hubError(
          'rate_limited',
          'too many redemptions of this invite; wait a minute and try again',
        ),
      );
    }
    this.#inviteLimiter.record(inviteKey, now);
    // No redemption clears a revoke, by this account or a new one with its verified email.
    if (this.#barred(invite, caller.userId, caller.account)) {
      this.#log.info('redemption refused: the account was revoked from this invite', {
        pageId: invite.pageId,
        userId: caller.userId,
      });
      return refuse(
        hubError(
          'denied_by_operator',
          "the page operator revoked this account's access through this invite",
        ),
      );
    }
    const live = this.#livePage(invite.pageId);
    if (live === null) {
      return refuse(
        hubError(
          'page_asleep',
          'the page is not connected right now; try the invite again when it is back',
        ),
      );
    }
    const { page, conn } = live;
    // The page's own pairing limit counts every redemption that lands on it (S14).
    if (!this.#pageLimiter.allows(page.pageId, now)) {
      this.#log.warn('redemption refused: too many pairings for one page', {
        pageId: page.pageId,
        userId: caller.userId,
      });
      return refuse(
        hubError(
          'rate_limited',
          'too many pairing attempts on this page; wait a minute and try again',
        ),
      );
    }
    this.#pageLimiter.record(page.pageId, now);

    // Someone attached keeps what they hold only while it, and each member's
    // above it, is in time, so a caller past their own end with the timer not
    // yet run is ended here as the timer would end them, and the page is asked
    // rather than the caller told they were attached already. An end here
    // that would close this invite (sponsor_gone, ADR 0017) is its sponsor's
    // or one above them, which #findInvite has already ended if due; the put
    // below would bring a closed invite back with no sponsor and no timer,
    // though, so a closed one still gets every dead invite's answer.
    this.#chainInTime(page.pageId, caller.userId);
    if (this.#store.invites.get(invite.pageId, invite.inviteId) === undefined) {
      this.#log.info('redemption refused: the invite closed as the caller expired', {
        pageId: page.pageId,
        userId: caller.userId,
      });
      return refuse(hubError('pairing_expired', 'this invite is invalid, used up or expired'));
    }
    const existing = this.#store.attachments.get(page.pageId, caller.userId);
    if (existing) {
      // Someone already attached keeps what they hold, and the invite its use (ADR 0017).
      if (this.#recordClient(existing, caller.client)) this.#sendRoster(page.pageId);
      this.#store.attachments.put(existing);
      return {
        kind: 'attached',
        pageId: page.pageId,
        origin: page.origin,
        role: existing.role,
        existing: true,
        ...this.#sponsorNamed(existing),
      };
    }
    const mine = this.#store.requests
      .listForPage(page.pageId)
      .find((candidate) => candidate.userId === caller.userId);
    if (mine) {
      this.#joinRequest(mine, caller.client, 'invite');
      return { kind: 'pending', record: mine };
    }
    const waiting = this.#pendingOn(invite);
    // A control invite allows one prompt at a time; a watch invite as many as it has uses left.
    if (invite.role === 'driver' ? waiting.length > 0 : invite.usesLeft - waiting.length <= 0) {
      return refuse(
        hubError(
          'page_busy',
          "someone else's redemption of this invite is waiting on the operator; try again shortly",
        ),
      );
    }
    const waitingOnInvites = this.#store.requests
      .listForPage(page.pageId)
      .filter((request) => request.inviteId !== null).length;
    if (this.#pageFull(page.pageId) || this.#inviteSeatsFull(page.pageId, waitingOnInvites)) {
      this.#log.info('redemption refused: the seats invites may use are taken', {
        pageId: page.pageId,
        userId: caller.userId,
      });
      return refuse(
        hubError(
          'page_busy',
          'the page has no seat left for someone joining by invite; its operator can revoke someone to make room',
        ),
      );
    }
    const record = this.#raiseRequest(
      caller,
      page,
      conn,
      'invite',
      { inviteId: invite.inviteId, secret, label: invite.label },
      now,
    );
    invite.pendingRequestId ??= record.requestId;
    this.#store.invites.put(invite);
    this.#sendInvites(page.pageId);
    return { kind: 'pending', record };
  }

  /**
   * ADR 0017: a pairing code or QR nonce is for members, and an invitee is
   * told so before anything is matched, after its attempt was counted.
   */
  #inviteRequired(caller: CallerIdentity, via: 'code' | 'qr'): HubError | null {
    if (caller.account.kind !== 'invitee') return null;
    this.#log.info('pairing refused: an invitee offered a pairing code', {
      userId: caller.userId,
      via,
    });
    return this.#refusedBeforePage(
      caller,
      via,
      null,
      hubError(
        'invite_required',
        "this account joins pages only by invite; ask the page's operator for an invite link",
      ),
    );
  }

  /**
   * A pairing or redemption refused before any page saw it: its
   * attach_refused record goes through the refusal budget (ADR 0019).
   */
  #refusedBeforePage(
    caller: CallerIdentity,
    via: AttachVia,
    inviteId: string | null,
    error: HubError,
  ): HubError {
    this.#budget.refused({
      v: AUDIT_VERSION,
      type: 'attach_refused',
      at: Date.now(),
      pageId: null,
      origin: null,
      userId: caller.userId,
      kind: caller.account.kind,
      via,
      inviteId,
      outcome: attachRefusalOf(error.code),
    });
    return error;
  }

  /** Counts one pairing attempt for the user, or refuses it past the limit (S3). */
  #pairingLimited(caller: CallerIdentity, via: AttachVia, now: number): HubError | null {
    const { userId } = caller;
    if (!this.#userLimiter.allows(userId, now)) {
      this.#log.warn('pairing attempt rate limited', { userId });
      return this.#refusedBeforePage(
        caller,
        via,
        null,
        hubError('rate_limited', 'too many pairing attempts; wait a minute and try again'),
      );
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
    via: 'code' | 'qr',
    now: number,
  ): Started {
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
      return this.#refusedBeforePage(
        caller,
        via,
        null,
        hubError(
          'rate_limited',
          'too many pairing attempts on this page; wait a minute and try again',
        ),
      );
    }
    this.#pageLimiter.record(page.pageId, now);

    // An attachment past its time, or made by the invite of a member past
    // theirs, is over, so its holder pairs as anyone not attached does.
    this.#chainInTime(page.pageId, caller.userId);
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
        ...this.#sponsorNamed(existing),
      };
    }

    // One person has at most one request per page. A retry after the wait ran
    // out, or the same person on a second device, waits on the request the
    // operator already sees, so the page never gets duplicates to answer. A
    // page that fills up meanwhile is caught when the operator approves.
    const pending = this.#store.requests
      .listForPage(page.pageId)
      .find((candidate) => candidate.userId === caller.userId);
    if (pending) {
      this.#joinRequest(pending, caller.client, via);
      return { kind: 'pending', record: pending };
    }

    // S9: a full page is refused before its operator is asked anything.
    if (this.#pageFull(page.pageId)) {
      this.#log.info('pairing refused: the page holds the most users allowed', {
        pageId: page.pageId,
        userId: caller.userId,
      });
      this.#spike?.pairingDecided(page.pageId, caller.userId, false);
      return this.#refusedBeforePage(caller, via, null, this.#pageFullError('already has'));
    }

    if (page.policy.autoApprove === 'observer') {
      const attachment = this.#grant(
        {
          pageId: page.pageId,
          userId: caller.userId,
          displayName: caller.displayName,
          account: caller.account,
          oauthClientId: caller.oauthClientId,
          client: caller.client,
          via,
        },
        'observer',
      );
      this.#spike?.pairingDecided(page.pageId, caller.userId, true);
      return {
        kind: 'attached',
        pageId: page.pageId,
        origin: page.origin,
        role: attachment.role,
        existing: false,
      };
    }

    return { kind: 'pending', record: this.#raiseRequest(caller, page, conn, via, null, now) };
  }

  /** The same person's next device or retry waits on the request already shown, named on it. */
  #joinRequest(pending: AttachRequestRecord, joining: ClientInfo | null, via: AttachVia): void {
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
  }

  /**
   * A new attach request the operator sees, which silence denies when its
   * time runs out. A redemption's carries the invite and the secret as it was
   * presented, which the relay forwards and never keeps, so the adapter can
   * check it against its own record (ADR 0017).
   */
  #raiseRequest(
    caller: CallerIdentity,
    page: PageRecord,
    conn: Conn,
    via: AttachVia,
    invite: { inviteId: string; secret: string; label: string } | null,
    now: number,
  ): AttachRequestRecord {
    const { attachRequestTtlMs } = this.#config.timings;
    const record: AttachRequestRecord = {
      pageId: page.pageId,
      userId: caller.userId,
      displayName: caller.displayName,
      account: caller.account,
      oauthClientId: caller.oauthClientId,
      client: caller.client,
      requestId: newId('rq'),
      via,
      inviteId: invite?.inviteId ?? null,
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
      // Silence on a control invite's prompt counts as a refusal (ADR 0016).
      if (record.inviteId !== null) this.#inviteRefused(record.pageId, record.inviteId);
    });
    this.#send(conn, {
      t: 'attach_request',
      requestId: record.requestId,
      user: { userId: record.userId, displayName: record.displayName },
      // A member's name comes from the owner's own settings; an invitee's is verified only with an email.
      account: {
        kind: record.account.kind,
        verified: record.account.kind === 'member' || record.account.email !== null,
      },
      via: record.via,
      ...(invite === null ? {} : { invite }),
      client: record.client,
      expiresAt: record.expiresAt,
    });
    this.#log.info('attach request sent', {
      pageId: record.pageId,
      userId: record.userId,
      requestId: record.requestId,
      via,
    });
    return record;
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

  /**
   * `heldBytes` is what the call's own request is measured to hold on the
   * heap while it waits (request-heap.ts), which relay.ts measures from its
   * body; 0 for a caller with none.
   */
  async callPageTool(
    caller: CallerIdentity,
    pageId: string,
    tool: PageToolRef,
    args: JsonObject,
    signal: AbortSignal,
    marks: CallMarks | null = null,
    heldBytes = 0,
  ): Promise<CallOutcome> {
    const started = Date.now();
    // The duration comes from a clock that only runs forward: a wall clock
    // stepped back during the call would give a negative one, which the
    // record's schema refuses, and the call would lose its line (S7).
    const startedMono = performance.now();
    let auditOutcome: AuditOutcome = 'relay_error';
    const trace: CallTrace = {
      reached: false,
      release: null,
      tool: typeof tool === 'string' ? tool : this.firstClassAuditName(pageId, tool.firstClass),
    };
    try {
      const outcome = await this.#call(caller, pageId, tool, args, signal, marks, trace, heldBytes);
      auditOutcome = outcome.kind === 'error' ? outcome.code : outcome.kind;
      return outcome.kind === 'ok' || outcome.kind === 'tool_error'
        ? { ...outcome, tool: trace.tool }
        : outcome;
    } catch (error) {
      // The SDK still answers the client with an error result; the log keeps the cause.
      this.#log.error('call failed inside the relay', { pageId, error });
      throw error;
    } finally {
      trace.release?.();
      // In finally, so every attempt leaves a record even when the relay itself fails (S7).
      const record: AuditCallEvent = {
        v: AUDIT_VERSION,
        type: 'call',
        at: started,
        // The client's own text: kept when it is an id or a tool name, else only its length (ADR 0019).
        pageId: auditPageId(pageId),
        origin: this.#store.pages.get(pageId)?.origin ?? null,
        userId: caller.userId,
        client: caller.client,
        tool: auditToolName(trace.tool),
        outcome: auditOutcome,
        durationMs: Math.round(performance.now() - startedMono),
      };
      // A call that reached its page is always written in full; one refused
      // before it went out, or failed by the relay before it could, only
      // within the refusal budget (ADR 0019).
      if (trace.reached || auditOutcome === 'relay_error') this.#audit(record);
      else this.#budget.refused(record);
      this.#spike?.callFinished(pageId, caller.userId, auditOutcome);
    }
  }

  /**
   * The tool a first-class call is recorded under (S7) until the call
   * resolves it: the one tool of the page that maps to the name, which is
   * what call_page_tool records for the same call, refused or not; or, when
   * the relay holds no such tool (the page is asleep, gone or unknown, or
   * none or two of its tools map to the name), the whole first-class name.
   * Never the mapped part alone, which reads as another tool's name: a
   * refused `<page id>__doc_save` must not be recorded as a call to a
   * `doc_save` the page may also have when it meant `doc.save`.
   */
  firstClassAuditName(pageId: string, toolPart: string): string {
    let found: string | null = null;
    for (const tool of this.#store.pages.get(pageId)?.tools ?? []) {
      if (firstClassToolPart(tool.name) !== toolPart) continue;
      if (found !== null) return firstClassName(pageId, toolPart);
      found = tool.name;
    }
    return found ?? firstClassName(pageId, toolPart);
  }

  /**
   * A call_page_tool whose own arguments do not fit its schema, a page id
   * of 101 characters say, is a call refused before any page saw it, so it
   * keeps its call line within the refusal budget like any other (S7, ADR
   * 0019). The page and tool are the client's text, stored only when valid.
   */
  refusedMalformedCall(caller: CallerIdentity, page: string, pageTool: string): void {
    this.#budget.refused({
      v: AUDIT_VERSION,
      type: 'call',
      at: Date.now(),
      pageId: auditPageId(page),
      origin: this.#store.pages.get(page)?.origin ?? null,
      userId: caller.userId,
      client: caller.client,
      tool: auditToolName(pageTool),
      outcome: 'invalid_arguments',
      durationMs: 0,
    });
  }

  /**
   * ADR 0018's per-user request budget refused a request before its tool
   * ran: a call stays a call record and a pairing an attach_refused one, so
   * every attempt of each keeps its kind of line, and the other tools get a
   * request_refused record, each within the refusal budget (ADR 0019).
   */
  refusedByBudget(caller: CallerIdentity, refused: BudgetRefusal): void {
    const at = Date.now();
    const { userId, client } = caller;
    switch (refused.tool) {
      case 'call_page_tool':
        this.#budget.refused({
          v: AUDIT_VERSION,
          type: 'call',
          at,
          pageId: auditPageId(refused.page),
          origin: this.#store.pages.get(refused.page)?.origin ?? null,
          userId,
          client,
          tool: auditToolName(refused.pageTool),
          outcome: 'rate_limited',
          durationMs: 0,
        });
        return;
      case 'pair_page':
        this.#refusedBeforePage(
          caller,
          refused.via,
          null,
          hubError('rate_limited', 'too many requests'),
        );
        return;
      case 'list_pages':
        this.#budget.refused({
          v: AUDIT_VERSION,
          type: 'request_refused',
          at,
          userId,
          kind: caller.account.kind,
          client,
          tool: 'list_pages',
          pageId: null,
          outcome: 'rate_limited',
        });
        return;
      default:
        this.#budget.refused({
          v: AUDIT_VERSION,
          type: 'request_refused',
          at,
          userId,
          kind: caller.account.kind,
          client,
          tool: refused.tool,
          pageId: auditPageId(refused.page),
          outcome: 'rate_limited',
        });
    }
  }

  /**
   * Every audit record the hub writes goes through here: into the audit log
   * and, as its off-host copy with whatever the file line added, to the log,
   * whose redaction drops an invitee's email (recordAudit, ADR 0019).
   * Arguments are never part of a record (S7). Refusals that reached no page
   * come here only through the refusal budget.
   */
  #audit(event: AuditEvent): void {
    recordAudit(this.#store.audit, this.#frameLog.kept, event);
  }

  /**
   * Everything a call must pass, in order: access, the rate limit (so a refused
   * call still counts and nobody spins on invalid calls for free), what its
   * request may hold while it waits, the tool, the role, the frame size, the
   * queue depth for a mutating call, and the arguments. A mutating call takes
   * its place in its page's queue on arrival, before its argument check
   * answers, so a later write whose check is quicker or skipped never
   * overtakes it (SPEC section 5); a read-only one goes to the page once its
   * check answers.
   */
  async #call(
    caller: CallerIdentity,
    pageId: string,
    toolRef: PageToolRef,
    args: JsonObject,
    signal: AbortSignal,
    marks: CallMarks | null,
    trace: CallTrace,
    heldBytes: number,
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
    const held = this.#holdBytes(caller, heldBytes, 'page_busy');
    if (held.kind === 'error') return held;
    trace.release = held.release;

    // Every call moves the expiry, but only one that passes every check names
    // its client (#nameClient): refused calls must not add names to the roster.
    const rosterAtArrival = this.#touchAttachment(attachment, arrivedAt);
    const resolved = this.#resolveTool(page, attachment, toolRef);
    if (resolved.kind === 'error') return resolved;
    const { tool } = resolved;
    const toolName = tool.name;
    trace.tool = toolName;
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
      heldOn: null,
      invokeBytes: 0,
      marks,
      trace,
      timer: null,
      done: false,
      settle: () => undefined,
    };
    // Checked before anything waits: the size cannot grow later, as the role
    // and deadline only shrink and a confirmation's room is counted already.
    const encoded = this.#encodeInvoke(call, attachment.role, this.#config.timings.callDeadlineMs);
    if (encoded.kind === 'error') return encoded;
    call.invokeBytes = encoded.bytes;

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
        // A queued or held call simply leaves; the page never heard of it.
        if (call.conn) this.#sendCancel(call.conn, call.callId, 'client');
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
  ): { kind: 'frame'; text: string; bytes: number } | HubError {
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
    // oversized call must stop here rather than knock the page offline. The
    // room a confirmation takes is kept on every call, since one confirmed in
    // its client gains it just before it goes out (ADR 0026), so nobody is
    // asked about a call that would then be too large to send (ADR 0032).
    const bytes = Buffer.byteLength(text, 'utf8') + MAX_CONFIRMATION_FRAME_BYTES;
    if (bytes > MAX_FRAME_BYTES) {
      return hubError(
        'invalid_arguments',
        `the arguments are too large to forward; one page link frame carries at most ${String(MAX_FRAME_BYTES)} bytes`,
      );
    }
    return { kind: 'frame', text, bytes };
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
          this.#sendCancel(call.conn, call.callId, 'timeout');
          call.settle(
            hubError('timeout', `the page did not answer within ${String(callDeadlineMs)} ms`),
          );
        } else {
          call.settle(call.heldOn ? this.#heldTooLong() : this.#queuedTooLong());
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

  #heldTooLong(): HubError {
    return hubError(
      'timeout',
      `the page did not take what the relay had already sent it within ${String(this.#config.timings.callDeadlineMs)} ms, so the call never reached it`,
    );
  }

  /**
   * The page tool a call names, looked up at the same step for both routes.
   * A first-class name (ADR 0025) is the one tool of the page that maps to
   * it, whether or not the caller's list shows it (a tool left off for a
   * cap or its schema stays reachable); tool_not_found when none or two map
   * to it, and on an attachment an invite made, or an invitee's, which ADR
   * 0016 keeps on the fixed tools. Every later check is the same code.
   */
  #resolveTool(
    page: PageRecord,
    attachment: AttachmentRecord,
    ref: PageToolRef,
  ): { kind: 'ok'; tool: PageTool } | HubError {
    const { pageId } = page;
    if (typeof ref === 'string') {
      const tool = page.tools.find((candidate) => candidate.name === ref);
      return tool
        ? { kind: 'ok', tool }
        : hubError('tool_not_found', `page ${pageId} has no tool named ${ref}`);
    }
    if (attachment.kind !== 'member' || attachment.inviteId !== null) {
      return hubError(
        'tool_not_found',
        `page ${pageId} offers no first-class tools to an attachment an invite made; use call_page_tool`,
      );
    }
    const matches = page.tools.filter(
      (candidate) => firstClassToolPart(candidate.name) === ref.firstClass,
    );
    const [only] = matches;
    if (only === undefined || matches.length > 1) {
      return hubError('tool_not_found', `page ${pageId} has no tool named ${ref.firstClass}`);
    }
    return { kind: 'ok', tool: only };
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
   * waited: the attachment, the page, the tool and the role. A call that
   * finds no room on the page's socket, or calls already waiting for it,
   * waits behind them (#hold). True if it went out or waits for room.
   */
  #dispatch(call: PendingCall): boolean {
    const current = this.#recheck(call);
    if (current.kind === 'error') {
      call.settle(current);
      return false;
    }
    const { conn } = current;
    if (conn.held.length > 0 || !this.#roomForInvoke(conn, call.invokeBytes)) {
      this.#hold(call, conn);
      return true;
    }
    return this.#sendInvoke(call, current.attachment, conn);
  }

  /** The invoke itself, once every check has passed and the socket has room. True if it went out. */
  #sendInvoke(call: PendingCall, attachment: AttachmentRecord, conn: Conn): boolean {
    // #access refuses a socket the relay is closing, but one the page began
    // to close stays CLOSING until ws reports the close, up to its 30 s
    // closeTimeout while the peer keeps TCP open, and ws sends nothing on it;
    // written there, the call would wait out its deadline and be recorded as
    // having reached the page (S7).
    if (conn.closing || conn.ws.readyState !== conn.ws.OPEN) {
      call.settle(hubError('page_asleep', 'the page disconnected before the call reached it'));
      return false;
    }
    const { callDeadlineMs } = this.#config.timings;
    const remaining = call.waited ? callDeadlineMs - (Date.now() - call.arrivedAt) : callDeadlineMs;
    if (remaining <= 0) {
      call.settle(call.heldOn ? this.#heldTooLong() : this.#queuedTooLong());
      return false;
    }
    const encoded = this.#encodeInvoke(call, attachment.role, remaining);
    if (encoded.kind === 'error') {
      call.settle(encoded);
      return false;
    }
    call.heldOn = null;
    call.conn = conn;
    call.trace.reached = true;
    conn.inflight.set(call.callId, call);
    this.#armCallTimer(call);
    if (call.marks) call.marks.invokeOut = performance.now();
    this.#write(conn, false, (written) => {
      conn.ws.send(encoded.text, written);
    });
    return true;
  }

  /**
   * A call whose invoke would take the page's queue past INVOKE_ROOM waits,
   * holding nothing the call does not already hold, until the page takes
   * enough of what it was sent (#sendHeld) or its deadline passes. Its
   * deadline runs on meanwhile, as in the write queue.
   */
  #hold(call: PendingCall, conn: Conn): void {
    call.heldOn = conn;
    call.waited = true;
    conn.held.push(call);
    this.#log.debug('call waits for room on the page link', {
      pageId: call.pageId,
      callId: call.callId,
      held: conn.held.length,
    });
  }

  /**
   * Sends the calls waiting for room on this socket, oldest first, while
   * there is room for the next. Each is looked at once more as it goes,
   * since its caller may have been revoked or demoted meanwhile.
   */
  #sendHeld(conn: Conn): void {
    while (!conn.closing && conn.ws.readyState === conn.ws.OPEN) {
      const call = conn.held[0];
      if (call === undefined || !this.#roomForInvoke(conn, call.invokeBytes)) return;
      conn.held.shift();
      const current = this.#recheck(call);
      if (current.kind === 'error') call.settle(current);
      else if (current.conn === conn) this.#sendInvoke(call, current.attachment, conn);
      else {
        // The page resumed on another socket; the call follows it.
        call.heldOn = null;
        this.#dispatch(call);
      }
    }
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

  /** Takes a settled call out of its socket's in-flight set or wait for room, and its page's queue. */
  #detachCall(call: PendingCall): void {
    call.conn?.inflight.delete(call.callId);
    if (call.heldOn) {
      const at = call.heldOn.held.indexOf(call);
      if (at !== -1) call.heldOn.held.splice(at, 1);
      call.heldOn = null;
    }
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
    const idleEnd = now + this.#config.timings.attachmentIdleMs;
    // Use moves the idle expiry, never past an invite-made attachment's end.
    attachment.expiresAt =
      attachment.endsAt === null ? idleEnd : Math.min(idleEnd, attachment.endsAt);
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
    // One past its time, or below a member past theirs, ends as it would have, not as a detach.
    this.#chainInTime(pageId, userId);
    const attachment = this.#store.attachments.get(pageId, userId);
    if (attachment) {
      this.#endAttachments(pageId, new Set([userId]), 'client', 'you detached from this page');
      const page = this.#store.pages.get(pageId);
      this.#audit({
        v: AUDIT_VERSION,
        type: 'detach',
        at: Date.now(),
        pageId,
        origin: page?.origin ?? '',
        userId,
      });
      this.#log.info('detached', { pageId, userId });
      // A sponsor who leaves takes their invites, and what those made, with them (S14).
      this.#loseSponsors(pageId, [attachment]);
      this.#sendRoster(pageId);
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

  /** Any frame but an invoke (#sendInvoke) or a cancel (#sendCancel), within ADR 0024's bound. */
  #send(conn: Conn, frame: RelayFrame): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    const text = encodeFrame(frame);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (!this.#roomFor(conn, bytes)) return;
    this.#write(conn, true, (written) => {
      conn.ws.send(text, written);
    });
  }

  /**
   * A cancel never closes a page: at most one follows each invoke that went
   * out, so the call limits bound them, and a member cancelling a burst of
   * calls must not end the page for everyone (ADR 0024's notes).
   */
  #sendCancel(conn: Conn, callId: string, reason: CancelReason): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    const text = encodeFrame({ t: 'cancel', callId, reason });
    this.#write(conn, false, (written) => {
      conn.ws.send(text, written);
    });
  }

  /**
   * Hands ws one frame and counts it in the socket's queue until ws reports
   * it handed to the kernel; each such report is the page making progress,
   * so calls waiting for room are looked at again.
   */
  #write(conn: Conn, counted: boolean, send: (written: () => void) => void): void {
    this.#observe(conn);
    const { queue } = conn;
    const epoch = queue.epoch;
    queue.frames += 1;
    if (counted) queue.counted += 1;
    send(() => {
      if (queue.epoch === epoch) {
        queue.frames -= 1;
        if (counted) queue.counted -= 1;
      }
      if (conn.held.length > 0) this.#sendHeld(conn);
    });
  }

  /**
   * Starts the socket's counts over when its queue (bufferedAmount: what ws
   * has not yet handed the kernel) is empty: nothing is unread then, though
   * the callbacks of what just left may still be a tick away.
   */
  #observe(conn: Conn): void {
    if (conn.ws.bufferedAmount !== 0) return;
    conn.queue.epoch += 1;
    conn.queue.frames = 0;
    conn.queue.counted = 0;
  }

  /**
   * Whether an invoke of this many bytes may go out now (INVOKE_ROOM): onto
   * an empty queue always, otherwise while the queue and it stay within
   * INVOKE_ROOM and the frames queued below MAX_UNREAD_FRAMES. Never closes.
   */
  #roomForInvoke(conn: Conn, bytes: number): boolean {
    this.#observe(conn);
    const queued = conn.ws.bufferedAmount;
    return queued === 0 || (queued + bytes <= INVOKE_ROOM && conn.queue.frames < MAX_UNREAD_FRAMES);
  }

  /**
   * Whether a frame of this many bytes may be queued for the page (ADR 0024).
   * The socket's queue (bufferedAmount) holds only what the kernel has not
   * taken yet, so it stays empty while the page reads, and drains on a slow
   * link as fast as the link takes it. Past MAX_UNREAD_FRAMES frames that
   * count still in it, or MAX_UNREAD_BYTES queued in all, the page is not
   * reading what it is sent, and its socket is closed with 1008 and cut off
   * after CLOSE_GRACE_MS, which frees what it held; the page sleeps and may
   * resume like after any close. Invokes never fill more than INVOKE_ROOM
   * of it, so what a member's calls queue cannot close a page by itself.
   */
  #roomFor(conn: Conn, bytes: number): boolean {
    this.#observe(conn);
    const queued = conn.ws.bufferedAmount;
    if (queued === 0) return true;
    if (conn.queue.counted < MAX_UNREAD_FRAMES && queued + bytes <= MAX_UNREAD_BYTES) return true;
    this.connectionLine(conn.address, 'warn', 'closing page socket: the page is not reading', {
      pageId: conn.pageId,
      address: conn.address,
      queuedBytes: queued,
      queuedFrames: conn.queue.counted,
    });
    this.#closeSocket(conn, CLOSE_POLICY, 'page is not reading');
    return false;
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
    // The refusal counts still held go out first, while the audit log is open.
    this.#budget.close();
    // So do the counts of page lines held back.
    this.#ignoredLines.flush();
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
        this.#sendCancel(conn, callId, 'shutdown');
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
      this.#inviteTimers,
    ]) {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    }
    this.#liveCodes.clear();
    await Promise.all([...closing, checkerClosed]);
    // Once every socket has closed, so the lines their closes counted go out too.
    this.#connectionLines.flush();
  }
}

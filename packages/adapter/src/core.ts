// The adapter core (SPEC.md sections 6 and 8): one page's link to the relay.
// It touches no DOM or browser global, so the browser entry and the Node sim
// page run exactly this code; the socket, the WebMCP runtime, storage, locks,
// timers and the operator's prompts all arrive through CoreOptions.

import {
  type Account,
  ATTACH_REQUEST_TTL_MS,
  type AttachmentView,
  type AttachVia,
  type Caller,
  type ClientInfo,
  CLOSE_DETACH,
  CLOSE_INVALID_FRAME_PAGE,
  CLOSE_REPLACED,
  CLOSE_SILENT,
  CONTROL_INVITE_USES,
  encodeFrame,
  IdSchema,
  IDLE_TIMEOUT_MS,
  InviteLabelSchema,
  type InviteRefusalReason,
  JsonObjectSchema,
  MAX_FRAME_BYTES,
  MAX_INVITE_USES,
  MAX_RESULT_CHARS,
  type PageErrorCode,
  type PageFrameInput,
  PageFrameSchema,
  type PageTool,
  type Pairing,
  parseRelayFrame,
  type PolicyInput,
  PolicySchema,
  PROTOCOL_VERSION,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  type RelayFrame,
  type Role,
  RoleSchema,
  type StoredGrant,
  StoredGrantSchema,
  SUBPROTOCOL,
  TOOL_POLL_MS,
  truncate,
  type User,
} from '@tabdock/protocol';
import {
  isConsequential,
  isReadOnly,
  needsHintNotice,
  type NormalisedTool,
  normaliseTools,
  type RuntimeTool,
  type ToolSnapshot,
} from './tools.ts';

export type { HintSupport, RuntimeTool } from './tools.ts';
export type { StoredGrant, StoredInvite, StoredInvites } from '@tabdock/protocol';

// Ports: everything the core needs from its environment.

/** The slice of document.modelContext the adapter uses. It never registers tools. */
export interface ModelContextLike {
  getTools(): Promise<readonly RuntimeTool[]>;
  executeTool?(
    tool: RuntimeTool,
    input: unknown,
    options: { signal: AbortSignal },
  ): Promise<unknown>;
  addEventListener(type: 'toolchange', listener: () => void): void;
  removeEventListener(type: 'toolchange', listener: () => void): void;
}

/**
 * Handlers are declared through a method type so that a browser WebSocket and a
 * `ws` client, whose events carry more than this, are both assignable.
 */
type Handler<E> = { bivarianceHack(event: E): void }['bivarianceHack'];

export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: Handler<unknown> | null;
  onmessage: Handler<{ data: unknown }> | null;
  onclose: Handler<{ code: number; reason: string }> | null;
  onerror: Handler<unknown> | null;
}

export type SocketFactory = (url: string, protocols: readonly string[]) => SocketLike;

/** sessionStorage fits; it keeps the resume token across a reload but not into a copied tab's future. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * navigator.locks fits. SPEC section 8 asks for a lock while linked: Chrome exempts pages
 * holding a Web Lock from Energy Saver freezing, though whether an uncontested lock counts
 * is measured in M3 (docs/notes/verified.md).
 */
export interface LocksLike {
  request(name: string, callback: (lock: unknown) => Promise<unknown>): Promise<unknown>;
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** What hello says about the page that can change while it is open. */
export interface PageInfo {
  title: string;
}

export type AttachAnswer = Role | 'deny';

/**
 * An optional operator that answers prompts in code (a scripted test operator,
 * or a host UI). Returning undefined, or never settling, leaves the prompt to
 * the Dock handle; silence until the deadline denies either way. The signal
 * aborts once the prompt is settled elsewhere or expires.
 */
export interface UiPort {
  askAttach?(
    request: PendingRequest,
    signal: AbortSignal,
  ): AttachAnswer | undefined | Promise<AttachAnswer | undefined>;
  askConfirm?(
    confirm: PendingConfirm,
    signal: AbortSignal,
  ): boolean | undefined | Promise<boolean | undefined>;
}

export interface CoreOptions {
  /** The relay's page endpoint, for example ws://127.0.0.1:8787/page. */
  relayUrl: string;
  policy?: PolicyInput | undefined;
  /** document.modelContext; without it the core logs how to add a polyfill and stays idle. */
  modelContext?: ModelContextLike | undefined;
  socketFactory: SocketFactory;
  storage?: StorageLike | undefined;
  ui?: UiPort | undefined;
  /**
   * The page's address when the adapter starts: location.origin plus
   * location.pathname in a browser. One approval covers one page (ADR 0011),
   * so the resume token, grants, revokes and pause are kept under it, and
   * hello names it. Any query or fragment is dropped.
   */
  pageUrl: string;
  /** Read at every hello. */
  pageInfo: () => PageInfo;
  /** When getTools() entries carry a window, only those whose window is this one are shared. */
  ownWindow?: unknown;
  locks?: LocksLike | undefined;
  adapterVersion: string;
  logger?: Logger | undefined;
  /** Epoch milliseconds; injectable with timers and random so tests control time. */
  clock?: (() => number) | undefined;
  timers?: Timers | undefined;
  random?: (() => number) | undefined;
}

// What the page sees.

export type LinkState = 'idle' | 'connecting' | 'linked' | 'reconnecting' | 'closed';

export interface PendingRequest {
  readonly requestId: string;
  readonly user: User;
  /** Member or invitee, and whether an invitee's name is a verified email (ADR 0017). */
  readonly account: Account;
  readonly via: AttachVia;
  /**
   * The invite a redemption came through, as the relay names it; never its
   * secret, which stays inside the adapter. null for a code or QR request.
   */
  readonly invite: { readonly inviteId: string; readonly label: string } | null;
  readonly client: ClientInfo | null;
  /** Local epoch milliseconds at which silence becomes a denial. */
  readonly expiresAt: number;
}

/** How long an invite works: 15 minutes, an hour, or while the page is open (ADR 0016). */
export type InviteLifetime = '15m' | '1h' | 'open';

export const INVITE_LIFETIMES: readonly InviteLifetime[] = ['15m', '1h', 'open'];

/** What the operator asks for when minting an invite (ADR 0017). */
export interface InviteOptions {
  /** 1 to 60 characters; shown wherever the invite is, as the page's own words. */
  readonly label: string;
  /** observer for Can watch; driver for Can control, which needs policy.invites 'all'. */
  readonly role: Role;
  /** An hour unless set; never past 24 hours, whatever is chosen. */
  readonly lifetime?: InviteLifetime;
  /** Can watch only: 1 (unless set) to 20. A Can control invite always has exactly one. */
  readonly uses?: number;
}

/**
 * Why no link came back: the relay's own reasons (ADR 0017), or the
 * adapter's: options it cannot mint (invalid), no link to the relay
 * (link_down), or a relay that offers no invites (unavailable).
 */
export type InviteRefusal = InviteRefusalReason | 'invalid' | 'link_down' | 'unavailable';

/**
 * One live invite this page minted, as the widget's list shows it (ADR
 * 0017): the relay's listing of an invite this page's own record holds.
 * expiresAt is the operator's choice on this page's clock, as the relay echoes
 * it back; null is "while the page is open", which still ends 24 hours after
 * minting.
 */
export interface InviteView {
  readonly inviteId: string;
  /** observer for Can watch, driver for Can control. */
  readonly role: Role;
  /** Written on this page: shown as its own words (S10). */
  readonly label: string;
  readonly uses: number;
  readonly usesLeft: number;
  readonly expiresAt: number | null;
  /** The member the relay named as sponsor at minting; fixed, since /i shows the name. */
  readonly sponsor: User;
  /** A redemption waits on the operator; a control invite allows one at a time. */
  readonly pending: boolean;
  /** Refusals and timeouts so far; three burn a control invite. */
  readonly refusals: number;
}

/** What a relay that offers invites said in its last invites frame. */
export interface InvitesOffered {
  /** `<public URL>/i`, where links start; null when this relay mints none, having no public URL. */
  readonly linkBase: string | null;
}

/** Options for Revoke (ADR 0017). */
export interface RevokeOptions {
  /**
   * For someone an invite let in, also close that invite's link
   * (invite_cancel), so nobody else joins by it. The widget checks it by
   * default for a multi-use invite; revoke('*') closes every link anyway.
   */
  readonly closeInvite?: boolean;
}

/** The link shows here once, and is never stored: only its secret's hash is. */
export type InviteResult =
  | {
      readonly ok: true;
      readonly inviteId: string;
      readonly link: string;
      /** Local epoch milliseconds; null while the page is open, which still ends after 24 hours. */
      readonly expiresAt: number | null;
    }
  | { readonly ok: false; readonly reason: InviteRefusal };

export interface PendingConfirm {
  readonly callId: string;
  readonly tool: string;
  readonly caller: Caller;
  /** Local epoch milliseconds at which silence becomes a denial (the call's deadline). */
  readonly expiresAt: number;
}

/** How a call ended, as the page activity log shows it; 'running' until it does. */
export type ActivityOutcome = 'running' | 'ok' | PageErrorCode;

/**
 * One call in the page activity log (S7): who asked, through which client,
 * for which tool, and how it ended. Never the arguments or the result.
 */
export interface ActivityEntry {
  readonly callId: string;
  /** Local epoch milliseconds at which the invoke arrived. */
  readonly time: number;
  readonly user: User;
  readonly client: ClientInfo | null;
  readonly tool: string;
  readonly outcome: ActivityOutcome;
  /** Milliseconds from arrival to the end; null while the call runs. */
  readonly durationMs: number | null;
  /**
   * True from when the call was answered (cancelled, timed out, revoked or cut
   * off) until the page's handler, which kept running, ends. A write holds
   * the page meanwhile, so later writes wait for it.
   */
  readonly handlerRunning: boolean;
}

/** What this page lets one user the roster lists do; see DockState.pageRoles. */
export interface PageRole {
  readonly userId: string;
  /** The role the page runs their calls under, or null when it runs none. */
  readonly role: Role | null;
  /** Revoked here, and the relay has not dropped them yet. */
  readonly revoked: boolean;
}

export interface DockState {
  readonly link: LinkState;
  readonly pageId: string | null;
  readonly pairing: Pairing | null;
  readonly roster: readonly AttachmentView[];
  /**
   * One entry per roster entry, in the same order: the role the page itself
   * enforces, the lesser of the operator's grant and the roster's role. The
   * roster is the relay's claim; a user the operator never approved here, or
   * revoked, gets null whatever it says.
   */
  readonly pageRoles: readonly PageRole[];
  readonly pendingRequests: readonly PendingRequest[];
  readonly pendingConfirms: readonly PendingConfirm[];
  /** Advice for the page author, such as the consequentialHint fallback (ADR 0002). */
  readonly notice: string | null;
  /** Why the link is not working, when it is not. */
  readonly error: string | null;
  /** While true, every new call is answered page_busy; calls already running finish. */
  readonly paused: boolean;
  /** The last ACTIVITY_LIMIT calls, newest first. */
  readonly activity: readonly ActivityEntry[];
  /**
   * This page's live invites, oldest first (ADR 0017): empty until a relay
   * offers invites, and holding only those this page's own record knows.
   */
  readonly invites: readonly InviteView[];
  /**
   * null until an invites frame arrives, which only a relay with invites on
   * sends, right after each welcome (ADR 0017's notes); a relay with them off
   * never sends one, so the widget then offers no Invite form at all.
   */
  readonly invitesOffered: InvitesOffered | null;
}

/** The only control handle. Each method returns false when there was nothing to act on. */
export interface Dock {
  readonly state: DockState;
  on(event: 'state', listener: (state: DockState) => void): () => void;
  approve(requestId: string, role: Role): boolean;
  deny(requestId: string): boolean;
  confirm(callId: string, allow: boolean): boolean;
  rotatePairing(): boolean;
  /**
   * The operator's role switch, for a user the roster lists and the operator
   * approved on this page (or autoApprove let in). The relay may still hold a
   * new driver at maxDrivers; the page runs calls under the lesser of this
   * choice and the relay's roster either way.
   */
  setRole(userId: string, role: Role): boolean;
  /**
   * Ends one user's attachment, or everyone's with '*' (S8), which also
   * cancels every live invite. Revoking someone an invite let in bars them
   * from it; options.closeInvite also closes its link (ADR 0017).
   */
  revoke(userId: string, options?: RevokeOptions): boolean;
  /**
   * Closes one live invite's link (invite_cancel); the attachments it already
   * made stay until revoked (ADR 0017's notes). False when this page holds no
   * such invite.
   */
  cancelInvite(inviteId: string): boolean;
  /**
   * Mints an invite on this page as far as policy.invites allows (ADR 0017):
   * a 128-bit secret whose hash alone goes to the relay and into this page's
   * own record, and a link that resolves here once. Workstream B mints; until
   * then every relay offers none, so this resolves unavailable once the
   * options and the page's policy check out.
   */
  invite(options: InviteOptions): Promise<InviteResult>;
  /** Pauses or resumes calls on this page. Only false resumes, and the choice survives a reload. */
  pause(paused: boolean): void;
  close(): void;
}

/**
 * 'detach' is a deliberate goodbye: pending prompts are denied, the socket
 * closes with CLOSE_DETACH and the resume token is forgotten. 'unload' is what a page
 * reload looks like to the relay: the socket goes away (1001) and the token
 * stays, so the next page load resumes.
 */
export type CloseMode = 'detach' | 'unload';

export interface AdapterCore {
  readonly dock: Dock;
  start(): void;
  close(mode?: CloseMode): void;
}

// Behaviour constants local to the adapter.

const OPEN = 1;

/** toolchange fires once per registration, so a page registering six tools at once should cost one frame. */
const TOOLCHANGE_DEBOUNCE_MS = 25;

/** A link that hears nothing for the relay's idle timeout plus this grace is treated as dead. */
export const SILENCE_GRACE_MS = 5000;

/** The page activity log keeps this many calls (SPEC section 8). */
export const ACTIVITY_LIMIT = 50;

/**
 * Writes the page holds waiting at once, ADR 0009's per-page queue default.
 * The relay sends one write at a time, so only a relay that floods the page
 * gets here; past it, writes are answered page_busy rather than piling up.
 */
export const MAX_WAITING_WRITES = 32;

/**
 * How long past its deadline a write keeps the page once the runtime has
 * stopped watching its handler (see holdUnwatched); the relay gives a
 * running call the same grace.
 */
export const UNWATCHED_HANDLER_GRACE_MS = 2000;

/** Results are cut this far under the cap so the truncation marker fits under it too. */
const MARKER_ROOM = 100;

/** The protocol caps result error messages at this length. */
const MAX_ERROR_CHARS = 2000;

/** The smallest frame limit honoured from a relay, so a truncated result always fits. */
const MIN_FRAME_BYTES = 4096;

/**
 * What the adapter keeps in the tab's storage, each for one relay and one
 * page: from M4 also its invite records (StoredInvites, ADR 0017), beside
 * the grants and dropped with them.
 */
export type StoredRecord = 'resume' | 'grants' | 'revoked' | 'paused' | 'invites';

const STORED_RECORDS: readonly StoredRecord[] = [
  'resume',
  'grants',
  'revoked',
  'paused',
  'invites',
];

const LOCK_PREFIX = 'tabdock:';

/**
 * The MCP-B polyfill 5.1 sets this on its context (its dist/index.js; the
 * README does not mention it). That runtime never hands a handler the signal
 * given to executeTool, it only races the call against it (ADR 0001).
 */
const POLYFILL_MARKER = '__isWebMCPPolyfill';

/**
 * The polyfill 5.1 also races each handler against its tool's registration
 * signal and, when the page unregisters the tool mid-run, rejects executeTool
 * with this UnknownError while the handler runs on (its dist/index.js,
 * #invokeToolByName).
 */
const POLYFILL_UNREGISTERED = 'Tool unregistered';

/** Its UnknownError for a tool already gone when the call starts, before any handler runs. */
const POLYFILL_NOT_FOUND = /^Tool not found/;

const POLYFILL_HINT =
  'document.modelContext is missing, so Tabdock stays idle. Load a WebMCP polyfill first ' +
  "(for example @mcp-b/webmcp-polyfill's initializeWebMCPPolyfill()) or use a browser with WebMCP enabled.";

const HINT_NOTICE =
  "This browser's WebMCP does not report consequentialHint, so every tool that is not read-only " +
  'is treated as consequential. List the consequential tools in policy.consequentialTools to fix this.';

/**
 * The standard close code for a malformed frame. Browsers refuse it from page
 * code, so closeSocket falls back to the protocol's CLOSE_INVALID_FRAME_PAGE.
 * A silent relay gets CLOSE_SILENT, never CLOSE_DETACH: the relay ends a
 * session at once on CLOSE_DETACH, and a page that reconnects must resume.
 */
const CLOSE_INVALID_FRAME = 1008;

type InvokeFrame = Extract<RelayFrame, { t: 'invoke' }>;
type WelcomeFrame = Extract<RelayFrame, { t: 'welcome' }>;
type AttachRequestFrame = Extract<RelayFrame, { t: 'attach_request' }>;

type Outcome = { ok: true; content: string } | { ok: false; code: PageErrorCode; message: string };
type Refusal = Extract<Outcome, { ok: false }>;

const PAUSED: Refusal = {
  ok: false,
  code: 'page_busy',
  message: 'the operator paused this page, so it runs no calls for now',
};

const REVOKED_MESSAGE = 'the operator revoked this caller';

/**
 * admitting: reading the tool list to learn whether the tool writes.
 * queued: a write waiting for the writes that arrived before it.
 * checking: cleared to go, perhaps waiting on the operator's confirmation.
 * running: the page's handler has started, so a pause lets it finish.
 */
type CallStage = 'admitting' | 'queued' | 'checking' | 'running';

interface CallRecord {
  readonly frame: InvokeFrame;
  /** Arrival order, which the write queue keeps. */
  readonly seq: number;
  /** Local epoch milliseconds of the call's deadline. */
  readonly deadlineAt: number;
  readonly controller: AbortController;
  /** The call's current line in the activity log; each change replaces it. */
  entry: ActivityEntry;
  stage: CallStage;
  finished: boolean;
  /** From the executeTool call until the runtime settles it, which may be after the call was answered. */
  executing: boolean;
  deadline: unknown;
  /** Set while the call waits for the operator's confirmation. */
  confirm: { readonly resolve: (allow: boolean) => void; readonly port: AbortController } | null;
}

type Checked = { ok: true; tool: NormalisedTool } | { ok: false; refusal: Refusal };

function refuse(code: PageErrorCode, message: string): Checked {
  return { ok: false, refusal: { ok: false, code, message } };
}

interface RequestRecord {
  readonly request: PendingRequest;
  readonly timer: unknown;
  readonly port: AbortController;
}

const consoleLogger: Logger = {
  info: (message) => {
    console.info(`[tabdock] ${message}`);
  },
  warn: (message) => {
    console.warn(`[tabdock] ${message}`);
  },
  error: (message) => {
    console.error(`[tabdock] ${message}`);
  },
};

const defaultTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** Each UTF-16 code unit becomes at most 3 UTF-8 bytes, so only longer strings need counting. */
function overByteLimit(text: string, limit: number): boolean {
  if (text.length > limit) return true;
  return text.length * 3 > limit && byteLength(text) > limit;
}

/**
 * Reads the grants stored beside the resume token with the protocol's own
 * schemas. Other code on the page shares that storage, so anything malformed
 * reads as no grants at all rather than as a partial list. Each grant is
 * `{ role, inviteId?, endsAt? }` from M4; a bare role, as an older adapter
 * stored it, reads as a grant with neither (ADR 0017).
 */
export function parseGrants(
  text: string,
): { pageId: string; grants: [string, StoredGrant][] } | null {
  const record = JsonObjectSchema.safeParse(parseJson(text));
  if (!record.success) return null;
  const pageId = IdSchema.safeParse(record.data.pageId);
  const stored = JsonObjectSchema.safeParse(record.data.grants);
  if (!pageId.success || !stored.success) return null;
  const grants: [string, StoredGrant][] = [];
  for (const [userId, grant] of Object.entries(stored.data)) {
    const user = IdSchema.safeParse(userId);
    const granted = StoredGrantSchema.safeParse(grant);
    if (!user.success || !granted.success) return null;
    grants.push([user.data, granted.data]);
  }
  return { pageId: pageId.data, grants };
}

/** The revokes the relay has not applied yet, stored beside the grants and read the same way. */
function parseRevoked(text: string): { pageId: string; users: string[] } | null {
  const record = JsonObjectSchema.safeParse(parseJson(text));
  if (!record.success) return null;
  const pageId = IdSchema.safeParse(record.data.pageId);
  const users = IdSchema.array().safeParse(record.data.users);
  if (!pageId.success || !users.success) return null;
  return { pageId: pageId.data, users: users.data };
}

/** undefined for text that is not JSON, which every schema then refuses. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function errorParts(error: unknown): { name: string; message: string } {
  if (typeof error === 'object' && error !== null) {
    const { name, message } = error as { name?: unknown; message?: unknown };
    return {
      name: typeof name === 'string' ? name : 'Error',
      message: typeof message === 'string' ? message : '',
    };
  }
  return { name: typeof error, message: String(error) };
}

/** For logs about the adapter's own plumbing only; tool errors are never logged, as they can echo arguments. */
function describe(error: unknown): string {
  const { name, message } = errorParts(error);
  return `${name}: ${message}`.slice(0, 200);
}

/**
 * Exponential backoff with jitter, kept inside RECONNECT_MIN_MS and
 * RECONNECT_MAX_MS: attempt n waits between half and all of min * 2^n.
 */
export function backoffDelay(attempt: number, random: () => number): number {
  const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(attempt, 16));
  const delay = ceiling / 2 + random() * (ceiling / 2);
  return Math.round(Math.min(RECONNECT_MAX_MS, Math.max(RECONNECT_MIN_MS, delay)));
}

/** Runtimes hand back strings; anything else is stringified the way they would. */
function resultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    try {
      const json = JSON.stringify(value) as string | undefined;
      if (json !== undefined) return json;
    } catch {
      // Falls through to String, as the runtimes do for unserialisable values.
    }
  }
  return String(value);
}

/**
 * Which executeTool input form a rejection asks for instead (ADR 0001), or null
 * when the rejection is about something else. Matching the start of the
 * message matters: a handler's own error is appended to a different fixed text
 * on the polyfill and may mention parsing too, and retrying it would run a
 * mutating handler twice.
 */
function otherInputFormat(error: unknown, tried: InputFormat): InputFormat | null {
  const { name, message } = errorParts(error);
  if (tried === 'object' && name === 'UnknownError' && /^Failed to parse input/i.test(message)) {
    return 'string';
  }
  if (tried === 'string' && name === 'TypeError' && /invalid input object/i.test(message)) {
    return 'object';
  }
  return null;
}

type InputFormat = 'object' | 'string';

/**
 * The page an address names (ADR 0011): its origin and path. A query or
 * fragment does not make another page, and can carry secrets that belong
 * neither in storage keys nor in hello. Text that is not an absolute URL is
 * cut at its first '?' or '#' instead, so it still names one page the same
 * way every time.
 */
export function pageAddress(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/, 1)[0] ?? '';
  }
}

/**
 * Where one record is kept. sessionStorage is shared by every page of the
 * origin in a tab, and one approval covers one page (ADR 0011), so each key
 * names the relay and the page: another page of the site finds none of this
 * page's records and starts its own session. The pair is written as JSON so
 * no two pairs run together, and so no key can match an older adapter's,
 * which named the relay URL alone.
 */
export function storageKey(record: StoredRecord, relayUrl: string, pageUrl: string): string {
  return `tabdock:${record}:${JSON.stringify([relayUrl, pageAddress(pageUrl)])}`;
}

/** A relay URL the core can dial, or a TypeError: retrying a malformed URL forever helps nobody. */
function checkRelayUrl(relayUrl: string): void {
  let protocol = '';
  try {
    protocol = new URL(relayUrl).protocol;
  } catch {
    // Reported below.
  }
  if (protocol !== 'ws:' && protocol !== 'wss:') {
    throw new TypeError('the relay URL must be a ws: or wss: URL');
  }
}

/**
 * Removes what an adapter before ADR 0011 kept under the relay URL alone, for
 * every page of the origin at once. None of it is read, as it may belong to
 * another page; removing it keeps a stale token out of storage. A pause
 * stored there goes too, since it may have been another page's.
 */
function forgetLegacyRecords(storage: StorageLike | undefined, relayUrl: string): void {
  for (const record of STORED_RECORDS) {
    try {
      storage?.removeItem(`tabdock:${record}:${relayUrl}`);
    } catch {
      // Storage that throws holds nothing this page could read either.
    }
  }
}

export function createAdapterCore(options: CoreOptions): AdapterCore {
  checkRelayUrl(options.relayUrl);
  // A bad policy is a page bug; throwing here surfaces it at attach().
  const policy = PolicySchema.parse(options.policy ?? {});
  const pageListedTools = options.policy?.consequentialTools !== undefined;
  const context = options.modelContext;
  const log = options.logger ?? consoleLogger;
  const clock = options.clock ?? (() => Date.now());
  const timers = options.timers ?? defaultTimers;
  const random = options.random ?? Math.random;
  /**
   * Fixed for the life of this core, like its storage keys: an app that
   * changes its path without reloading is still one document with one
   * operator, so it keeps its session (ADR 0011), and the relay, which
   * resumes only a hello naming the same page, must hear the same address.
   */
  const address = pageAddress(options.pageUrl);
  const resumeKey = storageKey('resume', options.relayUrl, options.pageUrl);
  const grantsKey = storageKey('grants', options.relayUrl, options.pageUrl);
  const revokedKey = storageKey('revoked', options.relayUrl, options.pageUrl);
  const pausedKey = storageKey('paused', options.relayUrl, options.pageUrl);
  forgetLegacyRecords(options.storage, options.relayUrl);
  const polyfillMarker: unknown = context && Reflect.get(context, POLYFILL_MARKER);
  /**
   * Under ADR 0001 a call that ends early aborts the signal it handed
   * executeTool, which native WebMCP passes on to the handler. The polyfill
   * only races executeTool against it, so there an abort stops nothing and
   * hides when the handler really ends, which the write queue must know.
   */
  const abortReachesHandlers = polyfillMarker !== true;

  let state: DockState = Object.freeze({
    link: 'idle',
    pageId: null,
    pairing: null,
    roster: [],
    pageRoles: [],
    pendingRequests: [],
    pendingConfirms: [],
    notice: null,
    error: null,
    paused: readPaused(),
    activity: [],
    invites: [],
    invitesOffered: null,
  });
  const listeners = new Set<(state: DockState) => void>();

  let started = false;
  let closed = false;
  let socket: SocketLike | null = null;
  let welcomed = false;
  let attempt = 0;
  let reconnectTimer: unknown = null;
  let watchdogTimer: unknown = null;
  let pollTimer: unknown = null;
  let syncTimer: unknown = null;
  let syncing: Promise<void> | null = null;
  let syncAgain = false;
  let lastToolsKey: string | null = null;
  let lastProblemsKey = '';
  let inputFormat: InputFormat | null = null;
  let frameLimit = MAX_FRAME_BYTES;
  let resultLimit = MAX_RESULT_CHARS;
  let silenceLimit = IDLE_TIMEOUT_MS + SILENCE_GRACE_MS;
  let lock: { release: () => void } | null = null;
  const calls = new Map<string, CallRecord>();
  const requests = new Map<string, RequestRecord>();
  /**
   * The roles the operator granted on this page, by user id: the root of S5's
   * second check. The relay's roster and the role an invoke claims can only
   * lower them, so a relay cannot run a tool for someone nobody approved. An
   * invite-made grant also names its invite and end, which workstream B
   * enforces (ADR 0017); no grant has either until it does.
   */
  const grants = new Map<string, StoredGrant>();
  /** The page session the grants belong to; they mean nothing on another. */
  let grantsPage: string | null = null;
  /**
   * Users the operator revoked whom the relay's roster still lists, because
   * the revoke has not reached it yet (or was made while the link was down).
   * They get nothing, even under autoApprove 'observer', until the roster
   * drops them; a resumed link sends their revoke again. Stored beside the
   * grants, so a reload before the link comes back keeps it too.
   */
  const revoked = new Set<string>();
  /**
   * Writes wait here in arrival order and run one at a time, whatever a relay
   * sends (SPEC section 5): two writes from one relay, or a relay that lost
   * its own queue, must not interleave on the page. Read-only calls skip it.
   */
  const queue: CallRecord[] = [];
  /**
   * The write now holding the page, from its last check until its handler
   * ends. Answering it early (a cancel, deadline, revoke or lost link) does
   * not stop a handler that ignores or never sees its signal, so the page
   * stays held until the runtime settles the call. A handler that never
   * settles is a page bug; pause, revoke and reload still work, and later
   * writes time out at their own deadlines.
   */
  let writing: CallRecord | null = null;
  let nextSeq = 0;

  function setState(patch: Partial<DockState>): void {
    const next = { ...state, ...patch };
    state = Object.freeze({ ...next, pageRoles: rolesFor(next.roster) });
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch (error) {
        log.error(`a state listener threw: ${describe(error)}`);
      }
    }
  }

  // Storage can throw (blocked cookies, sandboxed frames); the link still works without it.
  function readToken(): string | null {
    try {
      return options.storage?.getItem(resumeKey) ?? null;
    } catch {
      return null;
    }
  }

  function writeToken(token: string | null): void {
    try {
      if (token === null) options.storage?.removeItem(resumeKey);
      else options.storage?.setItem(resumeKey, token);
    } catch (error) {
      log.warn(`could not store the resume token: ${describe(error)}`);
    }
  }

  function readStored(key: string): string | null {
    try {
      return options.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  // Grants sit beside the resume token so a reload inside the resume window keeps them.
  function loadGrants(): void {
    const text = readStored(grantsKey);
    const stored = text === null ? null : parseGrants(text);
    if (text !== null && !stored) log.warn('ignored stored grants that did not parse');
    if (stored) {
      grantsPage = stored.pageId;
      for (const [userId, grant] of stored.grants) grants.set(userId, grant);
    }
    // Pending revokes belong to the same page session, which is the only page a
    // record of revokes alone (the user revoked held the last grant) can name.
    const revokedText = readStored(revokedKey);
    const pending = revokedText === null ? null : parseRevoked(revokedText);
    if (revokedText !== null && !pending) log.warn('ignored stored revokes that did not parse');
    if (pending && (grantsPage === null || grantsPage === pending.pageId)) {
      grantsPage = pending.pageId;
      for (const userId of pending.users) revoked.add(userId);
    }
  }

  function writeStored(key: string, value: string | null, what: string): void {
    try {
      if (value === null) options.storage?.removeItem(key);
      else options.storage?.setItem(key, value);
    } catch (error) {
      log.warn(`could not store ${what}: ${describe(error)}`);
    }
  }

  /** Every change to the grants or the pending revokes ends here, so storage and the shown roles always match memory. */
  function saveGrants(): void {
    const page = grantsPage;
    writeStored(
      grantsKey,
      grants.size === 0 || page === null
        ? null
        : JSON.stringify({ pageId: page, grants: Object.fromEntries(grants) }),
      "the operator's grants",
    );
    writeStored(
      revokedKey,
      revoked.size === 0 || page === null
        ? null
        : JSON.stringify({ pageId: page, users: [...revoked] }),
      "the operator's revokes",
    );
    if (JSON.stringify(rolesFor(state.roster)) !== JSON.stringify(state.pageRoles)) setState({});
  }

  /** The operator's approvals and role changes go through here, so storage always matches memory. */
  function setGrant(userId: string, grant: StoredGrant): void {
    grants.set(userId, grant);
    saveGrants();
  }

  /**
   * Withdraws the grants of users who are no longer attached, so coming back
   * takes a fresh approval, as it does on the relay.
   */
  function pruneGrants(userIds: Iterable<string>): void {
    let changed = false;
    for (const userId of userIds) changed = grants.delete(userId) || changed;
    if (changed) saveGrants();
  }

  /** Drops pending revokes the relay has applied, or that an approval has overtaken. */
  function forgetRevokes(userIds: Iterable<string>): void {
    let changed = false;
    for (const userId of userIds) changed = revoked.delete(userId) || changed;
    if (changed) saveGrants();
  }

  function clearGrants(): void {
    grants.clear();
    revoked.clear();
    grantsPage = null;
    saveGrants();
  }

  loadGrants();

  /**
   * The pause sits beside the grants so a reload does not quietly resume a
   * paused page. It is not tied to a page session: only the operator lifts
   * it. Any stored value reads as paused, so a damaged entry fails safe.
   */
  function readPaused(): boolean {
    try {
      return (options.storage?.getItem(pausedKey) ?? null) !== null;
    } catch {
      return false;
    }
  }

  function writePaused(paused: boolean): void {
    try {
      if (paused) options.storage?.setItem(pausedKey, 'true');
      else options.storage?.removeItem(pausedKey);
    } catch (error) {
      log.warn(`could not store the pause: ${describe(error)}`);
    }
  }

  /**
   * S5, second check: the least privileged of the operator's grant, the
   * relay's roster and the role the invoke claims. null means nobody approved
   * this caller on this page, or the relay no longer lists them as attached:
   * the relay sends the roster before any call it routes, so a caller missing
   * from it is one whose attachment ended, whatever grant is left. Under
   * autoApprove 'observer' the relay attaches people without asking (S4), so
   * a caller it lists counts as an observer.
   */
  function callerRole(caller: Caller): Role | null {
    const listed = state.roster.find((attachment) => attachment.userId === caller.userId)?.role;
    if (listed === undefined) return null;
    const role = pageRole(caller.userId, listed);
    if (role === null) return null;
    return caller.role === 'observer' ? 'observer' : role;
  }

  /** callerRole before the invoke's own claim, for a user the roster lists as `listed`. */
  function pageRole(userId: string, listed: Role): Role | null {
    if (revoked.has(userId)) return null;
    const granted =
      grants.get(userId)?.role ?? (policy.autoApprove === 'observer' ? 'observer' : undefined);
    if (granted === undefined) return null;
    return granted === 'observer' || listed === 'observer' ? 'observer' : 'driver';
  }

  function rolesFor(roster: readonly AttachmentView[]): PageRole[] {
    return roster.map(({ userId, role }) =>
      Object.freeze({ userId, role: pageRole(userId, role), revoked: revoked.has(userId) }),
    );
  }

  function send(frame: PageFrameInput): boolean {
    const sock = socket;
    if (sock?.readyState !== OPEN) return false;
    const checked = PageFrameSchema.safeParse(frame);
    if (!checked.success) {
      const where = checked.error.issues.map((issue) => issue.path.join('.')).join(', ');
      log.error(`not sending an invalid ${frame.t} frame (${where})`);
      return false;
    }
    const text = encodeFrame(frame);
    const size = byteLength(text);
    if (size > frameLimit) {
      log.error(
        `not sending a ${frame.t} frame of ${size} bytes, over the ${frameLimit} byte limit`,
      );
      return false;
    }
    try {
      sock.send(text);
      return true;
    } catch (error) {
      log.warn(`could not send a ${frame.t} frame: ${describe(error)}`);
      return false;
    }
  }

  function isLinked(): boolean {
    return welcomed && socket !== null && !closed;
  }

  // Connection lifecycle

  function connect(): void {
    reconnectTimer = null;
    if (closed) return;
    if (state.link === 'idle') setState({ link: 'connecting' });
    let sock: SocketLike;
    try {
      sock = options.socketFactory(options.relayUrl, [SUBPROTOCOL]);
    } catch (error) {
      log.warn(`could not open a socket to the relay: ${describe(error)}`);
      scheduleReconnect();
      return;
    }
    socket = sock;
    welcomed = false;
    // Covers a handshake that never completes as well as a relay that goes quiet.
    armWatchdog();
    sock.onopen = () => {
      if (sock === socket) onOpen();
    };
    sock.onmessage = (event) => {
      if (sock === socket) onMessage(event.data);
    };
    sock.onclose = (event) => {
      if (sock === socket) onClose(event.code, event.reason);
    };
    // Errors are always followed by close, which is where reconnecting happens.
    sock.onerror = () => undefined;
  }

  function detach(sock: SocketLike): void {
    sock.onopen = null;
    sock.onmessage = null;
    sock.onclose = null;
    // Stays a function: a `ws` client with no error listener crashes Node on a late error.
    sock.onerror = () => undefined;
  }

  function closeSocket(sock: SocketLike, code: number, reason: string): void {
    detach(sock);
    try {
      sock.close(code, reason);
      return;
    } catch {
      // Browsers only let page code send 1000 or 3000 to 4999.
    }
    try {
      sock.close(code === CLOSE_INVALID_FRAME ? CLOSE_INVALID_FRAME_PAGE : 1000, reason);
    } catch {
      // Already closing.
    }
  }

  function onOpen(): void {
    const token = readToken();
    const page = options.pageInfo();
    armWatchdog();
    send({
      t: 'hello',
      v: PROTOCOL_VERSION,
      ...(token === null ? {} : { resumeToken: token }),
      title: page.title.slice(0, 300),
      url: address.slice(0, 2048),
      adapterVersion: options.adapterVersion.slice(0, 50),
      policy,
    });
  }

  function onMessage(data: unknown): void {
    armWatchdog();
    if (typeof data !== 'string') {
      protocolError('a binary frame');
      return;
    }
    // The cap is in bytes; a string's length counts UTF-16 code units, which undercounts.
    if (overByteLimit(data, MAX_FRAME_BYTES)) {
      protocolError('an oversized frame');
      return;
    }
    const parsed = parseRelayFrame(data);
    if (parsed.kind === 'unknown') {
      log.info(`ignored a relay frame of unknown type ${JSON.stringify(parsed.type)}`);
      return;
    }
    if (parsed.kind === 'invalid') {
      protocolError(parsed.reason);
      return;
    }
    onFrame(parsed.frame);
  }

  function protocolError(reason: string): void {
    log.warn(`the relay sent ${reason}; reconnecting`);
    dropLink(CLOSE_INVALID_FRAME, 'invalid frame');
  }

  function onFrame(frame: RelayFrame): void {
    if (frame.t === 'ping') {
      send({ t: 'pong' });
      return;
    }
    if (frame.t === 'pong') return;
    if (frame.t === 'welcome') {
      onWelcome(frame);
      return;
    }
    if (!welcomed) {
      log.warn(`ignored a ${frame.t} frame that arrived before welcome`);
      return;
    }
    switch (frame.t) {
      case 'attach_request':
        onAttachRequest(frame);
        return;
      case 'roster':
        onRoster(frame.attachments);
        return;
      case 'pairing':
        setState({
          pairing: {
            code: frame.code,
            expiresAt: frame.expiresAt,
            ...(frame.url === undefined ? {} : { url: frame.url }),
          },
        });
        return;
      case 'invites':
        // Workstream B shows these and mints against linkBase (ADR 0017). A
        // relay sends them only once invites are on, which none is yet.
        return;
      case 'invoke':
        onInvoke(frame);
        return;
      case 'cancel':
        onCancel(frame.callId);
        return;
    }
  }

  function onWelcome(frame: WelcomeFrame): void {
    if (welcomed) {
      log.warn('ignored a second welcome on the same link');
      return;
    }
    welcomed = true;
    attempt = 0;
    writeToken(frame.resumeToken);
    // A new session, or a different page, starts with nobody approved. A
    // resumed one keeps the grants of users the relay still lists; the relay
    // drops attach requests when a link ends, so no approval is in flight here.
    const listed = new Set(frame.roster.map((attachment) => attachment.userId));
    const samePage = frame.resumed && grantsPage === frame.pageId;
    for (const userId of [...grants.keys()]) {
      if (!samePage || !listed.has(userId)) grants.delete(userId);
    }
    // A revoke the relay never applied (stored, if the page reloaded since) is
    // sent again below; on a new session it has nothing to end.
    for (const userId of [...revoked]) {
      if (!samePage || !listed.has(userId)) revoked.delete(userId);
    }
    grantsPage = frame.pageId;
    saveGrants();
    frameLimit = Math.max(MIN_FRAME_BYTES, Math.min(MAX_FRAME_BYTES, frame.limits.maxFrameBytes));
    resultLimit = Math.max(
      MARKER_ROOM * 2,
      Math.min(MAX_RESULT_CHARS, frame.limits.maxResultChars),
    );
    // Never shorter than the protocol's own: a tiny value would turn the watchdog into a reconnect loop.
    silenceLimit = Math.max(IDLE_TIMEOUT_MS, frame.limits.idleTimeoutMs) + SILENCE_GRACE_MS;
    armWatchdog();
    setState({
      link: 'linked',
      pageId: frame.pageId,
      pairing: frame.pairing,
      roster: frame.roster,
      error: null,
    });
    log.info(frame.resumed ? `resumed page ${frame.pageId}` : `linked as page ${frame.pageId}`);
    for (const userId of revoked) send({ t: 'revoke', userId });
    takeLock(frame.pageId);
    lastToolsKey = null;
    void syncTools();
    schedulePoll();
  }

  /**
   * Users the previous roster listed and this one leaves out have detached or
   * been revoked, so their grants go (stored ones too). Users it never listed
   * keep theirs: a roster sent for another reason can cross an approval the
   * relay has not applied yet, and callerRole refuses them until it does.
   */
  function onRoster(attachments: readonly AttachmentView[]): void {
    const listed = new Set(attachments.map((attachment) => attachment.userId));
    pruneGrants(
      state.roster.map((attachment) => attachment.userId).filter((userId) => !listed.has(userId)),
    );
    // The relay has applied a revoke once it stops listing the user.
    forgetRevokes([...revoked].filter((userId) => !listed.has(userId)));
    setState({ roster: attachments });
  }

  function onClose(code: number, reason: string): void {
    const sock = socket;
    if (sock) detach(sock);
    socket = null;
    tearDownLink();
    if (closed) return;
    if (code === CLOSE_REPLACED) {
      stopForGood('Another connection took over this page (close code 4001), so this tab stopped.');
      log.warn('the relay replaced this link with a newer one; not reconnecting');
      return;
    }
    log.info(`the relay link closed (${code}${reason ? ` ${reason.slice(0, 100)}` : ''})`);
    scheduleReconnect();
  }

  /** Ends the current link from this side and tries again later. */
  function dropLink(code: number, reason: string): void {
    const sock = socket;
    if (!sock) return;
    socket = null;
    closeSocket(sock, code, reason);
    tearDownLink();
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer !== null) return;
    const delay = backoffDelay(attempt, random);
    attempt += 1;
    if (state.link !== 'reconnecting') setState({ link: 'reconnecting' });
    reconnectTimer = timers.setTimeout(connect, delay);
  }

  function armWatchdog(): void {
    timers.clearTimeout(watchdogTimer);
    watchdogTimer = timers.setTimeout(() => {
      watchdogTimer = null;
      log.warn('heard nothing from the relay for too long; reconnecting');
      dropLink(CLOSE_SILENT, 'relay silent');
    }, silenceLimit);
  }

  /** Everything tied to one socket ends with it; the relay answers waiting callers itself. */
  function tearDownLink(): void {
    welcomed = false;
    for (const handle of [watchdogTimer, pollTimer, syncTimer]) timers.clearTimeout(handle);
    watchdogTimer = null;
    pollTimer = null;
    syncTimer = null;
    releaseLock();
    for (const call of [...calls.values()]) abandon(call, 'link lost');
    for (const record of requests.values()) {
      timers.clearTimeout(record.timer);
      record.port.abort();
    }
    requests.clear();
    setState({ pairing: null, pendingRequests: [], pendingConfirms: [] });
  }

  function stopForGood(error: string | null): void {
    closed = true;
    timers.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    context?.removeEventListener('toolchange', onToolChange);
    setState({ link: 'closed', error });
  }

  // Web Lock: held while linked.

  function takeLock(pageId: string): void {
    const locks = options.locks;
    if (!locks || lock) return;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    lock = { release };
    locks
      .request(`${LOCK_PREFIX}${pageId}`, () => held)
      .catch((error: unknown) => {
        log.warn(`could not hold a Web Lock: ${describe(error)}`);
      });
  }

  function releaseLock(): void {
    lock?.release();
    lock = null;
  }

  // Tool sync

  function onToolChange(): void {
    if (syncTimer !== null) return;
    syncTimer = timers.setTimeout(() => {
      syncTimer = null;
      void syncTools();
    }, TOOLCHANGE_DEBOUNCE_MS);
  }

  function schedulePoll(): void {
    pollTimer = timers.setTimeout(() => {
      pollTimer = null;
      if (!isLinked()) return;
      void syncTools();
      schedulePoll();
    }, TOOL_POLL_MS);
  }

  // A function, not an inline test: the flag changes while syncOnce awaits.
  function shouldSyncAgain(): boolean {
    return syncAgain && !closed;
  }

  /** One sync at a time; a request during a sync runs one more afterwards. */
  function syncTools(): Promise<void> {
    if (syncing) {
      syncAgain = true;
      return syncing;
    }
    syncing = (async () => {
      do {
        syncAgain = false;
        await syncOnce();
      } while (shouldSyncAgain());
    })().finally(() => {
      syncing = null;
    });
    return syncing;
  }

  async function readTools(): Promise<ToolSnapshot | null> {
    if (!context) return null;
    let list: readonly RuntimeTool[];
    try {
      const value = await context.getTools();
      list = Array.isArray(value) ? value : [];
    } catch (error) {
      log.warn(`getTools() failed: ${describe(error)}`);
      return null;
    }
    const snapshot = normaliseTools(list, options.ownWindow);
    const problemsKey = snapshot.problems.join('\n');
    if (problemsKey !== lastProblemsKey) {
      lastProblemsKey = problemsKey;
      for (const problem of snapshot.problems) log.warn(problem);
    }
    const notice = needsHintNotice(snapshot.hintSupport, policy, pageListedTools)
      ? HINT_NOTICE
      : null;
    if (notice !== state.notice) setState({ notice });
    return snapshot;
  }

  async function syncOnce(): Promise<void> {
    if (!isLinked()) return;
    const snapshot = await readTools();
    if (!isLinked()) return;
    if (!snapshot) {
      // The relay holds a resumed page's calls until its first tools frame, so
      // a page that cannot read its tools says it has none rather than nothing;
      // the next poll that reads them sends the real list.
      if (lastToolsKey === null && send({ t: 'tools', tools: [] })) lastToolsKey = '[]';
      return;
    }
    const tools = fitTools(snapshot.tools.map((tool) => tool.page));
    const key = JSON.stringify(tools);
    if (key === lastToolsKey) return;
    if (send({ t: 'tools', tools })) lastToolsKey = key;
  }

  /** Drops tools from the end until the frame fits; only a page with huge schemas gets here. */
  function fitTools(tools: PageTool[]): PageTool[] {
    let fitted = tools;
    while (
      fitted.length > 0 &&
      byteLength(encodeFrame({ t: 'tools', tools: fitted })) > frameLimit
    ) {
      fitted = fitted.slice(0, -1);
    }
    if (fitted.length < tools.length) {
      log.warn(`shared ${fitted.length} of ${tools.length} tools to stay under the frame limit`);
    }
    return fitted;
  }

  // Calls

  function onInvoke(frame: InvokeFrame): void {
    // A write answered early still holds the page under its id until its
    // handler ends; a relay reusing that id meanwhile is confused about which
    // call it means, so the page takes no second call by it.
    if (calls.has(frame.callId) || writing?.frame.callId === frame.callId) {
      log.warn(`ignored a repeated invoke for call ${frame.callId}`);
      return;
    }
    const now = clock();
    const { userId, displayName, client } = frame.caller;
    const entry: ActivityEntry = Object.freeze({
      callId: frame.callId,
      time: now,
      user: Object.freeze({ userId, displayName }),
      client: client === null ? null : Object.freeze({ ...client }),
      tool: frame.tool,
      outcome: 'running',
      durationMs: null,
      handlerRunning: false,
    });
    const call: CallRecord = {
      frame,
      seq: nextSeq++,
      deadlineAt: now + frame.deadlineMs,
      controller: new AbortController(),
      entry,
      stage: 'admitting',
      finished: false,
      executing: false,
      deadline: null,
      confirm: null,
    };
    calls.set(frame.callId, call);
    setState({ activity: [entry, ...state.activity].slice(0, ACTIVITY_LIMIT) });
    call.deadline = timers.setTimeout(() => {
      onDeadline(call);
    }, frame.deadlineMs);
    if (state.paused) {
      finish(call, PAUSED);
      return;
    }
    void admit(call);
  }

  function onDeadline(call: CallRecord): void {
    if (call.finished) return;
    if (call.confirm) {
      // S6: an unanswered confirmation is a denial, not a timeout.
      finish(call, {
        ok: false,
        code: 'denied_by_operator',
        message: 'the operator did not confirm in time',
      });
      return;
    }
    call.controller.abort();
    finish(call, { ok: false, code: 'timeout', message: 'the page did not answer in time' });
  }

  function onCancel(callId: string): void {
    const call = calls.get(callId);
    if (!call) return;
    call.controller.abort();
    finish(call, { ok: false, code: 'cancelled', message: 'the call was cancelled' });
  }

  /** S7 attribution; never the arguments, the result or the error text. */
  function logCall(call: CallRecord, outcome: string): void {
    const { caller, tool, callId } = call.frame;
    log.info(`call ${callId} ${tool} by ${caller.displayName} (${caller.role}): ${outcome}`);
  }

  function updateEntry(call: CallRecord, patch: Partial<ActivityEntry>): void {
    const index = state.activity.indexOf(call.entry);
    // Gone when fifty newer calls have pushed it out.
    if (index === -1) return;
    const activity = [...state.activity];
    call.entry = Object.freeze({ ...call.entry, ...patch });
    activity[index] = call.entry;
    setState({ activity });
  }

  /** Replaces the call's running line in the activity log with how it ended. */
  function settleEntry(call: CallRecord, outcome: ActivityOutcome): void {
    updateEntry(call, {
      outcome,
      durationMs: Math.max(0, clock() - call.entry.time),
      handlerRunning: call.executing,
    });
  }

  /**
   * Takes a settled call off the books and lets the next write have the
   * page, unless its handler is still running; proceed calls this again once
   * the runtime settles it.
   */
  function release(call: CallRecord): void {
    // The second release, when a lingering handler ends, may find a newer
    // call under the same id, which revoke, cancel and pause must still reach.
    if (calls.get(call.frame.callId) === call) calls.delete(call.frame.callId);
    const queued = queue.indexOf(call);
    if (queued !== -1) queue.splice(queued, 1);
    if (writing === call && !call.executing) writing = null;
    pump();
  }

  /**
   * Ends a call on this side without a result frame: the relay answers its
   * caller from how the link ended (page_asleep, or page_gone after
   * CLOSE_DETACH). The handler's signal aborts and any late result is dropped.
   */
  function abandon(call: CallRecord, why: string): void {
    if (call.finished) return;
    call.finished = true;
    timers.clearTimeout(call.deadline);
    call.controller.abort();
    settleConfirmPromise(call, false);
    logCall(call, why);
    // The log's outcomes are the page's own, and from here the call was cancelled.
    settleEntry(call, 'cancelled');
    release(call);
  }

  function finish(call: CallRecord, outcome: Outcome): void {
    if (call.finished) return;
    call.finished = true;
    timers.clearTimeout(call.deadline);
    settleConfirmPromise(call, false);
    const { callId } = call.frame;
    logCall(call, outcome.ok ? 'ok' : outcome.code);
    if (outcome.ok) {
      send(resultFrame(callId, outcome.content));
    } else {
      send({
        t: 'result',
        callId,
        ok: false,
        error: { code: outcome.code, message: outcome.message.slice(0, MAX_ERROR_CHARS) },
      });
    }
    settleEntry(call, outcome.ok ? 'ok' : outcome.code);
    release(call);
  }

  /** Cuts the text to the result limit, then further if JSON escaping or UTF-8 still overflow the frame. */
  function resultFrame(callId: string, content: string): PageFrameInput {
    let max = content.length > resultLimit ? resultLimit - MARKER_ROOM : content.length;
    for (;;) {
      const text = max >= content.length ? content : truncate(content, max).text;
      const frame = { t: 'result', callId, ok: true, content: text } as const;
      const size = byteLength(encodeFrame(frame));
      if (size <= frameLimit || max === 0) return frame;
      max = Math.floor(Math.min(max, content.length) * (frameLimit / size) * 0.9);
    }
  }

  // A function, not an inline test: a cancel or deadline can finish the call while an await is pending.
  function isDone(call: CallRecord): boolean {
    return call.finished;
  }

  /**
   * S5, second check: the caller's role on this page, then the tool. It runs
   * when a call arrives and again when a write reaches the front of the
   * queue, since the roster, the grants and the tools may have changed while
   * it waited.
   */
  function check(frame: InvokeFrame, snapshot: ToolSnapshot | null): Checked {
    const role = callerRole(frame.caller);
    if (role === null) {
      return refuse('role_denied', 'the operator has not approved this caller on this page');
    }
    if (!snapshot) return refuse('tool_error', 'the page could not list its tools');
    const tool = snapshot.byName.get(frame.tool);
    if (!tool) return refuse('tool_not_found', `no tool named ${frame.tool}`);
    if (role === 'observer' && !isReadOnly(tool.page)) {
      return refuse('role_denied', 'observers may only run read-only tools');
    }
    return { ok: true, tool };
  }

  /**
   * Reads the tools to learn whether the call writes. A refusal goes back at
   * once, so nobody waits in the queue only to be turned away; a read runs
   * now, beside whatever else is running; a write joins the queue.
   */
  async function admit(call: CallRecord): Promise<void> {
    const snapshot = await readTools();
    if (isDone(call)) return;
    const checked = check(call.frame, snapshot);
    if (!checked.ok) {
      finish(call, checked.refusal);
      return;
    }
    if (snapshot && isReadOnly(checked.tool.page)) {
      call.stage = 'checking';
      // This call may be the earlier arrival a queued write was waiting on.
      pump();
      await proceed(call, checked.tool, snapshot);
      return;
    }
    if (queue.length >= MAX_WAITING_WRITES) {
      finish(call, {
        ok: false,
        code: 'page_busy',
        message: 'too many writes are already waiting on this page',
      });
      return;
    }
    call.stage = 'queued';
    const later = queue.findIndex((other) => other.seq > call.seq);
    if (later === -1) queue.push(call);
    else queue.splice(later, 0, call);
    pump();
  }

  /** Gives the page to the oldest queued write once nothing else is writing. */
  function pump(): void {
    // A pause answers every queued write itself, so none should start meanwhile.
    if (writing !== null || state.paused || !isLinked()) return;
    const next = queue[0];
    if (!next) return;
    // An earlier arrival still reading the tool list may turn out to be a write that goes first.
    for (const call of calls.values()) {
      if (call.stage === 'admitting' && call.seq < next.seq) return;
    }
    queue.shift();
    writing = next;
    next.stage = 'checking';
    void runWrite(next);
  }

  async function runWrite(call: CallRecord): Promise<void> {
    const snapshot = await readTools();
    if (isDone(call)) return;
    const checked = check(call.frame, snapshot);
    if (!checked.ok) {
      finish(call, checked.refusal);
      return;
    }
    // check() refuses a missing snapshot, so this only narrows the type.
    if (snapshot) await proceed(call, checked.tool, snapshot);
  }

  /** Consequential policy and the operator's confirmation, then the handler. */
  async function proceed(
    call: CallRecord,
    tool: NormalisedTool,
    snapshot: ToolSnapshot,
  ): Promise<void> {
    const { frame } = call;
    if (isConsequential(tool.page, snapshot.hintSupport, policy, pageListedTools)) {
      if (policy.consequential === 'deny') {
        finish(call, {
          ok: false,
          code: 'denied_by_operator',
          message: 'this page does not run consequential tools',
        });
        return;
      }
      if (policy.consequential === 'confirm') {
        const allowed = await askConfirm(call);
        if (isDone(call)) return;
        if (!allowed) {
          finish(call, {
            ok: false,
            code: 'denied_by_operator',
            message: 'the operator denied this call',
          });
          return;
        }
        // The operator may have lowered this caller's role while the prompt was up.
        const again = check(frame, snapshot);
        if (!again.ok) {
          finish(call, again.refusal);
          return;
        }
      }
    }
    call.stage = 'running';
    call.executing = true;
    let outcome: Outcome;
    let unwatched = false;
    try {
      const value = await execute(tool.runtime, frame.arguments, call);
      outcome = { ok: true, content: resultText(value) };
    } catch (error) {
      outcome = { ok: false, code: 'tool_error', message: errorParts(error).message };
      unwatched = await lostSightOfHandler(call, tool, error);
    }
    if (unwatched) {
      holdUnwatched(call);
      // The relay still hears the runtime's answer, unless something answered first.
      if (!isDone(call)) finish(call, outcome);
      return;
    }
    call.executing = false;
    if (isDone(call)) {
      // Something answered first and whatever the runtime says now is
      // dropped, but only now has the handler let go of the page.
      if (call.entry.handlerRunning) updateEntry(call, { handlerRunning: false });
      release(call);
      return;
    }
    finish(call, outcome);
  }

  /**
   * Whether a write's rejection says only that the runtime stopped watching a
   * handler that may still be running. On the polyfill a write's executeTool
   * gets a signal nothing aborts, so it settles early only when the page ends
   * the tool's registration mid-run: its 'Tool unregistered', or, should
   * that text change, a tool missing from the list afterwards. A tool
   * already missing when the call started never ran its handler.
   */
  async function lostSightOfHandler(
    call: CallRecord,
    tool: NormalisedTool,
    error: unknown,
  ): Promise<boolean> {
    if (abortReachesHandlers || writing !== call) return false;
    const { name, message } = errorParts(error);
    if (name === 'UnknownError' && message === POLYFILL_UNREGISTERED) return true;
    if (name === 'UnknownError' && POLYFILL_NOT_FOUND.test(message)) return false;
    // A list that cannot be read cannot show the tool is still there either.
    const snapshot = await readTools();
    return snapshot === null || !snapshot.byName.has(tool.page.name);
  }

  /**
   * Keeps the page for a write whose handler the runtime no longer watches.
   * Nothing will say when that handler ends (the polyfill neither hands it
   * a signal nor reports its end), so time is the only bound there is: the
   * call's deadline plus a grace, or a grace from now when the handler has
   * already outrun its deadline. Then the next write may start, possibly
   * beside it.
   */
  function holdUnwatched(call: CallRecord): void {
    const until = Math.max(call.deadlineAt, clock()) + UNWATCHED_HANDLER_GRACE_MS;
    timers.setTimeout(() => {
      call.executing = false;
      if (call.entry.handlerRunning) updateEntry(call, { handlerRunning: false });
      log.warn(
        `call ${call.frame.callId}: stopped waiting for a handler whose tool was unregistered while it ran`,
      );
      release(call);
    }, until - clock());
  }

  /**
   * ADR 0001: the input form flipped between Chrome 154 and 155, and the
   * polyfill 5.1 takes a string. Try the remembered form (an object at first)
   * and switch once when the runtime rejects it for its form; such a rejection
   * comes before the handler runs, so the retry cannot run it twice.
   */
  async function execute(
    tool: RuntimeTool,
    args: Record<string, unknown>,
    call: CallRecord,
  ): Promise<unknown> {
    if (!context?.executeTool) throw new Error('this WebMCP runtime has no executeTool');
    // A write on the polyfill gets a signal nothing aborts, so the runtime
    // settles it when the handler ends and the page stays held until then.
    const signal =
      writing === call && !abortReachesHandlers
        ? new AbortController().signal
        : call.controller.signal;
    const run = (format: InputFormat): Promise<unknown> =>
      context.executeTool
        ? context.executeTool(tool, format === 'string' ? JSON.stringify(args) : args, {
            signal,
          })
        : Promise.reject(new Error('this WebMCP runtime has no executeTool'));
    const first = inputFormat ?? 'object';
    try {
      const value = await run(first);
      inputFormat ??= first;
      return value;
    } catch (error) {
      const other = call.controller.signal.aborted ? null : otherInputFormat(error, first);
      if (other === null) throw error;
      inputFormat = other;
      log.info(
        `this runtime takes executeTool input as ${other === 'string' ? 'a JSON string' : 'an object'}`,
      );
      return run(other);
    }
  }

  function askConfirm(call: CallRecord): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const { callId, tool, caller } = call.frame;
      const pending: PendingConfirm = Object.freeze({
        callId,
        tool,
        caller,
        expiresAt: call.deadlineAt,
      });
      const port = new AbortController();
      call.confirm = { resolve, port };
      setState({ pendingConfirms: [...state.pendingConfirms, pending] });
      const ui = options.ui;
      if (!ui?.askConfirm) return;
      Promise.resolve()
        .then(() => ui.askConfirm?.(pending, port.signal))
        .then(
          (answer) => {
            if (typeof answer === 'boolean') confirmCall(callId, answer);
          },
          (error: unknown) => {
            log.warn(`the UI port failed to ask for a confirmation: ${describe(error)}`);
          },
        );
    });
  }

  function settleConfirmPromise(call: CallRecord, allow: boolean): void {
    const confirm = call.confirm;
    if (!confirm) return;
    call.confirm = null;
    confirm.port.abort();
    setState({
      pendingConfirms: state.pendingConfirms.filter((item) => item.callId !== call.frame.callId),
    });
    confirm.resolve(allow);
  }

  function confirmCall(callId: string, allow: boolean): boolean {
    const call = calls.get(callId);
    if (!call?.confirm || call.finished) return false;
    settleConfirmPromise(call, allow);
    return true;
  }

  // Attach requests

  function onAttachRequest(frame: AttachRequestFrame): void {
    if (requests.has(frame.requestId)) return;
    const now = clock();
    // The relay's clock may differ from this one; never wait longer than a request can live.
    const expiresAt = Math.min(frame.expiresAt, now + ATTACH_REQUEST_TTL_MS);
    const request: PendingRequest = Object.freeze({
      requestId: frame.requestId,
      user: frame.user,
      account: frame.account,
      via: frame.via,
      // Never the secret: workstream B checks it against this page's own record, and no state shows it (ADR 0017).
      invite:
        frame.invite === undefined
          ? null
          : { inviteId: frame.invite.inviteId, label: frame.invite.label },
      client: frame.client,
      expiresAt,
    });
    const port = new AbortController();
    const timer = timers.setTimeout(
      () => {
        decide(frame.requestId, false);
      },
      Math.max(0, expiresAt - now),
    );
    requests.set(frame.requestId, { request, timer, port });
    setState({ pendingRequests: [...state.pendingRequests, request] });
    log.info(`attach request from ${frame.user.displayName} via ${frame.via}`);
    const ui = options.ui;
    if (!ui?.askAttach) return;
    Promise.resolve()
      .then(() => ui.askAttach?.(request, port.signal))
      .then(
        (answer) => {
          if (answer === 'deny') decide(frame.requestId, false);
          else if (answer !== undefined) decide(frame.requestId, true, answer);
        },
        (error: unknown) => {
          log.warn(`the UI port failed to ask about an attach request: ${describe(error)}`);
        },
      );
  }

  function decide(requestId: string, allow: boolean, role?: Role): boolean {
    const record = requests.get(requestId);
    if (!record) return false;
    if (allow && !RoleSchema.safeParse(role).success) {
      log.warn('ignored an approval without a valid role');
      return false;
    }
    requests.delete(requestId);
    timers.clearTimeout(record.timer);
    record.port.abort();
    setState({
      pendingRequests: state.pendingRequests.filter((item) => item.requestId !== requestId),
    });
    // The first approval wins, as on the relay, which keeps an existing
    // attachment as it is (role changes are set_role's job, from M2). It wins
    // only while the roster lists the user: a grant for a user the relay never
    // attached came from an approval it ignored (one that crossed the request's
    // expiry), so this decision is the one the relay will apply. For a listed
    // user a denial, or silence, answers only this request and leaves the
    // grant alone, since the relay keeps them attached (ADR 0007); withdrawing
    // access is revoke's job. For anyone else it withdraws that ignored grant,
    // so the operator's latest decision stands.
    const { userId } = record.request.user;
    const listed = state.roster.some((attachment) => attachment.userId === userId);
    // An approval after a revoke lets the user back in; the relay applies the two in that order too.
    if (allow) forgetRevokes([userId]);
    if (allow && role !== undefined && (!listed || !grants.has(userId))) {
      setGrant(userId, { role });
    }
    if (!allow && !listed) pruneGrants([userId]);
    const who = record.request.user.displayName;
    log.info(allow ? `allowed ${who} as ${String(role)}` : `denied ${who}`);
    return send({
      t: 'attach_decision',
      requestId,
      allow,
      ...(allow && role !== undefined ? { role } : {}),
    });
  }

  // Operator controls

  /**
   * The operator's own decision, so it becomes the grant before the frame
   * goes out: a demotion holds on the page at once, even if the relay is slow
   * to apply it or never does, and a promotion takes effect once the relay's
   * roster agrees (it may refuse a driver over maxDrivers).
   */
  function setRole(userId: string, role: Role): boolean {
    if (!RoleSchema.safeParse(role).success) {
      log.warn('ignored a role change without a valid role');
      return false;
    }
    const attachment = state.roster.find((entry) => entry.userId === userId);
    if (!attachment || revoked.has(userId) || !isLinked()) return false;
    // Only for someone the operator approved here, or autoApprove let in (S4):
    // otherwise even Make observer would be the approval S4 asks for, made by
    // a click meant to lower access. Revoke is what such a row needs.
    if (!grants.has(userId) && policy.autoApprove !== 'observer') return false;
    // A role change keeps whatever else the grant names, such as the invite that made it.
    setGrant(userId, { ...grants.get(userId), role });
    log.info(`set ${attachment.displayName} to ${role}`);
    return send({ t: 'set_role', userId, role });
  }

  /**
   * S8 on the page's side: the grant goes at once (stored copy too), so no
   * call of theirs runs here again whatever the relay does next. The revoke
   * frame goes first, so the relay answers their calls with not_attached
   * before any result below reaches it; their pending requests and prompts
   * are denied, and their calls in flight are cancelled.
   */
  function revoke(target: string): boolean {
    const everyone = target === '*';
    if (closed || (!everyone && !IdSchema.safeParse(target).success)) return false;
    const hits = (userId: string): boolean => everyone || userId === target;
    const listed = state.roster.map((attachment) => attachment.userId).filter(hits);
    const granted = [...grants.keys()].filter(hits);
    const asking = [...requests.values()].filter((record) => hits(record.request.user.userId));
    const running = [...calls.values()].filter((call) => hits(call.frame.caller.userId));
    if (listed.length + granted.length + asking.length + running.length === 0) return false;
    for (const userId of listed) revoked.add(userId);
    for (const userId of granted) grants.delete(userId);
    saveGrants();
    log.info(everyone ? 'the operator revoked everyone' : `the operator revoked ${target}`);
    // While the link is down, the next welcome sends it for anyone still listed.
    if (isLinked()) send({ t: 'revoke', userId: target });
    for (const record of asking) decide(record.request.requestId, false);
    for (const call of running) {
      if (call.confirm) {
        finish(call, { ok: false, code: 'denied_by_operator', message: REVOKED_MESSAGE });
      } else {
        call.controller.abort();
        finish(call, { ok: false, code: 'cancelled', message: REVOKED_MESSAGE });
      }
    }
    return true;
  }

  /**
   * Whether these options name an invite this page could mint: a label, a
   * role, a known lifetime, and uses only a Can watch invite may have more
   * than one of. Checked at run time, since a page script can pass anything.
   */
  function validInvite(options: InviteOptions): boolean {
    const uses: unknown = options.uses;
    const lifetime: unknown = options.lifetime;
    return (
      InviteLabelSchema.safeParse(options.label).success &&
      RoleSchema.safeParse(options.role).success &&
      (lifetime === undefined || INVITE_LIFETIMES.some((known) => known === lifetime)) &&
      (uses === undefined ||
        (typeof uses === 'number' &&
          Number.isInteger(uses) &&
          uses >= 1 &&
          uses <= (options.role === 'driver' ? CONTROL_INVITE_USES : MAX_INVITE_USES)))
    );
  }

  function invite(options: InviteOptions): Promise<InviteResult> {
    const refuse = (reason: InviteRefusal): Promise<InviteResult> =>
      Promise.resolve(Object.freeze({ ok: false, reason }));
    if (typeof options !== 'object' || !validInvite(options)) return refuse('invalid');
    // ADR 0016: watch by default, so Can control needs a page that opted into 'all'.
    if (policy.invites === 'off' || (options.role === 'driver' && policy.invites !== 'all')) {
      return refuse('policy');
    }
    if (!isLinked()) return refuse('link_down');
    // Workstream B mints from here once a relay offers invites with its
    // invites frame (ADR 0017); none does before workstream A.
    return refuse('unavailable');
  }

  /**
   * Closes the link of an invite this page lists. Workstream B also drops it
   * from the page's own record (ADR 0017); until a relay offers invites the
   * page lists none, so this finds nothing.
   */
  function cancelInvite(inviteId: string): boolean {
    if (closed || !state.invites.some((view) => view.inviteId === inviteId)) return false;
    return isLinked() && send({ t: 'invite_cancel', inviteId });
  }

  /** Calls already in the page's hands finish; every other call, now or later, is answered page_busy. */
  function pause(paused: boolean): void {
    writePaused(paused);
    if (paused === state.paused) return;
    setState({ paused });
    log.info(paused ? 'the operator paused calls' : 'the operator resumed calls');
    if (!paused) {
      pump();
      return;
    }
    for (const call of [...calls.values()]) {
      if (call.stage !== 'running') finish(call, PAUSED);
    }
  }

  // Public surface

  function start(): void {
    if (started || closed) return;
    started = true;
    if (!context) {
      log.error(POLYFILL_HINT);
      setState({ error: POLYFILL_HINT });
      return;
    }
    context.addEventListener('toolchange', onToolChange);
    connect();
  }

  function close(mode: CloseMode = 'detach'): void {
    if (closed) return;
    if (mode === 'detach' && isLinked()) {
      for (const requestId of [...requests.keys()]) decide(requestId, false);
      for (const call of [...calls.values()]) {
        // S6: a prompt left unanswered is a denial.
        if (call.confirm) {
          finish(call, {
            ok: false,
            code: 'denied_by_operator',
            message: 'the page detached',
          });
        } else {
          // No result: closing with CLOSE_DETACH makes the relay fail the call with
          // page_gone, which says what happened; 'cancelled' would read as a timeout.
          abandon(call, 'page detached');
        }
      }
    }
    const sock = socket;
    socket = null;
    if (sock) {
      closeSocket(
        sock,
        mode === 'detach' ? CLOSE_DETACH : 1001,
        mode === 'detach' ? 'detached' : 'unload',
      );
    }
    tearDownLink();
    if (mode === 'detach') {
      writeToken(null);
      clearGrants();
    }
    stopForGood(null);
  }

  const dock: Dock = Object.freeze({
    get state() {
      return state;
    },
    on(event: 'state', listener: (state: DockState) => void) {
      if ((event as string) !== 'state') throw new TypeError('a Dock only emits state events');
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    approve: (requestId: string, role: Role) => decide(requestId, true, role),
    deny: (requestId: string) => decide(requestId, false),
    // Strictly true: a script passing the string 'false' must not allow a consequential call.
    confirm: (callId: string, allow: boolean) => confirmCall(callId, (allow as unknown) === true),
    rotatePairing: () => isLinked() && send({ t: 'rotate_pairing' }),
    setRole: (userId: string, role: Role) => setRole(userId, role),
    // Workstream B honours RevokeOptions.closeInvite (ADR 0017); until a
    // relay offers invites no grant names one, so there is no link to close.
    revoke: (userId: string) => revoke(userId),
    cancelInvite: (inviteId: string) => cancelInvite(inviteId),
    invite: (options: InviteOptions) => invite(options),
    // Only false resumes: resuming lets calls run again, so a script's 'false' or 0 keeps the pause.
    pause: (paused: boolean) => {
      pause((paused as unknown) !== false);
    },
    close: () => {
      close('detach');
    },
  });

  return Object.freeze({ dock, start, close });
}

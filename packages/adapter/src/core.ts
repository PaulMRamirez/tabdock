// The adapter core (SPEC.md sections 6 and 8): one page's link to the relay.
// It touches no DOM or browser global, so the browser entry and the Node sim
// page run exactly this code; the socket, the WebMCP runtime, storage, locks,
// timers and the operator's prompts all arrive through CoreOptions.

import {
  ACCEPTED_PROPOSAL_RUN_MS,
  type Account,
  AGENT_BURN_TIMEOUTS,
  AGENT_TOKEN_BYTES,
  AGENT_TOKEN_PREFIX,
  agentKeyInput,
  type AgentListing,
  type AgentState,
  ATTACH_REQUEST_TTL_MS,
  type AttachmentView,
  type AttachVia,
  type Caller,
  canonicalJson,
  checkImage,
  type ClientInfo,
  CLOSE_DETACH,
  CLOSE_INVALID_FRAME_PAGE,
  CLOSE_REPLACED,
  CLOSE_SILENT,
  CONTROL_INVITE_USES,
  DEFAULT_INVITE_LIFETIME_MS,
  encodeFrame,
  encodeValue,
  escapeUnseen,
  IdSchema,
  IDLE_TIMEOUT_MS,
  type ImageMimeType,
  INVITE_BURN_REFUSALS,
  INVITE_SECRET_BYTES,
  InviteeIdSchema,
  InviteLabelSchema,
  inviteLink,
  type InviteListing,
  type InviteRefusalReason,
  INVITEE_ID_PREFIX,
  INVITEE_KEY_HEX_CHARS,
  INVITEE_SHORT_ID_CHARS,
  type JsonObject,
  JsonObjectSchema,
  MAX_AGENT_LIFETIME_MS,
  MAX_FRAME_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_TEXT_CHARS,
  MAX_INVITE_LIFETIME_MS,
  MAX_INVITE_USES,
  MAX_LIVE_AGENTS_PER_PAGE,
  MAX_LIVE_INVITES_PER_PAGE,
  MAX_OBSERVERS_PER_PAGE,
  MAX_PENDING_PROPOSALS_PER_PAGE,
  MAX_PENDING_PROPOSALS_PER_USER,
  MAX_RESULT_CHARS,
  MAX_SESSION_MS,
  MAX_STATE_BYTES,
  MAX_TIMER_MS,
  MAX_USERS_PER_PAGE,
  MEMBER_RESERVED_SEATS,
  narrowPolicy,
  type PageErrorCode,
  type PageFrameInput,
  PageFrameSchema,
  type PageTool,
  type Pairing,
  parseImageEnvelope,
  parseRelayFrame,
  parseValue,
  type Policy,
  type PolicyInput,
  PolicySchema,
  PROPOSAL_TTL_MS,
  proposalArgumentProblem,
  type ProposalPolicy,
  type ProposalRefusal,
  proposalsAdmit,
  PROTOCOL_VERSION,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  type RelayFrame,
  type Role,
  RoleSchema,
  SESSION_END_GRACE_MS,
  SESSION_LENGTH_UNIT_MS,
  type SessionEndReason,
  SessionLengthSchema,
  SessionPolicySchema,
  type SessionRecord,
  type SessionRefusalReason,
  SHORT_INVITE_LIFETIME_MS,
  STATE_MIN_INTERVAL_MS,
  StateValueSchema,
  type StoredAgent,
  StoredAgentsSchema,
  type StoredGrant,
  StoredGrantSchema,
  type StoredInvite,
  StoredInvitesSchema,
  type StoredSession,
  StoredSessionSchema,
  SUBPROTOCOL,
  TOOL_POLL_MS,
  truncate,
  type User,
  withinCeiling,
} from '@tabdock/protocol';
import * as z from 'zod/mini';
import { NOOP_RECORDER, type Recorder, type RecordView, type RecordWhich } from './record.ts';
import { apply } from './taken.ts';
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
export type { Recorder, RecordView, RecordWhich } from './record.ts';
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

/**
 * The slice of WebCrypto that invites need (ADR 0017): random bytes for a
 * secret and an invite id, and SHA-256 for the hash the relay keeps. A
 * browser's crypto fits, though its subtle exists only in a secure context;
 * so does Node's global crypto, which the sim page runs on.
 */
export interface CryptoLike {
  getRandomValues<T extends Uint8Array<ArrayBuffer>>(array: T): T;
  readonly subtle: {
    digest(algorithm: 'SHA-256', data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
  };
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

/** Where a page's policy was written: attach()'s options, or the script-tag build's data attributes. */
export type PolicyFrom = 'attach' | 'script-tag';

export interface CoreOptions {
  /** The relay's page endpoint, for example ws://127.0.0.1:8787/page. */
  relayUrl: string;
  policy?: PolicyInput | undefined;
  /** Where the policy was written, so advice names that setting; 'attach' unless set. */
  policyFrom?: PolicyFrom | undefined;
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
  /**
   * WebCrypto, for minting invites and checking redemptions; the global
   * crypto unless set. Without a usable one (a page outside a secure context)
   * the page mints nothing and honours no invite. Its two functions are
   * taken once, when the core is created, so a script that replaces them
   * later can neither predict a secret nor see one hashed through them;
   * docs/threat-model.md (B5) says what such a script can still read.
   */
  crypto?: CryptoLike | undefined;
  /**
   * Keeps the session record (ADR 0045). Internal, for tests: one that
   * throws shows that a recorder fault stops the record and never changes a call.
   */
  recorder?: Recorder | undefined;
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
  /**
   * The agent token whose first request this is (ADR 0044), as the relay
   * names it; never the token. Its label is checked against this page's own
   * record before the operator is asked. null for every other request.
   */
  readonly agent: { readonly tokenId: string; readonly label: string } | null;
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
 * (link_down), a relay that offers no invites or never answers, or a page
 * without WebCrypto (unavailable), or the operator closing the invite, by
 * Cancel or Revoke all, before the relay answered (cancelled).
 */
export type InviteRefusal =
  InviteRefusalReason | 'invalid' | 'link_down' | 'unavailable' | 'cancelled';

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
  /** Uses anyone can still take: the fewer of what the relay and this page's record have left. */
  readonly usesLeft: number;
  /** How many people this page let in by it: its own count, whatever the relay says. */
  readonly joined: number;
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
   * (invite_cancel), so nobody else joins by it. Left out, it closes a
   * multi-use invite's link and leaves a single-use one, which their joining
   * spent (ADR 0016: "and close this link" by default); revoke('*') closes
   * every link anyway.
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

// From M6: page state, proposals, time-boxed sessions and agent tokens.

/** What publishState did with a value (ADR 0040). Never a throw: pages publish from render loops. */
export type PublishResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'too_large' | 'invalid' };

/**
 * Whether the page's state reaches the relay (ADR 0040): nothing published
 * yet, shared, held while paused, refused for its size or its shape, or a
 * relay that takes no page state. It changes only between these, never with
 * each value, so a page publishing twice a second re-renders nothing.
 */
export type PublishStatus = 'none' | 'shared' | 'paused' | 'too_large' | 'invalid' | 'unsupported';

/** The CustomEvent a script-tag page dispatches on document to publish its state (ADR 0040). */
export const STATE_EVENT = 'tabdock:state';

/** How a proposal left the queue (ADR 0042). */
export type ProposalOutcome =
  'accepted' | 'dismissed' | 'refused' | 'expired' | 'withdrawn' | 'cancelled' | 'not_run';

/**
 * An observer's call the page holds for the operator to accept or dismiss
 * (ADR 0042). Its arguments are here as text to show, never to run: an
 * accepted proposal runs the page's own parsed copy.
 */
export interface PendingProposal {
  readonly proposalId: string;
  readonly tool: string;
  readonly proposer: Caller;
  /** The arguments' JSON as received, unseen characters escaped (escapeUnseen), for showing. */
  readonly arguments: string;
  readonly argumentChars: number;
  /** By the page's own rule (ADR 0002): accepting it is then that call's confirmation (S6). */
  readonly consequential: boolean;
  /** Local epoch milliseconds. */
  readonly receivedAt: number;
  readonly expiresAt: number;
}

/** A proposal that left the queue, as the session record keeps it (ADR 0045); never its arguments. */
export interface ProposalLogEntry {
  readonly proposalId: string;
  readonly tool: string;
  readonly proposer: User;
  readonly client: ClientInfo | null;
  readonly outcome: ProposalOutcome;
  /** The call that ran an accepted proposal; null for every other. */
  readonly callId: string | null;
  /** Local epoch milliseconds. */
  readonly time: number;
}

/** A time-boxed session this page started (ADR 0043). Never its invite link, which shows once. */
export interface SessionView {
  readonly sessionId: string;
  /** Written on this page: shown as its own words (S10). */
  readonly label: string;
  /** Local epoch milliseconds. */
  readonly startedAt: number;
  readonly endsAt: number;
  readonly lengthMinutes: number;
  /** The page's policy as the session narrows it; never wider than attach()'s. */
  readonly policy: Policy;
  /** Seats offered by watch invite, and the invites minted for them. */
  readonly observers: number;
  readonly inviteIds: readonly string[];
  /** The member the relay named as sponsor of the session's invites; null without observers. */
  readonly sponsor: User | null;
}

/** Why a session ended: the relay's reasons, or 'relay' when it started a new page session. */
export type SessionEndedReason = SessionEndReason | 'relay';

export interface SessionEnded {
  readonly sessionId: string;
  readonly label: string;
  readonly reason: SessionEndedReason;
  /** Local epoch milliseconds. */
  readonly time: number;
}

/** What the operator asks for when starting a session (ADR 0043), each within attach()'s policy. */
export interface SessionOptions {
  /** 1 to 60 characters, shown wherever the session is. */
  readonly label: string;
  /** Whole minutes from 30 to 240. */
  readonly lengthMinutes: number;
  /** Driver seats, 1 to policy.maxDrivers. */
  readonly drivers?: number;
  /** Seats by watch invite; none unless set. */
  readonly observers?: number;
  /** Who may propose, no wider than policy.proposals. */
  readonly proposals?: ProposalPolicy;
}

/** One of a session's watch invites and its link, which shows once (ADR 0043). */
export interface SessionLink {
  readonly inviteId: string;
  readonly link: string;
}

/** The observers' links show here once and are never stored, as an invite's is. */
export type SessionResult =
  | {
      readonly ok: true;
      readonly sessionId: string;
      /** Local epoch milliseconds. */
      readonly endsAt: number;
      /** The first of links, or null with no observers. */
      readonly link: string | null;
      /** One watch invite for every 20 observers, each to be shown in turn (conflict C12). */
      readonly links: readonly SessionLink[];
      /** Why a session with observers started without its link. */
      readonly inviteRefusal?: InviteRefusal;
    }
  | {
      readonly ok: false;
      readonly reason:
        'invalid' | 'policy' | 'active' | 'link_down' | 'unavailable' | SessionRefusalReason;
    };

/** Why no session started. */
type SessionFailure = Extract<SessionResult, { ok: false }>['reason'];

/** How long an agent token works (ADR 0044). */
export type AgentLifetime = '1h' | '4h' | '8h';

export interface AgentTokenOptions {
  /** 1 to 60 characters, shown in the prompt the token's first request raises. */
  readonly label: string;
  /** An hour unless set. */
  readonly lifetime?: AgentLifetime;
}

/** The token and its command show here once and are never stored: only the token's hash is. */
export type AgentTokenResult =
  | {
      readonly ok: true;
      readonly tokenId: string;
      readonly token: string;
      readonly endpoint: string;
      readonly command: string;
      /** Local epoch milliseconds. */
      readonly expiresAt: number;
    }
  | { readonly ok: false; readonly reason: InviteRefusal };

/** One live agent token this page minted, as the relay lists it and this page's record holds it. */
export interface AgentView {
  readonly tokenId: string;
  /** Written on this page: shown as its own words (S10). */
  readonly label: string;
  readonly expiresAt: number;
  readonly state: AgentState;
  /** Prompts its requests left to time out; three burn it. */
  readonly timeouts: number;
  readonly sponsor: User;
}

/** What a relay that takes agent tokens said in its last agents frame. */
export interface AgentsOffered {
  /** `<public URL>/g/mcp`; null where the relay mints no agent endpoint. */
  readonly endpoint: string | null;
}

/** The relay's seat numbers from its welcome (ADR 0044), within the protocol's ceilings. */
export interface SeatLimits {
  /** The people limit. */
  readonly usersPerPage: number;
  /** Watching seats for invitees beside it; 0 where there are none. */
  readonly observersPerPage: number;
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
  /**
   * 'client' when the page ran this consequential call without its prompt
   * because the caller confirmed it in their own MCP client, which the page
   * takes only under its own policy, rule and grant (ADR 0026); null
   * otherwise, including every call the operator confirmed here.
   */
  readonly confirmedBy: 'client' | null;
  /** Milliseconds from arrival to the end; null while the call runs. */
  readonly durationMs: number | null;
  /**
   * True from when the call was answered (cancelled, timed out, revoked or cut
   * off) until the page's handler, which kept running, ends. A write holds
   * the page meanwhile, so later writes wait for it.
   */
  readonly handlerRunning: boolean;
  /** An image result's type and size, never its data (ADR 0039); null for every other call. */
  readonly image: { readonly mimeType: ImageMimeType; readonly bytes: number } | null;
  /** The proposal this call ran, accepted on this page (ADR 0042); null for every other call. */
  readonly proposalId: string | null;
  /** True once the page bound the call to a proposal its own record shows accepted. */
  readonly acceptedOnPage: boolean;
}

/** What this page lets one user the roster lists do; see DockState.pageRoles. */
export interface PageRole {
  readonly userId: string;
  /** The role the page runs their calls under, or null when it runs none. */
  readonly role: Role | null;
  /** Revoked here, and the relay has not dropped them yet. */
  readonly revoked: boolean;
  /**
   * For someone an invite let in, that invite's role: the most the role
   * switch may give them (ADR 0017). null for everyone else.
   */
  readonly inviteRole: Role | null;
}

/**
 * Someone this page let in by an invite: its own honour decision, made
 * against its record and the presented secret, never the relay's roster
 * (ADR 0017). The widget's join notice (ADR 0016) reads these, so a relay
 * cannot announce a join the page never honoured.
 */
export interface InviteJoin {
  /** Counts up from 1 with every join this core honours, so a notice is given once. */
  readonly seq: number;
  readonly user: User;
  readonly account: Account;
  readonly inviteId: string;
  /** The invite's label as this page's record holds it: the page's own words. */
  readonly label: string;
  /** Local epoch milliseconds of the decision. */
  readonly time: number;
}

/**
 * Someone the operator asked to make a driver, by Allow as driver or Make
 * driver, whom the relay seated as an observer because the page already had
 * policy.maxDrivers drivers. The page records it when the relay's roster
 * comes back, never from its own guess, so the widget can say so in the
 * operator's own words.
 */
export interface ObserverSeat {
  /** Counts up from 1 with every such seat this core records, so a notice is given once. */
  readonly seq: number;
  readonly user: User;
  /** From the request Allow as driver answered; null for Make driver, which has none. */
  readonly account: Account | null;
  /** 'allow' for Allow as driver, 'promote' for Make driver. */
  readonly asked: 'allow' | 'promote';
  /** Local epoch milliseconds of the roster that showed it. */
  readonly time: number;
  /**
   * 'people' when no driver limit held them back but the page's people had
   * no seat for a watcher made a driver (ADR 0044); absent for the driver limit.
   */
  readonly heldBy?: 'people';
}

/** A set_role the page sent, until a roster that could answer it has come. */
interface SentRole {
  readonly userId: string;
}

/** A driver the operator asked for, until the relay's roster settles the seat. */
interface DriverAsk {
  readonly user: User;
  readonly account: Account | null;
  readonly asked: 'allow' | 'promote';
  /**
   * For Make driver, its set_role while a roster may yet answer it; null for
   * Allow as driver, which the first roster that lists them answers.
   */
  readonly sent: SentRole | null;
  /** Logged as an observer; watched still, in case the relay's answer comes after all. */
  saidObserver: boolean;
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
   * never sends one, so the widget then offers no Invite form at all. Back to
   * null whenever the link drops, until the next one.
   */
  readonly invitesOffered: InvitesOffered | null;
  /**
   * Who this page let in by invite and still lets in, newest first: one
   * entry per invite-made grant this page made itself, gone with the grant.
   * What the page runs their calls under now is pageRoles' to say.
   */
  readonly joins: readonly InviteJoin[];
  /**
   * Who the driver limit seated as an observer after the operator chose
   * driver, newest first, while the roster still lists them as one.
   */
  readonly observerSeats: readonly ObserverSeat[];
  /**
   * The page's policy as attach() was given it, defaults filled in: what
   * policy.invites lets the operator offer, and maxDrivers, for a prompt to
   * say a guest will join as observer. A copy; changing it changes nothing.
   */
  readonly policy: Policy;
  /** Whether the page's state reaches the relay (ADR 0040); see PublishStatus. */
  readonly published: PublishStatus;
  /**
   * The largest image result, in bytes, this link's relay takes (ADR 0039),
   * within MAX_IMAGE_BYTES; 0 for a relay that takes none, and null until a
   * welcome says and whenever the link drops.
   */
  readonly maxImageBytes: number | null;
  /** Proposals waiting for the operator, oldest first (ADR 0042). */
  readonly proposals: readonly PendingProposal[];
  /** The last ACTIVITY_LIMIT proposals that left the queue, newest first. */
  readonly proposalLog: readonly ProposalLogEntry[];
  /** The time-boxed session this page runs (ADR 0043), or null. */
  readonly session: SessionView | null;
  /**
   * Whether this link's relay sent a session frame after its welcome, which
   * only a relay that takes sessions does; the page offers none otherwise.
   */
  readonly sessionsOffered: boolean;
  /** How the last session ended, for the end notice and the session record; null before any has. */
  readonly sessionEnded: SessionEnded | null;
  /** This page's live agent tokens (ADR 0044), oldest first, holding only those its own record knows. */
  readonly agents: readonly AgentView[];
  /** null until an agents frame arrives on this link, which only a relay with agent tokens on sends. */
  readonly agentsOffered: AgentsOffered | null;
  /** This link's welcome's seat numbers (ADR 0044); null from a relay that sends none. */
  readonly seatLimits: SeatLimits | null;
  /** The session records held now (ADR 0045): counts and times, never a name. */
  readonly records: readonly RecordView[];
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
   * from it for its life, and no later redemption by them is honoured;
   * options.closeInvite also closes its link (ADR 0017).
   */
  revoke(userId: string, options?: RevokeOptions): boolean;
  /**
   * Closes one invite's link (invite_cancel); the attachments it already
   * made stay until revoked (ADR 0017's notes). This page forgets its record
   * at once, so it honours the link no more whatever the relay does, and a
   * relay that still lists it after a lost link hears the cancel again.
   * False when this page holds no such invite.
   */
  cancelInvite(inviteId: string): boolean;
  /**
   * Mints an invite on this page as far as policy.invites allows (ADR 0017):
   * a 128-bit secret whose hash alone goes to the relay and into this page's
   * own record, and a link that resolves here once, when the relay lists the
   * invite. The secret is kept nowhere after that.
   */
  invite(options: InviteOptions): Promise<InviteResult>;
  /** Pauses or resumes calls on this page. Only false resumes, and the choice survives a reload. */
  pause(paused: boolean): void;
  close(): void;
  /**
   * Shares a JSON object, or null, as the page's state for attached clients
   * to read (ADR 0040). It never throws: a value too large, or not an
   * object, clears what the relay holds and says why.
   */
  publishState(value: unknown): PublishResult;
  /**
   * Accepts a waiting proposal (ADR 0042), which is that call's confirmation
   * (S6); the relay then runs it in turn. False when there is none to accept now.
   */
  acceptProposal(proposalId: string): boolean;
  dismissProposal(proposalId: string): boolean;
  /** Dismisses every waiting proposal and says how many. */
  dismissAllProposals(): number;
  /** Starts a time-boxed session (ADR 0043), never wider than attach()'s policy. */
  startSession(options: SessionOptions): Promise<SessionResult>;
  /** Lengthens the running session by whole minutes, up to 4 hours from its start. */
  extendSession(minutes: number): boolean;
  /**
   * Ends the running session now, and with it every attachment an invite or
   * agent token made, every live invite and every agent token on the page,
   * those from before the session too, as Revoke all ends invites.
   */
  endSession(): boolean;
  /** A new observers' link for the running session, since a reload keeps none. */
  renewSessionLink(): Promise<InviteResult>;
  /** Mints an agent token (ADR 0044) whose first request asks the operator; the token shows once. */
  agentToken(options: AgentTokenOptions): Promise<AgentTokenResult>;
  cancelAgent(tokenId: string): boolean;
  /** A schema-checked copy of one session record (ADR 0045), the current one unless named. */
  sessionRecord(which?: RecordWhich): SessionRecord | null;
  /** Drops a sealed record, or restarts the current one from now. */
  discardRecord(which: RecordWhich): boolean;
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

/**
 * The longest deadline the page takes from a relay. The schema takes any
 * positive safe integer, since refusing the frame would close the link over
 * one odd deadline; but a timer past MAX_TIMER_MS fires at once, ending the
 * call early, and holdUnwatched adds its grace on top. Tabdock's own relay
 * never sends more; this is for one the adapter does not trust (ADR 0030).
 */
export const MAX_DEADLINE_MS = MAX_TIMER_MS - UNWATCHED_HANDLER_GRACE_MS;

/**
 * How many ids of calls that put a prompt before the operator the page
 * remembers, taking no later call under any of them (onInvoke), so an answer
 * keyed by call id, such as Dock.confirm's, can only ever reach the prompt it
 * was about. Tabdock's relay draws a fresh random id for every call, so only
 * a relay that lies reuses one, and to reuse one past this bound it must
 * first raise this many newer prompts before the operator. A UI port's
 * answer is bound to its own prompt whatever this remembers (askConfirm).
 */
export const REMEMBERED_PROMPT_IDS = 1000;

/** Results are cut this far under the cap so the truncation marker fits under it too. */
const MARKER_ROOM = 100;

/**
 * Image calls start one at a time on a page, at least this far apart (ADR
 * 0039), so a client looping on a capture cannot keep the page drawing.
 */
export const IMAGE_CALL_SPACING_MS = 250;

/** Image calls one page holds waiting at once; past it they are answered page_busy (ADR 0039). */
export const MAX_WAITING_IMAGE_CALLS = 8;

/** The protocol caps result error messages at this length. */
const MAX_ERROR_CHARS = 2000;

/** The smallest frame limit honoured from a relay, so a truncated result always fits. */
const MIN_FRAME_BYTES = 4096;

/**
 * How long dock.invite() waits for the relay to list or refuse a new
 * invite. A relay answers every invite_create at once (ADR 0017's notes), so
 * only one that does not ever gets here; the page then forgets the invite.
 */
export const MINT_ANSWER_MS = 10_000;

/** Random bytes in an invite id, which names an invite but opens nothing. */
const INVITE_ID_BYTES = 9;

/**
 * What the adapter keeps in the tab's storage, each for one relay and one
 * page: from M4 also its invite records (StoredInvites, ADR 0017), beside
 * the grants and dropped with them, and from M6 its time-boxed session
 * (StoredSession, ADR 0043) and agent token records (StoredAgents, ADR 0044).
 */
export type StoredRecord =
  'resume' | 'grants' | 'revoked' | 'paused' | 'invites' | 'session' | 'agents';

const STORED_RECORDS: readonly StoredRecord[] = [
  'resume',
  'grants',
  'revoked',
  'paused',
  'invites',
  'session',
  'agents',
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

/**
 * Names both majors' entry points: MCP-B 6 exports only installWebMCP(), and
 * 5.x only initializeWebMCPPolyfill() (docs/notes/verified.md, ADR 0001's notes).
 */
const POLYFILL_HINT =
  'document.modelContext is missing, so Tabdock stays idle. Load a WebMCP polyfill first ' +
  "(for example @mcp-b/webmcp-polyfill's installWebMCP() on 6.x, or initializeWebMCPPolyfill() on 5.x) " +
  'or use a browser with WebMCP enabled.';

/**
 * The hint fallback's advice (ADR 0002), naming the setting the page author
 * wrote: the policy option for attach(), the attribute on a script tag.
 */
const HINT_NOTICES: Readonly<Record<PolicyFrom, string>> = {
  attach:
    "This browser's WebMCP does not report consequentialHint, so every tool that is not read-only " +
    'is treated as consequential. List the consequential tools in policy.consequentialTools to fix this.',
  'script-tag':
    "This browser's WebMCP does not report consequentialHint, so every tool that is not read-only " +
    "is treated as consequential. List the consequential tools in the script tag's " +
    'data-consequential-tools attribute to fix this.',
};

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
type InvitesFrame = Extract<RelayFrame, { t: 'invites' }>;
type ProposalFrame = Extract<RelayFrame, { t: 'proposal' }>;
type ProposalEndFrame = Extract<RelayFrame, { t: 'proposal_end' }>;
type SessionFrame = Extract<RelayFrame, { t: 'session' }>;
type AgentsFrame = Extract<RelayFrame, { t: 'agents' }>;

/** A declared image tool's checked image (ADR 0039): bare base64, never re-encoded. */
interface ResultImage {
  mimeType: ImageMimeType;
  data: string;
  bytes: number;
}

type Outcome =
  | { ok: true; content: string; image?: ResultImage }
  | { ok: false; code: PageErrorCode; message: string };
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
  /**
   * Set while the call waits for the operator's confirmation. The prompt and
   * its port name this one prompt, so an answer is checked against them,
   * never only against the call id a relay chose.
   */
  confirm: {
    readonly resolve: (allow: boolean) => void;
    readonly port: AbortController;
    readonly pending: PendingConfirm;
  } | null;
  /** The accepted proposal this call ran under, bound once from this page's own record (ADR 0042). */
  proposal: HeldProposal | null;
}

/** This page's own record of a proposal (ADR 0042), in memory only. */
interface HeldProposal {
  readonly view: PendingProposal;
  /** The page's own parsed copy, which an accepted run executes. */
  readonly args: JsonObject;
  /** What binds an invoke to it: the arguments as canonical JSON. */
  readonly canonical: string;
  /** Whether an agent token made the proposer's grant; such a proposer never proposes (C13). */
  readonly agent: boolean;
  state: 'pending' | 'accepted';
  /** When the operator accepted it, on this page's clock. */
  acceptedAt: number;
  timer: unknown;
}

type Checked = { ok: true; tool: NormalisedTool } | { ok: false; refusal: Refusal };

function refuse(code: PageErrorCode, message: string): Checked {
  return { ok: false, refusal: { ok: false, code, message } };
}

/**
 * A grant as the core holds it: StoredGrant read back, the bare role of an
 * older adapter included, with every field it may have in one shape.
 */
interface Grant {
  readonly role: Role;
  readonly inviteId?: string | undefined;
  readonly endsAt?: number | undefined;
  readonly inviteRole?: Role | undefined;
}

/**
 * One attach request while it waits. Every decision names the record, never
 * only its id: a relay may reuse an id once a request is answered, and an
 * answer meant for the old request must not settle the new one.
 */
interface RequestRecord {
  readonly request: PendingRequest;
  /** Silence until expiresAt denies; set once, right after the record is made. */
  timer: unknown;
  readonly port: AbortController;
  /**
   * Put before the operator: listed in pendingRequests and asked through
   * the UI port. A redemption is shown only once its secret checks out, and
   * only for Can control; a Can watch one is answered without a prompt.
   */
  shown: boolean;
  /** The secret a redemption presented, held only until it is checked. */
  secret: string | null;
  /** A redemption whose secret hashed to this page's record; nothing approves one before. */
  verified: boolean;
}

/**
 * Why a request was answered, which decides whether a control invite counts
 * a refusal: only the operator's Deny and a prompt left to time out do,
 * since three of those burn it (ADR 0017). 'closing' is a request the relay
 * ends itself, as it applies the session_end, invite_cancel or agent_cancel
 * this page sends with it, or its own session's end.
 */
type DecisionCause = 'operator' | 'timeout' | 'rule' | 'invite' | 'revoke' | 'detach' | 'closing';

interface MintInFlight {
  /** Only until the relay answers; then it goes into the link, and from here nowhere. */
  readonly secret: string;
  readonly resolve: (result: InviteResult) => void;
  readonly timer: unknown;
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

/**
 * Taken when this module loads, which is before attach(): a script that runs
 * later and replaces TextEncoder's encode or the Uint8Array constructor
 * would otherwise be handed an invite secret's text or bytes as the core
 * draws and hashes it. WebCrypto's functions are taken in usableCrypto, and
 * the base64url digits and the typed array length below.
 * Each of these closes one route that handed a later script every secret
 * with no other effort; together they keep no secret from it. A secret still
 * passes through the page's own built-ins here (the Map that holds a mint
 * until the relay lists it, the Promise that resolves with the link) and, in
 * the protocol package, through the RegExp checks of its zod schemas, on its
 * way into a link and out of each redemption frame. So a script that runs
 * after attach() can still read an invite's secret as it is minted and as
 * each redemption arrives, a multi-use link's included, for as long as the
 * link works. The trusted-page rule covers it (docs/threat-model.md, B5).
 */
const encoder = new TextEncoder();
const encodeUtf8 = encoder.encode.bind(encoder);
const ByteArray = Uint8Array;

/**
 * The 64 digits as an array, indexed directly: a string's charAt, or any
 * other method on String.prototype, is the page's, and a script that patched
 * it after attach() would be handed each new secret one digit at a time.
 * Frozen so nothing can change a digit either.
 */
const BASE64URL_DIGITS: readonly string[] = Object.freeze(
  Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'),
);

/**
 * Taken when this module loads, like the digits: the length getter every
 * typed array inherits, called through the Reflect.apply taken.ts took. A
 * later script could otherwise put a length getter of its own on
 * Uint8Array.prototype, or replace Reflect.apply, and be handed a new
 * secret's 16 bytes.
 */
const typedArrayLength = (() => {
  const getter = Reflect.getOwnPropertyDescriptor(
    Reflect.getPrototypeOf(Uint8Array.prototype) as object,
    'length',
  )?.get;
  if (getter === undefined) throw new TypeError('no typed array length getter');
  return (bytes: Uint8Array): number => apply(getter, bytes, []) as number;
})();

/**
 * Through the taken length getter too: every frame the page sends is counted
 * here first, so a length getter a later script put on Uint8Array.prototype
 * would otherwise be handed each one's bytes.
 */
function byteLength(text: string): number {
  return typedArrayLength(encodeUtf8(text));
}

/**
 * A value the page publishes as its state, as the canonical text the adapter
 * keeps and sends, or why it is refused (ADR 0040). It is written once
 * through the protocol's taken JSON.stringify, so a getter that changes
 * between reads cannot make what is sent differ from what was checked; that
 * text, read back, must be a JSON object or null. Null comes back as null
 * text. Never a throw: pages publish from render loops.
 */
function stateTextOf(value: unknown): { text: string | null; bytes: number } | 'invalid' {
  let text: string | undefined;
  try {
    text = encodeValue(value);
  } catch {
    // A cycle or a BigInt.
    return 'invalid';
  }
  if (text === undefined) return 'invalid';
  const parsed = parseValue(text);
  if (!StateValueSchema.safeParse(parsed).success) return 'invalid';
  return parsed === null ? { text: null, bytes: 0 } : { text, bytes: byteLength(text) };
}

/** Unpadded base64url, as the relay's Buffer.toString('base64url') writes it: 16 bytes make 22 characters. */
export function base64url(bytes: Uint8Array): string {
  let text = '';
  const length = typedArrayLength(bytes);
  for (let i = 0; i < length; i += 3) {
    const rest = length - i;
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    text += `${BASE64URL_DIGITS[(n >> 18) & 63] ?? ''}${BASE64URL_DIGITS[(n >> 12) & 63] ?? ''}`;
    if (rest > 1) text += BASE64URL_DIGITS[(n >> 6) & 63] ?? '';
    if (rest > 2) text += BASE64URL_DIGITS[n & 63] ?? '';
  }
  return text;
}

/**
 * The page's WebCrypto, when it has one it can use: browsers leave subtle
 * out outside a secure context, where invites then stay off. Its functions
 * are bound here, once, into an object of the core's own: Crypto.prototype
 * and SubtleCrypto.prototype stay open to page scripts, and one that ran
 * after attach() and patched them could otherwise make every secret
 * predictable, or read each one as it is hashed.
 */
function usableCrypto(given: CryptoLike | undefined): CryptoLike | null {
  const candidate: unknown = given ?? Reflect.get(globalThis, 'crypto');
  if (typeof candidate !== 'object' || candidate === null) return null;
  const { getRandomValues, subtle } = candidate as { getRandomValues?: unknown; subtle?: unknown };
  if (typeof getRandomValues !== 'function' || typeof subtle !== 'object' || subtle === null) {
    return null;
  }
  const digest: unknown = (subtle as { digest?: unknown }).digest;
  if (typeof digest !== 'function') return null;
  return Object.freeze({
    getRandomValues: (getRandomValues as CryptoLike['getRandomValues']).bind(candidate),
    subtle: Object.freeze({
      digest: (digest as CryptoLike['subtle']['digest']).bind(subtle),
    }),
  });
}

/** SHA-256 of the text's UTF-8 bytes as 64 lower-case hex characters, matching the relay's digestHex. */
async function sha256Hex(crypto: CryptoLike, text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', encodeUtf8(text));
  return Array.from(new ByteArray(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomText(crypto: CryptoLike, bytes: number): string {
  return base64url(crypto.getRandomValues(new ByteArray(bytes)));
}

/** An invitee's id is the prefix and its account key; their kind follows from it (ADR 0017's notes). */
function isInvitee(userId: string): boolean {
  return InviteeIdSchema.safeParse(userId).success;
}

/**
 * How a user appears in the adapter's own log lines. An invitee's display
 * name is their email, which belongs on the operator's screen and in no log
 * (ADR 0020), so they appear by the short id the widget also shows.
 */
function logName(user: { userId: string; displayName: string }): string {
  return isInvitee(user.userId)
    ? `invitee ${user.userId.slice(2, 2 + INVITEE_SHORT_ID_CHARS)}`
    : user.displayName;
}

/** When an invite stops working on this page's clock: its expiry, and 24 hours after minting whatever it says. */
function inviteEnd(invite: StoredInvite): number {
  const latest = invite.createdAt + MAX_INVITE_LIFETIME_MS;
  return invite.expiresAt === null ? latest : Math.min(invite.expiresAt, latest);
}

/** Whether the relay lists an invite with the very terms this page minted it with (ADR 0017's notes). */
function sameTerms(invite: StoredInvite, listing: InviteListing): boolean {
  return (
    invite.role === listing.role &&
    invite.label === listing.label &&
    invite.uses === listing.uses &&
    invite.expiresAt === listing.expiresAt
  );
}

function lifetimeMs(lifetime: InviteLifetime): number | null {
  if (lifetime === 'open') return null;
  return lifetime === '15m' ? SHORT_INVITE_LIFETIME_MS : DEFAULT_INVITE_LIFETIME_MS;
}

/**
 * The relay's seat numbers (ADR 0044), for the widget to show and never for
 * a decision: the relay seats people, and the page enforces its own grants
 * whatever it says. The schema caps neither number, so a hostile relay's
 * large one is clamped here rather than closing the link; a relay that sends
 * no people limit (0.1.0) gives none.
 */
function seatLimitsOf(limits: WelcomeFrame['limits']): SeatLimits | null {
  if (limits.usersPerPage === undefined) return null;
  return Object.freeze({
    usersPerPage: Math.min(MAX_USERS_PER_PAGE, limits.usersPerPage),
    observersPerPage: Math.min(MAX_OBSERVERS_PER_PAGE, limits.observersPerPage ?? 0),
  });
}

/**
 * How many may watch by a session's invites (conflict C12): the relay's
 * watching seats, or its people less the members' two where it has none,
 * or one invite's uses from a relay that names no seats (0.1.0).
 */
export function sessionSeats(seats: SeatLimits | null): number {
  if (seats === null) return MAX_INVITE_USES;
  return seats.observersPerPage || Math.max(0, seats.usersPerPage - MEMBER_RESERVED_SEATS);
}

/**
 * Whether the roster shows `entry`, an invitee watching by invite, kept out
 * of the people's seats (ADR 0044): the people fill the people limit, or
 * those an invite let in leave members no more than their reserve (every
 * watcher came in by an invite or an agent token). For the widget's words
 * only, as seatLimitsOf is.
 */
function noPeopleSeat(
  limits: SeatLimits | null,
  roster: readonly AttachmentView[],
  entry: AttachmentView,
): boolean {
  const watching = (row: AttachmentView): boolean =>
    row.kind === 'invitee' && row.role === 'observer';
  if (!limits?.observersPerPage || !watching(entry)) return false;
  const people = roster.filter((row) => !watching(row));
  return (
    people.length >= limits.usersPerPage ||
    people.filter((row) => row.inviteId).length >= limits.usersPerPage - MEMBER_RESERVED_SEATS
  );
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
  const users = z.array(IdSchema).safeParse(record.data.users);
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
 * A bad policy is a page bug; throwing here surfaces it at attach(). The
 * error is a TypeError naming the fields, as for a bad relay URL, so zod's
 * own error class never becomes part of attach()'s contract, and it never
 * quotes a value the page passed (ADR 0032).
 */
function checkPolicy(input: unknown): Policy {
  const parsed = PolicySchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const fields = [
    ...new Set(
      parsed.error.issues
        .map((issue) => issue.path.map((part) => String(part)).join('.'))
        .filter((field) => field !== ''),
    ),
  ];
  throw new TypeError(
    fields.length === 0
      ? 'invalid policy: it must be an object'
      : `invalid policy for ${fields.join(', ')}`,
  );
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
  const policy = checkPolicy(options.policy ?? {});
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
  const invitesKey = storageKey('invites', options.relayUrl, options.pageUrl);
  const sessionKey = storageKey('session', options.relayUrl, options.pageUrl);
  const agentsKey = storageKey('agents', options.relayUrl, options.pageUrl);
  forgetLegacyRecords(options.storage, options.relayUrl);
  const webCrypto = usableCrypto(options.crypto);
  const polyfillMarker: unknown = context && Reflect.get(context, POLYFILL_MARKER);
  /**
   * Under ADR 0001 a call that ends early aborts the signal it handed
   * executeTool, which native WebMCP passes on to the handler. The polyfill
   * only races executeTool against it, so there an abort stops nothing and
   * hides when the handler really ends, which the write queue must know.
   */
  const abortReachesHandlers = polyfillMarker !== true;
  // M6 seam: not built
  const recorder = options.recorder ?? NOOP_RECORDER;

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
    joins: [],
    observerSeats: [],
    policy: {
      ...policy,
      consequentialTools: [...policy.consequentialTools],
      imageTools: [...policy.imageTools],
    },
    published: 'none',
    maxImageBytes: null,
    proposals: [],
    proposalLog: [],
    session: null,
    sessionsOffered: false,
    sessionEnded: null,
    agents: [],
    agentsOffered: null,
    seatLimits: null,
    records: recorder.views(),
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
  /**
   * Ids of calls that put a prompt before the operator, oldest first, up to
   * REMEMBERED_PROMPT_IDS, for as long as this page runs: across links too,
   * since a host's dialog outlives a link. Dock.confirm finds a prompt by
   * its call id alone, so a relay that cancelled a prompted call and sent
   * another under its id would have a host dialog still showing the first
   * prompt, or a click landing as it changes, confirm the second.
   */
  const promptedIds = new Set<string>();
  const requests = new Map<string, RequestRecord>();
  /**
   * The roles the operator granted on this page, by user id: the root of S5's
   * second check. The relay's roster and the role an invoke claims can only
   * lower them, so a relay cannot run a tool for someone nobody approved. An
   * invite-made grant also names its invite, its end and the invite's role,
   * which caps it (ADR 0017).
   */
  const grants = new Map<string, Grant>();
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
  /**
   * This page's own record of every invite it minted (ADR 0017), by id,
   * stored beside the grants: the hash of its secret, its terms, the uses
   * this page has let go, its refusals and the accounts barred from it. A
   * redemption is honoured only against this, never against what the relay
   * says, so a relay that never saw a secret cannot invent one that works.
   */
  const invites = new Map<string, StoredInvite>();
  /** What the relay's last invites frame said of each invite the records hold, terms matching. */
  let listings = new Map<string, InviteListing>();
  /** Invites sent to the relay that it has neither listed nor refused yet. */
  const minting = new Map<string, MintInFlight>();
  /**
   * Invites closed on this link because this page holds no record of them,
   * so a relay that keeps listing one hears the cancel once per link.
   */
  const cancelSent = new Set<string>();
  /** Fires when the next invite-made grant ends, so the roles shown change with it. */
  let grantEndTimer: unknown = null;
  /** The seq of the last join this core honoured; see InviteJoin. */
  let joinSeq = 0;
  /**
   * Users the operator asked to make drivers whose seat the relay has not
   * settled: the relay decides it (it holds a new driver at maxDrivers), so
   * what the operator got is said only once its roster shows it.
   */
  const askedDriver = new Map<string, DriverAsk>();
  /**
   * set_role frames sent whose roster may not have come back, oldest first.
   * The relay answers each with exactly one roster, in order, and sends
   * rosters for other events too, so each roster takes the oldest off: a
   * promotion's answer can be no earlier than the roster that takes its
   * frame off, and may be later. The relay answers a set_role for someone no
   * longer attached with nothing, so a roster that leaves its user out takes
   * it off too.
   */
  const rolesUnanswered: SentRole[] = [];
  /** The seq of the last ObserverSeat recorded. */
  let seatSeq = 0;
  /**
   * The time-boxed session this page started (ADR 0043), as its stored
   * record holds it; up here because pageRole reads it from the first grant.
   */
  let session: StoredSession | null = null;

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
    // The invite records too: a strict schema, so a record holding a secret,
    // or anything else malformed, reads as no records at all.
    const invitesText = readStored(invitesKey);
    const records =
      invitesText === null ? null : StoredInvitesSchema.safeParse(parseJson(invitesText));
    if (records && !records.success) log.warn('ignored stored invites that did not parse');
    if (records?.success && (grantsPage === null || grantsPage === records.data.pageId)) {
      grantsPage = records.data.pageId;
      for (const invite of records.data.invites) invites.set(invite.inviteId, invite);
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

  /**
   * Every change to the grants, the pending revokes or the invite records
   * ends here, so storage and the shown roles and invites always match memory.
   */
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
    writeStored(
      invitesKey,
      invites.size === 0 || page === null
        ? null
        : JSON.stringify({ pageId: page, invites: [...invites.values()] }),
      "the page's invite records",
    );
    armGrantEnd();
    const views = inviteViews();
    // A join stays only while the grant it made does.
    const joins = state.joins.filter(
      (join) => grants.get(join.user.userId)?.inviteId === join.inviteId,
    );
    const patch = {
      ...(JSON.stringify(views) === JSON.stringify(state.invites) ? {} : { invites: views }),
      ...(joins.length === state.joins.length ? {} : { joins }),
    };
    if (
      Object.keys(patch).length > 0 ||
      JSON.stringify(rolesFor(state.roster)) !== JSON.stringify(state.pageRoles)
    ) {
      setState(patch);
    }
  }

  /** The operator's approvals and role changes go through here, so storage always matches memory. */
  function setGrant(userId: string, grant: Grant): void {
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

  /** Everything this page approved, revoked or minted for one page session goes together. */
  function clearGrants(): void {
    grants.clear();
    revoked.clear();
    for (const inviteId of [...invites.keys()]) forgetInvite(inviteId, 'cancelled');
    grantsPage = null;
    saveGrants();
    // A time-boxed session and agent tokens belong to the page session too
    // (ADRs 0043 and 0044), so a detach leaves neither record in storage.
    writeStored(sessionKey, null, "the page's session");
    writeStored(agentsKey, null, "the page's agent tokens");
  }

  /**
   * Refreshes the shown roles when the next invite-made grant ends: calls
   * check the end themselves, but the roster in the widget should not wait
   * for some other change to show it.
   */
  function armGrantEnd(): void {
    timers.clearTimeout(grantEndTimer);
    grantEndTimer = null;
    if (closed) return;
    const now = clock();
    let next = Infinity;
    for (const grant of grants.values()) {
      if (grant.endsAt !== undefined && grant.endsAt > now) next = Math.min(next, grant.endsAt);
    }
    if (next === Infinity) return;
    // An end read back from storage can lie past the timer maximum, which
    // would fire at once and rearm forever; waking early only rearms.
    grantEndTimer = timers.setTimeout(
      () => {
        grantEndTimer = null;
        setState({});
        armGrantEnd();
      },
      Math.min(next - now, MAX_TIMER_MS),
    );
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

  /**
   * callerRole before the invoke's own claim, for a user the roster lists as
   * `listed`. An invite-made grant gives nothing past its end, and never
   * more than its invite's role (S14). autoApprove lets in members only: an
   * invitee comes in through an invite this page honoured, or not at all,
   * whatever the relay says (ADR 0017's notes).
   */
  function pageRole(userId: string, listed: Role): Role | null {
    if (revoked.has(userId)) return null;
    const grant = grants.get(userId);
    let granted: Role;
    if (grant) {
      if (grant.endsAt !== undefined && clock() >= grant.endsAt) return null;
      // Past a live session's end, before its end has run, an invite or token lets in nobody (ADR 0043).
      if (grant.inviteId !== undefined && session !== null && clock() >= session.endsAt) {
        return null;
      }
      granted = grant.inviteRole === 'observer' ? 'observer' : grant.role;
    } else {
      if (policy.autoApprove !== 'observer' || isInvitee(userId)) return null;
      granted = 'observer';
    }
    return granted === 'observer' || listed === 'observer' ? 'observer' : 'driver';
  }

  function rolesFor(roster: readonly AttachmentView[]): PageRole[] {
    return roster.map(({ userId, role }) =>
      Object.freeze({
        userId,
        role: pageRole(userId, role),
        revoked: revoked.has(userId),
        inviteRole: grants.get(userId)?.inviteRole ?? null,
      }),
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
        onInvites(frame);
        return;
      case 'invoke':
        onInvoke(frame);
        return;
      case 'cancel':
        onCancel(frame.callId);
        return;
      case 'proposal':
        onProposal(frame);
        return;
      case 'proposal_end':
        onProposalEnd(frame);
        return;
      case 'session':
        onSession(frame);
        return;
      case 'agents':
        onAgents(frame);
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
    // Invites belong to their page session too: a relay that did not resume it
    // holds none of them (a restart ends every invite, ADR 0019), and the
    // invites frame that follows a resumed welcome prunes what it ended.
    if (!samePage) {
      for (const inviteId of [...invites.keys()]) forgetInvite(inviteId, 'link_down');
    }
    cancelSent.clear();
    grantsPage = frame.pageId;
    saveGrants();
    sessionWelcome(frame);
    frameLimit = Math.max(MIN_FRAME_BYTES, Math.min(MAX_FRAME_BYTES, frame.limits.maxFrameBytes));
    resultLimit = Math.max(
      MARKER_ROOM * 2,
      Math.min(MAX_RESULT_CHARS, frame.limits.maxResultChars),
    );
    imageWelcome(frame);
    // Never shorter than the protocol's own: a tiny value would turn the
    // watchdog into a reconnect loop. Nor past the timer maximum: the schema
    // takes any positive integer, and a longer timer fires at once in
    // Chromium, the same loop (ADR 0030, as for deadlineMs).
    silenceLimit = Math.min(
      MAX_TIMER_MS,
      Math.max(IDLE_TIMEOUT_MS, frame.limits.idleTimeoutMs) + SILENCE_GRACE_MS,
    );
    armWatchdog();
    setState({
      link: 'linked',
      pageId: frame.pageId,
      pairing: frame.pairing,
      roster: frame.roster,
      error: null,
      seatLimits: seatLimitsOf(frame.limits),
    });
    log.info(frame.resumed ? `resumed page ${frame.pageId}` : `linked as page ${frame.pageId}`);
    for (const userId of revoked) send({ t: 'revoke', userId });
    takeLock(frame.pageId);
    lastToolsKey = null;
    // State goes before tools (ADR 0040): the relay serves reads again only
    // once the tools frame comes, so no reader sees the null a sleep left.
    stateWelcome(frame);
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
    rolesUnanswered.shift();
    for (let at = rolesUnanswered.length - 1; at >= 0; at -= 1) {
      if (!listed.has(rolesUnanswered[at]?.userId ?? '')) rolesUnanswered.splice(at, 1);
    }
    const seats = seatsAnswered(attachments);
    // A seat notice lasts while its user is still an observer, and a newer seat replaces it.
    const observers = new Set(
      attachments.filter((entry) => entry.role === 'observer').map((entry) => entry.userId),
    );
    const fresh = new Set(seats.map((seat) => seat.user.userId));
    const kept = state.observerSeats.filter(
      (seat) => observers.has(seat.user.userId) && !fresh.has(seat.user.userId),
    );
    setState({ roster: attachments, observerSeats: [...seats, ...kept] });
    proposalsRoster();
  }

  /**
   * What the relay made of each driver the operator asked for, once its
   * roster can say: logged as it is, never as asked, and an ObserverSeat for
   * each the driver limit held back. The roster carries no reason, so the
   * limit is named only when the other drivers it lists fill maxDrivers; a
   * promotion the relay refused for another reason, such as too many
   * promotions this window, is logged as kept. A promotion is judged only by
   * a roster that can be its answer; one that arrives earlier was sent before
   * the relay read the click. Rosters sent for other events can still come
   * first, so someone said to be an observer stays watched, and should the
   * relay's answer then seat them as a driver, the log says that too and the
   * seat, with its notice, goes.
   */
  function seatsAnswered(attachments: readonly AttachmentView[]): ObserverSeat[] {
    const seats: ObserverSeat[] = [];
    for (const [userId, asked] of [...askedDriver]) {
      const entry = attachments.find((attachment) => attachment.userId === userId);
      if (!entry) {
        // Not attached yet, for Allow as driver; detached, for Make driver.
        if (asked.asked === 'promote') askedDriver.delete(userId);
        continue;
      }
      const who = logName(entry);
      if (entry.role === 'driver') {
        askedDriver.delete(userId);
        log.info(asked.asked === 'allow' ? `${who} joined as driver` : `set ${who} to driver`);
        continue;
      }
      if (asked.saidObserver) continue;
      if (asked.sent !== null && rolesUnanswered.includes(asked.sent)) continue;
      const drivers = attachments.filter(
        (other) => other.role === 'driver' && other.userId !== userId,
      ).length;
      if (drivers < effective().maxDrivers) {
        if (asked.asked === 'allow') {
          // The first roster that lists someone new is the relay's answer.
          askedDriver.delete(userId);
          log.info(`${who} joined as observer`);
        } else {
          asked.saidObserver = true;
          // ADR 0044: a watcher the people had no seat for is told of, as the driver limit is.
          if (noPeopleSeat(state.seatLimits, attachments, entry)) {
            log.info(`${who} is still an observer: no seat left among the people`);
            seatSeq += 1;
            seats.push(
              Object.freeze({
                seq: seatSeq,
                user: Object.freeze({ ...asked.user }),
                account: null,
                asked: asked.asked,
                time: clock(),
                heldBy: 'people' as const,
              }),
            );
          } else log.info(`the relay kept ${who} an observer`);
        }
        continue;
      }
      log.info(
        `${who} ${asked.asked === 'allow' ? 'joined as observer' : 'is still an observer'}: the page already has its maximum drivers (${String(effective().maxDrivers)})`,
      );
      if (asked.asked === 'allow') askedDriver.delete(userId);
      else asked.saidObserver = true;
      seatSeq += 1;
      seats.push(
        Object.freeze({
          seq: seatSeq,
          user: Object.freeze({ ...asked.user }),
          account: asked.account === null ? null : Object.freeze({ ...asked.account }),
          asked: asked.asked,
          time: clock(),
        }),
      );
    }
    return seats;
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
    // A decision sent before the drop may never have been applied; the next
    // welcome's roster shows each seat as it is, with nothing to announce.
    askedDriver.clear();
    rolesUnanswered.length = 0;
    // A mint the relay has not answered may or may not have reached it. The
    // page forgets it, so nothing honours its link, and should a resumed
    // relay list it, the page closes it as one it holds no record of.
    for (const inviteId of [...minting.keys()]) forgetInvite(inviteId, 'link_down');
    listings = new Map();
    stateLinkDown();
    proposalsLinkDown();
    // What this link's relay said of itself goes with it, until the next welcome says again.
    setState({
      pairing: null,
      pendingRequests: [],
      pendingConfirms: [],
      invites: [],
      invitesOffered: null,
      maxImageBytes: null,
      sessionsOffered: false,
      agents: [],
      agentsOffered: null,
      seatLimits: null,
    });
  }

  function stopForGood(error: string | null): void {
    closed = true;
    timers.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    timers.clearTimeout(grantEndTimer);
    grantEndTimer = null;
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
    const notice = needsHintNotice(snapshot.hintSupport, policy)
      ? HINT_NOTICES[options.policyFrom ?? 'attach']
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
    const tools = fitTools(snapshot.tools.map((tool) => wireTool(tool.page, snapshot)));
    const key = JSON.stringify(tools);
    if (key === lastToolsKey) return;
    if (send({ t: 'tools', tools })) lastToolsKey = key;
  }

  /**
   * A tool as the tools frame carries it: marked consequential: true when
   * ADR 0002's rule classes it so, whose inputs (the runtime's hint support
   * and this page's list) only the page has, so the relay knows when a page
   * that opted in may have the caller confirm in their client (ADR 0026).
   * Marked whatever confirmVia and the consequential policy say, since the
   * mark says what the tool is, not who confirms; the page's own rule, not
   * the mark, still decides whether it prompts. Unmarked tools carry no key,
   * so their entries stay as an older adapter sent them.
   */
  function wireTool(tool: PageTool, snapshot: ToolSnapshot): PageTool {
    return isConsequential(tool, snapshot.hintSupport, policy)
      ? { ...tool, consequential: true }
      : tool;
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
    // S6: an id that named a prompt keeps naming only that prompt
    // (REMEMBERED_PROMPT_IDS), so an answer meant for it settles no other call.
    if (promptedIds.has(frame.callId)) {
      log.warn(`ignored an invoke under call ${frame.callId}, whose id a prompt here has used`);
      return;
    }
    const now = clock();
    const deadlineMs = Math.min(frame.deadlineMs, MAX_DEADLINE_MS);
    const { userId, displayName, client } = frame.caller;
    // ADR 0042: bound now, and spent, or never; check() refuses an invoke naming a proposal it did not bind.
    const proposal = bindProposal(frame);
    const entry: ActivityEntry = Object.freeze({
      callId: frame.callId,
      time: now,
      user: Object.freeze({ userId, displayName }),
      client: client === null ? null : Object.freeze({ ...client }),
      tool: frame.tool,
      outcome: 'running',
      confirmedBy: null,
      durationMs: null,
      handlerRunning: false,
      image: null,
      proposalId: proposal === null ? null : proposal.view.proposalId,
      acceptedOnPage: proposal !== null,
    });
    const call: CallRecord = {
      frame,
      seq: nextSeq++,
      deadlineAt: now + deadlineMs,
      controller: new AbortController(),
      entry,
      stage: 'admitting',
      finished: false,
      executing: false,
      deadline: null,
      confirm: null,
      proposal,
    };
    calls.set(frame.callId, call);
    setState({ activity: [entry, ...state.activity].slice(0, ACTIVITY_LIMIT) });
    call.deadline = timers.setTimeout(() => {
      onDeadline(call);
    }, deadlineMs);
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
    log.info(`call ${callId} ${tool} by ${logName(caller)} (${caller.role}): ${outcome}`);
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

  /** Replaces the call's running line in the activity log with how it ended, and any image's type and size. */
  function settleEntry(call: CallRecord, outcome: ActivityOutcome, image?: ResultImage): void {
    updateEntry(call, {
      outcome,
      durationMs: Math.max(0, clock() - call.entry.time),
      handlerRunning: call.executing,
      ...(image && { image: Object.freeze({ mimeType: image.mimeType, bytes: image.bytes }) }),
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
    // As in finish: a lost link must not leave the gate to the hold timer.
    freeImageSlot(call.executing ? null : call);
  }

  function finish(call: CallRecord, outcome: Outcome): void {
    if (call.finished) return;
    call.finished = true;
    timers.clearTimeout(call.deadline);
    settleConfirmPromise(call, false);
    const { callId } = call.frame;
    const frame = outcome.ok ? resultFrame(callId, outcome.content, outcome.image) : null;
    // An image is never cut, so one that leaves no room on this link is refused whole (ADR 0039).
    const ended: Outcome =
      outcome.ok && frame === null
        ? {
            ok: false,
            code: 'tool_error',
            message: "the image is too large for this relay's page link",
          }
        : outcome;
    const image = ended.ok ? ended.image : undefined;
    // S7: the type and size, never the data.
    logCall(
      call,
      ended.ok ? (image ? `ok, an ${image.mimeType} of ${image.bytes} bytes` : 'ok') : ended.code,
    );
    if (frame) send(frame);
    else if (!ended.ok) {
      send({
        t: 'result',
        callId,
        ok: false,
        error: { code: ended.code, message: ended.message.slice(0, MAX_ERROR_CHARS) },
      });
    }
    settleEntry(call, ended.ok ? 'ok' : ended.code, image);
    release(call);
    // A call answered before its handler started gives up the image gate, and
    // one answered while it waited leaves it, its handler never run (S8).
    freeImageSlot(call.executing ? null : call);
  }

  /**
   * Cuts the text to the result limit, then further if JSON escaping or UTF-8
   * still overflow the frame. An image beside it is never cut: null when the
   * frame cannot fit it even with the text gone.
   */
  function resultFrame(
    callId: string,
    content: string,
    image?: ResultImage,
  ): PageFrameInput | null {
    const extra = image && { image: { mimeType: image.mimeType, data: image.data } };
    let max = content.length > resultLimit ? resultLimit - MARKER_ROOM : content.length;
    for (;;) {
      const text = max >= content.length ? content : truncate(content, max).text;
      const frame = { t: 'result', callId, ok: true, content: text, ...extra } as const;
      const size = byteLength(encodeFrame(frame));
      if (size <= frameLimit) return frame;
      if (max === 0) return extra ? null : frame;
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
   * it waited. An observer's write runs only as a proposal this page's own
   * record shows the operator accepted (ADR 0042), never on the relay's word,
   * and only while the policy in force still takes proposals from them.
   */
  function check(call: CallRecord, snapshot: ToolSnapshot | null): Checked {
    const { frame, proposal } = call;
    const role = callerRole(frame.caller);
    if (role === null) {
      return refuse('role_denied', 'the operator has not approved this caller on this page');
    }
    if (
      frame.proposal !== undefined &&
      (proposal === null || !takesFrom(frame.caller.userId, proposal.agent))
    ) {
      return refuse('role_denied', 'the page holds no accepted proposal for this call');
    }
    if (!snapshot) return refuse('tool_error', 'the page could not list its tools');
    const tool = snapshot.byName.get(frame.tool);
    if (!tool) return refuse('tool_not_found', `no tool named ${frame.tool}`);
    if (role === 'observer' && proposal === null && !isReadOnly(tool.page)) {
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
    const checked = check(call, snapshot);
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
    const checked = check(call, snapshot);
    if (!checked.ok) {
      finish(call, checked.refusal);
      return;
    }
    // check() refuses a missing snapshot, so this only narrows the type.
    if (snapshot) await proceed(call, checked.tool, snapshot);
  }

  /** Consequential policy and the operator's confirmation, the image gate, then the handler. */
  async function proceed(
    call: CallRecord,
    tool: NormalisedTool,
    snapshot: ToolSnapshot,
  ): Promise<void> {
    const { frame } = call;
    const rule = isConsequential(tool.page, snapshot.hintSupport, policy) && policy.consequential;
    if (rule === 'deny') {
      finish(call, {
        ok: false,
        code: 'denied_by_operator',
        message: 'this page does not run consequential tools',
      });
      return;
    }
    let byClient = rule === 'confirm' && takesClientConfirmation(call);
    // ADR 0042: the operator's armed Accept on the page was this call's
    // confirmation (S6), so the page does not ask again; under deny it was
    // refused above all the same.
    const accepted = rule === 'confirm' && call.proposal !== null;
    if (accepted) {
      logCall(
        call,
        `accepted on the page as proposal ${call.proposal?.view.proposalId ?? ''}, so the page did not ask again`,
      );
    }
    // ADR 0039: the operator answers before an image call waits at the gate,
    // so a prompt left open holds no other capture back.
    if (rule === 'confirm' && !byClient && !accepted && !(await operatorAllows(call, snapshot))) {
      return;
    }
    const imageTool = policy.imageTools.includes(tool.page.name);
    if (imageTool) {
      if (!(await takeImageSlot(call, snapshot))) return;
      // Only a change made during the wait can end what let the client
      // confirm; the page then asks, holding the gate.
      if (byClient && !takesClientConfirmation(call)) {
        byClient = false;
        if (!(await operatorAllows(call, snapshot))) return;
      }
    }
    if (byClient) {
      // Nothing is awaited between check() and the handler, so the grant,
      // roster and role this read are the ones the call runs under.
      logCall(call, 'confirmed in their client, so the page did not ask');
      updateEntry(call, { confirmedBy: 'client' });
    }
    call.stage = 'running';
    call.executing = true;
    let outcome: Outcome;
    let unwatched = false;
    try {
      // An accepted proposal runs the page's own copy, which its invoke had to match.
      const value = await execute(tool.runtime, call.proposal?.args ?? frame.arguments, call);
      outcome = imageTool
        ? imageOutcome(resultText(value))
        : { ok: true, content: resultText(value) };
    } catch (error) {
      outcome = { ok: false, code: 'tool_error', message: errorParts(error).message };
      unwatched = await lostSightOfHandler(call, tool, error);
    }
    // The runtime has settled the call, so the next image call may start.
    freeImageSlot(call);
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

  /**
   * S6 under ADR 0026: whether an invoke's confirmation lets this
   * consequential call skip the on-page prompt. The relay's word is taken
   * only where this page itself would have let the caller confirm: its own
   * attach() policy chose confirmVia 'client' under consequential 'confirm',
   * the caller's id is a member's, this page's own grant for them names no
   * invite (nor does the roster's entry, which can only refuse here), and the
   * least of that grant, the roster and the invoke's role is driver. proceed
   * asks only for a tool the page's own rule calls consequential, so a tool
   * the relay calls consequential and the page does not runs as it always
   * did. Anything else prompts exactly as before, so a crafted frame skips no
   * prompt on a page that did not opt in, nor for an invitee, an invite-made
   * attachment or an observer.
   */
  function takesClientConfirmation(call: CallRecord): boolean {
    const { frame } = call;
    if (frame.confirmation === undefined) return false;
    const problem = clientConfirmationProblem(frame);
    if (problem === null) return true;
    logCall(call, `asking on the page, as ${problem}, whatever the relay says of their client`);
    return false;
  }

  /**
   * Why the page asks despite an invoke's confirmation, or null when it may
   * take it; see takesClientConfirmation, which proceed calls only under
   * consequential 'confirm'. A caller with no grant here never passes the
   * last check: callerRole gives driver only through a grant.
   */
  function clientConfirmationProblem(frame: InvokeFrame): string | null {
    if (policy.confirmVia !== 'client') return "this page's policy has the operator confirm";
    const { userId } = frame.caller;
    if (isInvitee(userId)) return 'the caller is an invitee';
    if (grants.get(userId)?.inviteId !== undefined) return "an invite made the caller's grant";
    const listed = state.roster.find((attachment) => attachment.userId === userId);
    if ((listed?.inviteId ?? null) !== null) {
      return "the relay lists the caller's attachment as an invite's";
    }
    if (callerRole(frame.caller) !== 'driver') return 'the caller is not a driver here';
    return null;
  }

  /** The operator's prompt; false when they deny it or the call ended meanwhile. */
  async function operatorAllows(call: CallRecord, snapshot: ToolSnapshot): Promise<boolean> {
    const allowed = await askConfirm(call);
    if (!allowed && !isDone(call)) {
      finish(call, {
        ok: false,
        code: 'denied_by_operator',
        message: 'the operator denied this call',
      });
    }
    // The operator may have lowered this caller's role while the prompt was up.
    return allowed && checkedAgain(call, snapshot);
  }

  /** check() once more after an await, since the roster, grants and tools may have changed. */
  function checkedAgain(call: CallRecord, snapshot: ToolSnapshot): boolean {
    if (isDone(call)) return false;
    const again = check(call, snapshot);
    if (!again.ok) finish(call, again.refusal);
    return again.ok;
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
      call.confirm = { resolve, port, pending };
      rememberPrompt(callId);
      setState({ pendingConfirms: [...state.pendingConfirms, pending] });
      const ui = options.ui;
      if (!ui?.askConfirm) return;
      Promise.resolve()
        .then(() => ui.askConfirm?.(pending, port.signal))
        .then(
          (answer) => {
            if (typeof answer !== 'boolean') return;
            // Only while this very prompt still waits, as for attach requests
            // (show): a port that ignores its signal can answer after the
            // prompt was settled, by then perhaps under an id the page has
            // since forgotten and the relay reused for another tool.
            if (port.signal.aborted || call.confirm?.port !== port) {
              log.warn('ignored a UI port answer to a confirmation that was already settled');
              return;
            }
            settleConfirmPromise(call, answer);
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
      pendingConfirms: state.pendingConfirms.filter((item) => item !== confirm.pending),
    });
    confirm.resolve(allow);
  }

  /** Oldest first, so passing the bound needs that many newer prompts before the operator. */
  function rememberPrompt(callId: string): void {
    promptedIds.add(callId);
    if (promptedIds.size <= REMEMBERED_PROMPT_IDS) return;
    const oldest = promptedIds.values().next();
    if (oldest.done !== true) promptedIds.delete(oldest.value);
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
      // Never the secret: checkRedemption checks it against this page's own record, and no state shows it (ADR 0017).
      invite:
        frame.invite === undefined
          ? null
          : Object.freeze({ inviteId: frame.invite.inviteId, label: frame.invite.label }),
      // Never the token either: checkAgent checks it against this page's own record (ADR 0044).
      agent:
        frame.agent === undefined
          ? null
          : Object.freeze({ tokenId: frame.agent.tokenId, label: frame.agent.label }),
      client: frame.client,
      expiresAt,
    });
    const record: RequestRecord = {
      request,
      timer: null,
      port: new AbortController(),
      shown: false,
      secret: frame.invite?.secret ?? frame.agent?.secret ?? null,
      verified: false,
    };
    record.timer = timers.setTimeout(
      () => {
        decide(record, false, undefined, 'timeout');
      },
      Math.max(0, expiresAt - now),
    );
    requests.set(frame.requestId, record);
    log.info(`attach request from ${logName(frame.user)} via ${frame.via}`);
    // An agent token is never approved in advance (S4): its request reaches
    // the operator only once it checks out against this page's own record.
    if (frame.agent !== undefined) {
      void checkAgent(record);
      return;
    }
    if (frame.invite !== undefined) {
      void checkRedemption(record);
      return;
    }
    // Pairing codes are for members: the relay answers an invitee's with
    // invite_required (ADR 0017), so one that reaches the page is the relay's
    // mistake or its lie, and no operator should be asked to judge it.
    if (isInvitee(frame.user.userId)) {
      log.warn(
        `refused a ${frame.via} request from ${logName(frame.user)}: an invitee joins only by invite`,
      );
      decide(record, false, undefined, 'rule');
      return;
    }
    show(record);
  }

  /** Puts a request before the operator: in the widget, and through the UI port when there is one. */
  function show(record: RequestRecord): void {
    record.shown = true;
    const { request } = record;
    setState({ pendingRequests: [...state.pendingRequests, request] });
    const ui = options.ui;
    if (!ui?.askAttach) return;
    Promise.resolve()
      .then(() => ui.askAttach?.(request, record.port.signal))
      .then(
        (answer) => {
          if (answer === undefined) return;
          // Only while this very request still waits. A port that ignores its
          // signal can answer after the prompt was settled, by then perhaps
          // under an id the relay has reused for a redemption whose secret is
          // still being checked; that answer was never about it.
          if (record.port.signal.aborted || requests.get(request.requestId) !== record) {
            log.warn('ignored a UI port answer to an attach request that was already settled');
            return;
          }
          if (answer === 'deny') decide(record, false, undefined, 'operator');
          else decide(record, true, answer, 'operator');
        },
        (error: unknown) => {
          log.warn(`the UI port failed to ask about an attach request: ${describe(error)}`);
        },
      );
  }

  /**
   * S14: a redemption is honoured only against this page's own record and
   * the secret the relay presented, whose hash must be the one this page
   * kept, so a relay that never saw a link cannot redeem it. Then a Can watch
   * invite lets its holder in as observer without a prompt, approval given
   * in advance as autoApprove gives it (ADR 0016), and a Can control one asks
   * the operator. Anything else is refused without troubling the operator:
   * only a relay's mistake or lie could have sent it.
   */
  async function checkRedemption(record: RequestRecord): Promise<void> {
    const { request } = record;
    const secret = record.secret;
    record.secret = null;
    const inviteId = request.invite?.inviteId ?? '';
    const kept = invites.get(inviteId);
    let matches = false;
    if (kept && secret !== null && webCrypto) {
      try {
        // Both sides are digests of a secret, so how long the comparison takes says nothing about it.
        matches = (await sha256Hex(webCrypto, secret)) === kept.secretHash;
      } catch (error) {
        log.warn(`could not hash a presented invite secret: ${describe(error)}`);
      }
    }
    // Answered meanwhile: expired, revoked, the invite closed, or the link lost.
    if (requests.get(request.requestId) !== record) return;
    const problem = !kept
      ? 'this page holds no record of it'
      : !webCrypto
        ? 'this page has no WebCrypto to check its secret'
        : !matches
          ? "the secret presented is not the one this page's record was made from"
          : redemptionProblem(request);
    if (problem !== null || !kept) {
      log.warn(
        `refused a redemption of invite ${inviteId} by ${logName(request.user)}: ${problem ?? 'this page holds no record of it'}`,
      );
      decide(record, false, undefined, 'rule');
      return;
    }
    record.verified = true;
    if (kept.role === 'observer') {
      decide(record, true, 'observer', 'invite');
      return;
    }
    show(record);
  }

  /**
   * Whatever about an invite's own record stops a redemption now, beyond its
   * secret, or null. Checked when the secret checks out and again as the
   * operator approves, since a prompt can outlive the invite's terms.
   */
  function redemptionProblem(request: PendingRequest): string | null {
    const invite = request.invite === null ? undefined : invites.get(request.invite.inviteId);
    if (!invite || request.invite === null) return 'this page holds no record of it';
    const { userId } = request.user;
    if (request.invite.label !== invite.label) return 'the relay named it by a label it never had';
    // The page's policy as it stands now, which a reload may have narrowed since minting.
    if (policy.invites === 'off' || (invite.role === 'driver' && policy.invites !== 'all')) {
      return "the page's policy no longer allows it";
    }
    if (clock() >= inviteEnd(invite)) return 'it has expired';
    // A live session ends every invite with it, however long its own life (ADR 0043).
    if (session !== null && clock() >= session.endsAt) return 'the session has ended';
    if (invite.usesLeft <= 0) return 'it is used up';
    if (invite.refusals >= INVITE_BURN_REFUSALS) return 'three refusals burnt it';
    if (invite.barred.includes(userId)) return 'the operator revoked this account from it';
    // No redemption clears a revoke (ADR 0017), not even one the operator approves.
    if (revoked.has(userId)) return 'the operator revoked this account';
    // For someone already attached a redemption changes nothing (ADR 0017).
    if (state.roster.some((attachment) => attachment.userId === userId)) {
      return 'the account is already attached';
    }
    // A Can control invite allows one prompt at a time (S14).
    if (invite.role === 'driver') {
      for (const other of requests.values()) {
        if (
          other.shown &&
          other.request !== request &&
          other.request.invite?.inviteId === invite.inviteId
        ) {
          return 'another redemption of it is waiting for the operator';
        }
      }
    }
    return null;
  }

  /** The waiting request under this id, if the operator was shown it; nothing else is theirs to answer. */
  function shownRecord(requestId: string): RequestRecord | null {
    const record = requests.get(requestId);
    return record?.shown === true ? record : null;
  }

  /**
   * Answers one request, which must be the very record still waiting under
   * its id: anything that took longer to answer than the request lived, such
   * as a UI port or a timer, holds a record the relay may since have
   * replaced with another under the same id.
   */
  function decide(
    record: RequestRecord,
    allow: boolean,
    role?: Role,
    cause: DecisionCause = 'operator',
  ): boolean {
    const { request } = record;
    const { requestId } = request;
    if (requests.get(requestId) !== record) return false;
    if (allow && !RoleSchema.safeParse(role).success) {
      log.warn('ignored an approval without a valid role');
      return false;
    }
    const inviteId = request.invite?.inviteId;
    const invite = inviteId === undefined ? undefined : invites.get(inviteId);
    const agentId = request.agent?.tokenId;
    const agent = agentId === undefined ? undefined : agentRecords.get(agentId);
    let granted = role;
    if (allow && agentId !== undefined) {
      // S4 and S5: never a token this page has not matched to its record,
      // never past the record's terms now, and only ever an observer.
      const problem = record.verified ? agentProblem(request) : 'unchecked';
      if (problem !== null || !agent) {
        log.warn(`refused agent token ${agentId}: ${problem ?? 'no record'}`);
        return decide(record, false, undefined, 'rule');
      }
      granted = 'observer';
    }
    if (allow && inviteId !== undefined) {
      // S14: never a redemption whose secret this page has not matched to its
      // record, whoever approves it, and never past the record's terms now.
      const problem = record.verified
        ? redemptionProblem(request)
        : 'its secret has not been checked';
      if (problem !== null || !invite) {
        log.warn(
          `refused a redemption of invite ${inviteId} by ${logName(request.user)}: ${problem ?? 'this page holds no record of it'}`,
        );
        return decide(record, false, undefined, 'rule');
      }
      // Never above the invite's role, whatever the operator or a UI port chose (S14).
      if (invite.role === 'observer') granted = 'observer';
    }
    requests.delete(requestId);
    timers.clearTimeout(record.timer);
    record.port.abort();
    if (record.shown) {
      setState({
        pendingRequests: state.pendingRequests.filter((item) => item !== request),
      });
    }
    // The first approval wins, as on the relay, which keeps an existing
    // attachment as it is (role changes are set_role's job, from M2). It wins
    // only while the roster lists the user: a grant for a user the relay never
    // attached came from an approval it ignored (one that crossed the request's
    // expiry), so this decision is the one the relay will apply. For a listed
    // user a denial, or silence, answers only this request and leaves the
    // grant alone, since the relay keeps them attached (ADR 0007); withdrawing
    // access is revoke's job. For anyone else it withdraws that ignored grant,
    // so the operator's latest decision stands.
    const { userId } = request.user;
    const listed = state.roster.some((attachment) => attachment.userId === userId);
    // A revoke the relay has yet to apply ends that attachment before this decision makes another.
    const keptAttachment = revoked.has(userId)
      ? undefined
      : state.roster.find((attachment) => attachment.userId === userId);
    if (allow && granted !== undefined && agent) {
      agentGranted(userId, agent);
    } else if (allow && granted !== undefined && invite && inviteId !== undefined) {
      // An invite-made grant ends 24 hours after redemption and names the
      // invite's role as its cap (ADR 0017); its use is spent here, on the
      // page's own count, whatever the relay counts.
      const now = clock();
      setGrant(userId, {
        role: granted,
        inviteId,
        endsAt: now + MAX_INVITE_LIFETIME_MS,
        inviteRole: invite.role,
      });
      updateInvite({ ...invite, usesLeft: invite.usesLeft - 1 });
      // The widget's notice comes from here, the page's own decision, never from the roster.
      joinSeq += 1;
      const join: InviteJoin = Object.freeze({
        seq: joinSeq,
        user: Object.freeze({ ...request.user }),
        account: Object.freeze({ ...request.account }),
        inviteId,
        label: invite.label,
        time: now,
      });
      setState({ joins: [join, ...state.joins] });
    } else if (allow && granted !== undefined) {
      // An approval after a revoke lets the user back in; the relay applies
      // the two in that order too. A redemption never does (redemptionProblem).
      forgetRevokes([userId]);
      if (!listed || !grants.has(userId)) setGrant(userId, { role: granted });
    }
    if (!allow && !listed) pruneGrants([userId]);
    if (!allow && invite && record.shown && (cause === 'operator' || cause === 'timeout')) {
      updateInvite({ ...invite, refusals: Math.min(INVITE_BURN_REFUSALS, invite.refusals + 1) });
    }
    const burned =
      !allow && agent !== undefined && record.shown && (cause === 'operator' || cause === 'timeout')
        ? agentRefused(agent, cause)
        : false;
    const who = logName(request.user);
    askedDriver.delete(userId);
    if (!allow) {
      log.info(`denied ${who}`);
    } else if (keptAttachment) {
      // The relay keeps an attachment's role, whatever this approval named.
      log.info(
        `allowed ${who}, who is already attached as ${keptAttachment.role}; the relay keeps that role`,
      );
    } else if (granted === 'driver') {
      // The relay seats a new driver only while a driver seat is free, so
      // what they joined as is logged when its roster lists them.
      askedDriver.set(userId, {
        user: request.user,
        account: request.account,
        asked: 'allow',
        sent: null,
        saidObserver: false,
      });
      log.info(`allowed ${who}, asking the relay for a driver seat`);
    } else {
      log.info(`allowed ${who} as ${String(granted)}`);
    }
    // The relay ends every request a revoke names as it applies the revoke
    // frame, which went first; a decision would only reach a request already
    // gone there, and count against the page's budget for frames that change
    // nothing (A4.3). While the link is down the relay dropped them anyway.
    // An agent token's silence is the relay's to count: its own timer ends
    // the request as a timeout, which only the third time burns the token,
    // whereas a refusal from here reads as the operator's deny and burns it
    // at once (ADR 0044), whichever clock runs ahead. A request the relay
    // ends itself with a frame this page sends beside it, or with its own
    // session's end, gets none either, which would read there as the
    // operator's deny and close a token as denied rather than as ended or
    // cancelled (S7).
    const sent =
      cause === 'revoke' || cause === 'closing' || (cause === 'timeout' && agentId !== undefined)
        ? true
        : send({
            t: 'attach_decision',
            requestId,
            allow,
            ...(allow && granted !== undefined ? { role: granted } : {}),
          });
    // After the deny that burned it, which the relay closes the token on as
    // denied; agent_cancel then closes it too should that deny have crossed
    // the prompt's end there, and changes nothing otherwise.
    if (burned && agent) cancelAgent(agent.tokenId);
    return sent;
  }

  // Invites (ADR 0017)

  function updateInvite(invite: StoredInvite): void {
    invites.set(invite.inviteId, invite);
    saveGrants();
  }

  /** Every invite this page minted that the relay lists on the very terms it was minted with, oldest first. */
  function inviteViews(): InviteView[] {
    const views: InviteView[] = [];
    const oldestFirst = [...invites.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const invite of oldestFirst) {
      const listing = listings.get(invite.inviteId);
      if (!listing) continue;
      views.push(
        Object.freeze({
          inviteId: invite.inviteId,
          role: invite.role,
          label: invite.label,
          uses: invite.uses,
          usesLeft: Math.min(listing.usesLeft, invite.usesLeft),
          joined: invite.uses - invite.usesLeft,
          expiresAt: invite.expiresAt,
          sponsor: Object.freeze({ ...listing.sponsor }),
          pending: listing.pending,
          refusals: Math.max(listing.refusals, invite.refusals),
        }),
      );
    }
    return views;
  }

  /**
   * The page stops honouring an invite: its record goes, stored copy too, a
   * redemption of it still being checked or waiting on the operator is
   * refused (`cause`), and a mint still waiting on the relay settles with `reason`.
   */
  function forgetInvite(
    inviteId: string,
    reason: InviteRefusal,
    cause: DecisionCause = 'rule',
  ): void {
    const had = invites.delete(inviteId);
    listings.delete(inviteId);
    const mint = minting.get(inviteId);
    if (mint) {
      minting.delete(inviteId);
      timers.clearTimeout(mint.timer);
      mint.resolve(Object.freeze({ ok: false, reason }));
    }
    for (const record of [...requests.values()]) {
      if (record.request.invite?.inviteId === inviteId) decide(record, false, undefined, cause);
    }
    if (had) saveGrants();
  }

  /** Closes an invite the relay lists that this page holds no record of, once per link. */
  function closeUnknown(inviteId: string): void {
    if (cancelSent.has(inviteId) || !isLinked()) return;
    if (send({ t: 'invite_cancel', inviteId })) {
      cancelSent.add(inviteId);
      log.warn(`closed invite ${inviteId}, which this page holds no record of`);
    }
  }

  /**
   * The relay's list of this page's live invites (ADR 0017). Only invites
   * this page's own record holds, on the very terms it minted them with, are
   * shown; any other is closed, since nothing here would honour it. A record
   * the relay no longer lists was used up, cancelled or expired and goes,
   * unless its mint is still waiting for this very answer.
   */
  function onInvites(frame: InvitesFrame): void {
    const refused = frame.refused?.inviteId;
    const listed = new Map<string, InviteListing>();
    for (const listing of frame.invites) {
      const invite = invites.get(listing.inviteId);
      if (invite && sameTerms(invite, listing) && listing.inviteId !== refused) {
        listed.set(listing.inviteId, listing);
        continue;
      }
      if (invite) {
        log.warn(`the relay listed invite ${listing.inviteId} on terms this page never set`);
        forgetInvite(listing.inviteId, 'unavailable');
      }
      closeUnknown(listing.inviteId);
    }
    if (frame.refused !== undefined && minting.has(frame.refused.inviteId)) {
      log.info(`the relay refused invite ${frame.refused.inviteId}: ${frame.refused.reason}`);
      forgetInvite(frame.refused.inviteId, frame.refused.reason);
    }
    for (const inviteId of [...invites.keys()]) {
      if (!listed.has(inviteId) && !minting.has(inviteId)) forgetInvite(inviteId, 'cancelled');
    }
    listings = listed;
    setState({
      invitesOffered: Object.freeze({ linkBase: frame.linkBase }),
      invites: inviteViews(),
    });
    for (const inviteId of [...minting.keys()]) {
      if (listed.has(inviteId)) answerMint(inviteId, frame.linkBase);
    }
  }

  /** The relay listed a new invite: dock.invite() resolves with its link, the only place the secret ever goes. */
  function answerMint(inviteId: string, linkBase: string | null): void {
    const mint = minting.get(inviteId);
    if (!mint) return;
    let link: string | null;
    try {
      link = linkBase === null ? null : inviteLink(linkBase, mint.secret);
    } catch {
      link = null;
    }
    if (link === null) {
      // A relay with no public URL mints nothing (ADR 0017), so one listing an invite anyway gets it closed.
      forgetInvite(inviteId, 'no_public_url');
      closeUnknown(inviteId);
      return;
    }
    minting.delete(inviteId);
    timers.clearTimeout(mint.timer);
    log.info(`minted invite ${inviteId}`);
    mint.resolve(
      Object.freeze({
        ok: true,
        inviteId,
        link,
        expiresAt: invites.get(inviteId)?.expiresAt ?? null,
      }),
    );
  }

  /**
   * The invites this page holds that let a user in: the one their grant
   * names, and the one the roster names, which can only add to what a revoke
   * bars and closes.
   */
  function invitesOf(userId: string): string[] {
    const ids = new Set<string>();
    const own = grants.get(userId)?.inviteId;
    if (own !== undefined) ids.add(own);
    const claimed = state.roster.find((attachment) => attachment.userId === userId)?.inviteId;
    if (claimed !== undefined && claimed !== null) ids.add(claimed);
    return [...ids].filter((inviteId) => invites.has(inviteId));
  }

  /** Bars a revoked user from the invites that let them in, for each invite's life (ADR 0017). */
  function bar(userId: string, inviteIds: readonly string[]): void {
    for (const inviteId of inviteIds) {
      const invite = invites.get(inviteId);
      if (!invite || invite.barred.includes(userId)) continue;
      if (invite.barred.length >= MAX_INVITE_USES) {
        // More revokes than any invite can have uses: the relay is making up
        // who it let in, and the record could hold no more. Closing it bars everyone.
        cancelInvite(inviteId);
        continue;
      }
      invites.set(inviteId, { ...invite, barred: [...invite.barred, userId] });
    }
    saveGrants();
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
    const grant = grants.get(userId);
    // Only for someone the operator approved here, or autoApprove let in (S4):
    // otherwise even Make observer would be the approval S4 asks for, made by
    // a click meant to lower access. Revoke is what such a row needs. An
    // invitee only ever comes in through an invite this page honoured.
    if (!grant && (policy.autoApprove !== 'observer' || isInvitee(userId))) return false;
    // Never past the invite's role, nor once an invite-made attachment has
    // ended (S14); the relay refuses both as well.
    if (grant?.inviteRole === 'observer' && role === 'driver') return false;
    if (grant?.endsAt !== undefined && clock() >= grant.endsAt) return false;
    // A role change keeps whatever else the grant names, such as the invite that made it.
    setGrant(userId, { ...grant, role });
    askedDriver.delete(userId);
    if (!send({ t: 'set_role', userId, role })) return false;
    // The relay answers every set_role with a roster, even when nothing changed.
    const sent: SentRole = { userId };
    rolesUnanswered.push(sent);
    if (role === 'driver' && attachment.role !== 'driver') {
      // The relay may hold them at maxDrivers, so the log waits for its roster.
      const user = { userId: attachment.userId, displayName: attachment.displayName };
      askedDriver.set(userId, {
        user,
        account: null,
        asked: 'promote',
        sent,
        saidObserver: false,
      });
      log.info(`asked the relay to make ${logName(attachment)} a driver`);
    } else {
      log.info(`set ${logName(attachment)} to ${role}`);
    }
    return true;
  }

  /**
   * S8 on the page's side: the grant goes at once (stored copy too), so no
   * call of theirs runs here again whatever the relay does next. The revoke
   * frame goes first, so the relay answers their calls with not_attached
   * before any result below reaches it; their pending requests and prompts
   * are denied, and their calls in flight are cancelled. Someone an invite
   * let in is barred from it first, and its link closed as RevokeOptions
   * says; revoke('*') forgets every invite (ADR 0017).
   */
  function revoke(target: string, revokeOptions?: RevokeOptions): boolean {
    const everyone = target === '*';
    if (closed || (!everyone && !IdSchema.safeParse(target).success)) return false;
    // A page script can pass anything: only an explicit false keeps a link open.
    const given: unknown = revokeOptions;
    const closeInvite: unknown =
      typeof given === 'object' && given !== null
        ? (given as { closeInvite?: unknown }).closeInvite
        : undefined;
    const hits = (userId: string): boolean => everyone || userId === target;
    const listed = state.roster.map((attachment) => attachment.userId).filter(hits);
    const granted = [...grants.keys()].filter(hits);
    const asking = [...requests.values()].filter((record) => hits(record.request.user.userId));
    const running = [...calls.values()].filter((call) => hits(call.frame.caller.userId));
    const theirs = everyone ? [] : invitesOf(target);
    const closing = everyone
      ? [...invites.keys()]
      : theirs.filter((inviteId) =>
          closeInvite === undefined
            ? (invites.get(inviteId)?.uses ?? 0) > 1
            : closeInvite !== false,
        );
    const reach = listed.length + granted.length + asking.length + running.length;
    if (reach + theirs.length + closing.length === 0) return false;
    // Barred first, so nothing below can let them back in by it.
    if (!everyone) bar(target, theirs);
    for (const userId of listed) revoked.add(userId);
    for (const userId of granted) grants.delete(userId);
    // Whatever they were asked for, nothing is announced for someone revoked.
    for (const userId of [...askedDriver.keys()].filter(hits)) askedDriver.delete(userId);
    saveGrants();
    log.info(everyone ? 'the operator revoked everyone' : `the operator revoked ${target}`);
    // While the link is down, the next welcome sends it for anyone still listed.
    if (isLinked()) send({ t: 'revoke', userId: target });
    // The relay's revoke '*' cancels every invite itself; the page forgets
    // them now whatever the relay does, and closes any a resumed relay still lists.
    for (const inviteId of closing) {
      if (everyone) forgetInvite(inviteId, 'cancelled');
      else cancelInvite(inviteId);
    }
    for (const record of asking) decide(record, false, undefined, 'revoke');
    for (const call of running) {
      if (call.confirm) {
        finish(call, { ok: false, code: 'denied_by_operator', message: REVOKED_MESSAGE });
      } else {
        call.controller.abort();
        finish(call, { ok: false, code: 'cancelled', message: REVOKED_MESSAGE });
      }
    }
    proposalsRevoked(target);
    agentsRevoked(target);
    return true;
  }

  /**
   * Whether these options name an invite this page could mint: a label, a
   * role, a known lifetime, and uses only a Can watch invite may have more
   * than one of. Checked at run time, since a page script can pass anything.
   */
  function validInvite(request: InviteOptions): boolean {
    const uses: unknown = request.uses;
    const lifetime: unknown = request.lifetime;
    return (
      InviteLabelSchema.safeParse(request.label).success &&
      RoleSchema.safeParse(request.role).success &&
      (lifetime === undefined || INVITE_LIFETIMES.some((known) => known === lifetime)) &&
      (uses === undefined ||
        (typeof uses === 'number' &&
          Number.isInteger(uses) &&
          uses >= 1 &&
          uses <= (request.role === 'driver' ? CONTROL_INVITE_USES : MAX_INVITE_USES)))
    );
  }

  /**
   * Mints an invite (ADR 0017): a 128-bit secret from getRandomValues, its
   * SHA-256 kept in this page's own record and sent to the relay, and the
   * secret itself only in the link dock.invite() resolves with, once the
   * relay lists the invite. The record is stored before invite_create goes,
   * so a reload while the relay answers still knows the invite it may hold.
   */
  async function invite(request: InviteOptions): Promise<InviteResult> {
    const given: unknown = request;
    if (typeof given !== 'object' || given === null || !validInvite(request)) {
      return refuseInvite('invalid');
    }
    // ADR 0016: watch by default, so Can control needs a page that opted into 'all'.
    if (policy.invites === 'off' || (request.role === 'driver' && policy.invites !== 'all')) {
      return refuseInvite('policy');
    }
    const lifetime = lifetimeMs(request.lifetime ?? '1h');
    return mintInvite(
      request.role,
      request.label,
      request.role === 'driver' ? CONTROL_INVITE_USES : (request.uses ?? 1),
      lifetime === null ? null : clock() + lifetime,
    );
  }

  function refuseInvite(reason: InviteRefusal): InviteResult {
    return Object.freeze({ ok: false, reason });
  }

  /**
   * The mint itself, for invite() and a time-boxed session's watch invites
   * alike, its terms already checked: `expiresAt` on this page's clock, or
   * null for "while the page is open". `live` says whether what the invite
   * is for still stands once its digest is made: a session's link minted
   * after the session ended would outlive it, uncapped.
   */
  async function mintInvite(
    role: Role,
    label: string,
    uses: number,
    expiresAt: number | null,
    live: () => boolean = () => true,
  ): Promise<InviteResult> {
    const refuse = refuseInvite;
    if (!isLinked()) return refuse('link_down');
    const offered = state.invitesOffered;
    if (offered === null || !webCrypto) return refuse('unavailable');
    if (offered.linkBase === null) return refuse('no_public_url');
    if (invites.size >= MAX_LIVE_INVITES_PER_PAGE) return refuse('limit');
    const secret = randomText(webCrypto, INVITE_SECRET_BYTES);
    const inviteId = `inv_${randomText(webCrypto, INVITE_ID_BYTES)}`;
    let secretHash: string;
    try {
      secretHash = await sha256Hex(webCrypto, secret);
    } catch (error) {
      log.warn(`could not hash a new invite secret: ${describe(error)}`);
      return refuse('unavailable');
    }
    // The link may have dropped, or the page closed, while the hash was made.
    if (!isLinked()) return refuse('link_down');
    if (!live()) return refuse('cancelled');
    if (invites.size >= MAX_LIVE_INVITES_PER_PAGE) return refuse('limit');
    const record: StoredInvite = {
      inviteId,
      secretHash,
      role,
      label,
      uses,
      usesLeft: uses,
      createdAt: clock(),
      expiresAt,
      refusals: 0,
      barred: [],
    };
    invites.set(inviteId, record);
    saveGrants();
    return new Promise<InviteResult>((resolve) => {
      const timer = timers.setTimeout(() => {
        if (!minting.has(inviteId)) return;
        log.warn(`the relay never answered invite ${inviteId}; closing it`);
        forgetInvite(inviteId, 'unavailable');
        closeUnknown(inviteId);
      }, MINT_ANSWER_MS);
      minting.set(inviteId, { secret, resolve, timer });
      const sent = send({
        t: 'invite_create',
        inviteId,
        role: record.role,
        label: record.label,
        uses: record.uses,
        expiresAt: record.expiresAt,
        secretHash,
      });
      if (!sent) forgetInvite(inviteId, 'link_down');
    });
  }

  /**
   * Closes the link of an invite this page holds (invite_cancel) and forgets
   * its record at once. While the link is down nothing goes out; a resumed
   * relay that still lists it hears the cancel then, from onInvites.
   */
  function cancelInvite(inviteId: string): boolean {
    if (closed || !invites.has(inviteId)) return false;
    // The cancel first: the relay ends a redemption waiting on it as it
    // closes the invite, never as a refusal that counts toward burning it.
    if (isLinked() && send({ t: 'invite_cancel', inviteId })) cancelSent.add(inviteId);
    forgetInvite(inviteId, 'cancelled', 'closing');
    log.info(`closed invite ${inviteId}`);
    return true;
  }

  /** Calls already in the page's hands finish; every other call, now or later, is answered page_busy. */
  function pause(paused: boolean): void {
    writePaused(paused);
    if (paused === state.paused) return;
    setState({ paused });
    stateFlush();
    log.info(paused ? 'the operator paused calls' : 'the operator resumed calls');
    if (!paused) {
      pump();
      return;
    }
    for (const call of [...calls.values()]) {
      if (call.stage !== 'running') finish(call, PAUSED);
    }
  }

  // M6 seams (plan section 2.6). Each stub below does nothing, or answers a
  // refusal, until the workstream that owns it fills it in; the marker on each
  // is what tests/e2e/test/m6-seams.test.ts looks for, so none ships unbuilt.
  // Each has its final signature, so the call sites above and the handle
  // below stay as they are when its body comes.

  // Page state (ADR 0040). The page's latest value is kept as canonical
  // text, and at most one state frame goes out each STATE_MIN_INTERVAL_MS:
  // the first change after a quiet spell at once, the last of a burst when
  // the interval ends, and nothing when the relay already holds that text
  // from this link. While paused the relay is sent null, as pause refuses
  // every call, reads included. The value is never logged.

  /** The page's latest valid value as canonical text; null for nothing, or after a refusal. */
  let stateText: string | null = null;
  let stateBytes = 0;
  /** Why the page's latest value was refused, or null. */
  let stateRefused: 'too_large' | 'invalid' | null = null;
  /** What the relay holds from this link: nothing after every welcome, since a sleep drops it. */
  let sentStateText: string | null = null;
  let stateSentAt = Number.NEGATIVE_INFINITY;
  let stateTimer: unknown = null;
  /** The welcome's maxStateBytes within the protocol's own; null until a welcome names one. */
  let stateCap: number | null = null;
  /** Whether the last welcome named maxStateBytes; null before any welcome. */
  let relayTakesState: boolean | null = null;

  function publishedNow(): PublishStatus {
    if (stateRefused !== null) return stateRefused;
    if (stateText === null) return 'none';
    if (relayTakesState === false) return 'unsupported';
    return state.paused ? 'paused' : 'shared';
  }

  /** Says the status once each time it changes, never per value, so a busy page re-renders nothing. */
  function syncPublished(): void {
    const published = publishedNow();
    if (state.published === published) return;
    if (published === 'too_large') {
      log.warn(
        `page state not shared: ${stateBytes} bytes, over the ${stateCap ?? MAX_STATE_BYTES} byte limit`,
      );
    } else if (published === 'invalid') {
      log.warn('page state not shared: not a JSON object or null');
    } else if (published === 'unsupported') {
      log.warn('page state not shared: this relay does not take page state');
    }
    setState({ published });
  }

  const publishState: Dock['publishState'] = (value) => {
    const written = stateTextOf(value);
    let refusal: 'too_large' | 'invalid' | null = 'invalid';
    // A refused value clears what the relay holds rather than leave a stale one current.
    stateText = null;
    if (written !== 'invalid') {
      stateBytes = written.bytes;
      refusal = written.bytes > (stateCap ?? MAX_STATE_BYTES) ? 'too_large' : null;
      if (refusal === null) stateText = written.text;
    }
    stateRefused = refusal;
    syncPublished();
    flushState();
    return Object.freeze(refusal === null ? { ok: true } : { ok: false, reason: refusal });
  };

  function flushState(): void {
    if (!isLinked() || stateCap === null) return;
    const wanted = state.paused ? null : stateText;
    if (wanted === sentStateText) return;
    const now = clock();
    const due = stateSentAt + STATE_MIN_INTERVAL_MS;
    if (now < due) {
      // One timer for the rest of the interval, which sends whatever is latest then.
      stateTimer ??= timers.setTimeout(() => {
        stateTimer = null;
        flushState();
      }, due - now);
      return;
    }
    // The text read back, so what goes out is exactly what was measured.
    // stateTextOf checked it is an object; send() checks the frame again.
    const value = wanted === null ? null : (parseValue(wanted) as JsonObject);
    if (!send({ t: 'state', value })) return;
    sentStateText = wanted;
    stateSentAt = now;
  }

  /** Before the tools frame: the relay serves reads again only once tools come, so none sees the gap. */
  const stateWelcome = (frame: WelcomeFrame): void => {
    const offered = frame.limits.maxStateBytes;
    relayTakesState = offered !== undefined;
    stateCap = offered === undefined ? null : Math.min(MAX_STATE_BYTES, offered);
    sentStateText = null;
    stateSentAt = Number.NEGATIVE_INFINITY;
    if (stateCap !== null && stateText !== null && stateBytes > stateCap) {
      stateText = null;
      stateRefused = 'too_large';
    }
    syncPublished();
    flushState();
  };

  const stateLinkDown = (): void => {
    timers.clearTimeout(stateTimer);
    stateTimer = null;
    sentStateText = null;
  };

  const stateFlush = (): void => {
    syncPublished();
    flushState();
  };

  // Image results (ADR 0039)

  /**
   * What the welcome says the relay takes, held to the protocol's ceiling so
   * a relay's large number never lets the page send more; absent, as from a
   * 0.1.0 relay, is none, and an image tool's image is then refused here
   * rather than sent to be dropped.
   */
  const imageWelcome = (frame: WelcomeFrame): void => {
    setState({ maxImageBytes: Math.min(MAX_IMAGE_BYTES, frame.limits.maxImageBytes ?? 0) });
  };

  /**
   * A declared image tool's result: an envelope, checked here as the relay
   * checks it again (one checkImage for both); anything else stays text as
   * the runtime gave it (ADR 0001), so the tool can still answer in words.
   * The page's words beside an image are cut so the marker fits within
   * MAX_IMAGE_TEXT_CHARS, and the image never is. A relay that named no cap
   * takes none, which checkImage refuses as images off.
   */
  function imageOutcome(text: string): Outcome {
    const envelope = parseImageEnvelope(text);
    if (envelope.kind === 'text') return { ok: true, content: text };
    const refused = (message: string): Outcome => ({ ok: false, code: 'tool_error', message });
    if (envelope.kind === 'invalid') return refused(envelope.message);
    const checked = checkImage(envelope.image, state.maxImageBytes ?? 0);
    if (!checked.ok) return refused(checked.message);
    return {
      ok: true,
      content: truncate(envelope.text, MAX_IMAGE_TEXT_CHARS - MARKER_ROOM).text,
      image: { mimeType: checked.mimeType, data: envelope.image.data, bytes: checked.bytes.length },
    };
  }

  // The image gate (ADR 0039): image calls start one at a time on this page,
  // IMAGE_CALL_SPACING_MS apart, so a room capturing the projected tab cannot
  // keep it drawing; the page holds it, so no relay can get round it.
  let imageRunning: CallRecord | null = null;
  let imageStartedAt = -Infinity;
  let imageTimer: unknown = null;
  let imageHold: unknown = null;
  const imageWaiting: { call: CallRecord; go: () => void }[] = [];

  /**
   * Waits for the gate, then runs check() again, since the caller's role or
   * grant may have changed meanwhile; false when the call ended instead, its
   * handler never run (S8). Past MAX_WAITING_IMAGE_CALLS waiting, a call is
   * answered page_busy at once.
   */
  async function takeImageSlot(call: CallRecord, snapshot: ToolSnapshot): Promise<boolean> {
    if (imageWaiting.filter((waiter) => !waiter.call.finished).length >= MAX_WAITING_IMAGE_CALLS) {
      finish(call, { ok: false, code: 'page_busy', message: 'too many image calls are waiting' });
      return false;
    }
    await new Promise<void>((go) => {
      imageWaiting.push({ call, go });
      pumpImages();
    });
    return checkedAgain(call, snapshot);
  }

  /** Drops waiters already answered, then starts the next once the gate is free and the spacing passed. */
  function pumpImages(): void {
    for (const waiter of imageWaiting.filter((each) => each.call.finished)) {
      imageWaiting.splice(imageWaiting.indexOf(waiter), 1);
      waiter.go();
    }
    const next = imageWaiting[0];
    if (!next || imageRunning !== null || imageTimer !== null) return;
    const wait = imageStartedAt + IMAGE_CALL_SPACING_MS - clock();
    if (wait > 0) {
      imageTimer = timers.setTimeout(() => {
        imageTimer = null;
        pumpImages();
      }, wait);
      return;
    }
    imageWaiting.shift();
    imageRunning = next.call;
    imageStartedAt = clock();
    // A handler the runtime never settles (a polyfill 5.1 read) holds the gate no longer than this.
    imageHold = timers.setTimeout(
      () => {
        freeImageSlot(next.call);
      },
      Math.max(next.call.deadlineAt, imageStartedAt) + UNWATCHED_HANDLER_GRACE_MS - imageStartedAt,
    );
    next.go();
  }

  /** Frees the gate if `call` holds it, then lets the next waiter start. */
  function freeImageSlot(call: CallRecord | null): void {
    if (call !== null && imageRunning === call) {
      imageRunning = null;
      timers.clearTimeout(imageHold);
    }
    pumpImages();
  }

  // Proposals (ADR 0042). An observer's write reaches the page as a proposal
  // frame, never an invoke. The page takes it only under its own policy and
  // role rules, never from an agent token's caller (C13), and keeps its own
  // record of it in memory alone, never in storage, so a reload or a lost
  // link leaves nothing to accept (decision 12). The operator's Accept,
  // armed in the widget, is that call's confirmation (S6); the relay then
  // queues the call, and its invoke runs only against this page's record of
  // that Accept: the same caller, tool and canonical arguments, once, within
  // ACCEPTED_PROPOSAL_RUN_MS (S5). Arguments are shown, never logged.
  const proposals = new Map<string, HeldProposal>();

  function showProposals(): void {
    setState({
      proposals: [...proposals.values()]
        .filter((held) => held.state === 'pending')
        .map((held) => held.view),
    });
  }

  /** Whether the policy in force, a session's narrowing included, takes proposals from this caller. */
  function takesFrom(userId: string, agent: boolean): boolean {
    return proposalsAdmit(effective().proposals, {
      kind: isInvitee(userId) ? 'invitee' : 'member',
      agent,
    });
  }

  /**
   * Whether an agent token made this caller's grant (ADR 0044): an agent's id
   * is drawn from the page's id and the token's, so this page tells one from
   * its own grant, whatever the relay says.
   */
  async function isAgent(userId: string): Promise<boolean> {
    const tokenId = grants.get(userId)?.inviteId;
    const pageId = grantsPage;
    if (!isInvitee(userId) || tokenId === undefined || pageId === null || !webCrypto) return false;
    const hash = await sha256Hex(webCrypto, agentKeyInput(pageId, tokenId));
    return userId === `${INVITEE_ID_PREFIX}${hash.slice(0, 32)}`;
  }

  /** Why this page will not take the proposal now, or null; read before and after every await. */
  function proposalProblem(frame: ProposalFrame, agent: boolean): ProposalRefusal | null {
    const { userId } = frame.proposer;
    if (agent) return 'role';
    if (!takesFrom(userId, agent)) return 'policy';
    const listed = state.roster.find((attachment) => attachment.userId === userId);
    if (listed === undefined || pageRole(userId, listed.role) !== 'observer') return 'role';
    if (proposalArgumentProblem(frame.arguments) !== null) return 'too_large';
    let mine = 0;
    let all = 0;
    for (const held of proposals.values()) {
      if (held.state !== 'pending') continue;
      all += 1;
      if (held.view.proposer.userId === userId) mine += 1;
    }
    if (mine >= MAX_PENDING_PROPOSALS_PER_USER || all >= MAX_PENDING_PROPOSALS_PER_PAGE) {
      return 'limit';
    }
    return null;
  }

  function onProposal(frame: ProposalFrame): void {
    void takeProposal(frame);
  }

  async function takeProposal(frame: ProposalFrame): Promise<void> {
    const { proposalId, tool, proposer } = frame;
    const named = `proposal ${proposalId} ${tool} by ${logName(proposer)}`;
    if (proposals.has(proposalId)) {
      log.warn(`ignored a repeated ${named}`);
      return;
    }
    const link = socket;
    const refuse = (refused: ProposalRefusal): void => {
      log.info(`${named}: refused (${refused})`);
      send({ t: 'proposal_decision', proposalId, accept: false, refused });
    };
    const agent = await isAgent(proposer.userId);
    const first = proposalProblem(frame, agent);
    if (first !== null) {
      refuse(first);
      return;
    }
    const snapshot = await readTools();
    // A link that ended meanwhile took the proposal with it, on both sides.
    if (socket !== link || !isLinked() || proposals.has(proposalId)) return;
    const runtime = snapshot?.byName.get(tool);
    const canonical = canonicalJson(frame.arguments);
    const problem =
      proposalProblem(frame, agent) ??
      (runtime === undefined || isReadOnly(runtime.page) ? 'tool' : null) ??
      (canonical === null ? 'too_large' : null);
    if (problem !== null || runtime === undefined || snapshot === null || canonical === null) {
      refuse(problem ?? 'tool');
      return;
    }
    const consequential = isConsequential(runtime.page, snapshot.hintSupport, policy);
    if (consequential && policy.consequential === 'deny') {
      refuse('consequential');
      return;
    }
    const now = clock();
    const shown = escapeUnseen(encodeValue(frame.arguments) ?? '{}');
    const held: HeldProposal = {
      view: Object.freeze({
        proposalId,
        tool,
        proposer: Object.freeze({
          ...proposer,
          client: proposer.client && Object.freeze({ ...proposer.client }),
        }),
        arguments: shown,
        argumentChars: shown.length,
        consequential,
        receivedAt: now,
        expiresAt: Math.min(frame.expiresAt, now + PROPOSAL_TTL_MS),
      }),
      args: frame.arguments,
      canonical,
      agent,
      state: 'pending',
      acceptedAt: 0,
      timer: null,
    };
    held.timer = timers.setTimeout(
      () => {
        settleProposal(held, 'expired', null);
      },
      Math.max(0, held.view.expiresAt - now),
    );
    proposals.set(proposalId, held);
    showProposals();
    if (state.pageId !== null) recorder.proposal(held.view, state.pageId);
    log.info(`${named}: waiting for the operator`);
  }

  /** The proposal leaves this page's record for its log, and the session record hears how (ADR 0045). */
  function settleProposal(
    held: HeldProposal,
    outcome: ProposalOutcome,
    callId: string | null,
  ): void {
    const { proposalId, tool, proposer } = held.view;
    if (proposals.get(proposalId) !== held) return;
    proposals.delete(proposalId);
    timers.clearTimeout(held.timer);
    const entry: ProposalLogEntry = Object.freeze({
      proposalId,
      tool,
      proposer: Object.freeze({ userId: proposer.userId, displayName: proposer.displayName }),
      client: proposer.client,
      outcome,
      callId,
      time: clock(),
    });
    setState({ proposalLog: [entry, ...state.proposalLog].slice(0, ACTIVITY_LIMIT) });
    showProposals();
    recorder.proposalSettled(entry);
    log.info(`proposal ${proposalId} ${tool} by ${logName(proposer)}: ${outcome}`);
  }

  /**
   * S5 for an invoke naming a proposal: the page's own record of the
   * operator's Accept, for this caller, tool and arguments, within
   * ACCEPTED_PROPOSAL_RUN_MS of it. A match is spent at once, so a second
   * invoke under the same proposal finds nothing; anything else binds
   * nothing, and check() refuses the call.
   */
  function bindProposal(frame: InvokeFrame): HeldProposal | null {
    const proposalId = frame.proposal?.proposalId;
    if (proposalId === undefined) return null;
    const held = proposals.get(proposalId);
    if (
      held?.state !== 'accepted' ||
      clock() > held.acceptedAt + ACCEPTED_PROPOSAL_RUN_MS ||
      held.view.proposer.userId !== frame.caller.userId ||
      held.view.tool !== frame.tool ||
      held.canonical !== canonicalJson(frame.arguments)
    ) {
      log.warn(
        `call ${frame.callId} names proposal ${proposalId}, which this page holds no Accept for`,
      );
      return null;
    }
    settleProposal(held, 'accepted', frame.callId);
    return held;
  }

  function onProposalEnd(frame: ProposalEndFrame): void {
    const held = proposals.get(frame.proposalId);
    if (held === undefined) return;
    const { reason } = frame;
    settleProposal(
      held,
      held.state === 'accepted' || reason === 'not_run'
        ? 'not_run'
        : reason === 'withdrawn' || reason === 'expired'
          ? reason
          : 'cancelled',
      null,
    );
    // The relay narrowed the policy: whatever else it no longer admits goes too.
    if (reason === 'policy') proposalsPolicyChanged();
  }

  /** Proposals of those the page no longer lists, or no longer runs anything for, end with them. */
  const proposalsRoster = (): void => {
    for (const held of [...proposals.values()]) {
      const { userId } = held.view.proposer;
      const listed = state.roster.find((attachment) => attachment.userId === userId);
      if (listed === undefined || pageRole(userId, listed.role) === null) {
        settleProposal(held, 'cancelled', null);
      }
    }
  };

  const proposalsLinkDown = (): void => {
    for (const held of [...proposals.values()]) settleProposal(held, 'cancelled', null);
  };

  const proposalsRevoked = (target: string): void => {
    for (const held of [...proposals.values()]) {
      if (target === '*' || held.view.proposer.userId === target) {
        settleProposal(held, 'cancelled', null);
      }
    }
  };

  /** A session that narrowed proposals ends the pending ones it no longer admits (ADR 0043). */
  function proposalsPolicyChanged(): void {
    for (const held of [...proposals.values()]) {
      if (held.state === 'pending' && !takesFrom(held.view.proposer.userId, held.agent)) {
        settleProposal(held, 'cancelled', null);
      }
    }
  }

  /**
   * The operator's Accept: only while the proposal waits, before its end,
   * on a linked page that is not paused (decision 13), for a proposer the
   * page still lists and the policy still admits.
   */
  const acceptProposal: Dock['acceptProposal'] = (proposalId) => {
    const held = typeof proposalId === 'string' ? proposals.get(proposalId) : undefined;
    if (held?.state !== 'pending' || state.paused || !isLinked()) return false;
    const { userId } = held.view.proposer;
    const listed = state.roster.find((attachment) => attachment.userId === userId);
    if (
      clock() >= held.view.expiresAt ||
      listed === undefined ||
      pageRole(userId, listed.role) === null ||
      !takesFrom(userId, held.agent) ||
      !send({ t: 'proposal_decision', proposalId: held.view.proposalId, accept: true })
    ) {
      return false;
    }
    held.state = 'accepted';
    held.acceptedAt = clock();
    timers.clearTimeout(held.timer);
    // An Accept no invoke binds in time ends as not run.
    held.timer = timers.setTimeout(() => {
      settleProposal(held, 'not_run', null);
    }, ACCEPTED_PROPOSAL_RUN_MS);
    showProposals();
    log.info(`the operator accepted proposal ${held.view.proposalId}`);
    return true;
  };

  const dismissProposal: Dock['dismissProposal'] = (proposalId) => {
    const held = typeof proposalId === 'string' ? proposals.get(proposalId) : undefined;
    if (held?.state !== 'pending') return false;
    send({ t: 'proposal_decision', proposalId: held.view.proposalId, accept: false });
    settleProposal(held, 'dismissed', null);
    return true;
  };

  const dismissAllProposals: Dock['dismissAllProposals'] = () => {
    let dismissed = 0;
    for (const held of [...proposals.values()]) {
      if (dismissProposal(held.view.proposalId)) dismissed += 1;
    }
    return dismissed;
  };

  // Time-boxed sessions (ADR 0043). This page starts, extends and ends its
  // own; the relay applies one only within the hello's policy and holds its
  // end on its own clock, and this page holds the end on its clock too, so
  // neither a silent relay nor a frozen tab keeps a guest past it. Only a
  // session this page started is ever adopted: a relay cannot impose one,
  // nor make one longer than the operator asked. Its links show once, as an
  // invite's do, and are never stored.

  /** The session the relay listed in its last session frame on this link. */
  let relayLists: string | null = null;
  /** The last session this page ended itself; the relay hears of it while it still lists it. */
  let endedHere: string | null = null;
  /** The session this page last asked the relay to end on this link, so it asks once. */
  let endSent: string | null = null;
  /** The longest the operator asked the session to run, which no relay can pass. */
  let askedMs = 0;
  let sessionTimer: unknown = null;
  let graceTimer: unknown = null;
  /** A start waiting for the relay: its answer is null once listed, or why not. */
  let starting: {
    readonly sessionId: string;
    readonly answer: (refused: SessionFailure | null) => void;
  } | null = null;

  /** attach()'s policy as a running session narrows it; every read a session may narrow goes through here. */
  function effective(): Policy {
    return narrowPolicy(policy, session?.policy ?? null);
  }

  function sessionView(): SessionView | null {
    if (session === null) return null;
    // The sponsor the relay named for its invites, fixed at minting (ADR 0017).
    let sponsor: User | null = null;
    for (const inviteId of session.inviteIds) sponsor ??= listings.get(inviteId)?.sponsor ?? null;
    return Object.freeze({
      sessionId: session.sessionId,
      label: session.label,
      startedAt: session.startedAt,
      endsAt: session.endsAt,
      lengthMinutes: session.lengthMs / SESSION_LENGTH_UNIT_MS,
      policy: effective(),
      observers: session.observers,
      inviteIds: [...session.inviteIds],
      sponsor: sponsor === null ? null : { ...sponsor },
    });
  }

  /** Every change to the session ends here, so storage and the state shown match memory. */
  function showSession(): void {
    writeStored(sessionKey, session && JSON.stringify(session), "the page's session");
    setState({ session: sessionView(), records: recorder.views() });
  }

  function armSessionEnd(): void {
    timers.clearTimeout(sessionTimer);
    sessionTimer = null;
    if (session === null || closed) return;
    sessionTimer = timers.setTimeout(
      () => {
        sessionTimer = null;
        if (session === null || closed) return;
        if (clock() >= session.endsAt) finishSession('time', true);
        else armSessionEnd();
      },
      Math.min(Math.max(0, session.endsAt - clock()), MAX_TIMER_MS),
    );
  }

  /**
   * The drivers past `seats`, newest grant first as the relay picks them,
   * become observers on this page at once, before the relay hears (S5).
   */
  function demoteBeyond(seats: number): void {
    const drivers = state.roster
      .filter((entry) => entry.role === 'driver')
      .sort((a, b) => a.grantedAt - b.grantedAt);
    for (const entry of drivers.slice(seats)) setRole(entry.userId, 'observer');
  }

  /** Asks the relay to end a session it lists, once per link. */
  function endListed(sessionId: string): void {
    if (endSent !== sessionId && isLinked() && send({ t: 'session_end', sessionId })) {
      endSent = sessionId;
    }
  }

  /** The relay hears of an end this page made only while it still lists that session. */
  function tellEnd(): void {
    if (endedHere !== null && relayLists === endedHere) endListed(endedHere);
  }

  const sessionWelcome = (frame: WelcomeFrame): void => {
    relayLists = null;
    endSent = null;
    if (session === null) {
      const text = readStored(sessionKey);
      const stored = text === null ? null : StoredSessionSchema.safeParse(parseJson(text));
      if (stored?.success === false) log.warn('ignored a stored session that did not parse');
      if (stored?.success) session = { ...stored.data };
    }
    if (session === null) return;
    // Kept across a reload that resumed its page session, until the relay's frame says.
    if (session.pageId === frame.pageId) {
      armSessionEnd();
      showSession();
    } else {
      finishSession('relay');
    }
  };

  const onSession = (frame: SessionFrame): void => {
    if (!state.sessionsOffered) setState({ sessionsOffered: true });
    const live = frame.session;
    relayLists = live?.sessionId ?? null;
    const { refused, ended } = frame;
    if (refused !== undefined) {
      log.info(`the relay refused session ${refused.sessionId}: ${refused.reason}`);
      if (starting?.sessionId === refused.sessionId) starting.answer(refused.reason);
    }
    const kept = session;
    if (kept !== null && live?.sessionId === kept.sessionId) {
      // Reckoned again on this clock, never past what the operator asked,
      // and the relay's policy taken only where it is no wider than this page's.
      const lengthMs = Math.min(live.lengthMs, Math.max(kept.lengthMs, askedMs));
      kept.lengthMs = lengthMs;
      kept.endsAt = Math.min(clock() + live.remainingMs, kept.startedAt + lengthMs);
      if (withinCeiling(effective(), live.policy)) kept.policy = { ...live.policy };
      if (starting?.sessionId === kept.sessionId) starting.answer(null);
      armSessionEnd();
      demoteBeyond(effective().maxDrivers);
      proposalsPolicyChanged();
      const view = sessionView();
      // Told after each decision, through the seam W3-A guards (ADR 0045, decision 22).
      if (view !== null) recorder.sessionStarted(view);
      showSession();
      return;
    }
    // The relay holds none of this page's: it ended there, unless a start still waits.
    if (kept !== null && starting?.sessionId !== kept.sessionId) {
      finishSession(ended?.sessionId === kept.sessionId ? ended.reason : 'relay');
    }
    // One the relay lists while this page holds none is never adopted, and is
    // ended there, as an unknown invite is closed: whether this page ended it
    // while the relay could not hear and a reload lost that, or never started
    // it. An end only takes access away, and without one the relay would keep
    // the seats narrowed and refuse every start until its own clock ran out.
    // One this page ended on its own clock waits out the grace first.
    if (live !== null && session === null) {
      if (live.sessionId !== endedHere) {
        if (endSent !== live.sessionId) {
          log.warn(`ended session ${live.sessionId}, which this page holds no record of`);
        }
        endListed(live.sessionId);
      } else if (graceTimer === null) {
        tellEnd();
      }
    }
  };

  /**
   * The end, however it came: everyone an invite or agent token let in
   * leaves, their redemptions are refused and their calls cancelled, as on
   * revoke (S8, C11), and the page's own policy returns. An end this page
   * made itself is told to the relay, at once for the operator's, after
   * SESSION_END_GRACE_MS for its clock's, so the relay's own end wins a tie.
   */
  function finishSession(reason: SessionEndedReason, local = false): void {
    const ended = session;
    if (ended === null) return;
    session = null;
    timers.clearTimeout(sessionTimer);
    if (starting?.sessionId === ended.sessionId) starting.answer('unavailable');
    const listed = new Set(state.roster.map((entry) => entry.userId));
    const gone: string[] = [];
    for (const [userId, grant] of grants) {
      if (grant.inviteId === undefined) continue;
      gone.push(userId);
      grants.delete(userId);
      // Refused here until the relay drops them, and revoked there should a later link find them.
      if (listed.has(userId)) revoked.add(userId);
    }
    // The relay ends what waits on them with the session (its session_end,
    // or its own end), so nothing here answers it as a refusal (S7).
    for (const inviteId of [...invites.keys()]) forgetInvite(inviteId, 'cancelled', 'closing');
    saveGrants();
    for (const call of [...calls.values()]) {
      if (!gone.includes(call.frame.caller.userId)) continue;
      if (!call.confirm) call.controller.abort();
      finish(call, {
        ok: false,
        code: call.confirm ? 'denied_by_operator' : 'cancelled',
        message: 'the time-boxed session ended',
      });
    }
    for (const userId of gone) proposalsRevoked(userId);
    for (const tokenId of [...agentRecords.keys()]) forgetAgent(tokenId, 'cancelled', 'closing');
    const end: SessionEnded = Object.freeze({
      sessionId: ended.sessionId,
      label: ended.label,
      reason,
      time: clock(),
    });
    recorder.sessionEnded(end);
    setState({ sessionEnded: end });
    showSession();
    log.info(`session ${ended.sessionId} ended (${reason})`);
    if (!local) return;
    endedHere = ended.sessionId;
    timers.clearTimeout(graceTimer);
    graceTimer = null;
    if (reason !== 'time') {
      tellEnd();
      return;
    }
    graceTimer = timers.setTimeout(() => {
      graceTimer = null;
      tellEnd();
    }, SESSION_END_GRACE_MS);
  }

  /** The session under this id, while it runs; an await may end it. */
  function runs(sessionId: string): StoredSession | null {
    return session?.sessionId === sessionId ? session : null;
  }

  /** A start the relay refused or never answered leaves nothing behind but its demotions. */
  function dropStart(sessionId: string): void {
    if (runs(sessionId) === null) return;
    session = null;
    timers.clearTimeout(sessionTimer);
    showSession();
    // Should the relay hold it after all, it hears the end once it lists it.
    endedHere = sessionId;
    tellEnd();
  }

  /**
   * Starts a session: checked at run time, since a page script can pass
   * anything, and never wider than attach()'s policy, so a start this page
   * would refuse never leaves it (S5). The drivers past its seats are
   * demoted here first. Its watch invites are minted once the relay lists
   * it, each ending with the session at the latest.
   */
  const startSession: Dock['startSession'] = async (options) => {
    const refuse = (reason: SessionFailure): SessionResult => Object.freeze({ ok: false, reason });
    const given: unknown = options;
    if (typeof given !== 'object' || given === null) return refuse('invalid');
    const {
      label,
      lengthMinutes,
      drivers = policy.maxDrivers,
      observers = 0,
      proposals = policy.proposals,
    } = options;
    const lengthMs =
      typeof lengthMinutes === 'number' ? lengthMinutes * SESSION_LENGTH_UNIT_MS : Number.NaN;
    const wanted = SessionPolicySchema.safeParse({ maxDrivers: drivers, proposals });
    if (
      !wanted.success ||
      !InviteLabelSchema.safeParse(label).success ||
      !SessionLengthSchema.safeParse(lengthMs).success ||
      !Number.isInteger(observers) ||
      observers < 0 ||
      observers > sessionSeats(state.seatLimits)
    ) {
      return refuse('invalid');
    }
    if (!withinCeiling(policy, wanted.data) || (observers > 0 && policy.invites === 'off')) {
      return refuse('policy');
    }
    if (session !== null) return refuse('active');
    if (!isLinked()) return refuse('link_down');
    const offered = state.invitesOffered?.linkBase ?? null;
    if (
      !state.sessionsOffered ||
      (observers > 0 &&
        (offered === null || !webCrypto || !state.roster.some((entry) => entry.kind === 'member')))
    ) {
      return refuse('unavailable');
    }
    if (invites.size + Math.ceil(observers / MAX_INVITE_USES) > MAX_LIVE_INVITES_PER_PAGE) {
      return refuse('limit');
    }
    demoteBeyond(wanted.data.maxDrivers);
    const now = clock();
    const sessionId = `ses_${webCrypto ? randomText(webCrypto, INVITE_ID_BYTES) : String(now)}`;
    session = {
      pageId: state.pageId ?? '',
      sessionId,
      label,
      startedAt: now,
      endsAt: now + lengthMs,
      lengthMs,
      policy: wanted.data,
      observers,
      inviteIds: [],
    };
    askedMs = lengthMs;
    armSessionEnd();
    // Proposals the narrowed policy no longer takes end here first, as its drivers were demoted.
    proposalsPolicyChanged();
    showSession();
    if (!send({ t: 'session_start', sessionId, lengthMs, policy: wanted.data })) {
      dropStart(sessionId);
      return refuse('link_down');
    }
    const answer = await new Promise<SessionFailure | null>((resolve) => {
      const settle = (reason: SessionFailure | null): void => {
        timers.clearTimeout(timer);
        starting = null;
        if (reason !== null) dropStart(sessionId);
        resolve(reason);
      };
      const timer = timers.setTimeout(() => {
        settle('unavailable');
      }, MINT_ANSWER_MS);
      starting = { sessionId, answer: settle };
    });
    if (answer !== null) return refuse(answer);
    const links: SessionLink[] = [];
    let inviteRefusal: InviteRefusal | undefined;
    // One watch invite for every MAX_INVITE_USES observers, as far as the relay mints them.
    for (let left = observers; left > 0 && runs(sessionId); left -= MAX_INVITE_USES) {
      const minted = await mintInvite(
        'observer',
        label,
        Math.min(left, MAX_INVITE_USES),
        now + MAX_SESSION_MS,
        () => runs(sessionId) !== null,
      );
      if (!minted.ok) {
        inviteRefusal = minted.reason;
        break;
      }
      links.push({ inviteId: minted.inviteId, link: minted.link });
      runs(sessionId)?.inviteIds.push(minted.inviteId);
      showSession();
    }
    return Object.freeze({
      ok: true,
      sessionId,
      endsAt: runs(sessionId)?.endsAt ?? now,
      link: links[0]?.link ?? null,
      links: Object.freeze(links),
      ...(inviteRefusal === undefined ? {} : { inviteRefusal }),
    });
  };

  const extendSession: Dock['extendSession'] = (minutes) => {
    const live = session;
    const step = typeof minutes === 'number' && minutes > 0 ? minutes : Number.NaN;
    const lengthMs = (live?.lengthMs ?? 0) + step * SESSION_LENGTH_UNIT_MS;
    if (live === null || relayLists !== live.sessionId) return false;
    if (!SessionLengthSchema.safeParse(lengthMs).success) return false;
    askedMs = Math.max(askedMs, lengthMs);
    return send({ t: 'session_extend', sessionId: live.sessionId, lengthMs });
  };

  const endSession: Dock['endSession'] = () => {
    if (session === null || closed) return false;
    finishSession('operator', true);
    return true;
  };

  /**
   * A new watch link for the running session, since its links live only in
   * the widget's memory and a reload loses them: the old invites close, and
   * one mint covers the seats still open, up to an invite's uses.
   */
  const renewSessionLink: Dock['renewSessionLink'] = async () => {
    const live = session;
    if (live === null || live.observers === 0) return refuseInvite('invalid');
    let joined = 0;
    for (const grant of grants.values()) {
      if (grant.inviteId !== undefined && live.inviteIds.includes(grant.inviteId)) joined += 1;
    }
    for (const inviteId of live.inviteIds) cancelInvite(inviteId);
    live.inviteIds = [];
    showSession();
    const minted = await mintInvite(
      'observer',
      live.label,
      Math.min(MAX_INVITE_USES, Math.max(1, live.observers - joined)),
      live.startedAt + MAX_SESSION_MS,
      () => session === live,
    );
    if (minted.ok && session === live) {
      live.inviteIds.push(minted.inviteId);
      showSession();
    }
    return minted;
  };

  // Agent tokens (ADR 0044). A token is minted here as an invite is: 256
  // bits from getRandomValues, its SHA-256 kept in this page's own record
  // and sent to the relay, the token itself only in what agentToken()
  // resolves with, once. Its first request is honoured only against that
  // record: the token presented, its label, the agent's id derived from this
  // page and the token, and its time; then the operator is asked, for
  // observer only, and a denial or three prompts left to time out burn it.

  /** This page's records of the tokens it minted, by id: hashes, never tokens. */
  const agentRecords = new Map<string, StoredAgent>();
  /** The page session the records belong to; they mean nothing on another. */
  let agentsPage: string | null = null;
  /** What the relay's last agents frame said of each token the records hold, terms matching. */
  let agentListings = new Map<string, AgentListing>();
  /** Tokens sent to the relay that it has neither listed nor refused yet, each with its token until then. */
  const agentMinting = new Map<
    string,
    {
      readonly token: string;
      readonly resolve: (result: AgentTokenResult) => void;
      readonly timer: unknown;
    }
  >();
  /** Tokens closed on this link because this page holds no record of them, so each is closed once. */
  const agentCancelSent = new Set<string>();
  /** The agent users this page checked, by user id, so revoking one also cancels its token. */
  const agentUsers = new Map<string, string>();

  function loadAgents(): void {
    const text = readStored(agentsKey);
    const stored = text === null ? null : StoredAgentsSchema.safeParse(parseJson(text));
    // A strict schema: a record holding a token, or anything malformed, is no record at all.
    if (stored && !stored.success) log.warn('ignored unparsable stored agent tokens');
    if (stored?.success && (grantsPage === null || grantsPage === stored.data.pageId)) {
      agentsPage = stored.data.pageId;
      for (const agent of stored.data.agents) agentRecords.set(agent.tokenId, agent);
    }
  }

  loadAgents();

  /** Every change to the records ends here, so storage and the shown tokens match memory. */
  function saveAgents(): void {
    writeStored(
      agentsKey,
      agentRecords.size === 0 || agentsPage === null
        ? null
        : JSON.stringify({ pageId: agentsPage, agents: [...agentRecords.values()] }),
      "the page's agent tokens",
    );
    const views = agentViews();
    if (JSON.stringify(views) !== JSON.stringify(state.agents)) setState({ agents: views });
  }

  /** When a token stops working on this page's clock: its expiry, never past 8 hours from minting. */
  function agentEnd(agent: StoredAgent): number {
    return Math.min(agent.expiresAt, agent.createdAt + MAX_AGENT_LIFETIME_MS);
  }

  /**
   * Every token this page minted that the relay lists on the very terms it
   * was minted with, oldest first: the records are kept in minting order.
   */
  function agentViews(): AgentView[] {
    const views: AgentView[] = [];
    for (const agent of agentRecords.values()) {
      const listing = agentListings.get(agent.tokenId);
      if (listing) {
        views.push(
          Object.freeze({
            tokenId: agent.tokenId,
            label: agent.label,
            expiresAt: agentEnd(agent),
            state: listing.state,
            timeouts: Math.max(listing.timeouts, agent.timeouts),
            sponsor: Object.freeze(listing.sponsor),
          }),
        );
      }
    }
    return views;
  }

  /**
   * The page stops honouring a token: its record goes, stored copy too, a
   * first request of it still being checked or waiting on the operator is
   * refused (`cause`), the grant it made goes, and a mint still waiting
   * settles with `reason`.
   */
  function forgetAgent(
    tokenId: string,
    reason: InviteRefusal,
    cause: DecisionCause = 'rule',
  ): void {
    const had = agentRecords.delete(tokenId);
    agentListings.delete(tokenId);
    const mint = agentMinting.get(tokenId);
    if (mint) {
      agentMinting.delete(tokenId);
      timers.clearTimeout(mint.timer);
      mint.resolve(Object.freeze({ ok: false, reason }));
    }
    for (const record of [...requests.values()]) {
      if (record.request.agent?.tokenId === tokenId) decide(record, false, undefined, cause);
    }
    for (const [userId, ofToken] of [...agentUsers]) {
      if (ofToken === tokenId) agentUsers.delete(userId);
    }
    const holders = [...grants].filter(([, grant]) => grant.inviteId === tokenId);
    if (holders.length > 0) pruneGrants(holders.map(([userId]) => userId));
    if (had) saveAgents();
  }

  /** Closes a token the relay lists that this page holds no record of, once per link. */
  function closeUnknownAgent(tokenId: string): void {
    if (agentCancelSent.has(tokenId) || !isLinked()) return;
    if (send({ t: 'agent_cancel', tokenId })) {
      agentCancelSent.add(tokenId);
      log.warn(`closed unknown agent token ${tokenId}`);
    }
  }

  /**
   * The relay's list of this page's live tokens. Only those this page's own
   * record holds, on the very terms it minted them with, are shown; any
   * other is closed, since nothing here would honour it. A record the relay
   * no longer lists was cancelled, burned or expired there and goes, unless
   * its mint is still waiting for this very answer.
   */
  function onAgents(frame: AgentsFrame): void {
    // The first agents frame of each link follows its welcome (tearDownLink cleared the last).
    if (state.agentsOffered === null) agentCancelSent.clear();
    // Records of another page session were never this one's to honour.
    if (agentsPage !== null && agentsPage !== state.pageId) {
      for (const tokenId of [...agentRecords.keys()]) forgetAgent(tokenId, 'link_down');
      agentsPage = null;
    }
    const refused = frame.refused;
    const listed = new Map<string, AgentListing>();
    for (const listing of frame.agents) {
      const agent = agentRecords.get(listing.tokenId);
      const same =
        agent !== undefined &&
        agent.label === listing.label &&
        agent.expiresAt === listing.expiresAt;
      if (same && listing.tokenId !== refused?.tokenId) {
        listed.set(listing.tokenId, listing);
        continue;
      }
      if (agent) {
        log.warn(`agent token ${listing.tokenId} listed on other terms`);
        forgetAgent(listing.tokenId, 'unavailable');
      }
      closeUnknownAgent(listing.tokenId);
    }
    if (refused && agentMinting.has(refused.tokenId)) {
      log.info(`relay refused agent token ${refused.tokenId}: ${refused.reason}`);
      forgetAgent(refused.tokenId, refused.reason);
    }
    for (const tokenId of [...agentRecords.keys()]) {
      if (!listed.has(tokenId) && !agentMinting.has(tokenId)) forgetAgent(tokenId, 'cancelled');
    }
    agentListings = listed;
    setState({ agentsOffered: Object.freeze({ endpoint: frame.endpoint }), agents: agentViews() });
    for (const tokenId of [...agentMinting.keys()]) {
      if (listed.has(tokenId)) answerAgentMint(tokenId, frame.endpoint);
    }
  }

  /**
   * The relay listed a new token: agentToken() resolves with it and the
   * command that uses it, the only place either ever goes. Every part of the
   * command is shell-safe by schema: the endpoint passed isAgentEndpoint,
   * and the token and its id are base64url.
   */
  function answerAgentMint(tokenId: string, endpoint: string | null): void {
    const mint = agentMinting.get(tokenId);
    const agent = agentRecords.get(tokenId);
    if (!mint || !agent) return;
    if (endpoint === null) {
      // A relay with no public URL mints nothing, so one listing a token anyway gets it closed.
      forgetAgent(tokenId, 'no_public_url');
      closeUnknownAgent(tokenId);
      return;
    }
    agentMinting.delete(tokenId);
    timers.clearTimeout(mint.timer);
    log.info(`minted agent token ${tokenId}`);
    mint.resolve(
      Object.freeze({
        ok: true,
        tokenId,
        token: mint.token,
        endpoint,
        command: `claude mcp add --transport http --scope local tabdock-${tokenId.slice(4, 12)} ${endpoint} --header "Authorization: Bearer ${mint.token}"`,
        expiresAt: agentEnd(agent),
      }),
    );
  }

  /**
   * Whatever about a token's own record stops its request now, beyond the
   * token itself, or null. An agent named with an account never gets here:
   * the frame's schema refuses one.
   */
  function agentProblem(request: PendingRequest): string | null {
    const agent = request.agent && agentRecords.get(request.agent.tokenId);
    if (!agent) return 'no record';
    if (agentsPage !== state.pageId) return 'another page session';
    if (request.agent.label !== agent.label) return 'wrong label';
    if (clock() >= agentEnd(agent)) return 'expired';
    if (agent.burned || agent.timeouts >= AGENT_BURN_TIMEOUTS) return 'burned';
    // The page's policy as it stands now, which a reload may have narrowed since minting.
    if (policy.invites === 'off') return 'policy';
    const { userId } = request.user;
    if (revoked.has(userId)) return 'revoked';
    return state.roster.some((attachment) => attachment.userId === userId) ? 'attached' : null;
  }

  /**
   * S4 for agents: a token's first request reaches the operator only when
   * the token presented hashes to this page's own record, its label is the
   * record's, the agent's id is the one this page derives from its own page
   * id and the token id (so a relay cannot reuse a token for another
   * account), and the record's terms still hold. Then the operator is asked,
   * for observer only. Anything else is refused without troubling them: only
   * a relay's mistake or lie could have sent it.
   */
  async function checkAgent(record: RequestRecord): Promise<void> {
    const { request } = record;
    const secret = record.secret;
    record.secret = null;
    const tokenId = request.agent?.tokenId ?? '';
    const kept = agentRecords.get(tokenId);
    const pageId = state.pageId;
    let matches = false;
    let derived: string | null = null;
    if (kept && secret !== null && webCrypto && pageId !== null) {
      try {
        // Both sides are digests, so how long the comparison takes says nothing of the token.
        matches = (await sha256Hex(webCrypto, secret)) === kept.secretHash;
        const key = await sha256Hex(webCrypto, agentKeyInput(pageId, tokenId));
        derived = `g_${key.slice(0, INVITEE_KEY_HEX_CHARS)}`;
      } catch (error) {
        log.warn(`agent token hash failed: ${describe(error)}`);
      }
    }
    // Answered meanwhile: expired, revoked, the token forgotten, or the link lost.
    if (requests.get(request.requestId) !== record) return;
    // Without a record or WebCrypto nothing matches, so nothing is honoured.
    const problem = !matches
      ? 'wrong token'
      : derived !== request.user.userId
        ? 'wrong agent id'
        : agentProblem(request);
    if (problem !== null) {
      log.warn(`refused agent token ${tokenId}: ${problem}`);
      decide(record, false, undefined, 'rule');
      return;
    }
    record.verified = true;
    agentUsers.set(request.user.userId, tokenId);
    show(record);
  }

  /** The operator allowed a checked token: an observer, capped as a watch invite's guest, ending with the token. */
  function agentGranted(userId: string, agent: StoredAgent): void {
    forgetRevokes([userId]);
    setGrant(userId, {
      role: 'observer',
      inviteId: agent.tokenId,
      endsAt: agentEnd(agent),
      inviteRole: 'observer',
    });
  }

  /**
   * The operator denied a token's prompt, which says they do not know the
   * agent, so the token burns at once; one left to time out counts, and its
   * third does too (ADR 0044). The relay burns it by the same rules, and is
   * told to close it whatever it counts: true when it burned, for decide to
   * close once its own answer has gone.
   */
  function agentRefused(agent: StoredAgent, cause: 'operator' | 'timeout'): boolean {
    const timeouts = cause === 'timeout' ? agent.timeouts + 1 : agent.timeouts;
    const burned = cause === 'operator' || timeouts >= AGENT_BURN_TIMEOUTS;
    agentRecords.set(agent.tokenId, { ...agent, burned, timeouts });
    if (!burned) saveAgents();
    return burned;
  }

  /**
   * Revoke's end: Revoke all forgets every token, which the relay's revoke
   * '*' closes itself; revoking an agent forgets its token and tells the
   * relay to close it too (agent_cancel), so no later request is honoured.
   */
  function agentsRevoked(target: string): void {
    if (target === '*') {
      for (const tokenId of [...agentRecords.keys()]) forgetAgent(tokenId, 'cancelled');
      return;
    }
    const tokenId =
      agentUsers.get(target) ??
      state.roster.find((attachment) => attachment.userId === target)?.inviteId;
    // cancelAgent passes over an id that names no token: an invite's, or none.
    if (tokenId) cancelAgent(tokenId);
  }

  /**
   * Mints an agent token (ADR 0044) once the page's policy, the relay and
   * this page's own limit allow: its record is stored before agent_create
   * goes, so a reload while the relay answers still knows the token it may
   * hold. The token and its command come back once and are kept nowhere.
   */
  async function agentToken(request: AgentTokenOptions): Promise<AgentTokenResult> {
    const refuse = (reason: InviteRefusal): AgentTokenResult =>
      Object.freeze({ ok: false, reason });
    const given: unknown = request;
    if (typeof given !== 'object' || given === null) return refuse('invalid');
    const lifetime: unknown = request.lifetime ?? '1h';
    const hours = lifetime === '1h' ? 1 : lifetime === '4h' ? 4 : lifetime === '8h' ? 8 : 0;
    if (!InviteLabelSchema.safeParse(request.label).success || hours === 0)
      return refuse('invalid');
    if (policy.invites === 'off') return refuse('policy');
    if (!isLinked()) return refuse('link_down');
    const offered = state.agentsOffered;
    if (offered === null || !webCrypto) return refuse('unavailable');
    if (offered.endpoint === null) return refuse('no_public_url');
    const token = `${AGENT_TOKEN_PREFIX}${randomText(webCrypto, AGENT_TOKEN_BYTES)}`;
    const tokenId = `agt_${randomText(webCrypto, INVITE_ID_BYTES)}`;
    let secretHash: string;
    try {
      secretHash = await sha256Hex(webCrypto, token);
    } catch (error) {
      log.warn(`agent token hash failed: ${describe(error)}`);
      return refuse('unavailable');
    }
    // The link may have dropped, or the page closed, while the hash was made.
    const pageId = state.pageId;
    if (!isLinked() || pageId === null) return refuse('link_down');
    if (agentRecords.size >= MAX_LIVE_AGENTS_PER_PAGE) return refuse('limit');
    const now = clock();
    const record: StoredAgent = {
      tokenId,
      secretHash,
      label: request.label,
      createdAt: now,
      expiresAt: now + hours * 3_600_000,
      timeouts: 0,
      burned: false,
    };
    if (agentsPage !== pageId) {
      for (const stale of [...agentRecords.keys()]) forgetAgent(stale, 'link_down');
      agentsPage = pageId;
    }
    agentRecords.set(tokenId, record);
    saveAgents();
    return new Promise<AgentTokenResult>((resolve) => {
      const timer = timers.setTimeout(() => {
        if (!agentMinting.has(tokenId)) return;
        log.warn(`no answer for agent token ${tokenId}`);
        forgetAgent(tokenId, 'unavailable');
        closeUnknownAgent(tokenId);
      }, MINT_ANSWER_MS);
      agentMinting.set(tokenId, { token, resolve, timer });
      const sent = send({
        t: 'agent_create',
        tokenId,
        label: record.label,
        expiresAt: record.expiresAt,
        secretHash,
      });
      if (!sent) forgetAgent(tokenId, 'link_down');
    });
  }

  /**
   * Closes one token (agent_cancel) and forgets its record at once, so this
   * page honours it no more whatever the relay does; the relay ends what it
   * let in. False when this page holds no such token.
   */
  function cancelAgent(tokenId: string): boolean {
    if (closed || !agentRecords.has(tokenId)) return false;
    // The cancel first: the relay ends a prompt of it still waiting as it
    // closes the token, as cancelled, never as the operator's deny.
    if (isLinked() && send({ t: 'agent_cancel', tokenId })) agentCancelSent.add(tokenId);
    forgetAgent(tokenId, 'cancelled', 'closing');
    log.info(`closed agent token ${tokenId}`);
    return true;
  }

  // The session record (ADR 0045)
  // M6 seam: not built
  const sessionRecord: Dock['sessionRecord'] = () => null;
  // M6 seam: not built
  const discardRecord: Dock['discardRecord'] = () => false;

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
      for (const record of [...requests.values()]) {
        decide(record, false, undefined, 'detach');
      }
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
    // Only a request the operator was shown: a redemption whose secret is
    // still being checked, or that is approved without a prompt, is not theirs to answer.
    approve: (requestId: string, role: Role) => {
      const record = shownRecord(requestId);
      return record !== null && decide(record, true, role, 'operator');
    },
    deny: (requestId: string) => {
      const record = shownRecord(requestId);
      return record !== null && decide(record, false, undefined, 'operator');
    },
    // Strictly true: a script passing the string 'false' must not allow a consequential call.
    confirm: (callId: string, allow: boolean) => confirmCall(callId, (allow as unknown) === true),
    rotatePairing: () => isLinked() && send({ t: 'rotate_pairing' }),
    setRole: (userId: string, role: Role) => setRole(userId, role),
    revoke: (userId: string, revokeOptions?: RevokeOptions) => revoke(userId, revokeOptions),
    cancelInvite: (inviteId: string) => cancelInvite(inviteId),
    invite: (options: InviteOptions) => invite(options),
    // Only false resumes: resuming lets calls run again, so a script's 'false' or 0 keeps the pause.
    pause: (paused: boolean) => {
      pause((paused as unknown) !== false);
    },
    close: () => {
      close('detach');
    },
    publishState: (value: unknown) => publishState(value),
    acceptProposal: (proposalId: string) => acceptProposal(proposalId),
    dismissProposal: (proposalId: string) => dismissProposal(proposalId),
    dismissAllProposals: () => dismissAllProposals(),
    startSession: (sessionOptions: SessionOptions) => startSession(sessionOptions),
    extendSession: (minutes: number) => extendSession(minutes),
    endSession: () => endSession(),
    renewSessionLink: () => renewSessionLink(),
    agentToken: (agentOptions: AgentTokenOptions) => agentToken(agentOptions),
    cancelAgent: (tokenId: string) => cancelAgent(tokenId),
    sessionRecord: (which?: RecordWhich) => sessionRecord(which),
    discardRecord: (which: RecordWhich) => discardRecord(which),
  });

  return Object.freeze({ dock, start, close });
}

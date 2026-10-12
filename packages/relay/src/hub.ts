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
  AGENT_BURN_TIMEOUTS,
  AGENT_PATH,
  type AttachmentView,
  AttachRefusalSchema,
  type AttachVia,
  AUDIT_VERSION,
  type AuditCallEvent,
  type AuditEvent,
  type AuditEventOf,
  auditPageId,
  auditToolName,
  type CheckedImage,
  checkImage,
  type ClientInfo,
  CLOSE_DETACH,
  CLOSE_REPLACED,
  encodeFrame,
  type ErrorCode,
  type ImageMimeType,
  type ImageRefusal,
  INVITE_BURN_REFUSALS,
  INVITE_PATH,
  INVITEE_ID_PREFIX,
  INVITEE_SHORT_ID_CHARS,
  type InviteListing,
  type InviteRefusalReason,
  InviteeIdSchema,
  isAgentEndpoint,
  InviteSecretSchema,
  inviteSecretOf,
  type JsonObject,
  type Limits,
  MAX_AGENT_LIFETIME_MS,
  MAX_CONFIRMATION_FRAME_BYTES,
  MAX_DESCRIPTION_CHARS,
  MAX_FIRST_CLASS_CHARS_PER_USER,
  MAX_FIRST_CLASS_NAME_CHARS,
  MAX_FIRST_CLASS_TOOLS_PER_USER,
  MAX_FRAME_BYTES,
  MAX_INVITE_LIFETIME_MS,
  MAX_LIVE_AGENTS_PER_PAGE,
  MAX_LIVE_INVITES_PER_PAGE,
  MAX_MEMBERS,
  MAX_PENDING_PROPOSALS_PER_PAGE,
  MAX_PENDING_PROPOSALS_PER_USER,
  MAX_PROPOSAL_ARGUMENT_BYTES,
  MAX_PROPOSAL_ARGUMENT_NODES,
  MAX_RESULT_CHARS,
  MAX_ROSTER_CLIENTS_PER_INVITEE,
  MAX_SESSION_MS,
  MAX_STATE_BYTES,
  MAX_STATE_FRAME_BYTES,
  MAX_WAIT_MS,
  MAX_WAITS_PER_USER,
  MEMBER_RESERVED_SEATS,
  MIN_INVITE_REMAINING_MS,
  narrowPolicy,
  type PageErrorCode,
  type PageFrame,
  type PageTool,
  type Pairing,
  parsePageFrame,
  PROPOSAL_OUTCOME_KEEP_MS,
  proposalArgumentProblem,
  type ProposalEndReason,
  proposalsAdmit,
  type RelayFrame,
  type RelaySnapshot,
  type Role,
  type SessionEndReason,
  type SessionRefusalReason,
  SNAPSHOT_VERSION,
  type ToolAnnotations,
  truncate,
  UNVERIFIED_EMAIL,
  type UserKind,
  type WireImage,
  withinCeiling,
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
import { agentUser, type AuthUser, foldName, type UserAccount } from './auth.ts';
import { MIN_REQUEST_BYTES, type ResolvedConfig } from './config.ts';
import {
  argumentsDigest,
  asksClient,
  type ConfirmationRecord,
  confirmQuestion,
  type ConfirmQuestion,
  confirms,
  type DroppedAnswer,
  MAX_PENDING_CONFIRMATIONS,
  PendingConfirmations,
  type RetryState,
} from './confirm.ts';
import {
  type FirstClassTool,
  firstClassEntry,
  firstClassName,
  firstClassToolPart,
} from './first-class.ts';
import { type AgentCloseReason, AgentTokens } from './agents.ts';
import { type HeldTally, holdValue } from './held-tally.ts';
import type { LogFields, Logger, LogLevel } from './log.ts';
import type { MemberChange } from './members.ts';
import { PageParts } from './page-parts.ts';
import { PageStates, type StateView } from './page-state.ts';
import {
  madeByAgentToken,
  PageProposals,
  PROPOSAL_PLACE_HOLD_MS,
  proposalCharge,
  type ProposalCloseReason,
  type ProposalOutcome,
  type ProposalRecord,
} from './proposals.ts';
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
import {
  restoredAgent,
  restoredAttachment,
  restoredInvite,
  restoredPage,
  savedAgent,
  savedAttachment,
  savedInvite,
  savedPage,
  type SnapshotAccounts,
} from './snapshot.ts';
import type { CallMarks, SpikeHooks } from './spike.ts';
import { WaitSlots, waitLimitsOf } from './waits.ts';
import {
  type AgentTokenRecord,
  type AttachmentRecord,
  type AttachRequestRecord,
  type AuditOutcome,
  type InviteRecord,
  type PageRecord,
  type PageState,
  recordAudit,
  type RelayStore,
  type SingleUseTicketRecord,
  type TimedSession,
} from './store.ts';

type FrameOf<T extends PageFrame['t']> = Extract<PageFrame, { t: T }>;

/** How a pairing or redemption ended without an attachment, as its attach_refused record names it. */
type AttachRefusal = AuditEventOf<'attach_refused'>['outcome'];
type ExpireReason = AuditEventOf<'expire'>['reason'];
type InviteCloseReason = AuditEventOf<'invite_closed'>['reason'];

/**
 * The fixed tools whose requests ADR 0018's per-user budget can refuse, with
 * what each names; a call by a first-class name is refused as the
 * call_page_tool it stands for (ADR 0025). The four M6 tools read state or
 * proposals and reach no page, so each is a request_refused record (ADRs
 * 0040 and 0042).
 */
export type BudgetRefusal =
  | { tool: 'list_pages' }
  | {
      tool:
        | 'list_page_tools'
        | 'detach_page'
        | 'get_page_state'
        | 'wait_for_page_state'
        | 'get_proposal'
        | 'withdraw_proposal';
      page: string;
    }
  | { tool: 'call_page_tool'; page: string; pageTool: PageToolRef }
  | { tool: 'pair_page'; via: 'code' | 'invite' };

/** The lesser of two roles: an invite-made attachment never passes its invite's (ADR 0017). */
function lesserRole(a: Role, b: Role): Role {
  return a === 'observer' || b === 'observer' ? 'observer' : 'driver';
}

/** What a request or an attachment an agent token held hears when the token closes (ADR 0044). */
const AGENT_CLOSED_MESSAGES: Record<AgentCloseReason, string> = {
  cancelled: 'the page operator cancelled this agent token',
  expired: 'this agent token reached the end of its time',
  revoked: 'the page operator revoked this agent token',
  denied: 'the page operator denied this agent token, so it no longer works',
  burned: 'this agent token went unanswered too many times, so it no longer works',
  sponsor_gone: 'the member who made this agent token is no longer attached, so it closed',
  page_gone: 'the page closed and did not come back',
  session_ended: "the page's time-boxed session ended, and every agent token with it",
};

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
  /**
   * The one page an agent token watches, for a caller on /g/mcp (ADR 0044);
   * null for everyone else, who signed in.
   */
  agentPageId: string | null;
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

/**
 * What made an invite-made attachment: an invite (ADR 0017), or an agent
 * token (ADR 0044), whose id then stands where the invite's would, whose
 * role is observer and whose end is the token's own.
 */
type GrantDoor = Pick<InviteRecord, 'inviteId' | 'role' | 'sponsor'> & { readonly endsAt?: number };

/**
 * What an attach request came through and the page must check against its
 * own record: an invite being redeemed, or an agent token's first request.
 * The secret is the one presented, forwarded once and never kept.
 */
type Door =
  | { inviteId: string; secret: string; label: string }
  | { tokenId: string; secret: string; label: string };

/** Who a live agent token on /g/mcp is (ADR 0044): its agent user, its id and its one page. */
export interface AgentIdentity {
  user: AuthUser;
  tokenId: string;
  pageId: string;
  /** Whether the operator has let it in, so its requests raise no prompt and need no client named. */
  attached: boolean;
}

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
  /** The caller may not run it but may propose it, on a page that takes proposals (ADR 0042). */
  proposable?: true;
}

export type ToolsOutcome =
  { kind: 'tools'; pageId: string; origin: string; role: Role; tools: ToolListing[] } | HubError;

/**
 * How a call ended. callPageTool names the page tool it reached in `tool`,
 * as the call resolved it, so a result's untrusted header reads the same
 * whichever route named the tool (ADR 0025).
 */
export type SettledCall =
  | {
      kind: 'ok';
      origin: string;
      content: string;
      tool?: string;
      /** An image from a tool the page declared, checked by the relay (ADR 0039). */
      image?: SettledImage;
    }
  /** The page's handler failed; its message is page-supplied text. */
  | {
      kind: 'tool_error';
      origin: string;
      message: string;
      tool?: string;
      /** Why the relay refused the page's image, when that is what failed (ADR 0039). */
      imageRefused?: ImageRefusal;
    }
  /** The MCP client abandoned the call. */
  | { kind: 'cancelled' }
  /**
   * The caller's role may not run the tool, and the page takes proposals,
   * so the call waits for the operator as a proposal; the page has not run
   * it (ADR 0042).
   */
  | { kind: 'proposed'; pageId: string; proposalId: string; tool: string; expiresAt: number }
  | HubError;

/** An image a call returned, as the relay checked it: its base64 data for the client, and what the record keeps. */
export interface SettledImage {
  mimeType: ImageMimeType;
  data: string;
  /** Decoded bytes. */
  bytes: number;
  /** SHA-256 of the decoded bytes, lower-case hex. */
  sha256: string;
}

/**
 * A 2026-07-28 first round the relay answers with input_required (ADR
 * 0026): every check before dispatch passed, a record waits for the retry,
 * `requestState` carries its id signed (ConfirmLeg's `mint`), and mcp.ts
 * puts `question` to the client. The call took no place in any queue, and
 * the page never heard of it.
 */
export interface AskInClient {
  kind: 'ask';
  requestState: string;
  question: ConfirmQuestion;
}

export type CallOutcome = SettledCall | AskInClient;

/**
 * How a call's own request can confirm it in its client (ADR 0026), as
 * mcp.ts reads it from the request. The hub decides whether to ask
 * (asksClient), so both routes to a page tool confirm alike.
 */
export interface ConfirmLeg {
  /**
   * Whether the request declared form elicitation: in its own envelope on
   * 2026-07-28, in initialize on a 2025-era session. Without it the call
   * goes out unconfirmed and the page prompts, so no client is ever asked
   * for what it did not declare.
   */
  formElicitation: boolean;
  /**
   * 'retry' on 2026-07-28: a first round is answered input_required and the
   * confirmation arrives on a retry. 'elicit' on a 2025-era session: the
   * question is put inside the request (`elicit`).
   */
  mode: 'retry' | 'elicit';
  /**
   * A request that carried a requestState: what the dispatcher took for it
   * before any other check (the record, out of the store already, or a
   * refusal) and the client's answer as the SDK handed it over. null on a
   * first round. A 2025-era session never asks this way, so there it is
   * always a refusal.
   */
  retry: { state: RetryState; answer: unknown } | null;
  /** elicit mode: puts the question to the client, resolving with its answer as given. */
  elicit: ((question: ConfirmQuestion, signal: AbortSignal) => Promise<unknown>) | null;
  /**
   * retry mode: signs a record's id into the request state the question
   * carries, bound to this request's caller. The hub awaits it, then looks
   * again whether the record is still held, so a revoke while it signs puts
   * no question (#ask).
   */
  mint: ((recordId: string) => Promise<string>) | null;
}

/** The confirmation an invoke carries, fresh for the call (ADR 0026). */
interface ClientConfirmation {
  /** A fresh relay id, never the record's. */
  confirmationId: string;
  /** When the confirming answer arrived. */
  at: number;
  /**
   * The grantedAt of the caller's attachment the question was asked under,
   * which names that attachment: a fresh one after a revoke or a detach
   * comes from a new pairing, a round trip later, never in the same
   * millisecond. The confirmation holds only while that attachment is still
   * the caller's, so it never outlives it whatever the order of awaits;
   * never sent to the page.
   */
  grantedAt: number;
}

export type DetachOutcome = { kind: 'detached'; pageId: string } | HubError;

/**
 * A page's published state as get_page_state and wait_for_page_state read
 * it (ADR 0040): the canonical text the page sent, never parsed again, and
 * whether a wait saw it change (null for a read that did not wait).
 */
export type StateOutcome =
  | {
      kind: 'state';
      pageId: string;
      origin: string;
      version: number;
      publishedAt: number | null;
      heardAt: number;
      text: string | null;
      changed: boolean | null;
    }
  | HubError;

/** Where a proposal stands (ADR 0042): pending until the operator decides or it ends some other way. */
export type ProposalStatus =
  'pending' | 'accepted' | 'dismissed' | 'refused' | 'expired' | 'withdrawn' | 'cancelled';

/** A proposal as get_proposal and withdraw_proposal answer it (ADR 0042), to its proposer alone. */
export type ProposalAnswer =
  | {
      kind: 'proposal';
      pageId: string;
      origin: string;
      proposalId: string;
      tool: string;
      status: ProposalStatus;
      /** For an accepted proposal: running, or how its run ended. */
      outcome?: ProposalOutcome;
      /** While it is pending. */
      expiresAt?: number;
      /** An accepted run's result, cut to MAX_PROPOSAL_RESULT_CHARS: page text, shown only behind its label. */
      result?: { text: string; cut: boolean };
      /** The run returned an image, which proposals never keep (ADR 0039). */
      image?: true;
      /** The run's result was kept and later dropped to make room (S9). */
      dropped?: true;
    }
  | HubError;

/**
 * Which of a page's two allowances an attachment fills (ADR 0044): an
 * invitee watching by invite takes a watching seat while the page has any,
 * and everyone else one of its people, usersPerPage.
 */
type Seat = 'people' | 'watching';

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
   * The page tool its record names: from the start the page tool's own
   * name whenever the relay holds the page's tools (#calledToolName), so a
   * call by either route leaves the same line even when it is refused
   * before the lookup (S7, ADR 0025); else as the client wrote it, a
   * first-class name whole, until the name resolves.
   */
  tool: string;
  /**
   * 'client' exactly when its invoke went out carrying a confirmation, so
   * the record never credits a client with a call the operator decided
   * (S7, ADR 0026).
   */
  confirmedBy: 'client' | null;
  /** The invoke's call id, exactly when it went out, so a saved session record matches the line (ADR 0045). */
  callId: string | null;
  /** The image that reached the client: its type, decoded size and digest, never its data (ADR 0039). */
  image: Omit<SettledImage, 'data'> | null;
  /** Why the relay refused the page's image (ADR 0039). */
  imageRefused: ImageRefusal | null;
  /** The proposal the call made, or the accepted proposal it runs (ADR 0042). */
  proposalId: string | null;
  /** Whether it runs a proposal the operator accepted on the page (ADR 0042). */
  acceptedOnPage: boolean;
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
  /**
   * Its caller's confirmation in their client, or null (ADR 0026). The
   * invoke carries it only if what called for asking still holds as it goes
   * out (#sendInvoke).
   */
  confirmation: ClientConfirmation | null;
  /**
   * The accepted proposal it runs, and the grantedAt of the proposer's
   * attachment it was made under, which must still be theirs as it goes out;
   * null for an ordinary call (ADR 0042). Never beside a confirmation.
   */
  proposal: { proposalId: string; grantedAt: number } | null;
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
 * the hub resolves at the step where it looks the tool up, with `calledAs`
 * the whole name as the client called it. The MCP tool as called is what a
 * confirmation's record binds beside the page tool (ADR 0026), so a
 * confirmation asked about through one route never passes for the other.
 */
export type PageToolRef = string | { firstClass: string; calledAs: string };

/** The MCP tool a call came through: call_page_tool, or its first-class name as called. */
export function calledAsOf(ref: PageToolRef): string {
  return typeof ref === 'string' ? 'call_page_tool' : ref.calledAs;
}

/** A call whose confirmation in its client failed; the page never hears of it (ADR 0026). */
function notConfirmed(message: string): HubError {
  return hubError('not_confirmed', message);
}

const NO_SUCH_CONFIRMATION =
  'this relay holds no confirmation of yours for this call: it expired, was used already, belongs to another account or client, or came from before the relay restarted; call again to be asked anew. The page never heard of this call';
const CONFIRMED_ANOTHER_CALL =
  'the confirmation was given for another call (other arguments, another tool or another page); call again to be asked about this one. The page never heard of this call';
const NOT_CONFIRMED_IN_CLIENT =
  'you did not confirm this call in your client: it was declined, dismissed or answered without confirm set to true. The page never heard of it';
const ASKED_UNDER_ENDED_ATTACHMENT =
  'you were asked about this call under an attachment to this page that has since ended, so its confirmation ended with it; call again to be asked anew. The page never heard of this call';
/** What a question held open on a page that ended answers (ADR 0026), as a later call would. */
const PAGE_GONE_ANSWER: DroppedAnswer = {
  code: 'page_gone',
  message: 'the page closed and did not come back',
};

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

/**
 * Where page sessions a restart snapshot put back are counted until each
 * first resumes (ADR 0046): a snapshot names no client address, and no
 * address a socket arrives from is written this way, so no page from a real
 * address is charged for one it never resumed. A resume moves the page to
 * its socket's address under that address's own limit (#hello), so a
 * restart never hands an address a second allowance of page sessions.
 */
const RESTORED_ADDRESS = '(restored from a snapshot)';

/**
 * How far before the end the relay holds a page may end a time-boxed session
 * on its own clock and have the audit log say time (ADR 0043's notes). The
 * page reckons its end again from the relay's remaining time at every
 * session frame, so the two differ by the link's latency and a late timer,
 * and the page waits SESSION_END_GRACE_MS before telling; a minute covers
 * that, and a claim made earlier is recorded as the operator's.
 */
const SESSION_CLOCK_SLACK_MS = 60_000;

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
  /** When this socket's recent state frames arrived, for stateFramesPerSocket (ADR 0040). */
  stateFrames: number[];
  /** When the last frame of any kind arrived, which state reads report as heardAt (ADR 0040). */
  heardAt: number;
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
/** The standard "message too big", which SPEC section 6 uses for a frame past its size (ADR 0040). */
const CLOSE_TOO_LARGE = 1009;
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
/**
 * The most a page's queue may hold, a proposal frame included, for an
 * observer's proposal to go out (ADR 0042). A proposal answers its caller
 * at once rather than waiting for room as an invoke does, so past this it
 * is refused page_busy and never closes a page; a quarter of INVOKE_ROOM
 * leaves members' calls most of theirs on a page reading over a slow link,
 * and a proposal at its argument caps, about 17 KB, always fits.
 */
export const PROPOSAL_ROOM = INVOKE_ROOM / 4;
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

/** What a wait refused by waits.ts answers, by the limit that refused it (ADR 0040, S9). */
const WAIT_REFUSALS: Record<'user' | 'page' | 'invitee', string> = {
  user: `you already hold ${String(MAX_WAITS_PER_USER)} waits, the most one user may hold at once across pages; let one end first`,
  page: 'this page already has as many waits as it allows; try again shortly',
  invitee:
    'invited accounts already hold as many waits on this page as they may; try again shortly',
};

/** What a proposal refused by proposals.ts answers, by the limit that refused it (ADR 0042, S9). */
const PROPOSAL_REFUSALS: Record<'user' | 'page' | 'recent' | 'share' | 'relay', string> = {
  user: `you already have ${String(MAX_PENDING_PROPOSALS_PER_USER)} proposals waiting on this page; wait for the operator, or withdraw one with withdraw_proposal`,
  page: `this page already has ${String(MAX_PENDING_PROPOSALS_PER_PAGE)} proposals waiting for its operator; try again later`,
  recent: `proposals withdrawn or refused on this page keep their places for ${formatDuration(PROPOSAL_PLACE_HOLD_MS)}, so the page is not asked too often; try again shortly`,
  share:
    "your proposals waiting across pages already hold as much of the relay's memory as one user's may; wait for their operators, or withdraw one with withdraw_proposal",
  relay: 'the relay holds as many proposals as it can; try again later',
};

/** The relay's line for each way a proposal ends unaccepted (ADR 0042); never its arguments. */
const PROPOSAL_END_LINES: Record<ProposalCloseReason, string> = {
  dismissed: 'proposal dismissed',
  refused: 'proposal refused by the page',
  expired: 'proposal expired',
  withdrawn: 'proposal withdrawn',
  cancelled: 'proposal cancelled',
};

/**
 * What get_proposal and withdraw_proposal answer for an unknown id and for
 * another user's alike, after the access check (S13): an id is a name.
 */
const NO_SUCH_PROPOSAL = `you have no proposal by that id on this page: it never existed, is not yours, or ended more than ${formatDuration(PROPOSAL_OUTCOME_KEEP_MS)} ago`;

/** An accepted proposal's run has no request of its own for a client to cancel. */
const NEVER_ABORTED = new AbortController().signal;

/** A proposal as its proposer reads it: never its arguments, and an accepted run's text only. */
function proposalAnswer(record: ProposalRecord): ProposalAnswer {
  return {
    kind: 'proposal',
    pageId: record.pageId,
    origin: record.origin,
    proposalId: record.proposalId,
    tool: record.tool,
    status: record.status,
    ...(record.outcome === null ? {} : { outcome: record.outcome }),
    ...(record.status === 'pending' ? { expiresAt: record.expiresAt } : {}),
    ...(record.result === null ? {} : { result: { ...record.result } }),
    ...(record.image ? { image: true as const } : {}),
    ...(record.dropped ? { dropped: true as const } : {}),
  };
}

function notAttached(pageId: string): HubError {
  return hubError('not_attached', `you are not attached to page ${pageId}`);
}

/** Gives one place back to a count, dropping the key at 0 so a count of nothing holds no memory. */
function giveBack(counts: Map<string, number>, key: string): void {
  const left = (counts.get(key) ?? 1) - 1;
  if (left > 0) counts.set(key, left);
  else counts.delete(key);
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
 * Counts a string a listed tool's cut copy keeps (held-tally.ts). A cut
 * string is a new one that may still point into the page's original, so
 * both are counted.
 */
function holdText(text: string, tally: HeldTally): string {
  const cut = truncate(text, MAX_DESCRIPTION_CHARS);
  tally.nodes += 1;
  tally.chars += cut.truncated ? text.length + cut.text.length : text.length;
  return cut.text;
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
   * even if it resumes from elsewhere; only a page a restart snapshot put back
   * moves, once, from RESTORED_ADDRESS to the address it first resumes from.
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
  /**
   * The id that stands for a user id's account whatever id the member list
   * gives it (members.ts, accountIdOf), which an invite's revoke bar holds;
   * each id stands for itself with no list (useAccountIds).
   */
  #accountIdOf: (userId: string) => string = (userId) => userId;
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
   * The watchers' share of a page's calls (ADR 0044, #watchingShareRefusal):
   * a rate for the page's watchers together, keyed by page, and one for each
   * watcher, keyed by page and user; the watchers' calls running on each
   * page, and each watcher's among them, keyed by page and user; and the
   * calls already counted, so a call passing the checks twice is counted once.
   */
  readonly #watchingPageCalls: SlidingWindowLimiter;
  readonly #watchingUserCalls: SlidingWindowLimiter;
  readonly #watchingRunning = new Map<string, number>();
  readonly #watcherRunning = new Map<string, number>();
  readonly #watchingCharged = new WeakSet<CallTrace>();
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
  /** State frames per remote address, likewise shared and kept (ADR 0040). */
  readonly #stateFrameLimiter: SlidingWindowLimiter;
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
  /** Settled proposals a decision has already crossed the end of: only one is expected (#proposalDecision). */
  readonly #lateDecisions = new WeakSet<ProposalRecord>();
  /**
   * Redemptions of one invite, whoever makes them (ADR 0017), keyed by page
   * and invite id, so only live invites, which a page holds ten of at most,
   * are ever keys.
   */
  readonly #inviteLimiter: SlidingWindowLimiter;
  /** One per live invite, keyed by inviteKey: fires at the invite's expiresAt. */
  readonly #inviteTimers = new Map<string, NodeJS.Timeout>();
  /** One per live time-boxed session, keyed by page id: fires at its end (ADR 0043). */
  readonly #sessionTimers = new Map<string, NodeJS.Timeout>();
  /** A session that ended while its page slept, told to the page with its next welcome. */
  readonly #sessionEnds = new Map<string, { sessionId: string; reason: SessionEndReason }>();
  /** Promotions and mints per page (OPERATOR_GRANTS_PER_PAGE), kept across its reconnects. */
  readonly #grantLimiter: SlidingWindowLimiter;
  /** One warning per page and window once its grants run out, so a flood writes no line per frame. */
  readonly #grantWarnings: SlidingWindowLimiter;
  /** Refusals that reached no page pass this before the audit log (ADR 0019). */
  readonly #budget: AuditRefusalBudget;
  /**
   * Questions in callers' clients (ADR 0026): 2026-07-28 records waiting
   * for their retry and 2025-era questions held open, at most
   * MAX_PENDING_CONFIRMATIONS a user, in memory only.
   */
  readonly #confirmations: PendingConfirmations;
  /**
   * What M6 keeps per page beside the records here: published state (ADR
   * 0040), proposals (ADR 0042) and agent tokens (ADR 0044), each told of
   * the page's life where the hub changes it (page-parts.ts).
   */
  readonly #parts: PageParts;
  /** Each page's published state and the waits on it (ADR 0040), one of #parts. */
  readonly #states: PageStates;
  /** Observers' proposals and the outcomes kept for them (ADR 0042), one of #parts. */
  readonly #proposals: PageProposals;
  /** Each page's agent tokens (ADR 0044), one of #parts, which a session's end closes (C11). */
  readonly #agents: AgentTokens;
  /**
   * The slots waiting fixed tool calls take, shared by wait_for_page_state
   * and get_proposal (waits.ts, conflict C2 of the M6 plan).
   */
  readonly #waits: WaitSlots;
  /** Told the agent user of each token that closes; relay.ts ends its sessions and streams. */
  #agentListener: ((userId: string) => void) | null = null;
  /**
   * Why a dormant token's latest request raised no prompt (the page busy,
   * full or asleep), by page and token id, so its pair_page can say so; only
   * live tokens are keys.
   */
  readonly #agentRefusals = new Map<string, HubError>();
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
      stateFramesPerAddress,
      stateFramesWindowMs,
      ignoredFramesPerAddress,
      connectionLinesPerAddress,
      redemptionsPerInvite,
      auditRefusalsPerUser,
      auditRefusalsForStrangers,
    } = config.rateLimits;
    this.#userLimiter = new SlidingWindowLimiter(pairAttemptsPerUser, windowMs);
    this.#pageLimiter = new SlidingWindowLimiter(pairAttemptsPerPage, windowMs);
    this.#callLimiter = new SlidingWindowLimiter(callsPerUserPerPage, windowMs);
    const { watchingCallsPerPage, watchingCallsPerUserPerPage } = config.rateLimits;
    this.#watchingPageCalls = new SlidingWindowLimiter(watchingCallsPerPage, windowMs);
    this.#watchingUserCalls = new SlidingWindowLimiter(watchingCallsPerUserPerPage, windowMs);
    this.#toolsFrameLimiter = new SlidingWindowLimiter(toolsFramesPerAddress, toolsFramesWindowMs);
    this.#stateFrameLimiter = new SlidingWindowLimiter(stateFramesPerAddress, stateFramesWindowMs);
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
    this.#confirmations = new PendingConfirmations({
      ttlMs: config.timings.confirmationTtlMs,
      perUser: MAX_PENDING_CONFIRMATIONS,
      onExpired: (record) => {
        this.#confirmationExpired(record);
      },
    });
    this.#states = new PageStates(config.limits.stateBytes);
    this.#waits = new WaitSlots(waitLimitsOf(config));
    this.#proposals = new PageProposals({
      ttlMs: config.timings.proposalTtlMs,
      budgetBytes: config.limits.proposalBytes,
      ended: (record, reason, frame) => {
        this.#proposalEnded(record, reason, frame);
      },
      admitted: (record) => this.#stillProposes(record),
    });
    this.#agents = new AgentTokens({
      store: store.agents,
      log: this.#log,
      audit: (event) => {
        this.#audit(event);
      },
      originOf: (pageId) => this.#store.pages.get(pageId)?.origin ?? '',
      closed: (agent, reason) => {
        this.#agentClosed(agent, reason);
      },
    });
    this.#parts = new PageParts([this.#states, this.#proposals, this.#agents]);
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
    const { pageSessions } = this.#config.limits;
    const refused = this.#roomAtAddress(address);
    if (refused !== null) return refused;
    const own = this.#sessionsByAddress.get(address);
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

  /**
   * Room for one more page session charged to this address, under
   * pageSessionsPerAddress: past it the address's own page asleep longest
   * ends, and with none asleep there is no room. Asked for a new page
   * session (#makeRoom) and for a restored one's first resume (#hello).
   */
  #roomAtAddress(address: string): string | null {
    const own = this.#sessionsByAddress.get(address);
    if ((own?.pages.size ?? 0) < this.#config.limits.pageSessionsPerAddress) return null;
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
    return null;
  }

  /** Counts a page session against `address`, moving it from wherever it was counted. */
  #chargeTo(pageId: string, address: string): void {
    const from = this.#pageAddress.get(pageId);
    if (from !== undefined) {
      const was = this.#sessionsByAddress.get(from);
      was?.pages.delete(pageId);
      was?.asleep.delete(pageId);
      if (was?.pages.size === 0) this.#sessionsByAddress.delete(from);
    }
    this.#pageAddress.set(pageId, address);
    let sessions = this.#sessionsByAddress.get(address);
    if (!sessions) {
      sessions = { pages: new Set(), asleep: new Set() };
      this.#sessionsByAddress.set(address, sessions);
    }
    sessions.pages.add(pageId);
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
      stateFrames: [],
      heardAt: Date.now(),
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
    conn.heardAt = Date.now();
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
      case 'state':
        if (this.#stateFrameAllowed(conn)) {
          this.#stateFrame(conn, pageId, frame, Buffer.byteLength(text, 'utf8'));
        }
        return;
      case 'proposal_decision':
        this.#mayChangeNothing(conn, frame.t, () => this.#proposalDecision(pageId, frame));
        return;
      case 'session_start':
      case 'session_extend':
      case 'session_end':
        this.#mayChangeNothing(conn, frame.t, () => this.#sessionFrame(pageId, frame));
        return;
      case 'agent_create':
      case 'agent_cancel':
        this.#mayChangeNothing(conn, frame.t, () => this.#agentFrame(pageId, frame));
        return;
    }
  }

  /**
   * A page publishing its state (ADR 0040), already within its frame budgets
   * (#stateFrameAllowed): past MAX_STATE_FRAME_BYTES on the wire, or
   * MAX_STATE_BYTES once written again as canonical JSON, the socket closes
   * with 1009 as for any frame too large (SPEC section 6), and a value that
   * cannot be written again (nesting past the stack) with 1008 as a
   * malformed frame. Only the canonical text is kept, never the parsed
   * object. An equal value is a frame that changes nothing (ADR 0023), its
   * line written only within that budget. No line ever holds the value.
   */
  #stateFrame(conn: Conn, pageId: string, frame: FrameOf<'state'>, rawBytes: number): void {
    if (rawBytes > MAX_STATE_FRAME_BYTES) {
      this.#stateTooLarge(conn, pageId, rawBytes);
      return;
    }
    let text: string | null = null;
    if (frame.value !== null) {
      try {
        text = JSON.stringify(frame.value);
      } catch {
        this.connectionLine(conn.address, 'warn', 'closing page socket: malformed frame', {
          pageId,
          reason: 'page state could not be written as JSON',
        });
        this.#closeSocket(conn, CLOSE_POLICY, 'malformed frame');
        return;
      }
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > MAX_STATE_BYTES) {
        this.#stateTooLarge(conn, pageId, bytes);
        return;
      }
    }
    const bytes = text === null ? 0 : Buffer.byteLength(text, 'utf8');
    this.#mayChangeNothing(conn, frame.t, () => {
      const outcome = this.#states.publish(pageId, text, Date.now());
      const { version } = this.#states.read(pageId);
      const fields = { pageId, version, bytes, allPagesStateBytes: this.#states.held };
      if (outcome === 'unchanged') {
        this.#log.debug('page state unchanged', { pageId, version });
        return false;
      }
      if (outcome === 'withheld') {
        this.connectionLine(
          conn.address,
          'warn',
          'page state withheld: pages hold all the page state this relay allows',
          fields,
        );
      } else {
        this.#log.debug('page state published', fields);
      }
      return true;
    });
  }

  #stateTooLarge(conn: Conn, pageId: string, bytes: number): void {
    this.connectionLine(conn.address, 'warn', 'closing page socket: page state too large', {
      pageId,
      bytes,
      maxBytes: MAX_STATE_BYTES,
    });
    this.#closeSocket(conn, CLOSE_TOO_LARGE, 'page state too large');
  }

  /**
   * The operator's answer to a proposal, or the page's own refusal of it
   * (ADR 0042); false when it named none of the page's. One decision for a
   * proposal that ended within ENDED_REQUEST_GRACE_MS (it expired, was
   * withdrawn or was cancelled while the operator looked) is expected, as
   * for attach requests (#justEnded); the page decides each proposal once,
   * so any other for one no longer pending changes nothing and spends the
   * budget for such frames (ADR 0023), however long its outcome is kept. An
   * Accept runs the proposer's call through the write queue now, so accepted
   * proposals enter it in the order the operator accepts them (decision 20).
   */
  #proposalDecision(pageId: string, frame: FrameOf<'proposal_decision'>): boolean {
    const record = this.#proposals.byId(frame.proposalId);
    if (record === undefined) {
      this.#log.warn('ignored a decision for an unknown proposal', { pageId });
      return false;
    }
    const { proposalId, tool } = record;
    if (record.pageId !== pageId) {
      this.#log.warn("ignored a decision for another page's proposal", { pageId, proposalId });
      return false;
    }
    const fields = { pageId, userId: record.proposer.userId, proposalId, tool };
    if (record.status !== 'pending') {
      const crossed =
        record.settledAt !== null &&
        Date.now() - record.settledAt <= ENDED_REQUEST_GRACE_MS &&
        !this.#lateDecisions.has(record);
      this.#lateDecisions.add(record);
      this.#log.debug('decision for a proposal that already ended', fields);
      return crossed;
    }
    if (frame.accept) {
      this.#log.info('proposal accepted on the page', fields);
      void this.#runAccepted(record);
      return true;
    }
    this.#proposals.end(record, frame.refused === undefined ? 'dismissed' : 'refused', null);
    return true;
  }

  /**
   * A proposal ended unaccepted (proposals.ts): the page hears why when it
   * did not decide itself and is still there to hear it, and the audit log
   * gets its proposal_closed line, in full, beside the call line that made
   * it (S7). Never its arguments.
   */
  #proposalEnded(
    record: ProposalRecord,
    reason: ProposalCloseReason,
    frame: ProposalEndReason | null,
  ): void {
    const { pageId, proposalId, tool } = record;
    const userId = record.proposer.userId;
    const live = frame === null ? null : this.#livePage(pageId);
    if (live !== null && frame !== null) {
      this.#sendProposalFrame(
        live.conn,
        encodeFrame({ t: 'proposal_end', proposalId, reason: frame }),
      );
    }
    this.#audit({
      v: AUDIT_VERSION,
      type: 'proposal_closed',
      at: Date.now(),
      pageId,
      origin: record.origin,
      proposalId,
      userId,
      tool,
      reason,
    });
    this.#log.info(PROPOSAL_END_LINES[reason], { pageId, userId, proposalId, tool });
  }

  /**
   * Whether the page takes proposals from this attachment's account under
   * the policy in force (ADR 0042, a session's narrowing included): by
   * account kind, and never from an agent token, by whichever sign the
   * relay has of one (conflict C13).
   */
  #takesProposalsFrom(
    page: PageRecord,
    attachment: AttachmentRecord,
    caller?: CallerIdentity,
  ): boolean {
    const agent = (caller?.agentPageId ?? null) !== null || madeByAgentToken(attachment);
    return proposalsAdmit(page.policy.proposals, { kind: attachment.kind, agent });
  }

  /** Whether a pending proposal's proposer still holds the attachment it was made under, and may still propose. */
  #stillProposes(record: ProposalRecord): boolean {
    const page = this.#store.pages.get(record.pageId);
    const attachment = this.#store.attachments.get(record.pageId, record.proposer.userId);
    return (
      page !== undefined &&
      attachment?.grantedAt === record.grantedAt &&
      this.#takesProposalsFrom(page, attachment, record.proposer)
    );
  }

  /**
   * What refuses an accepted proposal's run, looked at when it is accepted
   * and again as its invoke goes out (#recheck): the attachment it was made
   * under must still be the proposer's, so a revoke and a fresh approval
   * never revive an old acceptance (S8); the page must still take proposals
   * from them; and under deny a consequential tool runs for nobody (S6).
   */
  #proposalRefusal(
    grantedAt: number,
    caller: CallerIdentity,
    page: PageRecord,
    attachment: AttachmentRecord,
    tool: PageTool,
  ): HubError | null {
    if (attachment.grantedAt !== grantedAt) {
      return hubError('not_attached', 'the attachment you proposed under has ended');
    }
    if (!this.#takesProposalsFrom(page, attachment, caller)) {
      return hubError('role_denied', 'the page no longer takes proposals from you');
    }
    if (page.policy.consequential === 'deny' && tool.consequential === true) {
      return hubError(
        'denied_by_operator',
        `this page runs no consequential tools, so it runs no ${tool.name}`,
      );
    }
    return null;
  }

  /**
   * The page minting or cancelling an agent token (ADR 0044). A relay with
   * agent tokens off mints none and sends no agents frame at all, as for
   * invites, so a page that sends one anyway is ignored, its token's hash
   * unlogged. Answers whether it minted or closed a token.
   */
  #agentFrame(pageId: string, frame: FrameOf<'agent_create' | 'agent_cancel'>): boolean {
    if (!this.#config.agentTokens) {
      this.#log.warn('ignored an agent token frame: this relay takes no agent tokens', {
        pageId,
        frameType: frame.t,
      });
      return false;
    }
    if (frame.t === 'agent_cancel') {
      const agent = this.#store.agents.get(pageId, frame.tokenId);
      // Closing sends the agents frame; naming none sends it too, so the page reconciles.
      if (agent === undefined || !this.#agents.end(agent, 'cancelled')) this.#sendAgents(pageId);
      return agent !== undefined;
    }
    return this.#agentCreate(pageId, frame);
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
    this.#endSessionIfDue(pageId);
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
    const ownExpiresAt = frame.expiresAt === null ? longest : Math.min(frame.expiresAt, longest);
    const invite: InviteRecord = {
      inviteId: frame.inviteId,
      pageId,
      role: frame.role,
      label: frame.label,
      uses: frame.uses,
      usesLeft: frame.uses,
      createdAt: now,
      requestedExpiresAt: frame.expiresAt,
      // A live session ends it with itself, however long its own life (ADR
      // 0043); its own expiry stays apart, so an extension can lengthen it.
      expiresAt: this.#sessionCap(pageId, ownExpiresAt),
      ownExpiresAt,
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
        // An expiry the session capped is the session's end, whichever timer runs first (ADR 0043).
        this.#endSessionIfDue(pageId);
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

  /**
   * Bars an account, and its verified email when it has one, from an invite
   * for the invite's life. The bar names the account, never a member id the
   * file assigned (#accountIdOf): a member list change that removes the
   * account, moves its id or makes a barred invitee a member clears nothing,
   * since no redemption clears a revoke, and bars nobody the file gives the
   * old id to next (S14, ADR 0017).
   */
  #bar(invite: InviteRecord, userId: string, emailHash: string | null): void {
    const accountId = this.#accountIdOf(userId);
    if (!invite.barredUserIds.includes(accountId)) invite.barredUserIds.push(accountId);
    if (emailHash !== null && !invite.barredEmailHashes.includes(emailHash)) {
      invite.barredEmailHashes.push(emailHash);
    }
    this.#store.invites.put(invite);
  }

  #barred(invite: InviteRecord, userId: string, account: UserAccount): boolean {
    // The id as given too, so a bar a relay without the account rule saved still holds.
    const { barredUserIds } = invite;
    if (barredUserIds.includes(userId) || barredUserIds.includes(this.#accountIdOf(userId))) {
      return true;
    }
    return (
      account.kind === 'invitee' &&
      account.email !== null &&
      invite.barredEmailHashes.includes(emailBarDigest(account.email))
    );
  }

  /**
   * Invite-made attachments among the page's people may hold every seat
   * but MEMBER_RESERVED_SEATS (S14); invitees watching by invite sit in
   * seats of their own, which keep no reserve, since no member sits there
   * (ADR 0044).
   */
  #inviteSeatsFull(pageId: string, waiting: number): boolean {
    const made = this.#store.attachments
      .listForPage(pageId)
      .filter(
        (attachment) =>
          attachment.inviteId !== null &&
          this.#seatOf(attachment.kind, attachment.role) === 'people',
      ).length;
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
    // A session past its end closes its invites first, however late its timer (ADR 0043).
    this.#endSessionIfDue(invite.pageId);
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
    // A session past its end ends what it let in first, however late its timer (ADR 0043).
    this.#endSessionIfDue(pageId);
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

  // Time-boxed sessions (ADR 0043). One per page at most, started,
  // lengthened and ended only by the operator's own page, and never wider
  // than the hello's policy: a session_start past it is refused, never
  // clamped, since an adapter that sent one is wrong about the page and the
  // operator should hear so. Its end holds on the relay's own clock, a timer
  // plus #endSessionIfDue on every path that reads the policy, an invite or
  // an attachment, so a frozen tab or a late timer lets nobody past it.

  /** The operator starting, extending or ending a time-boxed session (ADR 0043); false when nothing changed. */
  #sessionFrame(
    pageId: string,
    frame: FrameOf<'session_start' | 'session_extend' | 'session_end'>,
  ): boolean {
    this.#endSessionIfDue(pageId);
    const page = this.#store.pages.get(pageId);
    if (!page) return false;
    const live = page.timedSession;
    const ours = live?.sessionId === frame.sessionId ? live : null;
    if (frame.t === 'session_end') {
      // An end for a session that is not live changes nothing (#ignored counts it).
      if (ours === null) return false;
      // The page says when its own clock ended it, and is believed only near
      // the end this relay holds: earlier, the page asked, as an operator does.
      const byClock = frame.reason === 'time' && ours.endsAt - Date.now() <= SESSION_CLOCK_SLACK_MS;
      this.#endSession(pageId, byClock ? 'time' : 'operator');
      return true;
    }
    const now = Date.now();
    let refused: SessionRefusalReason | null = null;
    if (frame.t === 'session_start') {
      // The same start again, as after a lost answer: the page hears it as it stands.
      if (ours !== null) {
        this.#sendSession(pageId);
        return false;
      }
      if (live !== null) refused = 'active';
      else if (!withinCeiling(page.ceiling, frame.policy)) refused = 'policy';
    } else if (ours === null) {
      refused = 'unknown';
    } else if (frame.lengthMs <= ours.lengthMs) {
      refused = 'length';
    }
    // Lengthening keeps guests in, so it counts against the page's grants as a mint does.
    if (refused === null && !this.#grantAllowed(pageId, now)) refused = 'limit';
    if (refused !== null) {
      this.#log.info('time-boxed session refused', {
        pageId,
        sessionId: frame.sessionId,
        frameType: frame.t,
        reason: refused,
      });
      this.#sendSession(pageId, { refused: { sessionId: frame.sessionId, reason: refused } });
      return false;
    }
    if (frame.t === 'session_start') {
      const session: TimedSession = {
        sessionId: frame.sessionId,
        startedAt: now,
        endsAt: now + frame.lengthMs,
        lengthMs: frame.lengthMs,
        policy: { ...frame.policy },
      };
      page.timedSession = session;
      page.policy = narrowPolicy(page.ceiling, session.policy);
      this.#store.pages.put(page);
      const demoted = this.#demoteDrivers(page);
      this.#capToSession(pageId, null);
      this.#armSession(pageId, session.endsAt);
      this.#audit({
        v: AUDIT_VERSION,
        type: 'session_start',
        at: now,
        pageId,
        origin: page.origin,
        sessionId: session.sessionId,
        lengthMs: session.lengthMs,
        maxDrivers: session.policy.maxDrivers,
        proposals: session.policy.proposals,
        demoted,
      });
      this.#log.info('time-boxed session started', {
        pageId,
        sessionId: session.sessionId,
        lengthMs: session.lengthMs,
        maxDrivers: session.policy.maxDrivers,
        proposals: session.policy.proposals,
        demoted,
      });
      this.#parts.policyChanged(pageId);
    } else if (ours !== null) {
      const before = ours.endsAt;
      ours.lengthMs = frame.lengthMs;
      ours.endsAt = ours.startedAt + frame.lengthMs;
      this.#store.pages.put(page);
      this.#capToSession(pageId, before);
      this.#armSession(pageId, ours.endsAt);
      this.#audit({
        v: AUDIT_VERSION,
        type: 'session_extend',
        at: now,
        pageId,
        origin: page.origin,
        sessionId: ours.sessionId,
        lengthMs: ours.lengthMs,
      });
      this.#log.info('time-boxed session extended', {
        pageId,
        sessionId: ours.sessionId,
        lengthMs: ours.lengthMs,
      });
    }
    this.#sendRoster(pageId);
    this.#sendInvites(pageId);
    this.#sendSession(pageId);
    return true;
  }

  #armSession(pageId: string, endsAt: number): void {
    this.#setTimer(this.#sessionTimers, pageId, Math.max(0, endsAt - Date.now()), () => {
      this.#endSessionIfDue(pageId);
    });
  }

  /**
   * Demotes the drivers past the policy's maxDrivers, newest grant first, so
   * the member attached first, normally the operator's own client, keeps
   * driving (ADR 0043). Nobody is promoted back later: that is a grant only
   * the operator makes. Answers how many it demoted.
   */
  #demoteDrivers(page: PageRecord): number {
    const drivers = this.#store.attachments
      .listForPage(page.pageId)
      .filter((attachment) => attachment.role === 'driver')
      .sort((a, b) => b.grantedAt - a.grantedAt);
    const demoted = drivers.slice(0, Math.max(0, drivers.length - page.policy.maxDrivers));
    const now = Date.now();
    for (const attachment of demoted) {
      attachment.role = 'observer';
      this.#store.attachments.put(attachment);
      this.#audit({
        v: AUDIT_VERSION,
        type: 'role',
        at: now,
        pageId: page.pageId,
        origin: page.origin,
        userId: attachment.userId,
        role: 'observer',
        previous: 'driver',
      });
      this.#log.info('role changed', {
        pageId: page.pageId,
        userId: attachment.userId,
        role: 'observer',
      });
    }
    this.#firstClassChanged(demoted.map((attachment) => attachment.userId));
    return demoted.length;
  }

  /**
   * Caps every live invite and invite-made attachment at the live session's
   * end, on the relay's clock (S14). `before` is the end an extension moved
   * from: an attachment the old end capped moves with the session, within its
   * own end (#ownEnd), and one that ends sooner for another reason keeps its
   * end. An invite keeps its own expiry apart (ownExpiresAt) for the same reason.
   */
  #capToSession(pageId: string, before: number | null): void {
    const session = this.#store.pages.get(pageId)?.timedSession;
    if (!session) return;
    const idleMs = this.#config.timings.attachmentIdleMs;
    for (const attachment of this.#store.attachments.listForPage(pageId)) {
      if (attachment.inviteId === null || attachment.endsAt === null) continue;
      const endsAt =
        attachment.endsAt === before
          ? Math.min(this.#ownEnd(attachment), session.endsAt)
          : Math.min(attachment.endsAt, session.endsAt);
      if (endsAt === attachment.endsAt) continue;
      attachment.endsAt = endsAt;
      attachment.expiresAt = Math.min(
        (attachment.lastUsedAt ?? attachment.grantedAt) + idleMs,
        endsAt,
      );
      this.#store.attachments.put(attachment);
      this.#armExpiry(attachment);
    }
    for (const invite of this.#store.invites.listForPage(pageId)) {
      invite.expiresAt = Math.min(invite.ownExpiresAt, session.endsAt);
      this.#store.invites.put(invite);
      this.#armInviteExpiry(invite);
    }
  }

  /**
   * An invite-made attachment's end with no session to cap it: 24 hours
   * from its grant (ADR 0017), and no later than the end of the agent token
   * that made one (ADR 0044), whose record a live attachment always has,
   * since the token's close ends it. The token is matched by its agent's id
   * too, so an invite a page named like one of its tokens finds nothing.
   */
  #ownEnd(attachment: AttachmentRecord): number {
    const longest = attachment.grantedAt + MAX_INVITE_LIFETIME_MS;
    const agent =
      attachment.inviteId === null
        ? undefined
        : this.#store.agents.get(attachment.pageId, attachment.inviteId);
    return agent?.userId === attachment.userId ? Math.min(agent.expiresAt, longest) : longest;
  }

  /**
   * The page's session as it stands, after every welcome and on every
   * change: relative times only, as invoke's deadline is, so the page's
   * clock never has to agree with this one, and never its label, which is
   * page text the relay is never given. `extra` says why it changed.
   */
  #sendSession(
    pageId: string,
    extra: {
      ended?: { sessionId: string; reason: SessionEndReason };
      refused?: { sessionId: string; reason: SessionRefusalReason };
    } = {},
  ): void {
    const conn = this.#live.get(pageId);
    if (!conn) return;
    const session = this.#store.pages.get(pageId)?.timedSession ?? null;
    // One that ended while the page slept is told once, with the next welcome.
    const ended = extra.ended ?? this.#sessionEnds.get(pageId);
    this.#sessionEnds.delete(pageId);
    this.#send(conn, {
      t: 'session',
      session:
        session === null
          ? null
          : {
              sessionId: session.sessionId,
              lengthMs: session.lengthMs,
              remainingMs: Math.min(MAX_SESSION_MS, Math.max(0, session.endsAt - Date.now())),
              policy: { ...session.policy },
            },
      ...(ended === undefined || session !== null ? {} : { ended }),
      ...(extra.refused === undefined ? {} : { refused: extra.refused }),
    });
  }

  /**
   * Ends the page's session: its agent tokens, what its invites let in and
   * its live invites end with it (C11), and the page's own policy returns.
   * Members' own attachments stay. A page that is gone ends its attachments
   * and invites itself (#gone), so then those are only counted, before it
   * does.
   */
  #endSession(pageId: string, reason: SessionEndReason): void {
    if (reason === 'page_gone') this.#sessionEnds.delete(pageId);
    const page = this.#store.pages.get(pageId);
    const session = page?.timedSession;
    if (!page || !session) return;
    this.#clearTimer(this.#sessionTimers, pageId);
    // First, so nothing the ends below run can find it due again.
    page.timedSession = null;
    page.policy = narrowPolicy(page.ceiling, null);
    this.#store.pages.put(page);
    const now = Date.now();
    const made = this.#store.attachments
      .listForPage(pageId)
      .filter((attachment) => attachment.inviteId !== null);
    const invites = this.#store.invites.listForPage(pageId);
    // The tokens before the attachments: a token's close ends the attachment
    // it made, with its own expire record (the AgentTokens closed hook), so
    // every token, in use or not, closes as session_ended rather than as its
    // attachment's end, and only what is left ends below, once each. A gone
    // page's tokens close here as page_gone, as #gone's parts would close
    // them next, so the record counts them.
    const agents = this.#agents.closePage(
      pageId,
      reason === 'page_gone' ? 'page_gone' : 'session_ended',
    );
    const left = made.filter(
      (attachment) => this.#store.attachments.get(pageId, attachment.userId) !== undefined,
    );
    if (reason !== 'page_gone') {
      this.#endAttachments(
        pageId,
        new Set(left.map((attachment) => attachment.userId)),
        'revoked',
        'the time-boxed session you joined by invite has ended',
      );
      for (const attachment of left) {
        this.#auditExpire(page, attachment.userId, 'session_ended', now);
      }
      for (const invite of invites) this.#closeInvite(invite, 'session_ended', false);
    }
    this.#audit({
      v: AUDIT_VERSION,
      type: 'session_end',
      at: now,
      pageId,
      origin: page.origin,
      sessionId: session.sessionId,
      reason,
      attachments: made.length,
      invites: invites.length,
      agents,
    });
    this.#log.info('time-boxed session ended', {
      pageId,
      sessionId: session.sessionId,
      reason,
      attachments: made.length,
      invites: invites.length,
      agents,
    });
    this.#parts.policyChanged(pageId);
    if (reason === 'page_gone') return;
    // A member an invite let in may have sponsored invites of their own.
    this.#loseSponsors(pageId, left);
    if (!this.#live.has(pageId)) {
      this.#sessionEnds.set(pageId, { sessionId: session.sessionId, reason });
      return;
    }
    this.#sendRoster(pageId);
    this.#sendInvites(pageId);
    this.#sendSession(pageId, { ended: { sessionId: session.sessionId, reason } });
  }

  /**
   * Ends the page's session if its end has passed, whatever its timer: a
   * late timer lets nobody past it. One that fired early waits again.
   */
  #endSessionIfDue(pageId: string): void {
    const session = this.#store.pages.get(pageId)?.timedSession;
    if (!session) return;
    if (session.endsAt <= Date.now()) this.#endSession(pageId, 'time');
    else if (!this.#sessionTimers.has(pageId)) this.#armSession(pageId, session.endsAt);
  }

  /** An invite-made attachment's end, at most the live session's (ADR 0043). */
  #sessionCap(pageId: string, endsAt: number): number {
    const session = this.#store.pages.get(pageId)?.timedSession;
    return session ? Math.min(endsAt, session.endsAt) : endsAt;
  }

  /** Stops every session timer at shutdown. */
  #clearSessionTimers(): void {
    for (const timer of this.#sessionTimers.values()) clearTimeout(timer);
    this.#sessionTimers.clear();
  }

  // Agent tokens (ADR 0044)

  /**
   * The page's agent tokens, after every welcome and on every change, while
   * agent tokens are on; refused answers an agent_create. A relay with them
   * off sends none, so the widget offers no agent kind.
   */
  #sendAgents(pageId: string, refused?: { tokenId: string; reason: InviteRefusalReason }): void {
    if (!this.#config.agentTokens) return;
    const conn = this.#live.get(pageId);
    if (!conn) return;
    this.#send(conn, {
      t: 'agents',
      endpoint: this.#agentEndpoint(),
      agents: this.#store.agents.listForPage(pageId).map((agent) => this.#agents.listing(agent)),
      ...(refused === undefined ? {} : { refused }),
    });
  }

  /** `<public URL>/g/mcp`, or null where no agent can reach the relay, which then mints no token. */
  #agentEndpoint(): string | null {
    const { publicUrl } = this.#config;
    const endpoint = publicUrl === null ? null : `${publicUrl}${AGENT_PATH}`;
    // resolveConfig takes only an https public URL; a frame the adapter would refuse ends its link.
    return endpoint !== null && isAgentEndpoint(endpoint) ? endpoint : null;
  }

  /**
   * Mints an agent token as far as the page's policy, its sponsor and the
   * bounds allow, keeping only its digest, and answers with an agents frame
   * either way, so the adapter's agentToken() always settles. The checks run
   * as an invite's do (#inviteCreate), the page's grants counted last, so a
   * refused mint spends none. The relay judges expiresAt on its own clock and
   * holds it to MAX_AGENT_LIFETIME_MS. Answers whether it minted one.
   */
  #agentCreate(pageId: string, frame: FrameOf<'agent_create'>): boolean {
    this.#endSessionIfDue(pageId);
    const page = this.#store.pages.get(pageId);
    if (!page) return false;
    const now = Date.now();
    const refuse = (reason: InviteRefusalReason): false => {
      this.#log.info('agent token refused', { pageId, tokenId: frame.tokenId, reason });
      this.#sendAgents(pageId, { tokenId: frame.tokenId, reason });
      return false;
    };
    // A digest is unique across the relay, so a lookup by it finds one token.
    if (
      this.#store.agents.get(pageId, frame.tokenId) !== undefined ||
      this.#store.agents.findBySecretHash(frame.secretHash) !== undefined
    ) {
      return refuse('duplicate');
    }
    if (page.policy.invites === 'off') return refuse('policy');
    if (this.#agentEndpoint() === null) return refuse('no_public_url');
    const sponsor = this.#sponsorOf(pageId);
    if (sponsor === null) return refuse('no_sponsor');
    if (frame.expiresAt - now < MIN_INVITE_REMAINING_MS) return refuse('expired');
    if (
      this.#store.agents.listForPage(pageId).length >= MAX_LIVE_AGENTS_PER_PAGE ||
      !this.#grantAllowed(pageId, now)
    ) {
      return refuse('limit');
    }
    this.#agents.mint({
      tokenId: frame.tokenId,
      pageId,
      label: frame.label,
      secretHash: frame.secretHash,
      createdAt: now,
      expiresAt: Math.min(frame.expiresAt, now + MAX_AGENT_LIFETIME_MS),
      requestedExpiresAt: frame.expiresAt,
      sponsor: { userId: sponsor.userId, displayName: sponsor.displayName },
      state: 'dormant',
      requestId: null,
      timeouts: 0,
      userId: agentUser(pageId, frame.tokenId).userId,
      client: null,
    });
    this.#sendAgents(pageId);
    return true;
  }

  /**
   * Who a token presented on /g/mcp is, or null for a missing, malformed,
   * unknown, expired or closed one alike, which relay.ts answers 404 before
   * the body is read (ADR 0044). Found by digest and confirmed in constant
   * time (S3), within its time, on a page not gone, and only while its
   * sponsor, and each member above them, is attached and in time: a sponsor
   * found past their end is ended here as their timer would, which closes
   * the token (attachmentsEnded), so no request slips into the gap before a
   * late timer. Asked again once the body is in (relay.ts), with the token
   * presented, so a request whose token closed meanwhile serves nothing (S8),
   * as a member list change ends a /mcp request signed in before it.
   */
  agentCaller(token: string, now: number): AgentIdentity | null {
    const agent = this.#agents.byToken(token, now);
    return agent === null ? null : this.#agentIdentity(agent, now);
  }

  #agentIdentity(agent: AgentTokenRecord, now: number): AgentIdentity | null {
    if (!this.#agents.inTime(agent, now)) return null;
    const page = this.#store.pages.get(agent.pageId);
    if (page === undefined || page.state === 'gone') return null;
    if (!this.#chainInTime(agent.pageId, agent.sponsor.userId)) {
      // A sponsor missing with the token still live would be a relay bug; closed all the same.
      this.#agents.end(agent, 'sponsor_gone');
      return null;
    }
    if (this.#store.agents.get(agent.pageId, agent.tokenId) !== agent) return null;
    return {
      user: agentUser(agent.pageId, agent.tokenId),
      tokenId: agent.tokenId,
      pageId: agent.pageId,
      attached: agent.state === 'attached',
    };
  }

  /**
   * A live token's request arrived with its body (ADR 0044). Never approved
   * in advance (S4): a dormant token on an awake page raises an ordinary
   * attach request via agent, carrying the token as presented, which the
   * relay forwards once and never keeps, so the adapter checks it against
   * its own record; one asking already has its request, which this client
   * joins; one attached needs nothing. `client` is what the request named,
   * remembered so a prompt raised again after a timeout can still name it.
   */
  agentArrived(
    identity: AgentIdentity,
    token: string,
    client: ClientInfo | null,
    now: number,
  ): void {
    const agent = this.#store.agents.get(identity.pageId, identity.tokenId);
    if (agent === undefined) return;
    if (client !== null) agent.client = client;
    this.#store.agents.put(agent);
    if (agent.state === 'attached') return;
    if (agent.state === 'asking') {
      const pending =
        agent.requestId === null ? undefined : this.#store.requests.get(agent.requestId);
      if (pending !== undefined && client !== null) this.#joinAgent(pending, client);
      return;
    }
    const key = attachmentKey(agent.pageId, agent.tokenId);
    const asked = this.#agentAsk(agent, identity.user, token, now);
    if (asked === null) this.#agentRefusals.delete(key);
    else this.#agentRefusals.set(key, asked);
  }

  /** A client joining a token's waiting request, named on it as a second device is, with no line each. */
  #joinAgent(pending: AttachRequestRecord, client: ClientInfo): void {
    const known = [pending.client, ...pending.joined].some(
      (seen) => seen !== null && sameClient(seen, client),
    );
    if (known || pending.joined.length >= MAX_ROSTER_CLIENTS) return;
    pending.joined.push(client);
    this.#store.requests.put(pending);
  }

  /**
   * Raises a dormant token's attach request, or says why not: the page
   * asleep, taking no tokens now, out of seats for one more watcher, or past
   * its pairing limit, which counts every prompt a token raises (S3) and
   * nothing a refusal before it, so a token's requests cannot spend the
   * page's limit while the room is full. Every request a dormant token sends
   * comes here, so the refusals' lines are debug lines only.
   */
  #agentAsk(agent: AgentTokenRecord, user: AuthUser, token: string, now: number): HubError | null {
    const live = this.#livePage(agent.pageId);
    if (live === null) {
      return hubError(
        'page_asleep',
        'the page is not connected right now; your agent token asks its operator once it is back',
      );
    }
    const { page, conn } = live;
    const fields = { pageId: page.pageId, tokenId: agent.tokenId };
    if (page.policy.invites === 'off') {
      return hubError(
        'denied_by_operator',
        'the page takes no invited guests now, agents included',
      );
    }
    if (
      this.#agentSeatFull(
        page.pageId,
        this.#waitingFor(page.pageId, this.#seatOf('invitee', 'observer')),
      )
    ) {
      this.#log.debug('agent request raised no prompt: no seat left to watch from', fields);
      return hubError(
        'page_busy',
        'the page has no room left for anyone else to watch; its operator can revoke someone to make room',
      );
    }
    if (!this.#pageLimiter.allows(page.pageId, now)) {
      this.#log.debug('agent request raised no prompt: too many pairings for one page', fields);
      return hubError(
        'rate_limited',
        'too many pairing attempts on this page; wait a minute and try again',
      );
    }
    this.#pageLimiter.record(page.pageId, now);
    const caller: CallerIdentity = {
      userId: user.userId,
      displayName: user.displayName,
      account: user.account,
      oauthClientId: null,
      client: agent.client,
      agentPageId: agent.pageId,
    };
    const record = this.#raiseRequest(
      caller,
      page,
      conn,
      'agent',
      { tokenId: agent.tokenId, secret: token, label: agent.label },
      now,
    );
    agent.state = 'asking';
    agent.requestId = record.requestId;
    this.#store.agents.put(agent);
    this.#sendAgents(page.pageId);
    return null;
  }

  /**
   * Whether one more agent, an invitee watching, finds no seat: the
   * watching seats where the page has them, otherwise the people the
   * invites may use, members' two kept (ADR 0044, S14).
   */
  #agentSeatFull(pageId: string, waiting: number): boolean {
    return this.#seatOf('invitee', 'observer') === 'watching'
      ? this.#watchingFull(pageId, waiting)
      : this.#pageFull(pageId) || this.#inviteSeatsFull(pageId, waiting);
  }

  /**
   * The operator allowed a token's first request (ADR 0044): an observer
   * whatever the answer named, an invite-made attachment whose invite is
   * the token, ending at the token's end, under its sponsor, so every rule
   * an invite's guest lives by holds (S14). A token or sponsor past its time
   * while the operator decided closes now instead, which answers the
   * request, and a page that filled up meanwhile leaves the token dormant.
   */
  #approveAgent(request: AttachRequestRecord): void {
    const { pageId, userId, requestId } = request;
    const origin = this.#store.pages.get(pageId)?.origin ?? '';
    const existing = this.#store.attachments.get(pageId, userId);
    if (existing) {
      this.#endRequest(requestId, {
        kind: 'attached',
        pageId,
        origin,
        role: existing.role,
        existing: true,
      });
      return;
    }
    const agent =
      request.agentTokenId === null
        ? undefined
        : this.#store.agents.get(pageId, request.agentTokenId);
    // Closing a token ends what waits on it, so this is only a guard.
    if (agent?.requestId !== requestId) {
      this.#endRequest(
        requestId,
        hubError('pairing_expired', 'this agent token is no longer live'),
      );
      return;
    }
    // A token or sponsor past its time closes here, which answers this request.
    if (this.#agentIdentity(agent, Date.now()) === null) {
      if (this.#store.requests.get(requestId) !== undefined) {
        this.#endRequest(
          requestId,
          hubError('pairing_expired', 'this agent token is no longer live'),
        );
      }
      return;
    }
    if (this.#agentSeatFull(pageId, 0)) {
      this.#log.info('approval refused: the page filled up while the operator decided', {
        pageId,
        userId,
      });
      this.#endRequest(
        requestId,
        hubError(
          'page_busy',
          'the page has no room left for anyone else to watch; its operator can revoke someone to make room',
        ),
      );
      return;
    }
    agent.state = 'attached';
    agent.requestId = null;
    this.#store.agents.put(agent);
    const attachment = this.#grant(request, 'observer', {
      inviteId: agent.tokenId,
      role: 'observer',
      sponsor: agent.sponsor,
      endsAt: agent.expiresAt,
    });
    this.#endRequest(requestId, {
      kind: 'attached',
      pageId,
      origin,
      role: attachment.role,
      existing: false,
      sponsor: agent.sponsor.displayName,
    });
    this.#sendAgents(pageId);
  }

  /**
   * A token's prompt went unanswered: the token goes back to waiting for its
   * next request, and its third such prompt burns it (ADR 0044), so a leaked
   * token cannot bury the operator in prompts.
   */
  #agentTimedOut(pageId: string, tokenId: string): void {
    const agent = this.#store.agents.get(pageId, tokenId);
    if (agent === undefined) return;
    agent.timeouts = Math.min(AGENT_BURN_TIMEOUTS, agent.timeouts + 1);
    if (agent.timeouts >= AGENT_BURN_TIMEOUTS) {
      this.#agents.end(agent, 'burned');
      return;
    }
    this.#store.agents.put(agent);
    this.#sendAgents(pageId);
  }

  /**
   * After a token's record went (agents.ts): its request still waiting on
   * the operator ends, its attachment ends with its calls and waits (S8)
   * under a record of why, unless its page's end takes the attachment
   * itself, the relay ends its MCP sessions and listen streams, and the page
   * hears. An attachment already ended (a revoke, its time, its sponsor's
   * end) needs nothing more here.
   */
  #agentClosed(agent: AgentTokenRecord, reason: AgentCloseReason): void {
    const { pageId, userId } = agent;
    this.#agentRefusals.delete(attachmentKey(pageId, agent.tokenId));
    const message = AGENT_CLOSED_MESSAGES[reason];
    if (agent.requestId !== null && this.#store.requests.get(agent.requestId) !== undefined) {
      this.#endRequest(agent.requestId, hubError('denied_by_operator', message));
    }
    const page = this.#store.pages.get(pageId);
    if (reason !== 'page_gone' && this.#store.attachments.get(pageId, userId) !== undefined) {
      this.#endAttachments(pageId, new Set([userId]), 'revoked', message);
      if (page) {
        const now = Date.now();
        if (reason === 'expired' || reason === 'sponsor_gone' || reason === 'session_ended') {
          this.#auditExpire(page, userId, reason === 'expired' ? 'ends_at' : reason, now);
        } else {
          this.#audit({
            v: AUDIT_VERSION,
            type: 'revoke',
            at: now,
            pageId,
            origin: page.origin,
            userId,
            everyone: false,
          });
        }
      }
      this.#sendRoster(pageId);
    }
    this.#agentListener?.(userId);
    this.#sendAgents(pageId);
  }

  /**
   * Who to tell when an agent token closes (relay.ts ends the agent user's
   * MCP sessions and listen streams, ADR 0044). Called inside the hub's own
   * changes, so it must not call back into the hub.
   */
  onAgentClosed(listener: (userId: string) => void): void {
    this.#agentListener = listener;
  }

  /**
   * How to find the account behind a user id under the member list in force
   * (relay.ts hands it MemberList.accountIdOf when there is a list), so an
   * invite's revoke bar follows the account across member list changes and
   * restarts (#bar, S14). It must answer from the list alone.
   */
  useAccountIds(accountIdOf: (userId: string) => string): void {
    this.#accountIdOf = accountIdOf;
  }

  /**
   * pair_page on /g/mcp (ADR 0044): never a code or an invite, which the
   * agent may not use, only its own token's standing. Attached answers at
   * once; asking waits on the token's own request as pair_page waits on any
   * (PAIR_WAIT_MS), charged what the request holds; dormant says why its
   * latest request raised no prompt.
   */
  async agentPair(
    caller: CallerIdentity,
    signal: AbortSignal,
    heldBytes = 0,
  ): Promise<PairOutcome> {
    const now = Date.now();
    const agent = this.#agents.ofUser(caller.userId);
    if (
      agent === null ||
      agent.pageId !== caller.agentPageId ||
      this.#agentIdentity(agent, now) === null
    ) {
      return hubError('denied_by_operator', 'this agent token is no longer live');
    }
    const { pageId } = agent;
    if (agent.state === 'attached') {
      const access = this.#access(caller.userId, pageId);
      const attachment = this.#store.attachments.get(pageId, caller.userId);
      if (access.kind === 'error' && access.code !== 'page_asleep') return access;
      if (attachment === undefined) return notAttached(pageId);
      return {
        kind: 'attached',
        pageId,
        origin: this.#store.pages.get(pageId)?.origin ?? '',
        role: attachment.role,
        existing: true,
        ...this.#sponsorNamed(attachment),
      };
    }
    const pending =
      agent.requestId === null ? undefined : this.#store.requests.get(agent.requestId);
    if (pending === undefined) {
      if (this.#livePage(pageId) === null) {
        return hubError(
          'page_asleep',
          'the page is not connected right now; try again when it is back',
        );
      }
      return (
        this.#agentRefusals.get(attachmentKey(pageId, agent.tokenId)) ??
        hubError('timeout', 'the page operator has not been asked yet; call pair_page again')
      );
    }
    const held = this.#holdBytes(caller, heldBytes, 'rate_limited');
    if (held.kind === 'error') return this.#refusedBeforePage(caller, 'agent', agent.tokenId, held);
    try {
      return await this.#waitForDecision(pending, signal);
    } finally {
      held.release();
    }
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
      // A page a restart snapshot put back is charged, at its first resume,
      // to the address it resumes from, under that address's own limit as a
      // new page session would be (S9); with no room it stays asleep and
      // resumable, as a refused new session may try again later.
      if (this.#pageAddress.get(page.pageId) === RESTORED_ADDRESS) {
        const noRoom = this.#roomAtAddress(conn.address);
        if (noRoom !== null) {
          this.#closeSocket(conn, CLOSE_TRY_AGAIN_LATER, noRoom);
          return;
        }
        this.#chargeTo(page.pageId, conn.address);
      }
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
        // Nor what the old socket published or was asked to decide (page-parts.ts).
        this.#parts.resumed(page.pageId);
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
      // A reload may send a new ceiling, never a way past a live session
      // (S5, ADR 0043): the policy in force stays the narrower of the two,
      // field by field, and so does the session's own, which the session
      // frame after the welcome tells the page. Drivers past a seat count the
      // smaller ceiling lowered are demoted before the welcome lists them.
      this.#endSessionIfDue(page.pageId);
      const was = page.policy;
      page.ceiling = frame.policy;
      const session = page.timedSession;
      if (session !== null) {
        const narrowed = narrowPolicy(frame.policy, session.policy);
        session.policy = { maxDrivers: narrowed.maxDrivers, proposals: narrowed.proposals };
      }
      page.policy = narrowPolicy(frame.policy, session?.policy ?? null);
      if (session !== null) this.#demoteDrivers(page);
      if (page.policy.maxDrivers !== was.maxDrivers || page.policy.proposals !== was.proposals) {
        this.#parts.policyChanged(page.pageId);
      }
    } else {
      const noRoom = this.#makeRoom(conn.address);
      if (noRoom !== null) {
        this.#closeSocket(conn, CLOSE_TRY_AGAIN_LATER, noRoom);
        return;
      }
      let pageId = newId('pg');
      while (this.#store.pages.get(pageId)) pageId = newId('pg');
      this.#chargeTo(pageId, conn.address);
      page = {
        pageId,
        origin: conn.origin,
        title: frame.title,
        url: frame.url,
        adapterVersion: frame.adapterVersion,
        // A new page session starts with no time-boxed session, so the policy
        // in force is its ceiling.
        policy: frame.policy,
        ceiling: frame.policy,
        // The operator starts one on the page, never the hello (#sessionFrame).
        timedSession: null,
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
    // Likewise its time-boxed session (ADR 0043) and agent tokens (ADR 0044).
    this.#sendSession(page.pageId);
    this.#sendAgents(page.pageId);
    this.#rosterSentAt.set(page.pageId, now);
    this.#startHeartbeat(conn);
    this.connectionLine(conn.address, 'info', 'page connected', {
      pageId: page.pageId,
      origin: page.origin,
      resumed,
    });
  }

  /**
   * From M6 the welcome also says how large an image the relay passes (0
   * for none, ADR 0039), that it takes page state (ADR 0040), and the
   * page's people limit and watching seats, none of which exist with
   * invites off (ADR 0044), so the adapter sends nothing an older relay
   * would only ignore. Each says only what this relay does: an adapter that
   * believed more would send images and state that nothing here passes on.
   */
  #limits(): Limits {
    const { timings, limits, invites } = this.#config;
    return {
      maxFrameBytes: MAX_FRAME_BYTES,
      maxResultChars: MAX_RESULT_CHARS,
      maxDescriptionChars: MAX_DESCRIPTION_CHARS,
      pingIntervalMs: timings.pingIntervalMs,
      idleTimeoutMs: timings.idleTimeoutMs,
      resumeWindowMs: timings.resumeWindowMs,
      attachRequestTtlMs: timings.attachRequestTtlMs,
      maxImageBytes: limits.imageBytes,
      maxStateBytes: MAX_STATE_BYTES,
      usersPerPage: limits.usersPerPage,
      observersPerPage: invites ? limits.observersPerPage : 0,
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
   * A state frame costs a parse and a re-encode of up to MAX_STATE_BYTES,
   * whether or not it changes anything, so like a tools frame each socket
   * gets a budget of them and each remote address one across its sockets and
   * reconnects, every frame counted, an equal one too (ADR 0040, S9). A
   * conforming adapter sends at most two a second; past either budget the
   * socket closes as a policy breach, leaving the page asleep and resumable.
   */
  #stateFrameAllowed(conn: Conn): boolean {
    const now = Date.now();
    const { stateFramesPerSocket, stateFramesWindowMs } = this.#config.rateLimits;
    conn.stateFrames = conn.stateFrames.filter((at) => at > now - stateFramesWindowMs);
    if (conn.stateFrames.length >= stateFramesPerSocket) {
      this.connectionLine(conn.address, 'warn', 'closing page socket: too many state frames', {
        pageId: conn.pageId,
      });
      this.#closeSocket(conn, CLOSE_POLICY, 'too many state frames');
      return false;
    }
    if (!this.#stateFrameLimiter.allows(conn.address, now)) {
      this.connectionLine(
        conn.address,
        'warn',
        'closing page socket: too many state frames from its address',
        { pageId: conn.pageId, address: conn.address },
      );
      this.#closeSocket(conn, CLOSE_POLICY, 'too many state frames from this address');
      return false;
    }
    this.#stateFrameLimiter.record(conn.address, now);
    conn.stateFrames.push(now);
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
    this.#sleep(pageId, conn.address, detached);
    // A deliberate detach will not come back, so skip the resume window.
    if (detached) {
      this.connectionLine(conn.address, 'info', 'page detached', { pageId });
      this.#gone(pageId);
    }
  }

  /** `detaching`: the page detached on purpose, and #gone follows at once. */
  #sleep(pageId: string, address: string, detaching: boolean): void {
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
    // Nothing reaches a sleeping page, so what waits on it ends too
    // (page-parts.ts). A detach is told to the parts only as their page's
    // end, so a waiter hears page_gone, never that the page may come back.
    if (!detaching) this.#parts.sleep(pageId);
    this.#setTimer(this.#lifecycleTimers, pageId, this.#config.timings.resumeWindowMs, () => {
      this.#gone(pageId);
    });
    this.connectionLine(address, 'info', 'page asleep', { pageId });
  }

  /**
   * The page's waiting requests end with its socket. An agent token asking
   * goes back to waiting for its next request, with no timeout counted
   * (#endRequest): the operator was never given the chance to answer.
   */
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
    // A time-boxed session ends with its page, before the attachments go,
    // so its record counts them (ADR 0043).
    this.#endSession(pageId, 'page_gone');
    // Questions about calls to it end with it, and one held open answers page_gone now (ADR 0026).
    this.#confirmations.drop(pageId, null, PAGE_GONE_ANSWER);
    this.#parts.gone(pageId);
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
    page.policy = { ...page.policy, consequentialTools: [], imageTools: [] };
    page.ceiling = { ...page.ceiling, consequentialTools: [], imageTools: [] };
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

  /**
   * Whether the page already holds as many people as it may (S9): everyone
   * but the invitees watching by invite, who sit in seats of their own
   * (ADR 0044), so a room of watchers never takes a member's place.
   */
  #pageFull(pageId: string): boolean {
    return this.#seated(pageId, 'people') >= this.#config.limits.usersPerPage;
  }

  #pageFullError(when: string): HubError {
    return hubError(
      'page_busy',
      `the page ${when} ${String(this.#config.limits.usersPerPage)} users attached, the most it allows; its operator can revoke someone to make room`,
    );
  }

  /** The watching seats a page has, beside its people: none without invites, whatever the setting (ADR 0044). */
  #watchingSeats(): number {
    return this.#config.invites ? this.#config.limits.observersPerPage : 0;
  }

  /**
   * Which seat an attachment of this kind and role fills (ADR 0044). Only an
   * invitee's observer watches: a member in any role, an invitee driver and
   * anything let in by code, QR or autoApprove count among the people. With
   * no watching seats, 0 restoring M5's rule, everyone does.
   */
  #seatOf(kind: UserKind, role: Role): Seat {
    return this.#watchingSeats() > 0 && kind === 'invitee' && role === 'observer'
      ? 'watching'
      : 'people';
  }

  /** The page's attachments in one seat. */
  #seated(pageId: string, seat: Seat): number {
    return this.#store.attachments
      .listForPage(pageId)
      .filter((attachment) => this.#seatOf(attachment.kind, attachment.role) === seat).length;
  }

  /**
   * Whether the page's watching seats are full, counting `waiting` requests
   * that would take one; a page with none is always full (ADR 0044). A
   * demotion may leave more watchers than seats until someone leaves, and
   * every watch redemption is refused meanwhile.
   */
  #watchingFull(pageId: string, waiting: number): boolean {
    return this.#seated(pageId, 'watching') + waiting >= this.#watchingSeats();
  }

  #watchingFullError(): HubError {
    return hubError(
      'page_busy',
      'the page has no room left for anyone else to watch by invite; its operator can revoke someone to make room',
    );
  }

  /**
   * Redemptions waiting on the operator that would take a seat of this
   * kind, judged as #redeem judges a new one: by the account and the
   * invite's role, before any driver limit, which only the approval knows.
   * An agent token's waiting prompt counts too, as the invitee observer it
   * would be once allowed (ADR 0044), so a watch redemption and an agent's
   * first request never both count on the last seat.
   */
  #waitingFor(pageId: string, seat: Seat): number {
    return this.#store.requests.listForPage(pageId).filter((request) => {
      if (request.agentTokenId !== null) return seat === this.#seatOf('invitee', 'observer');
      if (request.inviteId === null) return false;
      const invite = this.#store.invites.get(pageId, request.inviteId);
      return this.#seatOf(request.account.kind, invite?.role ?? 'observer') === seat;
    }).length;
  }

  /**
   * Whether an attachment of this kind, moving from `from` to `to`, finds
   * no room in the seats it moves into (ADR 0044): only a watcher made a
   * driver moves into the people, and an invite-made one there also leaves
   * members their reserve (S14). Taking a role away never needs a seat.
   */
  #noSeatFor(attachment: AttachmentRecord, to: Role): boolean {
    if (this.#seatOf(attachment.kind, attachment.role) !== 'watching') return false;
    if (this.#seatOf(attachment.kind, to) !== 'people') return false;
    return (
      this.#pageFull(attachment.pageId) ||
      (attachment.inviteId !== null && this.#inviteSeatsFull(attachment.pageId, 0))
    );
  }

  /**
   * A watcher's call past the page's share of its calls, or null to go on
   * (ADR 0044); members and the page's people are never held to it. Forty
   * watchers each at their own rate would run a handler in the operator's
   * tab many times a second, so they share a rate per page, each has a
   * smaller one of their own, and only a few of their calls run at once,
   * of which one watcher may hold only some: a slow read-only tool may run
   * for the whole call deadline, and one watcher refilling every place
   * would keep the rest of the room out. Only a call that passes is
   * counted, and its places among those running are given back with the
   * rest of what the call holds (`trace.release`), however it ends. A
   * refusal is a call record within the refusal budget, written as every
   * refused call's is (S7).
   */
  #watchingShareRefusal(
    pageId: string,
    attachment: AttachmentRecord,
    trace: CallTrace,
  ): HubError | null {
    if (this.#seatOf(attachment.kind, attachment.role) !== 'watching') return null;
    // A 2025-era call confirmed inside its request passes every check twice, and is one call.
    if (this.#watchingCharged.has(trace)) return null;
    const now = Date.now();
    const { userId } = attachment;
    const userKey = attachmentKey(pageId, userId);
    const { watchingCallsPerPage, watchingCallsPerUserPerPage, windowMs } = this.#config.rateLimits;
    const window = formatDuration(windowMs);
    if (!this.#watchingUserCalls.allows(userKey, now)) {
      this.#log.debug("call refused: past a watcher's share of the page's calls", {
        pageId,
        userId,
      });
      return hubError(
        'rate_limited',
        `a watcher may make ${String(watchingCallsPerUserPerPage)} calls to this page in ${window}, and you have; wait, or read its published state with get_page_state instead`,
      );
    }
    if (!this.#watchingPageCalls.allows(pageId, now)) {
      this.#log.debug("call refused: past the watchers' share of the page's calls", {
        pageId,
        userId,
      });
      return hubError(
        'rate_limited',
        `this page's watchers have made the ${String(watchingCallsPerPage)} calls they share in ${window}; wait, or read its published state with get_page_state instead`,
      );
    }
    const { watchingCallsInFlight: inFlight, watchingCallsInFlightPerUser: inFlightEach } =
      this.#config.limits;
    const mine = this.#watcherRunning.get(userKey) ?? 0;
    if (mine >= inFlightEach) {
      this.#log.debug("call refused: past a watcher's share of the page's calls running", {
        pageId,
        userId,
      });
      return hubError(
        'rate_limited',
        `a watcher may have ${String(inFlightEach)} calls running on this page at once, and you have; let one end first, or read its published state with get_page_state instead`,
      );
    }
    const running = this.#watchingRunning.get(pageId) ?? 0;
    if (running >= inFlight) {
      this.#log.debug("call refused: the watchers' calls already running on the page", {
        pageId,
        userId,
      });
      return hubError(
        'page_busy',
        `${String(inFlight)} calls from this page's watchers are already running; try again shortly`,
      );
    }
    this.#watchingUserCalls.record(userKey, now);
    this.#watchingPageCalls.record(pageId, now);
    this.#watchingRunning.set(pageId, running + 1);
    this.#watcherRunning.set(userKey, mine + 1);
    this.#watchingCharged.add(trace);
    const bytes = trace.release;
    let released = false;
    trace.release = () => {
      if (released) return;
      released = true;
      bytes?.();
      giveBack(this.#watchingRunning, pageId);
      giveBack(this.#watcherRunning, userKey);
    };
    return null;
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
    // An agent token's prompt offers observer or nothing, and a denial means
    // the operator does not know the agent, so the token dies (ADR 0044).
    if (request.agentTokenId !== null) {
      if (frame.allow) {
        this.#approveAgent(request);
        return true;
      }
      this.#log.info('agent token denied', { pageId, tokenId: request.agentTokenId });
      this.#endRequest(request.requestId, {
        kind: 'error',
        code: 'denied_by_operator',
        message: AGENT_CLOSED_MESSAGES.denied,
      });
      const agent = this.#store.agents.get(pageId, request.agentTokenId);
      if (agent !== undefined) this.#agents.end(agent, 'denied');
      return true;
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
    // The role first, as the driver limit leaves it, since the role says
    // which seats it takes: an invitee kept an observer watches (ADR 0044).
    const role = this.#cappedRole(pageId, userId, lesserRole(invite.role, decided));
    // #cappedRole first ends a time-boxed session past its end (ADR 0043),
    // which closes its invites and ends what waits on them: then this
    // request has had its answer, and nothing is granted under it.
    if (this.#store.requests.get(request.requestId) === undefined) return;
    const watching = this.#seatOf(request.account.kind, role) === 'watching';
    const full = watching
      ? this.#watchingFull(pageId, 0)
      : this.#pageFull(pageId) || this.#inviteSeatsFull(pageId, 0);
    if (full) {
      this.#log.info('approval refused: the page filled up while the operator decided', {
        pageId,
        userId,
      });
      this.#endRequest(
        request.requestId,
        watching ? this.#watchingFullError() : this.#pageFullError('filled up meanwhile and has'),
      );
      return;
    }
    const attachment = this.#grant(request, role, invite);
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
   * the invite's own record may go first; one an agent token makes keeps the
   * same, its token in the invite's place and its end the token's (ADR 0044).
   */
  #grant(request: GrantRequest, wanted: Role, invite?: GrantDoor): AttachmentRecord {
    const existing = this.#store.attachments.get(request.pageId, request.userId);
    if (existing) return existing;
    const now = Date.now();
    // Newest first, as every roster lists clients; a joined device came after the first.
    const clients = [...(request.joined ?? [])].reverse();
    if (request.client) clients.push(request.client);
    // A live time-boxed session ends what its invites let in with it (ADR 0043).
    const longest = now + MAX_INVITE_LIFETIME_MS;
    const endsAt =
      invite === undefined
        ? null
        : this.#sessionCap(
            request.pageId,
            invite.endsAt === undefined ? longest : Math.min(invite.endsAt, longest),
          );
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
    this.#endSessionIfDue(pageId);
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
    this.#endSessionIfDue(pageId);
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
    let capped = this.#cappedRole(pageId, frame.userId, wanted);
    // A watcher made a driver moves among the people, so it needs a seat
    // there, as a grant does; a demotion into full watching seats is never
    // refused, since it only takes access away (ADR 0044).
    if (capped !== attachment.role && this.#noSeatFor(attachment, capped)) {
      this.#log.info("set_role refused: no seat left among the page's people", {
        pageId,
        userId: frame.userId,
      });
      capped = attachment.role;
    }
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
   * every live invite (ADR 0017) and every agent token, and revoking an
   * agent closes its token (ADR 0044). Answers whether it ended anything: an
   * attachment, a waiting request, an invite or a token.
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
    // An agent's token dies with the access revoke takes (ADR 0044). One not
    // attached, waiting for its first prompt or asking, closes here; one
    // attached closes as revoked when its attachment ends just below
    // (attachmentsEnded), under the revoke record written for it there, and
    // Revoke all takes every token, so each later request gets 404.
    let agentsClosed = 0;
    for (const agent of this.#store.agents.listForPage(pageId)) {
      if (!everyone && agent.userId !== frame.userId) continue;
      if (this.#store.attachments.get(pageId, agent.userId) !== undefined) continue;
      if (this.#agents.end(agent, 'revoked')) agentsClosed += 1;
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
    let ended = targets.length + agentsClosed;
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
   * invite may have sponsored invites of their own, which end in turn. Their
   * agent tokens end with them as well (ADR 0044), counted with the invites.
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
      // Their agent tokens too, which their attachment's end has closed
      // already (attachmentsEnded), counted beside the invites (ADR 0044).
      const agents = this.#agents.sponsorGone(pageId, sponsor);
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
      if (invites.length > 0 || agents > 0 || made.length > 0) {
        changed = true;
        this.#audit({
          v: AUDIT_VERSION,
          type: 'sponsor_gone',
          at: Date.now(),
          pageId,
          origin: this.#store.pages.get(pageId)?.origin ?? '',
          sponsor,
          // The agent tokens their end closed count among the invites (ADR 0044).
          invites: invites.length + agents,
          attachments: made.length,
        });
        this.#log.info('sponsor gone: their invites and what those made ended', {
          pageId,
          userId: sponsor,
          invites: invites.length,
          agents,
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
    // ADR 0026: no confirmation outlives the attachment it was given under,
    // and a 2025-era call waiting on its question answers now (S8).
    this.#confirmations.drop(pageId, users, outcome);
    // Nor a wait, a proposal or an agent token's hold (S8, page-parts.ts).
    this.#parts.attachmentsEnded(pageId, users, outcome);
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
    // An end the session capped is the session's to end, whichever timer runs first (ADR 0043).
    this.#endSessionIfDue(pageId);
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

  /**
   * The page's roster, an invitee's row listing only its newest
   * MAX_ROSTER_CLIENTS_PER_INVITEE clients (ADR 0044): clients name
   * themselves on every call, so a room of guests each rotating names would
   * otherwise pass the frame cap, and the adapter, refusing the welcome,
   * would reconnect into the same welcome again and again.
   */
  #roster(pageId: string): AttachmentView[] {
    return this.#store.attachments.listForPage(pageId).map((attachment) => ({
      userId: attachment.userId,
      displayName: attachment.displayName,
      kind: attachment.kind,
      role: attachment.role,
      grantedAt: attachment.grantedAt,
      lastUsedAt: attachment.lastUsedAt,
      expiresAt: attachment.expiresAt,
      clients: attachment.clients.slice(
        0,
        attachment.kind === 'invitee' ? MAX_ROSTER_CLIENTS_PER_INVITEE : MAX_ROSTER_CLIENTS,
      ),
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
        // An agent token's request names its token where an invite's names the invite (ADR 0044).
        inviteId: request.inviteId ?? request.agentTokenId,
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
    // A token whose prompt ended unapproved waits for its next request; an
    // approval has made it attached already (#approveAgent). A timeout is
    // counted by the request's own timer, never by a page that went to sleep.
    if (request?.agentTokenId !== null && request?.agentTokenId !== undefined) {
      const agent = this.#store.agents.get(request.pageId, request.agentTokenId);
      if (agent?.requestId === requestId) {
        agent.requestId = null;
        agent.state = 'dormant';
        this.#store.agents.put(agent);
        this.#sendAgents(request.pageId);
      }
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
    if (frame.ok && frame.image !== undefined) {
      // Checked only here, after the lookup on this socket, so a frame for
      // no call of this page costs no decoding or hashing (S9).
      call.settle(this.#checkedImage(pageId, call, origin, frame.content ?? '', frame.image));
      return;
    }
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

  /**
   * A page's image, checked again before any client sees it (ADR 0039,
   * S10). The tool must be one the hello's policy.imageTools names, so no
   * crafted frame turns any other tool into an image source; then the
   * protocol's checkImage, the one the adapter ran, since the SDK passes
   * malformed base64 and any type and its client then fails the whole
   * result, label included. A refusal is a tool_error in relay words alone,
   * the page's text dropped with it, and its reason goes on the call's
   * record. A pass keeps the base64 as it came, since nothing here
   * re-encodes, and records the type, decoded size and SHA-256, never the
   * data (S7).
   */
  #checkedImage(
    pageId: string,
    call: PendingCall,
    origin: string,
    content: string,
    image: WireImage,
  ): SettledCall {
    const declared = this.#store.pages.get(pageId)?.policy.imageTools.includes(call.toolName);
    const checked: CheckedImage =
      declared === true
        ? checkImage(image, this.#config.limits.imageBytes)
        : {
            ok: false,
            reason: 'undeclared',
            message: 'the page did not declare this tool an image tool',
          };
    if (!checked.ok) {
      call.trace.imageRefused = checked.reason;
      return {
        kind: 'tool_error',
        origin,
        message: `tabdock refused this tool's image: ${checked.message}`,
        imageRefused: checked.reason,
      };
    }
    const bytes = checked.bytes.length;
    const sha256 = createHash('sha256').update(checked.bytes).digest('hex');
    call.trace.image = { mimeType: checked.mimeType, bytes, sha256 };
    return {
      kind: 'ok',
      origin,
      content,
      image: { mimeType: checked.mimeType, data: image.data, bytes, sha256 },
    };
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
   * The member list changed (ADR 0043). Whatever an account held under a
   * user id the change took from it ends at once, as a revoke would (S8):
   * its attachments on every page, in-flight calls cancelled and queued ones
   * answered not_attached, each with an expire record; the invites it
   * sponsored and what those let in; its pending attach requests; and its
   * place among a gone page's former users, so an id handed to someone else
   * shows them none of its old pages (S13). A member renamed keeps all of it
   * under the new name, and an invitee whose name now reads as a member's is
   * shown by its short id instead (ADR 0017). The relay ends the account's
   * MCP sessions, listen streams and /pair sign-ins beside this.
   */
  membershipChanged(change: MemberChange): { attachments: number } {
    const now = Date.now();
    const members = new Set(change.memberNames.map(foldName));
    let ended = 0;
    for (const page of this.#store.pages.all()) {
      const { pageId } = page;
      if (page.state === 'gone') {
        const former = page.formerAttachments.filter((entry) => !change.ended.has(entry.userId));
        if (former.length !== page.formerAttachments.length) {
          page.formerAttachments = former;
          this.#store.pages.put(page);
        }
        continue;
      }
      const targets = this.#store.attachments
        .listForPage(pageId)
        .filter((attachment) => change.ended.has(attachment.userId));
      if (targets.length > 0) {
        this.#endAttachments(
          pageId,
          new Set(targets.map((attachment) => attachment.userId)),
          'revoked',
          'your membership on this relay changed, so this attachment ended; sign in and pair again',
        );
        for (const target of targets) {
          this.#auditExpire(page, target.userId, 'membership_changed', now);
        }
        ended += targets.length;
      }
      for (const request of this.#store.requests.listForPage(pageId)) {
        if (change.ended.has(request.userId)) {
          this.#endRequest(
            request.requestId,
            hubError(
              'pairing_expired',
              'your membership on this relay changed while the request waited; sign in and pair again',
            ),
          );
          continue;
        }
        const name = this.#renamed(request.userId, request.displayName, change.renamed, members);
        if (name !== null) {
          request.displayName = name;
          this.#store.requests.put(request);
        }
      }
      let renamed = false;
      for (const attachment of this.#store.attachments.listForPage(pageId)) {
        const name = this.#renamed(
          attachment.userId,
          attachment.displayName,
          change.renamed,
          members,
        );
        if (name === null) continue;
        attachment.displayName = name;
        this.#store.attachments.put(attachment);
        renamed = true;
      }
      // Their invites close and what those let in ends, as when a sponsor detaches (ADR 0017).
      if (targets.length > 0) this.#loseSponsors(pageId, targets);
      if (targets.length > 0 || renamed) this.#sendRoster(pageId);
    }
    this.#audit({
      v: AUDIT_VERSION,
      type: 'members_reloaded',
      at: now,
      members: change.total,
      added: change.added.slice(0, MAX_MEMBERS),
      removed: change.removed.slice(0, MAX_MEMBERS),
      renamed: change.renamed.size,
      attachments: ended,
    });
    return { attachments: ended };
  }

  /**
   * The name a member list change gives someone the relay holds, or null
   * when it stays: a renamed member's new name, and for an invitee whose
   * name now folds to a member's, `invitee <short id>`, as at sign-in. It
   * takes the renames alone, so a restart snapshot's restore names people
   * by the same rule (restoreSnapshot).
   */
  #renamed(
    userId: string,
    displayName: string,
    renamed: ReadonlyMap<string, string>,
    members: ReadonlySet<string>,
  ): string | null {
    const name = renamed.get(userId);
    if (name !== undefined) return name === displayName ? null : name;
    if (!userId.startsWith(INVITEE_ID_PREFIX) || !members.has(foldName(displayName))) return null;
    const short = `invitee ${userId.slice(INVITEE_ID_PREFIX.length, INVITEE_ID_PREFIX.length + INVITEE_SHORT_ID_CHARS)}`;
    return short === displayName ? null : short;
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
    // An agent watches its token's one page and no other, whatever it names
    // (S13, ADR 0044); its id holds that page already, so this is a guard.
    const agentPage = this.#agents.pageOf(userId);
    if (agentPage !== null && agentPage !== pageId) return notAttached(pageId);
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
    // ADR 0042: an observer the page takes proposals from may propose what
    // they may not run, so a model reading allowed: false still tries.
    const proposes = attachment.role === 'observer' && this.#takesProposalsFrom(page, attachment);
    return {
      kind: 'tools',
      pageId,
      origin: page.origin,
      role: attachment.role,
      tools: page.tools.map((tool) => {
        const annotations = tool.annotations ?? {};
        const allowed = attachment.role === 'driver' || annotations.readOnlyHint === true;
        // Under deny a consequential tool is refused as a proposal too.
        const denied = page.policy.consequential === 'deny' && tool.consequential === true;
        return {
          name: tool.name,
          ...(tool.title === undefined ? {} : { title: tool.title }),
          // S10: the description and schema were already cut when the tools frame arrived (cutTool).
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations,
          allowed,
          ...(firstClass === null ? {} : { firstClass: firstClass.get(tool.name) ?? null }),
          ...(proposes && !allowed && !denied ? { proposable: true as const } : {}),
        };
      }),
    };
  }

  /**
   * get_page_state (ADR 0040): the page's latest published state, read
   * through the same access check as list_page_tools, so an unknown page and
   * someone else's answer alike (S13), and a page asleep or still resuming
   * answers page_asleep. Every attached role may read it, and reading runs
   * no page code, writes no record and moves no idle expiry (ADR 0009).
   */
  getPageState(userId: string, pageId: string): StateOutcome {
    const access = this.#access(userId, pageId);
    if (access.kind === 'error') return access;
    return this.#stateOutcome(access, this.#states.read(pageId), null);
  }

  #stateOutcome(
    access: { page: PageRecord; conn: Conn },
    view: StateView,
    changed: boolean | null,
  ): StateOutcome {
    return {
      kind: 'state',
      pageId: access.page.pageId,
      origin: access.page.origin,
      version: view.version,
      publishedAt: view.publishedAt,
      heardAt: access.conn.heardAt,
      text: view.text,
      changed,
    };
  }

  /**
   * wait_for_page_state (ADR 0040): answers at once when the version is not
   * `after` (it moved, or `after` is ahead of it, so nobody waits on a number
   * the page never reached) or when `timeoutMs` is 0, and otherwise once the
   * version moves or the time runs out, which is never past MAX_WAIT_MS or
   * the call deadline. A wait that waits holds one of its user's two wait
   * slots and one of the page's (waits.ts), and its request's charge
   * (#holdBytes), so a room cannot pin the relay with idle waits; refused
   * past either, it answers rate_limited with a request_refused record
   * within the refusal budget (S7, S9). An ended attachment, a sleep, a
   * reload or the page's end answer it at once (S8), and access is checked
   * again after the wait, so a late expiry timer never hands a value to
   * someone no longer attached.
   */
  async waitForPageState(
    caller: CallerIdentity,
    pageId: string,
    after: number,
    timeoutMs: number,
    signal: AbortSignal,
    heldBytes: number,
  ): Promise<StateOutcome> {
    const { userId } = caller;
    const access = this.#access(userId, pageId);
    if (access.kind === 'error') return access;
    const now = this.#states.read(pageId);
    if (now.version !== after || timeoutMs <= 0) {
      return this.#stateOutcome(access, now, now.version !== after);
    }
    const slot = this.#waits.take(userId, pageId, caller.account.kind === 'invitee');
    if (typeof slot === 'string') {
      this.#log.debug('page state wait refused: too many waits', { userId, pageId, limit: slot });
      this.refusedByBudget(caller, { tool: 'wait_for_page_state', page: pageId });
      return hubError('rate_limited', WAIT_REFUSALS[slot]);
    }
    const held = this.#holdBytes(caller, heldBytes, 'rate_limited');
    if (held.kind === 'error') {
      slot.release();
      this.refusedByBudget(caller, { tool: 'wait_for_page_state', page: pageId });
      return held;
    }
    try {
      const waitMs = Math.min(timeoutMs, MAX_WAIT_MS, this.#config.timings.callDeadlineMs);
      this.#log.debug('page state wait started', { userId, pageId, after, waitMs });
      const ended = await this.#states.wait(pageId, userId, waitMs, signal);
      if (ended.kind === 'error') return ended;
      if (ended.kind === 'cancelled') return hubError('timeout', 'the wait was cancelled');
      const again = this.#access(userId, pageId);
      if (again.kind === 'error') return again;
      const latest = this.#states.read(pageId);
      return this.#stateOutcome(again, latest, latest.version !== after);
    } finally {
      held.release();
      slot.release();
    }
  }

  /**
   * get_proposal (ADR 0042): the caller's own proposal on the page, at once,
   * or once it changes when `waitMs` asks to wait (a pending one leaves
   * pending by a decision or an end, an accepted one's run settles), never
   * past MAX_WAIT_MS or the call deadline. A wait holds one of the user's
   * wait slots, shared with wait_for_page_state, and one of the page's
   * (waits.ts, conflict C2), and its request's charge (#holdBytes); refused
   * past either, it answers rate_limited with a request_refused record
   * within the refusal budget (S7, S9). Whatever ends the proposer's
   * attachment answers a wait at once (S8), as the page's sleep, reload or
   * end does (SPEC section 7), and access is checked again after it.
   */
  async getProposal(
    caller: CallerIdentity,
    pageId: string,
    proposalId: string,
    waitMs: number,
    signal: AbortSignal,
    heldBytes: number,
  ): Promise<ProposalAnswer> {
    const { userId } = caller;
    const found = this.#ownProposal(userId, pageId, proposalId);
    if (found.kind === 'error') return found;
    const { record } = found;
    const settled = record.status !== 'pending' && record.outcome !== 'running';
    if (waitMs <= 0 || settled) return proposalAnswer(record);
    const slot = this.#waits.take(userId, pageId, caller.account.kind === 'invitee');
    if (typeof slot === 'string') {
      this.#log.debug('proposal wait refused: too many waits', { userId, pageId, limit: slot });
      this.refusedByBudget(caller, { tool: 'get_proposal', page: pageId });
      return hubError('rate_limited', WAIT_REFUSALS[slot]);
    }
    const held = this.#holdBytes(caller, heldBytes, 'rate_limited');
    if (held.kind === 'error') {
      slot.release();
      this.refusedByBudget(caller, { tool: 'get_proposal', page: pageId });
      return held;
    }
    try {
      const ms = Math.min(waitMs, MAX_WAIT_MS, this.#config.timings.callDeadlineMs);
      this.#log.debug('proposal wait started', { userId, pageId, proposalId, waitMs: ms });
      const ended = await this.#proposals.wait(record, ms, signal);
      if (ended.kind === 'error') return ended;
      if (ended.kind === 'cancelled') return hubError('timeout', 'the wait was cancelled');
      const again = this.#ownProposal(userId, pageId, proposalId);
      return again.kind === 'error' ? again : proposalAnswer(again.record);
    } finally {
      held.release();
      slot.release();
    }
  }

  /**
   * withdraw_proposal (ADR 0042): a pending proposal of the caller's ends,
   * the page hears so and the log closes it; any other answers as it stands,
   * so a second withdrawal, or one that crossed the operator's Accept, is
   * harmless (idempotentHint).
   */
  withdrawProposal(caller: CallerIdentity, pageId: string, proposalId: string): ProposalAnswer {
    const found = this.#ownProposal(caller.userId, pageId, proposalId);
    if (found.kind === 'error') return found;
    if (found.record.status === 'pending') {
      this.#proposals.end(found.record, 'withdrawn', 'withdrawn');
    }
    return proposalAnswer(found.record);
  }

  /**
   * The caller's own proposal on a page they are attached to, asleep or
   * awake, under the attachment it was made under. A gone page answers
   * page_gone to its former users and anyone else not_attached, as the
   * access check does; then an unknown id and another user's answer
   * proposal_not_found in the same words, since an id is a name and never a
   * capability (S13).
   */
  #ownProposal(
    userId: string,
    pageId: string,
    proposalId: string,
  ): { kind: 'ok'; record: ProposalRecord } | HubError {
    const attachment = this.#chainInTime(pageId, userId)
      ? this.#store.attachments.get(pageId, userId)
      : undefined;
    const page = this.#store.pages.get(pageId);
    if (attachment === undefined || page === undefined || page.state === 'gone') {
      if (
        page?.state === 'gone' &&
        page.formerAttachments.some((entry) => entry.userId === userId)
      ) {
        return hubError(
          'page_gone',
          'the page closed and did not come back; its attachments are gone',
        );
      }
      return notAttached(pageId);
    }
    const record = this.#proposals.find(pageId, proposalId, Date.now());
    if (record?.proposer.userId !== userId || record.grantedAt !== attachment.grantedAt) {
      return hubError('proposal_not_found', NO_SUCH_PROPOSAL);
    }
    return { kind: 'ok', record };
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
   * the invite's one prompt or its last uses are taken or the seats it would
   * take are full (an invitee watching takes a watching seat, anyone else
   * one of the people's that invites may use; ADR 0044), or raises a new
   * request. Never autoApprove: the
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
    // The seats it would take, and only the waiting redemptions bound for
    // the same seats (ADR 0044): watching by invite, or among the people.
    const seat = this.#seatOf(caller.account.kind, invite.role);
    const waitingHere = this.#waitingFor(page.pageId, seat);
    if (seat === 'watching' && this.#watchingFull(page.pageId, waitingHere)) {
      this.#log.info('redemption refused: the watching seats are taken', {
        pageId: page.pageId,
        userId: caller.userId,
      });
      return refuse(this.#watchingFullError());
    }
    if (
      seat === 'people' &&
      (this.#pageFull(page.pageId) || this.#inviteSeatsFull(page.pageId, waitingHere))
    ) {
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
   * presented, and an agent token's first request the token (ADR 0044), which
   * the relay forwards and never keeps, so the adapter can check either
   * against its own record (ADR 0017).
   */
  #raiseRequest(
    caller: CallerIdentity,
    page: PageRecord,
    conn: Conn,
    via: AttachVia,
    door: Door | null,
    now: number,
  ): AttachRequestRecord {
    const { attachRequestTtlMs } = this.#config.timings;
    const agent = door !== null && 'tokenId' in door ? door : null;
    const invite = door !== null && 'inviteId' in door ? door : null;
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
      agentTokenId: agent?.tokenId ?? null,
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
      // Silence on a control invite's prompt counts as a refusal (ADR 0016),
      // and on an agent token's toward burning it (ADR 0044).
      if (record.inviteId !== null) this.#inviteRefused(record.pageId, record.inviteId);
      if (record.agentTokenId !== null) this.#agentTimedOut(record.pageId, record.agentTokenId);
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
      ...(agent === null ? {} : { agent }),
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
   * body; 0 for a caller with none. `confirm` says how this request can
   * confirm the call in its client (ADR 0026); null never asks, and the page
   * prompts as before.
   */
  async callPageTool(
    caller: CallerIdentity,
    pageId: string,
    tool: PageToolRef,
    args: JsonObject,
    signal: AbortSignal,
    marks: CallMarks | null = null,
    heldBytes = 0,
    confirm: ConfirmLeg | null = null,
  ): Promise<CallOutcome> {
    const started = Date.now();
    // The duration comes from a clock that only runs forward: a wall clock
    // stepped back during the call would give a negative one, which the
    // record's schema refuses, and the call would lose its line (S7).
    const startedMono = performance.now();
    let auditOutcome: AuditOutcome = 'relay_error';
    // Asking writes nothing: the retry, or the record's expiry, leaves the line (ADR 0026).
    let asked = false;
    const trace: CallTrace = {
      reached: false,
      release: null,
      tool: this.#calledToolName(pageId, tool),
      confirmedBy: null,
      callId: null,
      image: null,
      imageRefused: null,
      proposalId: null,
      acceptedOnPage: false,
    };
    try {
      const outcome = await this.#call(
        caller,
        pageId,
        tool,
        args,
        signal,
        marks,
        trace,
        heldBytes,
        confirm,
      );
      if (outcome.kind === 'ask') {
        asked = true;
        return outcome;
      }
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
      if (!asked) {
        // In finally, so every attempt leaves a record even when the relay itself fails (S7).
        const record = this.#callRecord(started, startedMono, pageId, caller, trace, auditOutcome);
        // A call that reached its page is always written in full; one refused
        // before it went out, or failed by the relay before it could, only
        // within the refusal budget (ADR 0019).
        if (trace.reached || auditOutcome === 'relay_error') this.#audit(record);
        else this.#budget.refused(record);
        this.#spike?.callFinished(pageId, caller.userId, auditOutcome);
      }
    }
  }

  /**
   * A call's line (S7): the client's own text for page and tool, kept when it
   * is an id or a tool name, else only its length (ADR 0019), and from the
   * trace exactly what happened: confirmed in a client (ADR 0026), the
   * invoke's id (ADR 0045), the image's type, size and digest or why the
   * relay refused it (ADR 0039), and the proposal it made or ran (ADR 0042).
   * Never its arguments or results.
   */
  #callRecord(
    started: number,
    startedMono: number,
    pageId: string,
    caller: CallerIdentity,
    trace: CallTrace,
    outcome: AuditOutcome,
  ): AuditCallEvent {
    return {
      v: AUDIT_VERSION,
      type: 'call',
      at: started,
      pageId: auditPageId(pageId),
      origin: this.#store.pages.get(pageId)?.origin ?? null,
      userId: caller.userId,
      client: caller.client,
      tool: auditToolName(trace.tool),
      outcome,
      durationMs: Math.round(performance.now() - startedMono),
      ...(trace.confirmedBy === null ? {} : { confirmedBy: trace.confirmedBy }),
      ...(trace.callId === null ? {} : { callId: trace.callId }),
      ...(trace.image === null ? {} : { image: trace.image }),
      ...(trace.imageRefused === null ? {} : { imageRefused: trace.imageRefused }),
      ...(trace.proposalId === null ? {} : { proposalId: trace.proposalId }),
      ...(trace.acceptedOnPage ? { acceptedOnPage: true } : {}),
    };
  }

  /**
   * The dispatcher's first step for a page call that carries a state
   * (mcp.ts): the record the state names, taken out before any other check,
   * so a retry refused for any reason has spent it (ADR 0026); null when
   * the relay holds none.
   */
  takeConfirmation(id: string): ConfirmationRecord | null {
    return this.#confirmations.take(id);
  }

  /**
   * A record no retry took before its expiry: one call line, within the
   * refusal budget, so a question nobody answered leaves a line while the
   * relay runs (S7, ADR 0026). Never its id or its digest.
   */
  #confirmationExpired(record: ConfirmationRecord): void {
    this.#budget.refused({
      v: AUDIT_VERSION,
      type: 'call',
      at: record.askedAt,
      pageId: auditPageId(record.pageId),
      origin: record.origin,
      userId: record.userId,
      client: record.client,
      tool: auditToolName(record.pageTool),
      outcome: 'not_confirmed',
      durationMs: Math.max(0, Date.now() - record.askedAt),
    });
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
          tool: auditToolName(this.#calledToolName(refused.page, refused.pageTool)),
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
    confirm: ConfirmLeg | null,
  ): Promise<CallOutcome> {
    // A confirmation already given, by a retry that checked out or by an
    // answer inside a 2025-era request; null until then (ADR 0026).
    let confirmation: ClientConfirmation | null = null;
    // The page tool a retry's record or a 2025-era answer was about, which the name must still reach.
    let confirmedTool: string | null = null;
    if (confirm?.retry) {
      const retried = this.#retried(caller, pageId, toolRef, args, confirm);
      if (retried.kind === 'error') return retried;
      confirmation = {
        confirmationId: newId('cf'),
        at: Date.now(),
        grantedAt: retried.grantedAt,
      };
      confirmedTool = retried.pageTool;
    }
    // At most twice: a 2025-era call confirmed in its request passes every check again.
    for (;;) {
      const arrivedAt = Date.now();
      const access = this.#access(caller.userId, pageId);
      if (access.kind === 'error') return access;
      const { page, attachment } = access;
      // A confirmation ends with the attachment it was asked under, even
      // when the operator has approved the caller afresh since (ADR 0026).
      if (confirmation !== null && attachment.grantedAt !== confirmation.grantedAt) {
        return notConfirmed(ASKED_UNDER_ENDED_ATTACHMENT);
      }

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
      // Once per request: a 2025-era call holds its charge from before its
      // question until it ends (ADR 0026, S9).
      if (trace.release === null) {
        const held = this.#holdBytes(caller, heldBytes, 'page_busy');
        if (held.kind === 'error') return held;
        trace.release = held.release;
      }

      // Every call moves the expiry, but only one that passes every check names
      // its client (#nameClient): refused calls must not add names to the roster.
      const rosterAtArrival = this.#touchAttachment(attachment, arrivedAt);
      const resolved = this.#resolveTool(page, attachment, toolRef);
      if (resolved.kind === 'error') return resolved;
      const { tool } = resolved;
      const toolName = tool.name;
      trace.tool = toolName;
      if (confirmedTool !== null && toolName !== confirmedTool) {
        // The name now reaches another tool than the one confirmed.
        return notConfirmed(CONFIRMED_ANOTHER_CALL);
      }
      // S5, relay half: observers run only tools the page marked read-only.
      if (attachment.role === 'observer' && tool.annotations?.readOnlyHint !== true) {
        // ADR 0042: where the page takes proposals from this caller, the
        // write waits for the operator as a proposal instead, never as an
        // invoke. A call confirmed in a client is no proposal (decision 18).
        if (confirmation === null && this.#takesProposalsFrom(page, attachment, caller)) {
          return this.#propose(caller, page, attachment, tool, args, trace);
        }
        return hubError(
          'role_denied',
          `you are an observer on this page, and ${toolName} is not marked read-only`,
        );
      }
      // ADR 0044: a page's watchers share a part of its calls, so a room cannot make its tab stutter.
      const share = this.#watchingShareRefusal(pageId, attachment, trace);
      if (share !== null) return share;

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
        confirmation,
        proposal: null,
        marks,
        trace,
        timer: null,
        done: false,
        settle: () => undefined,
      };
      // Checked before anything waits: the size cannot grow later, as the role
      // and deadline only shrink and a confirmation's room is counted already.
      const encoded = this.#encodeInvoke(
        call,
        attachment.role,
        this.#config.timings.callDeadlineMs,
        null,
      );
      if (encoded.kind === 'error') return encoded;
      call.invokeBytes = encoded.bytes;

      // ADR 0026: a call its caller's client may confirm is asked there,
      // after every check that precedes dispatch, its argument check too, so
      // nobody is asked about a call the relay would refuse; it takes no
      // place in the queue until it is confirmed.
      if (
        confirmation === null &&
        confirm?.formElicitation === true &&
        asksClient(page.policy, tool, { account: caller.account.kind, attachment })
      ) {
        const argumentError = await this.#checkArguments(pageId, tool.name, args);
        if (argumentError) return argumentError;
        // The check waited on the worker, so the caller may have been revoked,
        // detached or demoted, or the page may have ended or changed its
        // tools or policy, before #endAttachments or #gone had a question to
        // drop. All of it is looked at again here, and nothing is awaited
        // from this look until the question's record or wait exists, so any
        // later end drops it (S8, ADR 0026).
        const current = this.#afterCheck(call);
        if (current.kind === 'error') return current;
        const latest = this.#store.pages.get(pageId);
        if (latest === undefined || !this.#stillAsks(call, current.attachment)) {
          // What called for asking changed: the page decides, as for any call.
          return this.#proceed(call, signal, args);
        }
        const { grantedAt } = current.attachment;
        const asked = await this.#ask(
          caller,
          latest,
          { pageTool: tool.name, toolRef, grantedAt },
          args,
          signal,
          confirm,
        );
        if (asked.kind !== 'confirmed') return asked;
        confirmation = { confirmationId: newId('cf'), at: asked.at, grantedAt };
        // The answer was about this page tool; a first-class name that now
        // reaches another one, after the page re-listed, is not_confirmed,
        // as a 2026-07-28 retry is.
        confirmedTool = tool.name;
        continue;
      }

      return this.#proceed(call, signal, args);
    }
  }

  /**
   * A retry's confirmation (ADR 0026), its record already out of the store:
   * the page tool it was asked about when it checks out; otherwise
   * not_confirmed, unless the access check would refuse the call as well,
   * when it answers as that check does (not_attached, as S8 asks of every
   * later call, or page_gone). A 2025-era session never asks this way, so
   * any state there is refused.
   */
  #retried(
    caller: CallerIdentity,
    pageId: string,
    toolRef: PageToolRef,
    args: JsonObject,
    confirm: ConfirmLeg,
  ): { kind: 'ok'; pageTool: string; grantedAt: number } | HubError {
    const refused = (message: string): HubError => {
      const access = this.#access(caller.userId, pageId);
      if (
        access.kind === 'error' &&
        (access.code === 'not_attached' || access.code === 'page_gone')
      ) {
        return access;
      }
      return notConfirmed(message);
    };
    const retry = confirm.retry;
    if (retry === null || confirm.mode !== 'retry' || retry.state.kind !== 'record') {
      return refused(NO_SUCH_CONFIRMATION);
    }
    const { record } = retry.state;
    if (record.userId !== caller.userId) return refused(NO_SUCH_CONFIRMATION);
    const sameCall =
      record.pageId === pageId &&
      record.calledAs === calledAsOf(toolRef) &&
      (typeof toolRef !== 'string' || record.pageTool === toolRef) &&
      record.digest === argumentsDigest(args);
    if (!sameCall) return refused(CONFIRMED_ANOTHER_CALL);
    if (!confirms(retry.answer)) return refused(NOT_CONFIRMED_IN_CLIENT);
    return { kind: 'ok', pageTool: record.pageTool, grantedAt: record.grantedAt };
  }

  /**
   * Puts the question: on 2026-07-28 a record for the retry and an `ask`
   * outcome, its state signed, that mcp.ts answers input_required; on a
   * 2025-era session the question inside the request. A fifth question
   * waiting for one user answers rate_limited. `grantedAt` names the
   * attachment it is asked under, which the caller looked at just before
   * with nothing awaited since, so the record or wait exists before any
   * later end of that attachment can look for it.
   */
  async #ask(
    caller: CallerIdentity,
    page: PageRecord,
    about: { pageTool: string; toolRef: PageToolRef; grantedAt: number },
    args: JsonObject,
    signal: AbortSignal,
    confirm: ConfirmLeg,
  ): Promise<AskInClient | HubError | { kind: 'confirmed'; at: number }> {
    const { pageTool, toolRef, grantedAt } = about;
    const question = confirmQuestion({
      tool: pageTool,
      pageId: page.pageId,
      origin: page.origin,
      args,
    });
    if (confirm.mode === 'elicit') {
      return confirm.elicit === null
        ? notConfirmed(NOT_CONFIRMED_IN_CLIENT)
        : this.#askInRequest(caller, page.pageId, question, signal, confirm.elicit);
    }
    const digest = argumentsDigest(args);
    if (digest === null) {
      return hubError('invalid_arguments', 'the arguments could not be encoded for the page link');
    }
    if (confirm.mint === null) return notConfirmed(NOT_CONFIRMED_IN_CLIENT);
    const record = this.#confirmations.add({
      userId: caller.userId,
      pageId: page.pageId,
      calledAs: calledAsOf(toolRef),
      pageTool,
      digest,
      grantedAt,
      origin: page.origin,
      client: caller.client,
    });
    if (record === null) return this.#tooManyQuestions(caller);
    let requestState: string;
    try {
      requestState = await confirm.mint(record.id);
    } catch (error) {
      // A question whose state never went out leaves no record behind.
      this.#confirmations.discard(record.id);
      throw error;
    }
    // Signing is awaited, so a revoke, the attachment's end, the page's end
    // or a shutdown may have dropped the record meanwhile; the question
    // would then ask about a call nobody may confirm, so the call answers as
    // a later one would (S8).
    if (!this.#confirmations.holds(record.id)) return this.#questionWithdrawn(caller, page.pageId);
    this.#log.debug('call asked in its client', {
      pageId: page.pageId,
      userId: caller.userId,
      tool: pageTool,
    });
    return { kind: 'ask', requestState, question };
  }

  /**
   * What a call whose question lost its record before it went out answers:
   * page_asleep at shutdown, else what the access check now says
   * (not_attached, page_gone or page_asleep), else not_confirmed, since only
   * a revoke and a fresh approval in between leave the caller attached.
   */
  #questionWithdrawn(caller: CallerIdentity, pageId: string): HubError {
    if (this.#closed) return hubError('page_asleep', 'the relay is shutting down');
    const access = this.#access(caller.userId, pageId);
    return access.kind === 'error' ? access : notConfirmed(ASKED_UNDER_ENDED_ATTACHMENT);
  }

  /**
   * A 2025-era question, asked inside the request under the relay's own
   * timer and the client's signal (ADR 0026). A revoke, the attachment's end
   * or the page's end answers at once as #endAttachments or #gone says; any
   * other outcome but a confirming answer, a request its client closed
   * included, is not_confirmed.
   */
  async #askInRequest(
    caller: CallerIdentity,
    pageId: string,
    question: ConfirmQuestion,
    signal: AbortSignal,
    elicit: (question: ConfirmQuestion, signal: AbortSignal) => Promise<unknown>,
  ): Promise<HubError | { kind: 'confirmed'; at: number }> {
    const waiting = this.#confirmations.wait(caller.userId, pageId);
    if (waiting === null) return this.#tooManyQuestions(caller);
    const expiry = new AbortController();
    const timer = setTimeout(() => {
      expiry.abort();
    }, this.#config.timings.confirmationTtlMs);
    timer.unref();
    const stop = AbortSignal.any([signal, waiting.signal, expiry.signal]);
    this.#log.debug('call asked in its client', { pageId, userId: caller.userId });
    try {
      const unanswered = Symbol('unanswered');
      const answer = await new Promise<unknown>((resolve) => {
        if (stop.aborted) {
          resolve(unanswered);
          return;
        }
        stop.addEventListener(
          'abort',
          () => {
            resolve(unanswered);
          },
          { once: true },
        );
        elicit(question, stop).then(resolve, () => {
          resolve(unanswered);
        });
      });
      const dropped = waiting.dropped;
      if (dropped !== null) return hubError(dropped.code, dropped.message);
      if (answer === unanswered && expiry.signal.aborted) {
        return notConfirmed(
          `nobody answered the question in your client within ${formatDuration(this.#config.timings.confirmationTtlMs)}. The page never heard of this call`,
        );
      }
      if (!confirms(answer)) return notConfirmed(NOT_CONFIRMED_IN_CLIENT);
      return { kind: 'confirmed', at: Date.now() };
    } finally {
      clearTimeout(timer);
      waiting.done();
    }
  }

  #tooManyQuestions(caller: CallerIdentity): HubError {
    this.#log.debug("call refused: too many questions wait in the caller's clients", {
      userId: caller.userId,
    });
    return hubError(
      'rate_limited',
      `${String(MAX_PENDING_CONFIRMATIONS)} calls already wait for your answer in your clients; answer one, or let it expire after ${formatDuration(this.#config.timings.confirmationTtlMs)}, and try again`,
    );
  }

  /**
   * An observer's write on a page that takes proposals from them (ADR 0042):
   * refused at once under deny for a consequential tool, past the argument
   * caps or past the proposal limits; otherwise its arguments are checked
   * against the tool's schema, everything that let it become a proposal is
   * looked at again after that wait, and the page gets a proposal frame,
   * never an invoke. Every refusal is a call line within the refusal budget;
   * a proposal made reached its page, so its line is written in full, with
   * outcome proposed and its id (S7). The call has already spent the
   * caller's calls on this page and holds its request's charge until it
   * answers, which is now: the operator decides later, on the page.
   */
  async #propose(
    caller: CallerIdentity,
    page: PageRecord,
    attachment: AttachmentRecord,
    tool: PageTool,
    args: JsonObject,
    trace: CallTrace,
  ): Promise<CallOutcome> {
    const { pageId } = page;
    const { userId } = caller;
    if (page.policy.consequential === 'deny' && tool.consequential === true) {
      return hubError(
        'denied_by_operator',
        `this page runs no consequential tools, so it takes no proposal for ${tool.name}`,
      );
    }
    if (proposalArgumentProblem(args) !== null) {
      return hubError(
        'invalid_arguments',
        `a proposal's arguments may hold at most ${String(MAX_PROPOSAL_ARGUMENT_BYTES)} bytes and ${String(MAX_PROPOSAL_ARGUMENT_NODES)} values`,
      );
    }
    // ADR 0044: a watcher's proposal reaches the operator's tab as a call
    // would, so it spends the watchers' share of the page's calls.
    const share = this.#watchingShareRefusal(pageId, attachment, trace);
    if (share !== null) return share;
    const reservation = this.#proposals.reserve(pageId, userId, proposalCharge(args), Date.now());
    if (typeof reservation === 'string') {
      this.#log.warn('proposal refused: too many proposals', {
        pageId,
        userId,
        limit: reservation,
      });
      return hubError('rate_limited', PROPOSAL_REFUSALS[reservation]);
    }
    let made = false;
    try {
      const argumentError = await this.#checkArguments(pageId, tool.name, args);
      if (argumentError) return argumentError;
      // The check waited on the worker: the caller may have been revoked,
      // promoted or approved afresh, or the page may have changed its tools
      // or its policy, meanwhile (S5, S8).
      const access = this.#access(userId, pageId);
      if (access.kind === 'error') return access;
      const now = access.page.tools.find((candidate) => candidate.name === tool.name);
      if (now === undefined) {
        return hubError('tool_not_found', `page ${pageId} has no tool named ${tool.name}`);
      }
      const refused = this.#proposalRefusal(
        attachment.grantedAt,
        caller,
        access.page,
        access.attachment,
        now,
      );
      if (refused !== null) return refused;
      if (access.attachment.role !== 'observer' || now.annotations?.readOnlyHint === true) {
        return hubError(
          'page_busy',
          'your standing on this page or its tools changed while the proposal was checked; call again',
        );
      }
      const proposalId = newId('pr');
      const createdAt = Date.now();
      const expiresAt = this.#proposals.expiresAt(createdAt);
      const text = encodeFrame({
        t: 'proposal',
        proposalId,
        tool: tool.name,
        arguments: args,
        proposer: {
          userId,
          displayName: caller.displayName,
          client: caller.client,
          role: access.attachment.role,
        },
        expiresAt,
      });
      if (!this.#roomForProposal(access.conn, Buffer.byteLength(text, 'utf8'))) {
        this.#log.debug('proposal refused: the page has not read what it was sent', {
          pageId,
          userId,
        });
        return hubError(
          'page_busy',
          'the page has not yet taken in what it was sent, so it takes no proposal now; try again shortly',
        );
      }
      this.#proposals.commit(reservation, {
        proposalId,
        origin: access.page.origin,
        proposer: caller,
        grantedAt: attachment.grantedAt,
        tool: tool.name,
        args,
        createdAt,
      });
      made = true;
      this.#sendProposalFrame(access.conn, text);
      trace.reached = true;
      trace.proposalId = proposalId;
      this.#log.info('proposal made', { pageId, userId, proposalId, tool: tool.name });
      return { kind: 'proposed', pageId, proposalId, tool: tool.name, expiresAt };
    } finally {
      if (!made) this.#proposals.release(reservation);
    }
  }

  /**
   * Whether a proposal frame of this many bytes may go out now (ADR 0042):
   * onto an empty queue always, otherwise only while no call waits for room
   * and the queue, the frame included, stays within PROPOSAL_ROOM and below
   * MAX_UNREAD_FRAMES frames. A proposal waits for nothing, so without room
   * it is refused, and what observers propose never closes a page (ADR 0024).
   */
  #roomForProposal(conn: Conn, bytes: number): boolean {
    this.#observe(conn);
    if (conn.held.length > 0) return false;
    const queued = conn.ws.bufferedAmount;
    return (
      queued === 0 || (queued + bytes <= PROPOSAL_ROOM && conn.queue.frames < MAX_UNREAD_FRAMES)
    );
  }

  /**
   * A proposal frame, or the proposal_end that may follow it, goes out as an
   * invoke or a cancel does: never counted toward closing the page. A
   * proposal goes out only with room (#roomForProposal), and at most one
   * proposal_end follows each, so the proposal limits bound them both; the
   * relay's own small frames keep ADR 0024's count to themselves.
   */
  #sendProposalFrame(conn: Conn, text: string): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    this.#write(conn, false, (written) => {
      conn.ws.send(text, written);
    });
  }

  /**
   * The operator accepted a proposal on the page (ADR 0042): its call takes
   * its place at the end of the page's write queue now, so proposals run in
   * the order the operator accepts them (decision 20), with the whole call
   * deadline from the acceptance, every check a call passes, and an invoke
   * naming the proposal, which the adapter runs only against its own record
   * of that Accept (S5). Its call line names the proposer, marked accepted
   * on the page, and is written in full however the run ends, since the
   * operator acted (S7). What the run returns is kept for the proposer as
   * text alone (decision 15).
   */
  async #runAccepted(record: ProposalRecord): Promise<void> {
    if (!this.#proposals.accept(record)) return;
    const started = Date.now();
    const startedMono = performance.now();
    const trace: CallTrace = {
      reached: false,
      release: null,
      tool: record.tool,
      confirmedBy: null,
      callId: null,
      image: null,
      imageRefused: null,
      proposalId: record.proposalId,
      acceptedOnPage: true,
    };
    let auditOutcome: AuditOutcome = 'relay_error';
    let ran: Exclude<ProposalOutcome, 'running'> = 'relay_error';
    let result: { text: string; image: boolean } | null = null;
    try {
      const outcome = await this.#acceptedCall(record, trace);
      switch (outcome.kind) {
        case 'ok':
          ran = 'ok';
          result = { text: outcome.content, image: outcome.image !== undefined };
          break;
        case 'tool_error':
          ran = 'tool_error';
          result = { text: outcome.message, image: false };
          break;
        case 'error':
          ran = outcome.code;
          break;
        default:
          // Nothing aborts an accepted run, and it neither asks nor proposes.
          throw new Error(`an accepted proposal's run ended as ${outcome.kind}`);
      }
      auditOutcome = ran;
    } catch (error) {
      this.#log.error('an accepted proposal failed inside the relay', {
        pageId: record.pageId,
        proposalId: record.proposalId,
        error,
      });
    } finally {
      this.#proposals.settleRun(record, ran, result);
      // The page heard nothing of a run refused before its invoke, so its
      // own record of the Accept ends now rather than at its own deadline.
      const live = trace.reached ? null : this.#livePage(record.pageId);
      if (live !== null) {
        this.#sendProposalFrame(
          live.conn,
          encodeFrame({ t: 'proposal_end', proposalId: record.proposalId, reason: 'not_run' }),
        );
      }
      this.#audit(
        this.#callRecord(started, startedMono, record.pageId, record.proposer, trace, auditOutcome),
      );
    }
  }

  /** An accepted proposal's call, checked again as it starts, then queued like any write. */
  async #acceptedCall(record: ProposalRecord, trace: CallTrace): Promise<CallOutcome> {
    const { pageId, proposer, args } = record;
    const access = this.#access(proposer.userId, pageId);
    if (access.kind === 'error') return access;
    const { page, attachment } = access;
    const resolved = this.#resolveTool(page, attachment, record.tool);
    if (resolved.kind === 'error') return resolved;
    const { tool } = resolved;
    const refused = this.#proposalRefusal(record.grantedAt, proposer, page, attachment, tool);
    if (refused !== null) return refused;
    if (args === null) throw new Error('an accepted proposal kept no arguments');
    const arrivedAt = Date.now();
    const call: PendingCall = {
      callId: newId('cl'),
      pageId,
      caller: proposer,
      toolName: tool.name,
      args,
      mutating: tool.annotations?.readOnlyHint !== true,
      arrivedAt,
      rosterAtArrival: false,
      waited: false,
      checking: false,
      conn: null,
      heldOn: null,
      invokeBytes: 0,
      confirmation: null,
      proposal: { proposalId: record.proposalId, grantedAt: record.grantedAt },
      marks: null,
      trace,
      timer: null,
      done: false,
      settle: () => undefined,
    };
    const encoded = this.#encodeInvoke(
      call,
      attachment.role,
      this.#config.timings.callDeadlineMs,
      null,
    );
    if (encoded.kind === 'error') return encoded;
    call.invokeBytes = encoded.bytes;
    call.rosterAtArrival = this.#touchAttachment(attachment, arrivedAt);
    return this.#proceed(call, NEVER_ABORTED, args);
  }

  /** Goes to the page, or to its place in the page's queue, once every check has passed. */
  async #proceed(call: PendingCall, signal: AbortSignal, args: JsonObject): Promise<CallOutcome> {
    const { pageId } = call;
    if (!call.mutating) {
      // Read-only calls run side by side, so nothing is held while this one is checked.
      const argumentError = await this.#checkArguments(pageId, call.toolName, args);
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

  /**
   * The invoke frame for a call, or invalid_arguments when it cannot be sent
   * at all; `confirmation` only as the call goes out confirmed (#sendInvoke).
   */
  #encodeInvoke(
    call: PendingCall,
    role: Role,
    deadlineMs: number,
    confirmation: ClientConfirmation | null,
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
        // Field by field: the attachment it was asked under stays the relay's.
        ...(confirmation === null
          ? {}
          : {
              confirmation: {
                by: 'client',
                confirmationId: confirmation.confirmationId,
                at: confirmation.at,
              },
            }),
        // Its id alone (ADR 0042): the page runs it only against its own record of the Accept.
        ...(call.proposal === null || confirmation !== null
          ? {}
          : { proposal: { proposalId: call.proposal.proposalId } }),
      });
    } catch {
      // JSON.stringify recurses: arguments nested a few thousand levels deep overflow the stack.
      return hubError('invalid_arguments', 'the arguments could not be encoded for the page link');
    }
    // The adapter drops any frame over the cap by closing the socket, so an
    // oversized call must stop here rather than knock the page offline. The
    // room a confirmation takes is kept on every call, since one confirmed in
    // its client gains it just before it goes out (ADR 0026), so nobody is
    // asked about a call that would then be too large to send (ADR 0032); a
    // frame that carries one has used that room already.
    const bytes =
      Buffer.byteLength(text, 'utf8') + (confirmation === null ? MAX_CONFIRMATION_FRAME_BYTES : 0);
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
   * The name a call's record gives the page tool it named, before or
   * without the lookup: a first-class name becomes the page tool's own name
   * whenever exactly one of the page's tools maps to it, whether or not the
   * caller holds the page, so a call refused before the lookup
   * (not_attached, rate_limited, page_busy) leaves the record call_page_tool
   * would (S7, ADR 0025). The record is the operator's and the answer never
   * names the tool, so nothing reaches a caller who does not hold the page
   * (S13). An unknown, asleep or gone page's tools are not held (S9), and a
   * `.` mapped to `_` cannot be mapped back, so where the relay holds no one
   * tool the name maps to, the record keeps the whole first-class name as
   * called. Never the mapped part alone, which reads as another tool's name:
   * a refused `<page id>__doc_save` must not be recorded as a call to a
   * `doc_save` the page may also have when it meant `doc.save`.
   */
  #calledToolName(pageId: string, ref: PageToolRef): string {
    if (typeof ref === 'string') return ref;
    let found: string | null = null;
    for (const tool of this.#store.pages.get(pageId)?.tools ?? []) {
      if (firstClassToolPart(tool.name) !== ref.firstClass) continue;
      if (found !== null) return firstClassName(pageId, ref.firstClass);
      found = tool.name;
    }
    return found ?? firstClassName(pageId, ref.firstClass);
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
   * attachment, the page, the tool and the role, and for a confirmed call
   * that its attachment is still the one it was asked under. A read-only
   * call waits on its check in no queue a revoke empties, so a revoke and
   * a fresh approval meanwhile are caught here (ADR 0026).
   */
  #recheck(
    call: PendingCall,
  ): { kind: 'ok'; attachment: AttachmentRecord; conn: Conn; tool: PageTool } | HubError {
    const access = this.#access(call.caller.userId, call.pageId);
    if (access.kind === 'error') return access;
    const { page, attachment, conn } = access;
    if (call.confirmation !== null && attachment.grantedAt !== call.confirmation.grantedAt) {
      return notConfirmed(ASKED_UNDER_ENDED_ATTACHMENT);
    }
    const tool = page.tools.find((candidate) => candidate.name === call.toolName);
    if (!tool) {
      return hubError('tool_not_found', `page ${call.pageId} has no tool named ${call.toolName}`);
    }
    if (call.proposal !== null) {
      // ADR 0042: an observer's write runs only as a proposal the operator
      // accepted, under the attachment it was made under, while the page
      // still takes proposals from its proposer (S5, S8).
      const refused = this.#proposalRefusal(
        call.proposal.grantedAt,
        call.caller,
        page,
        attachment,
        tool,
      );
      if (refused !== null) return refused;
    } else if (attachment.role === 'observer' && tool.annotations?.readOnlyHint !== true) {
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

  /**
   * Whether a confirmed call still calls for its caller's confirmation as it
   * goes out: the page's current hello policy, its latest tools frame's mark
   * on the tool and the caller's attachment as it is now (ADR 0026).
   */
  #stillAsks(call: PendingCall, attachment: AttachmentRecord): boolean {
    const page = this.#store.pages.get(call.pageId);
    const tool = page?.tools.find((candidate) => candidate.name === call.toolName);
    return (
      page !== undefined &&
      tool !== undefined &&
      asksClient(page.policy, tool, { account: call.caller.account.kind, attachment })
    );
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
    // ADR 0026: a confirmation goes with the invoke only while what called
    // for asking still holds; otherwise the page decides as for any call,
    // and the record credits no client.
    const confirmation =
      call.confirmation !== null && this.#stillAsks(call, attachment) ? call.confirmation : null;
    if (call.confirmation !== null && confirmation === null) {
      this.#log.info('a confirmed call went out unconfirmed: what called for asking changed', {
        pageId: call.pageId,
        userId: call.caller.userId,
        tool: call.toolName,
      });
    }
    const encoded = this.#encodeInvoke(call, attachment.role, remaining, confirmation);
    if (encoded.kind === 'error') {
      call.settle(encoded);
      return false;
    }
    call.heldOn = null;
    call.conn = conn;
    call.trace.reached = true;
    // The page sees this id, so a saved session record can name the audit line (ADR 0045).
    call.trace.callId = call.callId;
    call.trace.confirmedBy = confirmation === null ? null : 'client';
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
    // A stopping relay takes no work, a detach included: a restart snapshot
    // read after this would otherwise put the attachment back (ADR 0046).
    if (this.#closed) return hubError('page_asleep', 'the relay is shutting down');
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
    // A restart voids every confirmation, failing closed (ADR 0026).
    this.#confirmations.close(shuttingDown);
    // And every wait, proposal and agent token, writing no lines (page-parts.ts).
    this.#parts.close();
    this.#clearSessionTimers();
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

  // Restart snapshot (ADR 0046)

  /**
   * The store as a restart snapshot keeps it, read once the hub has stopped
   * taking work (shutdown), when no page socket is left and no frame can
   * change it: every page session not yet gone, with its attachments, live
   * invites and live agent tokens, digests and all, and any session that
   * ended while its page slept, which the page has yet to hear of.
   * `memberKey` binds each member's attachment to who its id stands for now
   * (snapshot.ts, snapshotAccounts), and `credentials` the whole file to the
   * credentials the relay signed people in with (credentialsDigest).
   */
  exportSnapshot(
    writtenAt: number,
    memberKey: (userId: string) => string | null,
    credentials: string | null,
  ): RelaySnapshot {
    if (!this.#closed) {
      throw new Error(
        'a restart snapshot is taken only once the hub has stopped taking work (ADR 0046)',
      );
    }
    const pages = this.#store.pages.all().filter((page) => page.state !== 'gone');
    const each = <T>(list: (pageId: string) => T[]): T[] =>
      pages.flatMap((page) => list(page.pageId));
    return {
      v: SNAPSHOT_VERSION,
      writtenAt,
      mode: this.#config.mode,
      credentials,
      pages: pages.map((page) => savedPage(page, this.#sessionEnds.get(page.pageId) ?? null)),
      attachments: each((pageId) =>
        this.#store.attachments
          .listForPage(pageId)
          .map((attachment) => savedAttachment(attachment, memberKey(attachment.userId))),
      ),
      invites: each((pageId) => this.#store.invites.listForPage(pageId).map(savedInvite)),
      agents: each((pageId) => this.#store.agents.listForPage(pageId).map(savedAgent)),
    };
  }

  /**
   * Puts a restart snapshot back into a hub that holds nothing yet, before
   * the relay listens (ADR 0046). Every page returns asleep with a fresh
   * resume window, so its tab resumes as after a dropped link, counted under
   * one stand-in address until it first resumes, since a snapshot names no
   * client's; its policy is
   * worked out again from its ceiling and session. Then, as a member list
   * change would, an account the list in force no longer gives to the same
   * person loses what it held, and what it sponsored goes with it, each with
   * its records (S8, S13, S14), and those who stay take the names the list
   * gives them (ADR 0017); a session past its end ends with reason time;
   * and an attachment, invite or token past its time ends, the rest timed
   * again from their stored ends. snapshot_loaded counts what is live after
   * all that, with the attachments the member list dropped.
   */
  restoreSnapshot(
    snapshot: RelaySnapshot,
    options: { ageMs: number; accounts: SnapshotAccounts },
  ): AuditEventOf<'snapshot_loaded'> {
    if (this.#closed || this.#store.pages.all().length > 0) {
      throw new Error(
        'a restart snapshot is put back only into a new hub, before the relay listens (ADR 0046)',
      );
    }
    const now = Date.now();
    const pageIds = snapshot.pages.map((saved) => saved.pageId);
    const restored: AddressSessions = { pages: new Set(), asleep: new Set() };
    this.#sessionsByAddress.set(RESTORED_ADDRESS, restored);
    for (const saved of snapshot.pages) {
      const { pageId } = saved;
      this.#store.pages.put(restoredPage(saved, now));
      this.#pageAddress.set(pageId, RESTORED_ADDRESS);
      restored.pages.add(pageId);
      restored.asleep.add(pageId);
      this.#asleep.add(pageId);
      if (saved.sessionEnded !== null) this.#sessionEnds.set(pageId, { ...saved.sessionEnded });
      this.#setTimer(this.#lifecycleTimers, pageId, this.#config.timings.resumeWindowMs, () => {
        this.#gone(pageId);
      });
    }
    if (restored.pages.size === 0) this.#sessionsByAddress.delete(RESTORED_ADDRESS);
    for (const saved of snapshot.attachments) {
      this.#store.attachments.put(restoredAttachment(saved));
    }
    for (const saved of snapshot.invites) this.#store.invites.put(restoredInvite(saved));
    for (const saved of snapshot.agents) this.#agents.restore(restoredAgent(saved));
    const held = (): number =>
      pageIds.reduce((sum, pageId) => sum + this.#store.attachments.listForPage(pageId).length, 0);
    const before = held();
    for (const pageId of pageIds) {
      const page = this.#store.pages.get(pageId);
      const targets = snapshot.attachments
        .filter((saved) => saved.pageId === pageId && !options.accounts.stillHolds(saved))
        .map((saved) => this.#store.attachments.get(pageId, saved.userId))
        .filter((attachment) => attachment !== undefined);
      if (page === undefined || targets.length === 0) continue;
      this.#endAttachments(
        pageId,
        new Set(targets.map((attachment) => attachment.userId)),
        'revoked',
        'your membership on this relay changed while it restarted, so this attachment ended; sign in and pair again',
      );
      for (const target of targets) {
        this.#auditExpire(page, target.userId, 'membership_changed', now);
      }
      this.#log.info('restart snapshot dropped attachments the member list no longer holds', {
        pageId,
        attachments: targets.length,
      });
      // Their invites close, and what those let in ends, as when a sponsor detaches (S14).
      this.#loseSponsors(pageId, targets);
    }
    const dropped = before - held();
    // Those who stay are named as the list in force names them, as a live
    // rename would (membershipChanged): a member by the name the list gives
    // their id, and an invitee whose name now folds to a member's by its
    // short id, so nobody is shown under a member's name (ADR 0017).
    const renames = new Map<string, string>();
    for (const saved of snapshot.attachments) {
      const listed = saved.kind === 'member' ? options.accounts.nameOf(saved.userId) : undefined;
      if (listed !== undefined) renames.set(saved.userId, listed);
    }
    const memberNames = new Set(options.accounts.memberNames.map(foldName));
    let renamed = 0;
    for (const pageId of pageIds) {
      for (const attachment of this.#store.attachments.listForPage(pageId)) {
        const name = this.#renamed(attachment.userId, attachment.displayName, renames, memberNames);
        if (name === null) continue;
        attachment.displayName = name;
        this.#store.attachments.put(attachment);
        renamed += 1;
      }
    }
    if (renamed > 0) {
      this.#log.info('restart snapshot renamed attachments as the member list names them', {
        attachments: renamed,
      });
    }
    // What ran out while the relay was down ends now, as each timer would end it.
    for (const pageId of pageIds) {
      this.#endSessionIfDue(pageId);
      for (const attachment of this.#store.attachments.listForPage(pageId)) {
        this.#expireIfDue(pageId, attachment.userId);
      }
      for (const invite of this.#store.invites.listForPage(pageId)) {
        if (invite.expiresAt <= now) this.#closeInvite(invite, 'expired', false);
        else this.#armInviteExpiry(invite);
      }
      for (const agent of this.#store.agents.listForPage(pageId)) this.#agents.inTime(agent, now);
    }
    const loaded: AuditEventOf<'snapshot_loaded'> = {
      v: AUDIT_VERSION,
      type: 'snapshot_loaded',
      at: now,
      ageMs: options.ageMs,
      pages: pageIds.length,
      attachments: held(),
      invites: pageIds.reduce(
        (sum, pageId) => sum + this.#store.invites.listForPage(pageId).length,
        0,
      ),
      sessions: pageIds.filter((pageId) => this.#store.pages.get(pageId)?.timedSession != null)
        .length,
      dropped,
    };
    this.#audit(loaded);
    return loaded;
  }
}

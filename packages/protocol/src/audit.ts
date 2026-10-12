// The relay's audit records (S7, ADR 0019). The hub appends AuditEvents; the
// persistent log adds a sequence number and the previous line's digest to each
// and writes one JSON line, which `pnpm audit:log` reads back with
// AuditLineSchema. Every record type is a strict object listing exactly the
// fields it may hold, so nothing else reaches the log by accident: never
// arguments, results, tokens, codes, nonces, invite secrets or their hashes,
// resume-token hashes, cookies, the provider's `sub`, client addresses, or
// text a page wrote (titles, URLs, invite labels). From M6 also never image
// data, page state values, session labels, agent labels, agent tokens or
// their digests, or members' display names. A page is named by its id and
// the origin from its socket's Origin header (S1). An invitee's email appears
// only in its attach record, and the logger drops it from stderr. Every M6
// field and record type is additive within AUDIT_VERSION 1, so lines written
// before read as they did (ADR 0045's notes: the version moves to 2 only if
// 0.1.0 publishes first).

// First, before zod builds anything: no eval probe on Trusted Types pages.
import './zod-config.ts';
import * as z from 'zod/mini';
import {
  AUDIT_VERSION,
  MAX_IMAGE_BYTES,
  MAX_MEMBERS,
  REFUSED_SUMMARY_BUSIEST,
} from './constants.ts';
import { ERROR_CODES } from './errors.ts';
import { IMAGE_MIME_TYPES, ImageRefusalSchema } from './images.ts';
import {
  AttachViaSchema,
  ClientInfoSchema,
  EmailSchema,
  EpochMsSchema,
  IdSchema,
  ProposalPolicySchema,
  RoleSchema,
  SessionEndReasonSchema,
  SessionLengthSchema,
  ToolNameSchema,
  UserKindSchema,
} from './page-link.ts';

/**
 * How an attempt ended: 'cancelled' is a call its MCP client abandoned and
 * 'relay_error' one the relay failed on its own (a bug), recorded so no
 * attempt escapes S7. 'proposed' (ADR 0042) is an observer's call the page's
 * policy turned into a proposal: it reached the page as a proposal, never as
 * an invoke. Every error code a client sees is recorded as itself.
 */
export const AuditOutcomeSchema = z.enum([
  'ok',
  'tool_error',
  'cancelled',
  'relay_error',
  'proposed',
  ...ERROR_CODES,
]);
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;

/** What client text that is no valid id or tool name is stored as: its length, never its content. */
const InvalidTextSchema = z.string().check(z.regex(/^\(invalid, \d{1,7} chars\)$/));

function invalidText(text: string): string {
  return `(invalid, ${String(Math.min(text.length, 9_999_999))} chars)`;
}

/** A page id as a client sent it, kept only when it is one (ADR 0019). */
export function auditPageId(text: string): string {
  return IdSchema.safeParse(text).success ? text : invalidText(text);
}

/** A tool name as a client sent it, kept only when it is one (ADR 0019). */
export function auditToolName(text: string): string {
  return ToolNameSchema.safeParse(text).success ? text : invalidText(text);
}

/**
 * An OAuth client_id as a verified access token states it (RFC 9068):
 * printable ASCII, an opaque id from dynamic registration or the URL of a
 * client ID metadata document.
 */
export const OAuthClientIdSchema = z.string().check(z.regex(/^[\x21-\x7e]{1,512}$/));

/** A page's origin from its socket's Origin header, or the dev flag's stand-in. */
const OriginSchema = z.string().check(z.minLength(1), z.maxLength(2048));

/** An invitee's verified email, or this when the provider vouched for none. */
export const UNVERIFIED_EMAIL = 'unverified';

const COUNT = z.number().check(z.int(), z.nonnegative());

/** Refusals by outcome; an outcome with none is left out. */
const OutcomeCountsSchema = z.partialRecord(
  AuditOutcomeSchema,
  z.number().check(z.int(), z.positive()),
);

/**
 * The outcomes a pairing or redemption can be refused with. An invite on
 * pair_page that is malformed, minted for several uses or unknown is refused
 * alike as pairing_expired (ADR 0017's notes), so no answer says a secret is live.
 */
export const AttachRefusalSchema = z.enum([
  'denied_by_operator',
  'timeout',
  'page_busy',
  'page_asleep',
  'page_gone',
  'pairing_expired',
  'rate_limited',
  'invite_required',
]);

/**
 * Why an attachment ended without a revoke or a detach. membership_changed: a
 * members reload removed or renumbered the account (ADR 0043); session_ended:
 * a time-boxed session's end took the invite-made attachments with it.
 */
export const ExpireReasonSchema = z.enum([
  'idle',
  'ends_at',
  'page_gone',
  'sponsor_gone',
  'membership_changed',
  'session_ended',
]);

/** Why an invite stopped being live. */
export const InviteCloseReasonSchema = z.enum([
  'cancelled',
  'expired',
  'used_up',
  'burned',
  'revoked',
  'sponsor_gone',
  'page_gone',
  'session_ended',
]);

/** Why a proposal ended without being accepted (ADR 0042); an accepted one ends in its run's call line. */
export const ProposalCloseReasonSchema = z.enum([
  'dismissed',
  'refused',
  'expired',
  'withdrawn',
  'cancelled',
]);

/** Why an agent token stopped being live (ADR 0044); a deny burns it at once, and so does its third timeout. */
export const AgentCloseReasonSchema = z.enum([
  'cancelled',
  'expired',
  'revoked',
  'denied',
  'burned',
  'sponsor_gone',
  'page_gone',
  'session_ended',
]);

/** How the relay was started; its auth and address settings decide it (ADRs 0014, 0018 and 0022). */
export const RelayModeSchema = z.enum(['local', 'dev_tokens', 'public', 'hosted']);
export type RelayMode = z.infer<typeof RelayModeSchema>;

function shape<const T extends string, S extends z.core.$ZodLooseShape>(type: T, fields: S) {
  return { v: z.literal(AUDIT_VERSION), type: z.literal(type), at: EpochMsSchema, ...fields };
}

const PAGE = { pageId: IdSchema, origin: OriginSchema };

/** One call_page_tool attempt, refused or not (S7). pageId and tool are the client's own text. */
const CallShape = shape('call', {
  pageId: z.union([IdSchema, InvalidTextSchema]),
  /** null when no page by that id was known. */
  origin: z.nullable(OriginSchema),
  userId: IdSchema,
  client: z.nullable(ClientInfoSchema),
  tool: z.union([ToolNameSchema, InvalidTextSchema]),
  outcome: AuditOutcomeSchema,
  durationMs: COUNT,
  /**
   * Present exactly when the call went out confirmed in its caller's client
   * (ADR 0026), so the log never credits a client with a call the operator
   * decided. Additive within AUDIT_VERSION 1: lines without it read as before.
   */
  confirmedBy: z.optional(z.literal('client')),
  /**
   * The invoke's id, present exactly when the call's invoke went out to its
   * page (ADR 0045), so an exported session record can be matched to this
   * line; additive within AUDIT_VERSION 1.
   */
  callId: z.optional(IdSchema),
  /**
   * The image that reached the client (ADR 0039): its type, decoded size and
   * the SHA-256 of its bytes, never the image. Present only with outcome ok.
   */
  image: z.optional(
    z.strictObject({
      mimeType: z.enum(IMAGE_MIME_TYPES),
      bytes: z.number().check(z.int(), z.gte(1), z.lte(MAX_IMAGE_BYTES)),
      sha256: z.string().check(z.regex(/^[0-9a-f]{64}$/)),
    }),
  ),
  /** Why the relay refused the page's image; present only with outcome tool_error. */
  imageRefused: z.optional(ImageRefusalSchema),
  /**
   * The proposal (ADR 0042) this line made, with outcome 'proposed', or ran,
   * with acceptedOnPage; userId and client are the proposer's either way.
   */
  proposalId: z.optional(IdSchema),
  /** The run of a proposal the operator accepted on the page, whose Accept was its confirmation. */
  acceptedOnPage: z.optional(z.literal(true)),
});
function callRule(record: { outcome: string; confirmedBy?: string | undefined }): boolean {
  return record.confirmedBy === undefined || record.outcome !== 'not_confirmed';
}
const CALL_RULE = {
  message: 'a call refused for its confirmation went out unconfirmed, so no client confirmed it',
};

/** ADR 0039: an image only beside ok, a refusal only beside tool_error, never both. */
function imageRule(record: {
  outcome: string;
  image?: unknown;
  imageRefused?: string | undefined;
}): boolean {
  return (
    (record.image === undefined || record.outcome === 'ok') &&
    (record.imageRefused === undefined || record.outcome === 'tool_error') &&
    (record.image === undefined || record.imageRefused === undefined)
  );
}
const IMAGE_RULE = {
  message:
    'an image reaches a client only in an ok call, a refused one only in a tool_error, and never both',
};

/**
 * ADR 0042: a proposal leaves a line with outcome 'proposed' when it is made,
 * which sent no invoke and so has no callId or image, and, once the operator
 * accepts it, a line for its run marked acceptedOnPage, whose confirmation was
 * the Accept on the page and never a client's. Each names the proposal, and
 * no other line names one.
 */
function proposalRule(record: {
  outcome: string;
  confirmedBy?: string | undefined;
  callId?: string | undefined;
  image?: unknown;
  proposalId?: string | undefined;
  acceptedOnPage?: true | undefined;
}): boolean {
  if (record.acceptedOnPage !== undefined) {
    return (
      record.proposalId !== undefined &&
      record.confirmedBy === undefined &&
      record.outcome !== 'proposed'
    );
  }
  if (record.outcome === 'proposed') {
    return (
      record.proposalId !== undefined && record.callId === undefined && record.image === undefined
    );
  }
  return record.proposalId === undefined;
}
const PROPOSAL_RULE = {
  message:
    'a proposal is made by a line with outcome proposed and run by one accepted on the page, each naming it, and no other line names one',
};

/** An attachment made, by an approval, autoApprove or an invite. */
const AttachShape = shape('attach', {
  ...PAGE,
  userId: IdSchema,
  kind: UserKindSchema,
  role: RoleSchema,
  via: AttachViaSchema,
  /** The access token's client_id; null for a dev token, which has none. */
  clientId: z.nullable(OAuthClientIdSchema),
  inviteId: z.nullable(IdSchema),
  /** An invitee's verified email, or UNVERIFIED_EMAIL; present exactly for an invitee. */
  email: z.optional(z.union([EmailSchema, z.literal(UNVERIFIED_EMAIL)])),
});
function attachRule(record: {
  kind: string;
  via: string;
  inviteId: string | null;
  email?: string | undefined;
}): boolean {
  return (
    (record.kind === 'invitee') === (record.email !== undefined) &&
    (record.via === 'invite' || record.via === 'agent') === (record.inviteId !== null) &&
    (record.via !== 'agent' || record.kind === 'invitee')
  );
}
const ATTACH_RULE = {
  message:
    'an invitee and only an invitee has an email; an invite or agent token, and only those, names one, and an agent is an invitee',
};

/**
 * A pairing or redemption refused: by the page (denied, timed out, full),
 * or before any page was reached (a wrong code, a limit), when pageId is null.
 */
const AttachRefusedShape = shape('attach_refused', {
  pageId: z.nullable(IdSchema),
  origin: z.nullable(OriginSchema),
  userId: IdSchema,
  kind: UserKindSchema,
  via: AttachViaSchema,
  inviteId: z.nullable(IdSchema),
  outcome: AttachRefusalSchema,
});
function attachRefusedRule(record: { pageId: string | null; origin: string | null }): boolean {
  return (record.pageId === null) === (record.origin === null);
}
const PAGE_RULE = { message: 'a known page has its origin, and only a known page' };

/**
 * The fixed tools whose requests past ADR 0018's per-user request budget get
 * a request_refused record. call_page_tool past it keeps its call record and
 * pair_page its attach_refused record (outcome rate_limited), so every call
 * attempt stays a call line (S7) and every pairing an attach_refused line.
 * From M6 the waiting tools also get one for a wait refused by the wait caps
 * or by the request's byte charge (ADRs 0040 and 0042).
 */
export const RequestRefusedToolSchema = z.enum([
  'list_pages',
  'list_page_tools',
  'detach_page',
  'get_page_state',
  'wait_for_page_state',
  'get_proposal',
  'withdraw_proposal',
]);

/**
 * A request ADR 0018's per-user budget refused before its tool ran, within
 * ADR 0019's refusal budget like any refusal that reached no page. pageId is
 * the client's own text, as in a call record, and null exactly for list_pages,
 * which names no page.
 */
const RequestRefusedShape = shape('request_refused', {
  userId: IdSchema,
  kind: UserKindSchema,
  client: z.nullable(ClientInfoSchema),
  tool: RequestRefusedToolSchema,
  pageId: z.nullable(z.union([IdSchema, InvalidTextSchema])),
  outcome: z.literal('rate_limited'),
});
function requestRefusedRule(record: { tool: string; pageId: string | null }): boolean {
  return (record.tool === 'list_pages') === (record.pageId === null);
}
const REQUEST_RULE = { message: 'every tool but list_pages names its page, and list_pages none' };

/** The operator changed someone's role. */
const RoleShape = shape('role', {
  ...PAGE,
  userId: IdSchema,
  role: RoleSchema,
  previous: RoleSchema,
});

/** The operator's revoke ended an attachment; everyone is true for Revoke all. */
const RevokeShape = shape('revoke', { ...PAGE, userId: IdSchema, everyone: z.boolean() });

/** A user detached from a page themselves. */
const DetachShape = shape('detach', { ...PAGE, userId: IdSchema });

/** An attachment ended on its own: unused too long, its invite's end, its page or its sponsor gone. */
const ExpireShape = shape('expire', { ...PAGE, userId: IdSchema, reason: ExpireReasonSchema });

/** An invite minted on a page; its label is the page's own words and stays out. */
const InviteMintedShape = shape('invite_minted', {
  ...PAGE,
  inviteId: IdSchema,
  role: RoleSchema,
  uses: z.number().check(z.int(), z.positive()),
  /** As the page asked; null was "while the page is open". */
  expiresAt: z.nullable(EpochMsSchema),
  sponsor: IdSchema,
});

/** One use of an invite spent on an attachment. */
const InviteRedeemedShape = shape('invite_redeemed', {
  ...PAGE,
  inviteId: IdSchema,
  userId: IdSchema,
  kind: UserKindSchema,
  usesLeft: COUNT,
});

/** An invite stopped being live. */
const InviteClosedShape = shape('invite_closed', {
  ...PAGE,
  inviteId: IdSchema,
  reason: InviteCloseReasonSchema,
});

/** A sponsor's attachment ended, and with it their invites and the attachments those made. */
const SponsorGoneShape = shape('sponsor_gone', {
  ...PAGE,
  sponsor: IdSchema,
  invites: COUNT,
  attachments: COUNT,
});

/**
 * The relay started; with relay_stop it marks the gap a restart leaves (ADR
 * 0019). agentTokens (ADR 0044) and restartSnapshot (ADR 0046) say whether
 * those were on; lines written before M6 lack both.
 */
const RelayStartShape = shape('relay_start', {
  version: z.string().check(z.minLength(1), z.maxLength(50)),
  env: z.enum(['development', 'production']),
  mode: RelayModeSchema,
  invites: z.boolean(),
  agentTokens: z.optional(z.boolean()),
  restartSnapshot: z.optional(z.boolean()),
});

const RelayStopShape = shape('relay_stop', {});

/** Records that reached only stderr while the audit disk failed, counted once writing works again. */
const AuditGapShape = shape('audit_gap', {
  lost: z.number().check(z.int(), z.positive()),
  firstAt: EpochMsSchema,
  lastAt: EpochMsSchema,
});
function auditGapRule(record: { firstAt: number; lastAt: number }): boolean {
  return record.firstAt <= record.lastAt;
}
const GAP_RULE = { message: 'a gap ends no earlier than it starts' };

/**
 * Refusals past a budget, a minute at a time (ADR 0019): one account's own,
 * or the relay-wide pool of accounts holding no attachment, naming only the
 * REFUSED_SUMMARY_BUSIEST busiest and counting the rest together.
 */
const RefusedSummaryShape = shape('refused_summary', {
  since: EpochMsSchema,
  scope: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('user'), userId: IdSchema, counts: OutcomeCountsSchema }),
    z.strictObject({
      kind: z.literal('relay'),
      busiest: z
        .array(z.strictObject({ userId: IdSchema, counts: OutcomeCountsSchema }))
        .check(z.maxLength(REFUSED_SUMMARY_BUSIEST)),
      others: z.strictObject({ accounts: COUNT, counts: OutcomeCountsSchema }),
    }),
  ]),
});

/** A proposal that ended without being accepted (ADR 0042); never its arguments. */
const ProposalClosedShape = shape('proposal_closed', {
  ...PAGE,
  proposalId: IdSchema,
  /** The proposer. */
  userId: IdSchema,
  tool: ToolNameSchema,
  reason: ProposalCloseReasonSchema,
});

/** A time-boxed session started (ADR 0043); demoted counts the drivers its seats left out. Never its label. */
const SessionStartShape = shape('session_start', {
  ...PAGE,
  sessionId: IdSchema,
  lengthMs: SessionLengthSchema,
  maxDrivers: z.number().check(z.int(), z.gte(1), z.lte(100)),
  proposals: ProposalPolicySchema,
  demoted: COUNT,
});

/** The operator lengthened a session; lengthMs is the new total from its start. */
const SessionExtendShape = shape('session_extend', {
  ...PAGE,
  sessionId: IdSchema,
  lengthMs: SessionLengthSchema,
});

/** A session ended, with the invite-made attachments, live invites and agent tokens its end closed. */
const SessionEndShape = shape('session_end', {
  ...PAGE,
  sessionId: IdSchema,
  reason: SessionEndReasonSchema,
  attachments: COUNT,
  invites: COUNT,
  agents: COUNT,
});

/**
 * The relay read a changed members list (ADR 0043): how many members it now
 * has, the user ids added and removed, how many were renamed and the
 * attachments the change ended. Never a sub or a display name.
 */
const MembersReloadedShape = shape('members_reloaded', {
  members: COUNT,
  added: z.array(IdSchema).check(z.maxLength(MAX_MEMBERS)),
  removed: z.array(IdSchema).check(z.maxLength(MAX_MEMBERS)),
  renamed: COUNT,
  attachments: COUNT,
});

/**
 * A restart snapshot written at a graceful stop (ADR 0046), with the SHA-256
 * of the file, so a start loads only the snapshot this log says was written.
 */
const SnapshotWrittenShape = shape('snapshot_written', {
  pages: COUNT,
  attachments: COUNT,
  invites: COUNT,
  sessions: COUNT,
  sha256: z.string().check(z.regex(/^[0-9a-f]{64}$/)),
});

/** A restart snapshot loaded at start: its age, what it restored and the attachments it dropped. */
const SnapshotLoadedShape = shape('snapshot_loaded', {
  ageMs: COUNT,
  pages: COUNT,
  attachments: COUNT,
  invites: COUNT,
  sessions: COUNT,
  dropped: COUNT,
});

/** An agent token minted on a page (ADR 0044); never the token, its digest or its label. */
const AgentMintedShape = shape('agent_minted', {
  ...PAGE,
  tokenId: IdSchema,
  expiresAt: EpochMsSchema,
  sponsor: IdSchema,
});

/** An agent token stopped being live; written once per token. */
const AgentClosedShape = shape('agent_closed', {
  ...PAGE,
  tokenId: IdSchema,
  reason: AgentCloseReasonSchema,
});

/** What the persistent log adds to each record: its place in the log and the previous line's digest. */
const LINE = {
  seq: COUNT,
  /** SHA-256 of the previous line as written, hex; null only on the first line a log ever holds. */
  prev: z.nullable(z.string().check(z.regex(/^[0-9a-f]{64}$/))),
};

/** What the hub appends (AuditLog.append). */
export const AuditEventSchema = z.discriminatedUnion('type', [
  z
    .strictObject(CallShape)
    .check(
      z.refine(callRule, CALL_RULE),
      z.refine(imageRule, IMAGE_RULE),
      z.refine(proposalRule, PROPOSAL_RULE),
    ),
  z.strictObject(AttachShape).check(z.refine(attachRule, ATTACH_RULE)),
  z.strictObject(AttachRefusedShape).check(z.refine(attachRefusedRule, PAGE_RULE)),
  z.strictObject(RoleShape),
  z.strictObject(RevokeShape),
  z.strictObject(DetachShape),
  z.strictObject(ExpireShape),
  z.strictObject(InviteMintedShape),
  z.strictObject(InviteRedeemedShape),
  z.strictObject(InviteClosedShape),
  z.strictObject(SponsorGoneShape),
  z.strictObject(RelayStartShape),
  z.strictObject(RelayStopShape),
  z.strictObject(AuditGapShape).check(z.refine(auditGapRule, GAP_RULE)),
  z.strictObject(RefusedSummaryShape),
  z.strictObject(RequestRefusedShape).check(z.refine(requestRefusedRule, REQUEST_RULE)),
  z.strictObject(ProposalClosedShape),
  z.strictObject(SessionStartShape),
  z.strictObject(SessionExtendShape),
  z.strictObject(SessionEndShape),
  z.strictObject(MembersReloadedShape),
  z.strictObject(SnapshotWrittenShape),
  z.strictObject(SnapshotLoadedShape),
  z.strictObject(AgentMintedShape),
  z.strictObject(AgentClosedShape),
]);
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type AuditEventType = AuditEvent['type'];
export type AuditEventOf<T extends AuditEventType> = Extract<AuditEvent, { type: T }>;
export type AuditCallEvent = AuditEventOf<'call'>;

/** One line of the persistent log: an event with its sequence number and chain link. */
export const AuditLineSchema = z.discriminatedUnion('type', [
  z
    .strictObject({ ...CallShape, ...LINE })
    .check(
      z.refine(callRule, CALL_RULE),
      z.refine(imageRule, IMAGE_RULE),
      z.refine(proposalRule, PROPOSAL_RULE),
    ),
  z.strictObject({ ...AttachShape, ...LINE }).check(z.refine(attachRule, ATTACH_RULE)),
  z.strictObject({ ...AttachRefusedShape, ...LINE }).check(z.refine(attachRefusedRule, PAGE_RULE)),
  z.strictObject({ ...RoleShape, ...LINE }),
  z.strictObject({ ...RevokeShape, ...LINE }),
  z.strictObject({ ...DetachShape, ...LINE }),
  z.strictObject({ ...ExpireShape, ...LINE }),
  z.strictObject({ ...InviteMintedShape, ...LINE }),
  z.strictObject({ ...InviteRedeemedShape, ...LINE }),
  z.strictObject({ ...InviteClosedShape, ...LINE }),
  z.strictObject({ ...SponsorGoneShape, ...LINE }),
  z.strictObject({ ...RelayStartShape, ...LINE }),
  z.strictObject({ ...RelayStopShape, ...LINE }),
  z.strictObject({ ...AuditGapShape, ...LINE }).check(z.refine(auditGapRule, GAP_RULE)),
  z.strictObject({ ...RefusedSummaryShape, ...LINE }),
  z
    .strictObject({ ...RequestRefusedShape, ...LINE })
    .check(z.refine(requestRefusedRule, REQUEST_RULE)),
  z.strictObject({ ...ProposalClosedShape, ...LINE }),
  z.strictObject({ ...SessionStartShape, ...LINE }),
  z.strictObject({ ...SessionExtendShape, ...LINE }),
  z.strictObject({ ...SessionEndShape, ...LINE }),
  z.strictObject({ ...MembersReloadedShape, ...LINE }),
  z.strictObject({ ...SnapshotWrittenShape, ...LINE }),
  z.strictObject({ ...SnapshotLoadedShape, ...LINE }),
  z.strictObject({ ...AgentMintedShape, ...LINE }),
  z.strictObject({ ...AgentClosedShape, ...LINE }),
]);
export type AuditLine = z.infer<typeof AuditLineSchema>;

/**
 * Every record type, in ADR 0019's order, then request_refused from its notes,
 * then M6's in plan order, for readers that filter by type.
 */
export const AUDIT_EVENT_TYPES = [
  'call',
  'attach',
  'attach_refused',
  'role',
  'revoke',
  'detach',
  'expire',
  'invite_minted',
  'invite_redeemed',
  'invite_closed',
  'sponsor_gone',
  'relay_start',
  'relay_stop',
  'audit_gap',
  'refused_summary',
  'request_refused',
  'proposal_closed',
  'session_start',
  'session_extend',
  'session_end',
  'members_reloaded',
  'snapshot_written',
  'snapshot_loaded',
  'agent_minted',
  'agent_closed',
] as const satisfies readonly AuditEventType[];

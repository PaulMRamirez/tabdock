// The relay's audit records (S7, ADR 0019). The hub appends AuditEvents; the
// persistent log adds a sequence number and the previous line's digest to each
// and writes one JSON line, which `pnpm audit:log` reads back with
// AuditLineSchema. Every record type is a strict object listing exactly the
// fields it may hold, so nothing else reaches the log by accident: never
// arguments, results, tokens, codes, nonces, invite secrets or their hashes,
// resume-token hashes, cookies, the provider's `sub`, client addresses, or
// text a page wrote (titles, URLs, invite labels). A page is named by its id
// and the origin from its socket's Origin header (S1). An invitee's email
// appears only in its attach record, and the logger drops it from stderr.

// First, before zod builds anything: no eval probe on Trusted Types pages.
import './zod-config.ts';
import * as z from 'zod/mini';
import { AUDIT_VERSION, REFUSED_SUMMARY_BUSIEST } from './constants.ts';
import { ERROR_CODES } from './errors.ts';
import {
  AttachViaSchema,
  ClientInfoSchema,
  EmailSchema,
  EpochMsSchema,
  IdSchema,
  RoleSchema,
  ToolNameSchema,
  UserKindSchema,
} from './page-link.ts';

/**
 * How an attempt ended: 'cancelled' is a call its MCP client abandoned and
 * 'relay_error' one the relay failed on its own (a bug), recorded so no
 * attempt escapes S7. Every error code a client sees is recorded as itself.
 */
export const AuditOutcomeSchema = z.enum([
  'ok',
  'tool_error',
  'cancelled',
  'relay_error',
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

/** Why an attachment ended without a revoke or a detach. */
export const ExpireReasonSchema = z.enum(['idle', 'ends_at', 'page_gone', 'sponsor_gone']);

/** Why an invite stopped being live. */
export const InviteCloseReasonSchema = z.enum([
  'cancelled',
  'expired',
  'used_up',
  'burned',
  'revoked',
  'sponsor_gone',
  'page_gone',
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
});
function callRule(record: { outcome: string; confirmedBy?: string | undefined }): boolean {
  return record.confirmedBy === undefined || record.outcome !== 'not_confirmed';
}
const CALL_RULE = {
  message: 'a call refused for its confirmation went out unconfirmed, so no client confirmed it',
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
    (record.via === 'invite') === (record.inviteId !== null)
  );
}
const ATTACH_RULE = {
  message: 'an invitee and only an invitee has an email; an invite and only an invite names one',
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
 */
export const RequestRefusedToolSchema = z.enum(['list_pages', 'list_page_tools', 'detach_page']);

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

/** The relay started; with relay_stop it marks the gap a restart leaves (ADR 0019). */
const RelayStartShape = shape('relay_start', {
  version: z.string().check(z.minLength(1), z.maxLength(50)),
  env: z.enum(['development', 'production']),
  mode: RelayModeSchema,
  invites: z.boolean(),
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

/** What the persistent log adds to each record: its place in the log and the previous line's digest. */
const LINE = {
  seq: COUNT,
  /** SHA-256 of the previous line as written, hex; null only on the first line a log ever holds. */
  prev: z.nullable(z.string().check(z.regex(/^[0-9a-f]{64}$/))),
};

/** What the hub appends (AuditLog.append). */
export const AuditEventSchema = z.discriminatedUnion('type', [
  z.strictObject(CallShape).check(z.refine(callRule, CALL_RULE)),
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
]);
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type AuditEventType = AuditEvent['type'];
export type AuditEventOf<T extends AuditEventType> = Extract<AuditEvent, { type: T }>;
export type AuditCallEvent = AuditEventOf<'call'>;

/** One line of the persistent log: an event with its sequence number and chain link. */
export const AuditLineSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...CallShape, ...LINE }).check(z.refine(callRule, CALL_RULE)),
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
]);
export type AuditLine = z.infer<typeof AuditLineSchema>;

/** Every record type, in ADR 0019's order and then request_refused from its notes, for readers that filter by type. */
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
] as const satisfies readonly AuditEventType[];

// The session record (ADR 0045): what the adapter keeps, in memory only, of
// the current page session or of a time-boxed session (ADR 0043), and what
// the widget saves as a JSON file when the operator asks. It holds every
// attachment span, every call that reached the page and every proposal,
// never arguments, results, images, page state or anything a frame carried
// beyond the names the widget already showed. Every object here is strict,
// so a later change cannot slip an argument, a result or any other field into
// the file unnoticed: the adapter parses its own export with this schema
// before saving it, and the audit reader's --match parses the file with it
// before comparing it to the hash-chained log.

// First, before zod builds anything: no eval probe on Trusted Types pages.
import './zod-config.ts';
import * as z from 'zod/mini';
import {
  MAX_DISPLAY_NAME_CHARS,
  MAX_LIVE_INVITES_PER_PAGE,
  MAX_OBSERVERS_PER_PAGE,
  SESSION_RECORD_MAX_ATTACHMENTS,
  SESSION_RECORD_MAX_BYTES,
  SESSION_RECORD_MAX_CALLS,
  SESSION_RECORD_MAX_DROPPED_USERS,
  SESSION_RECORD_MAX_PAGE_IDS,
  SESSION_RECORD_MAX_PROPOSALS,
  SESSION_RECORD_MAX_ROLE_CHANGES,
  SESSION_RECORD_VERSION,
} from './constants.ts';
import {
  EpochMsSchema,
  IdSchema,
  InviteLabelSchema,
  PAGE_ERROR_CODES,
  PolicySchema,
  ProposalPolicySchema,
  RoleSchema,
  ToolNameSchema,
  UserKindSchema,
} from './page-link.ts';

const COUNT = z.number().check(z.int(), z.nonnegative());

/**
 * An invitee as the widget names one: `g_` and the 8 hex characters of its
 * short id, with `~2`, `~3` and so on should two in one record share it. The
 * full account key never enters a record: it is an unkeyed digest of the
 * provider's subject, so it would tie the file to that account anywhere.
 */
const INVITEE_SHORT_ID = /^g_[0-9a-f]{8}(?:~[1-9]\d{0,2})?$/;
const PersonIdSchema = z.union([IdSchema, z.string().check(z.regex(INVITEE_SHORT_ID))]);

/** A person as the widget shows them: a member by user id, an invitee by short id, and their name. */
export const RecordPersonSchema = z
  .strictObject({
    id: PersonIdSchema,
    name: z.string().check(z.minLength(1), z.maxLength(MAX_DISPLAY_NAME_CHARS)),
    kind: UserKindSchema,
  })
  .check(
    z.refine(
      (person) =>
        person.kind === 'invitee' ? INVITEE_SHORT_ID.test(person.id) : !person.id.startsWith('g_'),
      { message: "an invitee is named by its short id, and only an invitee's id starts g_" },
    ),
  );
export type RecordPerson = z.infer<typeof RecordPersonSchema>;

/** How a call ended on the page, or running while the record was taken. */
export const RecordOutcomeSchema = z.enum(['running', 'ok', ...PAGE_ERROR_CODES]);
export type RecordOutcome = z.infer<typeof RecordOutcomeSchema>;

/**
 * One call the adapter accepted, by the invoke's callId, which the audit's
 * call line carries too (ADR 0045). confirmedBy says where a prompt was
 * answered: on the page (an Allow, or an accepted proposal), in the caller's
 * client (ADR 0026), or nowhere. Never its arguments or result.
 */
export const RecordCallSchema = z
  .strictObject({
    callId: IdSchema,
    pageId: IdSchema,
    at: EpochMsSchema,
    user: RecordPersonSchema,
    /** The client's name and version as one plain line, as the widget shows them. */
    client: z.nullable(z.string().check(z.maxLength(151))),
    tool: ToolNameSchema,
    outcome: RecordOutcomeSchema,
    durationMs: z.nullable(COUNT),
    confirmedBy: z.nullable(z.enum(['page', 'client'])),
    proposalId: z.nullable(IdSchema),
  })
  .check(
    z.refine((call) => (call.durationMs === null) === (call.outcome === 'running'), {
      message: 'a call has its duration once it ends, and not before',
    }),
  );
export type RecordCall = z.infer<typeof RecordCallSchema>;

/** A role an attachment held from `at`; null while the relay listed the user but nothing ran here. */
export const RecordRoleSchema = z.strictObject({
  at: EpochMsSchema,
  role: z.nullable(RoleSchema),
});

/** One attachment span: who, how they came in, when they joined and left, and their roles. */
export const RecordAttachmentSchema = z
  .strictObject({
    user: RecordPersonSchema,
    pageId: IdSchema,
    how: z.enum(['approved', 'invite', 'auto', 'unapproved']),
    inviteId: z.nullable(IdSchema),
    /** Attached before the record began. */
    before: z.boolean(),
    joinedAt: EpochMsSchema,
    leftAt: z.nullable(EpochMsSchema),
    ended: z.nullable(z.enum(['revoked', 'left', 'page_session_ended', 'session_ended'])),
    roles: z
      .array(RecordRoleSchema)
      .check(z.minLength(1), z.maxLength(SESSION_RECORD_MAX_ROLE_CHANGES)),
    rolesDropped: COUNT,
  })
  .check(
    z.refine((span) => (span.leftAt === null) === (span.ended === null), {
      message: 'a span that ended has its end and how, and an open one neither',
    }),
    z.refine((span) => (span.how === 'invite') === (span.inviteId !== null), {
      message: 'an invite names its invite, and no other way in does',
    }),
  );
export type RecordAttachment = z.infer<typeof RecordAttachmentSchema>;

/** One proposal (ADR 0042), never its arguments; callId links an accepted one to its run. */
export const RecordProposalSchema = z
  .strictObject({
    proposalId: IdSchema,
    pageId: IdSchema,
    at: EpochMsSchema,
    user: RecordPersonSchema,
    tool: ToolNameSchema,
    status: z.enum(['pending', 'accepted', 'dismissed', 'expired', 'withdrawn']),
    decidedAt: z.nullable(EpochMsSchema),
    callId: z.nullable(IdSchema),
  })
  .check(
    z.refine((proposal) => (proposal.decidedAt === null) === (proposal.status === 'pending'), {
      message: 'a proposal is decided exactly when it is no longer pending',
    }),
    z.refine((proposal) => proposal.callId === null || proposal.status === 'accepted', {
      message: 'only an accepted proposal names the call that ran it',
    }),
  );
export type RecordProposal = z.infer<typeof RecordProposalSchema>;

/**
 * What the record covers: the page session, or a time-boxed session that may
 * span several (a deploy in a lesson keeps one record), with its label, times
 * and settings as ADR 0043 names them. endedBy is the adapter's reason: the
 * relay's three, or 'relay' when the relay started a new page session.
 */
const SessionScopeSchema = z.strictObject({
  kind: z.literal('session'),
  sessionId: IdSchema,
  label: InviteLabelSchema,
  startedAt: EpochMsSchema,
  endsAt: EpochMsSchema,
  endedAt: z.nullable(EpochMsSchema),
  endedBy: z.nullable(z.enum(['operator', 'time', 'page_gone', 'relay'])),
  maxDrivers: z.number().check(z.int(), z.gte(0), z.lte(100)),
  proposals: ProposalPolicySchema,
  observers: z.number().check(z.int(), z.gte(0), z.lte(MAX_OBSERVERS_PER_PAGE)),
  invites: z.number().check(z.int(), z.gte(0), z.lte(MAX_LIVE_INVITES_PER_PAGE)),
});
export const RecordScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('page') }),
  SessionScopeSchema,
]);
export type RecordScope = z.infer<typeof RecordScopeSchema>;

/**
 * What the caps pushed out, so a capped record is never read as a whole one:
 * counts, the first and last dropped times, and dropped calls by user and
 * outcome for at most SESSION_RECORD_MAX_DROPPED_USERS users, the rest counted
 * together.
 */
export const RecordDroppedSchema = z.strictObject({
  calls: COUNT,
  attachments: COUNT,
  proposals: COUNT,
  firstAt: z.nullable(EpochMsSchema),
  lastAt: z.nullable(EpochMsSchema),
  byUser: z
    .array(
      z.strictObject({
        user: PersonIdSchema,
        counts: z.partialRecord(RecordOutcomeSchema, z.number().check(z.int(), z.positive())),
      }),
    )
    .check(z.maxLength(SESSION_RECORD_MAX_DROPPED_USERS)),
  otherCalls: COUNT,
});

/** A saved session record: its format and version, the page it describes, its scope and its entries. */
export const SessionRecordSchema = z
  .strictObject({
    format: z.literal('tabdock.session-record'),
    v: z.literal(SESSION_RECORD_VERSION),
    adapterVersion: z.string().check(z.maxLength(50)),
    exportedAt: EpochMsSchema,
    /** The page's origin and path as hello sent them, and its title at export. */
    page: z.strictObject({
      origin: z.string().check(z.maxLength(2048)),
      path: z.string().check(z.maxLength(2048)),
      title: z.string().check(z.maxLength(300)),
    }),
    /** The relay's host only. */
    relay: z.string().check(z.maxLength(300)),
    policy: PolicySchema,
    pageIds: z.array(IdSchema).check(z.minLength(1), z.maxLength(SESSION_RECORD_MAX_PAGE_IDS)),
    scope: RecordScopeSchema,
    from: EpochMsSchema,
    to: EpochMsSchema,
    sealed: z.boolean(),
    attachments: z.array(RecordAttachmentSchema).check(z.maxLength(SESSION_RECORD_MAX_ATTACHMENTS)),
    calls: z.array(RecordCallSchema).check(z.maxLength(SESSION_RECORD_MAX_CALLS)),
    proposals: z.array(RecordProposalSchema).check(z.maxLength(SESSION_RECORD_MAX_PROPOSALS)),
    dropped: RecordDroppedSchema,
  })
  .check(
    z.refine((record) => record.from <= record.to, {
      message: 'a record ends no earlier than it starts',
    }),
    z.refine(
      (record) =>
        [...record.attachments, ...record.calls, ...record.proposals].every((entry) =>
          record.pageIds.includes(entry.pageId),
        ),
      { message: "every entry's page is one of the record's pages" },
    ),
  );
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

/** JSON.parse and JSON.stringify as they were when this module loaded, for page-link.ts's reasons. */
const parseJson = JSON.parse;
const stringifyJson = JSON.stringify;

/**
 * Field names the record's schemas know, and outcome names a count may be
 * keyed by. A path segment outside them is a key the file wrote, so a reason
 * never repeats it.
 */
const KNOWN_SEGMENTS: ReadonlySet<string> = new Set([
  ...Object.keys(SessionRecordSchema.shape),
  ...Object.keys(SessionRecordSchema.shape.page.shape),
  ...Object.keys(PolicySchema.shape),
  ...Object.keys(RecordCallSchema.shape),
  ...Object.keys(RecordPersonSchema.shape),
  ...Object.keys(RecordAttachmentSchema.shape),
  ...Object.keys(RecordRoleSchema.shape),
  ...Object.keys(RecordProposalSchema.shape),
  ...Object.keys(SessionScopeSchema.shape),
  ...Object.keys(RecordDroppedSchema.shape),
  'user',
  'counts',
  ...RecordOutcomeSchema.options,
]);

function issueText(issue: z.core.$ZodIssue): string {
  const path = issue.path
    .map((segment) =>
      typeof segment === 'number' || KNOWN_SEGMENTS.has(String(segment)) ? String(segment) : '?',
    )
    .join('.');
  const message =
    issue.code === 'unrecognized_keys'
      ? 'holds fields a session record does not take'
      : issue.message;
  return `${path === '' ? '(root)' : path}: ${message}`;
}

/**
 * Reads a saved record, or says why it is none in issue paths and fixed
 * words only: the file names people and may have been edited, so no value or
 * key from it is repeated.
 */
export function parseSessionRecord(
  text: string,
): { ok: true; record: SessionRecord } | { ok: false; reason: string } {
  // UTF-16 units never outnumber UTF-8 bytes, so a text this long is too large either way.
  if (text.length > SESSION_RECORD_MAX_BYTES) {
    return { ok: false, reason: `larger than ${String(SESSION_RECORD_MAX_BYTES)} bytes` };
  }
  let value: unknown;
  try {
    value = parseJson(text);
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  const parsed = SessionRecordSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.slice(0, 3).map(issueText).join('; ') };
  }
  return { ok: true, record: parsed.data };
}

/** A record as the file the widget saves: JSON with a two-space indent. */
export function encodeSessionRecord(record: SessionRecord): string {
  return stringifyJson(record, null, 2);
}

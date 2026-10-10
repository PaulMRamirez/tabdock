// The page link (SPEC.md section 6): JSON text frames shaped { t: "<type>", ... }
// over a WebSocket with subprotocol tabdock.v1. Both sides parse every frame with
// these schemas; the TypeScript types are inferred from them, so the wire format
// is defined exactly once.

// First, before zod builds anything: no eval probe on Trusted Types pages.
import './zod-config.ts';
import * as z from 'zod/mini';
import {
  AGENT_BURN_TIMEOUTS,
  AGENT_KEY_DOMAIN,
  AGENT_PATH,
  CONTROL_INVITE_USES,
  INVITE_BURN_REFUSALS,
  INVITE_PATH,
  INVITE_SECRET_CHARS,
  INVITEE_ID_PREFIX,
  INVITEE_KEY_HEX_CHARS,
  MAX_DISPLAY_NAME_CHARS,
  MAX_EMAIL_CHARS,
  MAX_INVITE_LABEL_CHARS,
  MAX_INVITE_USES,
  MAX_LIVE_AGENTS_PER_PAGE,
  MAX_LIVE_INVITES_PER_PAGE,
  MAX_PROPOSAL_ARGUMENT_BYTES,
  MAX_PROPOSAL_ARGUMENT_NODES,
  MAX_SESSION_MS,
  MAX_TOOLS_PER_PAGE,
  MIN_SESSION_MS,
  PROTOCOL_VERSION,
  SESSION_LENGTH_UNIT_MS,
} from './constants.ts';
import { WireImageSchema } from './images.ts';

// Building blocks

/** Opaque identifiers minted by the relay (page, request, call, user ids). */
export const IdSchema = z.string().check(z.regex(/^[A-Za-z0-9_-]{1,64}$/));

/** Milliseconds since the Unix epoch. */
export const EpochMsSchema = z.number().check(z.int(), z.nonnegative());

export const RoleSchema = z.enum(['observer', 'driver']);
export type Role = z.infer<typeof RoleSchema>;

/** WebMCP's tool name rule: 1 to 128 characters of letters, digits, '_', '-' or '.'. */
export const ToolNameSchema = z.string().check(z.regex(/^[A-Za-z0-9_.-]{1,128}$/));

/** Unknown hint keys are dropped rather than rejected; runtimes add hints over time. */
export const ToolAnnotationsSchema = z.object({
  readOnlyHint: z.optional(z.boolean()),
  consequentialHint: z.optional(z.boolean()),
  untrustedContentHint: z.optional(z.boolean()),
  debugging: z.optional(z.boolean()),
});
export type ToolAnnotations = z.infer<typeof ToolAnnotationsSchema>;

export const JsonObjectSchema = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObjectSchema>;

/**
 * One tool as the adapter reports it. The wire allows long descriptions; the
 * relay cuts them to MAX_DESCRIPTION_CHARS before any client sees them (S10).
 * inputSchema is always an object here: the adapter parses the JSON string that
 * Chrome 153 and 154 return (ADR 0001).
 *
 * consequential (M5, ADR 0026) is true on each tool the adapter classes
 * consequential by ADR 0002's rule, whose inputs only it has. The relay reads
 * it only to decide whether a page that opted in may have a member driver
 * confirm in their own client, and shows it to no client. Absent or false
 * means not marked, which leaves the call to the page prompt, so a tool an
 * older adapter lists, or one wrongly unmarked, fails safe.
 */
export const PageToolSchema = z.object({
  name: ToolNameSchema,
  title: z.optional(z.string().check(z.maxLength(200))),
  description: z.string().check(z.maxLength(10_000)),
  inputSchema: JsonObjectSchema,
  annotations: z.optional(ToolAnnotationsSchema),
  consequential: z.optional(z.boolean()),
});
export type PageTool = z.infer<typeof PageToolSchema>;

/**
 * How far a page lets its operator share it by invite (ADR 0016): not at all,
 * Can watch invites only (the default, so control invites need a page that
 * opts in), or Can control invites too.
 */
export const InvitePolicySchema = z.enum(['off', 'watch', 'all']);
export type InvitePolicy = z.infer<typeof InvitePolicySchema>;

/**
 * Who confirms a consequential call under consequential 'confirm' (ADR 0026):
 * the operator through the on-page prompt, or, on a page that chose 'client',
 * a member driver on an attachment no invite made, in their own MCP client
 * where it declares form elicitation. Everyone else still gets the page prompt.
 */
export const ConfirmViaSchema = z.enum(['page', 'client']);
export type ConfirmVia = z.infer<typeof ConfirmViaSchema>;

/**
 * Whose calls to tools not marked read-only become proposals the operator
 * accepts or dismisses on the page (ADR 0042): nobody's, members' (by account
 * kind, an invite-made member's included), or everyone's.
 */
export const ProposalPolicySchema = z.enum(['off', 'members', 'all']);
export type ProposalPolicy = z.infer<typeof ProposalPolicySchema>;

/**
 * Page policy, sent in hello. consequentialTools is ADR 0002's option C
 * (accepted): tools the page declares consequential even when the runtime drops
 * consequentialHint. confirmVia (M5) defaults to 'page', so a hello from an
 * adapter that never heard of it means what it always meant, and a relay
 * older than M5 drops it and never asks a client. imageTools (ADR 0039) names
 * the tools whose results may carry an image, and proposals (ADR 0042) is off
 * unless the page opts in; both default so that an older adapter's hello
 * means what it meant, and an older relay drops both and takes neither.
 */
export const PolicySchema = z.object({
  autoApprove: z._default(z.enum(['none', 'observer']), 'none'),
  maxDrivers: z._default(z.number().check(z.int(), z.gte(1), z.lte(100)), 1),
  consequential: z._default(z.enum(['confirm', 'allow', 'deny']), 'confirm'),
  consequentialTools: z._default(
    z.array(ToolNameSchema).check(z.maxLength(MAX_TOOLS_PER_PAGE)),
    [],
  ),
  invites: z._default(InvitePolicySchema, 'watch'),
  confirmVia: z._default(ConfirmViaSchema, 'page'),
  imageTools: z._default(z.array(ToolNameSchema).check(z.maxLength(MAX_TOOLS_PER_PAGE)), []),
  proposals: z._default(ProposalPolicySchema, 'off'),
});
export type Policy = z.infer<typeof PolicySchema>;
export type PolicyInput = z.input<typeof PolicySchema>;

/**
 * Whether a page's proposal policy takes proposals from this caller. An agent
 * token's caller never proposes, whatever the policy (ADR 0044, conflict
 * C13): it is an invitee by kind and id, so 'all' would admit it, and the
 * relay's #propose and the adapter's onProposal each ask here, so neither
 * layer can forget the rule the other keeps.
 */
export function proposalsAdmit(
  policy: ProposalPolicy,
  proposer: { readonly kind: UserKind; readonly agent: boolean },
): boolean {
  if (proposer.agent) return false;
  return policy === 'all' || (policy === 'members' && proposer.kind === 'member');
}

// Time-boxed sessions (ADR 0043)

/** A time-boxed session's length from its start: whole minutes from 30 to 240. */
export const SessionLengthSchema = z.number().check(
  z.int(),
  z.gte(MIN_SESSION_MS),
  z.lte(MAX_SESSION_MS),
  z.refine((ms) => ms % SESSION_LENGTH_UNIT_MS === 0, { message: 'a length is whole minutes' }),
);

/**
 * The two policy fields a session may set, each no wider than the page's
 * attach() ceiling (sessions.ts). Strict, so a page cannot slip any other
 * field past the ceiling through a session.
 */
export const SessionPolicySchema = z.strictObject({
  maxDrivers: z.number().check(z.int(), z.gte(1), z.lte(100)),
  proposals: ProposalPolicySchema,
});
export type SessionPolicy = z.infer<typeof SessionPolicySchema>;

export const UserSchema = z.object({
  userId: IdSchema,
  displayName: z.string().check(z.minLength(1), z.maxLength(MAX_DISPLAY_NAME_CHARS)),
});
export type User = z.infer<typeof UserSchema>;

// Accounts (ADRs 0016, 0017 and 0020)

/**
 * Who an account is to the relay: a member is on the owner's allowlist; an
 * invitee signed in at the provider without being on it and can reach a page
 * only through an invite minted there.
 */
export const UserKindSchema = z.enum(['member', 'invitee']);
export type UserKind = z.infer<typeof UserKindSchema>;

/** An invitee's user id: the prefix and its account key, a digest of the provider's subject, never the subject. */
export const InviteeIdSchema = z
  .string()
  .check(z.regex(new RegExp(`^${INVITEE_ID_PREFIX}[0-9a-f]{${String(INVITEE_KEY_HEX_CHARS)}}$`)));

/**
 * An email address as an identity provider vouches for it: one '@', no
 * space or control character, at most MAX_EMAIL_CHARS. Loose on purpose,
 * since the provider has already checked the address; this only keeps
 * anything that is not one from being shown or stored as one. Nothing that
 * shows as nothing passes either: an invitee's name is its email, which the
 * widget, /i and the audit show beside a member's, so a right-to-left
 * override (U+202E) could turn the shown address around, and a zero-width
 * character could make two addresses read alike. Format characters (the
 * bidirectional controls among them), surrogate halves and every other
 * default-ignorable code point are refused, as plainLine drops them.
 */
export const EmailSchema = z
  .string()
  .check(
    z.maxLength(MAX_EMAIL_CHARS),
    z.regex(
      /^[^\s@\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]+@[^\s@\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]+$/u,
    ),
  );

/**
 * What an attach request says about the account behind it (ADR 0017). An
 * invitee is verified when its name is an email the provider vouches for, and
 * shows as UNVERIFIED_ACCOUNT_NAME otherwise; a member's name comes from the
 * owner's own settings, so a member is always verified.
 */
export const AccountSchema = z.object({ kind: UserKindSchema, verified: z.boolean() }).check(
  z.refine((account) => account.kind === 'invitee' || account.verified, {
    message: 'a member is always verified',
  }),
);
export type Account = z.infer<typeof AccountSchema>;

// Invites (ADR 0017)

/** An invite secret: 128 bits from getRandomValues as 22 base64url characters. */
export const InviteSecretSchema = z
  .string()
  .check(z.regex(new RegExp(`^[A-Za-z0-9_-]{${String(INVITE_SECRET_CHARS)}}$`)));

/**
 * SHA-256 of the secret's UTF-8 text, as 64 lower-case hex characters: what
 * the adapter sends and the relay keeps instead of the secret.
 */
export const InviteSecretHashSchema = z.string().check(z.regex(/^[0-9a-f]{64}$/));

/** The operator's label for an invite: page-written text, capped and shown as written (S10). */
export const InviteLabelSchema = z
  .string()
  .check(z.minLength(1), z.maxLength(MAX_INVITE_LABEL_CHARS));

/**
 * Why the relay refused to mint an invite. expired: its expiresAt was less
 * than MIN_INVITE_REMAINING_MS away on the relay's own clock, which says the
 * page's clock runs behind (ADR 0017's notes).
 */
export const InviteRefusalReasonSchema = z.enum([
  'no_sponsor',
  'policy',
  'limit',
  'duplicate',
  'no_public_url',
  'expired',
]);
export type InviteRefusalReason = z.infer<typeof InviteRefusalReasonSchema>;

/**
 * An invite's terms as the adapter set them. role observer is Can watch and
 * driver Can control; expiresAt null is "while the page is open", which the
 * relay still ends MAX_INVITE_LIFETIME_MS after minting.
 */
const InviteTermsShape = {
  inviteId: IdSchema,
  role: RoleSchema,
  label: InviteLabelSchema,
  uses: z.number().check(z.int(), z.gte(1), z.lte(MAX_INVITE_USES)),
  expiresAt: z.nullable(EpochMsSchema),
};

/** A control invite is never approved in advance, so it is good for exactly one use. */
export function controlForOneUse(terms: { role: Role; uses: number }): boolean {
  return terms.role === 'observer' || terms.uses === CONTROL_INVITE_USES;
}
const CONTROL_FOR_ONE_USE = { message: 'a control invite has exactly one use' };

/**
 * An https origin as the URL parser serialises one (lower-case host or
 * bracketed IPv6, optional port), then the invite path. No credentials, query
 * or fragment can match, and the protocol package needs no URL global.
 */
const HTTPS_ORIGIN = `https://(?:[a-z0-9-]+(?:\\.[a-z0-9-]+)*|\\[[0-9a-f:.]+\\])(?::\\d{1,5})?`;
const INVITE_LINK_BASE = new RegExp(`^${HTTPS_ORIGIN}${INVITE_PATH}$`);

/** Where invite links start: `<public URL>/i`, so the adapter appends `#<secret>` and nothing else. */
export function isInviteLinkBase(text: string): boolean {
  return text.length <= 2048 && INVITE_LINK_BASE.test(text);
}

/** One live invite as the relay lists it to its page. */
export const InviteListingSchema = z
  .object({
    ...InviteTermsShape,
    usesLeft: z.number().check(z.int(), z.gte(0), z.lte(MAX_INVITE_USES)),
    /** The member attached longest when it was minted; fixed, since /i has shown the name (ADR 0017). */
    sponsor: UserSchema,
    /** A redemption waits on the operator's prompt; a control invite allows one at a time. */
    pending: z.boolean(),
    /** Refusals and timeouts so far; INVITE_BURN_REFUSALS burns a control invite. */
    refusals: z.number().check(z.int(), z.gte(0), z.lte(INVITE_BURN_REFUSALS)),
  })
  .check(
    z.refine(controlForOneUse, CONTROL_FOR_ONE_USE),
    z.refine((invite) => invite.usesLeft <= invite.uses, {
      message: 'an invite cannot have more uses left than it had',
    }),
  );
export type InviteListing = z.infer<typeof InviteListingSchema>;

/**
 * The invite an attach request came through. The relay forwards the secret
 * it was shown, so the adapter checks it against its own record and a relay
 * that never saw the secret cannot make up a redemption.
 */
export const AttachInviteSchema = z.object({
  inviteId: IdSchema,
  secret: InviteSecretSchema,
  label: InviteLabelSchema,
});

export const AttachViaSchema = z.enum(['code', 'qr', 'invite', 'agent']);
export type AttachVia = z.infer<typeof AttachViaSchema>;

// Agent tokens (ADR 0044)

/** An agent token: the prefix and 256 bits from getRandomValues as 43 base64url characters. */
export const AgentTokenSchema = z.string().check(z.regex(/^tda_[A-Za-z0-9_-]{43}$/));

/**
 * The agent token an attach request came through. As with an invite, the
 * relay forwards the token it was shown, so the adapter checks it against its
 * own record's hash and a relay that never saw the token cannot make one up.
 */
export const AttachAgentSchema = z.object({
  tokenId: IdSchema,
  secret: AgentTokenSchema,
  label: InviteLabelSchema,
});

/** Where a token stands: unused, its first request waiting on the operator, or attached. */
export const AgentStateSchema = z.enum(['dormant', 'asking', 'attached']);
export type AgentState = z.infer<typeof AgentStateSchema>;

/** One live agent token as the relay lists it to its page; never the token or its hash. */
export const AgentListingSchema = z.object({
  tokenId: IdSchema,
  label: InviteLabelSchema,
  /** As the page asked, on the page's clock. */
  expiresAt: EpochMsSchema,
  /** The member attached longest when it was minted, as for an invite. */
  sponsor: UserSchema,
  state: AgentStateSchema,
  /** Prompts that timed out so far; AGENT_BURN_TIMEOUTS burns the token. */
  timeouts: z.number().check(z.int(), z.gte(0), z.lte(AGENT_BURN_TIMEOUTS)),
});
export type AgentListing = z.infer<typeof AgentListingSchema>;

const AGENT_ENDPOINT = new RegExp(`^${HTTPS_ORIGIN}${AGENT_PATH}$`);

/** The agents' MCP endpoint: `<public URL>/g/mcp`, as the widget shows it beside a token. */
export function isAgentEndpoint(text: string): boolean {
  return text.length <= 2048 && AGENT_ENDPOINT.test(text);
}

/**
 * The text an agent's user id is hashed from: the domain, the page id and the
 * token id, a line each. Each side takes SHA-256 of it with its own crypto
 * (WebCrypto in the adapter, node:crypto in the relay), and the id is
 * INVITEE_ID_PREFIX and the first 32 hex characters, so an agent is an
 * invitee by its id. A provider's subject is printable and holds no line
 * break, so the text a signed-in invitee's key is hashed from never equals
 * this one, and no agent's id can be a signed-in account's.
 */
export function agentKeyInput(pageId: string, tokenId: string): string {
  return `${AGENT_KEY_DOMAIN}\n${pageId}\n${tokenId}`;
}

/**
 * Characters that show as nothing yet can turn the words after them around
 * or hide among them: format characters (the bidirectional controls among
 * them), a half of a surrogate pair that a cap cut, and every other
 * default-ignorable code point.
 */
const UNSEEN = /[\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu;
/** Controls, and every kind of space, line break and paragraph break. */
const BREAKS = /[\p{Cc}\s]+/gu;

/**
 * Self-declared text, such as a client's name, as it may be shown on one
 * line beside other words: what shows as nothing goes, each run of controls,
 * spaces or breaks becomes one space, and the ends are trimmed. Such a name
 * can then neither start a line of its own nor reorder the words around it,
 * and it is never longer than it was given.
 */
export function plainLine(text: string): string {
  return text.replace(UNSEEN, '').replace(BREAKS, ' ').trim();
}

/**
 * Characters that would not read as written where a person is asked to judge
 * text: controls, line and paragraph breaks, format characters (the
 * bidirectional controls among them), surrogate halves and every other
 * default-ignorable code point.
 */
const NOT_AS_WRITTEN = /[\p{Cc}\p{Zl}\p{Zp}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * Text a person confirms or judges (a client's question, ADR 0026; a
 * proposal on the page, ADR 0042) with each character that would not read as
 * written shown as its escape, so arguments cannot reorder or hide the words
 * around them. Unlike plainLine it drops nothing: every character stays
 * visible, so what is shown is what runs. The relay and the widget escape
 * alike because both call this.
 */
export function escapeUnseen(text: string): string {
  return text.replace(NOT_AS_WRITTEN, (char) => {
    const point = char.codePointAt(0) ?? 0;
    return point > 0xffff
      ? `\\u{${point.toString(16)}}`
      : `\\u${point.toString(16).padStart(4, '0')}`;
  });
}

/**
 * MCP client name and version, for attribution only; null when the client
 * did not say. The relay keeps them as plainLine leaves them, and the widget
 * shows them so again, since the adapter does not trust the relay. The schema
 * itself takes any text within its caps, so audit records written before
 * that still parse.
 */
export const ClientInfoSchema = z.object({
  name: z.string().check(z.maxLength(100)),
  version: z.string().check(z.maxLength(50)),
});
export type ClientInfo = z.infer<typeof ClientInfoSchema>;

export const CallerSchema = z.extend(UserSchema, {
  client: z.nullable(ClientInfoSchema),
  role: RoleSchema,
});
export type Caller = z.infer<typeof CallerSchema>;

/**
 * ADR 0017: an account is an invitee exactly when its id is an invitee's, so
 * the page can tell a caller's kind from its id alone (Caller carries none)
 * and a frame that says otherwise is malformed.
 */
export function kindMatchesId(kind: UserKind, userId: string): boolean {
  return (kind === 'invitee') === InviteeIdSchema.safeParse(userId).success;
}
const KIND_MATCHES_ID = {
  message: "an invitee's id is g_ and its account key, and only an invitee's is",
};

export const AttachmentViewSchema = z
  .extend(UserSchema, {
    kind: UserKindSchema,
    role: RoleSchema,
    grantedAt: EpochMsSchema,
    lastUsedAt: z.nullable(EpochMsSchema),
    expiresAt: z.nullable(EpochMsSchema),
    /** Clients seen calling through this attachment, newest first. */
    clients: z.array(ClientInfoSchema).check(z.maxLength(20)),
    /**
     * The invite (ADR 0017) or agent token (ADR 0044) that made this
     * attachment, or null for one an approval or autoApprove made.
     */
    inviteId: z.nullable(IdSchema),
    /** When an invite-made attachment ends whatever its use, at most 24 hours after redemption; null otherwise. */
    endsAt: z.nullable(EpochMsSchema),
  })
  .check(
    z.refine((view) => kindMatchesId(view.kind, view.userId), KIND_MATCHES_ID),
    z.refine((view) => (view.inviteId === null) === (view.endsAt === null), {
      message: 'an invite-made attachment has its end, and no other has one',
    }),
  );
export type AttachmentView = z.infer<typeof AttachmentViewSchema>;

/** A pairing code as the relay shows it on the page; readers check what they read with this rule. */
export const PairingCodeSchema = z.string().check(z.minLength(1), z.maxLength(32));
export type PairingCode = z.infer<typeof PairingCodeSchema>;

export const PairingSchema = z.object({
  code: PairingCodeSchema,
  /** Where a phone can open the QR flow (M3); absent until the relay serves /pair. */
  url: z.optional(z.string().check(z.maxLength(2048))),
  expiresAt: EpochMsSchema,
});
export type Pairing = z.infer<typeof PairingSchema>;

const PositiveIntSchema = z.number().check(z.int(), z.positive());

/**
 * The relay's numbers, in every welcome. The M6 fields are optional, so a
 * 0.1.0 relay's welcome still parses, and none is capped above: a hostile
 * relay's large number is clamped by the adapter rather than closing the
 * link. maxImageBytes absent or 0 means the relay takes no image results
 * (ADR 0039), and maxStateBytes absent means it takes no page state (ADR
 * 0040); usersPerPage and observersPerPage are the people limit and the
 * watching seats (ADR 0044).
 */
export const LimitsSchema = z.object({
  maxFrameBytes: PositiveIntSchema,
  maxResultChars: PositiveIntSchema,
  maxDescriptionChars: PositiveIntSchema,
  pingIntervalMs: PositiveIntSchema,
  idleTimeoutMs: PositiveIntSchema,
  resumeWindowMs: PositiveIntSchema,
  attachRequestTtlMs: PositiveIntSchema,
  maxImageBytes: z.optional(z.number().check(z.int(), z.nonnegative())),
  maxStateBytes: z.optional(PositiveIntSchema),
  usersPerPage: z.optional(PositiveIntSchema),
  observersPerPage: z.optional(z.number().check(z.int(), z.nonnegative())),
});
export type Limits = z.infer<typeof LimitsSchema>;

/** Errors the adapter reports for a call. The relay maps them to SPEC.md section 7 codes. */
export const PAGE_ERROR_CODES = [
  'tool_error',
  'tool_not_found',
  'role_denied',
  'denied_by_operator',
  'cancelled',
  'timeout',
  'page_busy',
] as const;
export const PageErrorCodeSchema = z.enum(PAGE_ERROR_CODES);
export type PageErrorCode = z.infer<typeof PageErrorCodeSchema>;

// Page to relay

export const HelloFrameSchema = z.object({
  t: z.literal('hello'),
  v: z.literal(PROTOCOL_VERSION),
  resumeToken: z.optional(z.string().check(z.minLength(1), z.maxLength(200))),
  title: z.string().check(z.maxLength(300)),
  url: z.string().check(z.maxLength(2048)),
  adapterVersion: z.string().check(z.maxLength(50)),
  policy: PolicySchema,
});

export const ToolsFrameSchema = z.object({
  t: z.literal('tools'),
  tools: z.array(PageToolSchema).check(z.maxLength(MAX_TOOLS_PER_PAGE)),
});

export const AttachDecisionFrameSchema = z.object({
  t: z.literal('attach_decision'),
  requestId: IdSchema,
  allow: z.boolean(),
  role: z.optional(RoleSchema),
});

export const SetRoleFrameSchema = z.object({
  t: z.literal('set_role'),
  userId: IdSchema,
  role: RoleSchema,
});

export const RevokeFrameSchema = z.object({
  t: z.literal('revoke'),
  userId: z.union([IdSchema, z.literal('*')]),
});

export const RotatePairingFrameSchema = z.object({ t: z.literal('rotate_pairing') });

/**
 * Mints an invite (ADR 0017). The adapter draws inviteId, so it can store its
 * own record before the relay answers, and sends only the secret's hash: the
 * secret itself goes into the link, never onto the wire from the page.
 */
export const InviteCreateFrameSchema = z
  .object({
    t: z.literal('invite_create'),
    ...InviteTermsShape,
    secretHash: InviteSecretHashSchema,
  })
  .check(z.refine(controlForOneUse, CONTROL_FOR_ONE_USE));

export const InviteCancelFrameSchema = z.object({
  t: z.literal('invite_cancel'),
  inviteId: IdSchema,
});

/**
 * Outcome of one call: `content` (the runtime's string result) when ok, `error`
 * otherwise. `image` (ADR 0039) rides only beside ok, from a tool the hello's
 * policy.imageTools names, and the relay checks it again before any client
 * sees it; an error result never carries one, since a client gives its model
 * only an error's text.
 */
export const ResultFrameSchema = z
  .object({
    t: z.literal('result'),
    callId: IdSchema,
    ok: z.boolean(),
    content: z.optional(z.string()),
    error: z.optional(
      z.object({ code: PageErrorCodeSchema, message: z.string().check(z.maxLength(2000)) }),
    ),
    image: z.optional(WireImageSchema),
  })
  .check(
    z.refine((frame) => (frame.ok ? frame.content !== undefined : frame.error !== undefined), {
      message: 'an ok result needs content and a failed one needs error',
    }),
    z.refine((frame) => frame.image === undefined || frame.ok, {
      message: 'only an ok result carries an image',
    }),
  );

// Page state (ADR 0040)

/** A published value: a JSON object, or null for nothing. */
export const StateValueSchema = z.nullable(JsonObjectSchema);
export type StateValue = z.infer<typeof StateValueSchema>;

/** The page's latest published state, replacing the last; the relay keeps only this one. */
export const StateFrameSchema = z.object({ t: z.literal('state'), value: StateValueSchema });

/**
 * What get_page_state and wait_for_page_state answer after their label line:
 * the page, its origin, the version (counted per page session, 0 before
 * anything was published), when the value was published and when the page
 * was last heard from, the value, and for a wait whether it changed. Never
 * structured content (S10). Clients, tests and the CI helper parse it here.
 */
export const PageStateResultSchema = z
  .object({
    page: IdSchema,
    origin: z.string().check(z.minLength(1), z.maxLength(2048)),
    version: z.number().check(z.int(), z.gte(0), z.lte(Number.MAX_SAFE_INTEGER)),
    publishedAt: z.nullable(EpochMsSchema),
    heardAt: EpochMsSchema,
    value: StateValueSchema,
    changed: z.optional(z.boolean()),
  })
  .check(
    z.refine(
      (result) => result.version !== 0 || (result.value === null && result.publishedAt === null),
      {
        message: 'version 0 has nothing published',
      },
    ),
  );
export type PageStateResult = z.infer<typeof PageStateResultSchema>;

// Proposals (ADR 0042), page to relay

/**
 * Why the page itself would not take a proposal: its own policy, the
 * proposer's role, the tool, a consequential tool it will not queue, its
 * own limits, or arguments past the caps.
 */
export const ProposalRefusalSchema = z.enum([
  'policy',
  'role',
  'tool',
  'consequential',
  'limit',
  'too_large',
]);
export type ProposalRefusal = z.infer<typeof ProposalRefusalSchema>;

/**
 * The operator's Accept or Dismiss, or the page's own refusal. An accepting
 * decision carries no refusal; a refusal is a decline with its reason, and a
 * plain dismissal has none.
 */
export const ProposalDecisionFrameSchema = z
  .object({
    t: z.literal('proposal_decision'),
    proposalId: IdSchema,
    accept: z.boolean(),
    refused: z.optional(ProposalRefusalSchema),
  })
  .check(
    z.refine((frame) => !frame.accept || frame.refused === undefined, {
      message: 'an accepted proposal is not refused',
    }),
  );

// Time-boxed sessions (ADR 0043), page to relay

/** Starts a session under the page's ceiling; lengthMs counts from now. */
export const SessionStartFrameSchema = z.object({
  t: z.literal('session_start'),
  sessionId: IdSchema,
  lengthMs: SessionLengthSchema,
  policy: SessionPolicySchema,
});

/** Lengthens the live session; lengthMs is the new total from its start. */
export const SessionExtendFrameSchema = z.object({
  t: z.literal('session_extend'),
  sessionId: IdSchema,
  lengthMs: SessionLengthSchema,
});

export const SessionEndFrameSchema = z.object({
  t: z.literal('session_end'),
  sessionId: IdSchema,
});

// Agent tokens (ADR 0044), page to relay

/**
 * Mints an agent token. As with an invite, the adapter draws tokenId and the
 * token, keeps its own record and sends only the token's hash: the token is
 * shown once on the page and never crosses the link from the page.
 */
export const AgentCreateFrameSchema = z.object({
  t: z.literal('agent_create'),
  tokenId: IdSchema,
  label: InviteLabelSchema,
  expiresAt: EpochMsSchema,
  secretHash: InviteSecretHashSchema,
});

export const AgentCancelFrameSchema = z.object({
  t: z.literal('agent_cancel'),
  tokenId: IdSchema,
});

export const PingFrameSchema = z.object({ t: z.literal('ping') });
export const PongFrameSchema = z.object({ t: z.literal('pong') });

export const PageFrameSchema = z.discriminatedUnion('t', [
  HelloFrameSchema,
  ToolsFrameSchema,
  AttachDecisionFrameSchema,
  SetRoleFrameSchema,
  RevokeFrameSchema,
  RotatePairingFrameSchema,
  InviteCreateFrameSchema,
  InviteCancelFrameSchema,
  ResultFrameSchema,
  PingFrameSchema,
  PongFrameSchema,
  StateFrameSchema,
  ProposalDecisionFrameSchema,
  SessionStartFrameSchema,
  SessionExtendFrameSchema,
  SessionEndFrameSchema,
  AgentCreateFrameSchema,
  AgentCancelFrameSchema,
]);
export type PageFrame = z.infer<typeof PageFrameSchema>;
/** What the adapter writes; defaults in the policy may be left out. */
export type PageFrameInput = z.input<typeof PageFrameSchema>;

// Relay to page

export const WelcomeFrameSchema = z.object({
  t: z.literal('welcome'),
  pageId: IdSchema,
  /** A fresh token on every welcome; the page must store it and forget the old one. */
  resumeToken: z.string().check(z.minLength(1), z.maxLength(200)),
  resumed: z.boolean(),
  pairing: PairingSchema,
  roster: z.array(AttachmentViewSchema),
  limits: LimitsSchema,
});

export const AttachRequestFrameSchema = z
  .object({
    t: z.literal('attach_request'),
    requestId: IdSchema,
    user: UserSchema,
    account: AccountSchema,
    via: AttachViaSchema,
    /** Present exactly when via is invite (ADR 0017). */
    invite: z.optional(AttachInviteSchema),
    /** Present exactly when via is agent (ADR 0044). */
    agent: z.optional(AttachAgentSchema),
    client: z.nullable(ClientInfoSchema),
    expiresAt: EpochMsSchema,
  })
  .check(
    z.refine((frame) => (frame.via === 'invite') === (frame.invite !== undefined), {
      message: 'an invite request carries its invite, and no other request does',
    }),
    z.refine((frame) => kindMatchesId(frame.account.kind, frame.user.userId), KIND_MATCHES_ID),
    z.refine((frame) => (frame.via === 'agent') === (frame.agent !== undefined), {
      message: 'an agent request carries its agent token, and no other request does',
    }),
    z.refine(
      (frame) =>
        frame.via !== 'agent' || (frame.account.kind === 'invitee' && !frame.account.verified),
      { message: 'an agent has no account: it is an unverified invitee' },
    ),
  );

export const RosterFrameSchema = z.object({
  t: z.literal('roster'),
  attachments: z.array(AttachmentViewSchema),
});

export const PairingFrameSchema = z.extend(PairingSchema, { t: z.literal('pairing') });

/**
 * The page's live invites (ADR 0017), after each welcome and on every change.
 * linkBase is `<public URL>/i`, or null where the relay mints none (no public
 * URL); refused answers an invite_create the relay turned down.
 */
export const InvitesFrameSchema = z.object({
  t: z.literal('invites'),
  linkBase: z.nullable(z.string().check(z.maxLength(2048), z.refine(isInviteLinkBase))),
  invites: z.array(InviteListingSchema).check(z.maxLength(MAX_LIVE_INVITES_PER_PAGE)),
  refused: z.optional(z.object({ inviteId: IdSchema, reason: InviteRefusalReasonSchema })),
});

/**
 * The relay's word that the caller confirmed this call in their own client
 * (ADR 0026). confirmationId is a fresh relay id, never the id of the record
 * the relay checked, and at is when the confirming answer arrived. The adapter
 * honours it only under its own policy, its own consequential rule and its own
 * record that the caller is a member driver no invite made; anything else
 * prompts as usual, so a crafted frame skips no prompt.
 */
export const ConfirmationSchema = z.object({
  by: z.literal('client'),
  confirmationId: IdSchema,
  at: EpochMsSchema,
});
export type Confirmation = z.infer<typeof ConfirmationSchema>;

/**
 * confirmation (M5) is optional: an adapter older than M5 drops it, since
 * this object strips keys it does not know, and prompts as it always has.
 * proposal (M6, ADR 0042) names the proposal the operator accepted on the
 * page; the adapter runs such an invoke only against its own record of that
 * acceptance, and an adapter older than M6 drops the key and refuses the
 * observer's call as before. For a proposal the operator's Accept is the
 * confirmation, so no invoke carries both.
 */
export const InvokeFrameSchema = z
  .object({
    t: z.literal('invoke'),
    callId: IdSchema,
    tool: ToolNameSchema,
    arguments: JsonObjectSchema,
    caller: CallerSchema,
    deadlineMs: PositiveIntSchema,
    confirmation: z.optional(ConfirmationSchema),
    proposal: z.optional(z.object({ proposalId: IdSchema })),
  })
  .check(
    z.refine((frame) => frame.confirmation === undefined || frame.proposal === undefined, {
      message: 'an invoke is confirmed in a client or accepted as a proposal, never both',
    }),
  );

export const CancelFrameSchema = z.object({
  t: z.literal('cancel'),
  callId: IdSchema,
  reason: z.optional(z.enum(['timeout', 'revoked', 'client', 'shutdown'])),
});

// Proposals (ADR 0042), relay to page

/**
 * An observer's call the page's policy turned into a proposal. The page shows
 * the arguments as text for the operator to accept or dismiss; nothing runs
 * until an invoke naming this proposal arrives after the Accept.
 */
export const ProposalFrameSchema = z.object({
  t: z.literal('proposal'),
  proposalId: IdSchema,
  tool: ToolNameSchema,
  arguments: JsonObjectSchema,
  proposer: CallerSchema,
  expiresAt: EpochMsSchema,
});

/**
 * Why a pending proposal ended before the operator decided: its proposer
 * withdrew it, its time ran out, the proposer's attachment ended, a session
 * narrowed the policy, or an accepted proposal could not be run.
 */
export const ProposalEndReasonSchema = z.enum([
  'withdrawn',
  'expired',
  'attachment_ended',
  'policy',
  'not_run',
]);
export type ProposalEndReason = z.infer<typeof ProposalEndReasonSchema>;

export const ProposalEndFrameSchema = z.object({
  t: z.literal('proposal_end'),
  proposalId: IdSchema,
  reason: ProposalEndReasonSchema,
});

// Time-boxed sessions (ADR 0043), relay to page

/**
 * Why the relay refused a session frame. active: another session is live;
 * policy: wider than the ceiling; unknown: an extend or end for an id that is
 * not live; length: an extend that is not longer; limit: past the page's
 * operator grants.
 */
export const SessionRefusalReasonSchema = z.enum([
  'active',
  'policy',
  'unknown',
  'length',
  'limit',
]);
export type SessionRefusalReason = z.infer<typeof SessionRefusalReasonSchema>;

/** How a session ended at the relay: the operator ended it, its time ran out, or its page went. */
export const SessionEndReasonSchema = z.enum(['operator', 'time', 'page_gone']);
export type SessionEndReason = z.infer<typeof SessionEndReasonSchema>;

/** A live session as the relay holds it; remainingMs is on the relay's clock. */
export const TimedSessionViewSchema = z.object({
  sessionId: IdSchema,
  lengthMs: SessionLengthSchema,
  remainingMs: z.number().check(z.int(), z.gte(0), z.lte(MAX_SESSION_MS)),
  policy: SessionPolicySchema,
});
export type TimedSessionView = z.infer<typeof TimedSessionViewSchema>;

/**
 * The live session or null, after every welcome and on every change, with how
 * one ended or why a session frame was refused. It carries no label: the label
 * is page text, kept by the adapter.
 */
export const SessionFrameSchema = z.object({
  t: z.literal('session'),
  session: z.nullable(TimedSessionViewSchema),
  ended: z.optional(z.object({ sessionId: IdSchema, reason: SessionEndReasonSchema })),
  refused: z.optional(z.object({ sessionId: IdSchema, reason: SessionRefusalReasonSchema })),
});

// Agent tokens (ADR 0044), relay to page

/**
 * The page's live agent tokens, after each welcome and on every change.
 * endpoint is `<public URL>/g/mcp`, or null where the relay takes no agents;
 * refused answers an agent_create the relay turned down.
 */
export const AgentsFrameSchema = z.object({
  t: z.literal('agents'),
  endpoint: z.nullable(z.string().check(z.maxLength(2048), z.refine(isAgentEndpoint))),
  agents: z.array(AgentListingSchema).check(z.maxLength(MAX_LIVE_AGENTS_PER_PAGE)),
  refused: z.optional(z.object({ tokenId: IdSchema, reason: InviteRefusalReasonSchema })),
});

export const RelayFrameSchema = z.discriminatedUnion('t', [
  WelcomeFrameSchema,
  AttachRequestFrameSchema,
  RosterFrameSchema,
  PairingFrameSchema,
  InvitesFrameSchema,
  InvokeFrameSchema,
  CancelFrameSchema,
  PingFrameSchema,
  PongFrameSchema,
  ProposalFrameSchema,
  ProposalEndFrameSchema,
  SessionFrameSchema,
  AgentsFrameSchema,
]);
export type RelayFrame = z.infer<typeof RelayFrameSchema>;

export const PAGE_FRAME_TYPES = [
  'hello',
  'tools',
  'attach_decision',
  'set_role',
  'revoke',
  'rotate_pairing',
  'invite_create',
  'invite_cancel',
  'result',
  'ping',
  'pong',
  'state',
  'proposal_decision',
  'session_start',
  'session_extend',
  'session_end',
  'agent_create',
  'agent_cancel',
] as const;

export const RELAY_FRAME_TYPES = [
  'welcome',
  'attach_request',
  'roster',
  'pairing',
  'invites',
  'invoke',
  'cancel',
  'ping',
  'pong',
  'proposal',
  'proposal_end',
  'session',
  'agents',
] as const;

export type ParsedFrame<F> =
  | { kind: 'ok'; frame: F }
  /** A type this side does not know: SPEC.md section 6 says ignore it and log. */
  | { kind: 'unknown'; type: string }
  /** Not JSON, not an object, or a known type with a bad shape. */
  | { kind: 'invalid'; reason: string };

/**
 * JSON.parse as it was when this module loaded, which in the adapter's
 * bundle is before attach(): a page script that replaced JSON.parse later
 * would otherwise be handed every relay frame's text, a redemption's invite
 * secret with it. The checks that follow still run on the page's built-ins
 * (Array.isArray is handed the parsed frame, here and in zod, and zod's
 * regex checks call RegExp.prototype), so this narrows what a later script
 * can read or change rather than closing it (docs/threat-model.md, B5).
 */
const parseJson = JSON.parse;

function parseWith<F>(
  schema: z.ZodMiniType<F>,
  known: readonly string[],
  text: string,
): ParsedFrame<F> {
  let value: unknown;
  try {
    value = parseJson(text);
  } catch {
    return { kind: 'invalid', reason: 'not JSON' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'invalid', reason: 'not an object' };
  }
  const type = (value as { t?: unknown }).t;
  if (typeof type !== 'string') return { kind: 'invalid', reason: 'missing type' };
  if (!known.includes(type)) return { kind: 'unknown', type: type.slice(0, 64) };
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    // Only paths and messages, never values: frames can carry codes, tokens and
    // arguments. A strict object's message would name the keys it did not
    // take, which the sender wrote, so that one says so in fixed words.
    const reason = parsed.error.issues
      .slice(0, 3)
      .map(
        (issue) =>
          `${issue.path.join('.') || '(root)'}: ${issue.code === 'unrecognized_keys' ? 'holds fields it does not take' : issue.message}`,
      )
      .join('; ');
    return { kind: 'invalid', reason: `bad ${type} frame: ${reason}` };
  }
  return { kind: 'ok', frame: parsed.data };
}

/** Parses a frame the relay received from a page. */
export function parsePageFrame(text: string): ParsedFrame<PageFrame> {
  return parseWith(PageFrameSchema, PAGE_FRAME_TYPES, text);
}

/** Parses a frame the adapter received from the relay. */
export function parseRelayFrame(text: string): ParsedFrame<RelayFrame> {
  return parseWith(RelayFrameSchema, RELAY_FRAME_TYPES, text);
}

/**
 * JSON.stringify as it was when this module loaded, for the same reason as
 * parseJson: a page script that replaced JSON.stringify after attach() would
 * otherwise be handed every frame the page sends, and could hand back other
 * text, so that the operator's Deny left the page as Allow. It still looks up
 * toJSON on every object in the frame, so a toJSON that such a script puts on
 * Object.prototype is still called and can still read and rewrite each frame
 * as it goes out. The adapter's schema check, which runs before this, hands
 * each frame to page built-ins (Array.isArray among them) that such a script
 * can patch to the same end; this narrows the routes rather than closing
 * them (docs/threat-model.md, B5).
 */
const stringifyJson = JSON.stringify;

export function encodeFrame(frame: PageFrameInput | RelayFrame): string {
  return stringifyJson(frame);
}

/**
 * A live value as JSON text, through the JSON.stringify taken at load: the
 * adapter writes a published state value once, measures that text and sends
 * what it measured (ADR 0040). It throws where JSON.stringify throws (a cycle,
 * a BigInt), so the caller holds it in a try.
 */
export function encodeValue(value: unknown): string | undefined {
  return stringifyJson(value);
}

/** JSON text back to a value, through the JSON.parse taken at load; throws on text that is not JSON. */
export function parseValue(text: string): unknown {
  return parseJson(text);
}

/**
 * An object with its own keys sorted, holding the same values, for
 * JSON.stringify's replacer. A null prototype keeps a key named __proto__
 * an ordinary key, as JSON.parse made it.
 */
function sortedKeys(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const sorted = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(source).sort()) sorted[key] = source[key];
  return sorted;
}

/**
 * The arguments as canonical JSON: every object's keys in code unit order,
 * no white space. Two calls whose arguments mean the same JSON give the same
 * text whatever order their keys came in, and any change to a value gives
 * another. JSON.stringify does the walk, so the depth it can take is the
 * depth the invoke itself was encoded at; null when it cannot. It binds a
 * client's confirmation (ADR 0026) and an accepted proposal (ADR 0042) to
 * exact arguments, on both sides of the link.
 */
export function canonicalJson(value: JsonObject): string | null {
  try {
    return stringifyJson(value, (_key, inner: unknown) => sortedKeys(inner));
  } catch {
    return null;
  }
}

/**
 * UTF-8 bytes of a text. JSON.stringify writes a lone surrogate as an escape,
 * so canonical JSON holds none; one elsewhere counts as the 3 bytes of the
 * U+FFFD an encoder writes for it.
 */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Whether a proposal's arguments pass ADR 0042's caps: at most
 * MAX_PROPOSAL_ARGUMENT_NODES values and keys (the arguments object itself
 * counting as one value), counted no further than the cap, then at most
 * MAX_PROPOSAL_ARGUMENT_BYTES UTF-8 bytes of canonical JSON. A proposal waits
 * up to ten minutes outside any request's byte charge, so both bound what it
 * holds. Arguments that cannot be written as JSON at all count as too large.
 */
export function proposalArgumentProblem(args: JsonObject): 'bytes' | 'nodes' | null {
  // Each value is counted as it is found, so neither the walk nor its stack
  // ever holds more than the cap, however deep or wide the arguments are.
  let nodes = 1;
  const pending: unknown[] = [args];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== 'object' || value === null) continue;
    if (Array.isArray(value)) {
      const items = value as unknown[];
      for (let index = 0; index < items.length; index += 1) {
        nodes += 1;
        if (nodes > MAX_PROPOSAL_ARGUMENT_NODES) return 'nodes';
        pending.push(items[index]);
      }
      continue;
    }
    const object = value as Record<string, unknown>;
    for (const key of Object.keys(object)) {
      // The key and its value.
      nodes += 2;
      if (nodes > MAX_PROPOSAL_ARGUMENT_NODES) return 'nodes';
      pending.push(object[key]);
    }
  }
  const text = canonicalJson(args);
  if (text === null || utf8Bytes(text) > MAX_PROPOSAL_ARGUMENT_BYTES) return 'bytes';
  return null;
}

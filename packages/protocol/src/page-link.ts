// The page link (SPEC.md section 6): JSON text frames shaped { t: "<type>", ... }
// over a WebSocket with subprotocol tabdock.v1. Both sides parse every frame with
// these schemas; the TypeScript types are inferred from them, so the wire format
// is defined exactly once.

// First, before zod builds anything: no eval probe on Trusted Types pages.
import './zod-config.ts';
import { z } from 'zod';
import {
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
  MAX_LIVE_INVITES_PER_PAGE,
  MAX_TOOLS_PER_PAGE,
  PROTOCOL_VERSION,
} from './constants.ts';

// Building blocks

/** Opaque identifiers minted by the relay (page, request, call, user ids). */
export const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** Milliseconds since the Unix epoch. */
export const EpochMsSchema = z.number().int().nonnegative();

export const RoleSchema = z.enum(['observer', 'driver']);
export type Role = z.infer<typeof RoleSchema>;

/** WebMCP's tool name rule: 1 to 128 characters of letters, digits, '_', '-' or '.'. */
export const ToolNameSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);

/** Unknown hint keys are dropped rather than rejected; runtimes add hints over time. */
export const ToolAnnotationsSchema = z.object({
  readOnlyHint: z.boolean().optional(),
  consequentialHint: z.boolean().optional(),
  untrustedContentHint: z.boolean().optional(),
  debugging: z.boolean().optional(),
});
export type ToolAnnotations = z.infer<typeof ToolAnnotationsSchema>;

export const JsonObjectSchema = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObjectSchema>;

/**
 * One tool as the adapter reports it. The wire allows long descriptions; the
 * relay cuts them to MAX_DESCRIPTION_CHARS before any client sees them (S10).
 * inputSchema is always an object here: the adapter parses the JSON string that
 * Chrome 153 and 154 return (ADR 0001).
 */
export const PageToolSchema = z.object({
  name: ToolNameSchema,
  title: z.string().max(200).optional(),
  description: z.string().max(10_000),
  inputSchema: JsonObjectSchema,
  annotations: ToolAnnotationsSchema.optional(),
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
 * Page policy, sent in hello. consequentialTools is ADR 0002's option C
 * (accepted): tools the page declares consequential even when the runtime drops
 * consequentialHint.
 */
export const PolicySchema = z.object({
  autoApprove: z.enum(['none', 'observer']).default('none'),
  maxDrivers: z.number().int().min(1).max(100).default(1),
  consequential: z.enum(['confirm', 'allow', 'deny']).default('confirm'),
  consequentialTools: z.array(ToolNameSchema).max(MAX_TOOLS_PER_PAGE).default([]),
  invites: InvitePolicySchema.default('watch'),
});
export type Policy = z.infer<typeof PolicySchema>;
export type PolicyInput = z.input<typeof PolicySchema>;

export const UserSchema = z.object({
  userId: IdSchema,
  displayName: z.string().min(1).max(MAX_DISPLAY_NAME_CHARS),
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
  .regex(new RegExp(`^${INVITEE_ID_PREFIX}[0-9a-f]{${String(INVITEE_KEY_HEX_CHARS)}}$`));

/**
 * An email address as an identity provider vouches for it: one '@', no
 * space or control character, at most MAX_EMAIL_CHARS. Loose on purpose,
 * since the provider has already checked the address; this only keeps
 * anything that is not one from being shown or stored as one.
 */
export const EmailSchema = z
  .string()
  .max(MAX_EMAIL_CHARS)
  .regex(/^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+$/u);

/**
 * What an attach request says about the account behind it (ADR 0017). An
 * invitee is verified when its name is an email the provider vouches for, and
 * shows as UNVERIFIED_ACCOUNT_NAME otherwise; a member's name comes from the
 * owner's own settings, so a member is always verified.
 */
export const AccountSchema = z
  .object({ kind: UserKindSchema, verified: z.boolean() })
  .refine((account) => account.kind === 'invitee' || account.verified, {
    message: 'a member is always verified',
  });
export type Account = z.infer<typeof AccountSchema>;

// Invites (ADR 0017)

/** An invite secret: 128 bits from getRandomValues as 22 base64url characters. */
export const InviteSecretSchema = z
  .string()
  .regex(new RegExp(`^[A-Za-z0-9_-]{${String(INVITE_SECRET_CHARS)}}$`));

/**
 * SHA-256 of the secret's UTF-8 text, as 64 lower-case hex characters: what
 * the adapter sends and the relay keeps instead of the secret.
 */
export const InviteSecretHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** The operator's label for an invite: page-written text, capped and shown as written (S10). */
export const InviteLabelSchema = z.string().min(1).max(MAX_INVITE_LABEL_CHARS);

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
  uses: z.number().int().min(1).max(MAX_INVITE_USES),
  expiresAt: EpochMsSchema.nullable(),
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
const INVITE_LINK_BASE = new RegExp(
  `^https://(?:[a-z0-9-]+(?:\\.[a-z0-9-]+)*|\\[[0-9a-f:.]+\\])(?::\\d{1,5})?${INVITE_PATH}$`,
);

/** Where invite links start: `<public URL>/i`, so the adapter appends `#<secret>` and nothing else. */
export function isInviteLinkBase(text: string): boolean {
  return text.length <= 2048 && INVITE_LINK_BASE.test(text);
}

/** One live invite as the relay lists it to its page. */
export const InviteListingSchema = z
  .object({
    ...InviteTermsShape,
    usesLeft: z.number().int().min(0).max(MAX_INVITE_USES),
    /** The member attached longest when it was minted; fixed, since /i has shown the name (ADR 0017). */
    sponsor: UserSchema,
    /** A redemption waits on the operator's prompt; a control invite allows one at a time. */
    pending: z.boolean(),
    /** Refusals and timeouts so far; INVITE_BURN_REFUSALS burns a control invite. */
    refusals: z.number().int().min(0).max(INVITE_BURN_REFUSALS),
  })
  .refine(controlForOneUse, CONTROL_FOR_ONE_USE)
  .refine((invite) => invite.usesLeft <= invite.uses, {
    message: 'an invite cannot have more uses left than it had',
  });
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

export const AttachViaSchema = z.enum(['code', 'qr', 'invite']);
export type AttachVia = z.infer<typeof AttachViaSchema>;

/** MCP client name and version, for attribution only; null when the client did not say. */
export const ClientInfoSchema = z.object({
  name: z.string().max(100),
  version: z.string().max(50),
});
export type ClientInfo = z.infer<typeof ClientInfoSchema>;

export const CallerSchema = UserSchema.extend({
  client: ClientInfoSchema.nullable(),
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

export const AttachmentViewSchema = UserSchema.extend({
  kind: UserKindSchema,
  role: RoleSchema,
  grantedAt: EpochMsSchema,
  lastUsedAt: EpochMsSchema.nullable(),
  expiresAt: EpochMsSchema.nullable(),
  /** Clients seen calling through this attachment, newest first. */
  clients: z.array(ClientInfoSchema).max(20),
  /** The invite that made this attachment, or null for one an approval or autoApprove made (ADR 0017). */
  inviteId: IdSchema.nullable(),
  /** When an invite-made attachment ends whatever its use, at most 24 hours after redemption; null otherwise. */
  endsAt: EpochMsSchema.nullable(),
})
  .refine((view) => kindMatchesId(view.kind, view.userId), KIND_MATCHES_ID)
  .refine((view) => (view.inviteId === null) === (view.endsAt === null), {
    message: 'an invite-made attachment has its end, and no other has one',
  });
export type AttachmentView = z.infer<typeof AttachmentViewSchema>;

export const PairingSchema = z.object({
  code: z.string().min(1).max(32),
  /** Where a phone can open the QR flow (M3); absent until the relay serves /pair. */
  url: z.string().max(2048).optional(),
  expiresAt: EpochMsSchema,
});
export type Pairing = z.infer<typeof PairingSchema>;

export const LimitsSchema = z.object({
  maxFrameBytes: z.number().int().positive(),
  maxResultChars: z.number().int().positive(),
  maxDescriptionChars: z.number().int().positive(),
  pingIntervalMs: z.number().int().positive(),
  idleTimeoutMs: z.number().int().positive(),
  resumeWindowMs: z.number().int().positive(),
  attachRequestTtlMs: z.number().int().positive(),
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
  resumeToken: z.string().min(1).max(200).optional(),
  title: z.string().max(300),
  url: z.string().max(2048),
  adapterVersion: z.string().max(50),
  policy: PolicySchema,
});

export const ToolsFrameSchema = z.object({
  t: z.literal('tools'),
  tools: z.array(PageToolSchema).max(MAX_TOOLS_PER_PAGE),
});

export const AttachDecisionFrameSchema = z.object({
  t: z.literal('attach_decision'),
  requestId: IdSchema,
  allow: z.boolean(),
  role: RoleSchema.optional(),
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
  .refine(controlForOneUse, CONTROL_FOR_ONE_USE);

export const InviteCancelFrameSchema = z.object({
  t: z.literal('invite_cancel'),
  inviteId: IdSchema,
});

/** Outcome of one call: `content` (the runtime's string result) when ok, `error` otherwise. */
export const ResultFrameSchema = z
  .object({
    t: z.literal('result'),
    callId: IdSchema,
    ok: z.boolean(),
    content: z.string().optional(),
    error: z.object({ code: PageErrorCodeSchema, message: z.string().max(2000) }).optional(),
  })
  .refine((frame) => (frame.ok ? frame.content !== undefined : frame.error !== undefined), {
    message: 'an ok result needs content and a failed one needs error',
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
]);
export type PageFrame = z.infer<typeof PageFrameSchema>;
/** What the adapter writes; defaults in the policy may be left out. */
export type PageFrameInput = z.input<typeof PageFrameSchema>;

// Relay to page

export const WelcomeFrameSchema = z.object({
  t: z.literal('welcome'),
  pageId: IdSchema,
  /** A fresh token on every welcome; the page must store it and forget the old one. */
  resumeToken: z.string().min(1).max(200),
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
    invite: AttachInviteSchema.optional(),
    client: ClientInfoSchema.nullable(),
    expiresAt: EpochMsSchema,
  })
  .refine((frame) => (frame.via === 'invite') === (frame.invite !== undefined), {
    message: 'an invite request carries its invite, and no other request does',
  })
  .refine((frame) => kindMatchesId(frame.account.kind, frame.user.userId), KIND_MATCHES_ID);

export const RosterFrameSchema = z.object({
  t: z.literal('roster'),
  attachments: z.array(AttachmentViewSchema),
});

export const PairingFrameSchema = PairingSchema.extend({ t: z.literal('pairing') });

/**
 * The page's live invites (ADR 0017), after each welcome and on every change.
 * linkBase is `<public URL>/i`, or null where the relay mints none (no public
 * URL); refused answers an invite_create the relay turned down.
 */
export const InvitesFrameSchema = z.object({
  t: z.literal('invites'),
  linkBase: z.string().max(2048).refine(isInviteLinkBase).nullable(),
  invites: z.array(InviteListingSchema).max(MAX_LIVE_INVITES_PER_PAGE),
  refused: z.object({ inviteId: IdSchema, reason: InviteRefusalReasonSchema }).optional(),
});

export const InvokeFrameSchema = z.object({
  t: z.literal('invoke'),
  callId: IdSchema,
  tool: ToolNameSchema,
  arguments: JsonObjectSchema,
  caller: CallerSchema,
  deadlineMs: z.number().int().positive(),
});

export const CancelFrameSchema = z.object({
  t: z.literal('cancel'),
  callId: IdSchema,
  reason: z.enum(['timeout', 'revoked', 'client', 'shutdown']).optional(),
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
  schema: z.ZodType<F>,
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
    // Only paths and messages, never values: frames can carry codes, tokens and arguments.
    const reason = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
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

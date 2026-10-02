// The page link (SPEC.md section 6): JSON text frames shaped { t: "<type>", ... }
// over a WebSocket with subprotocol tabdock.v1. Both sides parse every frame with
// these schemas; the TypeScript types are inferred from them, so the wire format
// is defined exactly once.

import { z } from 'zod';
import { MAX_TOOLS_PER_PAGE, PROTOCOL_VERSION } from './constants.ts';

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
 * Page policy, sent in hello. consequentialTools is ADR 0002's option C
 * (accepted): tools the page declares consequential even when the runtime drops
 * consequentialHint.
 */
export const PolicySchema = z.object({
  autoApprove: z.enum(['none', 'observer']).default('none'),
  maxDrivers: z.number().int().min(1).max(100).default(1),
  consequential: z.enum(['confirm', 'allow', 'deny']).default('confirm'),
  consequentialTools: z.array(ToolNameSchema).max(MAX_TOOLS_PER_PAGE).default([]),
});
export type Policy = z.infer<typeof PolicySchema>;
export type PolicyInput = z.input<typeof PolicySchema>;

export const UserSchema = z.object({
  userId: IdSchema,
  displayName: z.string().min(1).max(100),
});
export type User = z.infer<typeof UserSchema>;

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

export const AttachmentViewSchema = UserSchema.extend({
  role: RoleSchema,
  grantedAt: EpochMsSchema,
  lastUsedAt: EpochMsSchema.nullable(),
  expiresAt: EpochMsSchema.nullable(),
  /** Clients seen calling through this attachment, newest first. */
  clients: z.array(ClientInfoSchema).max(20),
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

export const AttachRequestFrameSchema = z.object({
  t: z.literal('attach_request'),
  requestId: IdSchema,
  user: UserSchema,
  via: z.enum(['code', 'qr']),
  client: ClientInfoSchema.nullable(),
  expiresAt: EpochMsSchema,
});

export const RosterFrameSchema = z.object({
  t: z.literal('roster'),
  attachments: z.array(AttachmentViewSchema),
});

export const PairingFrameSchema = PairingSchema.extend({ t: z.literal('pairing') });

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
  'result',
  'ping',
  'pong',
] as const;

export const RELAY_FRAME_TYPES = [
  'welcome',
  'attach_request',
  'roster',
  'pairing',
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

function parseWith<F>(
  schema: z.ZodType<F>,
  known: readonly string[],
  text: string,
): ParsedFrame<F> {
  let value: unknown;
  try {
    value = JSON.parse(text);
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

export function encodeFrame(frame: PageFrameInput | RelayFrame): string {
  return JSON.stringify(frame);
}

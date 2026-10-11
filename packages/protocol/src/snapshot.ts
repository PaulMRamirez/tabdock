// The restart snapshot (ADR 0046): what a relay with TABDOCK_RESTART_SNAPSHOT
// on writes into its audit directory at a graceful stop and reads once at the
// next start, and only when the audit log's last two records bind it to the
// stop that wrote it (the relay's snapshot.ts). It carries the relay's store
// as Wave 2 left it: page sessions with their ceiling and any time-boxed
// session, attachments, live invites and live agent tokens. Every object is
// strict, so a field no record lists cannot ride in on a planted or edited
// file, and the policy in force is not stored at all: the relay works it out
// again from the ceiling and the session, so a session can only narrow.
//
// Secrets stay out. A page's resume token, an invite's secret, an agent's
// token and a revoked invitee's email are held as their SHA-256 digests
// only, as the store keeps them; never a pairing code, a QR nonce, a pending
// request or a published state value, none of which the store holds past a
// restart anyway. What it does hold that a person could read (page titles
// and addresses, invite and agent labels, display names, an invitee's email
// as its display name) sits at mode 0600 beside an audit log that names the
// same people, for the few minutes ADR 0046 allows.

// First, before zod builds anything: no eval probe on Trusted Types pages.
import './zod-config.ts';
import * as z from 'zod/mini';
import { RelayModeSchema } from './audit.ts';
import {
  AGENT_BURN_TIMEOUTS,
  INVITE_BURN_REFUSALS,
  MAX_AGENT_LIFETIME_MS,
  MAX_DISPLAY_NAME_CHARS,
  MAX_INVITE_USES,
  MAX_LIVE_AGENTS_PER_PAGE,
  MAX_LIVE_INVITES_PER_PAGE,
  MAX_ROSTER_CLIENTS_PER_INVITEE,
  SNAPSHOT_VERSION,
} from './constants.ts';
import {
  AgentStateSchema,
  ClientInfoSchema,
  controlForOneUse,
  EpochMsSchema,
  IdSchema,
  InviteeIdSchema,
  InviteLabelSchema,
  kindMatchesId,
  PolicySchema,
  RoleSchema,
  SessionEndReasonSchema,
  SessionLengthSchema,
  SessionPolicySchema,
  UserKindSchema,
} from './page-link.ts';
import { withinCeiling } from './sessions.ts';

/**
 * The largest snapshot a relay writes or reads. It bounds every list in the
 * file at once, and with it what a start parses before it listens. A hosted
 * relay at its defaults, 100 page sessions each with 10 people of 20
 * clients, 40 watchers, 10 live invites and 10 agent tokens, every name at
 * its longest, needs about 12.1 MB, since an invitee keeps only the clients
 * its roster row shows (restart-snapshot.test.ts measures it). A stop whose
 * snapshot would be larger writes none, and logs that as an error.
 */
export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

/** Clients an attachment keeps, newest first, as the relay's roster caps them. */
const MAX_SNAPSHOT_CLIENTS = 20;

/** SHA-256, as 64 lower-case hex characters: every digest the snapshot holds. */
const DigestSchema = z.string().check(z.regex(/^[0-9a-f]{64}$/));

const StrictClientSchema = z.strictObject(ClientInfoSchema.shape);

/** A member as an invite or token names its sponsor. */
const SponsorSchema = z.strictObject({
  userId: IdSchema,
  displayName: z.string().check(z.minLength(1), z.maxLength(MAX_DISPLAY_NAME_CHARS)),
});

/** A time-boxed session as the relay keeps it (ADR 0043), on the relay's clock. */
const SnapshotSessionSchema = z
  .strictObject({
    sessionId: IdSchema,
    startedAt: EpochMsSchema,
    endsAt: EpochMsSchema,
    lengthMs: SessionLengthSchema,
    policy: SessionPolicySchema,
  })
  .check(
    z.refine((session) => session.endsAt === session.startedAt + session.lengthMs, {
      message: 'a session ends its length after it started',
    }),
  );

/**
 * A page session the relay held at its stop, asleep or awake; one already
 * gone is left out. `ceiling` is the hello's policy, and `sessionEnded` a
 * session that ended while the page slept, which its next welcome tells it.
 */
const SnapshotPageSchema = z
  .strictObject({
    pageId: IdSchema,
    origin: z.string().check(z.minLength(1), z.maxLength(2048)),
    title: z.string().check(z.maxLength(300)),
    url: z.string().check(z.maxLength(2048)),
    adapterVersion: z.string().check(z.maxLength(50)),
    connectedAt: EpochMsSchema,
    ceiling: z.strictObject(PolicySchema.shape),
    timedSession: z.nullable(SnapshotSessionSchema),
    sessionEnded: z.nullable(
      z.strictObject({ sessionId: IdSchema, reason: SessionEndReasonSchema }),
    ),
    resumeTokenHash: DigestSchema,
  })
  .check(
    z.refine((page) => page.timedSession === null || page.sessionEnded === null, {
      message: 'a page with a live session has no ended one to tell',
    }),
    z.refine(
      (page) => page.timedSession === null || withinCeiling(page.ceiling, page.timedSession.policy),
      { message: 'a session never sets more than the page allows' },
    ),
  );

/**
 * An attachment with every field the store keeps (store.ts, AttachmentRecord)
 * and, for a member, `memberKey`: a digest of the subject the member list gave
 * its user id at the stop, or null where the relay keeps no list, so a start
 * whose list gives the id to someone else, or to no one, restores none of it
 * (S8, S13). The subject itself is never written.
 */
const SnapshotAttachmentSchema = z
  .strictObject({
    pageId: IdSchema,
    userId: IdSchema,
    displayName: z.string().check(z.minLength(1), z.maxLength(MAX_DISPLAY_NAME_CHARS)),
    kind: UserKindSchema,
    role: RoleSchema,
    grantedAt: EpochMsSchema,
    lastUsedAt: z.nullable(EpochMsSchema),
    expiresAt: z.nullable(EpochMsSchema),
    clients: z.array(StrictClientSchema).check(z.maxLength(MAX_SNAPSHOT_CLIENTS)),
    inviteId: z.nullable(IdSchema),
    endsAt: z.nullable(EpochMsSchema),
    inviteRole: z.nullable(RoleSchema),
    sponsorId: z.nullable(IdSchema),
    emailHash: z.nullable(DigestSchema),
    memberKey: z.nullable(DigestSchema),
  })
  .check(
    z.refine((attachment) => kindMatchesId(attachment.kind, attachment.userId), {
      message: "an invitee's id is g_ and its account key, and only an invitee's is",
    }),
    z.refine((attachment) => attachment.kind === 'member' || attachment.memberKey === null, {
      message: 'only a member has a member key',
    }),
    // What an invite made keeps what its rules need; nothing else has any of it (store.ts).
    z.refine(
      (attachment) =>
        attachment.inviteId === null
          ? attachment.endsAt === null &&
            attachment.inviteRole === null &&
            attachment.sponsorId === null &&
            attachment.emailHash === null
          : attachment.endsAt !== null &&
            attachment.inviteRole !== null &&
            attachment.sponsorId !== null,
      { message: 'an invite-made attachment keeps its end, cap and sponsor, and no other has any' },
    ),
    z.refine(
      (attachment) => attachment.inviteRole !== 'observer' || attachment.role === 'observer',
      {
        message: 'a watch invite never made a driver',
      },
    ),
    // All an invitee's roster row ever shows (ADR 0044), and all a stop saves of it.
    z.refine(
      (attachment) =>
        attachment.kind !== 'invitee' ||
        attachment.clients.length <= MAX_ROSTER_CLIENTS_PER_INVITEE,
      { message: 'an invitee keeps only its newest few clients' },
    ),
  );

/** A live invite with every field the store keeps but the redemption waiting on it, which a restart ends. */
const SnapshotInviteSchema = z
  .strictObject({
    inviteId: IdSchema,
    pageId: IdSchema,
    role: RoleSchema,
    label: InviteLabelSchema,
    uses: z.number().check(z.int(), z.gte(1), z.lte(MAX_INVITE_USES)),
    usesLeft: z.number().check(z.int(), z.gte(0), z.lte(MAX_INVITE_USES)),
    createdAt: EpochMsSchema,
    requestedExpiresAt: z.nullable(EpochMsSchema),
    expiresAt: EpochMsSchema,
    ownExpiresAt: EpochMsSchema,
    secretHash: DigestSchema,
    sponsor: SponsorSchema,
    refusals: z.number().check(z.int(), z.gte(0), z.lte(INVITE_BURN_REFUSALS)),
    barredUserIds: z.array(IdSchema),
    barredEmailHashes: z.array(DigestSchema),
  })
  .check(
    z.refine(controlForOneUse, { message: 'a control invite has exactly one use' }),
    z.refine((invite) => invite.usesLeft <= invite.uses, {
      message: 'an invite cannot have more uses left than it had',
    }),
    z.refine((invite) => invite.expiresAt <= invite.ownExpiresAt, {
      message: "a session only ever brings an invite's end closer",
    }),
  );

/**
 * A live agent token with every field the store keeps but the prompt its
 * request raised, which a restart ends: one asking comes back dormant.
 */
const SnapshotAgentSchema = z
  .strictObject({
    tokenId: IdSchema,
    pageId: IdSchema,
    label: InviteLabelSchema,
    secretHash: DigestSchema,
    createdAt: EpochMsSchema,
    expiresAt: EpochMsSchema,
    requestedExpiresAt: EpochMsSchema,
    sponsor: SponsorSchema,
    state: AgentStateSchema,
    timeouts: z.number().check(z.int(), z.gte(0), z.lte(AGENT_BURN_TIMEOUTS)),
    userId: InviteeIdSchema,
    client: z.nullable(StrictClientSchema),
  })
  .check(
    z.refine((agent) => agent.expiresAt <= agent.createdAt + MAX_AGENT_LIFETIME_MS, {
      message: 'an agent token lives at most MAX_AGENT_LIFETIME_MS',
    }),
  );

export type SnapshotPage = z.infer<typeof SnapshotPageSchema>;
export type SnapshotAttachment = z.infer<typeof SnapshotAttachmentSchema>;
export type SnapshotInvite = z.infer<typeof SnapshotInviteSchema>;
export type SnapshotAgent = z.infer<typeof SnapshotAgentSchema>;

interface SnapshotBody {
  pages: readonly SnapshotPage[];
  attachments: readonly SnapshotAttachment[];
  invites: readonly SnapshotInvite[];
  agents: readonly SnapshotAgent[];
}

/** The first problem with what refers to what, or null: the store never holds any of these. */
function referenceProblem(snapshot: SnapshotBody): string | null {
  const pages = new Set<string>();
  const resumeHashes = new Set<string>();
  for (const page of snapshot.pages) {
    if (pages.has(page.pageId)) return 'a page is listed twice';
    if (resumeHashes.has(page.resumeTokenHash)) return 'two pages share a resume token';
    pages.add(page.pageId);
    resumeHashes.add(page.resumeTokenHash);
  }
  const attached = new Map<string, SnapshotAttachment>();
  for (const attachment of snapshot.attachments) {
    if (!pages.has(attachment.pageId)) return 'an attachment names a page the snapshot lacks';
    const key = `${attachment.pageId} ${attachment.userId}`;
    if (attached.has(key)) return 'an attachment is listed twice';
    attached.set(key, attachment);
  }
  // Whatever a sponsor's end takes ends with it (S14), so a sponsor is always
  // a member attached to the same page while anything it sponsors is live.
  const sponsored = (pageId: string, userId: string): boolean =>
    attached.get(`${pageId} ${userId}`)?.kind === 'member';
  for (const attachment of snapshot.attachments) {
    if (attachment.sponsorId !== null && !sponsored(attachment.pageId, attachment.sponsorId)) {
      return 'an invite-made attachment outlived its sponsor';
    }
  }
  // Invites and tokens are found by the digest of what they were minted with, relay-wide.
  const secrets = new Set<string>();
  const perPage = new Map<string, number>();
  const invites = new Set<string>();
  for (const invite of snapshot.invites) {
    if (!pages.has(invite.pageId)) return 'an invite names a page the snapshot lacks';
    const key = `${invite.pageId} ${invite.inviteId}`;
    if (invites.has(key)) return 'an invite is listed twice';
    if (secrets.has(invite.secretHash)) return 'two invites or tokens share a secret';
    if (!sponsored(invite.pageId, invite.sponsor.userId)) return 'an invite outlived its sponsor';
    invites.add(key);
    secrets.add(invite.secretHash);
    const count = (perPage.get(invite.pageId) ?? 0) + 1;
    if (count > MAX_LIVE_INVITES_PER_PAGE) return 'a page holds more live invites than allowed';
    perPage.set(invite.pageId, count);
  }
  perPage.clear();
  const tokens = new Set<string>();
  const agentUsers = new Set<string>();
  for (const agent of snapshot.agents) {
    if (!pages.has(agent.pageId)) return 'an agent token names a page the snapshot lacks';
    if (tokens.has(agent.tokenId)) return 'an agent token is listed twice';
    if (agentUsers.has(agent.userId)) return 'two agent tokens share a user';
    if (secrets.has(agent.secretHash)) return 'two invites or tokens share a secret';
    if (!sponsored(agent.pageId, agent.sponsor.userId))
      return 'an agent token outlived its sponsor';
    tokens.add(agent.tokenId);
    agentUsers.add(agent.userId);
    secrets.add(agent.secretHash);
    const count = (perPage.get(agent.pageId) ?? 0) + 1;
    if (count > MAX_LIVE_AGENTS_PER_PAGE) return 'a page holds more live agent tokens than allowed';
    perPage.set(agent.pageId, count);
    // An attached token's access is its attachment, made by the token itself (ADR 0044).
    const attachment = attached.get(`${agent.pageId} ${agent.userId}`);
    if ((agent.state === 'attached') !== (attachment?.inviteId === agent.tokenId)) {
      return "an agent token's state does not match its attachment";
    }
  }
  return null;
}

/**
 * The whole file: its version, when the stopping relay wrote it, which mode
 * that relay ran in (a user id means one person only within one mode's
 * accounts), and its records.
 */
export const RelaySnapshotSchema = z
  .strictObject({
    v: z.literal(SNAPSHOT_VERSION),
    writtenAt: EpochMsSchema,
    mode: RelayModeSchema,
    pages: z.array(SnapshotPageSchema),
    attachments: z.array(SnapshotAttachmentSchema),
    invites: z.array(SnapshotInviteSchema),
    agents: z.array(SnapshotAgentSchema),
  })
  .check(
    z.superRefine((snapshot, context) => {
      const problem = referenceProblem(snapshot);
      if (problem !== null) context.addIssue({ code: 'custom', message: problem, input: snapshot });
    }),
  );
export type RelaySnapshot = z.infer<typeof RelaySnapshotSchema>;

/** What a snapshot_written record counts: page sessions, attachments, live invites and time-boxed sessions. */
export function snapshotCounts(snapshot: RelaySnapshot): {
  pages: number;
  attachments: number;
  invites: number;
  sessions: number;
} {
  return {
    pages: snapshot.pages.length,
    attachments: snapshot.attachments.length,
    invites: snapshot.invites.length,
    sessions: snapshot.pages.filter((page) => page.timedSession !== null).length,
  };
}

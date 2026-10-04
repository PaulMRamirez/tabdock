// What the adapter keeps in the tab's storage beside its resume token, under
// ADR 0011's per-page keys. Other code on the page shares that storage, so
// these are read back as carefully as a frame: anything malformed reads as
// nothing. They live here because the adapter builds every check from the
// protocol's own schemas.

// First, before zod builds anything: no eval probe on Trusted Types pages.
import './zod-config.ts';
import { z } from 'zod';
import { INVITE_BURN_REFUSALS, MAX_INVITE_USES, MAX_LIVE_INVITES_PER_PAGE } from './constants.ts';
import {
  controlForOneUse,
  EpochMsSchema,
  IdSchema,
  InviteLabelSchema,
  InviteSecretHashSchema,
  RoleSchema,
} from './page-link.ts';

/**
 * The operator's grant to one user (ADR 0017): the role, and for an attachment
 * an invite made, that invite and the moment it ends. An adapter before M4
 * stored the bare role, which still reads, as a grant with neither.
 */
export const StoredGrantSchema = z.union([
  z.strictObject({
    role: RoleSchema,
    inviteId: IdSchema.optional(),
    endsAt: EpochMsSchema.optional(),
  }),
  RoleSchema.transform((role) => ({ role })),
]);
export type StoredGrant = z.infer<typeof StoredGrantSchema>;

/**
 * The adapter's own record of one invite it minted (ADR 0017): its id, the
 * hash of its secret, its terms, its refusals and the accounts revoked from
 * it. Never the secret: a strict object, so a record holding one is no record.
 */
export const StoredInviteSchema = z
  .strictObject({
    inviteId: IdSchema,
    secretHash: InviteSecretHashSchema,
    role: RoleSchema,
    label: InviteLabelSchema,
    uses: z.number().int().min(1).max(MAX_INVITE_USES),
    usesLeft: z.number().int().min(0).max(MAX_INVITE_USES),
    createdAt: EpochMsSchema,
    /** As the operator chose; null is "while the page is open", which still ends after 24 hours. */
    expiresAt: EpochMsSchema.nullable(),
    refusals: z.number().int().min(0).max(INVITE_BURN_REFUSALS),
    /** User ids revoked from this invite; no redemption by them is honoured again. */
    barred: z.array(IdSchema).max(MAX_INVITE_USES),
  })
  .refine(controlForOneUse, { message: 'a control invite has exactly one use' })
  .refine((invite) => invite.usesLeft <= invite.uses, {
    message: 'an invite cannot have more uses left than it had',
  });
export type StoredInvite = z.infer<typeof StoredInviteSchema>;

/** Every invite record of one page session, dropped with its grants when a session does not resume. */
export const StoredInvitesSchema = z.strictObject({
  pageId: IdSchema,
  invites: z.array(StoredInviteSchema).max(MAX_LIVE_INVITES_PER_PAGE),
});
export type StoredInvites = z.infer<typeof StoredInvitesSchema>;

// What the adapter keeps in the tab's storage beside its resume token, under
// ADR 0011's per-page keys. Other code on the page shares that storage, so
// these are read back as carefully as a frame: anything malformed reads as
// nothing. They live here because the adapter builds every check from the
// protocol's own schemas.

// First, before zod builds anything: no eval probe on Trusted Types pages.
import './zod-config.ts';
import * as z from 'zod/mini';
import { INVITE_BURN_REFUSALS, MAX_INVITE_USES, MAX_LIVE_INVITES_PER_PAGE } from './constants.ts';
import {
  controlForOneUse,
  EpochMsSchema,
  IdSchema,
  InviteLabelSchema,
  InviteSecretHashSchema,
  type Role,
  RoleSchema,
} from './page-link.ts';

/**
 * The operator's grant to one user (ADR 0017): the role, and for an attachment
 * an invite made, that invite, the moment it ends and the invite's own role,
 * the cap no role switch may pass. The cap stays here because the invite's
 * record does not: a control invite is spent on approval and a watch invite
 * may be cancelled or run out while its guests stay, yet the operator may
 * still promote a control guest who joined as observer, and never a watch
 * guest. The three come together or not at all, and the role never passes
 * the cap. An adapter before M4 stored the bare role, which still reads, as
 * a grant with none of them.
 */
export const StoredGrantSchema = z.union([
  z
    .strictObject({
      role: RoleSchema,
      inviteId: z.optional(IdSchema),
      endsAt: z.optional(EpochMsSchema),
      inviteRole: z.optional(RoleSchema),
    })
    .check(
      z.refine(
        (grant) =>
          (grant.inviteId === undefined) === (grant.endsAt === undefined) &&
          (grant.inviteId === undefined) === (grant.inviteRole === undefined),
        {
          message: 'an invite-made grant names its invite, its end and its cap, and no other does',
        },
      ),
      z.refine((grant) => grant.inviteRole !== 'observer' || grant.role === 'observer', {
        message: "a grant never passes its invite's role",
      }),
    ),
  z.pipe(
    RoleSchema,
    z.transform((role: Role) => ({ role })),
  ),
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
    uses: z.number().check(z.int(), z.gte(1), z.lte(MAX_INVITE_USES)),
    usesLeft: z.number().check(z.int(), z.gte(0), z.lte(MAX_INVITE_USES)),
    createdAt: EpochMsSchema,
    /** As the operator chose; null is "while the page is open", which still ends after 24 hours. */
    expiresAt: z.nullable(EpochMsSchema),
    refusals: z.number().check(z.int(), z.gte(0), z.lte(INVITE_BURN_REFUSALS)),
    /** User ids revoked from this invite; no redemption by them is honoured again. */
    barred: z.array(IdSchema).check(z.maxLength(MAX_INVITE_USES)),
  })
  .check(
    z.refine(controlForOneUse, { message: 'a control invite has exactly one use' }),
    z.refine((invite) => invite.usesLeft <= invite.uses, {
      message: 'an invite cannot have more uses left than it had',
    }),
  );
export type StoredInvite = z.infer<typeof StoredInviteSchema>;

/** Every invite record of one page session, dropped with its grants when a session does not resume. */
export const StoredInvitesSchema = z.strictObject({
  pageId: IdSchema,
  invites: z.array(StoredInviteSchema).check(z.maxLength(MAX_LIVE_INVITES_PER_PAGE)),
});
export type StoredInvites = z.infer<typeof StoredInvitesSchema>;

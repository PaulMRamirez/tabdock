// The relay's members (ADRs 0014 and 0043): one entry per account on the
// owner's allowlist, from TABDOCK_OAUTH_USERS or a members file. The relay
// reads both through these schemas, so a file and the setting accept exactly
// the same entries.

// First, before zod builds anything: no eval probe on Trusted Types pages.
import './zod-config.ts';
import * as z from 'zod/mini';
import { INVITEE_ID_PREFIX, MAX_DISPLAY_NAME_CHARS } from './constants.ts';
import { IdSchema } from './page-link.ts';

/** OIDC limits `sub` to 255 ASCII characters; spaces and controls never belong in one. */
export const MemberSubSchema = z.string().check(z.regex(/^[\x21-\x7e]{1,255}$/));

/**
 * One member: the provider's subject, the relay's user id for it and the
 * name the widget shows. Strict, so an entry holding anything else is no
 * entry. A member's id never starts as an invitee's does (ADR 0017), so no
 * member can pass for an invitee or an agent, nor one for a member.
 */
export const MemberEntrySchema = z.strictObject({
  sub: MemberSubSchema,
  userId: IdSchema.check(
    z.refine((id) => !id.startsWith(INVITEE_ID_PREFIX), {
      message: "a member's user id never starts g_, which only an invitee's may",
    }),
  ),
  displayName: z.string().check(z.minLength(1), z.maxLength(MAX_DISPLAY_NAME_CHARS)),
});
export type MemberEntry = z.infer<typeof MemberEntrySchema>;

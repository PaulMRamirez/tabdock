// Invite links and pair_page's input (ADR 0017). A link is `<public URL>/i#<secret>`:
// the secret rides only in the fragment, which browsers never send, so it stays
// out of every request line and log. The relay reads a link pasted into
// pair_page with inviteSecretOf; the adapter builds one with inviteLink.

// First, before zod builds anything: no eval probe on Trusted Types pages.
import './zod-config.ts';
import * as z from 'zod/mini';
import { MAX_CODE_INPUT_CHARS, MAX_INVITE_INPUT_CHARS } from './constants.ts';
import { InviteSecretSchema, isInviteLinkBase } from './page-link.ts';

/** The link an invite's QR code and text show, once: the link base and the secret as its fragment. */
export function inviteLink(linkBase: string, secret: string): string {
  if (!isInviteLinkBase(linkBase)) throw new TypeError('not an invite link base');
  if (!InviteSecretSchema.safeParse(secret).success) throw new TypeError('not an invite secret');
  return `${linkBase}#${secret}`;
}

/**
 * The secret in what someone pasted into pair_page: a bare secret, or a whole
 * link whose path is the invite path and whose fragment is the secret. With
 * linkBase given, a link must start with exactly it, so a link minted at
 * another relay is no link here. null for anything else, without saying why:
 * the input may be a secret meant for someone else.
 */
export function inviteSecretOf(input: string, linkBase?: string | null): string | null {
  if (input.length > MAX_INVITE_INPUT_CHARS) return null;
  const text = input.trim();
  if (InviteSecretSchema.safeParse(text).success) return text;
  const split = text.indexOf('#');
  if (split === -1) return null;
  const base = text.slice(0, split);
  const secret = text.slice(split + 1);
  if (!isInviteLinkBase(base) || !InviteSecretSchema.safeParse(secret).success) return null;
  if (linkBase !== undefined && linkBase !== null && base !== linkBase) return null;
  return secret;
}

/**
 * pair_page's input from M4: exactly one of a pairing code or an invite (a
 * link minted for one use, or its secret). Only the shape is checked here;
 * the relay decides what a code or an invite is worth.
 */
export const PairPageInputSchema = z
  .object({
    code: z.optional(z.string().check(z.minLength(1), z.maxLength(MAX_CODE_INPUT_CHARS))),
    invite: z.optional(z.string().check(z.minLength(1), z.maxLength(MAX_INVITE_INPUT_CHARS))),
  })
  .check(
    z.refine((input) => (input.code === undefined) !== (input.invite === undefined), {
      message: 'give exactly one of code and invite',
    }),
  );
export type PairPageInput = z.infer<typeof PairPageInputSchema>;

// Auth is a plugin (SPEC section 7, ADR 0013). authenticate(request) gives a
// user with its account, member or invitee and any verified email (ADRs 0017
// and 0020), or a refusal that carries its own HTTP status and challenge: 401 with
// WWW-Authenticate asks the client to sign in, 403 turns away someone signed in
// who is not allowed, 503 says the plugin cannot check anyone just now. Claude
// starts sign-in only on a 401 whose challenge names the metadata document, so
// the plugin, not the relay, has to write the challenge. A plugin may also serve
// GET routes, such as that metadata document, and may need to start before the
// relay listens. dev-token lives here, and local mode's owner token (ADR 0022)
// is a dev-token plugin with one user and the loopbackOnly mark; the OAuth
// plugin is in oauth.ts.

import type { IncomingMessage } from 'node:http';
import {
  EmailSchema,
  IdSchema,
  InviteeIdSchema,
  OAuthClientIdSchema,
  type User,
  type UserKind,
  UserKindSchema,
  UserSchema,
} from '@tabdock/protocol';
import { z } from 'zod';
import { digest, sameDigest } from './secrets.ts';

export interface AuthRefusal {
  kind: 'refused';
  status: 401 | 403 | 503;
  /**
   * Why, for the relay's log line: a fixed phrase written by the plugin, never
   * a credential and never text the caller sent.
   */
  reason: string;
  /** The response body: short and safe to show anyone. */
  body: string;
  /** Response headers, WWW-Authenticate above all; Content-Type defaults to plain text. */
  headers: Record<string, string>;
}

/**
 * The account behind an authenticated user (ADRs 0017 and 0020): a member of
 * the owner's allowlist or an invitee, and the email address the identity
 * provider verified for it, or null when it vouched for none, or when the
 * plugin has no provider at all, as dev-token has not. An address the
 * provider did not verify is never kept.
 */
export interface UserAccount {
  kind: UserKind;
  email: string | null;
}

/** A user as a plugin vouches for one: who they are and what kind of account. */
export interface AuthUser extends User {
  account: UserAccount;
}

/** Every member a plugin without a provider knows; frozen, so no caller can turn it into an invitee. */
export const MEMBER_ACCOUNT: Readonly<UserAccount> = Object.freeze({
  kind: 'member',
  email: null,
});

export type AuthOutcome =
  | {
      kind: 'user';
      user: AuthUser;
      /**
       * The access token's client_id (RFC 9068), which the audit log's attach
       * records name (ADR 0019); null for a credential with none, such as a
       * dev token.
       */
      oauthClientId: string | null;
    }
  | AuthRefusal;

/** A GET route a plugin serves, in web-standard form, like the SDK's metadata helpers. */
export type AuthRoute = (request: Request) => Response | Promise<Response>;

/**
 * Who a signed-in account is to this relay (ADR 0016). A member is on the
 * owner's allowlist and has a user. Anyone else who signs in at the provider
 * is an invitee: refused everywhere until M4 lets invites in, and known only
 * by an opaque key (a digest of the provider's subject), never by the subject.
 */
export type Account = { kind: 'member'; user: User } | { kind: 'invitee'; key: string };

/** The provider endpoints a browser sign-in needs, as the plugin's start() checked them. */
export interface ProviderEndpoints {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  response_types_supported: string[];
  token_endpoint_auth_methods_supported?: string[] | undefined;
}

/**
 * What a plugin backed by an identity provider offers the QR page at /pair,
 * which signs a phone's browser in at the same provider (ADR 0013): where the
 * provider is, and the one account mapping the plugin itself uses, so a person
 * is the same user on /mcp and at /pair.
 */
export interface BrowserSignIn {
  /** null until start() has read the provider's metadata. */
  provider(): ProviderEndpoints | null;
  accountOf(sub: string): Account;
}

export interface AuthPlugin {
  readonly name: string;
  /**
   * The public MCP URL whose tokens this plugin accepts, for a plugin that
   * checks tokens from an identity provider. Public URL mode requires it to
   * equal the relay's own, so a plugin without one, like dev-token, can never
   * answer for a public URL (ADR 0014).
   */
  readonly resource?: string | undefined;
  /**
   * Runs once before the relay listens. A plugin that cannot work, such as one
   * whose identity provider is misconfigured, throws here and the relay does
   * not start.
   */
  start?(): Promise<void>;
  authenticate(request: IncomingMessage): Promise<AuthOutcome>;
  /** GET (and HEAD) routes by exact path. */
  readonly routes?: ReadonlyMap<string, AuthRoute> | undefined;
  /** Present on a plugin that signs people in at a provider; public URL mode needs it for /pair. */
  readonly browserSignIn?: BrowserSignIn | undefined;
  /**
   * Set on a plugin whose credential is good only on this machine, as local
   * mode's owner token is (ADR 0022). resolveConfig refuses a plugin so
   * marked, whatever its name, with a public URL, in production or off
   * loopback, so no later mode or rename can carry it further.
   */
  readonly loopbackOnly?: boolean | undefined;
}

/** Header names as HTTP tokens, values without control characters, so node never throws on them. */
const HeaderNameSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const HeaderValueSchema = z.string().regex(/^[\x20-\x7e]{0,2000}$/);

/**
 * An invitee's user id is always `g_` and its account key, and a member's
 * never is (ADR 0017), so no member can pass for an invitee or the reverse.
 */
const AuthUserSchema = UserSchema.extend({
  account: z.object({ kind: UserKindSchema, email: EmailSchema.nullable() }),
}).refine(
  (user) => (user.account.kind === 'invitee') === InviteeIdSchema.safeParse(user.userId).success,
  { message: "an invitee's user id is g_ and its account key, and only an invitee's is" },
);

/**
 * The relay checks what a plugin returns before acting on it, as it checks
 * every other boundary: a malformed outcome is refused, never half-trusted.
 */
export const AuthOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    user: AuthUserSchema,
    oauthClientId: OAuthClientIdSchema.nullable(),
  }),
  z.object({
    kind: z.literal('refused'),
    status: z.union([z.literal(401), z.literal(403), z.literal(503)]),
    reason: z.string().min(1).max(200),
    body: z.string().max(2000),
    headers: z.record(HeaderNameSchema, HeaderValueSchema),
  }),
]);

export interface DevTokenUser {
  userId: string;
  displayName: string;
  token: string;
}

/** Shorter tokens are guessable enough to matter even on a loopback relay. */
export const MIN_DEV_TOKEN_LENGTH = 24;

const MAX_AUTHORIZATION_LENGTH = 4096;
const BEARER = /^Bearer +([\x21-\x7e]+) *$/i;
const TOKEN_CHARS = /^[\x21-\x7e]+$/;

/** The dev-token answer to anyone without a valid token, the same since M1. */
const DEV_TOKEN_REFUSAL: AuthRefusal = {
  kind: 'refused',
  status: 401,
  reason: 'no valid dev token',
  body: 'Unauthorized',
  headers: { 'WWW-Authenticate': 'Bearer realm="tabdock"' },
};

export interface DevTokenOptions {
  /** Marks the plugin as local mode's (ADR 0022): it then never serves beyond loopback. */
  loopbackOnly?: boolean | undefined;
}

/**
 * Error messages name the user, never the token, because they end up on a
 * terminal and in CI logs. Only each token's digest is kept.
 */
export function createDevTokenAuth(
  users: readonly DevTokenUser[],
  options: DevTokenOptions = {},
): AuthPlugin {
  if (users.length === 0) throw new Error('dev-token auth needs at least one user');
  const seenUsers = new Set<string>();
  const entries = users.map((entry) => {
    const user = UserSchema.safeParse({ userId: entry.userId, displayName: entry.displayName });
    if (!user.success) {
      throw new Error(
        `dev-token user ids must be 1 to 64 letters, digits, '_' or '-', with a display name of 1 to 100 characters`,
      );
    }
    if (seenUsers.has(user.data.userId)) {
      throw new Error(`dev-token user ${user.data.userId} is listed twice`);
    }
    seenUsers.add(user.data.userId);
    if (entry.token.length < MIN_DEV_TOKEN_LENGTH) {
      throw new Error(
        `the dev token for ${user.data.userId} is shorter than ${String(MIN_DEV_TOKEN_LENGTH)} characters`,
      );
    }
    if (!TOKEN_CHARS.test(entry.token)) {
      throw new Error(
        `the dev token for ${user.data.userId} must be printable ASCII without spaces`,
      );
    }
    return { user: user.data, digest: digest(entry.token) };
  });
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i];
      const b = entries[j];
      if (a && b && sameDigest(a.digest, b.digest)) {
        throw new Error(`dev-token users ${a.user.userId} and ${b.user.userId} share a token`);
      }
    }
  }

  return {
    name: 'dev-token',
    ...(options.loopbackOnly === true ? { loopbackOnly: true } : {}),
    authenticate(request) {
      const presented = bearerToken(request.headers.authorization);
      if (presented === null) return Promise.resolve(DEV_TOKEN_REFUSAL);
      // Hashing both sides gives equal-length buffers for timingSafeEqual, and
      // every entry is compared so the time taken does not say which user matched.
      const candidate = digest(presented);
      let match: User | null = null;
      for (const entry of entries) {
        if (sameDigest(candidate, entry.digest) && match === null) match = entry.user;
      }
      return Promise.resolve(
        match === null
          ? DEV_TOKEN_REFUSAL
          : {
              kind: 'user',
              user: { ...match, account: { ...MEMBER_ACCOUNT } },
              oauthClientId: null,
            },
      );
    },
  };
}

function bearerToken(header: string | undefined): string | null {
  if (header === undefined || header.length > MAX_AUTHORIZATION_LENGTH) return null;
  const match = BEARER.exec(header);
  return match?.[1] ?? null;
}

/**
 * Parses TABDOCK_DEV_TOKENS, shaped `alice=<token>,bob=<token>`. The display
 * name is the user id. Only the first '=' splits, so base64 padding survives.
 */
export function parseDevTokens(envValue: string): DevTokenUser[] {
  const users: DevTokenUser[] = [];
  const parts = envValue
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  parts.forEach((part, index) => {
    const split = part.indexOf('=');
    const userId = split > 0 ? part.slice(0, split).trim() : '';
    const token = split > 0 ? part.slice(split + 1).trim() : '';
    if (userId.length === 0 || token.length === 0) {
      throw new Error(
        `TABDOCK_DEV_TOKENS entry ${String(index + 1)} is not of the form user=token`,
      );
    }
    if (!IdSchema.safeParse(userId).success) {
      throw new Error(
        `TABDOCK_DEV_TOKENS entry ${String(index + 1)} has a user id that is not 1 to 64 letters, digits, '_' or '-'`,
      );
    }
    users.push({ userId, displayName: userId, token });
  });
  if (users.length === 0) throw new Error('TABDOCK_DEV_TOKENS lists no users');
  return users;
}

// The oauth auth plugin (ADR 0013): the relay is a resource server only. An
// identity provider registers Claude, signs people in and issues access tokens
// whose audience is the relay's public MCP URL; this plugin checks them. At
// start it reads the provider's metadata the way Claude does (RFC 8414, then
// OpenID Connect discovery) and refuses to run with a provider Claude could not
// use. It serves RFC 9728 protected resource metadata through the SDK's helper,
// and checks each token with the SDK's verifyBearerToken over a jose verifier:
// RS256 only, the provider's published keys, issuer, audience and expiry, and
// from M4 (ADR 0020) an iat and a jti, an age and a lifetime within the cap,
// and, when the owner lists them, one of the OAuth clients allowed. Any bad
// token becomes the SDK's 401 challenge with resource_metadata, which is the
// only answer that makes Claude sign in. A good token's `sub` maps to a member
// or an invitee; the plugin says which and the relay decides whether to admit
// an invitee, answering a plain 403, which Claude treats as final, whenever it
// does not (ADR 0020's notes). An invitee is named by the email two namespaced
// claims vouch for, or as unverified. Keys that cannot be fetched are the
// provider's fault, not the token's: a 503 with Retry-After, no new fetch until
// then, and meanwhile the last key set fetched, while it is young, still checks
// tokens. The provider's metadata is read again hourly, and a new issuer or key
// URL is refused and logged, never adopted. The same mapping, which says what
// kind of account a subject is and what it is called (ADRs 0016 and 0017),
// serves the browser sign-in at /pair and /i, so a person is one user on all
// of them.

import type { IncomingMessage } from 'node:http';
import {
  type AuthInfo,
  bearerAuthChallengeResponse,
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  type OAuthMetadata,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
  oauthMetadataResponse,
  verifyBearerToken,
} from '@modelcontextprotocol/server';
import {
  EmailSchema,
  IdSchema,
  OAuthClientIdSchema,
  type User,
  type UserKind,
  UserSchema,
} from '@tabdock/protocol';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  errors,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from 'jose';
import { z } from 'zod';
import {
  type Account,
  type AuthOutcome,
  type AuthPlugin,
  type AuthRefusal,
  type AuthRoute,
  type AuthUser,
  inviteeUser,
  isInviteePrefixed,
  MEMBER_ACCOUNT,
  type ProviderEndpoints,
} from './auth.ts';
import type { Logger } from './log.ts';
import { digestHex } from './secrets.ts';

export interface OAuthUser {
  /** The provider's subject identifier for this person, the token's `sub`. */
  sub: string;
  userId: string;
  displayName: string;
}

export interface OAuthAuthOptions {
  /** The provider's issuer identifier, exactly as its metadata states it. */
  issuer: string;
  /** The relay's public MCP URL: the resource tokens are issued for, and so their audience. */
  resource: string;
  /**
   * The members, by subject. Anyone else who signs in is an invitee, whom the
   * relay answers with 403 unless it admits invitees (ADR 0020).
   */
  users: readonly OAuthUser[];
  /**
   * The longest a token may live, from its iat to its exp, and the oldest its
   * iat may be, in minutes (TABDOCK_OAUTH_MAX_TOKEN_AGE): DEFAULT_MAX_TOKEN_AGE_MINUTES
   * unless set, never above MAX_TOKEN_AGE_CEILING_MINUTES (ADR 0020).
   */
  maxTokenAgeMinutes?: number | undefined;
  /**
   * The OAuth clients whose tokens the relay accepts, by RFC 9068 client_id
   * (TABDOCK_OAUTH_CLIENT_IDS); any client when absent (ADR 0020). A token
   * from another client, or naming none, gets the sign-in challenge.
   */
  clientIds?: readonly string[] | undefined;
  /**
   * How often the provider's metadata is read again: METADATA_REFRESH_MS
   * unless set. Tests set it, to see a re-read without waiting an hour.
   */
  metadataRefreshMs?: number | undefined;
}

/** ADR 0020: a token lives at most 2 hours unless TABDOCK_OAUTH_MAX_TOKEN_AGE says otherwise. */
export const DEFAULT_MAX_TOKEN_AGE_MINUTES = 120;
/** ADR 0020: the cap may be raised for a provider's real lifetime, never past a day. */
export const MAX_TOKEN_AGE_CEILING_MINUTES = 1440;
/** ADR 0020: jose's key cache and refetch cooldown, pinned at its defaults so an upgrade cannot move them. */
export const JWKS_CACHE_MAX_AGE_MS = 10 * 60_000;
export const JWKS_COOLDOWN_MS = 30_000;
/** ADR 0020: how often the provider's metadata is read again; a new issuer or key URL is refused. */
export const METADATA_REFRESH_MS = 60 * 60_000;
/** ADR 0020: token sessions (sid) remembered, so each first sighting logs its lifetime once. */
export const SEEN_SESSIONS = 1000;
/**
 * ADR 0020's JWT template puts the provider's email for an account, and
 * whether it verified it, under these namespaced keys, which no registered
 * claim uses and no provider reserves.
 */
export const EMAIL_CLAIM = 'urn:tabdock:email';
export const EMAIL_VERIFIED_CLAIM = 'urn:tabdock:email_verified';

/**
 * The two claims as the template renders them: an address of up to 320
 * characters and a boolean. Anything else, a string "true" included, reads
 * as no email at all, so a template typo shows guests as unverified rather
 * than trusting text the provider never vouched for.
 */
const EmailClaimsSchema = z.object({
  [EMAIL_CLAIM]: EmailSchema,
  [EMAIL_VERIFIED_CLAIM]: z.boolean(),
});

/**
 * The email an access token's namespaced claims vouch for, or null when they
 * name none, misstate one, or say the provider has not verified it. Identity
 * stays the subject; this only names an invitee (ADR 0020).
 */
export function verifiedEmailOf(claims: Record<string, unknown>): string | null {
  const parsed = EmailClaimsSchema.safeParse(claims);
  return parsed.success && parsed.data[EMAIL_VERIFIED_CLAIM] ? parsed.data[EMAIL_CLAIM] : null;
}

/** A claim's JSON type, for the first-sighting line, which names types and never values. */
function claimType(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Refuses a token age cap outside 1 to MAX_TOKEN_AGE_CEILING_MINUTES minutes. */
function checkMaxTokenAge(minutes: number | undefined): void {
  if (minutes === undefined) return;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_TOKEN_AGE_CEILING_MINUTES) {
    throw new Error(
      `the OAuth token age cap (TABDOCK_OAUTH_MAX_TOKEN_AGE) must be 1 to ${String(MAX_TOKEN_AGE_CEILING_MINUTES)} minutes (ADR 0020)`,
    );
  }
}

/** Refuses an empty client list, or an entry that is no client_id; never echoes one. */
function checkClientIds(clientIds: readonly string[] | undefined): void {
  if (clientIds === undefined) return;
  if (clientIds.length === 0) {
    throw new Error(
      'the OAuth client list (TABDOCK_OAUTH_CLIENT_IDS) names no client; leave it unset to accept any (ADR 0020)',
    );
  }
  clientIds.forEach((clientId, index) => {
    if (!OAuthClientIdSchema.safeParse(clientId).success || clientId.includes(',')) {
      throw new Error(
        `TABDOCK_OAUTH_CLIENT_IDS entry ${String(index + 1)} is not an OAuth client_id: 1 to 512 printable characters without spaces or commas`,
      );
    }
  });
}

/** Parses TABDOCK_OAUTH_CLIENT_IDS: comma-separated client_id values, such as metadata document URLs. */
export function parseOAuthClientIds(envValue: string): string[] {
  const clientIds = envValue
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  checkClientIds(clientIds);
  return [...new Set(clientIds)];
}

/** Claude gives discovery 10 s too (docs/notes/m3/connector-auth.md). */
export const DISCOVERY_TIMEOUT_MS = 10_000;
/** jose's default; a key fetch slower than this fails the request with 503. */
export const JWKS_TIMEOUT_MS = 5000;
/**
 * After a key set fetch fails, the relay answers 503 for this long without
 * fetching again, and says so in Retry-After. jose remembers no failure, so
 * without it every request bearing an RS256-shaped token, forged or not,
 * would be one more fetch at a provider already in trouble.
 */
export const JWKS_RETRY_MS = 5000;
/** Small: enough for clocks a little apart, never enough to stretch a token's life. */
export const CLOCK_TOLERANCE_SECONDS = 5;
/** Provider tokens are a kilobyte or two; past this, a header is not a token. */
const MAX_AUTHORIZATION_LENGTH = 8192;
/** The one signing algorithm accepted, so a token cannot choose a weaker one or none. */
const ALGORITHMS = ['RS256'];
/** ADR 0020: every token names when it was issued and what it is, so its age and lifetime can be held to the cap. */
const REQUIRED_CLAIMS = ['exp', 'sub', 'iat', 'jti'];
const RESOURCE_NAME = 'Tabdock relay';

/** OIDC limits `sub` to 255 ASCII characters; spaces and controls never belong in one. */
const SubSchema = z.string().regex(/^[\x21-\x7e]{1,255}$/);

/**
 * The fields of the provider's metadata the relay relies on. Loose, so the
 * many other fields a provider publishes pass through unread.
 */
const ProviderMetadataSchema = z.looseObject({
  issuer: z.string().min(1),
  authorization_endpoint: z.string().min(1),
  token_endpoint: z.string().min(1),
  jwks_uri: z.string().min(1),
  response_types_supported: z.array(z.string()),
  registration_endpoint: z.string().min(1).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  client_id_metadata_document_supported: z.boolean().optional(),
  userinfo_endpoint: z.string().min(1).optional(),
});
type ProviderMetadata = z.infer<typeof ProviderMetadataSchema>;

/**
 * Why the provider's metadata could not be used, as one fixed word: the
 * hourly re-read logs this, never the message, which may quote the
 * provider's own text.
 */
type MetadataProblem = 'unreachable' | 'missing' | 'malformed' | 'issuer' | 'unusable';

class ProviderMetadataError extends Error {
  readonly problem: MetadataProblem;

  constructor(problem: MetadataProblem, message: string, options?: ErrorOptions) {
    super(message, options);
    this.problem = problem;
  }
}

/**
 * Plain http is accepted only on this machine, as the SDK's metadata helper
 * accepts it, so a test provider can run without certificates while nothing a
 * network can reach is ever fetched or trusted without TLS.
 */
function secureUrl(value: string): URL | null {
  const url = URL.parse(value);
  if (!url || url.username !== '' || url.password !== '' || url.hash !== '') return null;
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return url;
  }
  return null;
}

/**
 * Where Claude looks for the provider's metadata, in its order: RFC 8414 with
 * the issuer's path inserted, then OpenID Connect discovery, which for an
 * issuer with a path has two forms (MCP authorization, discovery section).
 */
function discoveryUrls(issuer: URL): string[] {
  const path = issuer.pathname.replace(/\/$/, '');
  if (path === '') {
    return [
      `${issuer.origin}/.well-known/oauth-authorization-server`,
      `${issuer.origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
    `${issuer.origin}/.well-known/openid-configuration${path}`,
    `${issuer.origin}${path}/.well-known/openid-configuration`,
  ];
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : '';
  return `${error.message}${cause}`;
}

/** The first metadata document the provider serves, checked against what Claude needs. */
async function discover(issuer: string): Promise<ProviderMetadata> {
  const issuerUrl = new URL(issuer);
  const tried: string[] = [];
  for (const url of discoveryUrls(issuerUrl)) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json' },
        // A redirect here could hand the relay another server's metadata.
        redirect: 'manual',
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ProviderMetadataError(
        'unreachable',
        `oauth: cannot reach the identity provider at ${url} (${errorText(error)})`,
        { cause: error },
      );
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      tried.push(`${url} answered ${String(response.status)}`);
      continue;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ProviderMetadataError(
        'malformed',
        `oauth: the identity provider's metadata at ${url} is not JSON`,
      );
    }
    const parsed = ProviderMetadataSchema.safeParse(body);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
      throw new ProviderMetadataError(
        'malformed',
        `oauth: the identity provider's metadata at ${url} lacks or misstates ${fields.join(', ')}`,
      );
    }
    checkMetadata(parsed.data, issuer, url);
    return parsed.data;
  }
  throw new ProviderMetadataError(
    'missing',
    `oauth: the identity provider publishes no metadata for issuer ${issuer} (${tried.join('; ')})`,
  );
}

/** Refuses a provider Claude could not sign in with, or whose tokens could not be checked. */
function checkMetadata(metadata: ProviderMetadata, issuer: string, url: string): void {
  // RFC 8414 section 3.3 and the MCP authorization spec: the document must name
  // exactly the issuer it was fetched for, or it may be someone else's.
  if (metadata.issuer !== issuer) {
    throw new ProviderMetadataError(
      'issuer',
      `oauth: the metadata at ${url} names issuer ${JSON.stringify(metadata.issuer.slice(0, 200))}, not ${JSON.stringify(issuer)}; set TABDOCK_OAUTH_ISSUER to the provider's issuer exactly`,
    );
  }
  if (!metadata.code_challenge_methods_supported?.includes('S256')) {
    throw new ProviderMetadataError(
      'unusable',
      'oauth: the identity provider does not list S256 in code_challenge_methods_supported, and Claude always signs in with S256 PKCE',
    );
  }
  const metadataDocuments =
    metadata.client_id_metadata_document_supported === true &&
    metadata.token_endpoint_auth_methods_supported?.includes('none') === true;
  if (!metadataDocuments && metadata.registration_endpoint === undefined) {
    throw new ProviderMetadataError(
      'unusable',
      'oauth: the identity provider offers neither client ID metadata documents (client_id_metadata_document_supported with "none" in token_endpoint_auth_methods_supported) nor a registration_endpoint, so Claude cannot register with it; turn one of them on at the provider',
    );
  }
  for (const [field, value] of [
    ['authorization_endpoint', metadata.authorization_endpoint],
    ['token_endpoint', metadata.token_endpoint],
    ['jwks_uri', metadata.jwks_uri],
  ] as const) {
    if (secureUrl(value) === null) {
      throw new ProviderMetadataError(
        'unusable',
        `oauth: the identity provider's ${field} is not an https URL`,
      );
    }
  }
}

/** Thrown by the key lookup when the provider's keys cannot be fetched; a 503, not the token's fault. */
class ProviderUnavailable extends Error {}

/**
 * A fixed phrase per failure, for the challenge's error_description and the
 * relay's log. jose's own messages carry no token text either, but a fixed set
 * keeps it that way whatever a later jose version says.
 */
function tokenProblem(error: unknown): string {
  // jose reports an iat older than maxTokenAge as expired, naming iat.
  if (error instanceof errors.JWTExpired && error.claim === 'iat') {
    return 'Token is older than this relay accepts';
  }
  if (error instanceof errors.JWTExpired) return 'Token has expired';
  if (error instanceof errors.JWTClaimValidationFailed) {
    switch (error.claim) {
      case 'iss':
        return 'Token was not issued by the expected provider';
      case 'aud':
        return 'Token was not issued for this resource';
      case 'exp':
        return 'Token has no valid expiry';
      case 'nbf':
        return 'Token is not valid yet';
      case 'sub':
        return 'Token names no subject';
      case 'iat':
        return error.reason === 'missing'
          ? 'Token says nothing of when it was issued'
          : 'Token was issued in the future';
      case 'jti':
        return 'Token has no token id';
      default:
        return 'Token claims are invalid';
    }
  }
  if (error instanceof errors.JOSEAlgNotAllowed) return 'Token is not signed with RS256';
  if (error instanceof errors.JWSSignatureVerificationFailed) return 'Token signature is invalid';
  if (
    error instanceof errors.JWKSNoMatchingKey ||
    error instanceof errors.JWKSMultipleMatchingKeys
  ) {
    return 'Token was signed with a key the provider does not publish';
  }
  return 'Token is malformed';
}

function scopesOf(claim: unknown): string[] {
  return typeof claim === 'string' ? claim.split(' ').filter((scope) => scope.length > 0) : [];
}

/**
 * Parses TABDOCK_OAUTH_USERS: comma-separated `sub=userId:Display Name`
 * entries, the display name optional (the user id stands in). Only the first
 * '=' and the first ':' after it split, so a display name may hold either;
 * a sub may hold neither ',' nor '=', and a display name no ','.
 */
export function parseOAuthUsers(envValue: string): OAuthUser[] {
  const users: OAuthUser[] = [];
  const parts = envValue
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  parts.forEach((part, index) => {
    const entry = `TABDOCK_OAUTH_USERS entry ${String(index + 1)}`;
    const split = part.indexOf('=');
    const sub = split > 0 ? part.slice(0, split).trim() : '';
    const rest = split > 0 ? part.slice(split + 1) : '';
    const colon = rest.indexOf(':');
    const userId = (colon === -1 ? rest : rest.slice(0, colon)).trim();
    const displayName = colon === -1 ? userId : rest.slice(colon + 1).trim();
    if (sub === '' || userId === '') {
      throw new Error(`${entry} is not of the form sub=userId:Display Name`);
    }
    if (!SubSchema.safeParse(sub).success) {
      throw new Error(`${entry} has a sub that is not 1 to 255 printable characters`);
    }
    if (!IdSchema.safeParse(userId).success) {
      throw new Error(`${entry} has a user id that is not 1 to 64 letters, digits, '_' or '-'`);
    }
    if (isInviteePrefixed(userId)) {
      throw new Error(`${entry} has a user id starting g_, which only an invitee's may (ADR 0017)`);
    }
    users.push({ sub, userId, displayName });
  });
  if (users.length === 0) throw new Error('TABDOCK_OAUTH_USERS lists no users');
  return users;
}

/** What a checked token says, kept in AuthInfo.extra between the verifier and authenticate(). */
const VerifiedExtraSchema = z.object({
  sub: SubSchema,
  email: z.nullable(EmailSchema),
});

/**
 * Remembers the token sessions it has seen, the newest SEEN_SESSIONS of them,
 * by digest, so each first sighting is logged once and a flood of new ones
 * costs a bounded map.
 */
class SeenSessions {
  readonly #seen = new Set<string>();

  /** True the first time a key is offered while it is among the remembered. */
  first(key: string): boolean {
    if (this.#seen.has(key)) return false;
    this.#seen.add(key);
    if (this.#seen.size > SEEN_SESSIONS) {
      const oldest = this.#seen.values().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
    return true;
  }
}

/**
 * The oauth plugin. Construction checks the settings and throws on a bad one;
 * start() reads the provider's metadata and throws if Claude could not use it,
 * so the relay refuses to start rather than fail on the first sign-in.
 */
export function createOAuthAuth(options: OAuthAuthOptions): AuthPlugin {
  const issuerUrl = secureUrl(options.issuer);
  if (issuerUrl === null || issuerUrl.search !== '') {
    throw new Error(
      'the OAuth issuer (TABDOCK_OAUTH_ISSUER) must be an https URL without a query, such as https://example.authkit.app',
    );
  }
  const issuer = options.issuer;
  const resourceUrl = URL.parse(options.resource);
  if (
    resourceUrl?.protocol !== 'https:' ||
    resourceUrl.search !== '' ||
    resourceUrl.hash !== '' ||
    resourceUrl.username !== '' ||
    resourceUrl.password !== ''
  ) {
    throw new Error('the OAuth resource must be the https URL of the public MCP endpoint');
  }
  const resource = resourceUrl.href;

  if (options.users.length === 0) {
    throw new Error('OAuth sign-in needs at least one user (TABDOCK_OAUTH_USERS)');
  }
  checkMaxTokenAge(options.maxTokenAgeMinutes);
  checkClientIds(options.clientIds);
  const maxTokenAgeSeconds = (options.maxTokenAgeMinutes ?? DEFAULT_MAX_TOKEN_AGE_MINUTES) * 60;
  const allowedClients =
    options.clientIds === undefined ? null : new Set<string>(options.clientIds);
  const refreshMs = options.metadataRefreshMs ?? METADATA_REFRESH_MS;
  if (!Number.isInteger(refreshMs) || refreshMs < 1) {
    throw new Error('the metadata re-read interval must be a positive whole number of ms');
  }
  const bySub = new Map<string, User>();
  const userIds = new Set<string>();
  for (const entry of options.users) {
    if (!SubSchema.safeParse(entry.sub).success) {
      throw new Error('OAuth user subs must be 1 to 255 printable characters without spaces');
    }
    const user = UserSchema.safeParse({ userId: entry.userId, displayName: entry.displayName });
    if (!user.success) {
      throw new Error(
        `OAuth user ids must be 1 to 64 letters, digits, '_' or '-', with a display name of 1 to 100 characters`,
      );
    }
    if (bySub.has(entry.sub)) {
      throw new Error(`the OAuth user ${user.data.userId} has a sub listed twice`);
    }
    if (userIds.has(user.data.userId)) {
      throw new Error(`the OAuth user id ${user.data.userId} is listed twice`);
    }
    if (isInviteePrefixed(user.data.userId)) {
      throw new Error(
        `the OAuth user id ${user.data.userId} starts with g_, which only an invitee's may (ADR 0017)`,
      );
    }
    bySub.set(entry.sub, user.data);
    userIds.add(user.data.userId);
  }

  /**
   * The one account mapping (ADR 0016): an allowlisted subject is a member;
   * anyone else the provider signs in is an invitee, whom the relay refuses
   * unless it admits invitees. The key stands in for the subject, which never
   * leaves this function.
   */
  const accountOf = (sub: string): Account => {
    const user = bySub.get(sub);
    return user === undefined
      ? { kind: 'invitee', key: digestHex(`invitee ${sub}`).slice(0, 32) }
      : { kind: 'member', user };
  };
  const memberNames = [...bySub.values()].map((user) => user.displayName);
  /**
   * The user behind a subject, named once for /mcp, /pair and /i alike (ADR
   * 0017): a member as the owner listed them, with no email kept, since the
   * owner's own settings name them; an invitee by inviteeUser, from the email
   * the provider verified or none.
   */
  const userOf = (sub: string, email: string | null): AuthUser => {
    const account = accountOf(sub);
    return account.kind === 'member'
      ? { ...account.user, account: { ...MEMBER_ACCOUNT } }
      : inviteeUser(account.key, email, memberNames);
  };

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  const expectedResource = new URL(resource);
  let provider: ProviderEndpoints | null = null;
  let verifier: OAuthTokenVerifier | null = null;
  let metadataOptions: {
    oauthMetadata: OAuthMetadata;
    resourceServerUrl: URL;
    resourceName: string;
  } | null = null;
  let log: Logger | null = null;
  let refreshTimer: NodeJS.Timeout | null = null;
  const seen = new SeenSessions();

  const challenge = async (
    error: unknown,
    known: { accountKind: UserKind | null; oauthClientId: string | null } = {
      accountKind: null,
      oauthClientId: null,
    },
  ): Promise<AuthRefusal> => {
    // Only invalid_token ever leaves here: anything else the SDK would turn
    // into a 500, which Claude cannot recover from by signing in.
    const invalid =
      error instanceof OAuthError && error.code === (OAuthErrorCode.InvalidToken as string)
        ? error
        : new OAuthError(OAuthErrorCode.InvalidToken, 'Token is invalid');
    const response = bearerAuthChallengeResponse(invalid, { resourceMetadataUrl });
    return {
      kind: 'refused',
      status: 401,
      reason: invalid.message,
      body: await response.text(),
      headers: {
        'Content-Type': response.headers.get('content-type') ?? 'application/json',
        'WWW-Authenticate': response.headers.get('www-authenticate') ?? 'Bearer',
      },
      // A token that failed its checks says nothing trustworthy about anyone,
      // unless it passed every check but the client list.
      accountKind: known.accountKind,
      oauthClientId: known.oauthClientId,
    };
  };

  const metadataRoute: AuthRoute = (request) => {
    if (metadataOptions === null) return new Response('Not ready', { status: 503 });
    return (
      oauthMetadataResponse(request, metadataOptions) ?? new Response('Not found', { status: 404 })
    );
  };

  /**
   * ADR 0020: the first time a token session shows up, its shape, so the
   * owner's first production run settles what the provider really issues: the
   * lifetime, the client and the JSON types of the two email claims. Never
   * a claim's value, the sid or the subject. A token without a sid counts as
   * its client_id's session, never its jti's, since every token brings a new
   * jti and a line per token would grow with the traffic.
   */
  const firstSighting = (payload: JWTPayload, lifetimeSeconds: number): void => {
    const clientId = OAuthClientIdSchema.safeParse(payload.client_id);
    const key =
      typeof payload.sid === 'string'
        ? `sid ${digestHex(payload.sid)}`
        : `client ${clientId.success ? clientId.data : ''}`;
    if (!seen.first(key)) return;
    log?.info('oauth token shape, first sighting of its session', {
      lifetimeSeconds,
      clientId: clientId.success ? clientId.data : null,
      sessionId: typeof payload.sid === 'string' ? 'present' : 'missing',
      emailClaim: claimType(payload[EMAIL_CLAIM]),
      emailVerifiedClaim: claimType(payload[EMAIL_VERIFIED_CLAIM]),
    });
  };

  /**
   * ADR 0020: the provider's metadata again, hourly. Nothing it says now is
   * adopted: a new issuer or key URL is refused and logged, and the relay
   * keeps what start() checked; the line names a fixed problem, never the
   * provider's text.
   */
  let refreshing = false;
  const refresh = async (checked: ProviderMetadata): Promise<void> => {
    if (refreshing) return;
    refreshing = true;
    try {
      const fresh = await discover(issuer);
      if (fresh.jwks_uri !== checked.jwks_uri) {
        log?.error(
          'identity provider metadata names a new key URL; refused, keeping what the relay checked at start (ADR 0020)',
        );
        return;
      }
      log?.debug('identity provider metadata read again; unchanged where it matters');
    } catch (error) {
      const problem = error instanceof ProviderMetadataError ? error.problem : 'unreachable';
      if (problem === 'issuer') {
        log?.error(
          'identity provider metadata names a new issuer; refused, keeping what the relay checked at start (ADR 0020)',
        );
      } else {
        log?.warn(
          'identity provider metadata could not be read again; keeping what start checked',
          {
            problem,
          },
        );
      }
    } finally {
      refreshing = false;
    }
  };

  return {
    name: 'oauth',
    resource,
    routes: new Map([[new URL(resourceMetadataUrl).pathname, metadataRoute]]),
    browserSignIn: { provider: () => provider, accountOf, userOf },

    async start(context) {
      log = context.log;
      const metadata = await discover(issuer);
      const userinfo =
        metadata.userinfo_endpoint !== undefined && secureUrl(metadata.userinfo_endpoint) !== null
          ? metadata.userinfo_endpoint
          : undefined;
      provider = {
        issuer: metadata.issuer,
        authorization_endpoint: metadata.authorization_endpoint,
        token_endpoint: metadata.token_endpoint,
        jwks_uri: metadata.jwks_uri,
        response_types_supported: metadata.response_types_supported,
        token_endpoint_auth_methods_supported: metadata.token_endpoint_auth_methods_supported,
        userinfo_endpoint: userinfo,
      };
      metadataOptions = {
        oauthMetadata: {
          issuer: metadata.issuer,
          authorization_endpoint: metadata.authorization_endpoint,
          token_endpoint: metadata.token_endpoint,
          response_types_supported: metadata.response_types_supported,
        },
        resourceServerUrl: expectedResource,
        resourceName: RESOURCE_NAME,
      };
      // The SDK's own checks on the issuer, once now rather than on the first request.
      buildOAuthProtectedResourceMetadata(metadataOptions);

      // Pinned at jose's defaults (ADR 0020), so an upgrade cannot change how
      // long a key is trusted, or how often an unknown kid fetches, unseen.
      const jwks = createRemoteJWKSet(new URL(metadata.jwks_uri), {
        timeoutDuration: JWKS_TIMEOUT_MS,
        cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
        cooldownDuration: JWKS_COOLDOWN_MS,
      });
      let failedAt = Number.NEGATIVE_INFINITY;
      // A key that is not published is the token's fault (401); keys that
      // cannot be fetched at all are the provider's (503).
      const keys: JWTVerifyGetKey = async (header, token) => {
        const now = Date.now();
        // A clock set back restarts the wait rather than ending it.
        if (now < failedAt) failedAt = now;
        let cause: unknown;
        if (now - failedAt >= JWKS_RETRY_MS) {
          try {
            return await jwks(header, token);
          } catch (error) {
            if (
              error instanceof errors.JWKSNoMatchingKey ||
              error instanceof errors.JWKSMultipleMatchingKeys
            ) {
              throw error;
            }
            // A first fetch that fails counts too, so a cold start waits like any other.
            failedAt = Date.now();
            cause = error;
          }
        }
        // While a fetch waits, keys jose still holds as fresh check tokens with
        // no fetch at all, so nothing is trusted longer than jose would trust it.
        const held = jwks.fresh ? jwks.jwks() : undefined;
        if (held !== undefined) {
          try {
            return await createLocalJWKSet(held)(header, token);
          } catch (error) {
            if (error instanceof errors.JWKSMultipleMatchingKeys) throw error;
            // A key the held set lacks may have been published since; that is
            // for the provider to answer once it is back, so not a 401.
            cause = error;
          }
        }
        throw new ProviderUnavailable('the identity provider keys cannot be fetched', { cause });
      };
      verifier = {
        async verifyAccessToken(token): Promise<AuthInfo> {
          let payload: JWTPayload;
          try {
            ({ payload } = await jwtVerify(token, keys, {
              issuer,
              audience: resource,
              algorithms: ALGORITHMS,
              requiredClaims: REQUIRED_CLAIMS,
              // Also refuses an iat in the future, past the tolerance.
              maxTokenAge: maxTokenAgeSeconds,
              clockTolerance: CLOCK_TOLERANCE_SECONDS,
            }));
          } catch (error) {
            if (error instanceof ProviderUnavailable) throw error;
            throw new OAuthError(OAuthErrorCode.InvalidToken, tokenProblem(error));
          }
          if (
            typeof payload.exp !== 'number' ||
            typeof payload.iat !== 'number' ||
            typeof payload.sub !== 'string' ||
            !SubSchema.safeParse(payload.sub).success ||
            typeof payload.jti !== 'string' ||
            payload.jti === ''
          ) {
            throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token claims are invalid');
          }
          // A young token can still be one minted to live for days: its whole
          // lifetime is held to the same cap, so a provider setting cannot
          // stretch what a stolen token is worth (ADR 0020).
          const lifetimeSeconds = payload.exp - payload.iat;
          if (lifetimeSeconds > maxTokenAgeSeconds) {
            throw new OAuthError(
              OAuthErrorCode.InvalidToken,
              'Token lives longer than this relay accepts',
            );
          }
          // The audience as the token states it, so verifyBearerToken's own
          // comparison with expectedResource is a second check, not an echo.
          const audience = Array.isArray(payload.aud)
            ? payload.aud.find((value: string) => value === resource)
            : payload.aud;
          const reported = audience === undefined ? null : URL.parse(audience);
          if (reported === null) {
            throw new OAuthError(
              OAuthErrorCode.InvalidToken,
              'Token was not issued for this resource',
            );
          }
          firstSighting(payload, lifetimeSeconds);
          return {
            // AuthInfo requires the token; it goes no further than this plugin.
            token,
            clientId: typeof payload.client_id === 'string' ? payload.client_id : '',
            scopes: scopesOf(payload.scope),
            expiresAt: payload.exp,
            resource: reported,
            extra: { sub: payload.sub, email: verifiedEmailOf(payload) },
          };
        },
      };
      refreshTimer = setInterval(() => {
        void refresh(metadata);
      }, refreshMs);
      // A re-read must never keep the process alive on its own (AuthPlugin.start).
      refreshTimer.unref();
    },

    stop() {
      if (refreshTimer !== null) clearInterval(refreshTimer);
      refreshTimer = null;
    },

    async authenticate(request: IncomingMessage): Promise<AuthOutcome> {
      if (verifier === null) throw new Error('the oauth plugin was used before start()');
      const header = request.headers.authorization;
      let info: AuthInfo;
      try {
        if (header !== undefined && header.length > MAX_AUTHORIZATION_LENGTH) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, 'Authorization header is too long');
        }
        info = await verifyBearerToken(header, {
          verifier,
          expectedResource,
          resourceMetadataUrl,
        });
      } catch (error) {
        if (error instanceof ProviderUnavailable) {
          return {
            kind: 'refused',
            status: 503,
            reason: 'identity provider keys unreachable',
            body: 'Sign-in cannot be checked right now; try again shortly',
            headers: { 'Retry-After': String(Math.ceil(JWKS_RETRY_MS / 1000)) },
            accountKind: null,
            oauthClientId: null,
          };
        }
        return challenge(error);
      }
      const extra = VerifiedExtraSchema.safeParse(info.extra);
      // verifyAccessToken put both there; this only keeps the type honest.
      if (!extra.success) return challenge(new Error('no subject'));
      const { sub, email } = extra.data;
      // A client_id that is no client_id is left out rather than refused: the
      // token itself checked out, and the id is kept for the audit log alone.
      const clientId = OAuthClientIdSchema.safeParse(info.clientId);
      const oauthClientId = clientId.success ? clientId.data : null;
      // ADR 0020: with a client list, only tokens issued to those clients
      // count, so a client anyone registers cannot phish a member's consent
      // into a working token. A token naming no client is no listed client's.
      if (
        allowedClients !== null &&
        (oauthClientId === null || !allowedClients.has(oauthClientId))
      ) {
        return challenge(
          new OAuthError(
            OAuthErrorCode.InvalidToken,
            'Token was issued to a client this relay does not accept',
          ),
          { accountKind: accountOf(sub).kind, oauthClientId },
        );
      }
      // A member or an invitee, which the relay admits or answers with 403
      // (ADR 0020), named by the email the token's claims vouch for.
      return { kind: 'user', user: userOf(sub, email), oauthClientId };
    },
  };
}

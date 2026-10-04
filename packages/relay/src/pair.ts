// The QR flow at /pair (M3 plan; S3, S4, S11, S13) and the invite page at /i
// (ADRs 0016 and 0017). In public URL mode the widget's QR code opens
// `<public URL>/pair#<nonce>` on a phone, and an invite link opens
// `<public URL>/i#<secret>`. This module serves both pages and their scripts
// under one strict CSP; signs the browser in at the oauth plugin's own
// provider with openid-client (authorization code with PKCE S256, state and
// nonce, the ID token's signature checked against the provider's keys,
// scope `openid email`), returning to whichever page started it; keeps the
// sign-in in a short in-memory session behind a __Host- cookie; shows what a
// nonce or an invite would join without using it up; and turns a click on
// Join into an attach request, which the operator answers on the page like
// any other while the browser polls for the answer. At /pair only a member
// may join, and an invitee is told it needs an invite; at /i a member or an
// invitee joins by the invite. A nonce or an invite alone yields only that
// preview; with a session it yields only a pending request. No nonce, code,
// invite secret, cookie, state, verifier, token or email is ever logged. The
// one count that may go by address is the sign-in gate's (sign-in-gate.ts),
// which relay.ts hands in with the address it resolved, since behind a
// tunnel every request comes from the same one and only a host edge names
// the client (ADR 0018). An invitee is named by the email its provider
// verified, read from the ID token or else from UserInfo (ADR 0020), through
// the plugin's one naming rule, so it is the same person here as on /mcp.

import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EmailSchema } from '@tabdock/protocol';
import * as oidc from 'openid-client';
import { z } from 'zod';
import { type AuthUser, type BrowserSignIn, MEMBER_ACCOUNT } from './auth.ts';
import { type PairClientOptions, pairRedirectUriOf, type ResolvedConfig } from './config.ts';
import type { CallerIdentity, ClaimOutcome, PageHub, PairOutcome } from './hub.ts';
import type { Logger } from './log.ts';
import { SlidingWindowLimiter } from './rate-limit.ts';
import { digest, newId, newSessionSecret, sameDigest } from './secrets.ts';
import type { SignInGate } from './sign-in-gate.ts';

/** Every path this module answers; relay.ts also logs requests by these names (ADR 0016). */
export const PAIR_ROUTES: readonly string[] = [
  '/pair',
  '/pair/pair.js',
  '/pair/pair.css',
  '/pair/login',
  '/pair/callback',
  '/pair/preview',
  '/pair/claim',
  '/pair/status',
  '/i',
  '/i/invite.js',
  '/i/preview',
  '/i/claim',
  '/i/status',
];

/**
 * __Host-: Secure, no Domain and Path=/, so only this exact origin over https
 * can set or read it, never a sibling host under the tunnel's domain.
 */
export const SESSION_COOKIE = '__Host-tabdock-pair';
/** Holds one sign-in's state, nonce and PKCE verifier between /pair/login and /pair/callback. */
export const LOGIN_COOKIE = '__Host-tabdock-pair-login';
/** Long enough to sign in at the provider, short enough that an abandoned attempt soon dies. */
export const LOGIN_TTL_MS = 10 * 60_000;
/** One person signing in on a few devices; more than that ends their oldest. */
export const SESSIONS_PER_ACCOUNT = 4;
/** A JSON body here is a nonce, an invite secret or a claim id; anything bigger is not ours. */
const MAX_BODY_BYTES = 1024;
/** Claims remembered at once; each user may only make a few a minute. */
const MAX_CLAIMS = 1000;
/** How long a settled claim stays readable, for a phone that polls a little late. */
const SETTLED_CLAIM_MS = 2 * 60_000;
/** openid-client's default is 30 s; a phone waiting on a sign-in should hear sooner. */
const PROVIDER_TIMEOUT_SECONDS = 10;
const SESSION_SECRET = /^[A-Za-z0-9_-]{43}$/;
/** openid-client's random state, nonce and verifier: 32 bytes as base64url. */
const LOGIN_PART = /^[A-Za-z0-9_-]{43}$/;
const CLAIM_ID = /^qc_[0-9A-Z]{10}$/;
/**
 * ADR 0020: the email claims of an ID token, or of a UserInfo answer. The
 * address counts only when the provider says it verified it.
 */
const EMAIL_SCOPE = 'openid email';

/**
 * Where a sign-in goes back to, fixed rather than taken from the request, so
 * the callback can never be made an open redirect: /pair, or /i for a sign-in
 * /i started (`/pair/login?to=i`). The provider sees one redirect URI either way.
 */
const RETURN_TARGETS = { pair: '/pair', i: '/i' } as const;
type ReturnTarget = keyof typeof RETURN_TARGETS;

/**
 * No inline script or style may run, nothing may frame the page, and with
 * Trusted Types required no string can become markup, so a title or label
 * the page wrote stays text. Its script and style are files of this same origin.
 */
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ');
/** Everything else here is data or a file, which needs nothing at all. */
const RESOURCE_CSP = "default-src 'none'; frame-ancestors 'none'";

/**
 * On every answer: never cached (a nonce or a session must not outlive its
 * use in some cache), never sending a Referer to the provider or anyone, and
 * never framed or sniffed.
 */
const COMMON_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const NonceBodySchema = z.object({ nonce: z.string().max(64) });
const SecretBodySchema = z.object({ secret: z.string().max(64) });
const ClaimBodySchema = z.object({ claim: z.string().max(64) });

/** The two OpenID Connect email claims, each checked for its type; the rest of a token is not read. */
const EmailClaimsSchema = z.object({ email: EmailSchema, email_verified: z.boolean() });

type ClaimStatus =
  | { status: 'pending' }
  | { status: 'approved'; role: 'observer' | 'driver' }
  | { status: 'denied' }
  | { status: 'expired' };

interface PairSession {
  hash: Buffer;
  /** Who signed in, named by the oauth plugin's one rule (ADR 0017). */
  user: AuthUser;
  /** Which account the session counts against for SESSIONS_PER_ACCOUNT. */
  accountKey: string;
  expiresAt: number;
}

interface Claim {
  claimId: string;
  userId: string;
  state: ClaimStatus;
  /** For a settled claim, when it is forgotten; null while it waits on the operator. */
  forgetAt: number | null;
}

interface Asset {
  body: Buffer;
  type: string;
  csp: string;
}

function loadAsset(name: string, type: string, csp: string): Asset {
  return { body: readFileSync(new URL(`./pair-page/${name}`, import.meta.url)), type, csp };
}

/**
 * Bidirectional overrides and other controls could make a page's title or an
 * invite's label read as something else on the phone (S10); they are dropped
 * before it is shown.
 */
function displayText(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, '');
}

function accountKeyOf(user: AuthUser): string {
  return `${user.account.kind} ${user.userId}`;
}

/** Cookie values by name, for the two cookies this module sets and nothing else. */
function cookiesOf(request: IncomingMessage): Map<string, string> {
  const found = new Map<string, string>();
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const split = part.indexOf('=');
    if (split === -1) continue;
    const name = part.slice(0, split).trim();
    if ((name === SESSION_COOKIE || name === LOGIN_COOKIE) && !found.has(name)) {
      found.set(name, part.slice(split + 1).trim());
    }
  }
  return found;
}

/** Secure and HttpOnly always; Lax so the provider's redirect back, a top-level GET, still carries it. */
function setCookie(name: string, value: string, maxAgeMs: number): string {
  const seconds = Math.max(0, Math.floor(maxAgeMs / 1000));
  return `${name}=${value}; Path=/; Max-Age=${String(seconds)}; Secure; HttpOnly; SameSite=Lax`;
}

function clearCookie(name: string): string {
  return setCookie(name, '', 0);
}

interface LoginState {
  state: string;
  nonce: string;
  verifier: string;
  expiresAt: number;
  target: ReturnTarget;
}

/**
 * The sign-in in progress, kept in the browser's own __Host- cookie rather
 * than in memory: nobody can start an unbounded number of them here, and
 * nobody but this browser can hold its state. The values are compared, never
 * trusted: a forged cookie can only sign its own browser in as its own account,
 * and return it to one of the two fixed pages. It can still make the relay
 * ask the provider about a code, as can a real cookie fresh from /pair/login,
 * so callback() bounds those requests. A sign-in /pair started carries four
 * parts; one /i started carries a fifth naming it.
 */
function parseLogin(value: string | undefined): LoginState | null {
  const parts = value?.split('.') ?? [];
  if (parts.length !== 4 && parts.length !== 5) return null;
  const [state = '', nonce = '', verifier = '', expires = '', to = 'pair'] = parts;
  if (![state, nonce, verifier].every((part) => LOGIN_PART.test(part))) return null;
  if (!/^\d{1,15}$/.test(expires)) return null;
  if (parts.length === 5 && to !== 'i') return null;
  return { state, nonce, verifier, expiresAt: Number(expires), target: to === 'i' ? 'i' : 'pair' };
}

/**
 * A fixed account of why a sign-in failed: the error's class and, when it is
 * a constant from openid-client or an OAuth error code, that. Never a message,
 * which can quote values from the response.
 */
function signInProblem(error: unknown): Record<string, string> {
  const problem: Record<string, string> = {
    kind: error instanceof Error ? error.name.slice(0, 64) : 'unknown',
  };
  if (typeof error === 'object' && error !== null) {
    const {
      code: check,
      error: oauthError,
      cause,
    } = error as { code?: unknown; error?: unknown; cause?: unknown };
    if (typeof check === 'string' && /^[A-Z0-9_]{1,64}$/.test(check)) problem.check = check;
    if (typeof oauthError === 'string' && /^[a-z0-9_]{1,64}$/.test(oauthError)) {
      problem.oauthError = oauthError;
    }
    // The name of a claim that failed its check, such as aud or nonce, never its value.
    // openid-client wraps oauth4webapi's error, whose own cause names the claim.
    const inner = (value: unknown): unknown =>
      typeof value === 'object' && value !== null
        ? (value as { cause?: unknown }).cause
        : undefined;
    for (const detail of [cause, inner(cause)]) {
      const claim =
        typeof detail === 'object' && detail !== null
          ? (detail as { claim?: unknown }).claim
          : undefined;
      if (typeof claim === 'string' && /^[a-z_]{1,32}$/.test(claim)) problem.claim = claim;
    }
  }
  return problem;
}

/**
 * The verified email some claims name: a string address with email_verified
 * true. Missing, mistyped or unverified claims name none (ADR 0020), and
 * undefined says the claims are not there at all, so UserInfo may be asked.
 */
function emailOf(claims: Record<string, unknown> | undefined): string | null | undefined {
  if (claims === undefined || (claims.email === undefined && claims.email_verified === undefined)) {
    return undefined;
  }
  const parsed = EmailClaimsSchema.safeParse(claims);
  return parsed.success && parsed.data.email_verified ? parsed.data.email : null;
}

function claimStatusOf(outcome: PairOutcome): ClaimStatus {
  if (outcome.kind === 'attached') return { status: 'approved', role: outcome.role };
  // A page that filled up while the operator decided refused too, if not in words.
  if (outcome.code === 'denied_by_operator' || outcome.code === 'page_busy') {
    return { status: 'denied' };
  }
  // Unanswered (silence is a denial), the page gone or asleep, or the relay stopping.
  return { status: 'expired' };
}

/** The status a refused claim answers with, by the hub's error code. */
function claimRefusalStatus(code: string): number {
  if (code === 'rate_limited') return 429;
  if (code === 'pairing_expired') return 404;
  if (code === 'denied_by_operator' || code === 'invite_required') return 403;
  return 409;
}

export interface PairFlowOptions {
  publicUrl: string;
  client: PairClientOptions;
  signIn: BrowserSignIn;
  hub: PageHub;
  config: ResolvedConfig;
  log: Logger;
  /** Admits each code exchange with the provider, for the whole relay and per client address. */
  signInGate: SignInGate;
}

export interface PairFlow {
  /**
   * Answers one request for a path in PAIR_ROUTES. The Host check has already
   * passed, and `address` is the client address's limit key, which relay.ts
   * resolved, answering 400 itself when the edge's header named none.
   */
  handle(
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
    address: string,
  ): Promise<void>;
  close(): void;
}

/**
 * The openid-client configuration for the relay's /pair client, from the
 * provider metadata the oauth plugin's start() fetched and checked, so both
 * talk to one provider and no second discovery can disagree with the first.
 */
function signInConfiguration(signIn: BrowserSignIn, client: PairClientOptions): oidc.Configuration {
  const provider = signIn.provider();
  if (provider === null) throw new Error('the /pair sign-in needs the oauth plugin started first');
  if (!provider.response_types_supported.includes('code')) {
    throw new Error(
      'the identity provider does not list the "code" response type, which the /pair sign-in needs',
    );
  }
  const methods = provider.token_endpoint_auth_methods_supported;
  // The POST form when the provider offers it: Basic credentials must be
  // form-encoded first (RFC 6749 section 2.3.1), so a client id such as
  // client_01AB goes out as client%5F01AB, which not every server decodes.
  // Otherwise RFC 8414's default, client_secret_basic.
  const clientAuth =
    methods?.includes('client_secret_post') === true
      ? oidc.ClientSecretPost(client.clientSecret)
      : oidc.ClientSecretBasic(client.clientSecret);
  const configuration = new oidc.Configuration(
    {
      issuer: provider.issuer,
      authorization_endpoint: provider.authorization_endpoint,
      token_endpoint: provider.token_endpoint,
      jwks_uri: provider.jwks_uri,
      // Where an invitee's email is asked for when the ID token names none (ADR 0020).
      ...(provider.userinfo_endpoint === undefined
        ? {}
        : { userinfo_endpoint: provider.userinfo_endpoint }),
    },
    client.clientId,
    undefined,
    clientAuth,
  );
  configuration.timeout = PROVIDER_TIMEOUT_SECONDS;
  // The ID token comes straight from the token endpoint over TLS, which
  // openid-client takes as proof enough; its signature is checked against
  // the provider's published keys as well, as the oauth plugin checks tokens.
  oidc.enableNonRepudiationChecks(configuration);
  // The oauth plugin accepts a plain http provider only on this machine (a
  // test provider); the same rule holds here, and nothing else is let through.
  if (new URL(provider.issuer).protocol === 'http:') {
    // Deprecated only to make it stand out; the oauth plugin already confined http to loopback.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    oidc.allowInsecureRequests(configuration);
  }
  return configuration;
}

export function createPairFlow(options: PairFlowOptions): PairFlow {
  const { publicUrl, client, signIn, hub, config, log, signInGate } = options;
  const configuration = signInConfiguration(signIn, client);
  const userInfoAvailable = signIn.provider()?.userinfo_endpoint !== undefined;
  const redirectUri = pairRedirectUriOf(publicUrl);
  const assets = new Map<string, Asset>([
    ['/pair', loadAsset('pair.html', 'text/html; charset=utf-8', PAGE_CSP)],
    ['/pair/pair.js', loadAsset('pair.js', 'text/javascript; charset=utf-8', RESOURCE_CSP)],
    ['/pair/pair.css', loadAsset('pair.css', 'text/css; charset=utf-8', RESOURCE_CSP)],
    ['/i', loadAsset('invite.html', 'text/html; charset=utf-8', PAGE_CSP)],
    ['/i/invite.js', loadAsset('invite.js', 'text/javascript; charset=utf-8', RESOURCE_CSP)],
  ]);
  const { windowMs, pairPreviewsPerNonce } = config.rateLimits;
  // Keyed by the digest of a live nonce or invite, never by address (ADR 0016).
  const previewLimiter = new SlidingWindowLimiter(pairPreviewsPerNonce, windowMs);
  /** Oldest first: a Map keeps insertion order, and sessions are only ever added at the end. */
  const sessions = new Map<string, PairSession>();
  const claims = new Map<string, Claim>();

  function send(
    response: ServerResponse,
    status: number,
    body: string | Buffer,
    headers: Record<string, string>,
  ): void {
    response.writeHead(status, {
      ...COMMON_HEADERS,
      'Content-Security-Policy': RESOURCE_CSP,
      ...headers,
    });
    response.end(response.req.method === 'HEAD' ? undefined : body);
  }

  function json(
    response: ServerResponse,
    status: number,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): void {
    send(response, status, JSON.stringify(body), {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    });
  }

  function refuse(response: ServerResponse, status: number, error: string, message: string): void {
    json(
      response,
      status,
      { error, message },
      status === 429 ? { 'Retry-After': String(Math.ceil(windowMs / 1000)) } : {},
    );
  }

  function redirect(response: ServerResponse, location: string, cookies: string[]): void {
    response.writeHead(303, {
      ...COMMON_HEADERS,
      'Content-Security-Policy': RESOURCE_CSP,
      Location: location,
      'Set-Cookie': cookies,
    });
    response.end();
  }

  // Sessions

  function sweepSessions(now: number): void {
    for (const [key, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(key);
    }
  }

  /**
   * A new session for a signed-in account. Past SESSIONS_PER_ACCOUNT the
   * account's oldest ends; past the relay's cap, the oldest session of an
   * account that is not a member ends first, so strangers signing in at the
   * provider cannot push the owner's people out.
   */
  function openSession(user: AuthUser, now: number): string {
    sweepSessions(now);
    const accountKey = accountKeyOf(user);
    const own = [...sessions].filter(([, session]) => session.accountKey === accountKey);
    for (const [key] of own.slice(0, Math.max(0, own.length - SESSIONS_PER_ACCOUNT + 1))) {
      sessions.delete(key);
    }
    while (sessions.size >= config.limits.pairSessions) {
      const stranger = [...sessions].find(([, session]) => session.user.account.kind !== 'member');
      const oldest = stranger ?? sessions.entries().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest[0]);
      log.info('pair session ended to make room for a new sign-in');
    }
    const secret = newSessionSecret();
    const hash = digest(secret);
    sessions.set(hash.toString('hex'), {
      hash,
      user,
      accountKey,
      expiresAt: now + config.timings.pairSessionMs,
    });
    return secret;
  }

  /** The browser's live session, found by its digest and confirmed in constant time. */
  function sessionOf(request: IncomingMessage, now: number): PairSession | null {
    const value = cookiesOf(request).get(SESSION_COOKIE);
    if (value === undefined || !SESSION_SECRET.test(value)) return null;
    const hash = digest(value);
    const key = hash.toString('hex');
    const session = sessions.get(key);
    if (!session || !sameDigest(session.hash, hash)) return null;
    if (session.expiresAt <= now) {
      sessions.delete(key);
      return null;
    }
    return session;
  }

  /** Who a session's claims act as: no access token, so no client_id, and no client name. */
  function callerOf(user: AuthUser): CallerIdentity {
    return {
      userId: user.userId,
      displayName: user.displayName,
      account: user.account.kind === 'member' ? { ...MEMBER_ACCOUNT } : { ...user.account },
      oauthClientId: null,
      client: null,
    };
  }

  // Claims

  function sweepClaims(now: number): void {
    for (const [claimId, claim] of claims) {
      if (claim.forgetAt !== null && claim.forgetAt <= now) claims.delete(claimId);
    }
  }

  /** Remembers a claim the hub took, settling it when the operator answers or time runs out. */
  function remember(outcome: Extract<ClaimOutcome, { kind: 'claimed' }>, userId: string): string {
    const claimId = newId('qc');
    const record: Claim = { claimId, userId, state: { status: 'pending' }, forgetAt: null };
    claims.set(claimId, record);
    void outcome.settled
      .catch(() => ({ kind: 'error', code: 'timeout', message: '' }) as const)
      .then((settled) => {
        record.state = claimStatusOf(settled);
        record.forgetAt = Date.now() + SETTLED_CLAIM_MS;
        log.debug('pair claim settled', {
          userId,
          pageId: outcome.pageId,
          claim: claimId,
          status: record.state.status,
        });
      });
    return claimId;
  }

  // Bodies and origins

  /**
   * A small JSON body, or null after answering. Only application/json is
   * read, which a cross-site page cannot send without a CORS preflight this
   * relay never answers.
   */
  async function readJson(request: IncomingMessage, response: ServerResponse): Promise<unknown> {
    const type = request.headers['content-type'] ?? '';
    if (!/^application\/json\s*(;|$)/i.test(type)) {
      refuse(response, 415, 'bad_request', 'send the body as application/json');
      return null;
    }
    const declared = Number(request.headers['content-length'] ?? '0');
    if (declared > MAX_BODY_BYTES) {
      refuse(response, 413, 'bad_request', 'the body is too large');
      return null;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        refuse(response, 413, 'bad_request', 'the body is too large');
        return null;
      }
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      refuse(response, 400, 'bad_request', 'the body is not JSON');
      return null;
    }
  }

  /**
   * A request that changes something must come from this relay's own pages:
   * its Origin must be exactly the public origin. A missing Origin is refused
   * too; browsers send one on every POST.
   */
  function sameOrigin(request: IncomingMessage): boolean {
    return request.headers.origin === publicUrl;
  }

  // Routes

  function serveAsset(path: string, response: ServerResponse): void {
    const asset = assets.get(path);
    if (!asset) {
      refuse(response, 404, 'not_found', 'not found');
      return;
    }
    send(response, 200, asset.body, {
      'Content-Type': asset.type,
      'Content-Security-Policy': asset.csp,
    });
  }

  async function login(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    // Only the one name /i sends is read; anything else returns to /pair.
    const asked = URL.parse(request.url ?? '', 'http://relay.invalid')?.searchParams.get('to');
    const target: ReturnTarget = asked === 'i' && config.invites ? 'i' : 'pair';
    const authorization = oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: redirectUri,
      scope: EMAIL_SCOPE,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    const expiresAt = Date.now() + LOGIN_TTL_MS;
    log.debug('pair sign-in started', { returnTo: RETURN_TARGETS[target] });
    const value = `${state}.${nonce}.${verifier}.${String(expiresAt)}${target === 'i' ? '.i' : ''}`;
    redirect(response, authorization.href, [setCookie(LOGIN_COOKIE, value, LOGIN_TTL_MS)]);
  }

  /**
   * The email the provider verified for an invitee: from the ID token, or
   * when it names none, from UserInfo with the code grant's access token
   * (ADR 0020). A member's is never asked for, since the owner's own settings
   * name members. A UserInfo failure leaves the account unverified; it is
   * logged by its kind, never its text.
   */
  async function verifiedEmail(
    sub: string,
    tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers,
  ): Promise<string | null> {
    if (signIn.accountOf(sub).kind === 'member') return null;
    const fromIdToken = emailOf(tokens.claims());
    if (fromIdToken !== undefined || !userInfoAvailable) return fromIdToken ?? null;
    try {
      const info = await oidc.fetchUserInfo(configuration, tokens.access_token, sub);
      return emailOf(info) ?? null;
    } catch (error) {
      log.info('pair sign-in: the provider gave no email; the account shows as unverified', {
        ...signInProblem(error),
      });
      return null;
    }
  }

  async function callback(
    request: IncomingMessage,
    response: ServerResponse,
    address: string,
  ): Promise<void> {
    const now = Date.now();
    const login = parseLogin(cookiesOf(request).get(LOGIN_COOKIE));
    const back = RETURN_TARGETS[login?.target ?? 'pair'];
    const failed = (): void => {
      redirect(response, `${back}?signin=failed`, [clearCookie(LOGIN_COOKIE)]);
    };
    if (login === null || login.expiresAt <= now) {
      log.info('pair sign-in refused: no sign-in in progress in this browser');
      failed();
      return;
    }
    // Rebuilt on the public URL, the redirect URI the provider was given;
    // only the query comes from the request, and the Host never does.
    const query = URL.parse(request.url ?? '', 'http://relay.invalid')?.search ?? '';
    const returned = new URL(`/pair/callback${query}`, publicUrl);
    let user: AuthUser;
    // Anyone can get this far with a cookie of their own making, and what
    // follows is a request to the provider carrying the /pair client's
    // secret, so the gate admits only so many at once and per window. Past
    // either, the sign-in fails here and the provider hears nothing. Admitted
    // last, so nothing can throw between here and the finally that leaves.
    const pass = signInGate.enter(address, now);
    if (pass === null) {
      failed();
      return;
    }
    try {
      const tokens = await oidc.authorizationCodeGrant(configuration, returned, {
        pkceCodeVerifier: login.verifier,
        expectedState: login.state,
        expectedNonce: login.nonce,
        idTokenExpected: true,
      });
      const claimed = tokens.claims()?.sub;
      if (typeof claimed !== 'string' || claimed === '') throw new Error('no subject');
      // The same naming rule as /mcp's, from the email the provider verified.
      user = signIn.userOf(claimed, await verifiedEmail(claimed, tokens));
    } catch (error) {
      log.info('pair sign-in failed', signInProblem(error));
      failed();
      return;
    } finally {
      pass.leave();
    }
    const secret = openSession(user, now);
    log.info(
      'pair signed in',
      user.account.kind === 'member'
        ? { userId: user.userId }
        : { account: 'not a member', userId: user.userId, verified: user.account.email !== null },
    );
    redirect(response, back, [
      clearCookie(LOGIN_COOKIE),
      setCookie(SESSION_COOKIE, secret, config.timings.pairSessionMs),
    ]);
  }

  async function preview(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = NonceBodySchema.safeParse(await readJson(request, response));
    if (response.headersSent) return;
    if (!body.success) {
      refuse(response, 400, 'bad_request', 'expected {"nonce": "..."}');
      return;
    }
    const { nonce } = body.data;
    const now = Date.now();
    // Looked up first: an unknown, used or expired nonce gets the one answer
    // and leaves nothing behind, so nobody can fill the limiter with nonces
    // of their own making, and a made-up nonce never reads as limited.
    const shown = hub.previewPairNonce(nonce);
    if (shown === null) {
      refuse(response, 404, 'pairing_expired', 'this pairing link is invalid or expired');
      return;
    }
    // Looking uses nothing up, so a live nonce is bounded per nonce: a page
    // polled to death would still answer its own operator. The key is the
    // live ticket's own digest (the hub matched it), so keys stay as few as
    // live tickets.
    const key = digest(nonce).toString('hex');
    if (!previewLimiter.allows(key, now)) {
      log.warn('pair preview rate limited');
      refuse(response, 429, 'rate_limited', 'too many looks at this pairing link');
      return;
    }
    previewLimiter.record(key, now);
    const session = sessionOf(request, now);
    json(response, 200, {
      page: {
        origin: shown.origin,
        title: displayText(shown.title),
        titleCut: shown.titleCut,
        code: shown.code,
        expiresAt: shown.expiresAt,
      },
      account:
        session === null
          ? { signedIn: false }
          : session.user.account.kind === 'member'
            ? { signedIn: true, member: true, displayName: session.user.displayName }
            : // With invites on, the page says how such an account joins instead.
              {
                signedIn: true,
                member: false,
                ...(config.invites ? { inviteRequired: true } : {}),
              },
    });
  }

  async function claim(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!sameOrigin(request)) {
      log.info('pair claim refused: not from the /pair page');
      refuse(response, 403, 'forbidden', 'claims come only from the /pair page');
      return;
    }
    const now = Date.now();
    const session = sessionOf(request, now);
    if (session === null) {
      log.info('pair claim refused: not signed in');
      refuse(response, 401, 'sign_in_required', 'sign in to join a page');
      return;
    }
    // With invites off this relay admits no one but members (ADR 0013), so
    // anyone else is turned away before the nonce is even read.
    if (session.user.account.kind !== 'member' && !config.invites) {
      log.info('pair claim refused: the account is not a member');
      refuse(response, 403, 'not_allowed', 'this account is not allowed on this relay');
      return;
    }
    const body = NonceBodySchema.safeParse(await readJson(request, response));
    if (response.headersSent) return;
    if (!body.success) {
      refuse(response, 400, 'bad_request', 'expected {"nonce": "..."}');
      return;
    }
    sweepClaims(now);
    if (claims.size >= MAX_CLAIMS) {
      log.warn('pair claim refused: too many claims waiting');
      refuse(response, 429, 'rate_limited', 'too many people are joining pages; try again shortly');
      return;
    }
    const { user } = session;
    // An invitee's claim goes to the hub as well, which counts it against the
    // user's pairing limit and records its refusal as pair_page's would, then
    // answers invite_required before the nonce is looked at, so the nonce is
    // neither spent nor rotated and a code seen on a shared screen summons no
    // prompt from a stranger (ADRs 0016 and 0019).
    const outcome = hub.claimPairNonce(callerOf(user), body.data.nonce);
    if (outcome.kind === 'error') {
      refuse(response, claimRefusalStatus(outcome.code), outcome.code, outcome.message);
      return;
    }
    const claimId = remember(outcome, user.userId);
    log.info('pair claim accepted', {
      userId: user.userId,
      pageId: outcome.pageId,
      claim: claimId,
    });
    json(response, 200, { claim: claimId, status: 'pending' });
  }

  async function status(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!sameOrigin(request)) {
      refuse(response, 403, 'forbidden', "status comes only to this relay's own pages");
      return;
    }
    const now = Date.now();
    const session = sessionOf(request, now);
    // An invitee's claims are made at /i; a claim names its claimant either way.
    if (session === null) {
      refuse(response, 401, 'sign_in_required', 'sign in to see your claim');
      return;
    }
    const body = ClaimBodySchema.safeParse(await readJson(request, response));
    if (response.headersSent) return;
    if (!body.success || !CLAIM_ID.test(body.data.claim)) {
      refuse(response, 400, 'bad_request', 'expected {"claim": "..."}');
      return;
    }
    sweepClaims(now);
    const record = claims.get(body.data.claim);
    // Someone else's claim and no claim at all answer alike (S13).
    if (record?.userId !== session.user.userId) {
      refuse(response, 404, 'unknown_claim', 'no such claim');
      return;
    }
    json(response, 200, record.state);
  }

  // /i (ADRs 0016 and 0017)

  /**
   * What an invite would join, for whoever holds its link: the page's origin
   * from its socket, its title and the invite's label marked as written by
   * the page, what the invite lets someone do and who shared it. Looked up
   * before it is counted, as /pair's nonces are, so made-up secrets leave
   * nothing behind and a live invite is bounded per invite.
   */
  async function invitePreview(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = SecretBodySchema.safeParse(await readJson(request, response));
    if (response.headersSent) return;
    if (!body.success) {
      refuse(response, 400, 'bad_request', 'expected {"secret": "..."}');
      return;
    }
    const { secret } = body.data;
    const now = Date.now();
    const shown = hub.previewInvite(secret);
    if (shown === null) {
      refuse(response, 404, 'pairing_expired', 'this invite link is invalid, used up or expired');
      return;
    }
    const key = `invite ${digest(secret).toString('hex')}`;
    if (!previewLimiter.allows(key, now)) {
      log.warn('invite preview rate limited');
      refuse(response, 429, 'rate_limited', 'too many looks at this invite link');
      return;
    }
    previewLimiter.record(key, now);
    const session = sessionOf(request, now);
    json(response, 200, {
      invite: {
        origin: shown.origin,
        title: displayText(shown.title),
        titleCut: shown.titleCut,
        label: displayText(shown.label),
        role: shown.role,
        sponsor: displayText(shown.sponsor),
        expiresAt: shown.expiresAt,
      },
      account:
        session === null
          ? { signedIn: false }
          : {
              signedIn: true,
              member: session.user.account.kind === 'member',
              displayName: session.user.displayName,
              verified:
                session.user.account.kind === 'member' || session.user.account.email !== null,
            },
      // Where Claude reaches this relay, to add as a connector under the same account.
      connector: `${publicUrl}/mcp`,
    });
  }

  /** /i's Join: only on a click, from /i itself, signed in, member or invitee alike. */
  async function inviteClaim(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!sameOrigin(request)) {
      log.info('invite claim refused: not from the /i page');
      refuse(response, 403, 'forbidden', 'claims come only from the /i page');
      return;
    }
    const now = Date.now();
    const session = sessionOf(request, now);
    if (session === null) {
      log.info('invite claim refused: not signed in');
      refuse(response, 401, 'sign_in_required', 'sign in to join a page');
      return;
    }
    const body = SecretBodySchema.safeParse(await readJson(request, response));
    if (response.headersSent) return;
    if (!body.success) {
      refuse(response, 400, 'bad_request', 'expected {"secret": "..."}');
      return;
    }
    sweepClaims(now);
    if (claims.size >= MAX_CLAIMS) {
      log.warn('invite claim refused: too many claims waiting');
      refuse(response, 429, 'rate_limited', 'too many people are joining pages; try again shortly');
      return;
    }
    const { user } = session;
    // Redemptions count per user, per invite and per page in the hub (S14).
    const outcome = hub.claimInvite(callerOf(user), body.data.secret);
    if (outcome.kind === 'error') {
      refuse(response, claimRefusalStatus(outcome.code), outcome.code, outcome.message);
      return;
    }
    const claimId = remember(outcome, user.userId);
    log.info('invite claim accepted', {
      userId: user.userId,
      pageId: outcome.pageId,
      claim: claimId,
    });
    json(response, 200, { claim: claimId, status: 'pending' });
  }

  const methods: Record<string, readonly string[]> = {
    '/pair': ['GET', 'HEAD'],
    '/pair/pair.js': ['GET', 'HEAD'],
    '/pair/pair.css': ['GET', 'HEAD'],
    '/pair/login': ['GET'],
    '/pair/callback': ['GET'],
    '/pair/preview': ['POST'],
    '/pair/claim': ['POST'],
    '/pair/status': ['POST'],
    '/i': ['GET', 'HEAD'],
    '/i/invite.js': ['GET', 'HEAD'],
    '/i/preview': ['POST'],
    '/i/claim': ['POST'],
    '/i/status': ['POST'],
  };

  return {
    async handle(path, request, response, address) {
      const allowed = methods[path];
      // A relay with invites off knows no invites, so /i is not there at all.
      if (allowed === undefined || (path.startsWith('/i') && !config.invites)) {
        refuse(response, 404, 'not_found', 'not found');
        return;
      }
      if (!allowed.includes(request.method ?? '')) {
        send(response, 405, 'Method not allowed', {
          'Content-Type': 'text/plain; charset=utf-8',
          Allow: allowed.join(', '),
        });
        return;
      }
      switch (path) {
        case '/pair/login':
          await login(request, response);
          return;
        case '/pair/callback':
          await callback(request, response, address);
          return;
        case '/pair/preview':
          await preview(request, response);
          return;
        case '/pair/claim':
          await claim(request, response);
          return;
        case '/pair/status':
        case '/i/status':
          await status(request, response);
          return;
        case '/i/preview':
          await invitePreview(request, response);
          return;
        case '/i/claim':
          await inviteClaim(request, response);
          return;
        default:
          serveAsset(path, response);
      }
    },
    close() {
      sessions.clear();
      claims.clear();
    },
  };
}

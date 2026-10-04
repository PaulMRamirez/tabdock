// ADR 0020's hardening of the oauth plugin, against the stand-in provider in
// public URL mode: tokens must carry iat and jti, be no older than the cap and
// live no longer than it; with a client list only those clients' tokens count;
// the namespaced email claims name an invitee, parsed with zod; the first
// token of each session logs its shape and never a value; the provider's
// metadata is read again on a timer and a new issuer or key URL is refused;
// and the refusal line names the account kind and client, collapsing repeated
// 401s from one address. S11 throughout: no token, subject or email in a line.

import type { IncomingMessage } from 'node:http';
import { generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ClientAddress,
  createAuthRefusalLog,
  createLogger,
  createOAuthAuth,
  createRelay,
  EMAIL_CLAIM,
  EMAIL_VERIFIED_CLAIM,
  JWKS_CACHE_MAX_AGE_MS,
  JWKS_COOLDOWN_MS,
  type OAuthAuthOptions,
  type Relay,
  SEEN_SESSIONS,
  verifiedEmailOf,
} from '../src/index.ts';
import { PAGE_ORIGIN } from './helpers/page-client.ts';
import { goodMetadata, PAIR_CLIENT, startProvider, type TestProvider } from './helpers/provider.ts';
import { PUBLIC_MCP_URL, PUBLIC_ORIGIN, type RawAnswer, rawRequest } from './helpers/tunnel.ts';

const USERS = [{ sub: 'sub-alice', userId: 'alice', displayName: 'Alice' }];

let provider: TestProvider;
let relay: Relay | undefined;
let lines: string[] = [];

beforeEach(async () => {
  provider = await startProvider();
  lines = [];
});

afterEach(async () => {
  vi.useRealTimers();
  await relay?.close();
  relay = undefined;
  await provider.stop().catch(() => undefined);
});

async function start(overrides: Partial<OAuthAuthOptions> = {}, invites = false): Promise<Relay> {
  relay = await createRelay({
    auth: createOAuthAuth({
      issuer: provider.issuer,
      resource: PUBLIC_MCP_URL,
      users: USERS,
      ...overrides,
    }),
    publicUrl: PUBLIC_ORIGIN,
    pairClient: PAIR_CLIENT,
    allowedOrigins: [PAGE_ORIGIN],
    invites,
    port: 0,
    logLevel: 'debug',
    logSink: (line) => {
      lines.push(line);
    },
  });
  return relay;
}

const now = (): number => Math.floor(Date.now() / 1000);

/** A 2026-07-28 discover with a bearer token: the plugin answers before any MCP code runs. */
function discover(token: string | null): Promise<RawAnswer> {
  if (!relay) throw new Error('no relay');
  return rawRequest(relay.url, '/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'server/discover',
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
}

function token(claims: Record<string, unknown> = {}): Promise<string> {
  return provider.token({ sub: 'sub-alice', aud: PUBLIC_MCP_URL, ...claims });
}

function events(): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function expectChallenge(answer: RawAnswer, description: RegExp): void {
  expect(answer.status, answer.body).toBe(401);
  expect(answer.headers.get('www-authenticate')).toMatch(description);
}

describe('token claims and age (ADR 0020)', () => {
  beforeEach(async () => {
    await start();
  });

  it('accepts a token with iat and jti inside the cap', async () => {
    expect((await discover(await token())).status).toBe(200);
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['without a jti', { jti: undefined }, /no token id/],
    ['without an iat', { iat: undefined }, /nothing of when it was issued/],
    ['issued in the future', { iat: now() + 600, nbf: undefined }, /issued in the future/],
    [
      'older than the cap',
      { iat: now() - 121 * 60, exp: now() + 60 },
      /older than this relay accepts/,
    ],
    [
      'minted to live longer than the cap',
      { exp: now() + 121 * 60 },
      /lives longer than this relay/,
    ],
  ])('refuses a token %s with the sign-in challenge', async (_name, claims, description) => {
    expectChallenge(await discover(await token(claims)), description);
  });
});

describe('the cap is a setting, from 1 to 1440 minutes', () => {
  it('holds a token to a lower cap, both its age and its lifetime', async () => {
    await start({ maxTokenAgeMinutes: 30 });
    expect((await discover(await token({ exp: now() + 29 * 60 }))).status).toBe(200);
    expectChallenge(await discover(await token({ exp: now() + 31 * 60 })), /lives longer/);
    expectChallenge(
      await discover(await token({ iat: now() - 31 * 60, exp: now() + 60 })),
      /older than/,
    );
  });

  it('lets a raised cap accept what the default refuses, never past a day', async () => {
    await start({ maxTokenAgeMinutes: 1440 });
    expect((await discover(await token({ exp: now() + 23 * 60 * 60 }))).status).toBe(200);
    expectChallenge(await discover(await token({ exp: now() + 25 * 60 * 60 })), /lives longer/);
  });
});

describe('the client list (ADR 0020)', () => {
  const CLAUDE = 'https://claude.ai/oauth/mcp-oauth-client-metadata';

  it('accepts only listed clients, and a refused one names its account kind and client', async () => {
    // Early in the next minute, so the refusals below share one collapsing window.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime((Math.floor(Date.now() / 60_000) + 1) * 60_000 + 5000);
    await start({ clientIds: [CLAUDE] }, true);
    expect((await discover(await token({ client_id: CLAUDE }))).status).toBe(200);
    for (const claims of [{ client_id: 'client_phisher' }, {}]) {
      expectChallenge(
        await discover(await token(claims)),
        /issued to a client this relay does not accept/,
      );
    }
    // An invitee's token from another client is refused alike, by its kind.
    expectChallenge(
      await discover(
        await provider.token({ sub: 'sub-stranger', aud: PUBLIC_MCP_URL, client_id: 'x' }),
      ),
      /does not accept/,
    );
    // One address: the first line in full, the rest counted by reason.
    const refused = events().filter(
      (entry) => entry.msg === 'mcp request refused: not authenticated',
    );
    expect(refused.map((entry) => [entry.accountKind, entry.oauthClientId])).toEqual([
      ['member', 'client_phisher'],
    ]);
    await relay?.close();
    expect(
      events().find((entry) => entry.msg === 'mcp request refused: not authenticated, repeated'),
    ).toMatchObject({
      reasons: { 'Token was issued to a client this relay does not accept': 2 },
      repeated: 2,
    });
  });

  it('accepts any client without a list', async () => {
    await start();
    expect((await discover(await token({ client_id: 'anything' }))).status).toBe(200);
    expect((await discover(await token())).status).toBe(200);
  });
});

describe('the email claims (ADR 0020)', () => {
  it.each<[string, Record<string, unknown>, string | null]>([
    [
      'a verified email',
      { [EMAIL_CLAIM]: 'a@example.com', [EMAIL_VERIFIED_CLAIM]: true },
      'a@example.com',
    ],
    ['an unverified one', { [EMAIL_CLAIM]: 'a@example.com', [EMAIL_VERIFIED_CLAIM]: false }, null],
    [
      'a verified flag as text',
      { [EMAIL_CLAIM]: 'a@example.com', [EMAIL_VERIFIED_CLAIM]: 'true' },
      null,
    ],
    ['no flag', { [EMAIL_CLAIM]: 'a@example.com' }, null],
    ['no email', { [EMAIL_VERIFIED_CLAIM]: true }, null],
    [
      'an email that is none',
      { [EMAIL_CLAIM]: 'not an email', [EMAIL_VERIFIED_CLAIM]: true },
      null,
    ],
    [
      'an email over 320 characters',
      { [EMAIL_CLAIM]: `${'a'.repeat(310)}@example.com`, [EMAIL_VERIFIED_CLAIM]: true },
      null,
    ],
    ['the plain OpenID claim names', { email: 'a@example.com', email_verified: true }, null],
  ])('reads %s', (_name, claims, email) => {
    expect(verifiedEmailOf(claims)).toBe(email);
  });

  it('names an invitee by the verified email in its token, and a member never by one', async () => {
    const auth = createOAuthAuth({
      issuer: provider.issuer,
      resource: PUBLIC_MCP_URL,
      users: USERS,
    });
    await auth.start?.({ log: createLogger({ sink: () => undefined }) });
    try {
      const ask = async (sub: string, claims: Record<string, unknown>) =>
        auth.authenticate({
          headers: {
            authorization: `Bearer ${await provider.token({ sub, aud: PUBLIC_MCP_URL, ...claims })}`,
          },
        } as unknown as IncomingMessage);
      const verified = { [EMAIL_CLAIM]: 'guest@example.com', [EMAIL_VERIFIED_CLAIM]: true };
      expect(await ask('sub-guest', verified)).toMatchObject({
        user: {
          displayName: 'guest@example.com',
          account: { kind: 'invitee', email: 'guest@example.com' },
        },
      });
      expect(await ask('sub-guest', { ...verified, [EMAIL_VERIFIED_CLAIM]: false })).toMatchObject({
        user: { displayName: 'unverified account', account: { kind: 'invitee', email: null } },
      });
      expect(await ask('sub-alice', verified)).toMatchObject({
        user: { userId: 'alice', displayName: 'Alice', account: { kind: 'member', email: null } },
      });
    } finally {
      auth.stop?.();
    }
  });
});

describe("a token session's first sighting (ADR 0020)", () => {
  it('logs its lifetime, client and claim types once per sid, never a value, sid or subject', async () => {
    await start();
    const sid = 'session_01SECRETSESSIONID';
    const claims = {
      sid,
      client_id: 'client_01ABC',
      [EMAIL_CLAIM]: 'guest@example.com',
      [EMAIL_VERIFIED_CLAIM]: true,
    };
    for (let i = 0; i < 3; i += 1) expect((await discover(await token(claims))).status).toBe(200);
    expect((await discover(await token({ ...claims, sid: 'session_02OTHER' }))).status).toBe(200);
    const seen = events().filter((entry) =>
      String(entry.msg).startsWith('oauth token shape, first sighting'),
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      lifetimeSeconds: 3600,
      clientId: 'client_01ABC',
      sessionId: 'present',
      emailClaim: 'string',
      emailVerifiedClaim: 'boolean',
    });
    const all = lines.join('\n');
    for (const kept of [sid, 'session_02OTHER', 'guest@example.com', 'sub-alice']) {
      expect(all).not.toContain(kept);
    }
  });

  it('remembers at most the newest sessions it saw', () => {
    expect(SEEN_SESSIONS).toBe(1000);
  });

  it('names a missing claim as missing, so the first production run shows the template is off', async () => {
    await start();
    await discover(await token({ sid: 'session_03' }));
    expect(
      events().find((entry) => String(entry.msg).startsWith('oauth token shape')),
    ).toMatchObject({ emailClaim: 'missing', emailVerifiedClaim: 'missing', clientId: null });
  });
});

describe("the provider's metadata, read again (ADR 0020)", () => {
  it('keeps what it checked at start when the issuer or key URL changes, and says so', async () => {
    await start({ metadataRefreshMs: 50 });
    const good = await token();
    provider.oauthMetadata = { ...goodMetadata(provider.issuer), issuer: 'https://evil.example' };
    await vi.waitFor(() => {
      expect(lines.join('\n')).toContain('identity provider metadata names a new issuer; refused');
    });
    provider.oauthMetadata = {
      ...goodMetadata(provider.issuer),
      jwks_uri: 'https://evil.example/jwks',
    };
    await vi.waitFor(() => {
      expect(lines.join('\n')).toContain('identity provider metadata names a new key URL; refused');
    });
    // Tokens still check against the provider's real keys, as at start.
    expect((await discover(good)).status).toBe(200);
    provider.oauthMetadata = null;
    await vi.waitFor(() => {
      expect(
        events().some(
          (entry) =>
            String(entry.msg).startsWith('identity provider metadata could not be read again') &&
            entry.problem === 'missing',
        ),
      ).toBe(true);
    });
    expect(lines.join('\n')).not.toContain('evil.example');
  });

  it('stops reading again once the relay closes', async () => {
    const opened = await start({ metadataRefreshMs: 30 });
    await opened.close();
    relay = undefined;
    const fetches = vi.spyOn(globalThis, 'fetch');
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fetches).not.toHaveBeenCalled();
    } finally {
      fetches.mockRestore();
    }
  });

  it('pins the key cache and cooldown at jose defaults', () => {
    expect(JWKS_CACHE_MAX_AGE_MS).toBe(10 * 60_000);
    expect(JWKS_COOLDOWN_MS).toBe(30_000);
  });
});

describe('the refusal line (ADR 0020)', () => {
  const peer = (address: string): ClientAddress => ({ ok: true, address, key: address });
  const refusal = (status: 401 | 403, reason: string) => ({
    kind: 'refused' as const,
    status,
    reason,
    body: '',
    headers: {},
    accountKind: null,
    oauthClientId: null,
  });

  it('collapses repeated 401s to one line per address a minute, with a count by reason', () => {
    const logged: string[] = [];
    const log = createAuthRefusalLog(createLogger({ sink: (line) => logged.push(line) }));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T00:00:10Z'));
    for (let i = 0; i < 50; i += 1)
      log.refused(refusal(401, 'Token has expired'), peer('192.0.2.1'));
    log.refused(refusal(401, 'Missing Authorization header'), peer('192.0.2.1'));
    log.refused(refusal(401, 'Token has expired'), peer('192.0.2.2'));
    // A 403 is never collapsed: each names a signed-in account turned away.
    log.refused(refusal(403, 'signed-in account is not on the allowlist'), peer('192.0.2.1'));
    log.refused(refusal(403, 'signed-in account is not on the allowlist'), peer('192.0.2.1'));
    const parsed = (): Record<string, unknown>[] =>
      logged.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed().map((entry) => entry.msg)).toEqual([
      'mcp request refused: not authenticated',
      'mcp request refused: not authenticated',
      'mcp request refused: not allowed',
      'mcp request refused: not allowed',
    ]);
    expect(parsed()[0]).toMatchObject({ reason: 'Token has expired', address: '192.0.2.1' });
    // At the end of the minute the count goes out, even with no 401 after it.
    vi.advanceTimersByTime(60_000);
    const repeated = parsed().filter(
      (entry) => entry.msg === 'mcp request refused: not authenticated, repeated',
    );
    // The address that refused once has nothing to repeat.
    expect(repeated).toHaveLength(1);
    expect(repeated[0]).toMatchObject({
      address: '192.0.2.1',
      repeated: 50,
      reasons: { 'Token has expired': 49, 'Missing Authorization header': 1 },
    });
    // A new minute writes the first line again.
    log.refused(refusal(401, 'Token has expired'), peer('192.0.2.1'));
    expect(parsed().at(-1)).toMatchObject({ msg: 'mcp request refused: not authenticated' });
    log.close();
  });

  it('names the account kind and client on every line, never a token', async () => {
    await start({}, false);
    const stranger = await provider.token({
      sub: 'sub-stranger',
      aud: PUBLIC_MCP_URL,
      client_id: 'client_01ABC',
    });
    expect((await discover(stranger)).status).toBe(403);
    expect(
      events().find((entry) => entry.msg === 'mcp request refused: not allowed'),
    ).toMatchObject({
      accountKind: 'invitee',
      oauthClientId: 'client_01ABC',
      address: '127.0.0.1',
    });
    expect(lines.join('\n')).not.toContain(stranger);
    expect(lines.join('\n')).not.toContain('sub-stranger');
  });
});

describe('a token signed by a key the provider does not publish, with every claim right', () => {
  it('is still refused', async () => {
    await start();
    const { privateKey } = await generateKeyPair('RS256');
    const forged = await new SignJWT({ sub: 'sub-alice', aud: PUBLIC_MCP_URL, jti: 'x' })
      .setProtectedHeader({ alg: 'RS256', kid: 'not-published' })
      .setIssuer(provider.issuer)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
    expectChallenge(await discover(forged), /key the provider does not publish/);
  });
});

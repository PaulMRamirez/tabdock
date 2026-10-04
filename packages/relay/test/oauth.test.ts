// The oauth plugin against a stand-in identity provider (ADR 0013): what it
// demands of the provider before the relay starts, which tokens it accepts,
// the challenge every refused /mcp request gets on both MCP legs before either
// runs, the protected resource metadata, and the client SDK's own sign-in from
// the first 401 to a tool call. The relay runs in public URL mode, the only
// mode the plugin works in, with the tunnel played by helpers/tunnel.ts.

import {
  Client,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPair, SignJWT, UnsecuredJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthOutcomeSchema,
  createLogger,
  createOAuthAuth,
  createRelay,
  type OAuthAuthOptions,
  type OAuthUser,
  type Relay,
} from '../src/index.ts';
import { JWKS_RETRY_MS } from '../src/oauth.ts';
import { PAGE_ORIGIN } from './helpers/page-client.ts';
import {
  goodMetadata,
  MOCK_SUBJECT,
  PAIR_CLIENT,
  startProvider,
  type TestProvider,
} from './helpers/provider.ts';
import {
  PUBLIC_MCP_URL,
  PUBLIC_METADATA_URL,
  PUBLIC_ORIGIN,
  type RawAnswer,
  rawRequest,
  tunnelFetch,
} from './helpers/tunnel.ts';

const USERS: OAuthUser[] = [
  { sub: 'sub-alice', userId: 'alice', displayName: 'Alice' },
  { sub: MOCK_SUBJECT, userId: 'john', displayName: 'John' },
];

let provider: TestProvider;
let relay: Relay | undefined;
let lines: string[] = [];
/** What the relay hands a plugin's start(); a test that starts one by hand passes this. */
const START = { log: createLogger({ sink: () => undefined }) };

beforeEach(async () => {
  provider = await startProvider();
  lines = [];
});

afterEach(async () => {
  await relay?.close();
  relay = undefined;
  // A test may have stopped it already to play an outage.
  await provider.stop().catch(() => undefined);
});

function plugin(overrides: Partial<OAuthAuthOptions> = {}): ReturnType<typeof createOAuthAuth> {
  return createOAuthAuth({
    issuer: provider.issuer,
    resource: PUBLIC_MCP_URL,
    users: USERS,
    ...overrides,
  });
}

async function startPublicRelay(overrides: Partial<OAuthAuthOptions> = {}): Promise<Relay> {
  relay = await createRelay({
    auth: plugin(overrides),
    publicUrl: PUBLIC_ORIGIN,
    pairClient: PAIR_CLIENT,
    allowedOrigins: [PAGE_ORIGIN],
    port: 0,
    logLevel: 'debug',
    logSink: (line) => {
      lines.push(line);
    },
  });
  return relay;
}

/** A token the relay should accept: Alice's, for the public MCP URL. */
function aliceToken(claims: Record<string, unknown> = {}): Promise<string> {
  return provider.token({ sub: 'sub-alice', aud: PUBLIC_MCP_URL, ...claims });
}

const now = (): number => Math.floor(Date.now() / 1000);

const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';

/** The MCP requests a client may open with, one per leg and method that matters. */
const OPENERS: { name: string; method: string; headers: Record<string, string>; body?: unknown }[] =
  [
    {
      name: '2025 initialize',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LEGACY,
          capabilities: {},
          clientInfo: { name: 'raw', version: '1.0.0' },
        },
      },
    },
    {
      name: '2025 session stream',
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'Mcp-Session-Id': '00000000-0000-4000-8000-000000000000',
        'Mcp-Protocol-Version': LEGACY,
      },
    },
    {
      name: '2026-07-28 server/discover',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Protocol-Version': MODERN,
        'Mcp-Method': 'server/discover',
      },
      body: {
        jsonrpc: '2.0',
        id: 'discover-1',
        method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MODERN,
            'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      },
    },
    {
      name: '2026-07-28 tools/call',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Protocol-Version': MODERN,
        'Mcp-Method': 'tools/call',
      },
      body: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'list_pages',
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MODERN,
            'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      },
    },
  ];

const DISCOVER = OPENERS[2];
const INITIALIZE = OPENERS[0];

function send(
  opener: (typeof OPENERS)[number] | undefined,
  authorization?: string,
  host?: string,
): Promise<RawAnswer> {
  if (!relay || !opener) throw new Error('no relay');
  return rawRequest(relay.url, '/mcp', {
    method: opener.method,
    ...(host === undefined ? {} : { host }),
    headers: {
      ...opener.headers,
      ...(authorization === undefined ? {} : { Authorization: authorization }),
    },
    ...(opener.body === undefined ? {} : { body: JSON.stringify(opener.body) }),
  });
}

/** The 401 that starts Claude's sign-in: invalid_token, the metadata URL, an OAuth error body. */
function expectChallenge(answer: RawAnswer, description?: RegExp): void {
  expect(answer.status, answer.body).toBe(401);
  const challenge = answer.headers.get('www-authenticate') ?? '';
  expect(challenge).toMatch(/^Bearer /);
  expect(challenge).toContain('error="invalid_token"');
  expect(challenge).toContain(`resource_metadata="${PUBLIC_METADATA_URL}"`);
  if (description) expect(challenge).toMatch(description);
  // An OAuth error body, not JSON-RPC: the refusal came before any MCP code ran.
  const body = JSON.parse(answer.body) as Record<string, unknown>;
  expect(body.error).toBe('invalid_token');
  expect(body).not.toHaveProperty('jsonrpc');
}

describe('the provider the relay will start with (ADR 0013)', () => {
  it('starts against a provider Claude can use, found through RFC 8414', async () => {
    await startPublicRelay();
    expect(relay?.publicMcpUrl).toBe(PUBLIC_MCP_URL);
  });

  it('refuses metadata that names another issuer, even one differing by a trailing slash', async () => {
    provider.oauthMetadata = { ...goodMetadata(provider.issuer), issuer: `${provider.issuer}/x` };
    await expect(startPublicRelay()).rejects.toThrow(/names issuer .*TABDOCK_OAUTH_ISSUER/);
    provider.oauthMetadata = goodMetadata(provider.issuer);
    await expect(startPublicRelay({ issuer: `${provider.issuer}/` })).rejects.toThrow(
      /names issuer/,
    );
  });

  it('refuses a provider without S256 PKCE', async () => {
    provider.oauthMetadata = {
      ...goodMetadata(provider.issuer),
      code_challenge_methods_supported: ['plain'],
    };
    await expect(startPublicRelay()).rejects.toThrow(/S256/);
    provider.oauthMetadata = {
      ...goodMetadata(provider.issuer),
      code_challenge_methods_supported: undefined,
    };
    await expect(startPublicRelay()).rejects.toThrow(/S256/);
  });

  it('needs client ID metadata documents with "none", or a registration endpoint', async () => {
    const base = goodMetadata(provider.issuer);
    provider.oauthMetadata = { ...base, client_id_metadata_document_supported: false };
    await expect(startPublicRelay()).rejects.toThrow(/neither client ID metadata documents/);
    provider.oauthMetadata = {
      ...base,
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
    };
    await expect(startPublicRelay()).rejects.toThrow(/neither client ID metadata documents/);
    provider.oauthMetadata = {
      ...base,
      client_id_metadata_document_supported: undefined,
      registration_endpoint: `${provider.issuer}/register`,
    };
    await startPublicRelay();
  });

  it('falls back to OpenID Connect discovery as Claude does, and refuses a provider with neither', async () => {
    provider.oauthMetadata = null;
    provider.oidcMetadata = goodMetadata(provider.issuer);
    await startPublicRelay();
    await relay?.close();
    relay = undefined;
    provider.oidcMetadata = null;
    await expect(startPublicRelay()).rejects.toThrow(/publishes no metadata .*answered 404/);
  });

  it('refuses metadata that is malformed or points its keys at plain http', async () => {
    provider.oauthMetadata = { issuer: provider.issuer };
    await expect(startPublicRelay()).rejects.toThrow(/lacks or misstates .*jwks_uri/);
    provider.oauthMetadata = {
      ...goodMetadata(provider.issuer),
      jwks_uri: 'http://idp.example/jwks',
    };
    await expect(startPublicRelay()).rejects.toThrow(/jwks_uri is not an https URL/);
  });

  it('refuses a provider it cannot reach', async () => {
    await expect(plugin({ issuer: 'http://127.0.0.1:1' }).start?.(START)).rejects.toThrow(
      /cannot reach the identity provider/,
    );
  });

  it('refuses settings it cannot use before fetching anything', () => {
    for (const issuer of ['http://idp.example', 'idp.example', 'https://idp.example/?tenant=1']) {
      expect(() => plugin({ issuer }), issuer).toThrow(/TABDOCK_OAUTH_ISSUER/);
    }
    expect(() => plugin({ resource: 'http://relay.test/mcp' })).toThrow(/https URL/);
    expect(() => plugin({ users: [] })).toThrow(/at least one user/);
    expect(() =>
      plugin({ users: [...USERS, { ...USERS[0], userId: 'alice2' } as OAuthUser] }),
    ).toThrow(/sub listed twice/);
    expect(() =>
      plugin({ users: [...USERS, { sub: 'other', userId: 'alice', displayName: 'A' }] }),
    ).toThrow(/listed twice/);
    expect(() => plugin({ users: [{ sub: 'has space', userId: 'x', displayName: 'X' }] })).toThrow(
      /printable/,
    );
    expect(() => plugin({ users: [{ sub: 's', userId: 'not valid!', displayName: 'X' }] })).toThrow(
      /user ids/,
    );
  });
});

describe('tokens (ADR 0013)', () => {
  beforeEach(async () => {
    await startPublicRelay();
  });

  it('accepts a valid token on both legs', async () => {
    const token = await aliceToken();
    const discovered = await send(DISCOVER, `Bearer ${token}`);
    expect(discovered.status, discovered.body).toBe(200);
    const initialized = await send(INITIALIZE, `Bearer ${token}`);
    expect(initialized.status, initialized.body).toBe(200);
    expect(initialized.headers.get('mcp-session-id')).toBeTruthy();
    // An audience list that includes this resource is a token for it too.
    const listed = await aliceToken({ aud: ['https://other.test/api', PUBLIC_MCP_URL] });
    expect((await send(DISCOVER, `Bearer ${listed}`)).status).toBe(200);
  });

  it.each<[string, () => Promise<string>, RegExp]>([
    ['expired', () => aliceToken({ exp: now() - 60 }), /has expired/],
    [
      'for another resource',
      () => aliceToken({ aud: 'https://other.test/mcp' }),
      /not issued for this resource/,
    ],
    [
      'with no audience',
      () => aliceToken({ aud: undefined }),
      /not issued for this resource|claims are invalid/,
    ],
    ['from another issuer', () => aliceToken({ iss: 'https://idp.example' }), /expected provider/],
    ['without an expiry', () => aliceToken({ exp: undefined }), /no valid expiry/],
    ['not valid yet', () => aliceToken({ nbf: now() + 600 }), /not valid yet/],
    [
      'unsigned (alg none)',
      () =>
        Promise.resolve(
          new UnsecuredJWT({ sub: 'sub-alice', aud: PUBLIC_MCP_URL })
            .setIssuer(provider.issuer)
            .setIssuedAt()
            .setExpirationTime('1h')
            .encode(),
        ),
      /not signed with RS256/,
    ],
    [
      'signed with a key the provider does not publish',
      async () => {
        const { privateKey } = await generateKeyPair('RS256');
        return new SignJWT({ sub: 'sub-alice', aud: PUBLIC_MCP_URL })
          .setProtectedHeader({ alg: 'RS256', kid: 'not-published' })
          .setIssuer(provider.issuer)
          .setIssuedAt()
          .setExpirationTime('1h')
          .sign(privateKey);
      },
      /key the provider does not publish/,
    ],
    [
      'with its signature altered',
      async () => {
        // A real header and signature over a payload the provider never signed.
        const [header, , signature] = (await aliceToken()).split('.');
        const forged = Buffer.from(
          JSON.stringify({
            sub: 'sub-alice',
            aud: PUBLIC_MCP_URL,
            iss: provider.issuer,
            exp: now() + 86_400,
          }),
        ).toString('base64url');
        return `${header ?? ''}.${forged}.${signature ?? ''}`;
      },
      /signature is invalid/,
    ],
    ['that is not a JWT at all', () => Promise.resolve('not-a-jwt'), /malformed/],
  ])('refuses a token %s with the sign-in challenge', async (_name, make, description) => {
    const token = await make();
    for (const opener of [DISCOVER, INITIALIZE]) {
      expectChallenge(await send(opener, `Bearer ${token}`), description);
    }
  });

  it('turns away a signed-in account that is not on the allowlist with a plain 403', async () => {
    const token = await provider.token({ sub: 'sub-stranger', aud: PUBLIC_MCP_URL });
    for (const opener of [DISCOVER, INITIALIZE]) {
      const answer = await send(opener, `Bearer ${token}`);
      expect(answer.status).toBe(403);
      // No challenge: insufficient_scope would only send Claude round to sign in again.
      expect(answer.headers.get('www-authenticate')).toBeNull();
      expect(answer.body).toBe('This account is not allowed on this relay');
    }
  });

  it('maps a subject to its kind of account once, for /mcp and /pair alike (ADR 0016)', async () => {
    const auth = plugin();
    const signIn = auth.browserSignIn;
    if (signIn === undefined) throw new Error('the oauth plugin offers no browser sign-in');
    // Nothing to sign a browser in with until the provider's metadata is read.
    expect(signIn.provider()).toBeNull();
    await auth.start?.(START);
    expect(signIn.provider()).toMatchObject({
      issuer: provider.issuer,
      authorization_endpoint: `${provider.issuer}/authorize`,
      token_endpoint: `${provider.issuer}/token`,
      jwks_uri: `${provider.issuer}/jwks`,
    });
    expect(signIn.accountOf('sub-alice')).toEqual({
      kind: 'member',
      user: { userId: 'alice', displayName: 'Alice' },
    });
    const stranger = signIn.accountOf('sub-stranger');
    expect(stranger.kind).toBe('invitee');
    // Known by a key that does not carry the subject, and the same key every time.
    expect(JSON.stringify(stranger)).not.toContain('stranger');
    expect(signIn.accountOf('sub-stranger')).toEqual(stranger);
    expect(signIn.accountOf('sub-other')).not.toEqual(stranger);
    // The user a subject signs in as, named once for /mcp, /pair and /i (ADR 0017).
    expect(signIn.userOf('sub-alice', 'alice@example.com')).toEqual({
      userId: 'alice',
      displayName: 'Alice',
      account: { kind: 'member', email: null },
    });
    if (stranger.kind !== 'invitee') throw new Error('expected an invitee');
    expect(signIn.userOf('sub-stranger', 'guest@example.com')).toEqual({
      userId: `g_${stranger.key}`,
      displayName: 'guest@example.com',
      account: { kind: 'invitee', email: 'guest@example.com' },
    });
    expect(signIn.userOf('sub-stranger', null)).toMatchObject({
      displayName: 'unverified account',
      account: { kind: 'invitee', email: null },
    });
    // A name that folds to a member's shows the short id instead.
    const lookalike = createOAuthAuth({
      issuer: provider.issuer,
      resource: PUBLIC_MCP_URL,
      users: [{ sub: 'sub-alice', userId: 'alice', displayName: 'ALICE@Example.com' }],
    }).browserSignIn;
    expect(lookalike?.userOf('sub-stranger', 'alice@example.com').displayName).toBe(
      `invitee ${stranger.key.slice(0, 8)}`,
    );
  });

  it('vouches for an account off the allowlist as an invitee, and leaves admitting it to the relay (ADR 0020)', async () => {
    const auth = plugin();
    await auth.start?.(START);
    const token = await provider.token({
      sub: 'sub-stranger',
      aud: PUBLIC_MCP_URL,
      client_id: 'client_01ABC',
    });
    const outcome = await auth.authenticate({
      headers: { authorization: `Bearer ${token}` },
    } as unknown as IncomingMessage);
    expect(AuthOutcomeSchema.parse(outcome)).toEqual(outcome);
    expect(outcome).toMatchObject({
      kind: 'user',
      user: { displayName: 'unverified account', account: { kind: 'invitee', email: null } },
      oauthClientId: 'client_01ABC',
    });
    expect(JSON.stringify(outcome)).not.toContain('sub-stranger');
  });

  it.each<[string, string | undefined]>([
    ['no Authorization header', undefined],
    ['Basic credentials', 'Basic YWxpY2U6c2VjcmV0'],
    ['a bare Bearer', 'Bearer'],
    ['Bearer and spaces', 'Bearer   '],
    ['another scheme', 'Token abc'],
    ['an oversized header', `Bearer ${'x'.repeat(9000)}`],
  ])(
    'answers %s with the challenge on every leg, before any MCP code runs',
    async (_name, header) => {
      for (const opener of OPENERS) {
        const answer = await send(opener, header);
        expectChallenge(answer);
      }
      // Through the tunnel the same.
      expectChallenge(await send(DISCOVER, header, new URL(PUBLIC_ORIGIN).host));
    },
  );

  it('logs every refusal with its reason, and never a token or a subject', async () => {
    const good = await aliceToken();
    const expired = await aliceToken({ exp: now() - 60 });
    const stranger = await provider.token({ sub: 'sub-stranger-7f3a', aud: PUBLIC_MCP_URL });
    await send(DISCOVER, `Bearer ${good}`);
    await send(DISCOVER, `Bearer ${expired}`);
    await send(DISCOVER, `Bearer ${stranger}`);
    await send(DISCOVER);
    const all = lines.join('\n');
    for (const token of [good, expired, stranger]) {
      expect(all).not.toContain(token);
      // Not even a piece of one: the signature is the secret part.
      expect(all).not.toContain(token.split('.')[2]);
    }
    expect(all).not.toContain('sub-stranger-7f3a');
    expect(all).not.toContain('sub-alice');
    const refusals = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => String(entry.msg).startsWith('mcp request refused'));
    expect(refusals.map((entry) => [entry.msg, entry.reason])).toEqual([
      ['mcp request refused: not authenticated', 'Token has expired'],
      ['mcp request refused: not allowed', 'signed-in account is not on the allowlist'],
      ['mcp request refused: not authenticated', 'Missing Authorization header'],
    ]);
    // Each names the client address the relay resolved, here the socket's peer.
    for (const entry of refusals) expect(entry.address).toBe('127.0.0.1');
  });

  it("answers 503, not 401, when the provider's keys cannot be fetched", async () => {
    const token = await aliceToken();
    await provider.stop();
    const answer = await send(DISCOVER, `Bearer ${token}`);
    expect(answer.status).toBe(503);
    expect(answer.headers.get('retry-after')).toBe('5');
    expect(answer.headers.get('www-authenticate')).toBeNull();
    expect(lines.join('\n')).toContain('identity provider keys unreachable');
  });
});

describe("the provider's key set while it cannot be fetched", () => {
  /**
   * Stands in for the provider's jwks_uri: counts every fetch, and while
   * `failing` answers 500 as a provider in trouble would, else passes the
   * provider's real key set on.
   */
  const keySet = { fetches: 0, failing: false };
  let keyServer: Server | undefined;
  /** jose's default cacheMaxAge, which the plugin keeps: past it a lookup refetches. */
  const JOSE_CACHE_MAX_AGE_MS = 10 * 60_000;
  /** Shaped like a provider token (RS256), so it reaches the key lookup, but signed by nobody. */
  const forged = (kid: string): string => {
    const part = (value: unknown): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    return `Bearer ${part({ alg: 'RS256', kid })}.${part({ sub: 'x' })}.${part('sig')}`;
  };

  beforeEach(async () => {
    keySet.fetches = 0;
    keySet.failing = false;
    const server = createServer((_request, response) => {
      keySet.fetches += 1;
      if (keySet.failing) {
        response.writeHead(500, { 'Content-Type': 'text/plain' });
        response.end('down');
        return;
      }
      fetch(`${provider.issuer}/jwks`)
        .then(async (upstream) => {
          response.writeHead(upstream.status, { 'Content-Type': 'application/json' });
          response.end(await upstream.text());
        })
        .catch(() => {
          response.writeHead(502);
          response.end();
        });
    });
    keyServer = server;
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    provider.oauthMetadata = {
      ...goodMetadata(provider.issuer),
      jwks_uri: `http://127.0.0.1:${String(port)}/jwks`,
    };
    await startPublicRelay();
  });

  afterEach(async () => {
    vi.useRealTimers();
    const server = keyServer;
    keyServer = undefined;
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  it('fetches once per Retry-After from a cold start, whatever tokens arrive, then works once the keys are back', async () => {
    // Only Date is faked: jose and the plugin time the key set by it, and the test steps it.
    vi.useFakeTimers({ toFake: ['Date'] });
    keySet.failing = true;
    const token = `Bearer ${await aliceToken()}`;
    const answers: RawAnswer[] = [];
    for (let index = 0; index < 10; index += 1) {
      answers.push(await send(DISCOVER, index % 2 === 0 ? token : forged(`kid-${String(index)}`)));
    }
    answers.push(
      ...(await Promise.all(Array.from({ length: 10 }, () => send(DISCOVER, forged('spray'))))),
    );
    for (const answer of answers) {
      expect(answer.status, answer.body).toBe(503);
      expect(answer.headers.get('www-authenticate')).toBeNull();
    }
    const retryAfter = Number(answers[0]?.headers.get('retry-after'));
    expect(retryAfter).toBe(5);
    expect(keySet.fetches).toBe(1);

    // The provider is back, but the relay waits out the time it asked clients to wait.
    keySet.failing = false;
    vi.setSystemTime(Date.now() + retryAfter * 1000 - 1);
    expect((await send(DISCOVER, token)).status).toBe(503);
    expect(keySet.fetches).toBe(1);
    vi.setSystemTime(Date.now() + 1);
    const back = await send(DISCOVER, token);
    expect(back.status, back.body).toBe(200);
    expect(keySet.fetches).toBe(2);
    // Cached again: valid tokens pass and forged ones are refused, with no fetch for either.
    expect((await send(DISCOVER, token)).status).toBe(200);
    expectChallenge(await send(DISCOVER, forged('spray')), /key the provider does not publish/);
    expect(keySet.fetches).toBe(2);
  });

  it('checks tokens with the keys jose still holds while a fetch waits, never past their cache life', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetchedAt = Date.now();
    expect((await send(DISCOVER, `Bearer ${await aliceToken()}`)).status).toBe(200);
    expect(keySet.fetches).toBe(1);

    // An unknown key sends jose to the provider, which fails: the wait begins.
    keySet.failing = true;
    vi.setSystemTime(fetchedAt + 60_000);
    const unknown = await send(DISCOVER, forged('published-since'));
    expect(unknown.status).toBe(503);
    expect(unknown.headers.get('retry-after')).toBe('5');
    expect(keySet.fetches).toBe(2);
    // Meanwhile the keys jose holds still check tokens, with no fetch: a valid
    // token passes and an altered one is the token's fault.
    expect((await send(DISCOVER, `Bearer ${await aliceToken()}`)).status).toBe(200);
    const [header, , signature] = (await aliceToken()).split('.');
    const altered = Buffer.from(
      JSON.stringify({
        sub: 'sub-alice',
        aud: PUBLIC_MCP_URL,
        iss: provider.issuer,
        exp: now() + 600,
      }),
    ).toString('base64url');
    expectChallenge(
      await send(DISCOVER, `Bearer ${header ?? ''}.${altered}.${signature ?? ''}`),
      /signature is invalid/,
    );
    expect(keySet.fetches).toBe(2);

    // Past jose's cache life the held keys are trusted no longer.
    vi.setSystemTime(fetchedAt + JOSE_CACHE_MAX_AGE_MS + 1);
    expect((await send(DISCOVER, `Bearer ${await aliceToken()}`)).status).toBe(503);
    expect(keySet.fetches).toBe(3);
    expect((await send(DISCOVER, `Bearer ${await aliceToken()}`)).status).toBe(503);
    expect(keySet.fetches).toBe(3);
    // Once a fetch succeeds again, the fresh keys take over.
    keySet.failing = false;
    vi.setSystemTime(Date.now() + JWKS_RETRY_MS);
    expect((await send(DISCOVER, `Bearer ${await aliceToken()}`)).status).toBe(200);
    expect(keySet.fetches).toBe(4);
  });

  it('treats a clock set back as more waiting, not as a reason to fetch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    keySet.failing = true;
    const token = `Bearer ${await aliceToken()}`;
    expect((await send(DISCOVER, token)).status).toBe(503);
    expect(keySet.fetches).toBe(1);
    for (let step = 0; step < 3; step += 1) {
      vi.setSystemTime(Date.now() - 1);
      expect((await send(DISCOVER, token)).status).toBe(503);
    }
    expect(keySet.fetches).toBe(1);
    // The wait restarted at the earliest time seen, and runs its full length from there.
    keySet.failing = false;
    vi.setSystemTime(Date.now() + JWKS_RETRY_MS - 1);
    expect((await send(DISCOVER, token)).status).toBe(503);
    expect(keySet.fetches).toBe(1);
    vi.setSystemTime(Date.now() + 1);
    expect((await send(DISCOVER, token)).status).toBe(200);
    expect(keySet.fetches).toBe(2);
  });
});

describe('protected resource metadata (RFC 9728)', () => {
  beforeEach(async () => {
    await startPublicRelay();
  });

  it('is served at the path-inserted URL, naming the provider as the only authorization server and no scopes', async () => {
    if (!relay) throw new Error('no relay');
    const expected = {
      resource: PUBLIC_MCP_URL,
      authorization_servers: [provider.issuer],
      resource_name: 'Tabdock relay',
    };
    for (const host of [undefined, new URL(PUBLIC_ORIGIN).host]) {
      const answer = await rawRequest(relay.url, '/.well-known/oauth-protected-resource/mcp', {
        ...(host === undefined ? {} : { host }),
      });
      expect(answer.status).toBe(200);
      expect(answer.headers.get('content-type')).toMatch(/^application\/json/);
      // Exactly these fields: no scopes_supported, so no offline_access either.
      expect(JSON.parse(answer.body)).toEqual(expected);
    }
    // The challenge points exactly there.
    const challenge = (await send(DISCOVER)).headers.get('www-authenticate') ?? '';
    expect(new URL(PUBLIC_METADATA_URL).pathname).toBe('/.well-known/oauth-protected-resource/mcp');
    expect(challenge).toContain(PUBLIC_METADATA_URL);
  });

  it('serves nothing at the root forms, answers HEAD, refuses other methods and foreign hosts', async () => {
    if (!relay) throw new Error('no relay');
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
    ]) {
      expect((await rawRequest(relay.url, path)).status, path).toBe(404);
    }
    const path = '/.well-known/oauth-protected-resource/mcp';
    const head = await rawRequest(relay.url, path, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    const post = await rawRequest(relay.url, path, { method: 'POST', body: '{}' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
    expect((await rawRequest(relay.url, path, { host: 'evil.example' })).status).toBe(403);
  });
});

/**
 * An OAuth client as an MCP host keeps one: Claude Code's shape, a client ID
 * metadata document URL as client id, with a loopback redirect nobody serves,
 * since the test reads the code off the provider's redirect itself.
 */
class SignInProvider implements OAuthClientProvider {
  readonly clientMetadataUrl = 'https://client.test/oauth/client-metadata.json';
  authorizationUrl: URL | undefined;
  #client: StoredOAuthClientInformation | undefined;
  #tokens: StoredOAuthTokens | undefined;
  #verifier = '';
  #discovery: OAuthDiscoveryState | undefined;

  get redirectUrl(): string {
    return 'http://localhost:53682/callback';
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'tabdock relay test',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    return this.#client;
  }

  saveClientInformation(info: StoredOAuthClientInformation): void {
    this.#client = info;
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.#tokens;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this.#tokens = tokens;
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.#verifier = verifier;
  }

  codeVerifier(): string {
    return this.#verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.#discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#discovery;
  }
}

describe("the client SDK's own sign-in, through relay and provider", () => {
  it('goes from the first 401 to a tool call on both protocol eras', async () => {
    const started = await startPublicRelay();
    const signIn = new SignInProvider();
    const viaTunnel = tunnelFetch(started.url);
    const transport = (): StreamableHTTPClientTransport =>
      new StreamableHTTPClientTransport(new URL(PUBLIC_MCP_URL), {
        authProvider: signIn,
        fetch: viaTunnel,
      });

    // 1. The first request is refused, and the SDK follows the challenge to the provider.
    const first = transport();
    await expect(
      new Client({ name: 'oauth-e2e', version: '1.0.0' }).connect(first),
    ).rejects.toThrow();
    const authorizationUrl = signIn.authorizationUrl;
    if (!authorizationUrl) throw new Error('the SDK never asked to sign in');
    expect(authorizationUrl.origin).toBe(new URL(provider.issuer).origin);
    expect(authorizationUrl.searchParams.get('resource')).toBe(PUBLIC_MCP_URL);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('client_id')).toBe(signIn.clientMetadataUrl);
    expect(authorizationUrl.searchParams.get('scope')).toBeNull();

    // 2. The provider signs the person in and sends the browser back with a code.
    const redirect = await fetch(authorizationUrl, { redirect: 'manual' });
    const location = redirect.headers.get('location');
    if (location === null) throw new Error('the provider did not redirect');
    const callback = new URL(location);
    expect(callback.origin + callback.pathname).toBe(signIn.redirectUrl);
    await first.finishAuth(callback.searchParams);
    expect(signIn.tokens()?.access_token).toBeTruthy();

    // 3. With the token, both eras connect and reach the fixed tools as John.
    for (const modern of [false, true]) {
      const client = new Client(
        { name: 'oauth-e2e', version: '1.0.0' },
        modern ? { versionNegotiation: { mode: { pin: MODERN } } } : {},
      );
      await client.connect(transport());
      const result = await client.callTool({ name: 'list_pages', arguments: {} });
      const text = result.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      expect(result.isError ?? false, text).toBe(false);
      expect(text).toMatch(/not attached to any page/);
      await client.close();
    }
    const accepted = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.msg === 'MCP session opened');
    expect(accepted.map((entry) => entry.userId)).toEqual(['john']);
  });
});

// The seams M4's workstreams build on, fixed after the interface review
// (docs/plans/M4.md, notes after the build): dev-token invitees and the one
// naming rule for invitees (ADR 0017); the relay, not the plugin, deciding
// whether an invitee is admitted, and refusals that can name the account kind
// and client (ADR 0020); the plugin's start context and stop hook; the
// client_id an attach request keeps for its attach record (ADR 0019); the
// sign-in gate (ADR 0018); and the hub's holds(). None changes behaviour:
// every invitee still gets M3's 403, with TABDOCK_INVITES on or off.

import type { Client } from '@modelcontextprotocol/client';
import { MAX_DISPLAY_NAME_CHARS } from '@tabdock/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../src/config.ts';
import { PageHub } from '../src/hub.ts';
import {
  type AuthOutcome,
  AuthOutcomeSchema,
  type AuthPlugin,
  type AuthStartContext,
  createDevTokenAuth,
  createLogger,
  createMemoryStore,
  createOAuthAuth,
  createRelay,
  createSignInGate,
  type DevTokenUser,
  foldName,
  inviteeUser,
  loadConfigFromEnv,
  parseDevTokens,
  parseOAuthUsers,
} from '../src/index.ts';
import { connectPage, PAGE_ORIGIN, type TestPage, TOOLS } from './helpers/page-client.ts';
import { PAIR_CLIENT } from './helpers/provider.ts';
import { ALICE, callTool, connectClient, startRelay, type TestRelay } from './helpers/relay.ts';
import { PUBLIC_MCP_URL, PUBLIC_ORIGIN } from './helpers/tunnel.ts';

const relays: TestRelay[] = [];
const pages: TestPage[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const page of pages.splice(0)) page.ws.terminate();
  for (const relay of relays.splice(0)) await relay.close();
});

const KEY = '0123456789abcdef'.repeat(2);
const GUEST: DevTokenUser = {
  userId: `g_${KEY}`,
  displayName: 'ignored',
  token: 'guest-dev-token-5a8c1e7f2b9d4063',
  kind: 'invitee',
};

function thrown(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected an error');
}

/** A bare POST to /mcp with a bearer token: sign-in runs before the body is read. */
async function mcpPost(url: string, token: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

describe('dev-token invitees (ADR 0017)', () => {
  it('read an entry with an invitee id as an invitee, named as unverified', () => {
    const users = parseDevTokens(`alice=${ALICE.token}, g_${KEY}=${GUEST.token}`);
    expect(users).toEqual([
      { userId: 'alice', displayName: 'alice', token: ALICE.token },
      {
        userId: `g_${KEY}`,
        displayName: 'unverified account',
        token: GUEST.token,
        kind: 'invitee',
      },
    ]);
  });

  it('refuse any other id starting g_, for members everywhere, never echoing a token', () => {
    const message = thrown(() => parseDevTokens(`alice=${ALICE.token},g_alice=${GUEST.token}`));
    expect(message).toMatch(/TABDOCK_DEV_TOKENS entry 2 has a user id starting g_/);
    expect(message).not.toContain(GUEST.token);
    expect(() => createDevTokenAuth([{ ...ALICE, userId: 'g_alice' }])).toThrow(/starts with g_/);
    expect(() => createDevTokenAuth([{ ...GUEST, userId: 'guest' }])).toThrow(
      /needs an invitee's id/,
    );
    expect(() => createDevTokenAuth([{ ...ALICE, kind: 'guest' as unknown as 'member' }])).toThrow(
      /neither member nor invitee/,
    );
    expect(() => parseOAuthUsers('user_01=g_alice:Alice')).toThrow(
      /TABDOCK_OAUTH_USERS entry 1 has a user id starting g_/,
    );
    expect(() =>
      createOAuthAuth({
        issuer: 'https://idp.example',
        resource: PUBLIC_MCP_URL,
        users: [{ sub: 'user_01', userId: `g_${KEY}`, displayName: 'Alice' }],
      }),
    ).toThrow(/starts with g_/);
  });

  it('are refused by name without TABDOCK_INVITES, and taken with it', () => {
    const env = { TABDOCK_DEV_TOKENS: `alice=${ALICE.token},g_${KEY}=${GUEST.token}` };
    const message = thrown(() => loadConfigFromEnv(env));
    expect(message).toMatch(/TABDOCK_DEV_TOKENS entry 2 names an invitee.*TABDOCK_INVITES/);
    expect(message).not.toContain(GUEST.token);
    expect(resolveConfig(loadConfigFromEnv({ ...env, TABDOCK_INVITES: '1' })).invites).toBe(true);
  });

  it('authenticate as invitees through the one naming rule', async () => {
    const auth = createDevTokenAuth([ALICE, GUEST]);
    const outcome = await auth.authenticate({
      headers: { authorization: `Bearer ${GUEST.token}` },
    } as never);
    expect(outcome).toEqual({
      kind: 'user',
      user: {
        userId: `g_${KEY}`,
        displayName: 'unverified account',
        account: { kind: 'invitee', email: null },
      },
      oauthClientId: null,
    });
    expect(AuthOutcomeSchema.parse(outcome)).toEqual(outcome);
    // A member already called that pushes the invitee to its short id.
    const named = createDevTokenAuth([{ ...ALICE, displayName: 'Unverified Account' }, GUEST]);
    const renamed = await named.authenticate({
      headers: { authorization: `Bearer ${GUEST.token}` },
    } as never);
    expect(renamed).toMatchObject({ user: { displayName: `invitee ${KEY.slice(0, 8)}` } });
  });

  it("get M3's 403 on /mcp with invites on or off, until workstream A admits them", async () => {
    for (const invites of [false, true]) {
      const relay = await startRelay({ auth: createDevTokenAuth([ALICE, GUEST]), invites });
      relays.push(relay);
      const answer = await mcpPost(relay.relay.mcpUrl, GUEST.token);
      expect(answer.status, String(invites)).toBe(403);
      expect(answer.headers.get('www-authenticate')).toBeNull();
      expect(await answer.text()).toBe('This account is not allowed on this relay');
      const refused = relay.lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.msg === 'mcp request refused: not allowed');
      expect(refused).toEqual([
        expect.objectContaining({
          reason: 'signed-in account is not on the allowlist',
          address: '127.0.0.1',
        }),
      ]);
      expect(relay.lines.join('\n')).not.toContain(GUEST.token);
      // A member on the same relay is served as ever.
      const alice = await connectClient(relay.relay, ALICE);
      clients.push(alice);
      expect((await callTool(alice, 'list_pages')).isError).toBe(false);
    }
  });
});

describe('inviteeUser, the one naming rule (ADR 0017)', () => {
  it('names an invitee by its verified email, or as unverified', () => {
    expect(inviteeUser(KEY, 'guest@example.com', ['Alice'])).toEqual({
      userId: `g_${KEY}`,
      displayName: 'guest@example.com',
      account: { kind: 'invitee', email: 'guest@example.com' },
    });
    expect(inviteeUser(KEY, null, [])).toMatchObject({
      displayName: 'unverified account',
      account: { email: null },
    });
    // An email that is no email counts as none.
    expect(inviteeUser(KEY, 'not an email', [])).toMatchObject({
      displayName: 'unverified account',
      account: { email: null },
    });
  });

  it('cuts a long email to 97 characters and ..., never inside a surrogate pair', () => {
    const long = `${'a'.repeat(120)}@example.com`;
    const user = inviteeUser(KEY, long, []);
    expect(user.displayName).toBe(`${'a'.repeat(97)}...`);
    expect(user.account.email).toBe(long);
    const emoji = `${'a'.repeat(96)}\u{1F600}${'b'.repeat(10)}@example.com`;
    const cut = inviteeUser(KEY, emoji, []).displayName;
    expect(cut).toBe(`${'a'.repeat(96)}...`);
    expect(cut.length).toBeLessThanOrEqual(MAX_DISPLAY_NAME_CHARS);
    expect(
      AuthOutcomeSchema.safeParse({
        kind: 'user',
        user: inviteeUser(KEY, long, []),
        oauthClientId: null,
      }).success,
    ).toBe(true);
  });

  it.each([
    ['in another case', 'ALICE@Example.COM', 'alice@example.com'],
    ['in full-width letters', 'ａｌｉｃｅ@example.com', 'alice@example.com'],
    ['with a zero-width space', 'ali​ce@example.com', 'alice@example.com'],
    ['with a sharp s', 'strasse@example.com', 'STRAßE@example.com'],
  ])("shows the short id for a name that copies a member's %s", (_name, email, member) => {
    expect(foldName(email)).toBe(foldName(member));
    expect(inviteeUser(KEY, email, ['Bob', member]).displayName).toBe(`invitee ${KEY.slice(0, 8)}`);
  });
});

describe('auth outcomes (ADR 0020)', () => {
  const refusal = {
    kind: 'refused',
    status: 401,
    reason: 'no valid dev token',
    body: 'Unauthorized',
    headers: {},
    accountKind: null,
    oauthClientId: null,
  };

  it('carry the account kind and client_id on every refusal, checked', () => {
    expect(AuthOutcomeSchema.parse(refusal)).toEqual(refusal);
    const known = { ...refusal, status: 403, accountKind: 'invitee', oauthClientId: 'client_01' };
    expect(AuthOutcomeSchema.parse(known)).toEqual(known);
    for (const bad of [
      { ...refusal, accountKind: undefined },
      { ...refusal, oauthClientId: undefined },
      { ...refusal, accountKind: 'guest' },
      { ...refusal, oauthClientId: 'has space' },
    ]) {
      expect(AuthOutcomeSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("refuse a member whose id starts with an invitee's prefix", () => {
    const member: AuthOutcome = {
      kind: 'user',
      user: { userId: 'g_alice', displayName: 'Alice', account: { kind: 'member', email: null } },
      oauthClientId: null,
    };
    expect(AuthOutcomeSchema.safeParse(member).success).toBe(false);
  });
});

/** A dev-token plugin with a start and a stop that say when they ran. */
function watchedPlugin(overrides: Partial<AuthPlugin> = {}): {
  plugin: AuthPlugin;
  started: AuthStartContext[];
  stop: ReturnType<typeof vi.fn>;
} {
  const inner = createDevTokenAuth([ALICE]);
  const started: AuthStartContext[] = [];
  const stop = vi.fn();
  const plugin: AuthPlugin = {
    name: 'watched',
    authenticate: (request) => inner.authenticate(request),
    start(context) {
      started.push(context);
      return Promise.resolve();
    },
    stop,
    ...overrides,
  };
  return { plugin, started, stop };
}

describe("the auth plugin's start and stop (ADR 0020)", () => {
  it("starts with the relay's logger and stops once when the relay closes", async () => {
    const { plugin, started, stop } = watchedPlugin();
    const relay = await startRelay({ auth: plugin });
    expect(started).toHaveLength(1);
    started[0]?.log.info('from the plugin');
    expect(relay.lines.some((line) => line.includes('from the plugin'))).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    await relay.close();
    await relay.close();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('stops when its own start throws', async () => {
    const { plugin, stop } = watchedPlugin({
      start: () => Promise.reject(new Error('provider misconfigured')),
    });
    await expect(startRelay({ auth: plugin })).rejects.toThrow(/provider misconfigured/);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('stops when the relay cannot listen', async () => {
    const blocker = await startRelay();
    relays.push(blocker);
    const { plugin, stop } = watchedPlugin();
    await expect(
      createRelay({
        auth: plugin,
        port: Number(new URL(blocker.relay.url).port),
        logSink: () => undefined,
      }),
    ).rejects.toThrow(/EADDRINUSE/);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('stops when the /pair flow cannot be built', async () => {
    const { plugin, stop } = watchedPlugin({
      resource: PUBLIC_MCP_URL,
      browserSignIn: {
        // Never started, so there is no provider to sign a browser in at.
        provider: () => null,
        accountOf: () => ({ kind: 'member', user: { userId: 'alice', displayName: 'Alice' } }),
        userOf: () => ({
          userId: 'alice',
          displayName: 'Alice',
          account: { kind: 'member', email: null },
        }),
      },
    });
    await expect(
      createRelay({
        auth: plugin,
        publicUrl: PUBLIC_ORIGIN,
        pairClient: PAIR_CLIENT,
        allowedOrigins: [PAGE_ORIGIN],
        logSink: () => undefined,
      }),
    ).rejects.toThrow(/started first/);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("an attach request's client_id (ADR 0019)", () => {
  it('rides from the token to the request record, and the attachment says no invite made it', async () => {
    const inner = createDevTokenAuth([ALICE]);
    const plugin: AuthPlugin = {
      name: 'client-id',
      async authenticate(request) {
        const outcome = await inner.authenticate(request);
        return outcome.kind === 'user' ? { ...outcome, oauthClientId: 'client_01ABC' } : outcome;
      },
    };
    const store = createMemoryStore();
    const relay = await startRelay({ auth: plugin, store });
    relays.push(relay);
    const page = await connectPage(relay.relay.pageUrl, { tools: TOOLS });
    pages.push(page);
    const alice = await connectClient(relay.relay, ALICE);
    clients.push(alice);
    const pending = callTool(alice, 'pair_page', { code: page.code });
    const request = await page.next('attach_request');
    expect(store.requests.get(request.requestId)).toMatchObject({
      userId: 'alice',
      oauthClientId: 'client_01ABC',
      inviteId: null,
    });
    page.send({ t: 'attach_decision', requestId: request.requestId, allow: true });
    expect((await pending).isError).toBe(false);
    expect(store.attachments.get(page.pageId, 'alice')).toMatchObject({
      inviteId: null,
      endsAt: null,
      inviteRole: null,
      sponsorId: null,
      emailHash: null,
    });
  });
});

describe('the hub (InviteHub.holds)', () => {
  it('says whether a user holds an attachment to any page', async () => {
    const config = resolveConfig({ auth: createDevTokenAuth([ALICE]) });
    const store = createMemoryStore();
    const hub = new PageHub(config, store, createLogger({ sink: () => undefined }));
    try {
      expect(hub.holds('alice')).toBe(false);
      store.attachments.put({
        pageId: 'pg_A',
        userId: 'alice',
        displayName: 'Alice',
        kind: 'member',
        role: 'observer',
        grantedAt: 0,
        lastUsedAt: null,
        expiresAt: null,
        clients: [],
        inviteId: null,
        endsAt: null,
        inviteRole: null,
        sponsorId: null,
        emailHash: null,
      });
      expect(hub.holds('alice')).toBe(true);
      expect(hub.holds('bob')).toBe(false);
    } finally {
      await hub.shutdown();
    }
  });
});

describe('the sign-in gate (S9, ADRs 0013 and 0018)', () => {
  function gate(overrides: { pairSignIns?: number; pairSignInsInFlight?: number }): {
    enter: ReturnType<typeof createSignInGate>['enter'];
    lines: string[];
  } {
    const lines: string[] = [];
    const config = resolveConfig({
      auth: createDevTokenAuth([ALICE]),
      rateLimits: { pairSignIns: overrides.pairSignIns },
      limits: { pairSignInsInFlight: overrides.pairSignInsInFlight },
    });
    const signIns = createSignInGate(config, createLogger({ sink: (line) => lines.push(line) }));
    return { enter: (address, now) => signIns.enter(address, now), lines };
  }

  it('admits pairSignIns a window for the whole relay, whatever the address', () => {
    const { enter, lines } = gate({ pairSignIns: 2 });
    enter('192.0.2.1', 0)?.leave();
    enter('192.0.2.2', 1)?.leave();
    expect(enter('192.0.2.3', 2)).toBeNull();
    expect(enter('192.0.2.3', 60_001)).not.toBeNull();
    expect(lines.join('\n')).toContain('too many sign-ins in this window');
    expect(lines.join('\n')).not.toContain('192.0.2');
  });

  it('admits pairSignInsInFlight at once, each pass leaving once', () => {
    const { enter, lines } = gate({ pairSignInsInFlight: 1 });
    const first = enter('192.0.2.1', 0);
    expect(first).not.toBeNull();
    expect(enter('192.0.2.1', 1)).toBeNull();
    first?.leave();
    first?.leave();
    const second = enter('192.0.2.1', 2);
    expect(second).not.toBeNull();
    // The second leave of the first pass freed nothing the second holds.
    expect(enter('192.0.2.1', 3)).toBeNull();
    expect(lines.join('\n')).toContain('too many sign-ins waiting on the provider');
  });
});

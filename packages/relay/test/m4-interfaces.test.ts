// M4's interfaces before workstreams A, B and C build on them (docs/plans/M4.md,
// step 1): the new settings with their defaults and bounds, each refused by
// name outside the mode where it means something (ADRs 0017 to 0020 and 0022);
// the auth outcome's account and client_id; the client address; the invite
// frames a relay without invites ignores; what the page now hears about each
// account; and the call record as an AuditEvent. None of it changes behaviour:
// invites stay off, the audit log stays in memory, and the client address
// stays the socket's.

import type { IncomingMessage } from 'node:http';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { AuditEventSchema, MAX_FRAME_BYTES } from '@tabdock/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AuditLog,
  AuthOutcomeSchema,
  callRecords,
  createClientAddresses,
  createDevTokenAuth,
  createLogger,
  createMemoryStore,
  createOAuthAuth,
  createRelay,
  DEFAULT_TRUSTED_PROXY_CIDR,
  type EnvConfig,
  loadConfigFromEnv,
  loggedAddress,
  MemoryAuditLog,
  parseOAuthClientIds,
  parseProxyRange,
} from '../src/index.ts';
import { resolveConfig } from '../src/config.ts';
import { readOwnerToken } from '../src/local-token.ts';
import { connectPage, PAGE_ORIGIN, type TestPage, TOOLS } from './helpers/page-client.ts';
import { PAIR_CLIENT, startProvider, type TestProvider } from './helpers/provider.ts';
import {
  ALICE,
  callTool,
  connectClient,
  pairAndApprove,
  startRelay,
  type TestRelay,
} from './helpers/relay.ts';
import { PUBLIC_MCP_URL, PUBLIC_ORIGIN } from './helpers/tunnel.ts';

const scratches: string[] = [];
const relays: TestRelay[] = [];
const pages: TestPage[] = [];
const clients: Client[] = [];
let provider: TestProvider | undefined;

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const page of pages.splice(0)) page.ws.terminate();
  for (const relay of relays.splice(0)) await relay.close();
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
  await provider?.stop().catch(() => undefined);
  provider = undefined;
});

/** A TABDOCK_HOME of its own that does not exist yet. */
function freshHome(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tabdock-m4-')));
  scratches.push(dir);
  return join(dir, 'tabdock');
}

function thrown(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected an error');
}

const DEV = { TABDOCK_DEV_TOKENS: `alice=${ALICE.token}` };

const OAUTH = {
  TABDOCK_PUBLIC_URL: PUBLIC_ORIGIN,
  TABDOCK_OAUTH_ISSUER: 'https://idp.example',
  TABDOCK_OAUTH_USERS: 'user_01ABC=alice:Alice',
  TABDOCK_PAIR_CLIENT_ID: PAIR_CLIENT.clientId,
  TABDOCK_PAIR_CLIENT_SECRET: PAIR_CLIENT.clientSecret,
  TABDOCK_ALLOWED_ORIGINS: PAGE_ORIGIN,
};

const HOSTED = {
  ...OAUTH,
  TABDOCK_ENV: 'production',
  TABDOCK_CLIENT_ADDRESS_HEADER: 'Fly-Client-IP',
};

/** Both layers, as main.ts runs them: the environment, then the checks before listening. */
function resolveEnv(env: Record<string, string>): ReturnType<typeof resolveConfig> {
  return resolveConfig(loadConfigFromEnv(env));
}

/** A refusal that names the variable and never echoes the value given. */
function expectRefusedByName(env: Record<string, string>, name: string, value: string): void {
  const message = thrown(() => resolveEnv({ ...env, [name]: value }));
  expect(message, name).toContain(name);
  if (value.length >= 4) expect(message, name).not.toContain(value);
}

describe('M4 settings', () => {
  it('leave invites off, hosted mode off and the audit log in memory unless set', () => {
    const config = resolveEnv(DEV);
    expect(config).toMatchObject({
      mode: 'dev_tokens',
      invites: false,
      hosted: false,
      clientAddressHeader: null,
      trustedProxies: [],
      audit: { dir: null, retentionDays: 30, maxBytes: 64 * 1024 * 1024 },
    });
    expect(config.rateLimits).toMatchObject({ requestsPerUser: 240, requestsPerInvitee: 60 });
    expect(config.limits.toolBytes).toBe(64 * 1024 * 1024);
    expect(resolveEnv(OAUTH).mode).toBe('public');
  });

  describe('TABDOCK_INVITES (ADR 0017)', () => {
    it('turns invites on with dev tokens or a public URL, and reads 0 as off anywhere', () => {
      expect(resolveEnv({ ...DEV, TABDOCK_INVITES: '1' }).invites).toBe(true);
      expect(resolveEnv({ ...OAUTH, TABDOCK_INVITES: 'true' }).invites).toBe(true);
      const home = freshHome();
      expect(resolveEnv({ TABDOCK_HOME: home, TABDOCK_INVITES: '0' })).toMatchObject({
        mode: 'local',
        invites: false,
      });
      expect(() => loadConfigFromEnv({ ...DEV, TABDOCK_INVITES: 'yes' })).toThrow(
        /TABDOCK_INVITES must be 1, true, 0 or false/,
      );
    });

    it('is refused in local mode by name, before any token is drawn', () => {
      const home = freshHome();
      const message = thrown(() => loadConfigFromEnv({ TABDOCK_HOME: home, TABDOCK_INVITES: '1' }));
      expect(message).toMatch(/TABDOCK_INVITES does not apply to local mode/);
      expect(readOwnerToken({ TABDOCK_HOME: home })).toBeNull();
      // Given in code, a plugin marked loopbackOnly refuses it too.
      const local = createDevTokenAuth([{ ...ALICE }], { loopbackOnly: true });
      expect(() => resolveConfig({ auth: local, invites: true })).toThrow(/mints no invites/);
    });

    it('needs at least three users per page, since invites leave members two seats', () => {
      expect(
        thrown(() => resolveEnv({ ...DEV, TABDOCK_INVITES: '1', TABDOCK_MAX_USERS_PER_PAGE: '2' })),
      ).toMatch(/TABDOCK_INVITES.*TABDOCK_MAX_USERS_PER_PAGE.*at least 3/);
      expect(
        resolveEnv({ ...DEV, TABDOCK_INVITES: '1', TABDOCK_MAX_USERS_PER_PAGE: '3' }).invites,
      ).toBe(true);
      // Off, a page may hold two users as before.
      expect(resolveEnv({ ...DEV, TABDOCK_MAX_USERS_PER_PAGE: '2' }).limits.usersPerPage).toBe(2);
    });

    it('is on only when exactly true in code', () => {
      const auth = createDevTokenAuth([{ ...ALICE }]);
      expect(resolveConfig({ auth, invites: 'yes' as unknown as boolean }).invites).toBe(false);
    });
  });

  describe('request budgets and the tool-list budget (ADR 0018)', () => {
    it('read TABDOCK_MAX_REQUESTS_PER_USER everywhere and refuse a bad one', () => {
      expect(
        resolveEnv({ ...DEV, TABDOCK_MAX_REQUESTS_PER_USER: '120' }).rateLimits.requestsPerUser,
      ).toBe(120);
      expect(() => loadConfigFromEnv({ ...DEV, TABDOCK_MAX_REQUESTS_PER_USER: '0' })).toThrow(
        /TABDOCK_MAX_REQUESTS_PER_USER/,
      );
    });

    it('refuse TABDOCK_MAX_REQUESTS_PER_INVITEE unless invites are on', () => {
      expectRefusedByName(DEV, 'TABDOCK_MAX_REQUESTS_PER_INVITEE', '30');
      expect(
        resolveEnv({ ...DEV, TABDOCK_INVITES: '1', TABDOCK_MAX_REQUESTS_PER_INVITEE: '30' })
          .rateLimits.requestsPerInvitee,
      ).toBe(30);
    });

    it('read TABDOCK_MAX_TOOL_BYTES, never below one whole frame', () => {
      expect(resolveEnv({ ...DEV, TABDOCK_MAX_TOOL_BYTES: '2097152' }).limits.toolBytes).toBe(
        2_097_152,
      );
      expect(
        resolveEnv({ ...DEV, TABDOCK_MAX_TOOL_BYTES: String(MAX_FRAME_BYTES) }).limits.toolBytes,
      ).toBe(MAX_FRAME_BYTES);
      expect(thrown(() => resolveEnv({ ...DEV, TABDOCK_MAX_TOOL_BYTES: '1000' }))).toMatch(
        /TABDOCK_MAX_TOOL_BYTES.*at least 1048576/,
      );
      expect(() => loadConfigFromEnv({ ...DEV, TABDOCK_MAX_TOOL_BYTES: 'lots' })).toThrow(
        /TABDOCK_MAX_TOOL_BYTES/,
      );
    });
  });

  describe('hosted mode (ADR 0018)', () => {
    it('is production with a public URL and a client address header, with its own page limits', () => {
      const config = resolveEnv(HOSTED);
      expect(config).toMatchObject({
        mode: 'hosted',
        hosted: true,
        clientAddressHeader: 'fly-client-ip',
      });
      expect(
        config.trustedProxies.map((range) => `${range.address}/${String(range.prefix)}`),
      ).toEqual([...DEFAULT_TRUSTED_PROXY_CIDR]);
      expect(config.limits).toMatchObject({
        pageSessions: 100,
        pageSocketsPerAddress: 5,
        pageSessionsPerAddress: 5,
      });
      // Each setting still wins over the hosted default.
      expect(resolveEnv({ ...HOSTED, TABDOCK_MAX_PAGE_SESSIONS: '50' }).limits.pageSessions).toBe(
        50,
      );
      // A tunnel in front of a loopback relay is public URL mode, with M3's limits.
      expect(resolveEnv({ ...OAUTH, TABDOCK_ENV: 'production' })).toMatchObject({
        mode: 'public',
        hosted: false,
        limits: { pageSessions: 1000 },
      });
    });

    it('refuses TABDOCK_CLIENT_ADDRESS_HEADER outside it by name, drawing no token', () => {
      expectRefusedByName(DEV, 'TABDOCK_CLIENT_ADDRESS_HEADER', 'x-secret-header-name');
      expectRefusedByName(OAUTH, 'TABDOCK_CLIENT_ADDRESS_HEADER', 'x-secret-header-name');
      const home = freshHome();
      expectRefusedByName({ TABDOCK_HOME: home }, 'TABDOCK_CLIENT_ADDRESS_HEADER', 'fly-client-ip');
      expect(readOwnerToken({ TABDOCK_HOME: home })).toBeNull();
      expect(
        thrown(() => resolveEnv({ ...HOSTED, TABDOCK_CLIENT_ADDRESS_HEADER: 'fly client' })),
      ).toMatch(/TABDOCK_CLIENT_ADDRESS_HEADER\) must be one header name/);
      const auth = createDevTokenAuth([{ ...ALICE }]);
      expect(() => resolveConfig({ auth, clientAddressHeader: 'fly-client-ip' })).toThrow(
        /hosted mode only/,
      );
    });

    it('reads TABDOCK_TRUSTED_PROXY_CIDR there only, entry by entry', () => {
      expectRefusedByName(DEV, 'TABDOCK_TRUSTED_PROXY_CIDR', '172.19.0.0/16');
      expectRefusedByName(OAUTH, 'TABDOCK_TRUSTED_PROXY_CIDR', '172.19.0.0/16');
      const config = resolveEnv({
        ...HOSTED,
        TABDOCK_TRUSTED_PROXY_CIDR: ' 172.19.0.0/16, fdaa::/16 ',
      });
      expect(config.trustedProxies).toEqual([
        { address: '172.19.0.0', prefix: 16, family: 'ipv4' },
        { address: 'fdaa::', prefix: 16, family: 'ipv6' },
      ]);
      for (const bad of ['nonsense', '10.0.0.0/33', 'fdaa::/129', '10.0.0.0', '10.0.0.0/8/8']) {
        expect(
          thrown(() => resolveEnv({ ...HOSTED, TABDOCK_TRUSTED_PROXY_CIDR: `10.0.0.0/8,${bad}` })),
          bad,
        ).toMatch(/TABDOCK_TRUSTED_PROXY_CIDR entry 2 is not an address range/);
      }
      expect(() => resolveConfig({ ...loadConfigFromEnv(HOSTED), trustedProxyCidr: [] })).toThrow(
        /lists no range/,
      );
      expect(parseProxyRange('::ffff:10.0.0.0/104')).toEqual({
        address: '::ffff:10.0.0.0',
        prefix: 104,
        family: 'ipv6',
      });
    });
  });

  describe('the audit log (ADR 0019)', () => {
    it('takes an absolute TABDOCK_AUDIT_DIR and nothing else', () => {
      const dir = join(freshHome(), 'audit');
      expect(resolveEnv({ ...DEV, TABDOCK_AUDIT_DIR: dir }).audit.dir).toBe(dir);
      const message = thrown(() => resolveEnv({ ...DEV, TABDOCK_AUDIT_DIR: 'relative/audit-dir' }));
      expect(message).toMatch(/TABDOCK_AUDIT_DIR\) must be an absolute path/);
      expect(message).not.toContain('relative/audit-dir');
    });

    it("defaults local mode's directory to audit/ beside its owner token, and creates nothing yet", () => {
      const home = freshHome();
      const options = loadConfigFromEnv({ TABDOCK_HOME: home });
      const tokenPath = options.localMode?.tokenPath ?? '';
      const config = resolveConfig(options);
      expect(config.audit.dir).toBe(join(dirname(tokenPath), 'audit'));
      expect(existsSync(config.audit.dir ?? '')).toBe(false);
      expect(
        resolveEnv({ TABDOCK_HOME: home, TABDOCK_AUDIT_RETENTION_DAYS: '7' }).audit.retentionDays,
      ).toBe(7);
    });

    it('refuses its bounds by name where there are no files to bound', () => {
      expectRefusedByName(DEV, 'TABDOCK_AUDIT_RETENTION_DAYS', '7');
      expectRefusedByName(DEV, 'TABDOCK_AUDIT_MAX_MB', '16');
      const options: EnvConfig = { auth: createDevTokenAuth([{ ...ALICE }]), audit: { maxMb: 16 } };
      expect(() => resolveConfig(options)).toThrow(/auditMaxMb \(TABDOCK_AUDIT_MAX_MB\)/);
    });

    it('bounds retention to 1 to 3650 days and the total to at least one rotated file', () => {
      const withDir = { ...DEV, TABDOCK_AUDIT_DIR: join(freshHome(), 'audit') };
      expect(resolveEnv({ ...withDir, TABDOCK_AUDIT_MAX_MB: '8' }).audit.maxBytes).toBe(
        8 * 1024 * 1024,
      );
      expect(thrown(() => resolveEnv({ ...withDir, TABDOCK_AUDIT_MAX_MB: '7' }))).toMatch(
        /TABDOCK_AUDIT_MAX_MB\) must be 8 to/,
      );
      expect(
        thrown(() => resolveEnv({ ...withDir, TABDOCK_AUDIT_RETENTION_DAYS: '3651' })),
      ).toMatch(/TABDOCK_AUDIT_RETENTION_DAYS\) must be 1 to 3650/);
      expect(() => loadConfigFromEnv({ ...withDir, TABDOCK_AUDIT_RETENTION_DAYS: '0' })).toThrow(
        /TABDOCK_AUDIT_RETENTION_DAYS/,
      );
    });
  });

  describe('OAuth token age and clients (ADR 0020)', () => {
    it('are refused by name without OAuth, drawing no token', () => {
      expectRefusedByName(DEV, 'TABDOCK_OAUTH_MAX_TOKEN_AGE', '90');
      expectRefusedByName(DEV, 'TABDOCK_OAUTH_CLIENT_IDS', 'https://client.example/metadata');
      for (const name of ['TABDOCK_OAUTH_MAX_TOKEN_AGE', 'TABDOCK_OAUTH_CLIENT_IDS']) {
        const home = freshHome();
        expect(thrown(() => loadConfigFromEnv({ TABDOCK_HOME: home, [name]: '90' }))).toMatch(
          new RegExp(`${name} tunes OAuth sign-in`),
        );
        expect(readOwnerToken({ TABDOCK_HOME: home }), name).toBeNull();
      }
    });

    it('cap the token age at 1440 minutes', () => {
      expect(loadConfigFromEnv({ ...OAUTH, TABDOCK_OAUTH_MAX_TOKEN_AGE: '1440' }).auth.name).toBe(
        'oauth',
      );
      expect(() => loadConfigFromEnv({ ...OAUTH, TABDOCK_OAUTH_MAX_TOKEN_AGE: '1441' })).toThrow(
        /TABDOCK_OAUTH_MAX_TOKEN_AGE\) must be 1 to 1440 minutes/,
      );
      expect(() =>
        createOAuthAuth({
          issuer: 'https://idp.example',
          resource: PUBLIC_MCP_URL,
          users: [{ sub: 'user_01ABC', userId: 'alice', displayName: 'Alice' }],
          maxTokenAgeMinutes: 0,
        }),
      ).toThrow(/1 to 1440 minutes/);
    });

    it('read the client list entry by entry, never echoing one', () => {
      const ids = 'https://claude.ai/oauth/mcp-oauth-client-metadata, client_01ABC';
      expect(loadConfigFromEnv({ ...OAUTH, TABDOCK_OAUTH_CLIENT_IDS: ids }).auth.name).toBe(
        'oauth',
      );
      expect(parseOAuthClientIds(`${ids},client_01ABC`)).toEqual([
        'https://claude.ai/oauth/mcp-oauth-client-metadata',
        'client_01ABC',
      ]);
      const message = thrown(() =>
        loadConfigFromEnv({ ...OAUTH, TABDOCK_OAUTH_CLIENT_IDS: 'client_01ABC,secret client' }),
      );
      expect(message).toMatch(/TABDOCK_OAUTH_CLIENT_IDS entry 2 is not an OAuth client_id/);
      expect(message).not.toContain('secret client');
      expect(() => parseOAuthClientIds(' , ')).toThrow(/names no client/);
    });
  });
});

describe('the auth outcome (ADRs 0017 and 0020)', () => {
  const member = {
    kind: 'user',
    user: { userId: 'alice', displayName: 'Alice', account: { kind: 'member', email: null } },
    oauthClientId: null,
  };
  const guestId = `g_${'0'.repeat(32)}`;

  it('carries the account and the token client_id, both checked', () => {
    expect(AuthOutcomeSchema.parse(member)).toEqual(member);
    const invitee = {
      kind: 'user',
      user: {
        userId: guestId,
        displayName: 'guest@example.com',
        account: { kind: 'invitee', email: 'guest@example.com' },
      },
      oauthClientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
    };
    expect(AuthOutcomeSchema.parse(invitee)).toEqual(invitee);
    const unverified = {
      ...invitee,
      user: { ...invitee.user, account: { kind: 'invitee', email: null } },
    };
    expect(AuthOutcomeSchema.safeParse(unverified).success).toBe(true);
  });

  it.each([
    ['a user with no account', { ...member, user: { userId: 'alice', displayName: 'Alice' } }],
    ['no client_id field', { kind: 'user', user: member.user }],
    ['a client_id that is no client_id', { ...member, oauthClientId: 'has space' }],
    [
      'an email that is no email',
      { ...member, user: { ...member.user, account: { kind: 'member', email: 'nope' } } },
    ],
    [
      "an invitee without an invitee's id",
      { ...member, user: { ...member.user, account: { kind: 'invitee', email: null } } },
    ],
    ["a member with an invitee's id", { ...member, user: { ...member.user, userId: guestId } }],
  ])('refuses %s', (_name, outcome) => {
    expect(AuthOutcomeSchema.safeParse(outcome).success).toBe(false);
  });

  it('comes from the oauth plugin with a member account and the token client_id, kept only when it is one', async () => {
    provider = await startProvider();
    const auth = createOAuthAuth({
      issuer: provider.issuer,
      resource: PUBLIC_MCP_URL,
      users: [{ sub: 'sub-alice', userId: 'alice', displayName: 'Alice' }],
    });
    await auth.start?.({ log: createLogger({ sink: () => undefined }) });
    const asked = async (claims: Record<string, unknown>): Promise<unknown> => {
      const token = await (provider as TestProvider).token({
        sub: 'sub-alice',
        aud: PUBLIC_MCP_URL,
        ...claims,
      });
      return auth.authenticate({
        headers: { authorization: `Bearer ${token}` },
      } as unknown as IncomingMessage);
    };
    const named = await asked({ client_id: 'client_01ABC' });
    expect(named).toEqual({
      kind: 'user',
      user: { userId: 'alice', displayName: 'Alice', account: { kind: 'member', email: null } },
      oauthClientId: 'client_01ABC',
    });
    expect(AuthOutcomeSchema.safeParse(named).success).toBe(true);
    expect(await asked({ client_id: 'not a client id' })).toMatchObject({ oauthClientId: null });
    expect(await asked({})).toMatchObject({ oauthClientId: null });
  });
});

describe('the client address (ADR 0018)', () => {
  const from = (remoteAddress: string | undefined): IncomingMessage =>
    ({
      socket: { remoteAddress },
      headers: { 'fly-client-ip': '203.0.113.7' },
    }) as unknown as IncomingMessage;

  it("is the socket's peer, as address and limit key, until hosted mode names the client", () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (line) => lines.push(line) });
    const addresses = createClientAddresses(resolveEnv(DEV), log);
    expect(addresses.of(from('127.0.0.2'))).toEqual({
      ok: true,
      address: '127.0.0.2',
      key: '127.0.0.2',
    });
    expect(addresses.of(from(undefined))).toEqual({ ok: true, address: 'unknown', key: 'unknown' });
    expect(lines).toEqual([]);
  });

  it('says once, in hosted mode, that every client still counts by its proxy until the header is read', () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (line) => lines.push(line) });
    const addresses = createClientAddresses(resolveEnv(HOSTED), log);
    expect(addresses.of(from('10.0.0.5'))).toMatchObject({ ok: true, key: '10.0.0.5' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('hosted mode counts every client by its proxy address');
    expect(lines.join('\n')).not.toContain('203.0.113.7');
  });

  it('names a header that named no client by its problem, never by what it held', () => {
    expect(loggedAddress({ ok: true, address: '192.0.2.1', key: '192.0.2.1' })).toBe('192.0.2.1');
    expect(loggedAddress({ ok: false, problem: 'repeated' })).toBe(
      '(repeated client address header)',
    );
  });
});

describe('a relay without invites', () => {
  const HASH = '0123456789abcdef'.repeat(4);

  it('ignores invite frames, sends no invites frame, logs no hash, and keeps the page linked', async () => {
    const relay = await startRelay();
    relays.push(relay);
    const page = await connectPage(relay.relay.pageUrl, { tools: TOOLS });
    pages.push(page);
    page.send({
      t: 'invite_create',
      inviteId: 'inv_1',
      role: 'observer',
      label: 'Friends',
      uses: 2,
      expiresAt: null,
      secretHash: HASH,
    });
    page.send({ t: 'invite_cancel', inviteId: 'inv_1' });
    await page.sync();
    expect(page.all('invites')).toEqual([]);
    expect(relay.lines.filter((line) => line.includes('ignored an invite frame'))).toHaveLength(2);
    expect(relay.lines.join('\n')).not.toContain(HASH);
    // A malformed invite frame is a malformed frame like any other (SPEC section 6).
    page.send({ t: 'invite_cancel', inviteId: 'has space' });
    expect((await page.closed).code).toBe(1008);
  });

  it('tells the page each request is from a verified member, and lists members with no invite or end', async () => {
    const relay = await startRelay();
    relays.push(relay);
    const page = await connectPage(relay.relay.pageUrl, { tools: TOOLS });
    pages.push(page);
    const alice = await connectClient(relay.relay, ALICE);
    clients.push(alice);
    const pending = callTool(alice, 'pair_page', { code: page.code });
    const request = await page.next('attach_request');
    expect(request).toMatchObject({
      user: { userId: 'alice', displayName: 'Alice' },
      account: { kind: 'member', verified: true },
      via: 'code',
    });
    expect(request.invite).toBeUndefined();
    page.send({ t: 'attach_decision', requestId: request.requestId, allow: true, role: 'driver' });
    expect((await pending).isError).toBe(false);
    expect(page.all('roster').at(-1)?.attachments).toEqual([
      expect.objectContaining({ userId: 'alice', kind: 'member', inviteId: null, endsAt: null }),
    ]);
  });
});

describe('the call record as an AuditEvent (ADR 0019)', () => {
  it('keeps client text that is no id or tool name only by its length, in the log and on stderr', async () => {
    const relay = await startRelay();
    relays.push(relay);
    const alice = await connectClient(relay.relay, ALICE);
    clients.push(alice);
    await callTool(alice, 'call_page_tool', { page: 'not a page', tool: 'bad tool!' });
    const [record] = relay.relay.audit.records();
    expect(record).toMatchObject({
      v: 1,
      type: 'call',
      pageId: '(invalid, 10 chars)',
      tool: '(invalid, 9 chars)',
      outcome: 'not_attached',
    });
    expect(AuditEventSchema.parse(record)).toEqual(record);
    const logged = relay.lines.filter((line) => line.includes('"msg":"call"')).join('\n');
    expect(logged).toContain('(invalid, 10 chars)');
    expect(logged).not.toContain('not a page');
    expect(logged).not.toContain('bad tool!');
  });

  it('closes the audit log after the hub, on close and when a start fails', async () => {
    const order: string[] = [];
    const ring = new MemoryAuditLog();
    const audit: AuditLog = {
      append: (event) => {
        order.push(event.type);
        return ring.append(event);
      },
      records: () => ring.records(),
      close: vi.fn(() => {
        order.push('close');
        return Promise.resolve();
      }),
    };
    const store = { ...createMemoryStore(), audit };
    const relay = await startRelay({ store, timings: { callDeadlineMs: 5000 } });
    const page = await connectPage(relay.relay.pageUrl, { tools: TOOLS });
    pages.push(page);
    const alice = await connectClient(relay.relay, ALICE);
    clients.push(alice);
    await pairAndApprove(alice, page, 'driver');
    // A call still on the page when the relay stops is failed by the shutdown, and audited first.
    const running = callTool(alice, 'call_page_tool', {
      page: page.pageId,
      tool: 'add_item',
      arguments: { label: 'x' },
    });
    await page.next('invoke');
    await relay.close();
    await running.catch(() => undefined);
    // Only what this test is about: the log closes last, after the last call it
    // recorded. Other records (attach, relay_start, relay_stop) may come and go.
    expect(order.at(-1)).toBe('close');
    expect(order.lastIndexOf('call')).toBeGreaterThanOrEqual(0);
    expect(order.lastIndexOf('call')).toBeLessThan(order.indexOf('close'));
    expect(callRecords(ring.records()).map((record) => record.outcome)).toEqual(['page_asleep']);

    const closeFailing = vi.fn(() => Promise.resolve());
    const failing: AuditLog = { ...audit, close: closeFailing };
    const blocker = await startRelay();
    relays.push(blocker);
    await expect(
      createRelay({
        auth: createDevTokenAuth([{ ...ALICE }]),
        port: Number(new URL(blocker.relay.url).port),
        store: { ...createMemoryStore(), audit: failing },
        logSink: () => undefined,
      }),
    ).rejects.toThrow(/EADDRINUSE/);
    expect(closeFailing).toHaveBeenCalledTimes(1);
  });
});

// Local mode (ADR 0022): with no auth settings the relay runs for this machine
// only, with one user, `you`, behind a dev-token plugin marked loopbackOnly.
// Which settings win, which are refused and where, the mark that keeps the
// plugin on loopback whatever its name, the 401s and the operator's approval,
// the address the relay listens on, which must be loopback whatever a name
// resolves to, and the refusal of proxied requests on /mcp and /page,
// before the plugin answers, whenever there is no public URL, with dev tokens
// as much as in local mode.

import type * as Dns from 'node:dns';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { connect, createServer, isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { type AuthPlugin, createDevTokenAuth } from '../src/auth.ts';
import {
  AUTH_SETTINGS,
  isLoopbackAddress,
  loadConfigFromEnv,
  resolveConfig,
} from '../src/config.ts';
import { OWNER_TOKEN_FILE, readOwnerToken } from '../src/local-token.ts';
import { createOAuthAuth, createRelay, type Relay } from '../src/index.ts';
import {
  connectPage,
  openSocket,
  PAGE_ORIGIN,
  type TestPage,
  TOOLS,
  UpgradeRefused,
} from './helpers/page-client.ts';
import { PAIR_CLIENT } from './helpers/provider.ts';
import { ALICE, delay, startRelay, type TestRelay } from './helpers/relay.ts';
import { leakIn } from './helpers/secrecy.ts';
import { PUBLIC_MCP_URL, PUBLIC_ORIGIN, rawRequest } from './helpers/tunnel.ts';

const scratches: string[] = [];
const relays: Relay[] = [];
const testRelays: TestRelay[] = [];
const pages: TestPage[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const page of pages.splice(0)) page.ws.terminate();
  for (const relay of relays.splice(0)) await relay.close();
  for (const relay of testRelays.splice(0)) await relay.close();
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A TABDOCK_HOME of its own that does not exist yet. */
function freshHome(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tabdock-local-')));
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

const OAUTH = {
  TABDOCK_PUBLIC_URL: PUBLIC_ORIGIN,
  TABDOCK_OAUTH_ISSUER: 'https://idp.example',
  TABDOCK_OAUTH_USERS: 'user_01ABC=alice:Alice',
  TABDOCK_PAIR_CLIENT_ID: PAIR_CLIENT.clientId,
  TABDOCK_PAIR_CLIENT_SECRET: PAIR_CLIENT.clientSecret,
  TABDOCK_ALLOWED_ORIGINS: PAGE_ORIGIN,
};

describe('which mode the environment gives', () => {
  it('no settings give local mode: you, behind a dev-token plugin marked loopbackOnly', () => {
    const home = freshHome();
    const options = loadConfigFromEnv({ TABDOCK_HOME: home });
    expect(options.auth.name).toBe('dev-token');
    expect(options.auth.loopbackOnly).toBe(true);
    expect(options.localMode).toEqual({ tokenPath: join(home, OWNER_TOKEN_FILE), created: true });
    expect(options).toMatchObject({ port: 8787, env: 'development', host: undefined });
    expect(options.publicUrl).toBeUndefined();
    const config = resolveConfig(options);
    expect(config.publicUrl).toBeNull();
    expect(config.host).toBe('127.0.0.1');
    // The next start keeps the token.
    expect(loadConfigFromEnv({ TABDOCK_HOME: home }).localMode?.created).toBe(false);
  });

  it('blank settings, as .env.example leaves them, and TABDOCK_ENV=development still give local mode', () => {
    const blank: Record<string, string> = { TABDOCK_HOME: freshHome() };
    for (const name of AUTH_SETTINGS) blank[name] = ' ';
    expect(loadConfigFromEnv({ ...blank, TABDOCK_ENV: 'development' }).localMode?.created).toBe(
      true,
    );
  });

  it('explicit dev tokens win: their users, no mark, and no token drawn', () => {
    const home = freshHome();
    const options = loadConfigFromEnv({
      TABDOCK_HOME: home,
      TABDOCK_DEV_TOKENS: `alice=${ALICE.token}`,
    });
    expect(options.auth.name).toBe('dev-token');
    expect(options.auth.loopbackOnly).toBeUndefined();
    expect(options.localMode).toBeUndefined();
    expect(readOwnerToken({ TABDOCK_HOME: home })).toBeNull();
  });

  it('OAuth settings win: public URL mode, no token drawn', () => {
    const home = freshHome();
    const options = loadConfigFromEnv({ ...OAUTH, TABDOCK_HOME: home });
    expect(options.auth.name).toBe('oauth');
    expect(options.auth.loopbackOnly).toBeUndefined();
    expect(options.localMode).toBeUndefined();
    expect(readOwnerToken({ TABDOCK_HOME: home })).toBeNull();
  });

  it('refuses each setting that means nothing without a public URL by name, drawing no token', () => {
    for (const name of [
      'TABDOCK_OAUTH_ISSUER',
      'TABDOCK_OAUTH_USERS',
      'TABDOCK_PAIR_CLIENT_ID',
      'TABDOCK_PAIR_CLIENT_SECRET',
    ] as const) {
      const home = freshHome();
      const message = thrown(() => loadConfigFromEnv({ TABDOCK_HOME: home, [name]: OAUTH[name] }));
      expect(message, name).toMatch(new RegExp(`${name}.*work only with TABDOCK_PUBLIC_URL`));
      expect(message).not.toContain(PAIR_CLIENT.clientSecret);
      expect(readOwnerToken({ TABDOCK_HOME: home }), name).toBeNull();
    }
  });

  it('production without auth settings refuses to start and never falls back to local mode', () => {
    const home = freshHome();
    expect(() =>
      loadConfigFromEnv({
        TABDOCK_HOME: home,
        TABDOCK_ENV: 'production',
        TABDOCK_ALLOWED_ORIGINS: PAGE_ORIGIN,
      }),
    ).toThrow(/production needs auth settings.*never falls back to local mode/);
    expect(readOwnerToken({ TABDOCK_HOME: home })).toBeNull();
  });

  it('refuses a bad setting, or a host off loopback, before any token is drawn', () => {
    for (const [name, value] of [
      ['TABDOCK_PORT', 'x'],
      ['TABDOCK_ENV', 'prod'],
      ['TABDOCK_DEV_ALLOW_NO_ORIGIN', 'yes'],
      ['TABDOCK_MAX_QUEUE_DEPTH', '0'],
      ['TABDOCK_HOST', '0.0.0.0'],
      ['TABDOCK_HOST', '192.168.1.20'],
    ] as const) {
      const home = freshHome();
      expect(() => loadConfigFromEnv({ TABDOCK_HOME: home, [name]: value }), name).toThrow(
        new RegExp(name),
      );
      expect(readOwnerToken({ TABDOCK_HOME: home }), name).toBeNull();
    }
    const home = freshHome();
    expect(loadConfigFromEnv({ TABDOCK_HOME: home, TABDOCK_HOST: '::1' }).host).toBe('::1');
  });

  it('names the variable when TABDOCK_HOME is relative, never its value', () => {
    const message = thrown(() => loadConfigFromEnv({ TABDOCK_HOME: 'tabdock_relative' }));
    expect(message).toMatch(/TABDOCK_HOME must be an absolute path/);
    expect(message).not.toContain('tabdock_relative');
  });
});

describe('a plugin marked loopbackOnly, whatever its name', () => {
  const answer: AuthPlugin['authenticate'] = () =>
    Promise.resolve({
      kind: 'user',
      user: { userId: 'you', displayName: 'You', account: { kind: 'member', email: null } },
      oauthClientId: null,
    });
  const offline = createOAuthAuth({
    issuer: 'https://idp.example',
    resource: PUBLIC_MCP_URL,
    users: [{ sub: 'sub-alice', userId: 'alice', displayName: 'Alice' }],
  });
  const publicOptions = {
    publicUrl: PUBLIC_ORIGIN,
    allowedOrigins: [PAGE_ORIGIN],
    pairClient: PAIR_CLIENT,
  };

  it('is refused with a public URL, even posing as the oauth plugin for that very address', async () => {
    const posing: AuthPlugin = { ...offline, authenticate: answer, loopbackOnly: true };
    expect(() => resolveConfig({ auth: posing, ...publicOptions })).toThrow(
      /oauth plugin is marked loopbackOnly.*refuses a public URL/,
    );
    await expect(createRelay({ auth: posing, ...publicOptions })).rejects.toThrow(/loopbackOnly/);
    // Without the mark the same plugin would be taken: the mark alone refuses it.
    expect(
      resolveConfig({ auth: { ...posing, loopbackOnly: false }, ...publicOptions }).publicUrl,
    ).toBe(PUBLIC_ORIGIN);
  });

  it('is refused in production and off loopback, and a stray value from JavaScript fails closed', async () => {
    for (const name of ['dev-token', 'oauth', 'anything']) {
      const plugin: AuthPlugin = { name, authenticate: answer, loopbackOnly: true };
      expect(() =>
        resolveConfig({ auth: plugin, env: 'production', allowedOrigins: [PAGE_ORIGIN] }),
      ).toThrow(/marked loopbackOnly.*refuses production/);
      expect(() => resolveConfig({ auth: plugin, host: '0.0.0.0' })).toThrow(
        /marked loopbackOnly.*refuses to bind 0\.0\.0\.0/,
      );
      await expect(
        createRelay({ auth: plugin, env: 'production', allowedOrigins: [PAGE_ORIGIN] }),
      ).rejects.toThrow(/loopbackOnly/);
      expect(resolveConfig({ auth: plugin, host: '::1' }).host).toBe('::1');
      const unmarked: AuthPlugin = { name, authenticate: answer };
      expect(
        resolveConfig({ auth: unmarked, env: 'production', allowedOrigins: [PAGE_ORIGIN] }).env,
      ).toBe('production');
    }
    const stray = {
      name: 'dev-token',
      authenticate: answer,
      loopbackOnly: 'yes',
    } as unknown as AuthPlugin;
    expect(() =>
      resolveConfig({ auth: stray, env: 'production', allowedOrigins: [PAGE_ORIGIN] }),
    ).toThrow(/loopbackOnly/);
  });

  it('is what createDevTokenAuth makes only when asked, and what local mode always makes', () => {
    expect(createDevTokenAuth([ALICE]).loopbackOnly).toBeUndefined();
    expect(createDevTokenAuth([ALICE], { loopbackOnly: true }).loopbackOnly).toBe(true);
    const local = loadConfigFromEnv({ TABDOCK_HOME: freshHome() });
    expect(() =>
      resolveConfig({ ...local, env: 'production', allowedOrigins: [PAGE_ORIGIN] }),
    ).toThrow(/refuses production/);
    expect(() => resolveConfig({ ...local, ...publicOptions })).toThrow(/refuses a public URL/);
  });
});

/** The dns module's own object, whose functions node:net and node:dns/promises look up as they run. */
const dns = createRequire(import.meta.url)('node:dns') as typeof Dns;

/**
 * Makes every resolver in this process answer `localhost` with `addresses`,
 * as a hosts file that maps it elsewhere would (the review's probe bound one
 * over /etc/hosts in a private mount namespace), until the returned function
 * puts the real ones back. An address answers as itself, as the real lookup
 * does (server.listen looks up even a literal); any other name fails, so a
 * stray lookup shows.
 */
function resolveLocalhostTo(addresses: string[]): () => void {
  const answerFor = (hostname: string): Dns.LookupAddress[] | Error => {
    if (isIP(hostname) !== 0) return [{ address: hostname, family: isIP(hostname) }];
    if (hostname !== 'localhost' || addresses.length === 0) {
      return Object.assign(new Error(`unexpected lookup of ${hostname}`), { code: 'ENOTFOUND' });
    }
    return addresses.map((address) => ({ address, family: isIP(address) }));
  };
  const wantsAll = (options: unknown): boolean =>
    typeof options === 'object' && options !== null && 'all' in options && options.all === true;
  type Reply = (
    error: Error | null,
    address?: string | Dns.LookupAddress[],
    family?: number,
  ) => void;
  const { lookup } = dns;
  const promised = dns.promises.lookup;
  dns.lookup = ((hostname: string, options: unknown, callback?: Reply) => {
    const reply = (typeof options === 'function' ? options : callback) as Reply;
    const answer = answerFor(hostname);
    process.nextTick(() => {
      if (answer instanceof Error) reply(answer);
      else if (wantsAll(options)) reply(null, answer);
      else reply(null, answer[0]?.address, answer[0]?.family);
    });
  }) as unknown as typeof dns.lookup;
  dns.promises.lookup = ((hostname: string, options?: unknown) => {
    const answer = answerFor(hostname);
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(wantsAll(options) ? answer : answer[0]);
  }) as unknown as typeof dns.promises.lookup;
  syncBuiltinESMExports();
  return () => {
    dns.lookup = lookup;
    dns.promises.lookup = promised;
    syncBuiltinESMExports();
  };
}

/** A port nothing listens on, found by listening on it once. */
function vacantPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
  });
}

/** Whether anything takes a connection at 127.0.0.1 on `port`; a wildcard listener would. */
function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
}

describe('the address the relay listens on (S12, ADR 0022)', () => {
  /** createRelay's error message, or 'started' after closing a relay that should not have started. */
  async function outcome(options: Parameters<typeof createRelay>[0]): Promise<string> {
    return createRelay(options).then(
      async (relay) => {
        await relay.close();
        return 'started';
      },
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
  }

  it('is checked, not the name: localhost resolving off loopback is refused before anything listens', async () => {
    for (const addresses of [['0.0.0.0'], ['192.0.2.2'], ['127.0.0.1', '0.0.0.0'], ['::']]) {
      const label = addresses.join();
      const port = await vacantPort();
      const local = loadConfigFromEnv({
        TABDOCK_HOME: freshHome(),
        TABDOCK_HOST: 'localhost',
        TABDOCK_PORT: String(port),
      });
      expect(local.auth.loopbackOnly).toBe(true);
      const restore = resolveLocalhostTo(addresses);
      let refused: string;
      let refusedWithDevTokens: string;
      try {
        refused = await outcome(local);
        // S12 is the same rule with dev tokens: no relay listens off loopback.
        refusedWithDevTokens = await outcome({
          auth: createDevTokenAuth([ALICE]),
          host: 'localhost',
          port,
        });
      } finally {
        restore();
      }
      for (const message of [refused, refusedWithDevTokens]) {
        expect(message, label).toMatch(
          /^refusing to listen on (0\.0\.0\.0|192\.0\.2\.2|::): the host localhost \(TABDOCK_HOST\) resolves there.*listens only on loopback.*set TABDOCK_HOST to 127\.0\.0\.1 or ::1/,
        );
      }
      expect(await accepts(port), label).toBe(false);
    }
  });

  it('localhost that resolves to loopback still serves, on the very address it resolved to', async () => {
    const restore = resolveLocalhostTo(['127.0.0.1']);
    let relay: Relay;
    try {
      relay = await createRelay(
        loadConfigFromEnv({
          TABDOCK_HOME: freshHome(),
          TABDOCK_HOST: 'localhost',
          TABDOCK_PORT: '0',
        }),
      );
    } finally {
      restore();
    }
    relays.push(relay);
    expect(relay.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // And through this machine's own resolver, whatever loopback address it gives.
    const real = await createRelay({ auth: createDevTokenAuth([ALICE]), host: 'localhost' });
    relays.push(real);
    expect(isLoopbackAddress(new URL(real.url).hostname.replace(/^\[(.*)\]$/, '$1'))).toBe(true);
  });

  it('counts 127.0.0.0/8 and ::1 as loopback in any spelling, and nothing else', () => {
    for (const address of [
      '127.0.0.1',
      '127.255.0.9',
      '::1',
      '0:0:0:0:0:0:0:1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isLoopbackAddress(address), address).toBe(true);
    }
    for (const address of [
      '0.0.0.0',
      '::',
      '192.0.2.2',
      '128.0.0.1',
      '::ffff:192.0.2.2',
      'fe80::1',
      'localhost',
      '[::1]',
      '',
    ]) {
      expect(isLoopbackAddress(address), address).toBe(false);
    }
  });
});

/** A 2026-07-28 request that needs nothing but authentication; 200 means the caller got in. */
function discover(
  relay: Relay,
  headers: Record<string, string>,
): Promise<{ status: number; headers: Headers }> {
  return rawRequest(relay.url, '/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'server/discover',
      ...headers,
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

/** The status an upgrade to /page gets with these extra headers: 101 when it opened. */
function upgradeStatus(relay: Relay, headers: Record<string, string>): Promise<number> {
  return openSocket(relay.pageUrl, { headers }).then(
    (ws) => {
      ws.terminate();
      return 101;
    },
    (error: unknown) => {
      if (error instanceof UpgradeRefused) return error.status;
      throw error;
    },
  );
}

const PROXIED: Record<string, string>[] = [
  { Forwarded: 'for=203.0.113.9;proto=https' },
  { 'X-Forwarded-For': '203.0.113.9' },
  { 'X-Forwarded-Host': 'relay.example' },
  { 'X-Forwarded-Proto': 'https' },
];

describe('a relay in local mode', () => {
  async function startLocal(): Promise<{ relay: Relay; token: string; lines: string[] }> {
    const home = freshHome();
    const lines: string[] = [];
    const options = loadConfigFromEnv({ TABDOCK_HOME: home, TABDOCK_PORT: '0' });
    const relay = await createRelay({
      ...options,
      logLevel: 'debug',
      logSink: (line) => {
        lines.push(line);
      },
    });
    relays.push(relay);
    const token = readOwnerToken({ TABDOCK_HOME: home })?.token ?? '';
    expect(token).not.toBe('');
    return { relay, token, lines };
  }

  it('answers no token, a wrong one or a dev token with 401, and the owner token with you, whose pairing waits for the operator', async () => {
    const { relay, token, lines } = await startLocal();
    const wrong = `tabdock_${'A'.repeat(43)}`;
    for (const authorization of [undefined, `Bearer ${wrong}`, `Bearer ${ALICE.token}`, token]) {
      const answer = await discover(
        relay,
        authorization === undefined ? {} : { Authorization: authorization },
      );
      expect(answer.status).toBe(401);
      expect(answer.headers.get('www-authenticate')).toBe('Bearer realm="tabdock"');
    }
    expect((await discover(relay, { Authorization: `Bearer ${token}` })).status).toBe(200);

    const page = await connectPage(relay.pageUrl, {
      tools: TOOLS,
      onInvoke: (frame) => ({ ok: true, content: JSON.stringify({ tool: frame.tool }) }),
    });
    pages.push(page);
    const client = new Client({ name: 'local-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(relay.mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    clients.push(client);
    let settled = false;
    const pairing = client
      .callTool({ name: 'pair_page', arguments: { code: page.code } })
      .finally(() => {
        settled = true;
      });
    const request = await page.next('attach_request');
    expect(request.user).toEqual({ userId: 'you', displayName: 'You' });
    // Local mode decides who may call /mcp, never who reaches a page (S4).
    await delay(300);
    expect(settled).toBe(false);
    page.send({ t: 'attach_decision', requestId: request.requestId, allow: true, role: 'driver' });
    expect((await pairing).isError ?? false).toBe(false);
    const called = await client.callTool({
      name: 'call_page_tool',
      arguments: { page: page.pageId, tool: 'get_view', arguments: {} },
    });
    expect(called.isError ?? false).toBe(false);
    expect(relay.audit.records().at(-1)).toMatchObject({ userId: 'you', tool: 'get_view' });
    for (const line of lines) expect(leakIn(line, token)).toBeNull();
  });

  it('refuses Forwarded and every X-Forwarded-* header on /mcp and /page with 403', async () => {
    const { relay, token, lines } = await startLocal();
    for (const headers of PROXIED) {
      const label = Object.keys(headers).join();
      for (const authorization of [
        undefined,
        `Bearer tabdock_${'A'.repeat(43)}`,
        `Bearer ${token}`,
      ]) {
        const mcp = await discover(relay, {
          ...headers,
          ...(authorization === undefined ? {} : { Authorization: authorization }),
        });
        expect(mcp.status, label).toBe(403);
        // Refused before the plugin, so a proxy never even sees a challenge,
        // which the plugin would send with no token or a wrong one.
        expect(mcp.headers.get('www-authenticate'), label).toBeNull();
      }
      expect(await upgradeStatus(relay, headers), label).toBe(403);
    }
    expect(await upgradeStatus(relay, {})).toBe(101);
    expect(lines.join('\n')).toContain('mcp request refused: not made on this machine');
    expect(lines.join('\n')).toContain('page socket refused: not made on this machine');
    expect(lines.join('\n')).not.toContain('203.0.113.9');
    for (const line of lines) expect(leakIn(line, token)).toBeNull();
  });
});

describe('a relay with dev tokens and no public URL', () => {
  it('refuses Forwarded and every X-Forwarded-* header on /mcp and /page with 403, too', async () => {
    const test = await startRelay();
    testRelays.push(test);
    for (const headers of PROXIED) {
      const label = Object.keys(headers).join();
      for (const authorization of [
        undefined,
        `Bearer ${'x'.repeat(32)}`,
        `Bearer ${ALICE.token}`,
      ]) {
        const mcp = await discover(test.relay, {
          ...headers,
          ...(authorization === undefined ? {} : { Authorization: authorization }),
        });
        expect(mcp.status, label).toBe(403);
        expect(mcp.headers.get('www-authenticate'), label).toBeNull();
      }
      expect(await upgradeStatus(test.relay, headers), label).toBe(403);
    }
    expect((await discover(test.relay, { Authorization: `Bearer ${ALICE.token}` })).status).toBe(
      200,
    );
  });
});

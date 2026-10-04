// Hosted mode (ADR 0018): the relay in production behind a host edge that
// terminates TLS and names each client in one header. It alone may bind
// 0.0.0.0; it believes the header only from a peer inside the trusted proxy
// ranges, and counts every other peer as itself whatever it forges; a header
// missing, repeated or not an address is a 400 where requests count by
// address; IPv4-mapped forms count as IPv4 and native IPv6 by its /56; pages
// attach through the public host, under hosted mode's per-address limits;
// sign-ins through /pair, those /i starts included, get a per-address share
// of the relay-wide budget, counted by the client the edge names, while
// outside hosted mode every tunnelled sign-in shares the relay-wide budget
// alone; and the platform's own name for the app gets 403 everywhere but
// /healthz. Outside hosted mode M3's rules stay exactly as they were. Ends
// with a signed-in client and a page through the stand-in edge, and a scan
// of the audit files for anything S11 keeps out of them.

import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Client,
  type FetchLike,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { SUBPROTOCOL } from '@tabdock/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../src/config.ts';
import {
  createClientAddresses,
  createDevTokenAuth,
  createLogger,
  createOAuthAuth,
  createRelay,
  createSignInGate,
  limitKeyOf,
  listAuditFiles,
  LOGIN_COOKIE,
  loadConfigFromEnv,
  normalizeAddress,
  type Relay,
  type RelayOptions,
} from '../src/index.ts';
import {
  connectPage,
  openSocket,
  PAGE_ORIGIN,
  type TestPage,
  TOOLS,
  UpgradeRefused,
} from './helpers/page-client.ts';
import { PAIR_CLIENT, startProvider, type TestProvider } from './helpers/provider.ts';
import { ALICE, delay, eventually } from './helpers/relay.ts';
import {
  PUBLIC_MCP_URL,
  PUBLIC_METADATA_URL,
  PUBLIC_ORIGIN,
  type RawAnswer,
  rawRequest,
  tunnelFetch,
} from './helpers/tunnel.ts';

const PUBLIC_HOST = new URL(PUBLIC_ORIGIN).host;
const HEADER = 'fly-client-ip';
const USERS = [{ sub: 'sub-alice', userId: 'alice', displayName: 'Alice' }];
const quiet = (): void => {
  // Swallow log lines.
};

const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tabdock-hosted-')));
  scratches.push(dir);
  return dir;
}

/** The environment of a relay on a host, as the reference deployment sets it. */
const HOSTED_ENV = {
  TABDOCK_ENV: 'production',
  TABDOCK_PUBLIC_URL: PUBLIC_ORIGIN,
  TABDOCK_OAUTH_ISSUER: 'https://idp.example',
  TABDOCK_OAUTH_USERS: 'user_01ABC=alice:Alice',
  TABDOCK_PAIR_CLIENT_ID: PAIR_CLIENT.clientId,
  TABDOCK_PAIR_CLIENT_SECRET: PAIR_CLIENT.clientSecret,
  TABDOCK_ALLOWED_ORIGINS: PAGE_ORIGIN,
  TABDOCK_CLIENT_ADDRESS_HEADER: HEADER,
};

/** A copy of some settings or headers without one of them. */
function without(from: Record<string, string>, name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(from).filter(([key]) => key !== name));
}

function resolveEnv(env: Record<string, string>): ReturnType<typeof resolveConfig> {
  return resolveConfig(loadConfigFromEnv(env));
}

/** A request as client-address.ts sees it: a peer, and header lines as sent. */
function request(peer: string | undefined, lines: [string, string][] = []): IncomingMessage {
  return {
    socket: { remoteAddress: peer },
    headers: Object.fromEntries(lines.map(([name, value]) => [name.toLowerCase(), value])),
    rawHeaders: lines.flat(),
  } as unknown as IncomingMessage;
}

describe('binding (S12, ADR 0018)', () => {
  it('lets hosted mode alone bind 0.0.0.0, and nothing bind :: or another address', () => {
    expect(resolveEnv({ ...HOSTED_ENV, TABDOCK_HOST: '0.0.0.0' })).toMatchObject({
      host: '0.0.0.0',
      loopback: false,
      hosted: true,
    });
    expect(resolveEnv({ ...HOSTED_ENV, TABDOCK_HOST: '127.0.0.1' }).loopback).toBe(true);
    for (const host of ['::', '192.168.1.20', '10.0.0.1', 'relay.example']) {
      expect(() => resolveEnv({ ...HOSTED_ENV, TABDOCK_HOST: host }), host).toThrow(
        /hosted mode binds loopback or 0\.0\.0\.0.*never another address/,
      );
    }
    // A tunnel in front of a loopback relay (public URL mode, even in production) stays on loopback.
    const tunnelled = without(HOSTED_ENV, 'TABDOCK_CLIENT_ADDRESS_HEADER');
    expect(() => resolveEnv({ ...tunnelled, TABDOCK_HOST: '0.0.0.0' })).toThrow(
      /only on loopback.*unless it runs in hosted mode/,
    );
  });
});

describe('the client address (ADR 0018)', () => {
  it('reads IPv4-mapped and IPv4-compatible forms as IPv4, and keys native IPv6 by its /56', () => {
    expect(normalizeAddress('203.0.113.7')).toEqual({ family: 4, address: '203.0.113.7' });
    expect(normalizeAddress('::ffff:203.0.113.7')).toEqual({ family: 4, address: '203.0.113.7' });
    expect(normalizeAddress('::FFFF:cb00:7107')).toEqual({ family: 4, address: '203.0.113.7' });
    expect(normalizeAddress('::203.0.113.7')).toEqual({ family: 4, address: '203.0.113.7' });
    // Neither :: nor ::1 holds an IPv4 address.
    expect(normalizeAddress('::1')).toEqual({ family: 6, address: '::1' });
    expect(normalizeAddress('2001:DB8:0:0:0:0:0:1')).toEqual({ family: 6, address: '2001:db8::1' });
    expect(normalizeAddress('not an address')).toBeNull();
    const key = (text: string): string =>
      limitKeyOf(normalizeAddress(text) ?? { family: 4, address: '' });
    expect(key('2001:db8:0:12ab:1:2:3:4')).toBe('2001:db8:0:1200::/56');
    expect(key('2001:db8:0:12ff::')).toBe('2001:db8:0:1200::/56');
    expect(key('2001:db8:0:1300::1')).toBe('2001:db8:0:1300::/56');
    expect(key('::ffff:198.51.100.4')).toBe('198.51.100.4');
  });

  it('believes the header only from a trusted proxy, and names the first proxy once', () => {
    const lines: string[] = [];
    const addresses = createClientAddresses(
      resolveEnv(HOSTED_ENV),
      createLogger({ sink: (line) => lines.push(line) }),
    );
    expect(addresses.of(request('10.1.2.3', [['Fly-Client-IP', '203.0.113.7']]))).toEqual({
      ok: true,
      address: '203.0.113.7',
      key: '203.0.113.7',
    });
    // The same proxy over IPv6 sockets, IPv4-mapped, is still the proxy.
    expect(
      addresses.of(request('::ffff:10.1.2.3', [['fly-client-ip', '2001:db8:0:12ab::9']])),
    ).toEqual({
      ok: true,
      address: '2001:db8:0:12ab::9',
      key: '2001:db8:0:1200::/56',
    });
    expect(lines.filter((line) => line.includes('its proxy connects from this address'))).toEqual([
      expect.stringContaining('"proxy":"10.1.2.3"'),
    ]);
  });

  it('counts a peer outside the trusted ranges as itself, whatever header it forges, and logs it once', () => {
    const lines: string[] = [];
    const addresses = createClientAddresses(
      resolveEnv(HOSTED_ENV),
      createLogger({ sink: (line) => lines.push(line) }),
    );
    for (const forged of ['203.0.113.7', '198.51.100.1', 'garbage']) {
      expect(addresses.of(request('192.0.2.50', [[HEADER, forged]]))).toEqual({
        ok: true,
        address: '192.0.2.50',
        key: '192.0.2.50',
      });
    }
    // Even with no header at all: it is no 400, since nothing it sends is read.
    expect(addresses.of(request('192.0.2.50'))).toMatchObject({ ok: true, key: '192.0.2.50' });
    expect(addresses.of(request('2001:db8:aa:bb::1', [[HEADER, '203.0.113.7']]))).toMatchObject({
      ok: true,
      key: '2001:db8:aa::/56',
    });
    const untrusted = lines.filter((line) => line.includes('outside TABDOCK_TRUSTED_PROXY_CIDR'));
    expect(untrusted).toHaveLength(2);
    expect(untrusted[0]).toContain('"peer":"192.0.2.50"');
    expect(lines.join('\n')).not.toContain('198.51.100.1');
  });

  it('refuses a header that is missing, repeated or not one bare address', () => {
    const addresses = createClientAddresses(resolveEnv(HOSTED_ENV), createLogger({ sink: quiet }));
    const from = (lines: [string, string][]): ReturnType<typeof addresses.of> =>
      addresses.of(request('10.0.0.9', lines));
    expect(from([])).toEqual({ ok: false, problem: 'missing' });
    expect(from([['X-Forwarded-For', '203.0.113.7']])).toEqual({ ok: false, problem: 'missing' });
    expect(
      from([
        [HEADER, '203.0.113.7'],
        ['Fly-Client-IP', '203.0.113.7'],
      ]),
    ).toEqual({ ok: false, problem: 'repeated' });
    for (const value of [
      '',
      'not-an-ip',
      '203.0.113.7:443',
      '[2001:db8::1]',
      '203.0.113.7, 198.51.100.1',
      'fe80::1%eth0',
      '203.0.113.256',
    ]) {
      expect(from([[HEADER, value]]), value).toEqual({ ok: false, problem: 'malformed' });
    }
    expect(from([[HEADER, ' 203.0.113.7 ']])).toMatchObject({ ok: true, key: '203.0.113.7' });
  });

  it('trusts exactly the ranges TABDOCK_TRUSTED_PROXY_CIDR names, IPv4-mapped ranges included', () => {
    const narrowed = createClientAddresses(
      resolveEnv({ ...HOSTED_ENV, TABDOCK_TRUSTED_PROXY_CIDR: '172.19.0.0/16' }),
      createLogger({ sink: quiet }),
    );
    expect(narrowed.of(request('172.19.4.5', [[HEADER, '203.0.113.7']]))).toMatchObject({
      key: '203.0.113.7',
    });
    expect(narrowed.of(request('10.0.0.5', [[HEADER, '203.0.113.7']]))).toMatchObject({
      key: '10.0.0.5',
    });
    const mapped = createClientAddresses(
      resolveEnv({ ...HOSTED_ENV, TABDOCK_TRUSTED_PROXY_CIDR: '::ffff:10.0.0.0/104' }),
      createLogger({ sink: quiet }),
    );
    expect(mapped.of(request('::ffff:10.0.0.9', [[HEADER, '203.0.113.7']]))).toMatchObject({
      key: '203.0.113.7',
    });
  });

  it('reads no header outside hosted mode: M3 counts the socket peer', () => {
    const tunnelled = without(HOSTED_ENV, 'TABDOCK_CLIENT_ADDRESS_HEADER');
    const addresses = createClientAddresses(resolveEnv(tunnelled), createLogger({ sink: quiet }));
    expect(addresses.of(request('127.0.0.1', [[HEADER, '203.0.113.7']]))).toEqual({
      ok: true,
      address: '127.0.0.1',
      key: '127.0.0.1',
    });
  });
});

describe('the sign-in share per address (S9, ADR 0018)', () => {
  function gate(env: Record<string, string>): {
    enter: ReturnType<typeof createSignInGate>['enter'];
    lines: string[];
  } {
    const lines: string[] = [];
    const signIns = createSignInGate(
      resolveEnv(env),
      createLogger({ sink: (line) => lines.push(line) }),
    );
    return { enter: (address, now) => signIns.enter(address, now), lines };
  }

  it('gives each address 10 sign-ins a minute, checked before the relay-wide 60', () => {
    const { enter, lines } = gate(HOSTED_ENV);
    for (let index = 0; index < 10; index += 1) enter('203.0.113.7', index)?.leave();
    expect(enter('203.0.113.7', 11)).toBeNull();
    expect(lines.join('\n')).toContain('too many sign-ins from one address in this window');
    expect(lines.join('\n')).toContain('"address":"203.0.113.7"');
    // Another address still has its own share, and the first has it back a minute on.
    expect(enter('198.51.100.1', 12)).not.toBeNull();
    expect(enter('203.0.113.7', 60_001)).not.toBeNull();
  });

  it('gives each address 2 sign-ins in flight, under the relay-wide 8', () => {
    const { enter, lines } = gate(HOSTED_ENV);
    const first = enter('203.0.113.7', 0);
    const second = enter('203.0.113.7', 1);
    expect(enter('203.0.113.7', 2)).toBeNull();
    expect(lines.join('\n')).toContain(
      'too many sign-ins from one address waiting on the provider',
    );
    first?.leave();
    first?.leave();
    const third = enter('203.0.113.7', 3);
    expect(third).not.toBeNull();
    // A second leave of the first pass freed nothing the others hold.
    expect(enter('203.0.113.7', 4)).toBeNull();
    second?.leave();
    third?.leave();
    // The relay-wide 8 still binds across addresses.
    const held = Array.from({ length: 8 }, (_, index) => enter(`198.51.100.${String(index)}`, 10));
    expect(held.every((pass) => pass !== null)).toBe(true);
    expect(enter('192.0.2.1', 11)).toBeNull();
    expect(lines.join('\n')).toContain('too many sign-ins waiting on the provider');
  });

  it('keeps the relay-wide window as the backstop', () => {
    const { enter } = gate({ ...HOSTED_ENV, TABDOCK_MAX_PAIR_SIGNINS_PER_MINUTE: '3' });
    for (let index = 0; index < 3; index += 1) enter(`203.0.113.${String(index)}`, index)?.leave();
    expect(enter('203.0.113.99', 4)).toBeNull();
  });
});

describe('a relay on a host (ADR 0018)', () => {
  let provider: TestProvider;
  const relays: Relay[] = [];
  const lines: string[] = [];
  const pages: TestPage[] = [];
  const sockets: { terminate(): void }[] = [];
  const clients: Client[] = [];

  beforeEach(async () => {
    lines.length = 0;
    provider = await startProvider();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    for (const page of pages.splice(0)) page.ws.terminate();
    for (const socket of sockets.splice(0)) socket.terminate();
    for (const relay of relays.splice(0)) await relay.close();
    await provider.stop();
  });

  async function hosted(options: Partial<RelayOptions> = {}): Promise<Relay> {
    const relay = await createRelay({
      auth: createOAuthAuth({ issuer: provider.issuer, resource: PUBLIC_MCP_URL, users: USERS }),
      env: 'production',
      host: '0.0.0.0',
      publicUrl: PUBLIC_ORIGIN,
      pairClient: PAIR_CLIENT,
      allowedOrigins: [PAGE_ORIGIN],
      clientAddressHeader: HEADER,
      // The stand-in edge is this machine: its loopback address plays the proxy.
      trustedProxyCidr: ['127.0.0.1/32'],
      audit: { dir: join(scratch(), 'audit') },
      logLevel: 'debug',
      logSink: (line) => {
        lines.push(line);
      },
      ...options,
    });
    relays.push(relay);
    return relay;
  }

  /** The upgrade's HTTP status through the edge: 101 when the socket opened, kept open. */
  async function upgrade(
    relay: Relay,
    headers: Record<string, string>,
    localAddress?: string,
  ): Promise<number> {
    try {
      const ws = await openSocket(relay.pageUrl, {
        headers,
        ...(localAddress === undefined ? {} : { localAddress }),
      });
      sockets.push(ws);
      return 101;
    } catch (error) {
      if (error instanceof UpgradeRefused) return error.status;
      throw error;
    }
  }

  const through = (address: string): Record<string, string> => ({
    Host: PUBLIC_HOST,
    'Fly-Client-IP': address,
    // What an edge adds besides; hosted mode expects these rather than refusing them.
    'X-Forwarded-For': `${address}, 10.0.0.1`,
    'X-Forwarded-Proto': 'https',
  });

  it('binds 0.0.0.0, and reports where this machine reaches it', async () => {
    const relay = await hosted();
    expect(relay.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const listening = lines.find((line) => line.includes('"msg":"relay listening"')) ?? '';
    expect(listening).toMatch(/"bound":"0\.0\.0\.0:\d+"/);
    expect(listening).toContain('"mode":"hosted"');
    // Reachable on an address that is not loopback, where this machine has one.
    const external = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;
    if (external !== undefined) {
      const health = await rawRequest(relay.url.replace('127.0.0.1', external), '/healthz');
      expect(health.status).toBe(200);
    }
  });

  it("keeps the Host allowlist: the platform's name for the app gets 403 everywhere but /healthz", async () => {
    const relay = await hosted();
    const appHost = 'tabdock-a1b2.fly.dev';
    expect((await rawRequest(relay.url, '/healthz', { host: appHost })).status).toBe(200);
    const post = (host: string): ReturnType<typeof rawRequest> =>
      rawRequest(relay.url, '/mcp', {
        method: 'POST',
        host,
        headers: { 'Content-Type': 'application/json', [HEADER]: '203.0.113.7' },
        body: '{}',
      });
    expect((await post(appHost)).status).toBe(403);
    const challenge = await post(PUBLIC_HOST);
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('www-authenticate')).toContain(
      `resource_metadata="${PUBLIC_METADATA_URL}"`,
    );
    const metadata = '/.well-known/oauth-protected-resource/mcp';
    expect((await rawRequest(relay.url, metadata, { host: appHost })).status).toBe(403);
    expect((await rawRequest(relay.url, metadata, { host: PUBLIC_HOST })).status).toBe(200);
    expect(
      (
        await rawRequest(relay.url, '/pair', {
          host: appHost,
          headers: { [HEADER]: '203.0.113.7' },
        })
      ).status,
    ).toBe(403);
    expect(await upgrade(relay, { ...through('203.0.113.7'), Host: appHost })).toBe(403);
  });

  it('takes pages through the public host with the edge headers, and refuses the rest', async () => {
    const relay = await hosted();
    expect(await upgrade(relay, through('203.0.113.7'))).toBe(101);
    // The forwarding headers M3 refuses are the edge's own here; a loopback Host is not.
    expect(await upgrade(relay, { ...through('203.0.113.7'), Host: 'localhost' })).toBe(403);
    expect(lines.join('\n')).toContain('page socket refused: not the public host');
    const noClient = without(through('203.0.113.7'), 'Fly-Client-IP');
    expect(await upgrade(relay, noClient)).toBe(400);
    expect(await upgrade(relay, { ...through('203.0.113.7'), 'Fly-Client-IP': 'not-an-ip' })).toBe(
      400,
    );
    expect(lines.join('\n')).toContain('page socket refused: no client address');
  });

  /** The status line a raw request gets; only a raw socket can repeat a header line. */
  function rawStatus(relay: Relay, head: readonly string[]): Promise<number> {
    return new Promise((resolve, reject) => {
      const socket = connect(Number(new URL(relay.url).port), '127.0.0.1', () => {
        socket.write(`${head.join('\r\n')}\r\n\r\n`);
      });
      let received = '';
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('latin1');
        const status = /^HTTP\/1\.1 (\d{3})/.exec(received)?.[1];
        if (status !== undefined) {
          socket.destroy();
          resolve(Number(status));
        }
      });
      socket.on('error', reject);
    });
  }

  it('answers 400 to a repeated client address header on /page and /pair, never on /mcp', async () => {
    const relay = await hosted();
    const repeated = [`Fly-Client-IP: 203.0.113.7`, `fly-client-ip: 198.51.100.1`];
    expect(
      await rawStatus(relay, [
        'GET /page HTTP/1.1',
        `Host: ${PUBLIC_HOST}`,
        ...repeated,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        `Sec-WebSocket-Protocol: ${SUBPROTOCOL}`,
        `Origin: ${PAGE_ORIGIN}`,
      ]),
    ).toBe(400);
    expect(
      await rawStatus(relay, [
        'GET /pair HTTP/1.1',
        `Host: ${PUBLIC_HOST}`,
        ...repeated,
        'Connection: close',
      ]),
    ).toBe(400);
    expect((await rawRequest(relay.url, '/pair', { host: PUBLIC_HOST })).status).toBe(400);
    expect(
      (
        await rawRequest(relay.url, '/pair', {
          host: PUBLIC_HOST,
          headers: { [HEADER]: '203.0.113.7' },
        })
      ).status,
    ).toBe(200);
    // /mcp counts nothing by address, so it only names the problem in its refusal line.
    const mcp = await rawRequest(relay.url, '/mcp', {
      method: 'POST',
      host: PUBLIC_HOST,
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(mcp.status).toBe(401);
    expect(lines.join('\n')).toContain('(missing client address header)');
  });

  it('holds hosted limits per client: 5 page sockets an address, an IPv6 /56 as one, IPv4-mapped as IPv4', async () => {
    const relay = await hosted();
    for (let index = 0; index < 5; index += 1) {
      expect(await upgrade(relay, through('203.0.113.7'))).toBe(101);
    }
    expect(await upgrade(relay, through('203.0.113.7'))).toBe(429);
    expect(await upgrade(relay, through('::ffff:203.0.113.7'))).toBe(429);
    // Everyone else behind the same proxy still gets in.
    expect(await upgrade(relay, through('198.51.100.1'))).toBe(101);
    for (let index = 1; index <= 5; index += 1) {
      expect(
        await upgrade(relay, through(`2001:db8:0:12${String(index)}0::${String(index)}`)),
      ).toBe(101);
    }
    expect(await upgrade(relay, through('2001:db8:0:12ff::99'))).toBe(429);
    expect(await upgrade(relay, through('2001:db8:0:1300::1'))).toBe(101);
  });

  it('counts a peer outside the trusted ranges as itself, so forged headers buy it nothing', async () => {
    const relay = await hosted();
    // 127.0.0.2 is not the edge: each socket forges another client, and all count as 127.0.0.2.
    for (let index = 0; index < 5; index += 1) {
      expect(await upgrade(relay, through(`203.0.113.${String(10 + index)}`), '127.0.0.2')).toBe(
        101,
      );
    }
    expect(await upgrade(relay, through('203.0.113.99'), '127.0.0.2')).toBe(429);
    // Its missing header is no 400 either: nothing it sends is read.
    const noClient = without(through('203.0.113.7'), 'Fly-Client-IP');
    expect(await upgrade(relay, noClient, '127.0.0.2')).toBe(429);
    // The edge itself is unaffected.
    expect(await upgrade(relay, through('203.0.113.10'))).toBe(101);
    const untrusted = lines.filter((line) => line.includes('outside TABDOCK_TRUSTED_PROXY_CIDR'));
    expect(untrusted).toHaveLength(1);
    expect(untrusted[0]).toContain('"peer":"127.0.0.2"');
  });

  it('lets a signed-in client drive a page through the edge, and keeps S11 out of the audit files', async () => {
    const dir = join(scratch(), 'audit');
    const relay = await hosted({ audit: { dir } });
    const page = await connectPage(relay.pageUrl, {
      tools: TOOLS,
      headers: through('203.0.113.7'),
      onInvoke: (frame) => ({ ok: true, content: JSON.stringify({ tool: frame.tool }) }),
    });
    pages.push(page);
    const code = page.code;
    const token = await provider.token({ sub: 'sub-alice', aud: PUBLIC_MCP_URL });
    const tunnel = tunnelFetch(relay.url);
    // The edge names the client on every request; the tunnel helper already sets the public Host.
    const edge: FetchLike = (input, init) =>
      tunnel(input, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init?.headers).entries()),
          [HEADER]: '198.51.100.23',
        },
      });
    const client = new Client({ name: 'phone', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(PUBLIC_MCP_URL), {
        authProvider: { token: () => Promise.resolve(token) },
        fetch: edge,
      }),
    );
    clients.push(client);
    const pairing = client.callTool({ name: 'pair_page', arguments: { code } });
    const request = await page.next('attach_request');
    page.send({ t: 'attach_decision', requestId: request.requestId, allow: true, role: 'driver' });
    expect((await pairing).isError ?? false).toBe(false);
    const called = await client.callTool({
      name: 'call_page_tool',
      arguments: { page: page.pageId, tool: 'get_view', arguments: {} },
    });
    expect(called.isError ?? false).toBe(false);
    for (const open of clients.splice(0)) await open.close();
    for (const open of relays.splice(0)) await open.close();

    const text = listAuditFiles(dir)
      .map((file) => readFileSync(join(dir, file.name), 'utf8'))
      .join('');
    expect(text).toContain('"type":"relay_start"');
    expect(text).toContain('"mode":"hosted"');
    expect(text).toContain('"type":"call"');
    for (const secret of [token, code, 'sub-alice', '203.0.113.7', '198.51.100.23', '127.0.0.1']) {
      expect(text, secret === token ? 'the token' : secret).not.toContain(secret);
    }
    const logged = lines.join('\n');
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(code);
  });

  /**
   * Counts the relay's requests to the provider's token endpoint, one per code
   * exchange, each carrying the /pair client's secret; while held, they wait.
   */
  function watchTokenEndpoint(): {
    readonly count: number;
    hold(): void;
    release(): void;
    restore(): void;
  } {
    const realFetch = globalThis.fetch;
    let count = 0;
    let gate: Promise<void> | null = null;
    let open = (): void => undefined;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `${provider.issuer}/token`) {
        count += 1;
        if (gate !== null) await gate;
      }
      return realFetch(input, init);
    });
    return {
      get count() {
        return count;
      },
      hold() {
        gate = new Promise((resolve) => {
          open = resolve;
        });
      },
      release() {
        open();
        gate = null;
      },
      restore() {
        spy.mockRestore();
      },
    };
  }

  /**
   * A callback through the edge for a sign-in of the caller's own making,
   * with the login cookie and state anyone can send without a browser, from
   * the client the edge names (none when address is null). A sign-in /i
   * started carries a fifth part naming it, and returns there.
   */
  function forgedCallback(
    relay: Relay,
    address: string | null,
    startedAt: 'pair' | 'i' = 'pair',
  ): Promise<RawAnswer> {
    const part = (): string => randomBytes(32).toString('base64url');
    const state = part();
    const target = startedAt === 'i' ? '.i' : '';
    return rawRequest(relay.url, `/pair/callback?code=made-up-${part()}&state=${state}`, {
      host: PUBLIC_HOST,
      headers: {
        Cookie: `${LOGIN_COOKIE}=${state}.${part()}.${part()}.${String(Date.now() + 600_000)}${target}`,
        ...(address === null ? {} : { [HEADER]: address }),
      },
    });
  }

  const FAILED = '/pair?signin=failed';

  it('gives each client the edge names its share of sign-ins through /pair: 2 in flight and 10 a minute', async () => {
    const relay = await hosted();
    const tokens = watchTokenEndpoint();
    try {
      tokens.hold();
      const waiting = [forgedCallback(relay, '203.0.113.7'), forgedCallback(relay, '203.0.113.7')];
      await eventually(() => tokens.count === 2, 3000);
      // A third from the same client is answered at once; the provider never hears of it.
      const third = await Promise.race([
        forgedCallback(relay, '203.0.113.7'),
        delay(2000).then(() => null),
      ]);
      expect(third?.headers.get('location'), 'answered without the provider').toBe(FAILED);
      expect(tokens.count).toBe(2);
      expect(lines.join('\n')).toContain(
        'too many sign-ins from one address waiting on the provider',
      );
      // Another client behind the same edge still reaches the provider.
      const other = forgedCallback(relay, '198.51.100.1');
      await eventually(() => tokens.count === 3, 3000);
      tokens.release();
      for (const answer of await Promise.all([...waiting, other])) {
        expect(answer.headers.get('location')).toBe(FAILED);
      }

      // Two of the first client's ten a minute are spent; eight more reach the provider.
      for (let index = 0; index < 8; index += 1) {
        expect((await forgedCallback(relay, '203.0.113.7')).headers.get('location')).toBe(FAILED);
      }
      expect(tokens.count).toBe(11);
      // The eleventh in the minute does not, while another client's still does.
      expect((await forgedCallback(relay, '203.0.113.7')).headers.get('location')).toBe(FAILED);
      expect(tokens.count).toBe(11);
      expect(lines.join('\n')).toContain('too many sign-ins from one address in this window');
      expect((await forgedCallback(relay, '198.51.100.2')).headers.get('location')).toBe(FAILED);
      expect(tokens.count).toBe(12);
      // An IPv6 client counts by its /56: another address in it shares the spent share.
      for (let index = 0; index < 10; index += 1) {
        await forgedCallback(relay, `2001:db8:0:12${String(index % 10)}0::1`);
      }
      expect(tokens.count).toBe(22);
      await forgedCallback(relay, '2001:db8:0:12ff::99');
      expect(tokens.count).toBe(22);
      // A callback whose client the edge did not name is malformed: 400, no provider.
      expect((await forgedCallback(relay, null)).status).toBe(400);
      expect(tokens.count).toBe(22);
    } finally {
      tokens.release();
      tokens.restore();
    }
  });

  it('serves /i behind the same client address rule as /pair, and counts the sign-ins it starts against the same share', async () => {
    const relay = await hosted({ invites: true });
    const atI = (path: string, headers: Record<string, string>, body?: string) =>
      rawRequest(relay.url, path, {
        method: body === undefined ? 'GET' : 'POST',
        host: PUBLIC_HOST,
        headers: {
          ...headers,
          ...(body === undefined
            ? {}
            : { 'Content-Type': 'application/json', Origin: PUBLIC_ORIGIN }),
        },
        ...(body === undefined ? {} : { body }),
      });
    // /i counts previews and claims, so a request whose client the edge did not name is malformed.
    expect((await atI('/i', {})).status).toBe(400);
    expect(
      await rawStatus(relay, [
        'GET /i HTTP/1.1',
        `Host: ${PUBLIC_HOST}`,
        'Fly-Client-IP: 203.0.113.7',
        'fly-client-ip: 198.51.100.1',
        'Connection: close',
      ]),
    ).toBe(400);
    const preview = JSON.stringify({ secret: 'A'.repeat(22) });
    expect((await atI('/i/preview', {}, preview)).status).toBe(400);
    expect((await atI('/i', { [HEADER]: '203.0.113.7' })).status).toBe(200);
    // Named, the unknown secret gets /i's own answer rather than the 400.
    expect((await atI('/i/preview', { [HEADER]: '203.0.113.7' }, preview)).status).toBe(404);
    expect(lines.join('\n')).toContain('pair request refused: no client address');

    // /i signs in through /pair/callback: its sign-ins go back to /i and spend the same share.
    const tokens = watchTokenEndpoint();
    try {
      for (let index = 0; index < 10; index += 1) {
        const back = await forgedCallback(relay, '203.0.113.9', 'i');
        expect(back.headers.get('location')).toBe('/i?signin=failed');
      }
      expect(tokens.count).toBe(10);
      expect((await forgedCallback(relay, '203.0.113.9', 'i')).headers.get('location')).toBe(
        '/i?signin=failed',
      );
      expect((await forgedCallback(relay, '203.0.113.9')).headers.get('location')).toBe(FAILED);
      expect(tokens.count).toBe(10);
      expect(lines.join('\n')).toContain('too many sign-ins from one address in this window');
      await forgedCallback(relay, '198.51.100.9', 'i');
      expect(tokens.count).toBe(11);
      expect((await forgedCallback(relay, null, 'i')).status).toBe(400);
      expect(tokens.count).toBe(11);
    } finally {
      tokens.restore();
    }
  });

  it('keeps M3 exactly outside hosted mode: every tunnelled sign-in shares the relay-wide 8 in flight, with no share per address', async () => {
    const relay = await hosted({
      env: 'development',
      host: '127.0.0.1',
      clientAddressHeader: undefined,
      trustedProxyCidr: undefined,
      audit: undefined,
    });
    const tokens = watchTokenEndpoint();
    try {
      tokens.hold();
      // Every one arrives from the tunnel's loopback address, whatever header it carries.
      const waiting = Array.from({ length: 8 }, () => forgedCallback(relay, '203.0.113.7'));
      await eventually(() => tokens.count === 8, 3000);
      const ninth = await Promise.race([
        forgedCallback(relay, '198.51.100.1'),
        delay(2000).then(() => null),
      ]);
      expect(ninth?.headers.get('location'), 'answered without the provider').toBe(FAILED);
      expect(tokens.count).toBe(8);
      expect(lines.join('\n')).toContain('too many sign-ins waiting on the provider');
      expect(lines.join('\n')).not.toContain('from one address');
      tokens.release();
      for (const answer of await Promise.all(waiting)) {
        expect(answer.headers.get('location')).toBe(FAILED);
      }
    } finally {
      tokens.release();
      tokens.restore();
    }
  });

  it('keeps M3 exactly outside hosted mode: a tunnelled relay takes /page only from this machine', async () => {
    const relay = await hosted({
      env: 'development',
      host: '127.0.0.1',
      clientAddressHeader: undefined,
      trustedProxyCidr: undefined,
      audit: undefined,
    });
    expect(await upgrade(relay, through('203.0.113.7'))).toBe(403);
    expect(await upgrade(relay, {})).toBe(101);
  });
});

describe('a dev-token relay', () => {
  it('cannot be hosted: the header needs production with a public URL', () => {
    expect(() =>
      resolveConfig({
        auth: createDevTokenAuth([ALICE]),
        env: 'production',
        allowedOrigins: [PAGE_ORIGIN],
        clientAddressHeader: HEADER,
      }),
    ).toThrow(/hosted mode only/);
  });
});

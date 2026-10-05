// Origin on /mcp (ADR 0027, S12). Both MCP revisions say a server MUST answer
// 403 to a present Origin it does not allow; the relay compares the value as
// written, as it compares Host and page origins, against loopback origins
// without a public URL, the public origin with one, and the origins listed in
// TABDOCK_MCP_ALLOWED_ORIGINS. The check runs after the Host check and before
// anything else: a refused request gets no challenge, never reaches the auth
// plugin, spends no budget and reaches neither leg, whatever its method, with
// a valid token or without one. A request with no Origin passes. A refusal
// writes one line a window naming the origin, cut, and the client address;
// the start line names the policy; and a bad entry stops the relay naming its
// place, never its text.

import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AuthPlugin,
  createDevTokenAuth,
  createOAuthAuth,
  createRelay,
  loadConfigFromEnv,
  type Relay,
  type RelayOptions,
} from '../src/index.ts';
import { MAX_NAMED_REFUSED_ORIGINS } from '../src/origin-refusals.ts';
import { openSocket, PAGE_ORIGIN, UpgradeRefused } from './helpers/page-client.ts';
import { PAIR_CLIENT, startProvider, type TestProvider } from './helpers/provider.ts';
import { openSession } from './helpers/raw-mcp.ts';
import { ALICE, atWindowStart, FAST_TIMINGS } from './helpers/relay.ts';
import { PUBLIC_MCP_URL, PUBLIC_ORIGIN } from './helpers/tunnel.ts';

const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';
const META = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': { name: 'origin-test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

/** What the relay answers a refused Origin: the SDK guard's own shape. */
const REFUSAL = { jsonrpc: '2.0', error: { code: -32000, message: 'Invalid Origin' }, id: null };

interface Opener {
  name: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  /** Needs a live session id in its headers. */
  session?: boolean;
}

const OPENERS: Opener[] = [
  {
    name: '2025 initialize',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LEGACY,
        capabilities: {},
        clientInfo: { name: 'raw', version: '1' },
      },
    },
  },
  {
    name: '2025 tools/list on a session',
    method: 'POST',
    session: true,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Protocol-Version': LEGACY,
    },
    body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  },
  {
    name: '2025 GET stream',
    method: 'GET',
    session: true,
    headers: { Accept: 'text/event-stream', 'Mcp-Protocol-Version': LEGACY },
  },
  {
    name: '2025 DELETE',
    method: 'DELETE',
    session: true,
    headers: { 'Mcp-Protocol-Version': LEGACY },
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
    body: { jsonrpc: '2.0', id: 3, method: 'server/discover', params: { _meta: META } },
  },
  {
    name: '2026-07-28 tools/call',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Protocol-Version': MODERN,
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'list_pages',
    },
    body: {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'list_pages', arguments: {}, _meta: META },
    },
  },
  {
    name: '2026-07-28 subscriptions/listen',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Protocol-Version': MODERN,
      'Mcp-Method': 'subscriptions/listen',
    },
    body: {
      jsonrpc: '2.0',
      id: 5,
      method: 'subscriptions/listen',
      params: { _meta: META, notifications: { toolsListChanged: true } },
    },
  },
];

interface Answer {
  status: number;
  body: string;
}

/**
 * One request to /mcp through node:http, which can send a Host fetch cannot,
 * an empty Origin, or two Origin lines. A stream's body is not waited for.
 */
function send(
  relay: Relay,
  opener: Opener,
  options: { origin?: string | string[]; token?: string; host?: string; session?: string } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | string[]> = { ...opener.headers };
    if (options.origin !== undefined) headers.Origin = options.origin;
    if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
    if (options.host !== undefined) headers.Host = options.host;
    if (opener.session === true) headers['Mcp-Session-Id'] = options.session ?? 'no-session';
    const req = httpRequest(
      new URL('/mcp', relay.url),
      { method: opener.method, headers },
      (res) => {
        const status = res.statusCode ?? 0;
        if ((res.headers['content-type'] ?? '').startsWith('text/event-stream')) {
          res.destroy();
          resolve({ status, body: '' });
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(opener.body === undefined ? undefined : JSON.stringify(opener.body));
  });
}

/** A dev-token plugin that counts what reaches it. */
function counted(): { plugin: AuthPlugin; calls: () => number } {
  const inner = createDevTokenAuth([ALICE]);
  let calls = 0;
  return {
    plugin: {
      name: 'counted',
      loopbackOnly: true,
      authenticate(request) {
        calls += 1;
        return inner.authenticate(request);
      },
    },
    calls: () => calls,
  };
}

let relay: Relay | undefined;
let provider: TestProvider | undefined;
let lines: string[] = [];

afterEach(async () => {
  await relay?.close();
  relay = undefined;
  await provider?.stop().catch(() => undefined);
  provider = undefined;
});

async function start(options: Partial<RelayOptions> & Pick<RelayOptions, 'auth'>): Promise<Relay> {
  lines = [];
  relay = await createRelay({
    port: 0,
    logLevel: 'debug',
    logSink: (line) => {
      lines.push(line);
    },
    ...options,
    timings: { ...FAST_TIMINGS, sseKeepAliveMs: 100, ...options.timings },
  });
  return relay;
}

function logged(message: string): Record<string, unknown>[] {
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.msg === message);
}

describe('without a public URL (dev tokens and local mode)', () => {
  const FOREIGN: (string | string[])[] = [
    'https://evil.example',
    'null',
    '',
    ['http://localhost:5173', 'http://localhost:5173'],
    'HTTP://LOCALHOST:5173',
    'http://Localhost:5173',
    'http://localhost:5173/',
    'http://localhost:5173/mcp',
    'ws://localhost:5173',
    'http://localhost.evil.example',
  ];

  it('refuses a present Origin off the allowlist 403, on every method and both legs, before the plugin, with a token or without', async () => {
    const { plugin, calls } = counted();
    const started = await start({ auth: plugin });
    // A live session, opened with no Origin, so the session openers reach past the session check if allowed.
    const session = await openSession(started, ALICE);
    const before = calls();
    for (const opener of OPENERS) {
      for (const origin of FOREIGN) {
        for (const token of [ALICE.token, undefined]) {
          const answer = await send(started, opener, {
            origin,
            session,
            ...(token === undefined ? {} : { token }),
          });
          const label = `${opener.name} ${JSON.stringify(origin)} ${token === undefined ? 'no token' : 'token'}`;
          expect(answer.status, label).toBe(403);
          expect(JSON.parse(answer.body), label).toEqual(REFUSAL);
        }
      }
    }
    // Not one of them reached the plugin.
    expect(calls()).toBe(before);
  });

  it('takes http and https on localhost, 127.0.0.1 and [::1] at any port, and a missing Origin', async () => {
    const started = await start({ auth: createDevTokenAuth([ALICE]) });
    const discover = OPENERS[4];
    if (!discover) throw new Error('no opener');
    for (const origin of [
      'http://localhost:5173',
      'https://localhost',
      'http://127.0.0.1:9',
      'https://127.0.0.1:65535',
      'http://[::1]:8080',
      undefined,
    ]) {
      const answer = await send(started, discover, {
        token: ALICE.token,
        ...(origin === undefined ? {} : { origin }),
      });
      expect(answer.status, String(origin)).toBe(200);
    }
    // Without a token an allowed Origin gets as far as the challenge.
    expect((await send(started, discover, { origin: 'http://localhost:5173' })).status).toBe(401);
  });

  it('adds the listed origins, which admit nothing to /page, and page origins admit nothing to /mcp', async () => {
    const started = await start({
      auth: createDevTokenAuth([ALICE]),
      mcpAllowedOrigins: ['https://claude.ai'],
      allowedOrigins: ['http://localhost:5173'],
    });
    const discover = OPENERS[4];
    if (!discover) throw new Error('no opener');
    expect(
      (await send(started, discover, { token: ALICE.token, origin: 'https://claude.ai' })).status,
    ).toBe(200);
    // The page origin is loopback, which /mcp takes here anyway; a page origin elsewhere would not be.
    await expect(
      openSocket(started.pageUrl, { origin: 'https://claude.ai' }),
    ).rejects.toBeInstanceOf(UpgradeRefused);
  });

  it('spends no request budget on a refused Origin', async () => {
    const started = await start({
      auth: createDevTokenAuth([ALICE]),
      rateLimits: { requestsPerUser: 3 },
    });
    const call = OPENERS[5];
    if (!call) throw new Error('no opener');
    for (let index = 0; index < 10; index += 1) {
      expect(
        (await send(started, call, { token: ALICE.token, origin: 'https://evil.example' })).status,
      ).toBe(403);
    }
    for (let index = 0; index < 3; index += 1) {
      const answer = await send(started, call, { token: ALICE.token });
      expect(answer.status).toBe(200);
      expect(answer.body).not.toContain('rate_limited');
    }
  });

  it('writes the refusal once a window, naming the origin cut to 200 characters and the address', async () => {
    atWindowStart();
    const started = await start({ auth: createDevTokenAuth([ALICE]) });
    const discover = OPENERS[4];
    if (!discover) throw new Error('no opener');
    const long = `https://${'e'.repeat(300)}.example`;
    for (let index = 0; index < 5; index += 1) {
      expect((await send(started, discover, { origin: long })).status).toBe(403);
    }
    const refused = logged('mcp request refused: origin not allowed');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ origin: long.slice(0, 200), address: '127.0.0.1' });
    expect(lines.join('\n')).not.toContain(long.slice(0, 201));
  });

  it('names each of the first origins refused in a window, and the most seen of the rest, so a trickle of others cannot hide one', async () => {
    atWindowStart();
    const started = await start({ auth: createDevTokenAuth([ALICE]) });
    const discover = OPENERS[4];
    if (!discover) throw new Error('no opener');
    const refuse = async (origin: string): Promise<void> => {
      expect((await send(started, discover, { origin })).status).toBe(403);
    };
    // Others get in first, as a trickle at each window's start would.
    for (let index = 0; index < MAX_NAMED_REFUSED_ORIGINS; index += 1) {
      await refuse(`http://first${String(index)}.example`);
    }
    await refuse('http://first0.example');
    // Then the origin the owner is looking for, among many others seen once each.
    for (let index = 0; index < 120; index += 1) {
      await refuse(`http://evil${String(index)}.example`);
      if (index % 15 === 0) await refuse('https://claude.ai');
    }
    const named = logged('mcp request refused: origin not allowed');
    expect(named.map((line) => line.origin)).toEqual(
      Array.from({ length: MAX_NAMED_REFUSED_ORIGINS }, (_, index) => {
        return `http://first${String(index)}.example`;
      }),
    );
    // The window's counts go out as it ends, or as the relay closes.
    await started.close();
    relay = undefined;
    expect(logged('mcp request refused: origin not allowed, repeated')).toEqual([
      expect.objectContaining({ origin: 'http://first0.example', repeated: 1 }),
    ]);
    const [rest] = logged('mcp request refused: origin not allowed, more origins than named');
    expect(rest).toMatchObject({ repeated: 128 });
    expect((rest?.mostSeen as { origin: string }[])[0]).toEqual({
      origin: 'https://claude.ai',
      refusedAtMost: 8,
    });
    // The shared /mcp lines' budget has none of them, so they crowd no other kind.
    expect(lines.filter((line) => line.includes('origin not allowed'))).toHaveLength(
      MAX_NAMED_REFUSED_ORIGINS + 2,
    );
  });

  it('names its policy in the start line', async () => {
    await start({ auth: createDevTokenAuth([ALICE]), mcpAllowedOrigins: ['https://claude.ai'] });
    expect(logged('relay listening')[0]).toMatchObject({
      mcpOrigins: 'loopback: http and https on localhost, 127.0.0.1 and [::1], https://claude.ai',
    });
  });
});

describe('with a public URL', () => {
  async function publicRelay(options: Partial<RelayOptions> = {}): Promise<Relay> {
    provider = await startProvider();
    return start({
      auth: createOAuthAuth({
        issuer: provider.issuer,
        resource: PUBLIC_MCP_URL,
        users: [{ sub: 'sub-alice', userId: 'alice', displayName: 'Alice' }],
      }),
      publicUrl: PUBLIC_ORIGIN,
      pairClient: PAIR_CLIENT,
      allowedOrigins: [PAGE_ORIGIN],
      ...options,
    });
  }

  it('takes the public origin alone, as written, beside the listed ones', async () => {
    const started = await publicRelay({ mcpAllowedOrigins: ['https://claude.ai'] });
    if (!provider) throw new Error('no provider');
    const token = await provider.token({ sub: 'sub-alice', aud: PUBLIC_MCP_URL });
    const host = new URL(PUBLIC_ORIGIN).host;
    const discover = OPENERS[4];
    if (!discover) throw new Error('no opener');
    for (const origin of [PUBLIC_ORIGIN, 'https://claude.ai', undefined]) {
      const answer = await send(started, discover, {
        token,
        host,
        ...(origin === undefined ? {} : { origin }),
      });
      expect(answer.status, String(origin)).toBe(200);
    }
    for (const origin of [
      'https://relay.test:8443',
      'http://relay.test',
      'https://RELAY.test',
      'http://localhost:5173',
      PAGE_ORIGIN,
      'https://evil.example',
    ]) {
      for (const opener of OPENERS) {
        const answer = await send(started, opener, { token, host, origin });
        expect(answer.status, `${opener.name} ${origin}`).toBe(403);
      }
    }
  });
});

describe('TABDOCK_MCP_ALLOWED_ORIGINS at start', () => {
  it('stops the relay over an entry that is no origin, naming its place and never its text', () => {
    const secret = 'sk-live-0123456789abcdef';
    let message = '';
    try {
      loadConfigFromEnv({
        TABDOCK_HOME: process.env.TABDOCK_HOME ?? '',
        TABDOCK_MCP_ALLOWED_ORIGINS: `https://ok.example,${secret}`,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/TABDOCK_MCP_ALLOWED_ORIGINS entry 2 is not an http or https origin/);
    expect(message).not.toContain(secret);
  });
});

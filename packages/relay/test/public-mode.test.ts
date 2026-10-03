// Public URL mode (ADR 0014): an https address in front of the loopback relay.
// The settings it refuses, the production rules it brings, OAuth as the only
// way in, the Host allowlist that admits the public host and nothing else, and
// /page kept to this machine. Then a client through the stand-in tunnel drives
// a local page, which is the M3 shape: phone in the cloud, page on the laptop.

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.ts';
import {
  createDevTokenAuth,
  createOAuthAuth,
  createRelay,
  loadConfigFromEnv,
  parseOAuthUsers,
  type Relay,
} from '../src/index.ts';
import {
  connectPage,
  openSocket,
  PAGE_ORIGIN,
  type TestPage,
  TOOLS,
  UpgradeRefused,
} from './helpers/page-client.ts';
import { startProvider, type TestProvider } from './helpers/provider.ts';
import { ALICE } from './helpers/relay.ts';
import {
  PUBLIC_MCP_URL,
  PUBLIC_METADATA_URL,
  PUBLIC_ORIGIN,
  rawRequest,
  tunnelFetch,
} from './helpers/tunnel.ts';

const PUBLIC_HOST = new URL(PUBLIC_ORIGIN).host;
const USERS = [{ sub: 'sub-alice', userId: 'alice', displayName: 'Alice' }];
const quiet = (): void => {
  // Swallow log lines.
};

/** An oauth plugin for the test public URL; construction alone fetches nothing. */
function offlinePlugin(resource = PUBLIC_MCP_URL): ReturnType<typeof createOAuthAuth> {
  return createOAuthAuth({ issuer: 'https://idp.example', resource, users: USERS });
}

describe('public URL settings (ADR 0014)', () => {
  it.each([
    'http://relay.test',
    'ws://relay.test',
    'relay.test',
    'https://relay.test/base',
    'https://relay.test/?q=1',
    'https://relay.test/#top',
    'https://user:secret@relay.test',
    'https://localhost',
    'https://127.0.0.1:8443',
    'https://[::1]',
  ])('refuses %j', (publicUrl) => {
    expect(() =>
      resolveConfig({ auth: offlinePlugin(), publicUrl, allowedOrigins: [PAGE_ORIGIN] }),
    ).toThrow(/TABDOCK_PUBLIC_URL/);
  });

  it('takes an https origin as written by people, and derives the connector URL and the Host allowlist', () => {
    const config = resolveConfig({
      auth: offlinePlugin(),
      publicUrl: 'https://Relay.Test:443/',
      allowedOrigins: [PAGE_ORIGIN],
    });
    expect(config.publicUrl).toBe(PUBLIC_ORIGIN);
    expect(config.publicMcpUrl).toBe(PUBLIC_MCP_URL);
    expect(config.allowedHosts).toEqual(['localhost', '127.0.0.1', '[::1]', 'relay.test']);
    // Without a public URL, loopback names only, as before.
    const local = resolveConfig({ auth: createDevTokenAuth([ALICE]) });
    expect(local.publicUrl).toBeNull();
    expect(local.allowedHosts).toEqual(['localhost', '127.0.0.1', '[::1]']);
  });

  it('applies the production rules whatever env says: an explicit origin list, no missing-origin flag', () => {
    expect(() => resolveConfig({ auth: offlinePlugin(), publicUrl: PUBLIC_ORIGIN })).toThrow(
      /public URL mode needs an explicit allowedOrigins/,
    );
    expect(() =>
      resolveConfig({
        auth: offlinePlugin(),
        publicUrl: PUBLIC_ORIGIN,
        allowedOrigins: [PAGE_ORIGIN],
        allowMissingOrigin: true,
      }),
    ).toThrow(/development flag; public URL mode requires an Origin header/);
  });

  it('accepts only the oauth plugin for its own address: dev tokens never cross the tunnel', async () => {
    expect(() =>
      resolveConfig({
        auth: createDevTokenAuth([ALICE]),
        publicUrl: PUBLIC_ORIGIN,
        allowedOrigins: [PAGE_ORIGIN],
      }),
    ).toThrow(/accepts only OAuth sign-in .*dev tokens are refused/);
    await expect(
      createRelay({
        auth: createDevTokenAuth([ALICE]),
        publicUrl: PUBLIC_ORIGIN,
        allowedOrigins: [PAGE_ORIGIN],
        logSink: quiet,
      }),
    ).rejects.toThrow(/accepts only OAuth sign-in/);
    expect(() =>
      resolveConfig({
        auth: offlinePlugin('https://elsewhere.test/mcp'),
        publicUrl: PUBLIC_ORIGIN,
        allowedOrigins: [PAGE_ORIGIN],
      }),
    ).toThrow(/checks tokens for https:\/\/elsewhere\.test\/mcp/);
    // And the oauth plugin has no use without a public URL.
    expect(() => resolveConfig({ auth: offlinePlugin() })).toThrow(/needs public URL mode/);
  });

  it('reads TABDOCK_PUBLIC_URL with the OAuth settings, and then ignores dev tokens', () => {
    const options = loadConfigFromEnv({
      TABDOCK_PUBLIC_URL: ' https://relay.test ',
      TABDOCK_OAUTH_ISSUER: 'https://idp.example',
      TABDOCK_OAUTH_USERS: 'user_01ABC=alice:Alice Smith, user_02DEF=bob',
      TABDOCK_ALLOWED_ORIGINS: PAGE_ORIGIN,
      TABDOCK_DEV_TOKENS: `alice=${'a'.repeat(30)}`,
    });
    expect(options.auth.name).toBe('oauth');
    expect(options.auth.resource).toBe(PUBLIC_MCP_URL);
    expect(options.publicUrl).toBe(PUBLIC_ORIGIN);
    expect(resolveConfig(options).publicMcpUrl).toBe(PUBLIC_MCP_URL);
    // Dev tokens alone still work as in M1 when no public URL is set.
    expect(
      loadConfigFromEnv({ TABDOCK_DEV_TOKENS: `alice=${'a'.repeat(30)}` }).publicUrl,
    ).toBeUndefined();
  });

  it('names what is missing or misplaced, never echoing a value', () => {
    expect(() => loadConfigFromEnv({ TABDOCK_PUBLIC_URL: PUBLIC_ORIGIN })).toThrow(
      /TABDOCK_PUBLIC_URL needs TABDOCK_OAUTH_ISSUER and TABDOCK_OAUTH_USERS/,
    );
    expect(() =>
      loadConfigFromEnv({
        TABDOCK_PUBLIC_URL: 'http://relay.test',
        TABDOCK_OAUTH_ISSUER: 'https://idp.example',
        TABDOCK_OAUTH_USERS: 's=alice',
      }),
    ).toThrow(/TABDOCK_PUBLIC_URL\) must be an https URL/);
    expect(() =>
      loadConfigFromEnv({
        TABDOCK_OAUTH_ISSUER: 'https://idp.example',
        TABDOCK_OAUTH_USERS: 's=alice',
        TABDOCK_DEV_TOKENS: `alice=${'a'.repeat(30)}`,
      }),
    ).toThrow(/work only with TABDOCK_PUBLIC_URL/);
    expect(() =>
      loadConfigFromEnv({
        TABDOCK_PUBLIC_URL: PUBLIC_ORIGIN,
        TABDOCK_OAUTH_ISSUER: 'http://idp.example',
        TABDOCK_OAUTH_USERS: 's=alice',
      }),
    ).toThrow(/TABDOCK_OAUTH_ISSUER/);
  });
});

describe('parseOAuthUsers', () => {
  it('reads sub=userId:Display Name entries, the name optional and free to hold : and =', () => {
    expect(
      parseOAuthUsers(
        ' user_01ABC=alice:Alice Smith , google-oauth2|1234=bob , auth0|x=carol:Carol: the = sign ,',
      ),
    ).toEqual([
      { sub: 'user_01ABC', userId: 'alice', displayName: 'Alice Smith' },
      { sub: 'google-oauth2|1234', userId: 'bob', displayName: 'bob' },
      { sub: 'auth0|x', userId: 'carol', displayName: 'Carol: the = sign' },
    ]);
  });

  it.each(['', ',', 'alice', '=alice', 'sub=', 'sub=:Name', 'sub=al ice', 'su b=alice'])(
    'refuses %j, naming the variable',
    (value) => {
      expect(() => parseOAuthUsers(value)).toThrow(/TABDOCK_OAUTH_USERS/);
    },
  );
});

describe('a relay with a public URL (ADR 0014)', () => {
  let provider: TestProvider;
  let relay: Relay;
  const lines: string[] = [];
  const pages: TestPage[] = [];
  const clients: Client[] = [];

  beforeEach(async () => {
    lines.length = 0;
    provider = await startProvider();
    relay = await createRelay({
      auth: createOAuthAuth({ issuer: provider.issuer, resource: PUBLIC_MCP_URL, users: USERS }),
      publicUrl: PUBLIC_ORIGIN,
      allowedOrigins: [PAGE_ORIGIN],
      logLevel: 'debug',
      logSink: (line) => {
        lines.push(line);
      },
    });
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    for (const page of pages.splice(0)) page.ws.terminate();
    await relay.close();
    await provider.stop();
  });

  const discover = (authorization: string, host?: string): ReturnType<typeof rawRequest> =>
    rawRequest(relay.url, '/mcp', {
      method: 'POST',
      ...(host === undefined ? {} : { host }),
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'server/discover',
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

  it('still binds loopback, and says where the connector lives', () => {
    expect(relay.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(relay.publicUrl).toBe(PUBLIC_ORIGIN);
    expect(relay.publicMcpUrl).toBe(PUBLIC_MCP_URL);
  });

  it('answers the public host and loopback names, and still refuses every other Host', async () => {
    const token = `Bearer ${await provider.token({ sub: 'sub-alice', aud: PUBLIC_MCP_URL })}`;
    for (const host of [PUBLIC_HOST, 'relay.test:443', '127.0.0.1', 'localhost:8787']) {
      expect((await discover(token, host)).status, host).toBe(200);
    }
    for (const host of ['evil.example', 'relay.test.evil.example', 'evil-relay.test']) {
      expect((await discover(token, host)).status, host).toBe(403);
    }
  });

  it('refuses dev tokens on every request, local or through the tunnel', async () => {
    for (const host of [undefined, PUBLIC_HOST]) {
      const answer = await discover(`Bearer ${ALICE.token}`, host);
      expect(answer.status).toBe(401);
      expect(answer.headers.get('www-authenticate')).toContain(
        `resource_metadata="${PUBLIC_METADATA_URL}"`,
      );
    }
    expect(lines.join('\n')).not.toContain(ALICE.token);
  });

  it('takes /page only from this machine', async () => {
    const local = await openSocket(relay.pageUrl);
    local.terminate();
    for (const headers of [
      { Host: PUBLIC_HOST },
      { Host: 'evil.example' },
      // A tunnel told to rewrite Host still says it forwarded the request.
      { 'X-Forwarded-For': '203.0.113.9' },
      { 'X-Forwarded-Host': PUBLIC_HOST },
      { Forwarded: 'for=203.0.113.9;proto=https' },
    ]) {
      const refused = await openSocket(relay.pageUrl, { headers }).then(
        (ws) => {
          ws.terminate();
          return null;
        },
        (error: unknown) => error,
      );
      expect(refused, JSON.stringify(headers)).toBeInstanceOf(UpgradeRefused);
      expect((refused as UpgradeRefused).status).toBe(403);
    }
    expect(lines.join('\n')).toContain('page socket refused: not made on this machine');
  });

  it('lets a client through the tunnel drive a page on this machine', async () => {
    const page = await connectPage(relay.pageUrl, {
      tools: TOOLS,
      onInvoke: (frame) => ({ ok: true, content: JSON.stringify({ tool: frame.tool }) }),
    });
    pages.push(page);
    const token = await provider.token({ sub: 'sub-alice', aud: PUBLIC_MCP_URL });
    const client = new Client({ name: 'phone', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(PUBLIC_MCP_URL), {
        authProvider: { token: () => Promise.resolve(token) },
        fetch: tunnelFetch(relay.url),
      }),
    );
    clients.push(client);
    const pairing = client.callTool({ name: 'pair_page', arguments: { code: page.code } });
    const request = await page.next('attach_request');
    expect(request.user).toEqual({ userId: 'alice', displayName: 'Alice' });
    page.send({ t: 'attach_decision', requestId: request.requestId, allow: true, role: 'driver' });
    expect((await pairing).isError ?? false).toBe(false);
    const called = await client.callTool({
      name: 'call_page_tool',
      arguments: { page: page.pageId, tool: 'get_view', arguments: {} },
    });
    const text = called.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    expect(called.isError ?? false, text).toBe(false);
    expect(text).toContain('"tool":"get_view"');
  });
});

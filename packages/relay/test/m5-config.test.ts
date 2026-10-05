// M5's two new settings before workstream A builds on them (docs/plans/M5.md,
// step 1): TABDOCK_FIRST_CLASS_TOOLS (ADR 0025), off by default in every mode
// and allowed in production, and TABDOCK_MCP_ALLOWED_ORIGINS (ADR 0027), the
// origins /mcp accepts beside its mode's own. Only their parsing and what the
// relay exposes are tested here; the tool surface and the 403 on /mcp come
// with workstream A.

import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIRST_CLASS_NOTIFY_INTERVAL_MS } from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  DEFAULT_RATE_LIMITS,
  MIN_REQUEST_BYTES,
  parseMcpAllowedOrigins,
  resolveConfig,
} from '../src/config.ts';
import { createDevTokenAuth, createRelay, loadConfigFromEnv } from '../src/index.ts';
import { PAGE_ORIGIN } from './helpers/page-client.ts';
import { PAIR_CLIENT } from './helpers/provider.ts';
import { ALICE } from './helpers/relay.ts';
import { PUBLIC_ORIGIN } from './helpers/tunnel.ts';

const scratches: string[] = [];

afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A TABDOCK_HOME of its own that does not exist yet. */
function freshHome(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tabdock-m5-')));
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

const auth = createDevTokenAuth([ALICE]);

describe('TABDOCK_FIRST_CLASS_TOOLS (ADR 0025)', () => {
  it('is off unless set, in every mode, local mode included', () => {
    expect(resolveEnv(DEV)).toMatchObject({ mode: 'dev_tokens', firstClassTools: false });
    expect(resolveEnv({ TABDOCK_HOME: freshHome() })).toMatchObject({
      mode: 'local',
      firstClassTools: false,
    });
    expect(resolveEnv(OAUTH)).toMatchObject({ mode: 'public', firstClassTools: false });
    expect(resolveEnv(HOSTED)).toMatchObject({ mode: 'hosted', firstClassTools: false });
  });

  it('is parsed like TABDOCK_INVITES, and allowed in every mode, production included', () => {
    for (const value of ['1', 'true', 'TRUE']) {
      expect(resolveEnv({ ...DEV, TABDOCK_FIRST_CLASS_TOOLS: value }).firstClassTools).toBe(true);
    }
    for (const value of ['0', 'false', '']) {
      expect(resolveEnv({ ...DEV, TABDOCK_FIRST_CLASS_TOOLS: value }).firstClassTools).toBe(false);
    }
    const on = { TABDOCK_FIRST_CLASS_TOOLS: '1' };
    expect(resolveEnv({ TABDOCK_HOME: freshHome(), ...on }).firstClassTools).toBe(true);
    expect(resolveEnv({ ...OAUTH, ...on }).firstClassTools).toBe(true);
    expect(resolveEnv({ ...HOSTED, ...on })).toMatchObject({
      env: 'production',
      firstClassTools: true,
    });
    expect(
      resolveEnv({ ...DEV, TABDOCK_ENV: 'production', TABDOCK_ALLOWED_ORIGINS: PAGE_ORIGIN, ...on })
        .firstClassTools,
    ).toBe(true);
  });

  it('refuses any other value by name, before local mode draws a token', () => {
    const home = freshHome();
    expect(() =>
      loadConfigFromEnv({ TABDOCK_HOME: home, TABDOCK_FIRST_CLASS_TOOLS: 'yes' }),
    ).toThrow(/TABDOCK_FIRST_CLASS_TOOLS must be 1, true, 0 or false/);
    expect(existsSync(home)).toBe(false);
  });

  it('takes only true from code, so a stray value leaves it off', () => {
    expect(resolveConfig({ auth, firstClassTools: true }).firstClassTools).toBe(true);
    expect(resolveConfig({ auth }).firstClassTools).toBe(false);
    const stray = { auth, firstClassTools: 'true' } as unknown as Parameters<
      typeof resolveConfig
    >[0];
    expect(resolveConfig(stray).firstClassTools).toBe(false);
  });

  it('is named in the relay listening line', async () => {
    for (const firstClassTools of [false, true]) {
      const lines: string[] = [];
      const relay = await createRelay({
        auth,
        firstClassTools,
        logSink: (line) => lines.push(line),
      });
      await relay.close();
      const listening = lines.find((line) => line.includes('"msg":"relay listening"')) ?? '';
      expect(listening).toContain(`"firstClassTools":${String(firstClassTools)}`);
    }
  });
});

describe('TABDOCK_MCP_ALLOWED_ORIGINS (ADR 0027)', () => {
  it('is a comma-separated list parsed like TABDOCK_ALLOWED_ORIGINS, empty adding nothing', () => {
    expect(loadConfigFromEnv(DEV).mcpAllowedOrigins).toBeUndefined();
    expect(loadConfigFromEnv({ ...DEV, TABDOCK_MCP_ALLOWED_ORIGINS: '  ' }).mcpAllowedOrigins).toBe(
      undefined,
    );
    expect(
      loadConfigFromEnv({
        ...DEV,
        TABDOCK_MCP_ALLOWED_ORIGINS: ' https://claude.ai , http://localhost:6274 ,',
      }).mcpAllowedOrigins,
    ).toEqual(['https://claude.ai', 'http://localhost:6274']);
    const empty = resolveConfig({ auth, mcpAllowedOrigins: [] });
    expect(empty.isMcpOriginAllowed('https://claude.ai')).toBe(false);
  });

  it.each([
    'https://claude.ai/',
    'https://claude.ai/mcp',
    'HTTPS://claude.ai',
    'https://Claude.ai',
    'https://claude.ai:443',
    'https://user@claude.ai',
    'https://claude.ai?x=1',
    'null',
    'claude.ai',
    'ftp://claude.ai',
    'chrome-extension://abcdef',
  ])('stops at start on %j, naming the variable and the entry, never echoing it', (bad) => {
    const message = thrown(() =>
      loadConfigFromEnv({
        ...DEV,
        TABDOCK_MCP_ALLOWED_ORIGINS: `https://ok.example,${bad}`,
      }),
    );
    expect(message).toContain('TABDOCK_MCP_ALLOWED_ORIGINS entry 2');
    expect(message).not.toContain(bad);
    // The same check holds for options given in code.
    expect(() => resolveConfig({ auth, mcpAllowedOrigins: [bad] })).toThrow(
      /TABDOCK_MCP_ALLOWED_ORIGINS entry 1/,
    );
  });

  it('stops before local mode draws a token', () => {
    const home = freshHome();
    expect(() =>
      loadConfigFromEnv({ TABDOCK_HOME: home, TABDOCK_MCP_ALLOWED_ORIGINS: 'https://x.example/' }),
    ).toThrow(/TABDOCK_MCP_ALLOWED_ORIGINS entry 1/);
    expect(existsSync(home)).toBe(false);
  });

  it('is allowed in every mode', () => {
    const listed = { TABDOCK_MCP_ALLOWED_ORIGINS: 'https://claude.ai' };
    const home = freshHome();
    for (const config of [
      resolveEnv({ ...DEV, ...listed }),
      resolveEnv({ TABDOCK_HOME: home, ...listed }),
      resolveEnv({ ...OAUTH, ...listed }),
      resolveEnv({ ...HOSTED, ...listed }),
    ]) {
      expect(config.isMcpOriginAllowed('https://claude.ai'), config.mode).toBe(true);
    }
    expect(readdirSync(home)).toContain('owner-token');
  });

  describe('without a public URL (local mode and dev tokens)', () => {
    const config = resolveEnv({ ...DEV, TABDOCK_MCP_ALLOWED_ORIGINS: 'https://claude.ai' });

    it.each([
      'http://localhost',
      'http://localhost:5173',
      'https://localhost:8443',
      'http://127.0.0.1:8787',
      'https://127.0.0.1',
      'http://[::1]:6274',
      'https://claude.ai',
    ])('accepts %j', (origin) => {
      expect(config.isMcpOriginAllowed(origin)).toBe(true);
    });

    it.each([
      '',
      'null',
      'https://evil.example',
      'http://localhost:5173/',
      'http://LOCALHOST:5173',
      'http://localhost.:5173',
      'http://127.0.0.2',
      'http://[::2]',
      'ws://localhost:5173',
      // Two Origin lines, as Node joins them.
      'http://localhost:5173, https://evil.example',
      'https://claude.ai, https://claude.ai',
      'https://claude.ai/',
      PUBLIC_ORIGIN,
    ])('refuses %j, compared as written', (origin) => {
      expect(config.isMcpOriginAllowed(origin)).toBe(false);
    });

    it('names the policy for the start line', () => {
      expect(config.mcpOriginPolicy).toBe(
        'loopback: http and https on localhost, 127.0.0.1 and [::1], https://claude.ai',
      );
      expect(resolveEnv(DEV).mcpOriginPolicy).toBe(
        'loopback: http and https on localhost, 127.0.0.1 and [::1]',
      );
    });
  });

  describe('with a public URL (public and hosted mode)', () => {
    const publicHost = new URL(PUBLIC_ORIGIN).host;

    it.each([
      ['public', OAUTH],
      ['hosted', HOSTED],
    ])('%s mode accepts the public origin alone, and the listed ones', (_mode, env) => {
      const config = resolveEnv({ ...env, TABDOCK_MCP_ALLOWED_ORIGINS: 'https://claude.ai' });
      expect(config.isMcpOriginAllowed(PUBLIC_ORIGIN)).toBe(true);
      expect(config.isMcpOriginAllowed('https://claude.ai')).toBe(true);
      for (const origin of [
        // The public host over http or on another port, which a hostname check would pass.
        `http://${publicHost}`,
        `https://${publicHost}:8443`,
        `${PUBLIC_ORIGIN}/`,
        PUBLIC_ORIGIN.toUpperCase(),
        // Loopback is this machine's, not the public relay's.
        'http://localhost:5173',
        'http://127.0.0.1:8787',
        'null',
        '',
        `${PUBLIC_ORIGIN}, https://claude.ai`,
      ]) {
        expect(config.isMcpOriginAllowed(origin), origin).toBe(false);
      }
      expect(config.mcpOriginPolicy).toBe(`${PUBLIC_ORIGIN}, https://claude.ai`);
    });
  });

  it('keeps the page list and the /mcp list apart', () => {
    const config = resolveEnv({
      ...OAUTH,
      TABDOCK_ALLOWED_ORIGINS: 'https://page.example',
      TABDOCK_MCP_ALLOWED_ORIGINS: 'https://client.example',
    });
    expect(config.isOriginAllowed('https://page.example')).toBe(true);
    expect(config.isMcpOriginAllowed('https://page.example')).toBe(false);
    expect(config.isMcpOriginAllowed('https://client.example')).toBe(true);
    expect(config.isOriginAllowed('https://client.example')).toBe(false);
  });

  it('exports the entry check it runs at start', () => {
    expect(parseMcpAllowedOrigins([' https://a.example ', 'http://[::1]:1'])).toEqual([
      'https://a.example',
      'http://[::1]:1',
    ]);
  });
});

describe('the request total with invites on (ADR 0032)', () => {
  it('refuses a total under twice the least setting, so invitees never hold more than half of it', () => {
    const memberOnly = { ...OAUTH, TABDOCK_MAX_REQUEST_BYTES_PER_USER: String(MIN_REQUEST_BYTES) };
    const settings = { ...memberOnly, TABDOCK_INVITES: '1' };
    const message = thrown(() =>
      resolveEnv({ ...settings, TABDOCK_MAX_REQUEST_BYTES: String(2 * MIN_REQUEST_BYTES - 1) }),
    );
    expect(message).toMatch(
      /^invites \(TABDOCK_INVITES\) need requestBytes \(TABDOCK_MAX_REQUEST_BYTES\)/,
    );
    expect(
      resolveEnv({ ...settings, TABDOCK_MAX_REQUEST_BYTES: String(2 * MIN_REQUEST_BYTES) }).limits
        .requestBytes,
    ).toBe(2 * MIN_REQUEST_BYTES);
    // Without invites the least setting still starts, as before.
    expect(
      resolveEnv({ ...memberOnly, TABDOCK_MAX_REQUEST_BYTES: String(MIN_REQUEST_BYTES) }).limits
        .requestBytes,
    ).toBe(MIN_REQUEST_BYTES);
  });
});

describe('tool list changes against the request budget (ADRs 0025, 0030 and 0032)', () => {
  // Every 2026-07-28 tools/list spends a request, and with first-class tools
  // on every 2025-era one too, and a client lists again on each change. At one
  // change a second, a page that kept changing its tools spent all of a
  // member's 240 a minute through four clients, and every call they made on
  // any page answered rate_limited.
  const listsPerMinute = DEFAULT_RATE_LIMITS.windowMs / FIRST_CLASS_NOTIFY_INTERVAL_MS;

  it("leaves four clients that list again on every change nine tenths of a member's requests", () => {
    expect(4 * listsPerMinute).toBeLessThanOrEqual(DEFAULT_RATE_LIMITS.requestsPerUser / 10);
  });

  it('leaves half of them with every session a member may hold doing the same', () => {
    expect(DEFAULT_LIMITS.sessionsPerUser * listsPerMinute).toBeLessThanOrEqual(
      DEFAULT_RATE_LIMITS.requestsPerUser / 2,
    );
  });
});

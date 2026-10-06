import { createServer, type IncomingMessage } from 'node:http';
import { DEFAULT_CALL_DEADLINE_MS, MAX_TIMER_MS } from '@tabdock/protocol';
import { describe, expect, it } from 'vitest';
import { isLoopbackHost, parseHostHeader, resolveConfig } from '../src/config.ts';
import {
  createDevTokenAuth,
  createRelay,
  DEFAULT_CLI_PORT,
  loadConfigFromEnv,
  MIN_DEV_TOKEN_LENGTH,
  parseDevTokens,
} from '../src/index.ts';

const TOKEN = 'k'.repeat(MIN_DEV_TOKEN_LENGTH);
const auth = createDevTokenAuth([{ userId: 'alice', displayName: 'Alice', token: TOKEN }]);
const quiet = (): void => {
  // Swallow log lines.
};

/** Some sandboxes have no IPv6 loopback at all. */
const hasIpv6Loopback = await new Promise<boolean>((resolve) => {
  const probe = createServer();
  probe.once('error', () => {
    resolve(false);
  });
  probe.listen(0, '::1', () => {
    probe.close(() => {
      resolve(true);
    });
  });
});

function requestWith(authorization?: string): IncomingMessage {
  return {
    headers: authorization === undefined ? {} : { authorization },
  } as unknown as IncomingMessage;
}

describe('host binding (S12)', () => {
  // Outside hosted mode (ADR 0018), which test/hosted.test.ts covers.
  it.each(['0.0.0.0', '::', '192.168.1.20', '10.0.0.1', '127.0.0.2', 'relay.example', ''])(
    'refuses %j and names hosted mode as the only way off loopback',
    (host) => {
      expect(() => resolveConfig({ auth, host })).toThrow(/only on loopback.*unless.*hosted mode/);
    },
  );

  it.each(['127.0.0.1', 'localhost', '::1', '[::1]', 'LOCALHOST'])('accepts %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
    expect(resolveConfig({ auth, host }).host).toBe(host);
  });
});

describe('Host headers (RFC 9110)', () => {
  it.each<[string, string]>([
    ['localhost', 'localhost'],
    ['LocalHost:8787', 'localhost'],
    ['127.0.0.1:0', '127.0.0.1'],
    ['[::1]', '[::1]'],
    ['[::1]:65535', '[::1]'],
    ['Relay.Example', 'relay.example'],
    ['my_relay.example', 'my_relay.example'],
    // Well formed, so read as written; an allowlist then refuses them.
    ['2130706433', '2130706433'],
    ['localhost.', 'localhost.'],
  ])('reads %j as %j', (header, host) => {
    expect(parseHostHeader(header)).toBe(host);
  });

  it.each([
    '',
    ':8787',
    'localhost:',
    'localhost:65536',
    'localhost:123456',
    'evil.example@localhost',
    'u:p@localhost',
    'localhost/evil',
    'localhost?evil',
    'localhost#evil',
    'localhost\\evil',
    'loc%61lhost',
    'local host',
    'localhost,evil.example',
    '[::1',
    '[localhost]',
    '[::1%25eth0]',
    '[v1.fe]',
    'bücher.example',
  ])('refuses %j, which is no host', (header) => {
    expect(parseHostHeader(header)).toBeNull();
  });

  it('refuses before listening, and defaults to 127.0.0.1 on a free port', async () => {
    await expect(createRelay({ auth, host: '0.0.0.0', logSink: quiet })).rejects.toThrow(
      /hosted mode/,
    );
    const relay = await createRelay({ auth, logSink: quiet });
    try {
      expect(relay.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(relay.pageUrl).toBe(`${relay.url.replace('http:', 'ws:')}/page`);
      expect(relay.mcpUrl).toBe(`${relay.url}/mcp`);
      const health = await fetch(`${relay.url}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.text()).toBe('ok');
    } finally {
      await relay.close();
    }
  });

  it('rejects cleanly when the port is taken', async () => {
    const first = await createRelay({ auth, logSink: quiet });
    try {
      const port = Number(new URL(first.url).port);
      await expect(createRelay({ auth, port, logSink: quiet })).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await first.close();
    }
  });

  it.skipIf(!hasIpv6Loopback)('binds IPv6 loopback with a bracketed URL', async () => {
    const relay = await createRelay({ auth, host: '::1', logSink: quiet });
    try {
      expect(relay.url).toMatch(/^http:\/\/\[::1\]:\d+$/);
    } finally {
      await relay.close();
    }
  });
});

describe('origin policy (S1, S2)', () => {
  it('production refuses to start without an explicit, non-empty list', () => {
    expect(() => resolveConfig({ auth, env: 'production' })).toThrow(/allowedOrigins/);
    expect(() => resolveConfig({ auth, env: 'production', allowedOrigins: [] })).toThrow(/empty/);
    expect(
      resolveConfig({ auth, env: 'production', allowedOrigins: ['https://app.example'] }).env,
    ).toBe('production');
  });

  it('allowMissingOrigin is development only', () => {
    expect(() =>
      resolveConfig({
        auth,
        env: 'production',
        allowedOrigins: ['https://app.example'],
        allowMissingOrigin: true,
      }),
    ).toThrow(/development flag/);
    expect(resolveConfig({ auth, allowMissingOrigin: true }).allowMissingOrigin).toBe(true);
    expect(resolveConfig({ auth }).allowMissingOrigin).toBe(false);
  });

  it('dev default allows only http and https on localhost, 127.0.0.1 and [::1], at any port', () => {
    const { isOriginAllowed } = resolveConfig({ auth });
    for (const origin of [
      'http://localhost:5173',
      'https://localhost',
      'http://127.0.0.1:1',
      'https://127.0.0.1:8443',
      'http://[::1]:3000',
    ]) {
      expect(isOriginAllowed(origin), origin).toBe(true);
    }
    for (const origin of [
      'https://evil.example',
      'http://localhost.evil.example',
      'http://127.0.0.2:5173',
      'file://',
      'null',
      'chrome-extension://abc',
      'http://localhost:5173/path',
      'HTTP://LOCALHOST:5173',
      '',
    ]) {
      expect(isOriginAllowed(origin), origin).toBe(false);
    }
  });

  it('an explicit list replaces the dev default and must hold real origins', () => {
    const { isOriginAllowed } = resolveConfig({ auth, allowedOrigins: ['https://app.example'] });
    expect(isOriginAllowed('https://app.example')).toBe(true);
    expect(isOriginAllowed('http://localhost:5173')).toBe(false);
    expect(() => resolveConfig({ auth, allowedOrigins: ['app.example'] })).toThrow(/not an origin/);
    expect(() => resolveConfig({ auth, allowedOrigins: ['https://app.example/x'] })).toThrow(
      /not an origin/,
    );
  });

  it('rejects bad timings and rate limits', () => {
    expect(() => resolveConfig({ auth, timings: { pairWaitMs: 0 } })).toThrow(/pairWaitMs/);
    expect(() => resolveConfig({ auth, rateLimits: { pairAttemptsPerUser: 1.5 } })).toThrow(
      /pairAttemptsPerUser/,
    );
    expect(resolveConfig({ auth, timings: { pairWaitMs: 1234 } }).timings.pairWaitMs).toBe(1234);
  });

  it('defaults the section 9 limits and lifetimes to ADR 0009, and checks every override', () => {
    const { limits, rateLimits, timings } = resolveConfig({ auth });
    expect(limits).toEqual({
      sessionsPerUser: 20,
      sessions: 1000,
      inviteeSessions: 50,
      sessionsPerInvitee: 2,
      usersPerPage: 10,
      queueDepth: 32,
      pageSocketsPerAddress: 20,
      pageSessionsPerAddress: 20,
      pageSessions: 1000,
      pairSessions: 200,
      pairSignInsInFlight: 8,
      signInsInFlightPerAddress: 2,
      toolBytes: 64 * 1024 * 1024,
      requestBytes: 64 * 1024 * 1024,
      requestBytesPerUser: 24 * 1024 * 1024,
    });
    expect(rateLimits.callsPerUserPerPage).toBe(120);
    expect(rateLimits.pairSignIns).toBe(60);
    expect(timings.sessionIdleMs).toBe(30 * 60_000);
    expect(timings.attachmentIdleMs).toBe(8 * 60 * 60_000);
    expect(timings.sseKeepAliveMs).toBe(15_000);
    expect(timings.pairSessionMs).toBe(15 * 60_000);
    expect(resolveConfig({ auth, limits: { usersPerPage: 3 } }).limits.usersPerPage).toBe(3);
    expect(() => resolveConfig({ auth, limits: { queueDepth: 0 } })).toThrow(/queueDepth/);
    expect(() => resolveConfig({ auth, limits: { sessions: 2.5 } })).toThrow(/sessions/);
    expect(() => resolveConfig({ auth, rateLimits: { callsPerUserPerPage: -1 } })).toThrow(
      /callsPerUserPerPage/,
    );
    // Node runs a longer setTimeout after 1 ms, which would expire everything at once.
    expect(() =>
      resolveConfig({ auth, timings: { attachmentIdleMs: 30 * 24 * 60 * 60_000 } }),
    ).toThrow(/attachmentIdleMs must be at most 2147483647/);
  });

  it("waits a 2 s grace past the page's call deadline by default", () => {
    const { timings } = resolveConfig({ auth });
    expect(timings.callDeadlineMs).toBe(DEFAULT_CALL_DEADLINE_MS);
    expect(timings.callDeadlineGraceMs).toBe(2000);
    expect(() => resolveConfig({ auth, timings: { callDeadlineGraceMs: -1 } })).toThrow(
      /callDeadlineGraceMs/,
    );
  });

  it('gives each argument check 50 ms by default, bounded like every other timing (ADR 0010)', () => {
    expect(resolveConfig({ auth }).timings.argumentCheckMs).toBe(50);
    expect(resolveConfig({ auth, timings: { argumentCheckMs: 80 } }).timings.argumentCheckMs).toBe(
      80,
    );
    expect(() => resolveConfig({ auth, timings: { argumentCheckMs: 0 } })).toThrow(
      /argumentCheckMs must be a positive integer/,
    );
    expect(() => resolveConfig({ auth, timings: { argumentCheckMs: 12.5 } })).toThrow(
      /argumentCheckMs must be a positive integer/,
    );
    expect(() => resolveConfig({ auth, timings: { argumentCheckMs: MAX_TIMER_MS + 1 } })).toThrow(
      /argumentCheckMs must be at most 2147483647/,
    );
  });

  it('refuses a call deadline whose sum with the grace would not fit one setTimeout', () => {
    // A call's timer is armed for both together, and Node runs a longer one after 1 ms.
    expect(() =>
      resolveConfig({ auth, timings: { callDeadlineMs: MAX_TIMER_MS, callDeadlineGraceMs: 2000 } }),
    ).toThrow(/callDeadlineMs plus callDeadlineGraceMs must be at most 2147483647/);
    expect(() => resolveConfig({ auth, timings: { callDeadlineMs: MAX_TIMER_MS - 1999 } })).toThrow(
      /callDeadlineMs plus callDeadlineGraceMs/,
    );
    const fits = resolveConfig({
      auth,
      timings: { callDeadlineMs: MAX_TIMER_MS - 2000, callDeadlineGraceMs: 2000 },
    });
    expect(fits.timings.callDeadlineMs + fits.timings.callDeadlineGraceMs).toBe(MAX_TIMER_MS);
  });
});

describe('loadConfigFromEnv', () => {
  const tokens = `alice=${TOKEN},bob=${'b'.repeat(30)}`;

  it('reads every variable, with port 8787 by default', () => {
    const options = loadConfigFromEnv({ TABDOCK_DEV_TOKENS: tokens });
    expect(options.port).toBe(DEFAULT_CLI_PORT);
    expect(options.host).toBeUndefined();
    expect(options.env).toBe('development');
    expect(options.allowedOrigins).toBeUndefined();
    expect(options.allowMissingOrigin).toBe(false);
    expect(options.auth.name).toBe('dev-token');

    const full = loadConfigFromEnv({
      TABDOCK_DEV_TOKENS: tokens,
      TABDOCK_HOST: '::1',
      TABDOCK_PORT: '0',
      TABDOCK_ENV: 'production',
      TABDOCK_ALLOWED_ORIGINS: ' https://a.example , https://b.example ,',
      TABDOCK_DEV_ALLOW_NO_ORIGIN: 'true',
    });
    expect(full).toMatchObject({
      host: '::1',
      port: 0,
      env: 'production',
      allowedOrigins: ['https://a.example', 'https://b.example'],
      allowMissingOrigin: true,
    });
  });

  it('reads the limits and the idle lifetimes, in minutes, leaving unset ones to the defaults', () => {
    const options = loadConfigFromEnv({
      TABDOCK_DEV_TOKENS: tokens,
      TABDOCK_MAX_SESSIONS_PER_USER: '5',
      TABDOCK_MAX_SESSIONS: '50',
      TABDOCK_MAX_USERS_PER_PAGE: ' 4 ',
      TABDOCK_MAX_QUEUE_DEPTH: '8',
      TABDOCK_MAX_PAGE_SOCKETS_PER_ADDRESS: '3',
      TABDOCK_MAX_PAGE_SESSIONS_PER_ADDRESS: '6',
      TABDOCK_MAX_PAGE_SESSIONS: '30',
      TABDOCK_MAX_CALLS_PER_MINUTE: '60',
      TABDOCK_MAX_PAIR_SIGNINS_PER_MINUTE: '20',
      TABDOCK_MAX_PAIR_SIGNINS_IN_FLIGHT: '4',
      TABDOCK_SESSION_IDLE_MINUTES: '10',
      TABDOCK_ATTACHMENT_IDLE_MINUTES: '120',
    });
    const config = resolveConfig(options);
    expect(config.limits).toEqual({
      sessionsPerUser: 5,
      sessions: 50,
      inviteeSessions: 50,
      sessionsPerInvitee: 2,
      usersPerPage: 4,
      queueDepth: 8,
      pageSocketsPerAddress: 3,
      pageSessionsPerAddress: 6,
      pageSessions: 30,
      pairSessions: 200,
      pairSignInsInFlight: 4,
      signInsInFlightPerAddress: 2,
      toolBytes: 64 * 1024 * 1024,
      requestBytes: 64 * 1024 * 1024,
      requestBytesPerUser: 24 * 1024 * 1024,
    });
    expect(config.rateLimits.callsPerUserPerPage).toBe(60);
    expect(config.rateLimits.pairSignIns).toBe(20);
    expect(config.timings.sessionIdleMs).toBe(10 * 60_000);
    expect(config.timings.attachmentIdleMs).toBe(120 * 60_000);
    const defaults = resolveConfig(
      loadConfigFromEnv({ TABDOCK_DEV_TOKENS: tokens, TABDOCK_MAX_QUEUE_DEPTH: '' }),
    );
    expect(defaults.limits.queueDepth).toBe(32);
    expect(defaults.limits.pairSignInsInFlight).toBe(8);
    expect(defaults.rateLimits.pairSignIns).toBe(60);
    expect(defaults.timings.attachmentIdleMs).toBe(8 * 60 * 60_000);
    for (const [name, value] of [
      ['TABDOCK_MAX_QUEUE_DEPTH', '0'],
      ['TABDOCK_MAX_USERS_PER_PAGE', 'ten'],
      ['TABDOCK_MAX_CALLS_PER_MINUTE', '1.5'],
      ['TABDOCK_MAX_PAIR_SIGNINS_PER_MINUTE', '0'],
      ['TABDOCK_MAX_PAIR_SIGNINS_IN_FLIGHT', 'eight'],
      ['TABDOCK_SESSION_IDLE_MINUTES', '-3'],
      ['TABDOCK_ATTACHMENT_IDLE_MINUTES', '99999'],
    ] as const) {
      expect(() => loadConfigFromEnv({ TABDOCK_DEV_TOKENS: tokens, [name]: value }), name).toThrow(
        new RegExp(name),
      );
    }
  });

  it('runs local mode with no settings at all, where M1 refused (ADR 0022)', () => {
    // The vitest setup points HOME and the rest at throwaway directories, and
    // an empty environment names none, so the injected home directory is used.
    const options = loadConfigFromEnv({});
    expect(options.auth.name).toBe('dev-token');
    expect(options.auth.loopbackOnly).toBe(true);
    expect(options.localMode?.tokenPath.endsWith('owner-token')).toBe(true);
    expect(options.port).toBe(DEFAULT_CLI_PORT);
  });

  it('trims a flag as it trims every setting, so spaces alone read as unset and leave it off', () => {
    const flags = (value: string) =>
      loadConfigFromEnv({
        TABDOCK_DEV_TOKENS: tokens,
        TABDOCK_DEV_ALLOW_NO_ORIGIN: value,
        TABDOCK_INVITES: value,
        TABDOCK_FIRST_CLASS_TOOLS: value,
        TABDOCK_SPIKE: value,
      });
    for (const on of [' 1 ', '\ttrue', 'TRUE  ']) {
      expect(flags(on), JSON.stringify(on)).toMatchObject({
        allowMissingOrigin: true,
        invites: true,
        firstClassTools: true,
        spike: true,
      });
    }
    // Blank, as a blank count or URL is: the setting is unset, so the flag stays off.
    for (const off of ['   ', ' 0 ', ' false', '\t']) {
      expect(flags(off), JSON.stringify(off)).toMatchObject({
        allowMissingOrigin: false,
        invites: false,
        firstClassTools: false,
        spike: false,
      });
    }
    for (const bad of [' yes ', '1 1', 'on']) {
      expect(() => flags(bad), JSON.stringify(bad)).toThrow(/must be 1, true, 0 or false/);
    }
  });

  it('names the bad variable and never echoes a token', () => {
    expect(() => loadConfigFromEnv({ TABDOCK_DEV_TOKENS: tokens, TABDOCK_PORT: 'x' })).toThrow(
      /TABDOCK_PORT/,
    );
    expect(() => loadConfigFromEnv({ TABDOCK_DEV_TOKENS: tokens, TABDOCK_PORT: '70000' })).toThrow(
      /TABDOCK_PORT/,
    );
    expect(() => loadConfigFromEnv({ TABDOCK_DEV_TOKENS: tokens, TABDOCK_ENV: 'prod' })).toThrow(
      /TABDOCK_ENV/,
    );
    expect(() =>
      loadConfigFromEnv({ TABDOCK_DEV_TOKENS: tokens, TABDOCK_DEV_ALLOW_NO_ORIGIN: 'yes' }),
    ).toThrow(/TABDOCK_DEV_ALLOW_NO_ORIGIN/);
    const short = 'short-secret-value';
    let message = '';
    try {
      loadConfigFromEnv({ TABDOCK_DEV_TOKENS: `alice=${short}` });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/^TABDOCK_DEV_TOKENS entry 1 has a token shorter than 24/);
    expect(message).not.toContain(short);
  });

  it('production from env still needs origins, and the host check still applies', async () => {
    const options = loadConfigFromEnv({ TABDOCK_DEV_TOKENS: tokens, TABDOCK_ENV: 'production' });
    await expect(createRelay({ ...options, logSink: quiet })).rejects.toThrow(/allowedOrigins/);
    const open = loadConfigFromEnv({ TABDOCK_DEV_TOKENS: tokens, TABDOCK_HOST: '0.0.0.0' });
    await expect(createRelay({ ...open, logSink: quiet })).rejects.toThrow(/hosted mode/);
  });
});

describe('parseDevTokens', () => {
  it('parses user=token pairs, splitting on the first = only', () => {
    expect(parseDevTokens(` alice=${TOKEN}== , bob=x=${TOKEN} ,`)).toEqual([
      { userId: 'alice', displayName: 'alice', token: `${TOKEN}==` },
      { userId: 'bob', displayName: 'bob', token: `x=${TOKEN}` },
    ]);
  });

  it('refuses a token check by entry number, so a token written where the user id goes is never printed', () => {
    // Local mode's owner token and a hex token both pass as user ids.
    const owner = `tabdock_${'Zq7Mark9Wq'.repeat(4)}abc`;
    const hex = 'ab'.repeat(32);
    const other = 'j'.repeat(MIN_DEV_TOKEN_LENGTH);
    const refusals: [string, RegExp][] = [
      [`${owner}=you`, /^TABDOCK_DEV_TOKENS entry 1 has a token shorter than 24 characters$/],
      [`alice=${TOKEN},${hex}=alice`, /^TABDOCK_DEV_TOKENS entry 2 has a token shorter than 24/],
      [`${owner}=${TOKEN} x`, /^TABDOCK_DEV_TOKENS entry 1 has a token that is not printable/],
      [
        `${owner}=${TOKEN},${owner}=${other}`,
        /^TABDOCK_DEV_TOKENS entries 1 and 2 name the same user id$/,
      ],
      [`${owner}=${TOKEN},${hex}=${TOKEN}`, /^TABDOCK_DEV_TOKENS entries 1 and 2 share a token$/],
    ];
    for (const [value, refusal] of refusals) {
      let message = '';
      try {
        parseDevTokens(value);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, value).toMatch(refusal);
      expect(message, value).not.toContain('Zq7Mark9Wq');
      expect(message, value).not.toContain(hex);
    }
  });

  it.each(['', ',', 'alice', 'alice=', '=token', 'al ice=token', 'alice=a,bob'])(
    'refuses %j without echoing it',
    (value) => {
      let message = '';
      try {
        parseDevTokens(value);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/TABDOCK_DEV_TOKENS/);
      if (value.includes('token')) expect(message).not.toContain('token=');
    },
  );
});

describe('dev-token auth', () => {
  it('refuses short, duplicate and shared tokens at construction', () => {
    expect(() =>
      createDevTokenAuth([{ userId: 'alice', displayName: 'Alice', token: 'x'.repeat(23) }]),
    ).toThrow(/shorter than 24/);
    expect(() =>
      createDevTokenAuth([
        { userId: 'alice', displayName: 'Alice', token: TOKEN },
        { userId: 'alice', displayName: 'Alice again', token: `${TOKEN}2` },
      ]),
    ).toThrow(/listed twice/);
    expect(() =>
      createDevTokenAuth([
        { userId: 'alice', displayName: 'Alice', token: TOKEN },
        { userId: 'bob', displayName: 'Bob', token: TOKEN },
      ]),
    ).toThrow(/share a token/);
    expect(() =>
      createDevTokenAuth([{ userId: 'alice', displayName: 'Alice', token: `${TOKEN} x` }]),
    ).toThrow(/printable/);
    expect(() => createDevTokenAuth([])).toThrow(/at least one/);
  });

  it('reads Authorization: Bearer <token> and nothing else', async () => {
    const two = createDevTokenAuth([
      { userId: 'alice', displayName: 'Alice', token: TOKEN },
      { userId: 'bob', displayName: 'Bob', token: 'b'.repeat(40) },
    ]);
    // A dev token names a member with no verified email and no OAuth client (ADRs 0017 and 0019).
    expect(await two.authenticate(requestWith(`Bearer ${TOKEN}`))).toEqual({
      kind: 'user',
      user: { userId: 'alice', displayName: 'Alice', account: { kind: 'member', email: null } },
      oauthClientId: null,
    });
    expect(await two.authenticate(requestWith(`bearer ${'b'.repeat(40)}`))).toEqual({
      kind: 'user',
      user: { userId: 'bob', displayName: 'Bob', account: { kind: 'member', email: null } },
      oauthClientId: null,
    });
    for (const header of [
      undefined,
      '',
      TOKEN,
      `Basic ${TOKEN}`,
      `Bearer ${TOKEN}x`,
      `Bearer ${TOKEN.slice(1)}`,
      `Bearer ${TOKEN} extra`,
      `Bearer ${'k'.repeat(5000)}`,
    ]) {
      // The same refusal as since M1: a 401 that names no metadata, since dev tokens need no sign-in.
      expect(await two.authenticate(requestWith(header)), String(header)).toEqual({
        kind: 'refused',
        status: 401,
        reason: 'no valid dev token',
        body: 'Unauthorized',
        headers: { 'WWW-Authenticate': 'Bearer realm="tabdock"' },
        // Nothing to say about an account or a client before a token matches (ADR 0020).
        accountKind: null,
        oauthClientId: null,
      });
    }
  });
});

// M6's settings before the waves build on them (docs/plans/M6.md, section
// 2.5): every default, bound and refusal, read from the environment and
// checked again in resolveConfig for options given in code. The largest
// image (ADR 0039, where 0 turns images off), the relay-wide budgets for page
// state, proposals and unread answers (ADRs 0040, 0042 and 0044), the
// watching seats, the invitee pool and agent tokens, which mean nothing
// without invites (ADR 0044), the members file in public URL mode (ADR 0043)
// and the restart snapshot, which needs an audit directory (ADR 0046). Every
// refusal names its setting and never the value it was given (R1, R2).

import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_IMAGE_BYTES,
  MAX_FRAME_BYTES,
  MAX_IMAGE_BYTES,
  MAX_OBSERVERS_PER_PAGE,
  MAX_USERS_PER_PAGE,
  MEMBERS_POLL_MS,
  PROPOSAL_TTL_MS,
} from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTH_SETTINGS,
  DEFAULT_LIMITS,
  DEFAULT_RATE_LIMITS,
  DEFAULT_TIMINGS,
  HOSTED_LIMITS,
  INVITEE_SESSIONS,
  MIN_INVITEE_SESSIONS,
  MIN_RESPONSE_BYTES,
  OBSERVERS_PER_PAGE,
  PROPOSAL_BYTES,
  type RelayOptions,
  RESPONSE_BYTES,
  resolveConfig,
  STATE_BYTES,
} from '../src/config.ts';
import { createDevTokenAuth, loadConfigFromEnv } from '../src/index.ts';
import { PAGE_ORIGIN } from './helpers/page-client.ts';
import { PAIR_CLIENT } from './helpers/provider.ts';
import { ALICE } from './helpers/relay.ts';
import { PUBLIC_ORIGIN } from './helpers/tunnel.ts';

const scratches: string[] = [];

afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A directory of its own, removed after the test. */
function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tabdock-m6-')));
  scratches.push(dir);
  return dir;
}

/** A TABDOCK_HOME of its own that does not exist yet. */
function freshHome(): string {
  return join(scratch(), 'tabdock');
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
const DEV_INVITES = { ...DEV, TABDOCK_INVITES: '1' };

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

/**
 * Refused at start with exactly these words, in either layer, and never
 * with the value given. Both layers read it: main.ts runs one, then the other.
 */
function refusedWith(env: Record<string, string>, given: string, words: string): void {
  const message = thrown(() => resolveEnv(env));
  expect(message).toBe(words);
  expect(message).not.toContain(given);
}

const auth = createDevTokenAuth([ALICE]);

/** Options for code that bypasses the type checker, as a JavaScript caller might. */
function stray(options: Record<string, unknown>): RelayOptions {
  const given: unknown = { auth, ...options };
  return given as RelayOptions;
}

/** The settings without one of them. */
function without(env: Record<string, string>, name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key !== name));
}

describe('defaults (docs/plans/M6.md, section 2.5)', () => {
  it('are the numbers the plan gives, exported under their names', () => {
    expect(DEFAULT_LIMITS).toMatchObject({
      imageBytes: DEFAULT_IMAGE_BYTES,
      stateBytes: STATE_BYTES,
      proposalBytes: PROPOSAL_BYTES,
      responseBytes: RESPONSE_BYTES,
      observersPerPage: OBSERVERS_PER_PAGE,
      inviteeSessions: INVITEE_SESSIONS,
      usersPerPage: 10,
      watchingCallsInFlight: 4,
    });
    expect(DEFAULT_IMAGE_BYTES).toBe(65_536);
    expect(STATE_BYTES).toBe(4_194_304);
    expect(PROPOSAL_BYTES).toBe(16_777_216);
    expect(RESPONSE_BYTES).toBe(100_663_296);
    expect(MIN_RESPONSE_BYTES).toBe(4_194_304);
    expect(OBSERVERS_PER_PAGE).toBe(40);
    expect(INVITEE_SESSIONS).toBe(100);
    expect(MIN_INVITEE_SESSIONS).toBe(2);
    expect(DEFAULT_RATE_LIMITS).toMatchObject({
      stateFramesPerSocket: 40,
      stateFramesPerAddress: 200,
      stateFramesWindowMs: 10_000,
      watchingCallsPerPage: 120,
      watchingCallsPerUserPerPage: 30,
    });
    expect(DEFAULT_TIMINGS).toMatchObject({
      proposalTtlMs: PROPOSAL_TTL_MS,
      membersPollMs: MEMBERS_POLL_MS,
    });
    expect(PROPOSAL_TTL_MS).toBe(600_000);
    expect(MEMBERS_POLL_MS).toBe(2000);
  });

  it('apply in every mode, hosted mode keeping its own three and no new one', () => {
    expect(HOSTED_LIMITS).toEqual({
      pageSessions: 100,
      pageSocketsPerAddress: 5,
      pageSessionsPerAddress: 5,
    });
    const home = freshHome();
    for (const config of [
      resolveEnv(DEV),
      resolveEnv(DEV_INVITES),
      resolveEnv({ TABDOCK_HOME: home }),
      resolveEnv(OAUTH),
      resolveEnv({ ...HOSTED, TABDOCK_INVITES: '1' }),
    ]) {
      expect(config.limits, config.mode).toMatchObject({
        imageBytes: 65_536,
        stateBytes: 4_194_304,
        proposalBytes: 16_777_216,
        responseBytes: 100_663_296,
        observersPerPage: 40,
        inviteeSessions: 100,
        watchingCallsInFlight: 4,
      });
      expect(config, config.mode).toMatchObject({
        agentTokens: false,
        membersFile: null,
        restartSnapshot: false,
      });
      expect(config.timings.proposalTtlMs).toBe(600_000);
      expect(config.timings.membersPollMs).toBe(2000);
    }
  });

  it('leave a blank variable, as .env.example leaves it, to the default', () => {
    const config = resolveEnv({
      ...DEV_INVITES,
      TABDOCK_MAX_IMAGE_BYTES: ' ',
      TABDOCK_MAX_STATE_BYTES: '',
      TABDOCK_MAX_PROPOSAL_BYTES: '',
      TABDOCK_MAX_RESPONSE_BYTES: ' ',
      TABDOCK_MAX_OBSERVERS_PER_PAGE: '',
      TABDOCK_MAX_INVITEE_SESSIONS: '',
      TABDOCK_AGENT_TOKENS: '',
      TABDOCK_MEMBERS_FILE: ' ',
      TABDOCK_RESTART_SNAPSHOT: '',
    });
    expect(config.limits).toMatchObject({
      imageBytes: DEFAULT_IMAGE_BYTES,
      stateBytes: STATE_BYTES,
      proposalBytes: PROPOSAL_BYTES,
      responseBytes: RESPONSE_BYTES,
      observersPerPage: OBSERVERS_PER_PAGE,
      inviteeSessions: INVITEE_SESSIONS,
    });
    expect(config).toMatchObject({ agentTokens: false, membersFile: null, restartSnapshot: false });
  });
});

describe('TABDOCK_MAX_IMAGE_BYTES (ADR 0039)', () => {
  it('takes a whole number from 0, which turns images off, to MAX_IMAGE_BYTES, in every mode', () => {
    expect(MAX_IMAGE_BYTES).toBe(524_288);
    for (const value of ['0', '1', '8192', '524288']) {
      expect(resolveEnv({ ...DEV, TABDOCK_MAX_IMAGE_BYTES: value }).limits.imageBytes).toBe(
        Number(value),
      );
    }
    expect(resolveEnv({ ...HOSTED, TABDOCK_MAX_IMAGE_BYTES: ' 0 ' }).limits.imageBytes).toBe(0);
    expect(
      resolveEnv({ TABDOCK_HOME: freshHome(), TABDOCK_MAX_IMAGE_BYTES: '131072' }).limits
        .imageBytes,
    ).toBe(131_072);
  });

  it('refuses one past the ceiling in its own words', () => {
    refusedWith(
      { ...DEV, TABDOCK_MAX_IMAGE_BYTES: '524289' },
      '524289',
      'imageBytes (TABDOCK_MAX_IMAGE_BYTES) must be a whole number from 0 to 524288 (ADR 0039)',
    );
  });

  it.each(['-1', '1.5', '64k', '0x10', '1e5', 'sk_live_secret'])(
    'refuses %j as no whole number, never quoting it',
    (value) => {
      const message = thrown(() => loadConfigFromEnv({ ...DEV, TABDOCK_MAX_IMAGE_BYTES: value }));
      expect(message).toBe('TABDOCK_MAX_IMAGE_BYTES must be a whole number');
      expect(message).not.toContain(value);
    },
  );

  it('holds options given in code to the same bounds', () => {
    expect(resolveConfig({ auth, limits: { imageBytes: 0 } }).limits.imageBytes).toBe(0);
    for (const imageBytes of [-1, 1.5, MAX_IMAGE_BYTES + 1, Number.NaN]) {
      expect(() => resolveConfig({ auth, limits: { imageBytes } }), String(imageBytes)).toThrow(
        'imageBytes (TABDOCK_MAX_IMAGE_BYTES) must be a whole number from 0 to 524288 (ADR 0039)',
      );
    }
  });
});

describe('the relay-wide byte budgets (ADRs 0040, 0042 and 0044)', () => {
  const budgets = [
    {
      setting: 'TABDOCK_MAX_STATE_BYTES',
      field: 'stateBytes',
      least: MAX_FRAME_BYTES,
      words:
        'stateBytes (TABDOCK_MAX_STATE_BYTES) must be at least 1048576, so the budget holds about thirty pages at the largest state (ADR 0040)',
    },
    {
      setting: 'TABDOCK_MAX_PROPOSAL_BYTES',
      field: 'proposalBytes',
      least: MAX_FRAME_BYTES,
      words:
        'proposalBytes (TABDOCK_MAX_PROPOSAL_BYTES) must be at least 1048576, so the relay holds a few proposals and their outcomes (ADR 0042)',
    },
    {
      setting: 'TABDOCK_MAX_RESPONSE_BYTES',
      field: 'responseBytes',
      least: MIN_RESPONSE_BYTES,
      words:
        'responseBytes (TABDOCK_MAX_RESPONSE_BYTES) must be at least 4194304, room for a few full answers (ADR 0044)',
    },
  ] as const;

  it.each(budgets)(
    '$setting takes its floor and more, in every mode',
    ({ setting, field, least }) => {
      expect(resolveEnv({ ...DEV, [setting]: String(least) }).limits[field]).toBe(least);
      expect(resolveEnv({ ...HOSTED, [setting]: '200000000' }).limits[field]).toBe(200_000_000);
      expect(
        resolveEnv({ TABDOCK_HOME: freshHome(), [setting]: String(least) }).limits[field],
      ).toBe(least);
    },
  );

  it.each(budgets)(
    '$setting under its floor is refused in its own words',
    ({ setting, field, least, words }) => {
      // 1048000 and 4100000 appear in no refusal's words, so a quoted value would show.
      const below = least === MAX_FRAME_BYTES ? '1048000' : '4100000';
      refusedWith({ ...DEV, [setting]: below }, below, words);
      expect(() => resolveConfig({ auth, limits: { [field]: least - 1 } })).toThrow(words);
    },
  );

  it.each(budgets)('$setting refuses 0 and junk as no positive number', ({ setting }) => {
    for (const value of ['0', '-5', 'lots']) {
      const message = thrown(() => loadConfigFromEnv({ ...DEV, [setting]: value }));
      expect(message).toBe(`${setting} must be a positive whole number`);
      expect(message).not.toContain(value);
    }
  });
});

describe('TABDOCK_MAX_OBSERVERS_PER_PAGE (ADR 0044)', () => {
  it('takes a whole number from 0, which restores M5 rule, to 100, with invites on', () => {
    expect(MAX_OBSERVERS_PER_PAGE).toBe(100);
    for (const value of ['0', '1', '40', '100']) {
      expect(
        resolveEnv({ ...DEV_INVITES, TABDOCK_MAX_OBSERVERS_PER_PAGE: value }).limits
          .observersPerPage,
      ).toBe(Number(value));
    }
    expect(
      resolveEnv({ ...HOSTED, TABDOCK_INVITES: '1', TABDOCK_MAX_OBSERVERS_PER_PAGE: '0' }).limits
        .observersPerPage,
    ).toBe(0);
  });

  it('refuses one past 100 in its own words', () => {
    refusedWith(
      { ...DEV_INVITES, TABDOCK_MAX_OBSERVERS_PER_PAGE: '101' },
      '101',
      "observersPerPage (TABDOCK_MAX_OBSERVERS_PER_PAGE) must be a whole number from 0 to 100, so the page's roster fits one page link frame (ADR 0044)",
    );
    const message = thrown(() =>
      loadConfigFromEnv({ ...DEV_INVITES, TABDOCK_MAX_OBSERVERS_PER_PAGE: 'forty' }),
    );
    expect(message).toBe('TABDOCK_MAX_OBSERVERS_PER_PAGE must be a whole number');
  });

  it('is refused without invites, 0 included, before local mode draws a token', () => {
    refusedWith(
      { ...DEV, TABDOCK_MAX_OBSERVERS_PER_PAGE: '0' },
      'xx',
      'TABDOCK_MAX_OBSERVERS_PER_PAGE sizes how many invited accounts may watch a page apart from its users, and there are none unless TABDOCK_INVITES is on (ADR 0044)',
    );
    const home = freshHome();
    expect(() =>
      loadConfigFromEnv({ TABDOCK_HOME: home, TABDOCK_MAX_OBSERVERS_PER_PAGE: '30' }),
    ).toThrow(/there are none unless TABDOCK_INVITES is on/);
    expect(existsSync(home)).toBe(false);
  });

  it('holds options given in code to the same rules', () => {
    expect(
      resolveConfig({ auth, invites: true, limits: { observersPerPage: 0 } }).limits
        .observersPerPage,
    ).toBe(0);
    for (const observersPerPage of [-1, 2.5, 101]) {
      expect(() => resolveConfig({ auth, invites: true, limits: { observersPerPage } })).toThrow(
        /must be a whole number from 0 to 100/,
      );
    }
    expect(() => resolveConfig({ auth, limits: { observersPerPage: 10 } })).toThrow(
      'observersPerPage (TABDOCK_MAX_OBSERVERS_PER_PAGE) sizes how many invited accounts may watch a page apart from its users, and there are none unless invites (TABDOCK_INVITES) are on (ADR 0044)',
    );
    // Off, the default stands unused: the welcome says 0 (hub.ts).
    expect(resolveConfig({ auth }).limits.observersPerPage).toBe(40);
  });
});

describe('TABDOCK_MAX_INVITEE_SESSIONS (ADR 0044)', () => {
  it('takes 2 up to TABDOCK_MAX_SESSIONS, with invites on', () => {
    for (const value of ['2', '100', '1000']) {
      expect(
        resolveEnv({ ...DEV_INVITES, TABDOCK_MAX_INVITEE_SESSIONS: value }).limits.inviteeSessions,
      ).toBe(Number(value));
    }
    expect(
      resolveEnv({
        ...DEV_INVITES,
        TABDOCK_MAX_SESSIONS: '40',
        TABDOCK_MAX_INVITEE_SESSIONS: '40',
      }).limits.inviteeSessions,
    ).toBe(40);
  });

  it('refuses a pool of one, and one above the total, in their own words', () => {
    refusedWith(
      { ...DEV_INVITES, TABDOCK_MAX_INVITEE_SESSIONS: '1' },
      'xx',
      "TABDOCK_MAX_INVITEE_SESSIONS must be at least 2, room for one invited account's two sessions (ADR 0044)",
    );
    refusedWith(
      { ...DEV_INVITES, TABDOCK_MAX_SESSIONS: '40', TABDOCK_MAX_INVITEE_SESSIONS: '41' },
      '41',
      "inviteeSessions (TABDOCK_MAX_INVITEE_SESSIONS) must be at most sessions (TABDOCK_MAX_SESSIONS): the invitee pool is part of the relay's sessions (ADR 0044)",
    );
  });

  it('lets its default give way to a smaller total, which M5 allowed', () => {
    expect(resolveEnv({ ...DEV_INVITES, TABDOCK_MAX_SESSIONS: '30' }).limits.inviteeSessions).toBe(
      30,
    );
    expect(resolveEnv({ ...DEV, TABDOCK_MAX_SESSIONS: '30' }).limits.inviteeSessions).toBe(30);
  });

  it('is refused without invites', () => {
    refusedWith(
      { ...DEV, TABDOCK_MAX_INVITEE_SESSIONS: '200' },
      '200',
      'TABDOCK_MAX_INVITEE_SESSIONS sizes the session pool invited accounts share, and there are none unless TABDOCK_INVITES is on (ADR 0044)',
    );
    expect(() => resolveConfig({ auth, limits: { inviteeSessions: 10 } })).toThrow(
      'inviteeSessions (TABDOCK_MAX_INVITEE_SESSIONS) sizes the session pool invited accounts share, and there are none unless invites (TABDOCK_INVITES) are on (ADR 0044)',
    );
  });

  it('holds options given in code to the total', () => {
    expect(() =>
      resolveConfig({ auth, invites: true, limits: { sessions: 5, inviteeSessions: 6 } }),
    ).toThrow(/must be at most sessions/);
    // A test may still build a pool of one in code, as M5's did.
    expect(
      resolveConfig({ auth, invites: true, limits: { inviteeSessions: 1 } }).limits.inviteeSessions,
    ).toBe(1);
  });
});

describe('TABDOCK_MAX_USERS_PER_PAGE gains a ceiling (ADR 0044)', () => {
  it('takes up to 50 and refuses 51 in its own words', () => {
    expect(MAX_USERS_PER_PAGE).toBe(50);
    expect(resolveEnv({ ...DEV, TABDOCK_MAX_USERS_PER_PAGE: '50' }).limits.usersPerPage).toBe(50);
    refusedWith(
      { ...DEV, TABDOCK_MAX_USERS_PER_PAGE: '51' },
      '51',
      "usersPerPage (TABDOCK_MAX_USERS_PER_PAGE) must be at most 50, so the page's roster always fits one page link frame (ADR 0044)",
    );
    expect(() => resolveConfig({ auth, limits: { usersPerPage: 51 } })).toThrow(/at most 50/);
    // With invites on it must still leave members their two seats (ADR 0017).
    expect(() => resolveEnv({ ...DEV_INVITES, TABDOCK_MAX_USERS_PER_PAGE: '2' })).toThrow(
      /must be at least 3 \(ADR 0017\)/,
    );
  });
});

describe('TABDOCK_AGENT_TOKENS (ADR 0044)', () => {
  it('is off unless set, and on with invites in every mode that has them, production included', () => {
    expect(resolveEnv(DEV_INVITES).agentTokens).toBe(false);
    for (const value of ['1', 'true', 'TRUE']) {
      expect(resolveEnv({ ...DEV_INVITES, TABDOCK_AGENT_TOKENS: value }).agentTokens).toBe(true);
    }
    for (const value of ['0', 'false']) {
      expect(resolveEnv({ ...DEV, TABDOCK_AGENT_TOKENS: value }).agentTokens).toBe(false);
    }
    expect(
      resolveEnv({ ...HOSTED, TABDOCK_INVITES: '1', TABDOCK_AGENT_TOKENS: '1' }),
    ).toMatchObject({ mode: 'hosted', agentTokens: true });
  });

  it('is refused without invites, and in local mode through them, before a token is drawn', () => {
    refusedWith(
      { ...DEV, TABDOCK_AGENT_TOKENS: '1' },
      'xx',
      'TABDOCK_AGENT_TOKENS needs TABDOCK_INVITES: an agent token is minted on a page as an invite is, while a member sponsors it (ADR 0044)',
    );
    for (const env of [
      { TABDOCK_AGENT_TOKENS: '1' },
      { TABDOCK_AGENT_TOKENS: '1', TABDOCK_INVITES: '1' },
    ]) {
      const home = freshHome();
      expect(() => loadConfigFromEnv({ TABDOCK_HOME: home, ...env })).toThrow(/TABDOCK_INVITES/);
      expect(existsSync(home)).toBe(false);
    }
    expect(thrown(() => loadConfigFromEnv({ ...DEV, TABDOCK_AGENT_TOKENS: 'yes' }))).toBe(
      'TABDOCK_AGENT_TOKENS must be 1, true, 0 or false',
    );
  });

  it('takes only true from code, and never without invites', () => {
    expect(resolveConfig({ auth, invites: true, agentTokens: true }).agentTokens).toBe(true);
    expect(resolveConfig(stray({ invites: true, agentTokens: 'true' })).agentTokens).toBe(false);
    expect(() => resolveConfig({ auth, agentTokens: true })).toThrow(
      'agentTokens (TABDOCK_AGENT_TOKENS) needs invites (TABDOCK_INVITES): an agent token is minted on a page as an invite is, while a member sponsors it (ADR 0044)',
    );
  });
});

describe('TABDOCK_MEMBERS_FILE (ADR 0043)', () => {
  /** Public URL mode's settings with the file in place of TABDOCK_OAUTH_USERS. */
  function withFile(path: string): Record<string, string> {
    return { ...without(OAUTH, 'TABDOCK_OAUTH_USERS'), TABDOCK_MEMBERS_FILE: path };
  }
  const SECRETISH = '/srv/tabdock-sk_live_0123456789/members.txt';

  it('is an auth setting, so it takes the relay out of local mode', () => {
    expect(AUTH_SETTINGS).toContain('TABDOCK_MEMBERS_FILE');
    const home = freshHome();
    expect(() =>
      loadConfigFromEnv({ TABDOCK_HOME: home, TABDOCK_MEMBERS_FILE: SECRETISH }),
    ).toThrow(/only with TABDOCK_PUBLIC_URL/);
    expect(existsSync(home)).toBe(false);
  });

  it('is refused beside TABDOCK_OAUTH_USERS or dev tokens, and outside public URL mode', () => {
    refusedWith(
      { ...OAUTH, TABDOCK_MEMBERS_FILE: SECRETISH },
      SECRETISH,
      'TABDOCK_OAUTH_USERS and TABDOCK_MEMBERS_FILE both list members; keep one (ADR 0043)',
    );
    refusedWith(
      { ...withFile(SECRETISH), ...DEV },
      SECRETISH,
      'TABDOCK_MEMBERS_FILE lists the members OAuth signs in, and TABDOCK_DEV_TOKENS lists users of its own; keep one (ADR 0043)',
    );
    const noPublic = without(withFile(SECRETISH), 'TABDOCK_PUBLIC_URL');
    expect(thrown(() => loadConfigFromEnv(noPublic))).toBe(
      'TABDOCK_MEMBERS_FILE lists the members OAuth signs in, which only public URL mode does; it works only with TABDOCK_PUBLIC_URL (ADR 0043)',
    );
  });

  it('must be an absolute path, never quoted', () => {
    for (const path of ['members.txt', './sk_live_secret.txt', '~/members.txt']) {
      refusedWith(withFile(path), path, 'TABDOCK_MEMBERS_FILE must be an absolute path (ADR 0043)');
    }
  });

  it('is refused at start until this relay reads it, rather than run with no members', () => {
    refusedWith(
      withFile(SECRETISH),
      SECRETISH,
      'TABDOCK_MEMBERS_FILE is not read by this relay yet; list the members in TABDOCK_OAUTH_USERS (ADR 0043)',
    );
  });

  it('holds options given in code to public URL mode and an absolute path', () => {
    const publicOptions = loadConfigFromEnv(OAUTH);
    expect(resolveConfig(publicOptions).membersFile).toBeNull();
    expect(resolveConfig({ ...publicOptions, membersFile: SECRETISH }).membersFile).toBe(SECRETISH);
    const relative = thrown(() =>
      resolveConfig({ ...publicOptions, membersFile: 'sk_live_secret/members.txt' }),
    );
    expect(relative).toBe('membersFile (TABDOCK_MEMBERS_FILE) must be an absolute path (ADR 0043)');
    const local = thrown(() => resolveConfig({ auth, membersFile: SECRETISH }));
    expect(local).toBe(
      'membersFile (TABDOCK_MEMBERS_FILE) lists the members OAuth signs in, which only public URL mode does (TABDOCK_PUBLIC_URL) (ADR 0043)',
    );
    expect(local).not.toContain(SECRETISH);
  });
});

describe('TABDOCK_RESTART_SNAPSHOT (ADR 0046)', () => {
  it('is off unless set, even with an audit directory', () => {
    expect(resolveEnv({ ...DEV, TABDOCK_AUDIT_DIR: scratch() }).restartSnapshot).toBe(false);
    expect(resolveEnv({ TABDOCK_HOME: freshHome() }).restartSnapshot).toBe(false);
  });

  it('is on with TABDOCK_AUDIT_DIR, or in local mode beside its token', () => {
    expect(
      resolveEnv({ ...DEV, TABDOCK_AUDIT_DIR: scratch(), TABDOCK_RESTART_SNAPSHOT: '1' })
        .restartSnapshot,
    ).toBe(true);
    const local = resolveEnv({ TABDOCK_HOME: freshHome(), TABDOCK_RESTART_SNAPSHOT: 'true' });
    expect(local).toMatchObject({ mode: 'local', restartSnapshot: true });
    expect(local.audit.dir).not.toBeNull();
    expect(
      resolveEnv({ ...HOSTED, TABDOCK_AUDIT_DIR: scratch(), TABDOCK_RESTART_SNAPSHOT: '1' })
        .restartSnapshot,
    ).toBe(true);
  });

  it('is refused without an audit directory, in either layer', () => {
    refusedWith(
      { ...DEV, TABDOCK_RESTART_SNAPSHOT: '1' },
      'xx',
      "TABDOCK_RESTART_SNAPSHOT keeps its file in the audit directory, and without TABDOCK_AUDIT_DIR, or local mode's directory beside its token, the relay keeps none (ADR 0046)",
    );
    // Off, it needs nothing.
    expect(resolveEnv({ ...DEV, TABDOCK_RESTART_SNAPSHOT: '0' }).restartSnapshot).toBe(false);
    expect(() => resolveConfig({ auth, restartSnapshot: true })).toThrow(
      'restartSnapshot (TABDOCK_RESTART_SNAPSHOT) keeps its file in the audit directory (TABDOCK_AUDIT_DIR), and without one the relay keeps none (ADR 0046)',
    );
    const dir = scratch();
    expect(resolveConfig({ auth, restartSnapshot: true, audit: { dir } }).restartSnapshot).toBe(
      true,
    );
    expect(resolveConfig(stray({ restartSnapshot: 'true', audit: { dir } })).restartSnapshot).toBe(
      false,
    );
    expect(thrown(() => loadConfigFromEnv({ ...DEV, TABDOCK_RESTART_SNAPSHOT: 'on' }))).toBe(
      'TABDOCK_RESTART_SNAPSHOT must be 1, true, 0 or false',
    );
  });
});

describe('options with no environment variable', () => {
  it('take the state frame and watching budgets from code, each a positive whole number', () => {
    const config = resolveConfig({
      auth,
      rateLimits: {
        stateFramesPerSocket: 3,
        stateFramesPerAddress: 5,
        stateFramesWindowMs: 1000,
        watchingCallsPerPage: 6,
        watchingCallsPerUserPerPage: 2,
      },
      limits: { watchingCallsInFlight: 1 },
    });
    expect(config.rateLimits).toMatchObject({
      stateFramesPerSocket: 3,
      stateFramesPerAddress: 5,
      stateFramesWindowMs: 1000,
      watchingCallsPerPage: 6,
      watchingCallsPerUserPerPage: 2,
    });
    expect(config.limits.watchingCallsInFlight).toBe(1);
    expect(() => resolveConfig({ auth, rateLimits: { stateFramesPerSocket: 0 } })).toThrow(
      'stateFramesPerSocket must be a positive integer',
    );
    expect(() => resolveConfig({ auth, limits: { watchingCallsInFlight: 0 } })).toThrow(
      'watchingCallsInFlight must be a positive integer',
    );
  });

  it('let a test shorten a proposal, never lengthen it past PROPOSAL_TTL_MS', () => {
    expect(resolveConfig({ auth, timings: { proposalTtlMs: 500 } }).timings.proposalTtlMs).toBe(
      500,
    );
    expect(
      resolveConfig({ auth, timings: { proposalTtlMs: PROPOSAL_TTL_MS } }).timings.proposalTtlMs,
    ).toBe(PROPOSAL_TTL_MS);
    expect(() => resolveConfig({ auth, timings: { proposalTtlMs: PROPOSAL_TTL_MS + 1 } })).toThrow(
      'proposalTtlMs must be at most 600000: a proposal lives 10 minutes at most (ADR 0042)',
    );
  });

  it('let a test shorten the members poll', () => {
    expect(resolveConfig({ auth, timings: { membersPollMs: 50 } }).timings.membersPollMs).toBe(50);
    expect(() => resolveConfig({ auth, timings: { membersPollMs: 0 } })).toThrow(
      'membersPollMs must be a positive integer',
    );
  });

  it('are never read from the environment', () => {
    const config = resolveEnv({
      ...DEV,
      TABDOCK_STATE_FRAMES_PER_SOCKET: '1',
      TABDOCK_WATCHING_CALLS_PER_PAGE: '1',
      TABDOCK_PROPOSAL_TTL_MS: '1',
      TABDOCK_MEMBERS_POLL_MS: '1',
    });
    expect(config.rateLimits.stateFramesPerSocket).toBe(40);
    expect(config.rateLimits.watchingCallsPerPage).toBe(120);
    expect(config.timings.proposalTtlMs).toBe(PROPOSAL_TTL_MS);
    expect(config.timings.membersPollMs).toBe(MEMBERS_POLL_MS);
  });
});

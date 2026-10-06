// The guide's settings page (docs/guide/08-relay-settings.md, ADR 0035) is
// the canonical list an operator reads, so it must name exactly the settings
// the relay reads, both ways, and state the defaults the code applies: a
// setting renamed in config.ts, or a default changed there, fails here rather
// than leaving a page that sends someone to a variable nothing reads. The
// docs at large may name only settings something reads, and the .env.example
// template must itself load, so copying it to .env never stops the relay.
// Each setting's place in the relay README and .env.example stays with
// readme-settings.test.ts.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { MAX_FRAME_BYTES } from '@tabdock/protocol';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_MAX_MB,
  AUDIT_RETENTION_DAYS,
  DEFAULT_CLI_PORT,
  DEFAULT_HOST,
  DEFAULT_LIMITS,
  DEFAULT_RATE_LIMITS,
  DEFAULT_TIMINGS,
  DEFAULT_TRUSTED_PROXY_CIDR,
  HOSTED_LIMITS,
  LOCAL_AUDIT_DIR,
  LOOPBACK_HOSTNAMES,
  loadConfigFromEnv,
  MIN_REQUEST_BYTES,
  type RelayLimits,
  type RelayRateLimits,
  resolveConfig,
} from '../src/config.ts';
import { MIN_DEV_TOKEN_LENGTH } from '../src/auth.ts';
import { DEFAULT_MAX_TOKEN_AGE_MINUTES } from '../src/oauth.ts';

const ROOT = new URL('../../../', import.meta.url).pathname;
const PAGE = 'docs/guide/08-relay-settings.md';
const SETTING = /\bTABDOCK_[A-Z0-9_]+\b/g;
/** A constant the bundle defines at build time (ADR 0028), never a setting anyone sets. */
const BUILD_CONSTANTS = new Set(['TABDOCK_PACKAGED']);

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

function namesIn(text: string): Set<string> {
  return new Set(text.match(SETTING) ?? []);
}

/** Every TABDOCK_ name in the .ts files under `dir`. */
function namesUnder(dir: string): Set<string> {
  const names = new Set<string>();
  for (const entry of readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    for (const name of namesIn(readFileSync(join(entry.parentPath, entry.name), 'utf8'))) {
      names.add(name);
    }
  }
  return names;
}

/** A Markdown table's body rows as cells keyed by header, backticks kept. */
interface Row {
  readonly cells: Readonly<Record<string, string>>;
  readonly line: number;
}

/** Every pipe table in `text`, each as its rows. */
function tables(text: string): Row[][] {
  const lines = text.split('\n');
  const found: Row[][] = [];
  const split = (line: string): string[] =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim());
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index] ?? '';
    const rule = lines[index + 1] ?? '';
    if (!header.startsWith('|') || !/^\|[\s:|-]+\|$/.test(rule.trim())) continue;
    const names = split(header);
    const rows: Row[] = [];
    let at = index + 2;
    for (; at < lines.length && (lines[at] ?? '').startsWith('|'); at += 1) {
      const values = split(lines[at] ?? '');
      rows.push({
        cells: Object.fromEntries(names.map((name, column) => [name, values[column] ?? ''])),
        line: at + 1,
      });
    }
    found.push(rows);
    index = at;
  }
  return found;
}

/** The setting a row's first cell names, or null for a row that names none. */
function settingOf(row: Row): string | null {
  return /^`(TABDOCK_[A-Z0-9_]+)`$/.exec(row.cells.Setting ?? '')?.[1] ?? null;
}

const plain = (cell: string): string => cell.replaceAll('`', '').trim();

/** The first whole number in a cell, written without separators. */
function firstNumber(cell: string): number | null {
  const match = /\d+/.exec(plain(cell));
  return match === null ? null : Number(match[0]);
}

type Limit = keyof RelayLimits;
type RateLimit = keyof RelayRateLimits;

/**
 * What each row's Default cell must say, from the code. A number is the
 * cell's first number; text is how the cell must start; a list is what the
 * cell must name. A row missing here fails, so a new setting brings its
 * default with it.
 */
type Expected =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'text'; readonly starts: string }
  | { readonly kind: 'names'; readonly names: readonly string[] }
  | { readonly kind: 'limit'; readonly key: Limit; readonly least: number }
  | { readonly kind: 'rate'; readonly key: RateLimit; readonly least: number }
  | { readonly kind: 'minutes'; readonly ms: number };

const minutes = (ms: number): number => ms / 60_000;
const none = { kind: 'text', starts: 'none' } as const;
const off = { kind: 'number', value: 0 } as const;

const EXPECTED: Readonly<Record<string, Expected>> = {
  TABDOCK_ENV: { kind: 'text', starts: 'development' },
  TABDOCK_HOME: { kind: 'text', starts: 'the per-user configuration directory' },
  TABDOCK_DEV_TOKENS: none,
  TABDOCK_PUBLIC_URL: none,
  TABDOCK_OAUTH_ISSUER: none,
  TABDOCK_OAUTH_USERS: none,
  TABDOCK_PAIR_CLIENT_ID: none,
  TABDOCK_PAIR_CLIENT_SECRET: none,
  TABDOCK_OAUTH_MAX_TOKEN_AGE: { kind: 'number', value: DEFAULT_MAX_TOKEN_AGE_MINUTES },
  TABDOCK_OAUTH_CLIENT_IDS: none,
  TABDOCK_HOST: { kind: 'text', starts: DEFAULT_HOST },
  TABDOCK_PORT: { kind: 'number', value: DEFAULT_CLI_PORT },
  TABDOCK_ALLOWED_ORIGINS: { kind: 'names', names: LOOPBACK_HOSTNAMES },
  TABDOCK_MCP_ALLOWED_ORIGINS: none,
  TABDOCK_DEV_ALLOW_NO_ORIGIN: off,
  TABDOCK_CLIENT_ADDRESS_HEADER: none,
  TABDOCK_TRUSTED_PROXY_CIDR: { kind: 'text', starts: DEFAULT_TRUSTED_PROXY_CIDR.join(',') },
  TABDOCK_INVITES: off,
  TABDOCK_FIRST_CLASS_TOOLS: off,
  TABDOCK_SPIKE: off,
  TABDOCK_MAX_SESSIONS_PER_USER: { kind: 'limit', key: 'sessionsPerUser', least: 1 },
  TABDOCK_MAX_SESSIONS: { kind: 'limit', key: 'sessions', least: 1 },
  TABDOCK_MAX_USERS_PER_PAGE: { kind: 'limit', key: 'usersPerPage', least: 1 },
  TABDOCK_MAX_CALLS_PER_MINUTE: { kind: 'rate', key: 'callsPerUserPerPage', least: 1 },
  TABDOCK_MAX_QUEUE_DEPTH: { kind: 'limit', key: 'queueDepth', least: 1 },
  TABDOCK_MAX_REQUESTS_PER_USER: { kind: 'rate', key: 'requestsPerUser', least: 1 },
  TABDOCK_MAX_REQUESTS_PER_INVITEE: { kind: 'rate', key: 'requestsPerInvitee', least: 1 },
  TABDOCK_MAX_TOOL_BYTES: { kind: 'limit', key: 'toolBytes', least: MAX_FRAME_BYTES },
  TABDOCK_MAX_REQUEST_BYTES: { kind: 'limit', key: 'requestBytes', least: MIN_REQUEST_BYTES },
  TABDOCK_MAX_REQUEST_BYTES_PER_USER: {
    kind: 'limit',
    key: 'requestBytesPerUser',
    least: MIN_REQUEST_BYTES,
  },
  TABDOCK_MAX_PAIR_SIGNINS_PER_MINUTE: { kind: 'rate', key: 'pairSignIns', least: 1 },
  TABDOCK_MAX_PAIR_SIGNINS_IN_FLIGHT: { kind: 'limit', key: 'pairSignInsInFlight', least: 1 },
  TABDOCK_MAX_PAGE_SOCKETS_PER_ADDRESS: { kind: 'limit', key: 'pageSocketsPerAddress', least: 1 },
  TABDOCK_MAX_PAGE_SESSIONS_PER_ADDRESS: {
    kind: 'limit',
    key: 'pageSessionsPerAddress',
    least: 1,
  },
  TABDOCK_MAX_PAGE_SESSIONS: { kind: 'limit', key: 'pageSessions', least: 1 },
  TABDOCK_SESSION_IDLE_MINUTES: { kind: 'minutes', ms: DEFAULT_TIMINGS.sessionIdleMs },
  TABDOCK_ATTACHMENT_IDLE_MINUTES: { kind: 'minutes', ms: DEFAULT_TIMINGS.attachmentIdleMs },
  TABDOCK_AUDIT_DIR: { kind: 'names', names: [LOCAL_AUDIT_DIR] },
  TABDOCK_AUDIT_RETENTION_DAYS: { kind: 'number', value: AUDIT_RETENTION_DAYS },
  TABDOCK_AUDIT_MAX_MB: { kind: 'number', value: AUDIT_MAX_MB },
};

const HOSTED: RelayLimits = { ...DEFAULT_LIMITS, ...HOSTED_LIMITS };

/** What is wrong with one row, against EXPECTED; empty when nothing is. */
function rowProblems(name: string, row: Row): string[] {
  const where = `${name} (${PAGE}:${String(row.line)})`;
  const expected = EXPECTED[name];
  if (expected === undefined) return [`${where}: no expected default in this test`];
  const cell = row.cells.Default ?? '';
  const problems: string[] = [];
  const numberIs = (value: number, label: string, text: string): void => {
    if (plain(text) !== String(value) && firstNumber(text) !== value) {
      problems.push(`${where}: ${label} says ${JSON.stringify(text)}, the code ${String(value)}`);
    }
  };
  switch (expected.kind) {
    case 'number':
      numberIs(expected.value, 'Default', cell);
      break;
    case 'minutes':
      numberIs(minutes(expected.ms), 'Default', cell);
      break;
    case 'text':
      if (!plain(cell).startsWith(expected.starts)) {
        problems.push(`${where}: Default says ${JSON.stringify(cell)}, not "${expected.starts}"`);
      }
      break;
    case 'names':
      for (const named of expected.names) {
        if (!plain(cell).includes(named)) {
          problems.push(`${where}: Default does not name ${named}`);
        }
      }
      break;
    case 'limit':
    case 'rate': {
      const value =
        expected.kind === 'limit'
          ? DEFAULT_LIMITS[expected.key]
          : DEFAULT_RATE_LIMITS[expected.key];
      const hosted = expected.kind === 'limit' ? HOSTED[expected.key] : value;
      // Byte settings are read in bytes, so the page writes them in bytes.
      for (const [label, text, want] of [
        ['Default', cell, value],
        ['Hosted default', row.cells['Hosted default'] ?? '', hosted],
      ] as const) {
        if (plain(text) !== String(want)) {
          problems.push(
            `${where}: ${label} says ${JSON.stringify(text)}, the code ${String(want)}, written as a plain whole number`,
          );
        }
      }
      const least = firstNumber(row.cells.Least ?? '');
      if (least !== expected.least) {
        problems.push(`${where}: Least says ${String(least)}, the code ${String(expected.least)}`);
      }
      break;
    }
  }
  return problems;
}

/** The settings the relay reads, less build constants. */
function relaySettings(): string[] {
  return [...namesUnder('packages/relay/src')].filter((name) => !BUILD_CONSTANTS.has(name)).sort();
}

/** Every Markdown file a reader is sent to for settings. */
function docsNamingSettings(): string[] {
  const markdownIn = (dir: string): string[] =>
    readdirSync(join(ROOT, dir))
      .filter((name) => name.endsWith('.md'))
      .map((name) => `${dir}/${name}`);
  const readmes = ['packages', 'apps'].flatMap((dir) =>
    readdirSync(join(ROOT, dir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${dir}/${entry.name}/README.md`)
      .filter((path) => {
        try {
          read(path);
          return true;
        } catch {
          return false;
        }
      }),
  );
  return [
    'README.md',
    '.env.example',
    'docs/deploy.md',
    'docs/develop.md',
    ...markdownIn('docs/guide'),
    ...markdownIn('docs/tour'),
    ...readmes,
  ];
}

describe('the relay settings page', () => {
  const rows = tables(read(PAGE))
    .flat()
    .flatMap((row) => {
      const name = settingOf(row);
      return name === null ? [] : [{ name, row }];
    });

  it('lists every setting the relay reads, and only those, once each', () => {
    const listed = rows.map(({ name }) => name);
    expect(listed.length).toBeGreaterThan(30);
    expect([...new Set(listed)].sort()).toEqual(relaySettings());
    expect(listed.filter((name, index) => listed.indexOf(name) !== index)).toEqual([]);
  });

  it('states the default, hosted default and least the code applies', () => {
    expect(rows.flatMap(({ name, row }) => rowProblems(name, row))).toEqual([]);
  });

  it('expects defaults only for settings the relay reads', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(relaySettings());
  });

  it('says flags are off when unset, as the code reads them', () => {
    const options = loadConfigFromEnv({
      TABDOCK_DEV_TOKENS: `alice=${'k'.repeat(MIN_DEV_TOKEN_LENGTH)}`,
    });
    expect([
      options.allowMissingOrigin,
      options.invites,
      options.firstClassTools,
      options.spike,
    ]).toEqual([false, false, false, false]);
  });

  it('fails a row whose default drifts from the code', () => {
    const row = (cells: Record<string, string>): Row => ({ cells, line: 1 });
    expect(rowProblems('TABDOCK_PORT', row({ Default: '8788' }))).not.toEqual([]);
    expect(
      rowProblems(
        'TABDOCK_MAX_TOOL_BYTES',
        row({ Default: '64 MiB', 'Hosted default': '67108864', Least: '1048576' }),
      ),
    ).not.toEqual([]);
    expect(
      rowProblems(
        'TABDOCK_MAX_PAGE_SESSIONS',
        row({ Default: '1000', 'Hosted default': '1000', Least: '1' }),
      ),
    ).not.toEqual([]);
    expect(rowProblems('TABDOCK_RENAMED', row({ Default: 'none' }))).not.toEqual([]);
  });
});

describe('settings the docs name', () => {
  it('are each read by the relay or by a script', () => {
    const known = new Set([...namesUnder('packages/relay/src'), ...namesUnder('scripts')]);
    const stray = docsNamingSettings().flatMap((path) =>
      [...namesIn(read(path))]
        .filter((name) => !known.has(name))
        .map((name) => `${name} in ${path}`),
    );
    expect(stray).toEqual([]);
  });
});

describe('.env.example', () => {
  it('loads and resolves as it stands, so a copy of it starts the relay', () => {
    const env = { ...parseEnv(read('.env.example')), TABDOCK_HOME: process.env.TABDOCK_HOME };
    const options = loadConfigFromEnv(env);
    expect(options.localMode).toBeDefined();
    expect(() => resolveConfig(options)).not.toThrow();
  });
});

describe('refusals and the values they refuse', () => {
  // The page promises a refusal never repeats the value, since a token may sit
  // in the wrong variable; this holds the code to it by refusing a marked
  // value in every setting the relay reads, as a bare word, inside a URL, and
  // for TABDOCK_HOME as absolute paths, which a token starting with '/' would
  // pass as: inside the checkout, inside a work tree, on a file, and through
  // a loop of links, whose realpath error node words with the path.
  const MARK = 'Zq7Mark9Wq';
  const devTokens = { TABDOCK_DEV_TOKENS: `alice=${'k'.repeat(MIN_DEV_TOKEN_LENGTH)}` };

  function homes(scratch: string): string[] {
    const base = join(scratch, MARK);
    mkdirSync(join(base, 'repo', '.git'), { recursive: true, mode: 0o700 });
    writeFileSync(join(base, 'file'), 'x');
    symlinkSync(join(base, 'loop'), join(base, 'loop'));
    return [
      join(ROOT, MARK),
      join(base, 'repo', 'tabdock'),
      join(base, 'file'),
      join(base, 'loop', 'tabdock'),
    ];
  }

  function quoting(scratch: string): { quoted: string[]; refused: Set<string> } {
    const quoted = new Set<string>();
    const refused = new Set<string>();
    for (const name of relaySettings()) {
      const envs: NodeJS.ProcessEnv[] = [MARK, `https://${MARK}.example/x`].map((value) => ({
        ...devTokens,
        [name]: value,
      }));
      if (name === 'TABDOCK_HOME') envs.push(...homes(scratch).map((home) => ({ [name]: home })));
      for (const env of envs) {
        try {
          resolveConfig(loadConfigFromEnv(env));
        } catch (error) {
          refused.add(name);
          if (error instanceof Error && error.message.includes(MARK)) quoted.add(name);
        }
      }
    }
    return { quoted: [...quoted].sort(), refused };
  }

  it('never repeat it, as the settings page says, naming a list entry by its place', () => {
    const page = read(PAGE);
    expect(page).toContain('A refusal names the variable and the rule broken, never the value');
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tabdock-settings-')));
    let found: ReturnType<typeof quoting>;
    try {
      found = quoting(scratch);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    const { quoted, refused } = found;
    // The probe reaches the settings whose refusals once quoted their value.
    for (const name of ['TABDOCK_ALLOWED_ORIGINS', 'TABDOCK_HOME', 'TABDOCK_HOST']) {
      expect(refused.has(name), name).toBe(true);
    }
    expect(quoted).toEqual([]);
    expect(() =>
      resolveConfig(
        loadConfigFromEnv({ ...devTokens, TABDOCK_ALLOWED_ORIGINS: `https://a.example,${MARK}` }),
      ),
    ).toThrow(/^allowedOrigins \(TABDOCK_ALLOWED_ORIGINS\) entry 2 is not an origin/);
  });
});

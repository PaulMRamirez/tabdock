// The CI check's files (ADR 0041). tests/ci-check stays copyable: it imports
// only Playwright, the MCP client, @tabdock/adapter/testing, zod and node:,
// names no relay setting that would widen what local mode admits or raise a
// limit, pins what the workspace pins, starts the relay with readiness on
// /healthz and SIGINT to stop it, and never reuses a server already on a
// port. Its copied profile schemas stay equal to @tabdock/sim-page/map's, as
// JSON Schema and on sample values, so a copy cannot drift from the profile
// it checks (conflict C4). CI's ci-check job reads no secret, puts
// TABDOCK_HOME under RUNNER_TEMP through GITHUB_ENV, deletes it whatever
// happens, and caches and uploads nothing; no job runs Claude Code or names
// its key (decision 1). The runner refuses a TABDOCK_HOME in use, withholds
// output holding the token or an unmasked code, holds the audit log to the
// walk (S7, S11), and when interrupted stops everything it started and still
// deletes the home it made, owner token and all.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import * as copied from '@tabdock/ci-check/profile';
import { OPTIONAL_TOOLS } from '@tabdock/ci-check/walk';
import * as map from '@tabdock/sim-page/map';
import { describe, expect, it } from 'vitest';
import config from '../../ci-check/playwright.config.ts';
import {
  auditProblems,
  CLIENT_NAME,
  homeFor,
  outputLeak,
  printedPageCalls,
} from '../../../scripts/ci-check.ts';
import { readRepo, ROOT } from '../src/doc-files.ts';

const PACKAGE = join(ROOT, 'tests/ci-check');
const ALLOWED = [
  '@playwright/test',
  '@modelcontextprotocol/client',
  '@tabdock/adapter/testing',
  'zod',
];
/** Words a copier's check must never carry: other workspace packages, test hooks, and settings that widen or raise. */
const BANNED = [
  '@tabdock/relay',
  '@tabdock/sim-page',
  '@tabdock/protocol',
  '@tabdock/demo',
  '__tabdockDock',
  '?e2e',
  'TABDOCK_DEV_',
  'TABDOCK_MAX_',
  'TABDOCK_ALLOWED_ORIGINS',
  'TABDOCK_HOST',
  'TABDOCK_PUBLIC_URL',
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'test-results') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

function json(path: string): Record<string, Record<string, string> | string | boolean> {
  return JSON.parse(readRepo(path)) as Record<string, Record<string, string> | string | boolean>;
}

describe('tests/ci-check, as a copier takes it', () => {
  const files = sources(PACKAGE);

  it('imports only Playwright, the MCP client, the testing helper, zod and node:', () => {
    expect(files.map((file) => relative(PACKAGE, file))).toEqual(
      expect.arrayContaining([
        'playwright.config.ts',
        'src/walk.ts',
        'src/profile.ts',
        'src/tabdock.ts',
      ]),
    );
    const outside = files.flatMap((file) => {
      const where = relative(PACKAGE, file);
      // The walker's own unit tests run under this repository's vitest; a copier may drop them.
      const allowed = where.startsWith('test/') ? [...ALLOWED, 'vitest'] : ALLOWED;
      return [
        ...readFileSync(file, 'utf8').matchAll(/\bfrom\s+'([^']+)'|\bimport\s*\(?\s*'([^']+)'/g),
      ]
        .map((match) => match[1] ?? match[2] ?? '')
        .filter(
          (specifier) =>
            !specifier.startsWith('./') &&
            !specifier.startsWith('../') &&
            !specifier.startsWith('node:') &&
            !allowed.includes(specifier),
        )
        .map((specifier) => `${where}: ${specifier}`);
    });
    expect(outside).toEqual([]);
  });

  it('names no other workspace package, test hook, or setting that widens or raises', () => {
    const named = files.flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return BANNED.filter((word) => text.includes(word)).map(
        (word) => `${relative(PACKAGE, file)}: ${word}`,
      );
    });
    expect(named).toEqual([]);
  });

  it('is private and pins what the workspace pins', () => {
    const manifest = json('tests/ci-check/package.json');
    const e2e = json('tests/e2e/package.json').devDependencies as Record<string, string>;
    const sim = json('packages/sim-page/package.json').dependencies as Record<string, string>;
    expect(manifest.private).toBe(true);
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.devDependencies).toEqual({
      '@modelcontextprotocol/client': e2e['@modelcontextprotocol/client'],
      '@playwright/test': e2e['@playwright/test'],
      '@tabdock/adapter': 'workspace:*',
      zod: sim.zod,
    });
    expect(e2e['@tabdock/ci-check']).toBe('workspace:*');
    expect((json('package.json').scripts as Record<string, string>)['ci-check']).toBe(
      'node scripts/ci-check.ts',
    );
  });

  it('starts the relay ready on /healthz, stopped by SIGINT, never reusing a server', () => {
    const servers = Array.isArray(config.webServer) ? config.webServer : [config.webServer];
    expect(servers).toHaveLength(2);
    const [relay, page] = servers;
    expect(relay?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/healthz$/);
    expect(relay?.gracefulShutdown).toEqual({ signal: 'SIGINT', timeout: 10_000 });
    for (const server of servers) expect(server?.reuseExistingServer).toBe(false);
    expect(page?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    // One worker: one relay and one owner token, whose budgets more workers would only share.
    expect(config.workers).toBe(1);
    const projects = (config.projects ?? []).map((project) => project.name);
    expect(projects).toEqual(['chromium', 'advisory']);
    // The check runs the page on the polyfill it loads, with no flag turning native WebMCP on.
    expect(readRepo('tests/ci-check/playwright.config.ts')).not.toContain('WebMCPTesting');
  });

  it("walks this repository's page requiring every group the walker would otherwise skip", () => {
    const spec = readRepo('tests/ci-check/specs/walk.spec.ts');
    const list = /const REQUIRE_TOOLS = \[([^\]]*)\]/.exec(spec)?.[1] ?? '';
    const named = [...list.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    expect([...named].sort()).toEqual([...OPTIONAL_TOOLS].sort());
    expect(spec).toContain('requireTools: REQUIRE_TOOLS');
  });

  it('connects the page through its connect hook in one replaceable function, never its URL (C3)', () => {
    const fixture = readRepo('tests/ci-check/src/tabdock.ts');
    expect(fixture).toMatch(
      /export async function connectPage\(page: Page, relayPageUrl: string\)/,
    );
    expect(fixture).toContain('__tabdockMapPage');
    expect(fixture).not.toMatch(/[?#]relay=/);
    expect(fixture).toContain(`'${CLIENT_NAME}'`);
  });
});

describe('the copied profile schemas (conflict C4)', () => {
  const originals: Record<
    string,
    { toJSONSchema(params?: object): unknown; safeParse(value: unknown): { success: boolean } }
  > = map as unknown as Record<string, never>;
  const names = Object.keys(copied.COPIED_SCHEMAS) as (keyof typeof copied.COPIED_SCHEMAS)[];

  it('copy every schema the walk reads, by its original name', () => {
    expect(names.sort()).toEqual(
      [
        'CaptureImageTextSchema',
        'GoToStopResultSchema',
        'ListObservationsResultSchema',
        'ListWalkthroughsResultSchema',
        'MapClockSchema',
        'MapObservationSchema',
        'MapPageStateSchema',
        'MapStopSchema',
        'MapStopViewSchema',
        'MapViewSchema',
        'ViewFromObservationResultSchema',
      ].sort(),
    );
    for (const name of names) expect(originals[name], name).toBeDefined();
  });

  it.each(['input', 'output'] as const)('equal their originals as JSON Schema (%s)', (io) => {
    for (const name of names) {
      expect(copied.COPIED_SCHEMAS[name].toJSONSchema({ io }), name).toEqual(
        originals[name]?.toJSONSchema({ io }),
      );
    }
    expect(copied.MAP_PROFILE).toBe(map.MAP_PROFILE);
    expect(copied.MAP_MAX_OBSERVATIONS).toBe(map.MAP_MAX_OBSERVATIONS);
  });

  it('agree with their originals on what JSON Schema cannot show', () => {
    const world = map.createMapWorld();
    const stop = world.stop('flyby', 2);
    const observation = world.observation('obs-3');
    const listed = world.observations({ limit: map.MAP_MAX_OBSERVATIONS });
    const summary = listed.observations[0];
    const view = world.view();
    const samples: [keyof typeof copied.COPIED_SCHEMAS, unknown][] = [
      ['MapViewSchema', view],
      // A globe's camera fields present on a flat map, and missing on a globe.
      ['MapViewSchema', { ...view, altitudeM: 1, fovDeg: 60 }],
      ['MapStopViewSchema', { ...stop.view, altitudeM: undefined }],
      ['MapClockSchema', world.clock()],
      ['MapClockSchema', { ...world.clock(), time: '2026-02-30T00:00:00Z' }],
      ['ListWalkthroughsResultSchema', world.walkthroughs()],
      ['MapStopSchema', stop],
      ['MapStopSchema', { ...stop, title: 'bell \u0007' }],
      ['MapStopSchema', { ...stop, text: 'lone \ud83c half' }],
      ['MapStopSchema', { ...stop, text: 'tab\tand\nlines and a pair 🌕' }],
      ['MapObservationSchema', observation],
      ['MapObservationSchema', { ...observation, notes: ['escape \u001b[2J'] }],
      [
        'MapObservationSchema',
        {
          ...observation,
          footprint: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
              ],
            ],
          },
        },
      ],
      ['ListObservationsResultSchema', listed],
      [
        'ListObservationsResultSchema',
        { ...listed, observations: Array.from({ length: 151 }, () => summary) },
      ],
      ['ViewFromObservationResultSchema', world.viewFromObservation('obs-3')],
      ['MapPageStateSchema', world.state()],
      ['MapPageStateSchema', { ...world.state(), walkthrough: { id: 'flyby', stopIndex: 1000 } }],
      [
        'CaptureImageTextSchema',
        { view, visibleLayers: ['albedo'], observationId: null, widthPx: 960, heightPx: 540 },
      ],
    ];
    const accepted = samples.map(([name, value]) => [
      name,
      copied.COPIED_SCHEMAS[name].safeParse(value).success,
      originals[name]?.safeParse(value).success,
    ]);
    for (const [name, copy, original] of accepted) expect(copy, String(name)).toBe(original);
    // The samples reach both sides of each rule, so agreement is not agreement to accept all.
    expect(accepted.filter(([, copy]) => copy === false).length).toBeGreaterThanOrEqual(9);
  });
});

describe("CI's ci-check job", () => {
  const ci = readRepo('.github/workflows/ci.yml');
  /** ci.yml's jobs, each as its text, comments left out so a rule kept only in a comment counts for nothing. */
  const code = ci
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line.replace(/\s+#(\s.*)?$/, '')))
    .join('\n');
  const jobs = new Map(
    code
      .slice(code.search(/^jobs:$/m))
      .split(/\n(?= {2}[a-z][\w-]*:\n)/)
      .slice(1)
      .map((block) => [/^ {2}([a-z][\w-]*):/.exec(block)?.[1] ?? '', block] as const),
  );
  const job = jobs.get('ci-check') ?? '';
  const steps = job
    .slice(job.search(/^ {4}steps:$/m))
    .split(/\n(?= {6}- )/)
    .slice(1);

  it('runs pnpm ci-check with TABDOCK_HOME under RUNNER_TEMP, set through GITHUB_ENV', () => {
    expect(job).not.toBe('');
    const run = steps.findIndex((step) => /^ {6}- run: pnpm ci-check$/m.test(step));
    const home = steps.findIndex((step) =>
      step.includes('echo "TABDOCK_HOME=$RUNNER_TEMP/tabdock-ci-check" >> "$GITHUB_ENV"'),
    );
    expect(home).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(home);
    // Only the deletion may be switched by a condition, and it runs whatever happened before it.
    const conditioned = steps.filter((step) => /^ {6}- if:|^ {8}if:/m.test(step));
    expect(conditioned).toHaveLength(1);
    expect(conditioned[0]).toMatch(/^ {8}if: always\(\)$/m);
    expect(conditioned[0]).toContain('run: rm -rf -- "${TABDOCK_HOME:?}"');
    expect(steps.indexOf(conditioned[0] ?? '')).toBe(steps.length - 1);
    expect(job).not.toMatch(/^ {4}if:/m);
  });

  it('reads no secret and keeps nothing: no cache, no upload, no job-wide TABDOCK_HOME', () => {
    for (const word of ['secrets.', 'actions/cache', 'upload-artifact', 'ANTHROPIC_API_KEY']) {
      expect(job, word).not.toContain(word);
    }
    expect(job).not.toMatch(/^ {4}env:/m);
    expect(job).not.toMatch(/^ {4}permissions:/m);
  });

  it('runs no Claude Code job anywhere in this repository, and names no key (decision 1)', () => {
    expect(code).not.toMatch(/\bclaude\b/);
    expect(code).not.toContain('ANTHROPIC_API_KEY');
    expect(code).not.toContain('secrets.');
  });
});

describe("the repository's runner, scripts/ci-check.ts", () => {
  const token = `tabdock_${'Q'.repeat(10)}${'r7'.repeat(16)}x`;

  it('withholds output holding the token in any form, or an unmasked pairing code', () => {
    const digest = createHash('sha256').update(token, 'utf8').digest('hex');
    expect(outputLeak('a quiet run', token)).toBeNull();
    expect(outputLeak(`header Bearer ${token}`, token)).toBe('the token');
    expect(outputLeak(`digest ${digest}`, token)).toBe('its digest in hex');
    expect(outputLeak('code AB3DE-7FGHJ on the page', token)).toBe('an unmasked pairing code');
    // Masked as the helper's maskCode masks it, and lower case hex, it is no code.
    expect(outputLeak('code AB3DE-***** on the page', token)).toBeNull();
    expect(outputLeak('commit 3d3c4-2e5aa', token)).toBeNull();
  });

  it('reads the page call count the walk prints', () => {
    expect(printedPageCalls('Running 1 test\nci-check: 49 page calls\n  1 passed')).toBe(49);
    expect(printedPageCalls('no count')).toBeNull();
  });

  /** One audit line, chained to the one before. */
  function lines(records: Record<string, unknown>[]): string[] {
    let prev: string | null = null;
    return records.map((record, index) => {
      const line = JSON.stringify({
        v: 1,
        at: 1_791_699_459_984 + index,
        ...record,
        seq: index + 1,
        prev,
      });
      prev = createHash('sha256').update(line, 'utf8').digest('hex');
      return line;
    });
  }
  const start = {
    type: 'relay_start',
    version: '0.1.0',
    env: 'development',
    mode: 'local',
    invites: false,
  };
  const call = (client: string, outcome = 'ok') => ({
    type: 'call',
    pageId: 'pg_GJV18AT1GB',
    origin: 'http://127.0.0.1:5180',
    userId: 'you',
    client: { name: client, version: '1.0.0' },
    tool: 'get_view',
    outcome,
    durationMs: 3,
  });
  const stop = { type: 'relay_stop' };

  it('holds the audit log to the walk: one start, a stop last, and only its ok calls', () => {
    expect(auditProblems(lines([start, call(CLIENT_NAME), call(CLIENT_NAME), stop]), 2)).toEqual({
      problems: [],
      calls: 2,
    });
    expect(auditProblems(lines([start, call(CLIENT_NAME), stop]), 2).problems).toEqual([
      "the audit log holds 1 call records for the walk's 2 page calls",
    ]);
    expect(auditProblems(lines([start, call('another-client'), stop]), 1).problems).toEqual([
      `1 call records are not ok calls from you through ${CLIENT_NAME}`,
    ]);
    expect(
      auditProblems(lines([start, call(CLIENT_NAME, 'rate_limited'), stop]), 1).problems,
    ).toHaveLength(1);
    expect(auditProblems(lines([start, call(CLIENT_NAME)]), 1).problems).toEqual([
      'the audit log does not end with relay_stop',
    ]);
    expect(auditProblems([...lines([start, stop]), '{"torn'], 0).problems).toContain(
      'an audit line is not a valid record',
    );
    // The advisory walk's calls are Claude Code's, so only the chain's shape is held.
    expect(auditProblems(lines([start, call('claude-code'), stop]), null).problems).toEqual([]);
  });

  it('refuses a TABDOCK_HOME a relay may already use, and a relative one', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'ci-check-home-'));
    try {
      const used = join(scratch, 'used');
      mkdirSync(used);
      writeFileSync(join(used, 'owner-token'), 'x');
      expect(() => homeFor({ TABDOCK_HOME: used })).toThrow('fresh, empty directory');
      expect(() => homeFor({ TABDOCK_HOME: 'relative/home' })).toThrow('must be an absolute path');
      expect(homeFor({ TABDOCK_HOME: join(scratch, 'fresh') })).toEqual({
        home: join(scratch, 'fresh'),
        made: false,
      });
      const made = homeFor({}, () => scratch);
      expect(made.made).toBe(true);
      expect(made.home.startsWith(join(scratch, 'tabdock-ci-check-'))).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('the runner, interrupted', () => {
  /** Whether a process still runs. */
  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // A terminal's Ctrl-C reaches the runner but not the process group it puts
  // Playwright in, so only the runner is signalled here, as only it would be.
  it.skipIf(process.platform === 'win32')(
    'stops everything it started and deletes the home it made on Ctrl-C or SIGTERM',
    async () => {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        const scratch = mkdtempSync(join(tmpdir(), 'ci-check-signal-'));
        const report = join(scratch, 'stand-in.json');
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          npm_execpath: join(ROOT, 'tests/e2e/test/pnpm-stand-in.ts'),
          CI_CHECK_STAND_IN: report,
        };
        delete env.TABDOCK_HOME;
        const runner = spawn(process.execPath, [join(ROOT, 'scripts/ci-check.ts')], {
          cwd: ROOT,
          env,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        const ended = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
          runner.on('close', (code, by) => {
            resolve({ code, signal: by });
          });
        });
        let started: { pid: number; home: string } | null = null;
        try {
          const deadline = Date.now() + 15_000;
          while (!existsSync(report) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          started = JSON.parse(readFileSync(report, 'utf8')) as { pid: number; home: string };
          expect(alive(started.pid)).toBe(true);
          expect(existsSync(started.home)).toBe(true);
          runner.kill(signal);
          expect(await ended).toEqual({ code: signal === 'SIGINT' ? 130 : 143, signal: null });
          expect(alive(started.pid)).toBe(false);
          expect(existsSync(started.home)).toBe(false);
        } finally {
          runner.kill('SIGKILL');
          if (started !== null) {
            if (alive(started.pid)) process.kill(-started.pid, 'SIGKILL');
            rmSync(started.home, { recursive: true, force: true });
          }
          rmSync(scratch, { recursive: true, force: true });
        }
      }
    },
    40_000,
  );
});

describe('guide page 17', () => {
  it('names in its helper table exactly what @tabdock/adapter/testing exports', async () => {
    const page = readRepo('docs/guide/17-check-from-ci.md');
    const section = page.slice(page.indexOf('## The testing helper'));
    const named = [...section.matchAll(/^\| `([A-Za-z_]+)(?:\(\))?`/gm)].map((match) => match[1]);
    const exported = Object.keys(await import('@tabdock/adapter/testing'));
    expect(named.length).toBeGreaterThan(0);
    expect([...named].sort()).toEqual([...exported].sort());
  });
});

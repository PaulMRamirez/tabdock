// The official MCP conformance suite against the relay, both requirement sets
// (ADR 0027, A5.2):
//   pnpm conformance            (from the root; CI runs it on every push)
//   pnpm conformance -- --results <dir>   keeps each scenario's checks.json
//
// `pnpm relay` starts as an operator starts it, with every Tabdock setting
// cleared, TABDOCK_HOME in a throwaway directory, one dev token drawn for
// this run alone, and two limits raised for this run alone through the
// settings any operator has: TABDOCK_MAX_SESSIONS_PER_USER, since the
// referee leaves its 2025-era sessions open, and TABDOCK_MAX_REQUESTS_PER_USER,
// since every 2026-07-28 request spends (ADR 0030) and the referee sends more
// than 240 a minute. Nothing else changes, so every other S9 limit and every
// S12 check stands as it does for anyone. The suite's server mode takes no
// header and the relay never takes a token in a URL (S11), so the suite
// talks to a loopback proxy (mcp-proxy.ts) that adds the bearer header, logs
// nothing and passes Host and Origin through untouched, so the suite's
// rebinding scenario tests the relay's own checks.
//
// `@modelcontextprotocol/conformance` 0.2.0-alpha.12, pinned exactly in
// tests/e2e, runs the 2025-11-25 set and then the 2026-07-28 set, each at its
// own wire, against tests/e2e/conformance/<revision>.yaml, a baseline that
// lists only what reviewed.json beside it names (conformance-baselines.ts).
// The suite fails a run on an unexpected failure and on a stale entry, one
// that now passes; this script also fails it when an excused check failed for
// another reason than the one reviewed, or when dns-rebinding-protection or
// http-header-validation did not pass every check (the suite does not score
// the second in this alpha), and when anything printed holds the token.

import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateTempRoot } from '@tabdock/relay/test/private-tmp';
import { leakIn } from '@tabdock/relay/test/secrecy';
import {
  baselineProblems,
  CONFORMANCE_DIR,
  readBaseline,
  readReviewed,
  readRun,
  reviewedProblems,
  runProblems,
} from './conformance-baselines.ts';
import { freePort } from './harness.ts';
import { blankEnv, type Run, runPnpm } from './local-harness.ts';
import { type McpProxy, startMcpProxy } from './mcp-proxy.ts';

/** The requirement sets ADR 0027 runs, oldest first. */
export const REVISIONS = ['2025-11-25', '2026-07-28'] as const;

/** The limits raised for this run alone, and no others (ADRs 0027 and 0030). */
export const RAISED_LIMITS = {
  TABDOCK_MAX_SESSIONS_PER_USER: '200',
  TABDOCK_MAX_REQUESTS_PER_USER: '10000',
} as const;

const SUITE = join(
  dirname(createRequire(import.meta.url).resolve('@modelcontextprotocol/conformance/package.json')),
  'dist',
  'index.js',
);

interface Ran {
  code: number | null;
  output: string;
}

function runSuite(args: string[]): Promise<Ran> {
  return new Promise((resolveRan, reject) => {
    // The suite's environment holds no Tabdock setting, so the run's token never reaches it.
    const child = spawn(process.execPath, [SUITE, ...args], {
      env: blankEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGTERM'), 300_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRan({ code, output });
    });
  });
}

/** JSON log lines go to stderr; the start line says the relay is listening. */
async function waitForListening(relay: Run, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // An object, since the flag changes in a callback the loop cannot see.
  const exit = { seen: false };
  void relay.exited.then(() => {
    exit.seen = true;
  });
  while (!relay.stderr().includes('"relay listening"')) {
    if (exit.seen || Date.now() > deadline) {
      throw new Error(`pnpm relay ${exit.seen ? 'exited' : 'timed out'} before it was listening`);
    }
    await new Promise((wait) => setTimeout(wait, 50));
  }
}

const say = (text: string): void => {
  console.log(text);
};

function resultsDir(argv: readonly string[]): string | null {
  const at = argv.indexOf('--results');
  const dir = at === -1 ? undefined : argv[at + 1];
  return dir === undefined ? null : resolve(dir);
}

async function main(kept: string | null): Promise<boolean> {
  // The baselines are checked before anything runs, as the unit test checks them.
  const reviewed = readReviewed();
  const entries = new Map(REVISIONS.map((revision) => [revision, readBaseline(revision)]));
  const before = [
    ...reviewedProblems(reviewed),
    ...REVISIONS.flatMap((revision) =>
      baselineProblems(revision, entries.get(revision) ?? [], reviewed),
    ),
  ];
  if (before.length > 0) {
    say(`The baselines in ${CONFORMANCE_DIR} break the rules of ADR 0027:`);
    for (const problem of before) say(`   ${problem}`);
    return false;
  }

  const dir = await mkdtemp(join(privateTempRoot(), 'tabdock-conformance-'));
  const results = kept ?? join(dir, 'results');
  const token = randomBytes(32).toString('base64url');
  /** Shows text unless it holds the token, which it never should. */
  const show = (text: string): boolean => {
    const leaked = leakIn(text, token) !== null;
    say(leaked ? '[withheld: this output held the run token]' : text);
    return !leaked;
  };
  let relay: Run | undefined;
  let proxy: McpProxy | undefined;
  try {
    const port = await freePort();
    relay = runPnpm(['relay'], {
      ...blankEnv(),
      TABDOCK_HOME: join(dir, 'tabdock'),
      TABDOCK_DEV_TOKENS: `conformance=${token}`,
      TABDOCK_PORT: String(port),
      ...RAISED_LIMITS,
    });
    await waitForListening(relay);
    proxy = await startMcpProxy({ upstream: `http://127.0.0.1:${String(port)}`, bearer: token });
    say(
      `pnpm relay with a dev token drawn for this run, sessions per user at ${RAISED_LIMITS.TABDOCK_MAX_SESSIONS_PER_USER} and requests per user at ${RAISED_LIMITS.TABDOCK_MAX_REQUESTS_PER_USER} a minute for this run alone, behind a loopback proxy that adds the bearer header and logs nothing.`,
    );
    const outcomes: [string, boolean][] = [];
    const after: string[] = [];
    let clean = true;
    for (const revision of REVISIONS) {
      say(`\n=== ${revision} requirement set ===`);
      const out = join(results, revision);
      const ran = await runSuite([
        'server',
        '--url',
        proxy.url,
        '--requirements',
        revision,
        '--expected-failures',
        join(CONFORMANCE_DIR, `${revision}.yaml`),
        '--output-dir',
        out,
      ]);
      clean = show(ran.output.trimEnd()) && clean;
      say(`=== ${revision}: the suite exited ${String(ran.code)} ===`);
      outcomes.push([revision, ran.code === 0]);
      after.push(...runProblems(revision, readRun(out), entries.get(revision) ?? [], reviewed));
    }
    await relay.stop();
    const relayClean = leakIn(`${relay.stdout()}\n${relay.stderr()}`, token) === null;
    say('');
    for (const [revision, ok] of outcomes) {
      say(
        `   ${ok ? 'ok  ' : 'FAIL'} the ${revision} requirement set exits 0 against its baseline`,
      );
    }
    say(
      `   ${after.length === 0 ? 'ok  ' : 'FAIL'} dns-rebinding-protection and http-header-validation passed every check, and each excused check failed only for its reviewed reason`,
    );
    for (const problem of after) say(`        ${problem}`);
    say(`   ${relayClean ? 'ok  ' : 'FAIL'} the relay printed no part of the run token`);
    say(`   ${clean ? 'ok  ' : 'FAIL'} the suite printed no part of the run token`);
    if (kept !== null) say(`\nEach scenario's checks.json is kept under ${kept}.`);
    return outcomes.every(([, ok]) => ok) && after.length === 0 && relayClean && clean;
  } finally {
    await proxy?.close();
    await relay?.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const passed = await main(resultsDir(process.argv.slice(2)));
    say(
      passed
        ? '\nConformance PASS: both requirement sets exit 0 against their baselines.'
        : '\nConformance FAIL: the output above says where.',
    );
    process.exitCode = passed ? 0 : 1;
  } catch (error) {
    say(`Conformance FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

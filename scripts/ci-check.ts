// pnpm ci-check: this repository's run of the copyable check in tests/ci-check
// (ADR 0041, A6.8), the way CI's ci-check job runs it.
//   pnpm ci-check                 the deterministic walk of tests/map-page
//   pnpm ci-check --advisory      the hand-run Claude Code walk instead
// Any other arguments go to Playwright.
//
// It gives the check a fresh TABDOCK_HOME: the one CI names (under
// $RUNNER_TEMP, and only while it is still empty, so no relay already using
// it is disturbed), or a throwaway one it makes and deletes. It runs the
// relay from this checkout and the canvas map page on port 5180, with every
// other Tabdock setting cleared, so the relay is local mode at its defaults.
// It prints Playwright's output only after scanning it: any form of the
// owner token or an unmasked pairing code fails the run and withholds the
// output (S11). Then, with the relay stopped, it verifies the audit chain and
// holds its call records to the walk: every one ok, from `you` through
// tabdock-ci-check, as many as the page calls the walk printed (S7). Ctrl-C
// or SIGTERM stops everything it started and still deletes the home it made.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditLineSchema } from '../packages/protocol/src/index.ts';
import { privateTempRoot } from '../packages/relay/test/helpers/private-tmp.ts';
import { leakIn } from '../packages/relay/test/helpers/secrecy.ts';
import { blankEnv, type Run, runPnpm } from '../tests/e2e/src/local-harness.ts';

const ROOT = resolve(import.meta.dirname, '..');
export const CLIENT_NAME = 'tabdock-ci-check';
/** A pairing code as the widget shows it: two runs of five Crockford symbols. */
const UNMASKED_CODE = /\b[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}\b/;
const PAGE_CALLS = /^ci-check: (\d+) page calls$/m;

type Env = Readonly<Record<string, string | undefined>>;

function port(env: Env, name: string, fallback: number): number {
  const text = env[name]?.trim() ?? '';
  if (text === '') return fallback;
  const value = /^\d{1,5}$/.test(text) ? Number(text) : NaN;
  if (!(value >= 1 && value <= 65535)) throw new Error(`${name} must be a port from 1 to 65535`);
  return value;
}

/**
 * The home this run uses, and whether it made it and so deletes it. A given
 * one must be absolute and empty or absent: a home a relay already uses
 * holds a token, a lock and an audit log that are not this run's.
 */
export function homeFor(
  env: Env,
  makeIn: () => string = privateTempRoot,
): {
  home: string;
  made: boolean;
} {
  const given = env.TABDOCK_HOME?.trim() ?? '';
  if (given === '') return { home: mkdtempSync(join(makeIn(), 'tabdock-ci-check-')), made: true };
  if (!isAbsolute(given)) throw new Error('TABDOCK_HOME must be an absolute path');
  if (existsSync(given) && readdirSync(given).length > 0) {
    throw new Error(
      'pnpm ci-check needs TABDOCK_HOME to name a fresh, empty directory; unset it and the run makes a throwaway one',
    );
  }
  return { home: given, made: false };
}

/** What a run's output holds that it must not, naming the form and never quoting it, or null. */
export function outputLeak(output: string, token: string): string | null {
  const leak = token === '' ? null : leakIn(output, token);
  if (leak !== null) return leak;
  return UNMASKED_CODE.test(output) ? 'an unmasked pairing code' : null;
}

/** The page calls the walk said it made, or null when it printed no count. */
export function printedPageCalls(output: string): number | null {
  const counted = PAGE_CALLS.exec(output);
  return counted === null ? null : Number(counted[1]);
}

/**
 * What is wrong with the audit log's records (`--json` lines) for this run:
 * each must be a valid record; the log must hold one relay_start and end
 * with relay_stop, so nothing was lost to a kill; and, for the walk, every
 * call record must be an ok call from `you` through tabdock-ci-check, as
 * many as its page calls. The records themselves are never printed.
 */
export function auditProblems(
  jsonLines: readonly string[],
  pageCalls: number | null,
): { problems: string[]; calls: number } {
  const problems: string[] = [];
  const records = jsonLines
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return AuditLineSchema.safeParse(JSON.parse(line));
      } catch {
        return null;
      }
    });
  if (records.some((record) => record === null || !record.success)) {
    problems.push('an audit line is not a valid record');
  }
  const lines = records.flatMap((record) => (record?.success === true ? [record.data] : []));
  if (lines.filter((line) => line.type === 'relay_start').length !== 1) {
    problems.push('the audit log holds other than one relay_start');
  }
  if (lines.at(-1)?.type !== 'relay_stop')
    problems.push('the audit log does not end with relay_stop');
  const calls = lines.flatMap((line) => (line.type === 'call' ? [line] : []));
  if (pageCalls !== null) {
    const strays = calls.filter(
      (call) => call.userId !== 'you' || call.client?.name !== CLIENT_NAME || call.outcome !== 'ok',
    );
    if (strays.length > 0) {
      problems.push(
        `${String(strays.length)} call records are not ok calls from you through ${CLIENT_NAME}`,
      );
    }
    if (calls.length !== pageCalls) {
      problems.push(
        `the audit log holds ${String(calls.length)} call records for the walk's ${String(pageCalls)} page calls`,
      );
    }
  }
  return { problems, calls: calls.length };
}

async function main(args: readonly string[], env: Env): Promise<number> {
  const advisory = args[0] === '--advisory';
  const forPlaywright = advisory ? args.slice(1) : args;
  const relayPort = port(env, 'TABDOCK_PORT', 8787);
  const pagePort = port(env, 'CI_CHECK_PAGE_PORT', 5180);
  const { home, made } = homeFor(env);
  // Playwright runs in a process group of its own, which a terminal's Ctrl-C
  // never reaches, and a signal's default action would end this process
  // before its finally. So a signal here stops the whole group, relay, page
  // server and browser, waits for it, and lets the finally delete the home
  // and the owner token in it; a second signal waits with the first.
  const stopped: { run: Run | null; by: NodeJS.Signals | null } = { run: null, by: null };
  const onSignal = (signal: NodeJS.Signals): void => {
    stopped.by ??= signal;
    void stopped.run?.stop();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const run = runPnpm(
      ['--filter', '@tabdock/ci-check', advisory ? 'advisory' : 'check', ...forPlaywright],
      {
        ...blankEnv(),
        TABDOCK_HOME: home,
        TABDOCK_PORT: String(relayPort),
        CI_CHECK_RELAY_COMMAND: `"${process.execPath}" "${join(ROOT, 'packages/relay/src/main.ts')}"`,
        CI_CHECK_PAGE_COMMAND: `"${process.execPath}" "${join(ROOT, 'tests/map-page/scripts/server.ts')}" --port ${String(pagePort)}`,
        CI_CHECK_PAGE_URL: `http://127.0.0.1:${String(pagePort)}/`,
      },
    );
    stopped.run = run;
    const code = await run.exited;
    if (stopped.by !== null) {
      // Its output is not scanned, so it is not printed.
      console.error(`ci-check: stopped by ${stopped.by}, with everything it started`);
      return stopped.by === 'SIGINT' ? 130 : 143;
    }
    const output = `${run.stdout()}${run.stderr()}`;
    const tokenFile = join(home, 'owner-token');
    const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'latin1').trim() : '';
    const leak = outputLeak(output, token);
    if (leak !== null) {
      console.error(`ci-check: the run's output held ${leak}, so it is withheld (S11)`);
      return 1;
    }
    process.stdout.write(output);
    if (code !== 0) {
      console.error(`ci-check: Playwright exited with ${String(code)}`);
      return 1;
    }
    const pageCalls = printedPageCalls(output);
    if (!advisory && pageCalls === null) {
      console.error('ci-check: the walk printed no page call count');
      return 1;
    }
    const read = spawnSync(
      process.execPath,
      [
        join(ROOT, 'packages/relay/src/audit-cli.ts'),
        '--dir',
        join(home, 'audit'),
        '--verify',
        '--json',
      ],
      { cwd: ROOT, env: { ...blankEnv(), TABDOCK_HOME: home }, encoding: 'utf8' },
    );
    const verdict = read.stderr.split('\n').find((line) => line.startsWith('verify: ')) ?? '';
    const audit = auditProblems(read.stdout.split('\n'), advisory ? null : pageCalls);
    if (read.status !== 0) audit.problems.unshift('the audit chain did not verify');
    for (const problem of audit.problems) console.error(`ci-check: ${problem}`);
    console.log(
      `ci-check: audit ${verdict || 'not verified'}; ${String(audit.calls)} call records`,
    );
    return audit.problems.length === 0 ? 0 : 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (made) rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), process.env).catch((error: unknown) => {
    console.error(`ci-check: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  });
}

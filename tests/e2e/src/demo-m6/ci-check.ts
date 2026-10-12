// Leg 10 of pnpm demo:m6 (ADR 0041): the check a page's own CI runs, as this
// repository's CI job runs it: `pnpm ci-check` walks the canvas map page in
// local mode with no secret, through @tabdock/adapter/testing, then verifies
// the audit chain and holds its call records to the walk. It scans its own
// output for the owner token and any unmasked code before printing it; the
// demo prints only its summary lines, and scans those again.

import { freePort } from '../harness.ts';
import { blankEnv, runPnpm } from '../local-harness.ts';
import { bind, type Stage } from './lesson.ts';

export async function ciCheck(stage: Stage): Promise<void> {
  const { say, check } = bind(stage.narrator);
  // Free ports rather than its 8787 and 5180, so nothing else on this machine is disturbed.
  const relayPort = await freePort();
  const pagePort = await freePort();
  say(`$ TABDOCK_PORT=${String(relayPort)} CI_CHECK_PAGE_PORT=${String(pagePort)} pnpm ci-check`);
  const startedAt = Date.now();
  const run = runPnpm(['ci-check'], {
    ...blankEnv(),
    TABDOCK_PORT: String(relayPort),
    CI_CHECK_PAGE_PORT: String(pagePort),
  });
  const code = await run.exited;
  const output = `${run.stdout()}\n${run.stderr()}`;
  check(stage.narrator.leakIn(output) === null, 'ci-check printed a secret this run met');
  const summary = output
    .split('\n')
    .filter((line) => line.startsWith('ci-check:') || /^\s+\d+ (passed|failed|skipped)/.test(line));
  for (const line of summary) say(`   ${line.trim()}`);
  say(
    `   It exited ${String(code)} after ${String(Math.round((Date.now() - startedAt) / 1000))} s.`,
  );
  check(code === 0, 'pnpm ci-check should pass');
}

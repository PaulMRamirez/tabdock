// The rules a conformance baseline lives under (ADR 0027), in one place for
// the test that reads the checked-in files (test/conformance-baselines.test.ts)
// and for the run that reads what the suite found (src/conformance.ts).
//
// A baseline may excuse only what reviewed.json names: a whole scenario that
// calls the referee's fixture tools, prompts, resources or capabilities; one
// check that needs a diagnostic fixture tool; or one SHOULD-level warning. It
// may never name dns-rebinding-protection or http-header-validation, which
// test S12's Host and Origin rules and the header checks, nor excuse a
// MUST-level check of a scenario that does not depend on the referee's
// fixtures. The static rules hold the files; the run's rules hold what the
// files claim: an excused warning must have failed as a warning, an excused
// fixture check for want of a fixture, and the two scenarios above must have
// run and passed every check, since the suite does not score
// http-header-validation in 0.2.0-alpha.12 and so would not fail on it.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Scenarios no baseline may name, whole or by check. */
export const NEVER_EXCUSED = ['dns-rebinding-protection', 'http-header-validation'] as const;

/** Where the baselines and the reviewed list live. */
export const CONFORMANCE_DIR = fileURLToPath(new URL('../conformance/', import.meta.url));

/** The suite's own frozen requirement sets. */
const REQUIREMENTS_DIR = join(
  dirname(createRequire(import.meta.url).resolve('@modelcontextprotocol/conformance/package.json')),
  'requirements',
);

export interface Reviewed {
  fixtureScenarios: Record<string, string>;
  fixtureChecks: Record<string, string>;
  shouldWarnings: Record<string, string>;
}

const ENTRY = /^[a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?$/;

/**
 * A baseline file's entries. Only the shape the suite reads as a list of
 * strings under `server:` is taken, one `- <entry>` a line, with comments and
 * blank lines; anything else throws, so what this reads is what the suite reads.
 */
export function parseBaseline(text: string): string[] {
  const entries: string[] = [];
  let inServer = false;
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.replace(/\s+#.*$/, '').trimEnd();
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (line === 'server:') {
      if (inServer) throw new Error(`line ${String(index + 1)}: a second server: key`);
      inServer = true;
      continue;
    }
    const item = /^ {2}- (\S+)$/.exec(line);
    if (!inServer || item?.[1] === undefined || !ENTRY.test(item[1])) {
      throw new Error(
        `line ${String(index + 1)} is not a "  - <scenario>[:<check-id>]" entry under server:`,
      );
    }
    entries.push(item[1]);
  }
  if (!inServer) throw new Error('no server: key');
  return entries;
}

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((reason) => typeof reason === 'string' && reason.trim() !== '')
  );
}

export function parseReviewed(text: string): Reviewed {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const { fixtureScenarios, fixtureChecks, shouldWarnings } = parsed;
  if (
    !isStringMap(fixtureScenarios) ||
    !isStringMap(fixtureChecks) ||
    !isStringMap(shouldWarnings)
  ) {
    throw new Error(
      'reviewed.json needs fixtureScenarios, fixtureChecks and shouldWarnings, each mapping an entry to its reason',
    );
  }
  return { fixtureScenarios, fixtureChecks, shouldWarnings };
}

export function readReviewed(dir: string = CONFORMANCE_DIR): Reviewed {
  return parseReviewed(readFileSync(join(dir, 'reviewed.json'), 'utf8'));
}

export function readBaseline(revision: string, dir: string = CONFORMANCE_DIR): string[] {
  return parseBaseline(readFileSync(join(dir, `${revision}.yaml`), 'utf8'));
}

/**
 * The server scenarios a requirement set runs, scored or not, read from the
 * suite's own file: its `server:` list and its `not_scored` server entries.
 */
export function requirementScenarios(revision: string): { scored: string[]; all: string[] } {
  const text = readFileSync(join(REQUIREMENTS_DIR, `${revision}.yaml`), 'utf8');
  const scored: string[] = [];
  const unscored: string[] = [];
  let section = '';
  let pending: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    const key = /^([a-z_]+):\s*$/.exec(line);
    if (key?.[1] !== undefined) {
      section = key[1];
      continue;
    }
    if (section === 'server') {
      const item = /^ {2}- (\S+)$/.exec(line);
      if (item?.[1] !== undefined) scored.push(item[1]);
    }
    if (section === 'not_scored') {
      const scenario = /^ {2}- scenario: (\S+)$/.exec(line);
      if (scenario?.[1] !== undefined) pending = scenario[1];
      const leg = /^ {4}leg: (\S+)$/.exec(line);
      if (leg?.[1] === 'server' && pending !== null) unscored.push(pending);
    }
  }
  return { scored, all: [...scored, ...unscored] };
}

function scenarioOf(entry: string): string {
  return entry.split(':', 1)[0] ?? entry;
}

/** What is wrong with the reviewed list itself, before any baseline uses it. */
export function reviewedProblems(reviewed: Reviewed): string[] {
  const problems: string[] = [];
  const named = [
    ...Object.keys(reviewed.fixtureScenarios),
    ...Object.keys(reviewed.fixtureChecks),
    ...Object.keys(reviewed.shouldWarnings),
  ];
  for (const entry of named) {
    if (!ENTRY.test(entry)) problems.push(`${entry} is not a scenario or scenario:check-id`);
    if ((NEVER_EXCUSED as readonly string[]).includes(scenarioOf(entry))) {
      problems.push(`${entry} names ${scenarioOf(entry)}, which no baseline may excuse`);
    }
  }
  for (const entry of Object.keys(reviewed.fixtureScenarios)) {
    if (entry.includes(':'))
      problems.push(`${entry} is a check, listed as a whole fixture scenario`);
  }
  for (const entry of [
    ...Object.keys(reviewed.fixtureChecks),
    ...Object.keys(reviewed.shouldWarnings),
  ]) {
    if (!entry.includes(':')) problems.push(`${entry} is a whole scenario, listed as one check`);
    if (scenarioOf(entry) in reviewed.fixtureScenarios) {
      problems.push(`${entry} is a check of ${scenarioOf(entry)}, which is listed whole`);
    }
  }
  for (const entry of Object.keys(reviewed.fixtureChecks)) {
    if (entry in reviewed.shouldWarnings)
      problems.push(`${entry} is listed both as a fixture check and as a warning`);
  }
  for (const [entry, reason] of Object.entries(reviewed.fixtureScenarios)) {
    if (!/fixture/.test(reason))
      problems.push(`${entry}: its reason names no fixture of the referee's`);
  }
  for (const [entry, reason] of Object.entries(reviewed.fixtureChecks)) {
    if (!/fixture/.test(reason))
      problems.push(`${entry}: its reason names no fixture of the referee's`);
  }
  for (const [entry, reason] of Object.entries(reviewed.shouldWarnings)) {
    if (!reason.startsWith('SHOULD '))
      problems.push(`${entry}: its reason does not start with the SHOULD it excuses`);
  }
  return problems;
}

/** What is wrong with one revision's baseline against the reviewed list and the suite's set. */
export function baselineProblems(
  revision: string,
  entries: readonly string[],
  reviewed: Reviewed,
  scenarios: readonly string[] = requirementScenarios(revision).all,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry)) problems.push(`${revision}: ${entry} is listed twice`);
    seen.add(entry);
    const scenario = scenarioOf(entry);
    if ((NEVER_EXCUSED as readonly string[]).includes(scenario)) {
      problems.push(`${revision}: ${entry} names ${scenario}, which no baseline may excuse`);
      continue;
    }
    if (!scenarios.includes(scenario)) {
      problems.push(`${revision}: ${scenario} is not a server scenario of the ${revision} set`);
    }
    const allowed = entry.includes(':')
      ? entry in reviewed.fixtureChecks || entry in reviewed.shouldWarnings
      : entry in reviewed.fixtureScenarios;
    if (!allowed) {
      problems.push(
        entry.includes(':')
          ? `${revision}: ${entry} is neither a reviewed fixture check nor a reviewed SHOULD-level warning`
          : `${revision}: ${entry} is not a reviewed fixture scenario; a scenario that calls none of the referee's fixtures must pass, its warnings excused one check at a time`,
      );
    }
  }
  for (const entry of entries) {
    if (entry.includes(':') && seen.has(scenarioOf(entry))) {
      problems.push(`${revision}: ${entry} and ${scenarioOf(entry)} are both listed`);
    }
  }
  return problems;
}

/** One check as the suite writes it to checks.json. */
export interface SuiteCheck {
  id: string;
  status: string;
  errorMessage?: string;
}

/** Each scenario's checks from one run's output directory. */
export function readRun(dir: string): Map<string, SuiteCheck[]> {
  const run = new Map<string, SuiteCheck[]>();
  if (!existsSync(dir)) return run;
  for (const name of readdirSync(dir)) {
    const scenario = /^server-(.+)-\d{4}-\d{2}-\d{2}T[\d-]+Z$/.exec(name)?.[1];
    const file = join(dir, name, 'checks.json');
    if (scenario === undefined || !existsSync(file)) continue;
    const checks = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(checks)) continue;
    run.set(
      scenario,
      (checks as Record<string, unknown>[]).map((check) => ({
        id: String(check.id),
        status: String(check.status),
        ...(typeof check.errorMessage === 'string' ? { errorMessage: check.errorMessage } : {}),
      })),
    );
  }
  return run;
}

/** Words a check that failed for want of the referee's fixture says, and nothing else does. */
const FIXTURE_MISSING = /\bnot found\b|Not testable|Method not found|-32601/;

/**
 * What a finished run shows that the suite's exit code does not: that the
 * scenarios no baseline may excuse ran in this set and passed every check, and
 * that each excused check failed for the reason the reviewed list gives.
 */
export function runProblems(
  revision: string,
  run: ReadonlyMap<string, SuiteCheck[]>,
  entries: readonly string[],
  reviewed: Reviewed,
  scenarios: readonly string[] = requirementScenarios(revision).all,
): string[] {
  const problems: string[] = [];
  for (const scenario of NEVER_EXCUSED) {
    if (!scenarios.includes(scenario)) continue;
    const checks = run.get(scenario);
    if (checks === undefined || checks.length === 0) {
      problems.push(`${revision}: ${scenario} did not run`);
      continue;
    }
    const failed = checks.filter((check) => check.status !== 'SUCCESS' && check.status !== 'INFO');
    for (const check of failed)
      problems.push(`${revision}: ${scenario}:${check.id} is ${check.status}`);
    if (!checks.some((check) => check.status === 'SUCCESS')) {
      problems.push(`${revision}: ${scenario} passed no check`);
    }
  }
  for (const entry of entries.filter((one) => one.includes(':'))) {
    const [scenario = '', id = ''] = entry.split(':');
    const check = run.get(scenario)?.find((one) => one.id === id);
    if (check === undefined || check.status === 'SUCCESS' || check.status === 'SKIPPED') continue;
    if (entry in reviewed.shouldWarnings && check.status !== 'WARNING') {
      problems.push(
        `${revision}: ${entry} is excused as a SHOULD-level warning but failed as ${check.status}`,
      );
    }
    if (entry in reviewed.fixtureChecks && !FIXTURE_MISSING.test(check.errorMessage ?? '')) {
      problems.push(`${revision}: ${entry} is excused for a missing fixture but failed otherwise`);
    }
  }
  return problems;
}

// The rules a conformance baseline lives under (ADR 0027 and its Step 3
// review notes), in one place for the test that reads the checked-in files
// (test/conformance-baselines.test.ts) and for the run that reads what the
// suite found (src/conformance.ts).
//
// A baseline may excuse only what reviewed.json names, of four kinds: a whole
// scenario that calls the referee's fixture tools, prompts, resources or
// capabilities; one check that cannot reach the relay at all, which the
// suite itself reports "Not testable" for want of a diagnostic fixture, or
// which needs a method of a capability the relay never declares; one
// SHOULD-level warning; and a whole scenario of an optional extension the
// relay does not offer, which the set runs without scoring. Nothing may name
// dns-rebinding-protection or http-header-validation, which test S12's Host
// and Origin rules and the 2026-07-28 header rules, nor
// server-session-lifecycle, which tests DELETE and the 404 after it, nor any
// scenario's wire-schema-valid check, which tests the relay's own messages
// against the spec's schema. Every other MUST-level check must pass.
//
// The static rules hold the files. The run's rules hold what the files claim
// and what the suite leaves out: under --requirements the suite scores a
// baseline only over the set's scored scenarios, so it never fails on an
// unscored one (http-header-validation, server-session-lifecycle and the
// rest). So after each run every scenario of the set must have run; the
// three named above must have passed every check; every unscored scenario is
// held to its baseline entries by the suite's own rule (a FAILURE or WARNING
// no entry names fails, and so does an entry that now passes); an excused
// warning must have failed as a warning, and an excused untestable check in
// the very words the reviewed list gives; and no wire-schema-valid check may
// fail anywhere, a scenario excused whole included. The suite's
// dns-rebinding-protection probe sends a foreign Host and a foreign Origin in
// one request, so either of the relay's guards alone passes it there, and the
// scenario shows only that both are not lost at once; two more runs of it,
// each through a proxy that leaves one guard to refuse it alone, must pass
// every check too (soleGuardProblems). packages/relay/test/mcp-origin.test.ts
// and hosted.test.ts hold each rule on its own in `pnpm test`.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Scenarios no baseline may name, whole or by check, and that must pass every check wherever their set runs them. */
export const NEVER_EXCUSED = [
  'dns-rebinding-protection',
  'http-header-validation',
  'server-session-lifecycle',
] as const;

/** Checks no baseline may name in any scenario, and that no scenario may fail, one excused whole included. */
export const NEVER_EXCUSED_CHECKS = ['wire-schema-valid'] as const;

/**
 * Methods of the capabilities the relay never declares (its discover and
 * initialize answers declare tools alone), which it answers -32601. A check
 * that needs one cannot reach anything the relay serves.
 */
const UNDECLARED_METHOD = /^(?:prompts|resources|completion|logging)\/[A-Za-z/]+$/;

/** Where the baselines and the reviewed list live. */
export const CONFORMANCE_DIR = fileURLToPath(new URL('../conformance/', import.meta.url));

/** The suite's own frozen requirement sets. */
const REQUIREMENTS_DIR = join(
  dirname(createRequire(import.meta.url).resolve('@modelcontextprotocol/conformance/package.json')),
  'requirements',
);

/** One check that cannot reach the relay, and the words its failure must carry. */
export interface UntestableCheck {
  reason: string;
  /** The suite's words after "Not testable: ", with `untestable` set in its details. */
  notTestable?: string;
  /** A method of a capability the relay does not declare, answered -32601. */
  unknownMethod?: string;
}

export interface Reviewed {
  fixtureScenarios: Record<string, string>;
  untestableChecks: Record<string, UntestableCheck>;
  shouldWarnings: Record<string, string>;
  extensionScenarios: Record<string, string>;
}

/** A server scenario a set runs without scoring it, with the set's own reason. */
export interface UnscoredScenario {
  scenario: string;
  reason: string;
}

export interface RequirementSet {
  scored: readonly string[];
  unscored: readonly UnscoredScenario[];
  /** Every server scenario the set runs, scored or not. */
  all: readonly string[];
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

function isReason(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every(isReason);
}

function isUntestableCheck(value: unknown): value is UntestableCheck {
  if (!isPlainObject(value) || !isReason(value.reason)) return false;
  const keys = Object.keys(value).filter((key) => key !== 'reason');
  return (
    keys.length === 1 &&
    (keys[0] === 'notTestable' || keys[0] === 'unknownMethod') &&
    isReason(value[keys[0]])
  );
}

export function parseReviewed(text: string): Reviewed {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const { fixtureScenarios, untestableChecks, shouldWarnings, extensionScenarios } = parsed;
  if (
    !isStringMap(fixtureScenarios) ||
    !isPlainObject(untestableChecks) ||
    !Object.values(untestableChecks).every(isUntestableCheck) ||
    !isStringMap(shouldWarnings) ||
    !isStringMap(extensionScenarios)
  ) {
    throw new Error(
      'reviewed.json needs fixtureScenarios, shouldWarnings and extensionScenarios, each mapping an entry to its reason, and untestableChecks, each mapping a check to its reason and either notTestable or unknownMethod',
    );
  }
  return {
    fixtureScenarios,
    untestableChecks: untestableChecks as Record<string, UntestableCheck>,
    shouldWarnings,
    extensionScenarios,
  };
}

export function readReviewed(dir: string = CONFORMANCE_DIR): Reviewed {
  return parseReviewed(readFileSync(join(dir, 'reviewed.json'), 'utf8'));
}

export function readBaseline(revision: string, dir: string = CONFORMANCE_DIR): string[] {
  return parseBaseline(readFileSync(join(dir, `${revision}.yaml`), 'utf8'));
}

/**
 * The server scenarios a requirement set runs, read from the suite's own
 * file: its `server:` list, scored, and its `not_scored` server entries, each
 * with the reason the set gives.
 */
export function requirementScenarios(revision: string): RequirementSet {
  const text = readFileSync(join(REQUIREMENTS_DIR, `${revision}.yaml`), 'utf8');
  const scored: string[] = [];
  const unscored: UnscoredScenario[] = [];
  let section = '';
  let pending: { scenario: string; leg: string | null; reason: string | null } | null = null;
  const settle = (): void => {
    if (pending?.leg === 'server') {
      unscored.push({ scenario: pending.scenario, reason: pending.reason ?? '' });
    }
    pending = null;
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    const key = /^([a-z_]+):\s*$/.exec(line);
    if (key?.[1] !== undefined) {
      settle();
      section = key[1];
      continue;
    }
    if (section === 'server') {
      const item = /^ {2}- (\S+)$/.exec(line);
      if (item?.[1] !== undefined) scored.push(item[1]);
    }
    if (section === 'not_scored') {
      const scenario = /^ {2}- scenario: (\S+)$/.exec(line);
      if (scenario?.[1] !== undefined) {
        settle();
        pending = { scenario: scenario[1], leg: null, reason: null };
      }
      const leg = /^ {4}leg: (\S+)$/.exec(line);
      if (leg?.[1] !== undefined && pending !== null) pending.leg = leg[1];
      const reason = /^ {4}reason: (\S+)$/.exec(line);
      if (reason?.[1] !== undefined && pending !== null) pending.reason = reason[1];
    }
  }
  settle();
  return { scored, unscored, all: [...scored, ...unscored.map((one) => one.scenario)] };
}

function scenarioOf(entry: string): string {
  return entry.split(':', 1)[0] ?? entry;
}

function checkOf(entry: string): string | null {
  const at = entry.indexOf(':');
  return at === -1 ? null : entry.slice(at + 1);
}

/** What is wrong with the reviewed list itself, before any baseline uses it. */
export function reviewedProblems(reviewed: Reviewed): string[] {
  const problems: string[] = [];
  const wholes = [
    ...Object.keys(reviewed.fixtureScenarios),
    ...Object.keys(reviewed.extensionScenarios),
  ];
  const checks = [
    ...Object.keys(reviewed.untestableChecks),
    ...Object.keys(reviewed.shouldWarnings),
  ];
  for (const entry of [...wholes, ...checks]) {
    if (!ENTRY.test(entry)) problems.push(`${entry} is not a scenario or scenario:check-id`);
    if ((NEVER_EXCUSED as readonly string[]).includes(scenarioOf(entry))) {
      problems.push(`${entry} names ${scenarioOf(entry)}, which no baseline may excuse`);
    }
    const check = checkOf(entry);
    if (check !== null && (NEVER_EXCUSED_CHECKS as readonly string[]).includes(check)) {
      problems.push(`${entry} names ${check}, which no baseline may excuse`);
    }
  }
  for (const entry of wholes) {
    if (entry.includes(':')) problems.push(`${entry} is a check, listed as a whole scenario`);
  }
  for (const entry of Object.keys(reviewed.fixtureScenarios)) {
    if (entry in reviewed.extensionScenarios) {
      problems.push(`${entry} is listed both as a fixture scenario and as an extension scenario`);
    }
  }
  for (const entry of checks) {
    if (!entry.includes(':')) problems.push(`${entry} is a whole scenario, listed as one check`);
    if (wholes.includes(scenarioOf(entry))) {
      problems.push(`${entry} is a check of ${scenarioOf(entry)}, which is listed whole`);
    }
  }
  for (const entry of Object.keys(reviewed.untestableChecks)) {
    if (entry in reviewed.shouldWarnings)
      problems.push(`${entry} is listed both as an untestable check and as a warning`);
  }
  for (const [entry, reason] of Object.entries(reviewed.fixtureScenarios)) {
    if (!/fixture/.test(reason))
      problems.push(`${entry}: its reason names no fixture of the referee's`);
  }
  for (const [entry, reason] of Object.entries(reviewed.extensionScenarios)) {
    if (!/extension/.test(reason)) problems.push(`${entry}: its reason names no extension`);
  }
  for (const [entry, untestable] of Object.entries(reviewed.untestableChecks)) {
    if (
      untestable.unknownMethod !== undefined &&
      !UNDECLARED_METHOD.test(untestable.unknownMethod)
    ) {
      problems.push(
        `${entry}: ${untestable.unknownMethod} is not a method of a capability the relay never declares`,
      );
    }
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
  set: RequirementSet = requirementScenarios(revision),
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry)) problems.push(`${revision}: ${entry} is listed twice`);
    seen.add(entry);
    const scenario = scenarioOf(entry);
    const check = checkOf(entry);
    if ((NEVER_EXCUSED as readonly string[]).includes(scenario)) {
      problems.push(`${revision}: ${entry} names ${scenario}, which no baseline may excuse`);
      continue;
    }
    if (check !== null && (NEVER_EXCUSED_CHECKS as readonly string[]).includes(check)) {
      problems.push(`${revision}: ${entry} names ${check}, which no baseline may excuse`);
      continue;
    }
    if (!set.all.includes(scenario)) {
      problems.push(`${revision}: ${scenario} is not a server scenario of the ${revision} set`);
    }
    if (check !== null) {
      if (!(entry in reviewed.untestableChecks) && !(entry in reviewed.shouldWarnings)) {
        problems.push(
          `${revision}: ${entry} is neither a reviewed untestable check nor a reviewed SHOULD-level warning`,
        );
      }
      continue;
    }
    if (entry in reviewed.fixtureScenarios) continue;
    if (entry in reviewed.extensionScenarios) {
      const unscored = set.unscored.find((one) => one.scenario === entry);
      if (unscored?.reason !== 'extension') {
        problems.push(
          `${revision}: ${entry} is reviewed as an extension scenario, which the ${revision} set does not leave unscored as an extension`,
        );
      }
      continue;
    }
    problems.push(
      `${revision}: ${entry} is not a reviewed fixture or extension scenario; any other scenario must pass, its warnings and untestable checks excused one at a time`,
    );
  }
  for (const entry of entries) {
    if (entry.includes(':') && seen.has(scenarioOf(entry))) {
      problems.push(`${revision}: ${entry} and ${scenarioOf(entry)} are both listed`);
    }
  }
  return problems;
}

/** One check as the suite writes it to checks.json, with the two details the run reads. */
export interface SuiteCheck {
  id: string;
  status: string;
  errorMessage?: string;
  /** The suite's own mark that the check could not be exercised. */
  untestable?: true;
  /** The JSON-RPC error code the check's details carry. */
  errorCode?: number;
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
      (checks as Record<string, unknown>[]).map((check) => {
        const details = isPlainObject(check.details) ? check.details : {};
        const error = isPlainObject(details.error) ? details.error : {};
        return {
          id: String(check.id),
          status: String(check.status),
          ...(typeof check.errorMessage === 'string' ? { errorMessage: check.errorMessage } : {}),
          ...(details.untestable === true ? { untestable: true as const } : {}),
          ...(typeof error.code === 'number' ? { errorCode: error.code } : {}),
        };
      }),
    );
  }
  return run;
}

/** A status the suite counts against a run: a failure or a warning. */
function failing(check: SuiteCheck): boolean {
  return check.status === 'FAILURE' || check.status === 'WARNING';
}

const RANK: Record<string, number> = { FAILURE: 3, WARNING: 2, SUCCESS: 1 };

/** Each check id once, at its worst status, INFO left out, as the suite scores a scenario. */
function worstById(checks: readonly SuiteCheck[]): Map<string, SuiteCheck> {
  const worst = new Map<string, SuiteCheck>();
  for (const check of checks) {
    if (check.status === 'INFO') continue;
    const known = worst.get(check.id);
    if (known === undefined || (RANK[check.status] ?? 0) >= (RANK[known.status] ?? 0)) {
      worst.set(check.id, check);
    }
  }
  return worst;
}

/** What keeps one scenario from having passed every check: nothing but SUCCESS and INFO, and one SUCCESS at least. */
export function everyCheckProblems(
  label: string,
  scenario: string,
  checks: readonly SuiteCheck[] | undefined,
): string[] {
  if (checks === undefined || checks.length === 0) return [`${label}: ${scenario} did not run`];
  const problems = checks
    .filter((check) => check.status !== 'SUCCESS' && check.status !== 'INFO')
    .map((check) => `${label}: ${scenario}:${check.id} is ${check.status}`);
  if (!checks.some((check) => check.status === 'SUCCESS')) {
    problems.push(`${label}: ${scenario} passed no check`);
  }
  return problems;
}

/** The relay's two rebinding guards, each left alone to refuse the suite's probe in a run of its own. */
export const SOLE_GUARDS = ['origin', 'host'] as const;

/**
 * What keeps a run of dns-rebinding-protection alone, through a proxy that
 * left one guard to refuse its probe (mcp-proxy.ts's soleGuard), from having
 * passed every check. The probe sends a foreign Host and a foreign Origin
 * together, so in the set's own run either guard alone passes it; these runs
 * fail when the guard they leave is lost. Without a public URL a foreign Host
 * meets two refusals, the Host allowlist and the rule that a request was made
 * on this machine, so the Host run fails only when both are lost;
 * mcp-origin.test.ts and hosted.test.ts hold the allowlist alone.
 */
export function soleGuardProblems(
  revision: string,
  guard: (typeof SOLE_GUARDS)[number],
  run: ReadonlyMap<string, SuiteCheck[]>,
): string[] {
  return everyCheckProblems(
    `${revision}, ${guard === 'origin' ? 'the Origin check' : 'the Host checks'} alone`,
    'dns-rebinding-protection',
    run.get('dns-rebinding-protection'),
  );
}

/** Whether a failed check said, in the suite's own words, that it could not reach the relay as reviewed. */
function untestableAsReviewed(check: SuiteCheck, reviewed: UntestableCheck): boolean {
  if (check.status !== 'FAILURE') return false;
  const message = check.errorMessage ?? '';
  if (reviewed.notTestable !== undefined) {
    return check.untestable === true && message.startsWith(`Not testable: ${reviewed.notTestable}`);
  }
  return (
    check.errorCode === -32601 &&
    message === `${reviewed.unknownMethod ?? ''} returned JSON-RPC error -32601: Method not found`
  );
}

/**
 * What a finished run shows that the suite's exit code does not: that every
 * scenario of the set ran; that the scenarios no baseline may excuse passed
 * every check; that each unscored scenario, which the suite never scores,
 * meets its baseline entries by the suite's own rule; that each excused check
 * failed for the reason the reviewed list gives; and that no wire-schema-valid
 * check failed anywhere.
 */
export function runProblems(
  revision: string,
  run: ReadonlyMap<string, SuiteCheck[]>,
  entries: readonly string[],
  reviewed: Reviewed,
  set: RequirementSet = requirementScenarios(revision),
): string[] {
  const problems: string[] = [];
  for (const scenario of set.all) {
    if ((NEVER_EXCUSED as readonly string[]).includes(scenario)) {
      problems.push(...everyCheckProblems(revision, scenario, run.get(scenario)));
      continue;
    }
    const checks = run.get(scenario);
    if (checks === undefined || checks.length === 0) {
      problems.push(`${revision}: ${scenario} did not run`);
      continue;
    }
    for (const check of checks) {
      if ((NEVER_EXCUSED_CHECKS as readonly string[]).includes(check.id) && failing(check)) {
        problems.push(
          `${revision}: ${scenario}:${check.id} is ${check.status}, which no entry may excuse`,
        );
      }
    }
    if (!set.unscored.some((one) => one.scenario === scenario)) continue;
    // The suite's own rule, which it applies only to scored scenarios.
    const worst = worstById(checks);
    if (entries.includes(scenario)) {
      if (![...worst.values()].some(failing)) {
        problems.push(`${revision}: ${scenario} is listed whole but failed no check; it is stale`);
      }
      continue;
    }
    const listed = new Set(
      entries.filter((entry) => scenarioOf(entry) === scenario).map((entry) => checkOf(entry)),
    );
    for (const check of worst.values()) {
      if (failing(check) && !listed.has(check.id)) {
        problems.push(
          `${revision}: ${scenario}:${check.id} is ${check.status}, and no baseline entry excuses it`,
        );
      }
      if (check.status === 'SUCCESS' && listed.has(check.id)) {
        problems.push(`${revision}: ${scenario}:${check.id} now passes; its entry is stale`);
      }
    }
  }
  for (const entry of entries) {
    const scenario = scenarioOf(entry);
    const id = checkOf(entry);
    if (id === null) continue;
    const matching = (run.get(scenario) ?? []).filter((one) => one.id === id && failing(one));
    for (const check of matching) {
      if (entry in reviewed.shouldWarnings && check.status !== 'WARNING') {
        problems.push(
          `${revision}: ${entry} is excused as a SHOULD-level warning but failed as ${check.status}`,
        );
      }
      const untestable = reviewed.untestableChecks[entry];
      if (untestable !== undefined && !untestableAsReviewed(check, untestable)) {
        problems.push(
          `${revision}: ${entry} is excused as untestable against the relay but failed otherwise`,
        );
      }
    }
  }
  return problems;
}

// The conformance baselines of ADR 0027 (A5.2) may excuse only what the
// reviewed list beside them names: whole scenarios that call the referee's
// fixture tools, prompts, resources or capabilities, single checks that need
// one of its diagnostic fixture tools, and single SHOULD-level warnings. No
// baseline and no reviewed entry may name dns-rebinding-protection or
// http-header-validation, which test S12's Host and Origin rules and the
// header checks, and no entry may excuse a MUST-level check of a scenario that
// depends on no fixture: such a scenario is never listed whole, and its checks
// only one at a time from the reviewed list. This file reads the checked-in
// files without running the suite (`pnpm conformance` runs it, in CI too) and
// holds the rules themselves to cases that break each one, including what a
// finished run must show for the reviewed reasons to be true.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  baselineProblems,
  NEVER_EXCUSED,
  parseBaseline,
  parseReviewed,
  readBaseline,
  readReviewed,
  requirementScenarios,
  type Reviewed,
  reviewedProblems,
  runProblems,
  type SuiteCheck,
} from '../src/conformance-baselines.ts';
import { RAISED_LIMITS, REVISIONS } from '../src/conformance.ts';

const reviewed = readReviewed();

describe('the checked-in baselines', () => {
  it('follow the reviewed list, which breaks none of its own rules', () => {
    expect(reviewedProblems(reviewed)).toEqual([]);
    for (const revision of REVISIONS) {
      expect(baselineProblems(revision, readBaseline(revision), reviewed), revision).toEqual([]);
    }
  });

  it('name neither dns-rebinding-protection nor http-header-validation, which both sets run', () => {
    for (const revision of REVISIONS) {
      const named = readBaseline(revision).map((entry) => entry.split(':', 1)[0]);
      for (const scenario of NEVER_EXCUSED) expect(named, revision).not.toContain(scenario);
    }
    expect(requirementScenarios('2025-11-25').scored).toContain('dns-rebinding-protection');
    expect(requirementScenarios('2026-07-28').scored).toContain('dns-rebinding-protection');
    // Run but not scored by the suite in this alpha, so src/conformance.ts holds it itself.
    expect(requirementScenarios('2026-07-28').scored).not.toContain('http-header-validation');
    expect(requirementScenarios('2026-07-28').all).toContain('http-header-validation');
  });

  it('excuse no scenario whole that the relay can pass, and list nothing nobody reviewed', () => {
    const used = new Set(REVISIONS.flatMap((revision) => readBaseline(revision)));
    for (const entry of [
      ...Object.keys(reviewed.fixtureScenarios),
      ...Object.keys(reviewed.fixtureChecks),
      ...Object.keys(reviewed.shouldWarnings),
    ]) {
      expect(used, `${entry} is reviewed but no baseline uses it`).toContain(entry);
    }
    for (const scenario of [
      'server-initialize',
      'ping',
      'tools-list',
      'server-sse-multiple-streams',
      'server-session-lifecycle',
      'server-stateless',
      'caching',
      'sep-2164-resource-not-found',
      'input-required-result-unsupported-methods',
      'input-required-result-validate-input',
      'input-required-result-ignore-extra-params',
      'input-required-result-missing-input-response',
    ]) {
      expect(used, scenario).not.toContain(scenario);
    }
  });

  it('pin the suite exactly, and the run raises the two limits ADR 0027 names and no others', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { devDependencies: Record<string, string>; scripts: Record<string, string> };
    expect(manifest.devDependencies['@modelcontextprotocol/conformance']).toBe('0.2.0-alpha.12');
    expect(manifest.scripts.conformance).toBe('node src/conformance.ts');
    expect(RAISED_LIMITS).toEqual({
      TABDOCK_MAX_SESSIONS_PER_USER: '200',
      TABDOCK_MAX_REQUESTS_PER_USER: '10000',
    });
  });

  it('run in CI, after the tests', () => {
    const workflow = readFileSync(
      new URL('../../../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    )
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    const check = workflow.slice(workflow.indexOf('  check:'), workflow.indexOf('  pack-install:'));
    expect(check).toMatch(/\n\s+- run: pnpm conformance\n/);
    expect(check.indexOf('pnpm conformance')).toBeGreaterThan(check.indexOf('- run: pnpm test\n'));
  });
});

/** A reviewed list for the cases below, with one entry of each kind. */
const SAMPLE: Reviewed = {
  fixtureScenarios: {
    'tools-call-simple-text': "calls the referee's fixture tool test_simple_text",
  },
  fixtureChecks: {
    'server-stateless:sep-2575-missing-capability-http-400':
      "needs the referee's diagnostic fixture tool test_missing_capability",
  },
  shouldWarnings: {
    'sep-2164-resource-not-found:sep-2164-data-uri': 'SHOULD name the missing URI',
  },
};
const SCENARIOS = [
  'tools-call-simple-text',
  'server-stateless',
  'sep-2164-resource-not-found',
  'dns-rebinding-protection',
  'http-header-validation',
];

describe('a baseline', () => {
  const problems = (entries: string[]): string[] =>
    baselineProblems('2026-07-28', entries, SAMPLE, SCENARIOS);

  it('takes the reviewed entries', () => {
    expect(
      problems([
        'tools-call-simple-text',
        'server-stateless:sep-2575-missing-capability-http-400',
        'sep-2164-resource-not-found:sep-2164-data-uri',
      ]),
    ).toEqual([]);
  });

  it('never names dns-rebinding-protection or http-header-validation, whole or by check', () => {
    for (const entry of [
      'dns-rebinding-protection',
      'dns-rebinding-protection:dns-rebinding-host-header',
      'http-header-validation',
      'http-header-validation:sep-2243-version-header',
    ]) {
      expect(problems([entry]), entry).toEqual([
        expect.stringContaining('which no baseline may excuse'),
      ]);
    }
    // Not even when someone reviewed them in.
    const sneaked: Reviewed = {
      ...SAMPLE,
      fixtureScenarios: { ...SAMPLE.fixtureScenarios, 'dns-rebinding-protection': 'a fixture' },
      shouldWarnings: { ...SAMPLE.shouldWarnings, 'http-header-validation:x': 'SHOULD x' },
    };
    expect(
      baselineProblems(
        '2026-07-28',
        ['dns-rebinding-protection', 'http-header-validation:x'],
        sneaked,
        SCENARIOS,
      ),
    ).toHaveLength(2);
  });

  it('excuses no MUST: no scenario whole that is not a reviewed fixture scenario, no check that is not reviewed', () => {
    expect(problems(['server-stateless'])).toEqual([
      expect.stringContaining('is not a reviewed fixture scenario'),
    ]);
    expect(problems(['server-stateless:sep-2575-server-unsupported-version-error'])).toEqual([
      expect.stringContaining(
        'neither a reviewed fixture check nor a reviewed SHOULD-level warning',
      ),
    ]);
  });

  it('names only scenarios of its own set, each once, and never a scenario both whole and by check', () => {
    expect(problems(['tools-call-sampling'])).toContainEqual(
      expect.stringContaining('is not a server scenario of the 2026-07-28 set'),
    );
    expect(problems(['tools-call-simple-text', 'tools-call-simple-text'])).toContainEqual(
      expect.stringContaining('listed twice'),
    );
    expect(
      problems(['tools-call-simple-text', 'tools-call-simple-text:tools-call-simple-text']),
    ).toContainEqual(expect.stringContaining('are both listed'));
  });

  it('is read only in the plain shape the suite reads as a list of strings', () => {
    expect(parseBaseline('# why\nserver:\n  - a-b\n  - c:d-e # why too\n')).toEqual([
      'a-b',
      'c:d-e',
    ]);
    for (const text of [
      'server:\n  - a: b\n',
      'server:\n  - a:\n',
      'client:\n  - a\n',
      'server:\n  - a\nclient:\n  - b\n',
      'server:\n\t- a\n',
      'server:\n    - a\n',
      'server: [a]\n',
      '  - a\n',
      'server:\n  - A\n',
      'server:\n  - a\nserver:\n  - b\n',
    ]) {
      expect(() => parseBaseline(text), JSON.stringify(text)).toThrow();
    }
  });
});

describe('the reviewed list', () => {
  it('names no scenario no baseline may excuse, lists checks only as checks, and says why each one may go', () => {
    const broken: Reviewed = {
      fixtureScenarios: {
        'dns-rebinding-protection': "the referee's fixture",
        'caching:sep-2549-prompts-list-caching-hints': "the referee's fixture prompts",
        'tools-list': 'the relay lists its own tools',
      },
      fixtureChecks: {
        'http-header-validation:sep-2243-x': "the referee's fixture",
        'server-stateless': "the referee's fixture",
        'tools-list:some-check': 'the relay answers it itself',
      },
      shouldWarnings: { 'server-stateless:sep-2575-server-unsupported-version-error': 'MUST list' },
    };
    const found = reviewedProblems(broken);
    expect(found).toEqual(
      expect.arrayContaining([
        'dns-rebinding-protection names dns-rebinding-protection, which no baseline may excuse',
        'http-header-validation:sep-2243-x names http-header-validation, which no baseline may excuse',
        'caching:sep-2549-prompts-list-caching-hints is a check, listed as a whole fixture scenario',
        'server-stateless is a whole scenario, listed as one check',
        "tools-list: its reason names no fixture of the referee's",
        "tools-list:some-check: its reason names no fixture of the referee's",
        'server-stateless:sep-2575-server-unsupported-version-error: its reason does not start with the SHOULD it excuses',
      ]),
    );
  });

  it('parses only with all three kinds, each entry with a reason', () => {
    expect(() => parseReviewed('{"fixtureScenarios":{},"fixtureChecks":{}}')).toThrow();
    expect(() =>
      parseReviewed('{"fixtureScenarios":{"a":""},"fixtureChecks":{},"shouldWarnings":{}}'),
    ).toThrow();
  });
});

describe('a finished run', () => {
  const good = (): Map<string, SuiteCheck[]> =>
    new Map([
      [
        'dns-rebinding-protection',
        [
          { id: 'host', status: 'SUCCESS' },
          { id: 'origin', status: 'SUCCESS' },
        ],
      ],
      ['http-header-validation', [{ id: 'version-header', status: 'SUCCESS' }]],
      [
        'server-stateless',
        [
          { id: 'sep-2575-server-implements-discover', status: 'SUCCESS' },
          {
            id: 'sep-2575-missing-capability-http-400',
            status: 'FAILURE',
            errorMessage:
              "Not testable: server does not list the diagnostic tool 'test_missing_capability'",
          },
        ],
      ],
      [
        'sep-2164-resource-not-found',
        [
          {
            id: 'sep-2164-data-uri',
            status: 'WARNING',
            errorMessage: 'Error data.uri is undefined',
          },
        ],
      ],
    ]);
  const entries = [
    'server-stateless:sep-2575-missing-capability-http-400',
    'sep-2164-resource-not-found:sep-2164-data-uri',
  ];
  const problems = (run: Map<string, SuiteCheck[]>): string[] =>
    runProblems('2026-07-28', run, entries, SAMPLE, SCENARIOS);

  it('shows nothing wrong when every excused check failed for its reviewed reason', () => {
    expect(problems(good())).toEqual([]);
  });

  it('fails when dns-rebinding-protection or http-header-validation missed a check or did not run', () => {
    for (const scenario of NEVER_EXCUSED) {
      for (const status of ['FAILURE', 'WARNING', 'SKIPPED']) {
        const run = good();
        run.set(scenario, [...(run.get(scenario) ?? []), { id: 'one', status }]);
        expect(problems(run), `${scenario} ${status}`).toEqual([
          `2026-07-28: ${scenario}:one is ${status}`,
        ]);
      }
      const gone = good();
      gone.delete(scenario);
      expect(problems(gone)).toEqual([`2026-07-28: ${scenario} did not run`]);
    }
  });

  it('fails when a check excused as a SHOULD-level warning failed as a MUST', () => {
    const run = good();
    run.set('sep-2164-resource-not-found', [{ id: 'sep-2164-data-uri', status: 'FAILURE' }]);
    expect(problems(run)).toEqual([
      '2026-07-28: sep-2164-resource-not-found:sep-2164-data-uri is excused as a SHOULD-level warning but failed as FAILURE',
    ]);
  });

  it('fails when a check excused for a missing fixture failed for another reason', () => {
    const run = good();
    run.set('server-stateless', [
      {
        id: 'sep-2575-missing-capability-http-400',
        status: 'FAILURE',
        errorMessage: 'Expected HTTP 400, got 200',
      },
    ]);
    expect(problems(run)).toEqual([
      '2026-07-28: server-stateless:sep-2575-missing-capability-http-400 is excused for a missing fixture but failed otherwise',
    ]);
  });
});

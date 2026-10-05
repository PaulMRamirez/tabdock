// The conformance baselines of ADR 0027 (A5.2) and its Step 3 review notes
// may excuse only what the reviewed list beside them names, of four kinds:
// whole scenarios that call the referee's fixture tools, prompts, resources
// or capabilities; single checks that cannot reach the relay, which the suite
// reports "Not testable" for want of a tool the relay does not serve or which
// need a method of a capability the relay never declares; single SHOULD-level
// warnings; and whole scenarios of an optional extension the relay does not
// offer, where the set runs them unscored as an extension. No baseline and no
// reviewed entry may name dns-rebinding-protection, http-header-validation or
// server-session-lifecycle, nor any scenario's wire-schema-valid check, and
// every other MUST-level check must pass. This file reads the checked-in
// files without running the suite (`pnpm conformance` runs it, in CI too)
// and holds the rules themselves to cases that break each one, including
// what a finished run must show: the suite scores only the set's scored
// scenarios, so the run holds the unscored ones itself, and an excused check
// must have failed in the very words the reviewed list gives.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  baselineProblems,
  NEVER_EXCUSED,
  parseBaseline,
  parseReviewed,
  readBaseline,
  readReviewed,
  type RequirementSet,
  requirementScenarios,
  type Reviewed,
  reviewedProblems,
  runProblems,
  soleGuardProblems,
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

  it('name none of the scenarios no baseline may excuse, which the sets run', () => {
    for (const revision of REVISIONS) {
      const named = readBaseline(revision).map((entry) => entry.split(':', 1)[0]);
      for (const scenario of NEVER_EXCUSED) expect(named, revision).not.toContain(scenario);
      expect(readBaseline(revision).some((entry) => entry.endsWith(':wire-schema-valid'))).toBe(
        false,
      );
    }
    expect(requirementScenarios('2025-11-25').scored).toContain('dns-rebinding-protection');
    expect(requirementScenarios('2026-07-28').scored).toContain('dns-rebinding-protection');
    // Run but not scored by the suite in this alpha, so src/conformance.ts holds them itself.
    expect(requirementScenarios('2026-07-28').unscored).toContainEqual({
      scenario: 'http-header-validation',
      reason: 'pending',
    });
    expect(requirementScenarios('2025-11-25').unscored).toContainEqual({
      scenario: 'server-session-lifecycle',
      reason: 'added-after-release',
    });
    // Every extension scenario the 2026-07-28 baseline excuses, the set runs unscored as one.
    const extensions = requirementScenarios('2026-07-28')
      .unscored.filter((one) => one.reason === 'extension')
      .map((one) => one.scenario);
    for (const entry of Object.keys(reviewed.extensionScenarios)) {
      expect(extensions, entry).toContain(entry);
    }
  });

  it('excuse no scenario whole that the relay can pass, and list nothing nobody reviewed', () => {
    const used = new Set(REVISIONS.flatMap((revision) => readBaseline(revision)));
    for (const entry of [
      ...Object.keys(reviewed.fixtureScenarios),
      ...Object.keys(reviewed.untestableChecks),
      ...Object.keys(reviewed.shouldWarnings),
      ...Object.keys(reviewed.extensionScenarios),
    ]) {
      expect(used, `${entry} is reviewed but no baseline uses it`).toContain(entry);
    }
    for (const scenario of [
      'server-initialize',
      'ping',
      'tools-list',
      'server-sse-multiple-streams',
      'server-sse-polling',
      'server-stateless',
      'caching',
      'http-custom-header-server-validation',
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

const MISSING_CAPABILITY = "server does not list the diagnostic tool 'test_missing_capability'";

/** A reviewed list for the cases below, with entries of each kind. */
const SAMPLE: Reviewed = {
  fixtureScenarios: {
    'tools-call-simple-text': "calls the referee's fixture tool test_simple_text",
    'json-schema-2020-12': "calls the referee's fixture tool json_schema_2020_12_tool",
  },
  untestableChecks: {
    'server-stateless:sep-2575-missing-capability-http-400': {
      reason: "needs the referee's diagnostic fixture tool test_missing_capability",
      notTestable: MISSING_CAPABILITY,
    },
    'caching:sep-2549-prompts-list-caching-hints': {
      reason: 'lists prompts; the relay serves none',
      unknownMethod: 'prompts/list',
    },
  },
  shouldWarnings: {
    'sep-2164-resource-not-found:sep-2164-data-uri': 'SHOULD name the missing URI',
    'server-sse-polling:server-sse-priming-event': 'SHOULD prime the stream',
  },
  extensionScenarios: {
    'tasks-lifecycle': 'a scenario of the tasks extension, which the relay does not offer',
  },
};

function setOf(scored: string[], unscored: [string, string][]): RequirementSet {
  return {
    scored,
    unscored: unscored.map(([scenario, reason]) => ({ scenario, reason })),
    all: [...scored, ...unscored.map(([scenario]) => scenario)],
  };
}

const SET = setOf(
  [
    'tools-call-simple-text',
    'server-stateless',
    'caching',
    'sep-2164-resource-not-found',
    'dns-rebinding-protection',
  ],
  [
    ['http-header-validation', 'pending'],
    ['server-session-lifecycle', 'added-after-release'],
    ['json-schema-2020-12', 'pending'],
    ['server-sse-polling', 'pending'],
    ['tasks-lifecycle', 'extension'],
  ],
);

describe('a baseline', () => {
  const problems = (entries: string[], set: RequirementSet = SET): string[] =>
    baselineProblems('2026-07-28', entries, SAMPLE, set);

  it('takes the reviewed entries', () => {
    expect(
      problems([
        'tools-call-simple-text',
        'json-schema-2020-12',
        'tasks-lifecycle',
        'server-stateless:sep-2575-missing-capability-http-400',
        'caching:sep-2549-prompts-list-caching-hints',
        'sep-2164-resource-not-found:sep-2164-data-uri',
        'server-sse-polling:server-sse-priming-event',
      ]),
    ).toEqual([]);
  });

  it('never names dns-rebinding-protection, http-header-validation or server-session-lifecycle, whole or by check', () => {
    for (const entry of [
      'dns-rebinding-protection',
      'dns-rebinding-protection:localhost-host-rebinding-rejected',
      'http-header-validation',
      'http-header-validation:sep-2243-version-header',
      'server-session-lifecycle',
      'server-session-lifecycle:server-session-terminated-returns-404',
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
      extensionScenarios: { 'server-session-lifecycle': 'an extension' },
    };
    expect(
      baselineProblems(
        '2026-07-28',
        ['dns-rebinding-protection', 'http-header-validation:x', 'server-session-lifecycle'],
        sneaked,
        SET,
      ),
    ).toHaveLength(3);
  });

  it("never names a scenario's wire-schema-valid check, even one reviewed in", () => {
    const sneaked: Reviewed = {
      ...SAMPLE,
      untestableChecks: {
        ...SAMPLE.untestableChecks,
        'server-stateless:wire-schema-valid': { reason: 'x', notTestable: 'x' },
      },
    };
    expect(
      baselineProblems('2026-07-28', ['server-stateless:wire-schema-valid'], sneaked, SET),
    ).toEqual([expect.stringContaining('wire-schema-valid, which no baseline may excuse')]);
  });

  it('excuses no other MUST: no scenario whole that is not a reviewed fixture or extension scenario, no check that is not reviewed', () => {
    expect(problems(['server-stateless'])).toEqual([
      expect.stringContaining('is not a reviewed fixture or extension scenario'),
    ]);
    expect(problems(['server-stateless:sep-2575-server-unsupported-version-error'])).toEqual([
      expect.stringContaining(
        'neither a reviewed untestable check nor a reviewed SHOULD-level warning',
      ),
    ]);
  });

  it('excuses an extension scenario only where the set runs it unscored as an extension', () => {
    const scored = setOf([...SET.scored, 'tasks-lifecycle'], []);
    const pending = setOf(SET.scored as string[], [['tasks-lifecycle', 'pending']]);
    for (const set of [scored, pending]) {
      expect(problems(['tasks-lifecycle'], set)).toEqual([
        expect.stringContaining('does not leave unscored as an extension'),
      ]);
    }
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
  it('names nothing no baseline may excuse, lists checks only as checks, and says why each one may go', () => {
    const broken: Reviewed = {
      fixtureScenarios: {
        'dns-rebinding-protection': "the referee's fixture",
        'caching:sep-2549-prompts-list-caching-hints': "the referee's fixture prompts",
        'tools-list': 'the relay lists its own tools',
        'tasks-lifecycle': "the referee's fixture",
      },
      untestableChecks: {
        'http-header-validation:sep-2243-x': { reason: 'x', notTestable: 'x' },
        'server-stateless': { reason: 'x', notTestable: 'x' },
        'caching:sep-2549-tools-list-caching-hints': { reason: 'x', unknownMethod: 'tools/list' },
        'tools-call-simple-text:wire-schema-valid': { reason: 'x', notTestable: 'x' },
      },
      shouldWarnings: {
        'server-stateless:sep-2575-server-unsupported-version-error': 'MUST list',
        'server-session-lifecycle:server-session-delete-accepted': 'SHOULD accept',
      },
      extensionScenarios: {
        'tasks-lifecycle': 'tasks',
      },
    };
    expect(reviewedProblems(broken)).toEqual(
      expect.arrayContaining([
        'dns-rebinding-protection names dns-rebinding-protection, which no baseline may excuse',
        'http-header-validation:sep-2243-x names http-header-validation, which no baseline may excuse',
        'server-session-lifecycle:server-session-delete-accepted names server-session-lifecycle, which no baseline may excuse',
        'tools-call-simple-text:wire-schema-valid names wire-schema-valid, which no baseline may excuse',
        'caching:sep-2549-prompts-list-caching-hints is a check, listed as a whole scenario',
        'server-stateless is a whole scenario, listed as one check',
        'tasks-lifecycle is listed both as a fixture scenario and as an extension scenario',
        "tools-list: its reason names no fixture of the referee's",
        'tasks-lifecycle: its reason names no extension',
        'caching:sep-2549-tools-list-caching-hints: tools/list is not a method of a capability the relay never declares',
        'server-stateless:sep-2575-server-unsupported-version-error: its reason does not start with the SHOULD it excuses',
      ]),
    );
  });

  it('parses only with all four kinds, each entry with a reason, and each untestable check with one form of words', () => {
    const kinds = {
      fixtureScenarios: {},
      untestableChecks: {},
      shouldWarnings: {},
      extensionScenarios: {},
    };
    expect(parseReviewed(JSON.stringify(kinds))).toEqual(kinds);
    expect(() =>
      parseReviewed('{"fixtureScenarios":{},"untestableChecks":{},"shouldWarnings":{}}'),
    ).toThrow();
    expect(() =>
      parseReviewed(JSON.stringify({ ...kinds, fixtureScenarios: { a: '' } })),
    ).toThrow();
    for (const untestable of [
      'needs a fixture',
      { reason: 'x' },
      { reason: 'x', notTestable: 'y', unknownMethod: 'prompts/list' },
      { reason: 'x', notTestable: '' },
      { reason: '', notTestable: 'y' },
      { reason: 'x', notTestable: 'y', because: 'z' },
    ]) {
      expect(
        () => parseReviewed(JSON.stringify({ ...kinds, untestableChecks: { 'a:b': untestable } })),
        JSON.stringify(untestable),
      ).toThrow();
    }
  });
});

describe('a finished run', () => {
  const good = (): Map<string, SuiteCheck[]> =>
    new Map<string, SuiteCheck[]>([
      [
        'dns-rebinding-protection',
        [
          { id: 'host', status: 'SUCCESS' },
          { id: 'origin', status: 'SUCCESS' },
        ],
      ],
      ['http-header-validation', [{ id: 'version-header', status: 'SUCCESS' }]],
      [
        'server-session-lifecycle',
        [
          { id: 'server-session-delete-accepted', status: 'SUCCESS' },
          { id: 'server-session-terminated-returns-404', status: 'SUCCESS' },
        ],
      ],
      [
        'tools-call-simple-text',
        [
          { id: 'tools-call-simple-text', status: 'FAILURE', errorMessage: 'Tool not found' },
          { id: 'wire-schema-valid', status: 'SUCCESS' },
        ],
      ],
      [
        'server-stateless',
        [
          { id: 'sep-2575-server-implements-discover', status: 'SUCCESS' },
          {
            id: 'sep-2575-missing-capability-http-400',
            status: 'FAILURE',
            errorMessage: `Not testable: ${MISSING_CAPABILITY} in tools/list, so the -32021 HTTP status could not be validated`,
            untestable: true,
          },
        ],
      ],
      [
        'caching',
        [
          { id: 'sep-2549-tools-list-caching-hints', status: 'SUCCESS' },
          {
            id: 'sep-2549-prompts-list-caching-hints',
            status: 'FAILURE',
            errorMessage: 'prompts/list returned JSON-RPC error -32601: Method not found',
            errorCode: -32601,
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
      [
        'json-schema-2020-12',
        [
          { id: 'json-schema-2020-12-tool-found', status: 'FAILURE' },
          { id: 'wire-schema-valid', status: 'SUCCESS' },
        ],
      ],
      [
        'server-sse-polling',
        [
          { id: 'outgoing-request', status: 'INFO' },
          { id: 'server-sse-priming-event', status: 'WARNING' },
          { id: 'server-sse-disconnect-resume', status: 'INFO' },
        ],
      ],
      [
        'tasks-lifecycle',
        [
          { id: 'tasks-sync-tool-call', status: 'FAILURE' },
          { id: 'wire-schema-valid', status: 'SUCCESS' },
        ],
      ],
    ]);
  const entries = [
    'tools-call-simple-text',
    'json-schema-2020-12',
    'tasks-lifecycle',
    'server-stateless:sep-2575-missing-capability-http-400',
    'caching:sep-2549-prompts-list-caching-hints',
    'sep-2164-resource-not-found:sep-2164-data-uri',
    'server-sse-polling:server-sse-priming-event',
  ];
  const problems = (run: Map<string, SuiteCheck[]>, listed: string[] = entries): string[] =>
    runProblems('2026-07-28', run, listed, SAMPLE, SET);
  const replace = (scenario: string, checks: SuiteCheck[]): Map<string, SuiteCheck[]> => {
    const run = good();
    run.set(scenario, checks);
    return run;
  };

  it('shows nothing wrong when every excused check failed for its reviewed reason', () => {
    expect(problems(good())).toEqual([]);
  });

  it('fails when a scenario of the set did not run', () => {
    const run = good();
    run.delete('caching');
    expect(problems(run)).toEqual(['2026-07-28: caching did not run']);
  });

  it('fails when a scenario no baseline may excuse missed a check or did not run, scored or not', () => {
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

  it('fails when a terminated session answers 200, which the suite leaves unscored in 2025-11-25', () => {
    const run = replace('server-session-lifecycle', [
      { id: 'server-session-delete-accepted', status: 'SUCCESS' },
      {
        id: 'server-session-terminated-returns-404',
        status: 'FAILURE',
        errorMessage: 'Expected 404 on terminated session ID, got 200',
      },
    ]);
    expect(problems(run)).toEqual([
      '2026-07-28: server-session-lifecycle:server-session-terminated-returns-404 is FAILURE',
    ]);
  });

  it('holds an unscored scenario to its entries as the suite holds a scored one', () => {
    // A failure or warning no entry names.
    expect(
      problems(
        replace('server-sse-polling', [
          { id: 'server-sse-priming-event', status: 'WARNING' },
          { id: 'server-sse-retry-field', status: 'WARNING' },
        ]),
      ),
    ).toEqual([
      '2026-07-28: server-sse-polling:server-sse-retry-field is WARNING, and no baseline entry excuses it',
    ]);
    // The same check twice is scored at its worst, as the suite scores it.
    expect(
      problems(
        replace('server-sse-polling', [
          { id: 'server-sse-retry-field', status: 'SUCCESS' },
          { id: 'server-sse-retry-field', status: 'FAILURE' },
          { id: 'server-sse-priming-event', status: 'WARNING' },
        ]),
      ),
    ).toEqual([
      '2026-07-28: server-sse-polling:server-sse-retry-field is FAILURE, and no baseline entry excuses it',
    ]);
    // An unscored scenario with no entry at all.
    expect(
      problems(
        good(),
        entries.filter((entry) => entry !== 'tasks-lifecycle'),
      ),
    ).toEqual([
      '2026-07-28: tasks-lifecycle:tasks-sync-tool-call is FAILURE, and no baseline entry excuses it',
    ]);
    // An entry that now passes is stale, whole or by check.
    expect(
      problems(
        replace('server-sse-polling', [{ id: 'server-sse-priming-event', status: 'SUCCESS' }]),
      ),
    ).toEqual([
      '2026-07-28: server-sse-polling:server-sse-priming-event now passes; its entry is stale',
    ]);
    expect(
      problems(
        replace('json-schema-2020-12', [
          { id: 'json-schema-2020-12-tool-found', status: 'SUCCESS' },
          { id: 'wire-schema-valid', status: 'SUCCESS' },
        ]),
      ),
    ).toEqual(['2026-07-28: json-schema-2020-12 is listed whole but failed no check; it is stale']);
  });

  it('fails when a check excused as a SHOULD-level warning failed as a MUST', () => {
    const run = replace('sep-2164-resource-not-found', [
      { id: 'sep-2164-data-uri', status: 'FAILURE' },
    ]);
    expect(problems(run)).toEqual([
      '2026-07-28: sep-2164-resource-not-found:sep-2164-data-uri is excused as a SHOULD-level warning but failed as FAILURE',
    ]);
  });

  it('fails when a check excused as untestable failed in any other words than the reviewed ones', () => {
    /** The untestable check as the suite wrote it, changed; `marked` false leaves out the suite's untestable mark. */
    const stateless = (change: Partial<SuiteCheck>, marked = true): Map<string, SuiteCheck[]> => {
      const check: SuiteCheck = {
        id: 'sep-2575-missing-capability-http-400',
        status: 'FAILURE',
        errorMessage: `Not testable: ${MISSING_CAPABILITY} in tools/list`,
        ...change,
      };
      return replace('server-stateless', [marked ? { ...check, untestable: true } : check]);
    };
    /** The check that needs prompts/list as the suite wrote it, changed; `coded` false leaves out the -32601 code. */
    const caching = (change: Partial<SuiteCheck>, coded = true): Map<string, SuiteCheck[]> => {
      const check: SuiteCheck = {
        id: 'sep-2549-prompts-list-caching-hints',
        status: 'FAILURE',
        errorMessage: 'prompts/list returned JSON-RPC error -32601: Method not found',
        ...change,
      };
      return replace('caching', [coded ? { errorCode: -32601, ...check } : check]);
    };
    const untestableFailed = (entry: string): string[] => [
      `2026-07-28: ${entry} is excused as untestable against the relay but failed otherwise`,
    ];
    for (const run of [
      // A real failure of the relay.
      stateless({ errorMessage: 'Expected HTTP 400, got 200' }, false),
      // The suite's words, but not its mark.
      stateless({}, false),
      // Untestable for want of another tool than the reviewed one.
      stateless({
        errorMessage: "Not testable: server does not list the diagnostic tool 'test_other'",
      }),
      // A warning, not the suite's untestable failure.
      stateless({ status: 'WARNING' }),
    ]) {
      expect(problems(run)).toEqual(
        untestableFailed('server-stateless:sep-2575-missing-capability-http-400'),
      );
    }
    for (const run of [
      // Any "not found" once passed the old guard.
      caching({ errorMessage: 'Tool not found' }, false),
      caching({ errorCode: -32602 }),
      caching({ errorMessage: 'resources/list returned JSON-RPC error -32601: Method not found' }),
    ]) {
      expect(problems(run)).toEqual(
        untestableFailed('caching:sep-2549-prompts-list-caching-hints'),
      );
    }
  });

  it('fails when a wire-schema-valid check failed, in a scenario excused whole too', () => {
    for (const scenario of ['tools-call-simple-text', 'tasks-lifecycle', 'json-schema-2020-12']) {
      const run = good();
      run.set(
        scenario,
        (run.get(scenario) ?? []).map((check) =>
          check.id === 'wire-schema-valid' ? { ...check, status: 'FAILURE' } : check,
        ),
      );
      expect(problems(run), scenario).toEqual([
        `2026-07-28: ${scenario}:wire-schema-valid is FAILURE, which no entry may excuse`,
      ]);
    }
  });
});

describe('a run of dns-rebinding-protection with one guard left alone', () => {
  it('passes only when every check passed', () => {
    const passed = new Map([
      [
        'dns-rebinding-protection',
        [
          { id: 'localhost-host-rebinding-rejected', status: 'SUCCESS' },
          { id: 'localhost-host-valid-accepted', status: 'SUCCESS' },
        ],
      ],
    ]);
    expect(soleGuardProblems('2025-11-25', 'origin', passed)).toEqual([]);
    const lost = new Map([
      [
        'dns-rebinding-protection',
        [
          { id: 'localhost-host-rebinding-rejected', status: 'FAILURE' },
          { id: 'localhost-host-valid-accepted', status: 'SUCCESS' },
        ],
      ],
    ]);
    expect(soleGuardProblems('2025-11-25', 'origin', lost)).toEqual([
      '2025-11-25, the Origin check alone: dns-rebinding-protection:localhost-host-rebinding-rejected is FAILURE',
    ]);
    expect(soleGuardProblems('2026-07-28', 'host', new Map())).toEqual([
      '2026-07-28, the Host checks alone: dns-rebinding-protection did not run',
    ]);
  });
});

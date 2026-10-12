// Counts the docs state in words, held to what the code counts (the docs
// pass after M6). A count written as a number goes stale silently when the
// list behind it grows: the concepts page, the threat model and two READMEs
// once said five fixed tools, sixteen profile tools or 13 codes after M6
// moved each. So, across the guide, the READMEs (root, package, app and
// test), SPEC.md, the threat model and the CHANGELOG's Unreleased section:
// a number before "fixed tools" is FIXED_TOOL_NAMES' size, unless a
// milestone before M6 or 0.1.0 owns the list ("M4's five fixed tools") or the
// paragraph is a milestone's own (SPEC's "**M1 ...**"); "the profile's N"
// (tools or not) and "N profile tools" are MAP_TOOL_NAMES' length, the map
// page's own header included; "the N codes" in the protocol's README is
// ERROR_CODES' length; "N WebMCP tools" in the demo board's README counts the
// board's tools; and "N handle members" counts Dock's members ("N new handle
// members" those past 0.1.0's twelve, which doc-changelog.test.ts pins by
// name).

import { ERROR_CODES } from '@tabdock/protocol';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TOOL_FACTORIES } from '../../../apps/demo/src/tools.ts';
import { MAP_TOOL_NAMES } from '../../../packages/sim-page/src/map/profile.ts';
import { FIXED_TOOL_NAMES } from '../../../packages/relay/src/mcp.ts';
import { markdownIn, packageReadmes, readRepo } from '../src/doc-files.ts';

/** The control handle's member count in 0.1.0 (doc-changelog.test.ts names them). */
const HANDLE_0_1_0_MEMBERS = 12;

const NUMBERS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  'twenty-four': 24,
};

/** A count written in words or digits, or null for any other word. */
function numberOf(word: string): number | null {
  const lower = word.toLowerCase();
  if (/^\d+$/.test(lower)) return Number(lower);
  return NUMBERS[lower] ?? null;
}

/** The docs the counts are read in, each with the text that counts. */
function countedDocs(): { path: string; text: string }[] {
  const changelog = readRepo('CHANGELOG.md');
  const unreleased = /^## Unreleased\b[\s\S]*?(?=^## )/m.exec(changelog)?.[0] ?? '';
  return [
    ...markdownIn('docs/guide'),
    'README.md',
    ...packageReadmes(),
    'SPEC.md',
    'docs/threat-model.md',
  ]
    .map((path) => ({ path, text: readRepo(path) }))
    .concat([{ path: 'CHANGELOG.md (Unreleased)', text: unreleased }]);
}

/** The line of `index` in `text`. */
function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** The paragraph `index` falls in, from its start. */
function paragraphStart(text: string, index: number): string {
  const start = text.lastIndexOf('\n\n', index);
  return text.slice(start < 0 ? 0 : start + 2, index);
}

interface Rule {
  readonly what: string;
  readonly pattern: RegExp;
  readonly expected: number;
  /** Whether a match stands for history, so any number is right there. */
  readonly past?: (text: string, index: number) => boolean;
}

/**
 * A count of an earlier list: one a milestone before M6 or 0.1.0 owns ("M4's
 * five"), or one in a milestone's own paragraph. A milestone named elsewhere in
 * the sentence ("Since M4 the relay serves five") excuses nothing.
 */
function earlierList(text: string, index: number): boolean {
  if (/(?:\bM[0-5]|\b0\.1\.0)'s\s+$/.test(text.slice(Math.max(0, index - 12), index))) return true;
  return /^\*\*M[0-5]\b/.test(paragraphStart(text, index));
}

/** Each stated count that differs from its rule's. */
function wrongCounts(path: string, text: string, rules: readonly Rule[]): string[] {
  return rules.flatMap((rule) =>
    [...text.matchAll(rule.pattern)].flatMap((match) => {
      const stated = numberOf(match[1] ?? '');
      if (stated === null || stated === rule.expected) return [];
      if (rule.past?.(text, match.index) === true) return [];
      return [
        `${path}:${String(lineAt(text, match.index))}: "${match[0]}" where ${rule.what} is ${String(rule.expected)}`,
      ];
    }),
  );
}

/** The members the Dock interface declares. */
function dockMembers(): string[] {
  const path = 'packages/adapter/src/core.ts';
  const source = ts.createSourceFile(path, readRepo(path), ts.ScriptTarget.Latest, true);
  const dock = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === 'Dock',
  );
  if (dock === undefined) throw new Error(`${path} declares no Dock`);
  return dock.members.flatMap((member) =>
    member.name !== undefined && ts.isIdentifier(member.name) ? [member.name.text] : [],
  );
}

const WORD = '([A-Za-z]+(?:-[a-z]+)?|\\d+)';
/** Emphasis a count may sit outside of, as in "nine **fixed tools**". */
const MARK = '(?:\\*{1,2}|_{1,2})?';
const members = dockMembers().length;
const FIXED_RULE: Rule = {
  what: 'FIXED_TOOL_NAMES.size',
  pattern: new RegExp(`\\b${WORD} ${MARK}fixed tools\\b`, 'g'),
  expected: FIXED_TOOL_NAMES.size,
  past: earlierList,
};
const PROFILE_RULES: readonly Rule[] = [
  `\\bprofile's ${WORD}\\b`,
  `\\b${WORD} ${MARK}profile tools\\b`,
].map((source) => ({
  what: 'MAP_TOOL_NAMES.length',
  pattern: new RegExp(source, 'g'),
  expected: MAP_TOOL_NAMES.length,
}));
const HANDLE_RULES: readonly Rule[] = [
  {
    what: "Dock's member count",
    pattern: new RegExp(`\\b${WORD} ${MARK}handle members\\b`, 'g'),
    expected: members,
  },
  {
    what: "Dock's members past 0.1.0",
    pattern: new RegExp(`\\b${WORD} ${MARK}new handle members\\b`, 'g'),
    expected: members - HANDLE_0_1_0_MEMBERS,
  },
];
const ALL_RULES: readonly Rule[] = [FIXED_RULE, ...PROFILE_RULES, ...HANDLE_RULES];

describe('counts the docs state', () => {
  it('read the lists they count from the code', () => {
    expect(FIXED_TOOL_NAMES.size).toBe(9);
    expect(MAP_TOOL_NAMES.length).toBe(14);
    expect(members).toBeGreaterThan(HANDLE_0_1_0_MEMBERS);
  });

  it('match the fixed tools, the profile and the handle across the docs', () => {
    const docs = countedDocs();
    expect(docs.length).toBeGreaterThan(30);
    expect(docs.flatMap(({ path, text }) => wrongCounts(path, text, ALL_RULES))).toEqual([]);
  });

  it("match the profile's tools in the map page's own header", () => {
    const path = 'tests/map-page/src/main.ts';
    const header = /^(?:\/\/.*\n)+/.exec(readRepo(path))?.[0] ?? '';
    expect(header).toMatch(/profile's \w+/);
    expect(wrongCounts(path, header.replace(/\n\/\/ /g, ' '), PROFILE_RULES)).toEqual([]);
  });

  it("match the error codes in the protocol's README", () => {
    const path = 'packages/protocol/README.md';
    const rule: Rule = {
      what: 'ERROR_CODES.length',
      pattern: new RegExp(`\\bthe ${WORD} codes\\b`, 'g'),
      expected: ERROR_CODES.length,
    };
    expect(readRepo(path)).toMatch(rule.pattern);
    expect(wrongCounts(path, readRepo(path), [rule])).toEqual([]);
  });

  it("match the demo board's tools in its README", () => {
    const path = 'apps/demo/README.md';
    const rule: Rule = {
      what: "the board's tool count",
      pattern: new RegExp(`\\b${WORD} WebMCP tools\\b`, 'g'),
      expected: TOOL_FACTORIES.length,
    };
    expect(readRepo(path)).toMatch(rule.pattern);
    expect(wrongCounts(path, readRepo(path), [rule])).toEqual([]);
  });

  it('would fail a stale count, and pass a count of an earlier list', () => {
    const fixed = FIXED_RULE;
    expect(wrongCounts('x.md', 'Clients see five fixed tools.', [fixed])).toHaveLength(1);
    expect(wrongCounts('x.md', 'Clients see 9 fixed tools.', [fixed])).toEqual([]);
    expect(wrongCounts('x.md', 'Every relay offers five **fixed tools**.', [fixed])).toHaveLength(
      1,
    );
    expect(wrongCounts('x.md', "After M4's five fixed tools come four more.", [fixed])).toEqual([]);
    expect(wrongCounts('x.md', 'Since M4 the relay has five fixed tools.', [fixed])).toHaveLength(
      1,
    );
    expect(
      wrongCounts('x.md', '**M1 Walking skeleton.** A relay with the five fixed tools.', [fixed]),
    ).toEqual([]);
    expect(
      wrongCounts('x.md', "It has sixteen tools: the profile's sixteen tools.", PROFILE_RULES),
    ).toHaveLength(1);
    expect(
      wrongCounts('x.md', "It registers sixteen: the profile's sixteen (and two).", PROFILE_RULES),
    ).toHaveLength(1);
    expect(wrongCounts('x.md', "The profile's own tools and its fourteen.", PROFILE_RULES)).toEqual(
      [],
    );
    expect(wrongCounts('x.md', 'The handle has twelve handle members.', ALL_RULES)).toHaveLength(1);
  });
});

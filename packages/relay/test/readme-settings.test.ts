// The relay's README ships in the npm tarball and says it describes the
// relay in full, and an `npx` user has no .env.example to read: so every
// setting the relay's source reads must be named in the README, and in
// .env.example for a checkout. M5's two settings once reached only the
// latter, and the Origin list is the fix when a trusted client is refused.
// Two rules those files and guide pages 07 and 08 state are held to config.ts
// too (the docs pass after M6): the value rules' paragraph, the one stating
// counts run to 999999999, names every count that also takes 0, found by
// starting the relay's config with each TABDOCK_MAX_ setting at 0; and every
// list of the settings that turn local mode off is AUTH_SETTINGS, no more and
// no fewer, with any count it states.

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AUTH_SETTINGS, loadConfigFromEnv, resolveConfig } from '../src/config.ts';
import { ALICE } from './helpers/relay.ts';

const SRC = new URL('../src/', import.meta.url);
const SETTING = /\bTABDOCK_[A-Z0-9_]+\b/g;
/** A constant the bundle defines at build time (ADR 0028), never a setting anyone sets. */
const BUILD_CONSTANTS = new Set(['TABDOCK_PACKAGED']);

function namesIn(text: string): Set<string> {
  return new Set(text.match(SETTING) ?? []);
}

function sourceSettings(): string[] {
  const names = new Set<string>();
  for (const entry of readdirSync(SRC, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const path = new URL(`${entry.parentPath}/${entry.name}`, 'file://');
    for (const name of namesIn(readFileSync(path, 'utf8'))) names.add(name);
  }
  return [...names].sort();
}

describe('the settings the relay reads', () => {
  const settings = sourceSettings();

  it('are found in the source at all', () => {
    expect(settings).toEqual(
      expect.arrayContaining(['TABDOCK_FIRST_CLASS_TOOLS', 'TABDOCK_MCP_ALLOWED_ORIGINS']),
    );
  });

  it('are each named in the README the package ships', () => {
    const readme = namesIn(readFileSync(new URL('../README.md', import.meta.url), 'utf8'));
    expect(settings.filter((name) => !readme.has(name))).toEqual([]);
  });

  it('are each in .env.example, but for build constants', () => {
    const example = namesIn(
      readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'),
    );
    expect(settings.filter((name) => !BUILD_CONSTANTS.has(name) && !example.has(name))).toEqual([]);
  });
});

const ROOT = new URL('../../../', import.meta.url);
const VALUE_RULE_FILES = [
  'docs/guide/08-relay-settings.md',
  '.env.example',
  'packages/relay/README.md',
] as const;
const LOCAL_MODE_PROSE = [
  'packages/relay/README.md',
  'docs/guide/07-run-a-relay.md',
  'docs/guide/08-relay-settings.md',
] as const;
const COUNT_WORDS: Readonly<Record<string, number>> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function readRoot(path: string): string {
  return readFileSync(new URL(path, ROOT), 'utf8');
}

/** Whether the relay starts, both layers, with this TABDOCK_MAX_ setting at 0 beside dev tokens and invites. */
function takesZero(name: string): boolean {
  try {
    resolveConfig(
      loadConfigFromEnv({
        TABDOCK_DEV_TOKENS: `alice=${ALICE.token}`,
        TABDOCK_INVITES: '1',
        [name]: '0',
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/** The paragraphs of a Markdown file or of a .env file's comments, code blocks left out. */
function paragraphsOf(path: string, text: string): string[] {
  if (path.endsWith('.md')) {
    let fenced = false;
    const kept = text.split('\n').map((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return '';
      }
      return fenced ? '' : line;
    });
    return kept.join('\n').split(/\n\s*\n/);
  }
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of text.split('\n')) {
    const comment = /^#\s?(.*)$/.exec(line)?.[1];
    if (comment === undefined || comment.trim() === '') {
      if (current.length > 0) paragraphs.push(current.join(' '));
      current = [];
    } else current.push(comment);
  }
  if (current.length > 0) paragraphs.push(current.join(' '));
  return paragraphs;
}

/** The settings that take 0 which the value rules' paragraph of `text` leaves unnamed. */
function zeroesUnnamed(path: string, text: string, zeroes: readonly string[]): string[] {
  const paragraph = paragraphsOf(path, text).find((candidate) => candidate.includes('999999999'));
  if (paragraph === undefined) return [`${path} states no value rules`];
  const named = namesIn(paragraph);
  return zeroes.filter((name) => !named.has(name)).map((name) => `${path} leaves out ${name}`);
}

/** Each sentence of a Markdown file's prose, tables and code blocks left out. */
function sentencesOf(text: string): string[] {
  return paragraphsOf('x.md', text)
    .filter((paragraph) => !paragraph.trim().startsWith('|'))
    .flatMap((paragraph) => paragraph.replace(/\s+/g, ' ').split(/(?<=\.)\s+(?=[A-Z`])/));
}

/** What is wrong with each prose list of the settings that keep local mode, against AUTH_SETTINGS. */
function proseListProblems(where: string, text: string, auth: readonly string[]): string[] {
  const want = [...auth].sort().join(', ');
  return sentencesOf(text).flatMap((sentence) => {
    if (!/local mode/i.test(sentence)) return [];
    const problems: string[] = [];
    const list = /\bnone of (.+?)\bset\b/.exec(sentence)?.[1];
    if (list !== undefined) {
      const named = [...namesIn(list)].sort().join(', ');
      if (named !== want) problems.push(`${where} lists ${named}, not ${want}`);
    }
    const count = /\b(two|three|four|five|six|seven|eight|nine|ten) settings\b/.exec(sentence)?.[1];
    if (count !== undefined && (list !== undefined || /local mode off/i.test(sentence))) {
      if (COUNT_WORDS[count] !== auth.length) {
        problems.push(`${where} counts ${count} settings, not ${String(auth.length)}`);
      }
    }
    return problems;
  });
}

/**
 * The settings .env.example says turn local mode off: a comment block that
 * says so of "these <count>" names that many assignments from its own on,
 * and any other block that says so names its own.
 */
function envLocalModeOff(text: string): string[] {
  const blocks: { comment: string; name: string }[] = [];
  let comment: string[] = [];
  for (const line of text.split('\n')) {
    const assigned = /^(TABDOCK_[A-Z0-9_]+)=/.exec(line)?.[1];
    if (assigned !== undefined) {
      blocks.push({ comment: comment.join(' ').replace(/\s+/g, ' '), name: assigned });
      comment = [];
    } else if (line.startsWith('#')) comment.push(line.replace(/^#\s?/, ''));
  }
  const off = new Set<string>();
  blocks.forEach((block, index) => {
    if (!/local mode off/.test(block.comment)) return;
    const count = /\bthese (two|three|four|five|six|seven|eight|nine|ten)\b/.exec(
      block.comment,
    )?.[1];
    const span = count === undefined ? 1 : (COUNT_WORDS[count] ?? 1);
    for (const next of blocks.slice(index, index + span)) off.add(next.name);
  });
  return [...off].sort();
}

describe('the rules the docs state for settings', () => {
  const maxSettings = sourceSettings().filter((name) => name.startsWith('TABDOCK_MAX_'));
  const zeroes = maxSettings.filter(takesZero);

  it('find the counts that take 0 by starting the config with each', () => {
    expect(maxSettings.length).toBeGreaterThan(15);
    expect(zeroes).toEqual(
      expect.arrayContaining(['TABDOCK_MAX_IMAGE_BYTES', 'TABDOCK_MAX_OBSERVERS_PER_PAGE']),
    );
    expect(zeroes).not.toContain('TABDOCK_MAX_USERS_PER_PAGE');
  });

  it("name every count that takes 0 in each file's value rules", () => {
    expect(VALUE_RULE_FILES.flatMap((path) => zeroesUnnamed(path, readRoot(path), zeroes))).toEqual(
      [],
    );
  });

  it('list exactly AUTH_SETTINGS wherever they list what turns local mode off', () => {
    expect(
      LOCAL_MODE_PROSE.flatMap((path) => proseListProblems(path, readRoot(path), AUTH_SETTINGS)),
    ).toEqual([]);
    // The relay README states the list outright.
    const readme = readRoot('packages/relay/README.md');
    expect(sentencesOf(readme).some((sentence) => /local mode.*\bnone of\b/i.test(sentence))).toBe(
      true,
    );
    expect(envLocalModeOff(readRoot('.env.example'))).toEqual([...AUTH_SETTINGS].sort());
  });

  it('would fail a value rule that leaves a zero out, a short list and a wrong count', () => {
    const rule =
      'Counts are whole numbers from 1 to 999999999, but `TABDOCK_MAX_IMAGE_BYTES` takes 0 too.';
    expect(
      zeroesUnnamed('x.md', rule, ['TABDOCK_MAX_IMAGE_BYTES', 'TABDOCK_MAX_OBSERVERS_PER_PAGE']),
    ).toEqual(['x.md leaves out TABDOCK_MAX_OBSERVERS_PER_PAGE']);
    const auth = ['TABDOCK_A', 'TABDOCK_B', 'TABDOCK_C'];
    expect(
      proseListProblems(
        'x.md',
        'Local mode runs with none of `TABDOCK_A` and `TABDOCK_B` set.',
        auth,
      ),
    ).toEqual(['x.md lists TABDOCK_A, TABDOCK_B, not TABDOCK_A, TABDOCK_B, TABDOCK_C']);
    expect(
      proseListProblems(
        'x.md',
        'Local mode runs with none of the two settings `TABDOCK_A`, `TABDOCK_B` and `TABDOCK_C` set.',
        auth,
      ),
    ).toEqual(['x.md counts two settings, not 3']);
    const env = [
      '# Setting it turns local mode off.',
      'TABDOCK_A=',
      '# Leave these two empty; any one of them turns local mode off.',
      'TABDOCK_B=',
      'TABDOCK_C=',
      'TABDOCK_D=',
    ].join('\n');
    expect(envLocalModeOff(env)).toEqual(['TABDOCK_A', 'TABDOCK_B', 'TABDOCK_C']);
    expect(envLocalModeOff(env.replace('these two', 'these three'))).toContain('TABDOCK_D');
  });
});

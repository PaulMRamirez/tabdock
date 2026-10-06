// The house style CLAUDE.md sets, held where a reader meets it (ADR 0035):
// no en or em dash (U+2013, U+2014) in any tracked Markdown, TypeScript or
// workflow file; every URL in the README, the guide and the package READMEs
// on a host the project means to send readers to, or a placeholder, so
// neither a personal domain nor an employer's host gets in; and each guide
// page short enough to read on a phone, with one H1 and a link onward.

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  guidePages,
  markdownIn,
  packageReadmes,
  readRepo,
  ROOT,
  withoutCodeBlocks,
} from '../src/doc-files.ts';

const DASHES = /[\u2013\u2014]/;
/** Hosts the docs may send a reader to. */
const HOSTS = new Set([
  'github.com',
  'modelcontextprotocol.io',
  'spec.modelcontextprotocol.io',
  'webmachinelearning.github.io',
  'json-schema.org',
  'claude.ai',
  'docs.claude.com',
  'code.claude.com',
  'support.claude.com',
  'docs.anthropic.com',
  'www.npmjs.com',
  'registry.npmjs.org',
  'cdn.jsdelivr.net',
  'localhost',
  '127.0.0.1',
  '[::1]',
]);
const WORD_LIMIT = 1300;
const URL = /\b(?:https?|wss?):\/\/([^\s/)>`"',;]+)/g;

function tracked(patterns: readonly string[]): string[] {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', ...patterns],
    {
      cwd: ROOT,
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter((path) => path !== '');
}

/** A host a reader may be sent to: a listed one, a reserved example name, or a placeholder. */
function allowedHost(host: string): boolean {
  const name = host.replace(/:\d+$/, '').toLowerCase();
  if (name.startsWith('<') || name.startsWith('$')) return true;
  // RFC 2606 keeps these for documentation and tests.
  if (/\.(?:example|test|invalid|localhost)$/.test(name) || name === 'example.com') return true;
  return HOSTS.has(name);
}

/** The words a page's prose holds, its code blocks, tables and comments left out. */
function proseWords(text: string): number {
  return withoutCodeBlocks(text)
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('|'))
    .join(' ')
    .split(/\s+/)
    .filter((word) => /[A-Za-z0-9]/.test(word)).length;
}

describe('en and em dashes', () => {
  it('appear in no tracked Markdown, TypeScript or workflow file', () => {
    const files = tracked(['*.md', '*.ts', '*.mts', '*.cts', '.github/workflows/*']);
    expect(files.length).toBeGreaterThan(300);
    const found = files.flatMap((path) =>
      readRepo(path)
        .split('\n')
        .flatMap((line, index) => (DASHES.test(line) ? [`${path}:${String(index + 1)}`] : [])),
    );
    expect(found).toEqual([]);
  });
});

describe('URLs in the README, the guide and the package READMEs', () => {
  it('are on hosts the project sends readers to, or placeholders', () => {
    const docs = ['README.md', ...markdownIn('docs/guide'), ...packageReadmes()];
    const stray = docs.flatMap((path) =>
      [...readRepo(path).matchAll(URL)]
        .map((match) => match[1] ?? '')
        .filter((host) => !allowedHost(host))
        .map((host) => `${host} in ${path}`),
    );
    expect(stray).toEqual([]);
    expect(allowedHost('relay.example')).toBe(true);
    expect(allowedHost('relay.someone.dev')).toBe(false);
  });
});

describe('the guide pages', () => {
  const pages = guidePages();
  const all = markdownIn('docs/guide');

  it('are numbered from 01 with no gap', () => {
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.map((path) => /\/(\d\d)-/.exec(path)?.[1])).toEqual(
      pages.map((_, index) => String(index + 1).padStart(2, '0')),
    );
  });

  it('each have exactly one H1', () => {
    const wrong = all.filter(
      (path) => (withoutCodeBlocks(readRepo(path)).match(/^# \S/gm) ?? []).length !== 1,
    );
    expect(wrong).toEqual([]);
  });

  it(`each hold at most ${String(WORD_LIMIT)} words outside code blocks and tables`, () => {
    const long = all
      .map((path) => ({ path, words: proseWords(readRepo(path)) }))
      .filter(({ words }) => words > WORD_LIMIT);
    expect(long).toEqual([]);
  });

  it('each end by linking to the next page, and the last back to the index', () => {
    const missing = pages.flatMap((path, index) => {
      const next = pages[index + 1]?.replace('docs/guide/', '') ?? 'README.md';
      const linked = new RegExp(`\\]\\(${next.replace(/\./g, '\\.')}(?:#[^)]*)?\\)`);
      // The last paragraph, where a reader on a phone looks for the way on.
      const last =
        withoutCodeBlocks(readRepo(path))
          .trim()
          .split(/\n\s*\n/)
          .at(-1) ?? '';
      return linked.test(last) ? [] : [`${path} does not end with a link to ${next}`];
    });
    expect(missing).toEqual([]);
  });
});

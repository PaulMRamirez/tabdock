// The house style CLAUDE.md sets, held where a reader meets it (ADR 0035):
// no en or em dash (U+2013, U+2014) in any tracked Markdown, TypeScript or
// workflow file; every URL in the README, the guide and the package READMEs
// on a host the project means to send readers to, or a placeholder, so
// neither a personal domain nor an employer's host gets in; and each guide
// page short enough to read on a phone, with one H1 and a link onward.
// Short enough counts tables too, since a wide table fills a phone screen as
// prose does (a troubleshooting page once held 1,300 words of table cells
// beside its prose), and holds each paragraph and table cell to what a
// phone shows at once. The tour's explainers stay under CLAUDE.md's "about
// 600 words" (at most 620, no paragraph over 160), and the guide names no
// milestone (M0 to M9): its readers know versions and features, never the
// build's milestones, which belong to the tour and the plans.

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
/** Words outside code blocks, tables included. */
const PAGE_LIMIT = 1600;
/** Words in one paragraph or list item of the guide or the README. */
const PARAGRAPH_LIMIT = 120;
/** Words in one table cell. */
const CELL_LIMIT = 45;
const URL = /\b(?:https?|wss?):\/\/([^\s/)>`"',;]+)/g;
/** Words in a tour page outside code blocks and comments, tables included. */
const TOUR_LIMIT = 620;
/** Words in one paragraph or list item of a tour page. */
const TOUR_PARAGRAPH_LIMIT = 160;
const MILESTONE = /\bM[0-9]\b/;

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

function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => /[A-Za-z0-9]/.test(word)).length;
}

/** A page's lines outside code blocks and comments. */
function textLines(text: string): string[] {
  return withoutCodeBlocks(text)
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n');
}

/** The words a page's prose holds, its code blocks, tables and comments left out. */
function proseWords(text: string): number {
  return wordCount(
    textLines(text)
      .filter((line) => !line.trim().startsWith('|'))
      .join(' '),
  );
}

/** The words outside code blocks and comments, table cells included. */
function pageWords(text: string): number {
  return wordCount(textLines(text).join(' '));
}

/** Each paragraph and list item outside code blocks and tables, with its word count. */
function paragraphs(text: string): { start: string; words: number }[] {
  const found: { start: string; words: number }[] = [];
  let current: string[] = [];
  const close = (): void => {
    const joined = current.join(' ').trim();
    if (joined !== '') found.push({ start: joined.slice(0, 60), words: wordCount(joined) });
    current = [];
  };
  for (const line of textLines(text)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('|') || trimmed.startsWith('#')) {
      close();
      continue;
    }
    if (/^(?:[-*+]|\d+\.)\s/.test(trimmed)) close();
    current.push(trimmed);
  }
  close();
  return found;
}

/** Each table cell outside code blocks, with its word count. */
function cells(text: string): { start: string; words: number }[] {
  return textLines(text)
    .filter((line) => line.trim().startsWith('|'))
    .flatMap((line) =>
      line
        .trim()
        .replace(/^\||\|$/g, '')
        .split(/(?<!\\)\|/),
    )
    .map((cell) => ({ start: cell.trim().slice(0, 60), words: wordCount(cell) }));
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

  it(`each hold at most ${String(PAGE_LIMIT)} words outside code blocks, tables included`, () => {
    const long = all
      .map((path) => ({ path, words: pageWords(readRepo(path)) }))
      .filter(({ words }) => words > PAGE_LIMIT);
    expect(long).toEqual([]);
  });

  it(`hold no paragraph over ${String(PARAGRAPH_LIMIT)} words, nor a table cell over ${String(CELL_LIMIT)}, and nor does the README`, () => {
    const long = [...all, 'README.md'].flatMap((path) => {
      const text = readRepo(path);
      return [
        ...paragraphs(text)
          .filter(({ words }) => words > PARAGRAPH_LIMIT)
          .map(({ start, words }) => `${path}: a paragraph of ${String(words)} words, "${start}"`),
        ...cells(text)
          .filter(({ words }) => words > CELL_LIMIT)
          .map(({ start, words }) => `${path}: a cell of ${String(words)} words, "${start}"`),
      ];
    });
    expect(long).toEqual([]);
  });

  it('would count a long table cell and a long paragraph', () => {
    const cell = Array.from({ length: CELL_LIMIT + 1 }, () => 'word').join(' ');
    const table = `| A | B |\n| - | - |\n| x | ${cell} |\n`;
    expect(cells(table).some(({ words }) => words > CELL_LIMIT)).toBe(true);
    expect(pageWords(table)).toBeGreaterThan(proseWords(table));
    const prose = Array.from({ length: PARAGRAPH_LIMIT + 1 }, () => 'word').join(' ');
    expect(paragraphs(`${prose}\n\n1. short item\n2. another`).map(({ words }) => words)).toEqual([
      PARAGRAPH_LIMIT + 1,
      3,
      2,
    ]);
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

/** Each line of `text` outside code blocks and comments that names a milestone, link targets left out. */
function milestoneLines(text: string): string[] {
  return textLines(text).flatMap((line, index) => {
    const read = line.replace(/\]\([^)]*\)/g, ']');
    return MILESTONE.test(read) ? [`${String(index + 1)}: ${line.trim().slice(0, 80)}`] : [];
  });
}

/** What is too long on a tour page: the page, or a paragraph or list item. */
function tourProblems(text: string): string[] {
  const words = pageWords(text);
  return [
    ...(words > TOUR_LIMIT ? [`${String(words)} words`] : []),
    ...paragraphs(text)
      .filter((paragraph) => paragraph.words > TOUR_PARAGRAPH_LIMIT)
      .map(({ start, words: count }) => `a paragraph of ${String(count)} words, "${start}"`),
  ];
}

describe('the tour pages', () => {
  const pages = markdownIn('docs/tour');

  it(`each hold at most ${String(TOUR_LIMIT)} words outside code blocks and no paragraph over ${String(TOUR_PARAGRAPH_LIMIT)}`, () => {
    expect(pages.length).toBeGreaterThan(6);
    const long = pages.flatMap((path) =>
      tourProblems(readRepo(path)).map((problem) => `${path}: ${problem}`),
    );
    expect(long).toEqual([]);
  });

  it('would fail a long page and a long paragraph', () => {
    const paragraph = (count: number): string =>
      Array.from({ length: count }, () => 'word').join(' ');
    expect(tourProblems(paragraph(TOUR_PARAGRAPH_LIMIT))).toEqual([]);
    expect(tourProblems(paragraph(TOUR_PARAGRAPH_LIMIT + 1))).toHaveLength(1);
    const page = Array.from({ length: 5 }, () => paragraph(130)).join('\n\n');
    expect(tourProblems(page)).toEqual(['650 words']);
    // Code blocks do not count.
    expect(tourProblems(`${paragraph(10)}\n\n\`\`\`sh\n${paragraph(700)}\n\`\`\`\n`)).toEqual([]);
  });
});

describe('milestone words in the guide', () => {
  it('appear on no guide page outside code blocks', () => {
    const found = markdownIn('docs/guide').flatMap((path) =>
      milestoneLines(readRepo(path)).map((line) => `${path}:${line}`),
    );
    expect(found).toEqual([]);
  });

  it('would fail a milestone named in prose or a table, and pass one in code or a link target', () => {
    expect(milestoneLines('Since M6 a page can publish state.')).toHaveLength(1);
    expect(milestoneLines('| Setting | Since M5 |')).toHaveLength(1);
    expect(
      milestoneLines('```sh\npnpm demo:m6 # M6\n```\nSee [the plan](../plans/M6.md).'),
    ).toEqual([]);
    expect(milestoneLines('MCP-B 6.0.0, M365 and SM6 are no milestones.')).toEqual([]);
  });
});

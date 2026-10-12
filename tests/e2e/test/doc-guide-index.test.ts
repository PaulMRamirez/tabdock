// The guide's two indexes (docs/guide/README.md, published at /guide/) and
// the copy of one on the repository's front page (the docs pass after M6).
// The Every page list links each numbered page once, in page order, its item
// numbers the pages' own (the numbers in the URLs readers see); the Where to
// start table reaches every page from some task, since a page no row names
// is found only by scrolling (page 15 once was); and README.md's You want to
// table is the guide's, row for row, by task and by the set of guide pages
// each row links, so the copy cannot drift from the original again.

import { describe, expect, it } from 'vitest';
import { guidePages, readRepo, type Table, tables, withoutCodeBlocks } from '../src/doc-files.ts';

const INDEX = 'docs/guide/README.md';
const FRONT = 'README.md';

/** The numbered guide pages a piece of Markdown links, in order, as file names. */
function linkedPages(text: string): string[] {
  return [
    ...text.matchAll(/\]\((?:\.\/)?(?:docs\/guide\/)?(\d\d-[a-z0-9-]+\.md)(?:#[^)]*)?\)/g),
  ].map((match) => match[1] ?? '');
}

/** The part of `text` under the `## <heading>` heading, up to the next H2. */
function sectionUnder(text: string, heading: string): string {
  const body = withoutCodeBlocks(text);
  const start = body.indexOf(`\n## ${heading}\n`);
  if (start < 0) return '';
  const rest = body.slice(start + heading.length + 5);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
}

/** The Every page list's items: each item's number and the pages it links. */
function listItems(section: string): { number: number; pages: string[] }[] {
  return section.split('\n').flatMap((line) => {
    const item = /^(\d+)\.\s+(.*)$/.exec(line.trim());
    return item === null ? [] : [{ number: Number(item[1]), pages: linkedPages(item[2] ?? '') }];
  });
}

/** What is wrong with an Every page list against the pages in order. */
function listProblems(section: string, pages: readonly string[]): string[] {
  const items = listItems(section);
  const problems: string[] = [];
  const linked = items.flatMap((item) => item.pages);
  if (linked.join() !== pages.join()) {
    problems.push(`the list links ${linked.join(', ')}, not ${pages.join(', ')}`);
  }
  for (const item of items) {
    const page = item.pages[0] ?? '';
    if (Number(page.slice(0, 2)) !== item.number) {
      problems.push(`item ${String(item.number)} links ${page}`);
    }
  }
  return problems;
}

/** The table whose first header is "You want to". */
function taskTable(text: string): Table {
  const table = tables(text).find((candidate) => candidate.header[0] === 'You want to');
  if (table === undefined) throw new Error('no "You want to" table');
  return table;
}

/** Each row as its task and the set of guide pages it links, sorted. */
function rowsOf(table: Table): { task: string; pages: string[] }[] {
  return table.rows.map((row) => ({
    task: (row.values[0] ?? '').trim(),
    pages: [...new Set(linkedPages(row.values[1] ?? ''))].sort(),
  }));
}

/** The numbered pages no row links. */
function unreached(table: Table, pages: readonly string[]): string[] {
  const linked = new Set(rowsOf(table).flatMap((row) => row.pages));
  return pages.filter((page) => !linked.has(page));
}

describe("the guide's indexes", () => {
  const pages = guidePages().map((path) => path.replace('docs/guide/', ''));
  const index = readRepo(INDEX);

  it('find the numbered pages, 21 and 22 among them', () => {
    expect(pages).toContain('21-run-a-class.md');
    expect(pages).toContain('22-join-a-shared-page.md');
  });

  it('list every page once in the Every page list, in page order, under its own number', () => {
    const section = sectionUnder(index, 'Every page');
    expect(section).not.toBe('');
    expect(listProblems(section, pages)).toEqual([]);
  });

  it('reach every page from the Where to start table', () => {
    expect(sectionUnder(index, 'Where to start')).not.toBe('');
    expect(unreached(taskTable(index), pages)).toEqual([]);
  });

  it("hold README.md's table to the guide's, row for row", () => {
    expect(rowsOf(taskTable(readRepo(FRONT)))).toEqual(rowsOf(taskTable(index)));
  });

  it('would fail a page left out, a list out of order, a misnumbered item and a drifted row', () => {
    const three = ['01-a.md', '02-b.md', '03-c.md'];
    const list = '1. [A](01-a.md): a.\n2. [B](02-b.md): b.\n3. [C](03-c.md): c.\n';
    expect(listProblems(list, three)).toEqual([]);
    expect(listProblems(list.replace('3. [C](03-c.md): c.\n', ''), three)).toHaveLength(1);
    expect(
      listProblems('1. [A](01-a.md): a.\n2. [C](03-c.md): c.\n3. [B](02-b.md): b.\n', three),
    ).not.toEqual([]);
    expect(listProblems(list.replace('3. [C]', '4. [C]'), three)).toEqual(['item 4 links 03-c.md']);
    const table = (cell: string): Table =>
      taskTable(`| You want to | Read, in order |\n| - | - |\n| Start | ${cell} |\n`);
    expect(unreached(table('[A](01-a.md), [B](02-b.md)'), three)).toEqual(['03-c.md']);
    expect(rowsOf(table('[A](docs/guide/01-concepts.md#parts)'))).toEqual(
      rowsOf(table('[A](01-concepts.md)')),
    );
    expect(rowsOf(table('[A](01-a.md)'))).not.toEqual(rowsOf(table('[B](02-b.md)')));
  });
});

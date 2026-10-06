// Reading the repository's Markdown for the doc sync tests (ADR 0035): the
// files each test covers, their fenced code blocks, their pipe tables and
// their prose with code taken out. Kept apart from the tests so each states
// only its rule.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The marker a guide puts just before a code block that is not a whole module. */
export const FRAGMENT_MARKER = '<!-- fragment -->';

export function readRepo(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

export function existsInRepo(path: string): boolean {
  return existsSync(join(ROOT, path));
}

/** The .md files directly in `dir`, as repository paths, sorted. */
export function markdownIn(dir: string): string[] {
  return readdirSync(join(ROOT, dir))
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => `${dir}/${name}`);
}

/** The README of each package, app and test package that has one. */
export function packageReadmes(): string[] {
  return ['packages', 'apps', 'tests'].flatMap((dir) =>
    readdirSync(join(ROOT, dir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${dir}/${entry.name}/README.md`)
      .filter(existsInRepo)
      .sort(),
  );
}

/** The guide's numbered pages in reading order, its index excluded. */
export function guidePages(): string[] {
  return markdownIn('docs/guide').filter((path) => /\/\d\d-[^/]+\.md$/.test(path));
}

export interface CodeBlock {
  /** The info string's first word, lower case: ts, html, sh and so on. */
  readonly lang: string;
  readonly body: string;
  /** The 1-based line of the opening fence. */
  readonly line: number;
  /** Whether a fragment marker sits on the last non-blank line before the fence. */
  readonly fragment: boolean;
}

/** Every fenced code block in `text`, opened by three or more backticks or tildes. */
export function codeBlocks(text: string): CodeBlock[] {
  const lines = text.split('\n');
  const blocks: CodeBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const open = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/.exec(lines[index] ?? '');
    if (open === null) continue;
    const fence = open[2] ?? '```';
    const body: string[] = [];
    let at = index + 1;
    for (; at < lines.length; at += 1) {
      const line = lines[at] ?? '';
      if (line.trim().startsWith(fence) && line.trim().replaceAll(fence[0] ?? '`', '') === '')
        break;
      body.push(line);
    }
    let before = index - 1;
    while (before >= 0 && (lines[before] ?? '').trim() === '') before -= 1;
    blocks.push({
      lang: (open[3] ?? '').toLowerCase(),
      body: body.join('\n'),
      line: index + 1,
      fragment: before >= 0 && (lines[before] ?? '').trim() === FRAGMENT_MARKER,
    });
    index = at;
  }
  return blocks;
}

/** `text` with fenced code blocks blanked, line numbers kept. */
export function withoutCodeBlocks(text: string): string {
  const lines = text.split('\n');
  let fence: string | null = null;
  return lines
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence === null && marker !== undefined) {
        fence = marker;
        return '';
      }
      if (fence !== null) {
        if (marker !== undefined && line.trim().replaceAll(fence[0] ?? '`', '') === '') {
          fence = null;
        }
        return '';
      }
      return line;
    })
    .join('\n');
}

/** One body row of a pipe table: its cells keyed by the header's text. */
export interface TableRow {
  readonly cells: Readonly<Record<string, string>>;
  /** The row's cells in order. */
  readonly values: readonly string[];
  /** The 1-based line of the row. */
  readonly line: number;
}

export interface Table {
  readonly header: readonly string[];
  readonly rows: readonly TableRow[];
  /** The 1-based line of the header row. */
  readonly line: number;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

/** Every pipe table in `text` outside code blocks. */
export function tables(text: string): Table[] {
  const lines = withoutCodeBlocks(text).split('\n');
  const found: Table[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index] ?? '';
    const rule = (lines[index + 1] ?? '').trim();
    if (!header.trim().startsWith('|') || !/^\|[\s:|-]+\|$/.test(rule)) continue;
    const names = splitRow(header);
    const rows: TableRow[] = [];
    let at = index + 2;
    for (; at < lines.length && (lines[at] ?? '').trim().startsWith('|'); at += 1) {
      const values = splitRow(lines[at] ?? '');
      rows.push({
        cells: Object.fromEntries(names.map((name, column) => [name, values[column] ?? ''])),
        values,
        line: at + 1,
      });
    }
    found.push({ header: names, rows, line: index + 1 });
    index = at;
  }
  return found;
}

/** The text of every `code span` in `text`, outside code blocks. */
export function codeSpans(text: string): { span: string; line: number }[] {
  const spans: { span: string; line: number }[] = [];
  withoutCodeBlocks(text)
    .split('\n')
    .forEach((line, index) => {
      for (const match of line.matchAll(/(`+)([^`]+?)\1(?!`)/g)) {
        spans.push({ span: (match[2] ?? '').trim(), line: index + 1 });
      }
    });
  return spans;
}

/**
 * The data-* attributes the script-tag build reads, from
 * packages/adapter/src/script-options.ts: every `data.<key>` it touches,
 * written as the attribute.
 */
export function scriptTagAttributes(): string[] {
  const source = readRepo('packages/adapter/src/script-options.ts');
  const keys = new Set<string>();
  for (const [, key] of source.matchAll(/\bdata\.([a-zA-Z]+)\b/g)) {
    if (key !== undefined) keys.add(key);
  }
  return [...keys]
    .map((key) => `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`)
    .sort();
}

/** data-relay-style attribute to its dataset key, as a browser maps it. */
export function datasetKey(attribute: string): string {
  return attribute
    .replace(/^data-/, '')
    .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

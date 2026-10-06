// Pointers between the docs and the code must hold both ways. Every docs/
// path the code names, in what it prints or in a comment, must exist in the
// checkout: a banner or a check that sends someone to a page that is not
// there leaves them stuck at the first step (the local mode banner once
// pointed at docs/deploy.md before it existed). And every pointer the docs
// a reader follows give must land (ADR 0035): a relative link and its
// anchor, a backticked repository path, a bare file name that names one file
// only, an ADR number, and in the guide and the tour an identifier that
// looks like code (camelCase, a #private member or a call), which must occur
// in the source, so a renamed function cannot linger in prose (the tour once
// named a runCall that no longer existed).

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, normalize, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  codeSpans,
  markdownIn,
  packageReadmes,
  readRepo,
  ROOT,
  withoutCodeBlocks,
} from '../src/doc-files.ts';

const SOURCE_DIRS = ['packages', 'apps', 'scripts', 'tests'];
const SKIP = new Set(['node_modules', 'dist', 'test-results', 'playwright-report', '.vite']);
const DOC_PATH = /\bdocs\/[A-Za-z0-9._/-]+\.md\b/g;

/** Every source file under `dir` but this one, which names the docs it looks for. */
function sources(dir: string, pattern = /\.(ts|js|html)$/): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (path === import.meta.filename) return [];
    if (entry.isDirectory()) return sources(path, pattern);
    return pattern.test(entry.name) ? [path] : [];
  });
}

describe('docs the code points at', () => {
  it('all exist', () => {
    const named = new Map<string, string>();
    for (const file of SOURCE_DIRS.flatMap((dir) => sources(join(ROOT, dir)))) {
      for (const [path] of readFileSync(file, 'utf8').matchAll(DOC_PATH)) {
        if (!named.has(path)) named.set(path, relative(ROOT, file));
      }
    }
    // The ones the local mode banner and its Claude Code check print, at least.
    expect([...named.keys()]).toEqual(
      expect.arrayContaining(['docs/deploy.md', 'docs/checklists/M4.md']),
    );
    const missing = [...named]
      .filter(([path]) => !existsSync(join(ROOT, path)))
      .map(([path, file]) => `${path} (named in ${file})`);
    expect(missing).toEqual([]);
  });
});

/** The docs whose pointers a reader follows. */
const DOCS = [
  'README.md',
  ...markdownIn('docs/guide'),
  ...markdownIn('docs/tour'),
  'docs/deploy.md',
  'docs/develop.md',
  'docs/release.md',
  'docs/threat-model.md',
  ...packageReadmes(),
];
/** Where code-shaped names are held to the source: the pages that teach the code. */
const TEACHING = [...markdownIn('docs/guide'), ...markdownIn('docs/tour')];

/** Every file git tracks or would track, as repository paths. */
const TREE: readonly string[] = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard'],
  { cwd: ROOT, encoding: 'utf8' },
)
  .split('\n')
  .filter((path) => path !== '' && existsSync(join(ROOT, path)));
const BY_NAME = new Map<string, string[]>();
for (const path of TREE) {
  BY_NAME.set(basename(path), [...(BY_NAME.get(basename(path)) ?? []), path]);
}
const DIRECTORIES = new Set(
  TREE.flatMap((path) => {
    const parts = path.split('/');
    return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join('/'));
  }),
);

/**
 * File names the docs use bare on purpose: every package has one and the
 * sentence says whose, or the file is made by a build, a release or the
 * relay and so is in no checkout.
 */
const BARE_NAMES_IN_CONTEXT = new Set([
  'package.json',
  'README.md',
  'tsconfig.json',
  'index.html',
  'index.ts',
  'fly.toml',
  'Dockerfile',
  'CHANGELOG.md',
  // Made by builds, releases, test runs or the relay, or MCP-B's own files.
  'checks.json',
  'embed.js',
  'tabdock-adapter.js',
  'tabdock-adapter.integrity.txt',
  'npm-shrinkwrap.json',
  'cli.js',
  'index.iife.js',
  'webmcp-polyfill.js',
  'index.d.ts',
  'claude.json',
  '.claude.json',
  'settings.json',
  'owner-token',
  'claude-headers',
  // Made by the reader in a folder of their own, as the guide shows.
  'list-pages.ts',
]);

/** GitHub's anchor for a heading. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function anchorsOf(path: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const [, heading] of withoutCodeBlocks(readRepo(path)).matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = slug(heading ?? '');
    const count = seen.get(base) ?? 0;
    anchors.add(count === 0 ? base : `${base}-${String(count)}`);
    seen.set(base, count + 1);
  }
  return anchors;
}

/** Each relative link's target and anchor, with where it is. */
function relativeLinks(doc: string): { where: string; target: string; anchor: string | null }[] {
  const links: { where: string; target: string; anchor: string | null }[] = [];
  withoutCodeBlocks(readRepo(doc))
    .split('\n')
    .forEach((line, index) => {
      // Code spans hold examples, not links.
      const prose = line.replace(/(`+)[^`]*?\1/g, '');
      for (const [, href] of prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        if (href === undefined || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//'))
          continue;
        const [path, anchor] = href.split('#', 2) as [string, string | undefined];
        const target = path === '' ? doc : normalize(join(dirname(doc), decodeURI(path)));
        links.push({ where: `${doc}:${String(index + 1)}`, target, anchor: anchor ?? null });
      }
    });
  return links;
}

/** A package README speaks of its own package, so its paths may start there. */
function packageDirOf(doc: string): string | null {
  return /^(?:packages|apps|tests)\/[^/]+\/README\.md$/.test(doc) ? dirname(doc) : null;
}

/**
 * Names that look like code in the guide on purpose without being code: the
 * misspelled policy key the adapter reference warns is silently dropped.
 */
const NOT_CODE = new Set(['consequentialTool']);

const REPO_PATH = /^(?:packages|apps|scripts|tests|docs|deploy|\.github)\/[^\s]*$/;
const FILE_NAME = /^\.?[A-Za-z0-9_][\w.-]*\.(?:ts|js|mjs|md|json|ya?ml|html|css|toml|txt|sh)$/;

/** A backticked path's file part: a line number, an anchor or a trailing slash dropped. */
function pathOf(span: string): string {
  return span
    .replace(/#.*$/, '')
    .replace(/:\d+(?::\d+)?$/, '')
    .replace(/\/$/, '');
}

describe('pointers the docs give', () => {
  it('covers the guide, the tour and the package READMEs', () => {
    expect(DOCS).toEqual(
      expect.arrayContaining([
        'docs/guide/01-concepts.md',
        'docs/tour/00-baseline.md',
        'packages/relay/README.md',
      ]),
    );
  });

  it('relative links reach a file, and an anchor a heading in it', () => {
    const problems = DOCS.flatMap((doc) =>
      relativeLinks(doc).flatMap(({ where, target, anchor }) => {
        if (!existsSync(join(ROOT, target))) return [`${where}: ${target} does not exist`];
        if (anchor === null || anchor === '' || !target.endsWith('.md')) return [];
        return anchorsOf(target).has(anchor) ? [] : [`${where}: ${target} has no #${anchor}`];
      }),
    );
    expect(problems).toEqual([]);
  });

  it('backticked repository paths exist', () => {
    const problems = DOCS.flatMap((doc) =>
      codeSpans(readRepo(doc)).flatMap(({ span, line }) => {
        if (!REPO_PATH.test(span) || /[<>*{}]/.test(span)) return [];
        const path = pathOf(span);
        const own = packageDirOf(doc);
        if (existsInTree(path) || (own !== null && existsInTree(`${own}/${path}`))) return [];
        return [`${doc}:${String(line)}: ${span} does not exist`];
      }),
    );
    expect(problems).toEqual([]);
  });

  it('bare file names name one file, or carry their directory', () => {
    const problems = DOCS.flatMap((doc) =>
      codeSpans(readRepo(doc)).flatMap(({ span, line }) => {
        if (!FILE_NAME.test(span) || BARE_NAMES_IN_CONTEXT.has(span)) return [];
        // A root file named as itself is a path, not a bare name.
        if (TREE.includes(span)) return [];
        const all = BY_NAME.get(span) ?? [];
        const own = packageDirOf(doc);
        // A package README's bare module names are its own, its src/ first.
        const inSource = own === null ? [] : all.filter((path) => path.startsWith(`${own}/src/`));
        const inPackage = own === null ? [] : all.filter((path) => path.startsWith(`${own}/`));
        const matches = inSource.length > 0 ? inSource : inPackage.length > 0 ? inPackage : all;
        if (matches.length === 1) return [];
        return [
          `${doc}:${String(line)}: ${span} ${matches.length === 0 ? 'names no file' : `could be any of ${matches.join(', ')}`}`,
        ];
      }),
    );
    expect(problems).toEqual([]);
  });

  it('ADR numbers name ADRs that exist', () => {
    const adrs = new Set(readdirSync(join(ROOT, 'docs/adr')).map((name) => name.slice(0, 4)));
    const problems = DOCS.flatMap((doc) =>
      readRepo(doc)
        .split('\n')
        .flatMap((line, index) =>
          [
            ...line.matchAll(
              /\bADRs?\s+((?:\d{4})(?:(?:,\s*|\s+and\s+|\s+to\s+|\s+or\s+)\d{4})*)/g,
            ),
          ].flatMap(([, list]) =>
            [...(list ?? '').matchAll(/\d{4}/g)]
              .map(([number]) => number)
              .filter((number) => !adrs.has(number))
              .map((number) => `${doc}:${String(index + 1)}: ADR ${number} does not exist`),
          ),
        ),
    );
    expect(problems).toEqual([]);
  });

  it('code-shaped names in the guide and the tour occur in the source', () => {
    const corpus = SOURCE_DIRS.flatMap((dir) =>
      sources(join(ROOT, dir), /\.(ts|js|mjs|html|json)$/),
    )
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    const problems = TEACHING.flatMap((doc) =>
      codeSpans(readRepo(doc)).flatMap(({ span, line }) => {
        const name = codeName(span);
        if (name === null || NOT_CODE.has(name)) return [];
        const pattern = new RegExp(`(?<![\\w$#])${name.replace(/[$#]/g, '\\$&')}(?![\\w$])`);
        return pattern.test(corpus)
          ? []
          : [`${doc}:${String(line)}: ${span} occurs nowhere in the source`];
      }),
    );
    expect(problems).toEqual([]);
  });
});

function existsInTree(path: string): boolean {
  return TREE.includes(path) || DIRECTORIES.has(path) || existsSync(join(ROOT, path));
}

/**
 * The identifier a code span names, when it looks like code: a call such as
 * `attach()` or `dock.on('state', listener)` gives its function's name, a
 * #private member its name with the mark, and a camelCase word itself.
 * Anything else, such as a command, a path or a value, gives null.
 */
function codeName(span: string): string | null {
  const call = /^(?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*)\(.*\)$/.exec(span);
  if (call?.[1] !== undefined) return call[1];
  if (/^#[a-z][A-Za-z0-9]*$/.test(span)) return span;
  if (/^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(span)) return span;
  return null;
}

// The code a reader copies from the guide and the READMEs must compile
// against the packages as they are now (ADR 0035): every ts and js block in
// docs/guide, the root README and the adapter's README is typechecked as its
// own module under the workspace's strict settings, with the DOM and Node
// types, so a renamed option or method fails here rather than in a reader's
// editor. TypeScript knows no document.modelContext, so the blocks compile
// only with the declaration the guide itself gives readers, never with one
// from the repository a reader would not have (the guide once sent readers
// to the demo's source for it). A block that
// is a piece of a larger program (a React hook, a polyfill import) carries
// <!-- fragment --> just before it and is skipped. Every script tag in an
// html block that sets data-* attributes must name only those the
// script-tag build reads, and pass readScriptOptions as the build would.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { readScriptOptions } from '../../../packages/adapter/src/script-options.ts';
import {
  codeBlocks,
  datasetKey,
  markdownIn,
  readRepo,
  ROOT,
  scriptTagAttributes,
} from '../src/doc-files.ts';

const DOCS = [...markdownIn('docs/guide'), 'README.md', 'packages/adapter/README.md'];
const SCRIPT_LANGS = new Set(['ts', 'typescript', 'js', 'javascript', 'mjs']);
/** A block that declares document.modelContext for TypeScript. */
const DECLARES_MODEL_CONTEXT = /interface Document\s*\{[^}]*\bmodelContext\b/;

// Under tests/e2e, so @tabdock/adapter, @tabdock/protocol and the MCP SDK
// resolve through the workspace, and in its ignored test-results, so no
// tool lints or commits what a failed run leaves.
const results = join(ROOT, 'tests/e2e/test-results');
mkdirSync(results, { recursive: true });
const scratch = mkdtempSync(join(results, 'doc-snippets-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Snippet {
  readonly where: string;
  readonly file: string;
}

/** Writes each script block as a module of its own. */
function writeSnippets(): Snippet[] {
  const snippets: Snippet[] = [];
  for (const doc of DOCS) {
    codeBlocks(readRepo(doc))
      .filter((block) => SCRIPT_LANGS.has(block.lang) && !block.fragment)
      .forEach((block, index) => {
        const typed = block.lang === 'ts' || block.lang === 'typescript';
        const name = `${doc.replace(/[^A-Za-z0-9]+/g, '-')}-${String(index + 1)}.${typed ? 'ts' : 'js'}`;
        const file = join(scratch, name);
        // Every block is a module, so two blocks never share a scope.
        writeFileSync(file, `${block.body}\nexport {};\n`);
        snippets.push({ where: `${doc}:${String(block.line)}`, file });
      });
  }
  return snippets;
}

/** The base strict settings, with the DOM, Node and JavaScript checked too. */
function compilerOptions(): ts.CompilerOptions {
  const base = ts.readConfigFile(join(ROOT, 'tsconfig.base.json'), (path) => ts.sys.readFile(path));
  const parsed = ts.parseJsonConfigFileContent(base.config, ts.sys, ROOT);
  return {
    ...parsed.options,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: ['node'],
    typeRoots: [join(ROOT, 'node_modules/@types')],
    allowJs: true,
    checkJs: true,
    noEmit: true,
  };
}

function diagnosticsFor(snippets: readonly Snippet[]): string[] {
  const program = ts.createProgram({
    rootNames: snippets.map((snippet) => snippet.file),
    options: compilerOptions(),
  });
  const where = new Map(snippets.map((snippet) => [snippet.file, snippet.where]));
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    const file = diagnostic.file;
    if (file === undefined) return message;
    const { line } = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    const block = where.get(file.fileName) ?? relative(ROOT, file.fileName);
    return `${block} (block line ${String(line + 1)}): ${message}`;
  });
}

/** Each script tag's data-* attributes in an html block, by tag. */
function scriptTagData(html: string): Record<string, string>[] {
  return [...html.matchAll(/<script\b([^>]*)>/g)].map(([, attributes]) =>
    Object.fromEntries(
      [...(attributes ?? '').matchAll(/\s(data-[a-z-]+)\s*=\s*"([^"]*)"/g)].map(
        ([, name, value]) => [name ?? '', value ?? ''],
      ),
    ),
  );
}

describe('code in the guide and READMEs', () => {
  const snippets = writeSnippets();

  it('finds blocks to check, and skips those marked as fragments', () => {
    expect(snippets.length).toBeGreaterThanOrEqual(4);
    expect(snippets.map((snippet) => snippet.where)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^README\.md:/)]),
    );
  });

  it('include a declaration of document.modelContext in the guide', () => {
    const declaring = markdownIn('docs/guide').filter((doc) =>
      codeBlocks(readRepo(doc)).some(
        (block) =>
          !block.fragment &&
          SCRIPT_LANGS.has(block.lang) &&
          DECLARES_MODEL_CONTEXT.test(block.body),
      ),
    );
    expect(declaring).not.toEqual([]);
  });

  it('typechecks against the workspace packages under strict settings', () => {
    expect(diagnosticsFor(snippets)).toEqual([]);
  }, 120_000);

  it('would fail a block that uses document.modelContext with no declaration beside it', () => {
    const file = join(scratch, 'undeclared.ts');
    writeFileSync(file, 'void document.modelContext;\nexport {};\n');
    expect(diagnosticsFor([{ where: 'undeclared', file }])).not.toEqual([]);
  }, 120_000);

  it('would fail a block that names an option attach() lacks', () => {
    const file = join(scratch, 'broken.ts');
    writeFileSync(
      file,
      "import { attach } from '@tabdock/adapter';\nattach({ relay: 'ws://127.0.0.1:8787/page', polcy: {} });\nexport {};\n",
    );
    expect(diagnosticsFor([{ where: 'broken', file }])).not.toEqual([]);
  }, 120_000);
});

describe('script tags in html blocks', () => {
  const known = new Set(scriptTagAttributes());
  const tags = DOCS.flatMap((doc) =>
    codeBlocks(readRepo(doc))
      .filter((block) => block.lang === 'html')
      .flatMap((block) =>
        scriptTagData(block.body)
          .filter((data) => Object.keys(data).length > 0)
          .map((data) => ({ where: `${doc}:${String(block.line)}`, data })),
      ),
  );

  it('are found, and the build reads data-relay', () => {
    expect(tags.length).toBeGreaterThanOrEqual(3);
    expect(known.has('data-relay')).toBe(true);
  });

  it('use only attributes the script-tag build reads, with values it accepts', () => {
    const problems = tags.flatMap(({ where, data }) => {
      const unknown = Object.keys(data)
        .filter((name) => !known.has(name))
        .map((name) => `${where}: ${name} is not an attribute the build reads`);
      const dataset = Object.fromEntries(
        Object.entries(data).map(([name, value]) => [datasetKey(name), value]),
      );
      const read = readScriptOptions(dataset);
      return read.ok ? unknown : [...unknown, `${where}: ${read.error}`];
    });
    expect(problems).toEqual([]);
  });
});

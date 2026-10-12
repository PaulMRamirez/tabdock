// The package, app and test READMEs say what each holds (the docs pass after
// M6, when a third of M6's modules, entries and specs had reached none). Each
// module directly in a package's src, but its index.ts and version.ts, is
// named in that package's README; each subpath its package.json exports, or
// publishes through publishConfig, is named there too; each value the
// adapter's entry exports is named in its README and on guide page 04 or 13,
// where a page author looks it up; every test and spec in tests/e2e is named
// in that package's README; and every directory under apps/ and tests/ has a
// README of its own. The protocol README's line for images.ts also names each
// check that module runs on an image's bytes, animation included.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ImageRefusal } from '@tabdock/protocol';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { existsInRepo, readRepo, ROOT } from '../src/doc-files.ts';

const PACKAGES = ['protocol', 'adapter', 'relay', 'sim-page'] as const;
/** Modules every package has, which say nothing of what it holds. */
const PLUMBING = new Set(['index.ts', 'version.ts']);

interface Manifest {
  name: string;
  exports?: Record<string, unknown>;
  publishConfig?: { exports?: Record<string, unknown> };
}

/** The non-test modules directly in a package's src. */
function modulesOf(dir: string): string[] {
  return readdirSync(join(ROOT, dir, 'src'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name)
    .filter((name) => !name.endsWith('.test.ts') && !PLUMBING.has(name))
    .sort();
}

/** Each subpath a package.json exports or publishes, but the root and package.json. */
function subpathsOf(manifest: Manifest): string[] {
  const keys = [
    ...Object.keys(manifest.exports ?? {}),
    ...Object.keys(manifest.publishConfig?.exports ?? {}),
  ];
  return [...new Set(keys)].filter((key) => key !== '.' && key !== './package.json').sort();
}

/** Whether a README names a subpath, by its import name or as the key itself. */
function namesSubpath(readme: string, name: string, key: string): boolean {
  return readme.includes(`${name}${key.slice(1)}`) || readme.includes(`\`${key}\``);
}

/** The values (never types) an entry module exports, by their exported names. */
function valueExports(path: string): string[] {
  const source = ts.createSourceFile(path, readRepo(path), ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  const exported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      const clause = statement.exportClause;
      if (clause === undefined || !ts.isNamedExports(clause)) continue;
      for (const element of clause.elements) {
        if (!element.isTypeOnly) names.push(element.name.text);
      }
    } else if (ts.isFunctionDeclaration(statement) && exported(statement)) {
      if (statement.name !== undefined) names.push(statement.name.text);
    } else if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
    }
  }
  return names;
}

/** Whether `text` names `word` whole, so `sessionRecord` is not found in `sessionRecordJson`. */
function namesWord(text: string, word: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${word}(?![A-Za-z0-9_])`).test(text);
}

/**
 * Whether `text` names the file `name` whole, alone or after a directory, so
 * `tools.ts` is not found in `proposal-tools.ts`.
 */
function namesFile(text: string, name: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_-])${name.replaceAll('.', '\\.')}(?![A-Za-z0-9_])`).test(text);
}

/** The files in a directory whose names end with `suffix`. */
function filesEnding(dir: string, suffix: string): string[] {
  return readdirSync(join(ROOT, dir))
    .filter((name) => name.endsWith(suffix))
    .sort();
}

/** The directories directly under `dir`. */
function directoriesIn(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
    .map((entry) => `${dir}/${entry.name}`)
    .sort();
}

describe('the package READMEs', () => {
  for (const name of PACKAGES) {
    const dir = `packages/${name}`;
    const readme = readRepo(`${dir}/README.md`);

    it(`name each module in ${dir}/src`, () => {
      const modules = modulesOf(dir);
      expect(modules.length).toBeGreaterThan(0);
      expect(modules.filter((module) => !namesFile(readme, module))).toEqual([]);
    });

    it(`name each subpath ${dir}/package.json exports`, () => {
      const manifest = JSON.parse(readRepo(`${dir}/package.json`)) as Manifest;
      expect(
        subpathsOf(manifest).filter((key) => !namesSubpath(readme, manifest.name, key)),
      ).toEqual([]);
    });
  }

  it("say, in the protocol README, each check images.ts runs on an image's bytes", () => {
    // Keyed by ImageRefusal, so a new refusal fails typecheck until it has its words here.
    // undeclared and off read the policy and the cap, never the image.
    const words: Record<ImageRefusal, string | null> = {
      undeclared: null,
      off: null,
      type: 'type',
      size: 'size',
      encoding: 'base64',
      signature: 'first bytes',
      dimensions: 'header dimensions',
      animated: 'animated',
    };
    const readme = readRepo('packages/protocol/README.md');
    const start = readme.indexOf('`images.ts`');
    expect(start).toBeGreaterThan(-1);
    const clause = readme.slice(start, readme.indexOf(';', start));
    const unsaid = Object.values(words).filter((word) => word !== null && !clause.includes(word));
    expect(unsaid).toEqual([]);
  });

  it("name each value the adapter's entry exports, in its README and on page 04 or 13", () => {
    const values = valueExports('packages/adapter/src/index.ts');
    for (const expected of ['attach', 'STATE_EVENT', 'DEFAULT_IMAGE_BYTES', 'sessionRecordJson']) {
      expect(values).toContain(expected);
    }
    const readme = readRepo('packages/adapter/README.md');
    const guide = `${readRepo('docs/guide/04-adapter-reference.md')}\n${readRepo('docs/guide/13-the-control-handle.md')}`;
    expect(values.filter((value) => !namesWord(readme, value))).toEqual([]);
    expect(values.filter((value) => !namesWord(guide, value))).toEqual([]);
  });
});

describe('the test READMEs', () => {
  it('name every test and spec in tests/e2e', () => {
    const readme = readRepo('tests/e2e/README.md');
    const files = [
      ...filesEnding('tests/e2e/test', '.test.ts'),
      ...filesEnding('tests/e2e/specs', '.spec.ts'),
    ];
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((file) => !namesFile(readme, file))).toEqual([]);
  });

  it('are there for every directory under apps/ and tests/', () => {
    const dirs = [...directoriesIn('apps'), ...directoriesIn('tests')];
    expect(dirs).toContain('apps/site');
    expect(dirs.filter((dir) => !existsInRepo(`${dir}/README.md`))).toEqual([]);
  });
});

describe('these checks', () => {
  it('would fail a module, a subpath or an export left unnamed', () => {
    expect(
      namesSubpath('Import `@tabdock/adapter/testing`.', '@tabdock/adapter', './testing'),
    ).toBe(true);
    expect(namesSubpath('The `./test/phone` entry.', '@tabdock/relay', './test/phone')).toBe(true);
    expect(namesSubpath('Import the adapter.', '@tabdock/adapter', './testing')).toBe(false);
    expect(namesWord('`sessionRecordJson` writes JSON', 'sessionRecord')).toBe(false);
    expect(namesWord('`sessionRecord()` reads it', 'sessionRecord')).toBe(true);
    expect(namesFile('`proposal-tools.ts` holds them', 'tools.ts')).toBe(false);
    expect(namesFile('`src/tools.ts` holds them', 'tools.ts')).toBe(true);
    expect(namesFile('see state-freeze.spec.ts', 'freeze.spec.ts')).toBe(false);
    expect(
      subpathsOf({
        name: '@tabdock/x',
        exports: { '.': './a.ts', './core': './c.ts' },
        publishConfig: { exports: { '.': './a.js', './testing': './t.js', './package.json': '' } },
      }),
    ).toEqual(['./core', './testing']);
    // Types are no values: AttachOptions and the protocol's types are left out.
    const values = valueExports('packages/adapter/src/index.ts');
    expect(values).not.toContain('AttachOptions');
    expect(values).not.toContain('PolicyInput');
    expect(modulesOf('packages/adapter')).not.toContain('index.ts');
  });
});

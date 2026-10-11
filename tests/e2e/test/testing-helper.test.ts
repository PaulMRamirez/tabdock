// ADR 0041: @tabdock/adapter/testing ships in the adapter's tarball but never
// in what a page loads. The script-tag build, made here in memory exactly as
// it ships, holds none of the helper's words, and no module the script tag or
// attach() reaches imports the helper or the protocol's DevTools schemas. The
// helper itself imports only the widget's names and the protocol, so a test
// process that loads it loads no DOM code.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scriptTagFile } from '../../../packages/adapter/scripts/script-tag-build.ts';

const ADAPTER_SRC = join(import.meta.dirname, '../../../packages/adapter/src');

/** Imports and re-exports with `from`. */
const FROM = /^\s*(?:import|export)\b[^;]*?\bfrom\s+(['"])([^'"]+)\1/gm;
/** Imports for their side effects alone, such as `import './zod-config.ts'`. */
const BARE = /^\s*import\s+(['"])([^'"]+)\1/gm;
/** import() of a plain string. */
const DYNAMIC = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

/**
 * Every specifier a module imports or re-exports, in every form, so a module
 * pulled in for its side effects alone, or loaded later, is in the graph too.
 * Throws for an import() of anything but a plain string, which no reading of
 * the source can follow.
 */
function importsOf(source: string): string[] {
  const dynamic = [...source.matchAll(DYNAMIC)];
  if (dynamic.length < (source.match(/\bimport\s*\(/g)?.length ?? 0)) {
    throw new Error('an import whose specifier is not a plain string');
  }
  return [...source.matchAll(FROM), ...source.matchAll(BARE), ...dynamic].map(
    (match) => match[2] ?? '',
  );
}

/** Every adapter module an entry reaches through relative imports, and every package it names. */
async function reach(entry: string): Promise<{ modules: Set<string>; packages: Set<string> }> {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (modules.has(next)) continue;
    modules.add(next);
    for (const specifier of importsOf(await readFile(join(ADAPTER_SRC, next), 'utf8'))) {
      if (specifier.startsWith('./')) queue.push(specifier.slice(2));
      else packages.add(specifier);
    }
  }
  return { modules, packages };
}

describe('the import reader the graph checks stand on', () => {
  it('names every form of import and re-export, side effects and dynamic ones too', () => {
    const source = [
      "import './zod-config.ts';",
      "import { a } from './a.ts';",
      'import type { B } from "./b.ts";',
      "export * from './c.ts';",
      "export { d } from './d.ts';",
      'import {',
      '  e,',
      "} from '@tabdock/protocol';",
      "const f = await import('./f.ts');",
      'const g = await import("./g.ts");',
    ].join('\n');
    expect(importsOf(source).sort()).toEqual([
      './a.ts',
      './b.ts',
      './c.ts',
      './d.ts',
      './f.ts',
      './g.ts',
      './zod-config.ts',
      '@tabdock/protocol',
    ]);
  });

  it('refuses an import it cannot name, rather than leave it out of the graph', () => {
    expect(() => importsOf('const h = await import(`./${name}.ts`);')).toThrow(
      'an import whose specifier is not a plain string',
    );
  });
});

describe('the testing helper', () => {
  it('is in no script-tag build', async () => {
    const built = new TextDecoder().decode(await scriptTagFile());
    for (const word of [
      'Input.dispatchMouseEvent',
      'DOM.getNodeForLocation',
      'in an unexpected shape',
      'waiting attach requests match',
    ]) {
      expect(built.includes(word), word).toBe(false);
    }
  }, 60_000);

  it('is reached from neither the script tag nor attach(), and neither are the DevTools schemas', async () => {
    for (const entry of ['script-tag.ts', 'index.ts']) {
      const { modules, packages } = await reach(entry);
      expect(modules.has('testing.ts'), entry).toBe(false);
      expect(packages.has('@tabdock/protocol/devtools'), entry).toBe(false);
    }
  });

  it('imports only the widget names and the protocol', async () => {
    const { modules, packages } = await reach('testing.ts');
    expect([...modules].sort()).toEqual(['testing.ts', 'widget-names.ts']);
    expect([...packages].sort()).toEqual(['@tabdock/protocol', '@tabdock/protocol/devtools']);
  });
});

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

/** Every specifier a module imports or re-exports. */
function importsOf(source: string): string[] {
  return [...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gm)].map(
    (match) => match[1] ?? '',
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

// Every docs/ path the code names, in what it prints or in a comment, must
// exist in the checkout: a banner or a check that sends someone to a page
// that is not there leaves them stuck at the first step (the local mode
// banner once pointed at docs/deploy.md before it existed).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../src/local-harness.ts';

const SOURCE_DIRS = ['packages', 'apps', 'scripts', 'tests'];
const SKIP = new Set(['node_modules', 'dist', 'test-results', 'playwright-report', '.vite']);
const DOC_PATH = /\bdocs\/[A-Za-z0-9._/-]+\.md\b/g;

/** Every source file under `dir` but this one, which names the docs it looks for. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (path === import.meta.filename) return [];
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|js|html)$/.test(entry.name) ? [path] : [];
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

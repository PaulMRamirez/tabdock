// What the canvas map page is built from: the MCP-B polyfill at exactly 5.1.0,
// the adapter and the sim page, and nothing else, so it can never draw with a
// map library (a new dependency CLAUDE.md would have to approve) and the
// polyfill it runs on is the one the M0 baseline measured. Its source imports
// only those, and it stays private, so no registry ever serves it.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = new URL('..', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8')) as {
  name: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const ALLOWED = ['@mcp-b/webmcp-polyfill', '@tabdock/adapter', '@tabdock/sim-page'];

describe('the map page package', () => {
  it('depends on exactly the polyfill at 5.1.0, the adapter and the sim page', () => {
    expect(manifest.name).toBe('@tabdock/map-page');
    expect(manifest.private).toBe(true);
    expect(manifest.dependencies).toEqual({
      '@mcp-b/webmcp-polyfill': '5.1.0',
      '@tabdock/adapter': 'workspace:*',
      '@tabdock/sim-page': 'workspace:*',
    });
    // Only the bundler beside them, and no other kind of dependency at all.
    expect(manifest.devDependencies).toEqual({ esbuild: '0.28.2' });
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
  });

  it('imports nothing in its page but those and its own files', () => {
    const sources = readdirSync(join(DIR, 'src')).filter((name) => name.endsWith('.ts'));
    expect(sources).toEqual(expect.arrayContaining(['main.ts', 'render.ts', 'webmcp.ts']));
    const imported = sources.flatMap((name) =>
      [
        ...readFileSync(join(DIR, 'src', name), 'utf8').matchAll(
          /\bfrom\s+'([^']+)'|\bimport\s+'([^']+)'/g,
        ),
      ].map((match) => match[1] ?? match[2] ?? ''),
    );
    const outside = imported.filter(
      (specifier) =>
        !specifier.startsWith('./') &&
        !ALLOWED.some((name) => specifier === name || specifier.startsWith(`${name}/`)),
    );
    expect(outside).toEqual([]);
    expect(imported).toEqual(expect.arrayContaining(['@tabdock/sim-page/map', '@tabdock/adapter']));
  });

  it('is pinned the same way in the lockfile', () => {
    const lock = readFileSync(join(DIR, '../../pnpm-lock.yaml'), 'utf8');
    const start = lock.indexOf('\n  tests/map-page:\n');
    expect(start).toBeGreaterThan(0);
    const end = lock.indexOf('\n\n', start + 1);
    const entry = lock.slice(start, end);
    expect(entry).toContain(
      "'@mcp-b/webmcp-polyfill':\n        specifier: 5.1.0\n        version: 5.1.0",
    );
    expect([...entry.matchAll(/^ {6}(\S+):$/gm)].map((match) => match[1])).toEqual([
      "'@mcp-b/webmcp-polyfill'",
      "'@tabdock/adapter'",
      "'@tabdock/sim-page'",
      'esbuild',
    ]);
  });
});

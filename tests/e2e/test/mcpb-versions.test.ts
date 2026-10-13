// Which MCP-B a test runs (ADR 0047, after M5 decision D4 and ADR 0032). The
// demo and the baseline stay on 5.1.0 while one leg runs 6.0.0, and both
// versions of @mcp-b/webmcp-local-relay declare the bin webmcp-local-relay:
// with both in this package pnpm linked the 6 one, so `pnpm exec
// webmcp-local-relay` here, as MCP-B's docs write it, ran 6 without a word.
// 6.0.0 lives in @tabdock/mcpb6 and is reached by path alone, pinned exactly,
// since a range would let the leg move to a release nobody has read.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MCPB6_LOCAL_RELAY_CLI,
  MCPB6_POLYFILL_MODULE,
  MCPB6_POLYFILL_SCRIPT,
} from '@tabdock/mcpb6';
import { describe, expect, it } from 'vitest';

const E2E = fileURLToPath(new URL('..', import.meta.url));
const MCPB6 = fileURLToPath(new URL('../../mcpb6', import.meta.url));
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** The name and version of the package a file under its dist/ belongs to. */
function packageOf(file: string): { name: string; version: string } {
  const manifest = join(dirname(dirname(file)), 'package.json');
  return JSON.parse(readFileSync(manifest, 'utf8')) as { name: string; version: string };
}

/** A package.json's dependencies of both kinds, by name. */
function dependenciesOf(dir: string): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return { ...manifest.dependencies, ...manifest.devDependencies };
}

describe('MCP-B versions in the tests (ADRs 0032 and 0047)', () => {
  it('resolves the local relay the harness runs to 5.1.0', () => {
    // As harness.ts resolves RELAY_CLI.
    const cli = fileURLToPath(
      new URL('./cli.mjs', import.meta.resolve('@mcp-b/webmcp-local-relay')),
    );
    expect(packageOf(cli)).toMatchObject({ name: '@mcp-b/webmcp-local-relay', version: '5.1.0' });
  });

  it('links the bare webmcp-local-relay bin here to 5.1.0, never the 6 one', () => {
    const shim = readFileSync(join(E2E, 'node_modules', '.bin', 'webmcp-local-relay'), 'utf8');
    expect(shim).toContain('@mcp-b/webmcp-local-relay/dist/cli.mjs');
    expect(shim).not.toMatch(/webmcp-local-relay(-6|@6\.)/);
  });

  it('keeps the demo and the map demo, whose pages people open, on exactly 5.1.0', () => {
    for (const app of ['apps/demo', 'apps/map-demo']) {
      const mcpb = Object.entries(dependenciesOf(join(ROOT, app))).filter(([name]) =>
        name.startsWith('@mcp-b/'),
      );
      expect(mcpb, app).toContainEqual(['@mcp-b/webmcp-polyfill', '5.1.0']);
      for (const [name, spec] of mcpb) expect(spec, `${app} ${name}`).toBe('5.1.0');
    }
  });

  it('depends here on no MCP-B package but 5.1.0', () => {
    const mcpb = Object.entries(dependenciesOf(E2E)).filter(
      ([name, spec]) => name.startsWith('@mcp-b/') || spec.includes('@mcp-b/'),
    );
    expect(mcpb.length).toBeGreaterThan(0);
    for (const [name, spec] of mcpb) expect(spec, name).toBe('5.1.0');
  });

  it('pins @tabdock/mcpb6 to exactly 6.0.0, under names no 5.1.0 import can reach', () => {
    const mcpb = Object.entries(dependenciesOf(MCPB6)).filter(([, spec]) =>
      spec.includes('@mcp-b/'),
    );
    expect(Object.fromEntries(mcpb)).toEqual({
      'webmcp-local-relay-6': 'npm:@mcp-b/webmcp-local-relay@6.0.0',
      'webmcp-polyfill-6': 'npm:@mcp-b/webmcp-polyfill@6.0.0',
    });
  });

  it('reaches 6.0.0 through @tabdock/mcpb6 alone', () => {
    expect(packageOf(MCPB6_LOCAL_RELAY_CLI)).toMatchObject({
      name: '@mcp-b/webmcp-local-relay',
      version: '6.0.0',
    });
    for (const file of [MCPB6_POLYFILL_MODULE, MCPB6_POLYFILL_SCRIPT]) {
      expect(packageOf(file)).toMatchObject({ name: '@mcp-b/webmcp-polyfill', version: '6.0.0' });
    }
    for (const file of [MCPB6_LOCAL_RELAY_CLI, MCPB6_POLYFILL_MODULE, MCPB6_POLYFILL_SCRIPT]) {
      expect(readFileSync(file).byteLength).toBeGreaterThan(0);
    }
  });

  it('lists the esbuild that wraps the ESM entry as a development dependency, as the whole workspace does', () => {
    // Dependabot merges a package's listings from every manifest and counts it
    // as production if any one lists it under dependencies; a single listing
    // here would move every esbuild bump into the runtime group, the one read
    // as shipped code (.github/dependabot.yml, docs/notes/verified.md).
    const manifest = (dir: string) =>
      JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
    expect(Object.keys(manifest(MCPB6).dependencies ?? {}).toSorted()).toEqual([
      'webmcp-local-relay-6',
      'webmcp-polyfill-6',
    ]);
    const workspace = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
    const globs = [...workspace.matchAll(/^ {2}- (\S+)$/gm)].map((match) => match[1] ?? '');
    const members = globs.flatMap((glob) =>
      glob.endsWith('/*')
        ? readdirSync(join(ROOT, glob.slice(0, -2)), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(ROOT, glob.slice(0, -2), entry.name))
        : [join(ROOT, glob)],
    );
    const listings = members
      .filter((dir) => existsSync(join(dir, 'package.json')))
      .map((dir) => ({ dir, ...manifest(dir) }))
      .filter(
        (m) => m.dependencies?.esbuild !== undefined || m.devDependencies?.esbuild !== undefined,
      );
    expect(listings.map((m) => m.dir)).toContain(MCPB6);
    for (const { dir, dependencies, devDependencies } of listings) {
      expect(dependencies?.esbuild, dir).toBeUndefined();
      expect(devDependencies?.esbuild, dir).toBe('0.28.2');
    }
  });

  it("takes the polyfill's ESM entry, whose one export is installWebMCP", () => {
    // That importing it installs nothing is shown in the browser, where
    // specs/mcpb6.spec.ts reads installedOnImport before the call.
    const source = readFileSync(MCPB6_POLYFILL_MODULE, 'utf8');
    expect(source.match(/^export \{.*\};$/gm)).toEqual(['export { installWebMCP };']);
  });
});

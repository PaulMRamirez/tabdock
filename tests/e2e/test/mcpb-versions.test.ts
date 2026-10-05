// Which MCP-B a test runs (M5 decision D4, ADR 0032). The demo and the
// baseline stay on 5.1.0 while one leg runs the 6.0 beta, and both versions
// of @mcp-b/webmcp-local-relay declare the bin webmcp-local-relay: with both
// in this package pnpm linked the beta's, so `pnpm exec webmcp-local-relay`
// here, as MCP-B's docs write it, ran the beta without a word. The beta now
// lives in @tabdock/mcpb6 and is reached by path alone.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCPB6_LOCAL_RELAY_CLI, MCPB6_POLYFILL_SCRIPT } from '@tabdock/mcpb6';
import { describe, expect, it } from 'vitest';

const E2E = fileURLToPath(new URL('..', import.meta.url));

/** The name and version of the package a file under its dist/ belongs to. */
function packageOf(file: string): { name: string; version: string } {
  const manifest = join(dirname(dirname(file)), 'package.json');
  return JSON.parse(readFileSync(manifest, 'utf8')) as { name: string; version: string };
}

describe('MCP-B versions in the tests (ADR 0032)', () => {
  it('resolves the local relay the harness runs to 5.1.0', () => {
    // As harness.ts resolves RELAY_CLI.
    const cli = fileURLToPath(
      new URL('./cli.mjs', import.meta.resolve('@mcp-b/webmcp-local-relay')),
    );
    expect(packageOf(cli)).toMatchObject({ name: '@mcp-b/webmcp-local-relay', version: '5.1.0' });
  });

  it('links the bare webmcp-local-relay bin here to 5.1.0, never the beta', () => {
    const shim = readFileSync(join(E2E, 'node_modules', '.bin', 'webmcp-local-relay'), 'utf8');
    expect(shim).toContain('@mcp-b/webmcp-local-relay/dist/cli.mjs');
    expect(shim).not.toMatch(/6-beta|6\.0\.0-beta/);
  });

  it('depends here on no MCP-B package but 5.1.0', () => {
    const manifest = JSON.parse(readFileSync(join(E2E, 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    const mcpb = Object.entries(manifest.devDependencies).filter(
      ([name, spec]) => name.startsWith('@mcp-b/') || spec.includes('@mcp-b/'),
    );
    expect(mcpb.length).toBeGreaterThan(0);
    for (const [name, spec] of mcpb) expect(spec, name).toBe('5.1.0');
  });

  it('reaches the 6.0 beta through @tabdock/mcpb6 alone', () => {
    for (const file of [MCPB6_LOCAL_RELAY_CLI, MCPB6_POLYFILL_SCRIPT]) {
      expect(packageOf(file).version).toMatch(/^6\.0\.0-beta\./);
      expect(readFileSync(file).byteLength).toBeGreaterThan(0);
    }
  });
});

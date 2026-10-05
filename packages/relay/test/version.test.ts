// The relay names the release that runs (ADR 0028): RELAY_VERSION, which the
// MCP server info and every relay_start audit record carry, stays a constant
// and equals @tabdock/relay's package.json version, which `tabdock-relay
// --version` prints; and the three published packages move in lockstep, one
// version in all three (Step 4 of M5 bumps them together, with
// ADAPTER_VERSION and RELAY_VERSION).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packageVersion } from '../src/cli.ts';
import { RELAY_VERSION } from '../src/mcp.ts';

const PACKAGES = resolve(import.meta.dirname, '../..');

function versionOf(name: string): string {
  const manifest = JSON.parse(readFileSync(resolve(PACKAGES, name, 'package.json'), 'utf8')) as {
    version: string;
  };
  return manifest.version;
}

describe('the relay version', () => {
  it('RELAY_VERSION equals the package version that --version prints', () => {
    expect(RELAY_VERSION).toBe(versionOf('relay'));
    expect(packageVersion()).toBe(versionOf('relay'));
  });

  it('protocol, adapter and relay share one version', () => {
    expect(new Set(['protocol', 'adapter', 'relay'].map(versionOf)).size).toBe(1);
  });
});

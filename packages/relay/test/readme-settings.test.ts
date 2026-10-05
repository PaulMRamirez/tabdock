// The relay's README ships in the npm tarball and says it describes the
// relay in full, and an `npx` user has no .env.example to read: so every
// setting the relay's source reads must be named in the README, and in
// .env.example for a checkout. M5's two settings once reached only the
// latter, and the Origin list is the fix when a trusted client is refused.

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../src/', import.meta.url);
const SETTING = /\bTABDOCK_[A-Z0-9_]+\b/g;
/** A constant the bundle defines at build time (ADR 0028), never a setting anyone sets. */
const BUILD_CONSTANTS = new Set(['TABDOCK_PACKAGED']);

function namesIn(text: string): Set<string> {
  return new Set(text.match(SETTING) ?? []);
}

function sourceSettings(): string[] {
  const names = new Set<string>();
  for (const entry of readdirSync(SRC, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const path = new URL(`${entry.parentPath}/${entry.name}`, 'file://');
    for (const name of namesIn(readFileSync(path, 'utf8'))) names.add(name);
  }
  return [...names].sort();
}

describe('the settings the relay reads', () => {
  const settings = sourceSettings();

  it('are found in the source at all', () => {
    expect(settings).toEqual(
      expect.arrayContaining(['TABDOCK_FIRST_CLASS_TOOLS', 'TABDOCK_MCP_ALLOWED_ORIGINS']),
    );
  });

  it('are each named in the README the package ships', () => {
    const readme = namesIn(readFileSync(new URL('../README.md', import.meta.url), 'utf8'));
    expect(settings.filter((name) => !readme.has(name))).toEqual([]);
  });

  it('are each in .env.example, but for build constants', () => {
    const example = namesIn(
      readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'),
    );
    expect(settings.filter((name) => !BUILD_CONSTANTS.has(name) && !example.has(name))).toEqual([]);
  });
});

// Runs before every test file. Local mode keeps its owner token in a per-user
// directory chosen from these five variables (ADR 0022), so each test file
// gets throwaway ones and no test reads or writes the real home. The token
// directory itself is left for the relay to make, since it must be 0700.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const base = mkdtempSync(join(tmpdir(), 'tabdock-test-home-'));
for (const [name, folder] of [
  ['HOME', 'home'],
  ['USERPROFILE', 'profile'],
  ['XDG_CONFIG_HOME', 'config'],
  ['LOCALAPPDATA', 'local-app-data'],
] as const) {
  const path = join(base, folder);
  mkdirSync(path);
  process.env[name] = path;
}
process.env.TABDOCK_HOME = join(base, 'tabdock');

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

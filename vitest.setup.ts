// Runs before every test file. Local mode keeps its owner token in a per-user
// directory chosen from these five variables (ADR 0022), so each test file
// gets throwaway ones and no test reads or writes the real home. The token
// directory itself is left for the relay to make, since it must be 0700.
// Local mode refuses a token directory below anything another account could
// change, a shared /tmp included (ADR 0028's notes), so TMPDIR first moves to
// a private scratch root: os.tmpdir() in every test, and in every child a
// test starts, then names a place the relay accepts.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { privateTempRoot } from './packages/relay/test/helpers/private-tmp.ts';

process.env.TMPDIR = privateTempRoot();
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

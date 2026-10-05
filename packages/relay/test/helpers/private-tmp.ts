// A directory for test scratch space that local mode accepts as a home for
// its owner token (ADR 0028's notes). The relay refuses a token directory
// below anything another account could change, /tmp included, so tests that
// start local mode cannot keep their throwaway homes in the shared temporary
// directory. This picks the first of these whose every ancestor only this
// account or root can change and that lies in no repository's work tree:
// TABDOCK_TEST_TMPDIR when set, the system's temporary directory (per user on
// macOS), RUNNER_TEMP on a CI runner, XDG_RUNTIME_DIR, and last a cache
// directory under the account's real home, made 0700. vitest.setup.ts points
// TMPDIR at it, so os.tmpdir() in a test, and in every child a test starts,
// names it; scripts that start local mode outside vitest call it themselves.

import { mkdirSync, realpathSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { placeRefusal } from '../../src/local-token.ts';

function candidates(env: NodeJS.ProcessEnv): string[] {
  const listed: (string | undefined)[] = [
    env.TABDOCK_TEST_TMPDIR,
    tmpdir(),
    env.RUNNER_TEMP,
    env.XDG_RUNTIME_DIR,
  ];
  let home: string | undefined;
  try {
    // The account's own home, not HOME, which a test may have pointed elsewhere.
    home = userInfo().homedir;
  } catch {
    home = undefined;
  }
  if (home !== undefined && home !== '') listed.push(join(home, '.cache', 'tabdock-tests'));
  return listed.filter((dir): dir is string => dir !== undefined && dir.trim() !== '');
}

let chosen: string | null = null;

/** The root for scratch directories that local mode accepts; throws, saying why, when there is none. */
export function privateTempRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (chosen !== null) return chosen;
  const refused: string[] = [];
  for (const candidate of candidates(env)) {
    try {
      mkdirSync(candidate, { recursive: true, mode: 0o700 });
      const real = realpathSync(candidate);
      // A token directory just inside it is what the tests will make.
      const refusal = placeRefusal(join(real, 'probe'));
      if (refusal === null) {
        chosen = real;
        return real;
      }
      refused.push(`${real}: ${refusal}`);
    } catch (error) {
      refused.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    `no directory for test scratch space that local mode would accept; set TABDOCK_TEST_TMPDIR to a directory only you can change, outside any repository:\n${refused.join('\n')}`,
  );
}

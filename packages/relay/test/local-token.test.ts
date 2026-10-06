// Local mode's owner token file (ADR 0022, the M4 plan): where it lives on
// each platform, the first start and the next, a race between two starts, and
// every refusal, each naming the path and the fix and never the contents.
// From ADR 0028: the refusal of a token directory inside any repository's work
// tree, in a checkout and in the package alike, and `--new-token`'s draw and
// rename. Another account's ownership is played through an injected stat,
// since the sandbox runs as root; other platforms through an injected
// platform and environment. The vitest setup points every home variable at a
// throwaway directory, and these tests name their own TABDOCK_HOME besides.
// A work tree here is a directory holding a `.git` entry made by hand, which
// is all the rule looks for.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import {
  drawOwnerToken,
  type FileFacts,
  GIVEN_HOME,
  HEADERS_HELPER_FILE,
  loadOwnerToken,
  type LocalTokenSystem,
  OWNER_TOKEN_FILE,
  OwnerTokenError,
  ownerTokenDirectory,
  pathNames,
  readOwnerToken,
  type TokenEnv,
} from '../src/local-token.ts';
import { leakIn } from './helpers/secrecy.ts';

const POSIX = process.platform !== 'win32';
const CHECKOUT = resolve(import.meta.dirname, '../../..');
const TOKEN_SHAPE = /^tabdock_[A-Za-z0-9_-]{43}$/;
/** What a POSIX start leaves in the token directory: the token and its header helper (ADR 0028). */
const BESIDE_TOKEN = POSIX ? [HEADERS_HELPER_FILE, OWNER_TOKEN_FILE].sort() : [OWNER_TOKEN_FILE];

const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh directory outside the checkout, removed after the test. */
function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tabdock-token-')));
  scratches.push(dir);
  return dir;
}

/** The refusal `run` throws, as text; it must be an OwnerTokenError. */
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerTokenError);
    return error instanceof Error ? error.message : '';
  }
  throw new Error('expected a refusal');
}

/**
 * A refusal about a directory TABDOCK_HOME gave, or something in or above it:
 * named from the setting and never spelled out, since a token may sit in the
 * wrong variable (PathNames in local-token.ts).
 */
function fromHome(message: string, path: string, named = GIVEN_HOME): void {
  expect(message).toContain(named);
  expect(message).not.toContain(path);
}

/** The same facts with another owner, as another account's file would show. */
function ownedBy(facts: FileFacts, uid: number): FileFacts {
  return {
    uid,
    mode: facts.mode,
    size: facts.size,
    isFile: () => facts.isFile(),
    isDirectory: () => facts.isDirectory(),
    isSymbolicLink: () => facts.isSymbolicLink(),
  };
}

/** A token file written by hand, the way a test or an attacker would. */
function plant(home: string, contents: string, mode = 0o600): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, OWNER_TOKEN_FILE);
  writeFileSync(file, contents, { mode });
  chmodSync(file, mode);
  return file;
}

/** A directory the repository rule counts as a git work tree: one holding a `.git` directory. */
function workTreeAt(path: string): string {
  mkdirSync(join(path, '.git'), { recursive: true });
  return path;
}

const SAMPLE = `tabdock_${'Q'.repeat(20)}Zx9-_${'w'.repeat(18)}`;

describe('where the owner token lives (ADR 0022)', () => {
  const linux = { platform: 'linux', homedir: '/injected/home' } as const;

  it('takes TABDOCK_HOME when absolute, and refuses a relative one without repeating it', () => {
    expect(ownerTokenDirectory({ TABDOCK_HOME: ' /srv/me/tokens/ ' }, linux)).toBe(
      resolve('/srv/me/tokens'),
    );
    for (const value of ['tokens', './tokens', '~/tokens', 'tabdock_notapath']) {
      const message = refusal(() => ownerTokenDirectory({ TABDOCK_HOME: value }, linux));
      expect(message).toMatch(/TABDOCK_HOME must be an absolute path/);
      expect(message).not.toContain(value);
    }
  });

  it('on Linux and other Unix systems: $XDG_CONFIG_HOME/tabdock when absolute, else ~/.config/tabdock', () => {
    for (const platform of ['linux', 'freebsd', 'openbsd'] as const) {
      const system = { platform, homedir: '/injected/home' };
      expect(ownerTokenDirectory({ XDG_CONFIG_HOME: '/x/config', HOME: '/x/home' }, system)).toBe(
        join('/x/config', 'tabdock'),
      );
      // XDG Base Directory 0.8: a relative path is invalid and ignored.
      expect(ownerTokenDirectory({ XDG_CONFIG_HOME: 'config', HOME: '/x/home' }, system)).toBe(
        join('/x/home', '.config', 'tabdock'),
      );
      expect(ownerTokenDirectory({ XDG_CONFIG_HOME: '', HOME: '/x/home' }, system)).toBe(
        join('/x/home', '.config', 'tabdock'),
      );
      expect(ownerTokenDirectory({}, system)).toBe(join('/injected/home', '.config', 'tabdock'));
      expect(ownerTokenDirectory({ HOME: 'relative' }, system)).toBe(
        join('/injected/home', '.config', 'tabdock'),
      );
    }
  });

  it('on macOS: ~/Library/Application Support/Tabdock, whatever XDG_CONFIG_HOME says', () => {
    const system = { platform: 'darwin', homedir: '/Users/injected' } as const;
    expect(ownerTokenDirectory({ HOME: '/Users/me', XDG_CONFIG_HOME: '/x/config' }, system)).toBe(
      join('/Users/me', 'Library', 'Application Support', 'Tabdock'),
    );
    expect(ownerTokenDirectory({}, system)).toBe(
      join('/Users/injected', 'Library', 'Application Support', 'Tabdock'),
    );
  });

  it('on Windows: %LOCALAPPDATA%\\Tabdock, else the local profile under %USERPROFILE%', () => {
    const system = { platform: 'win32', homedir: '/injected/profile' } as const;
    expect(
      ownerTokenDirectory({ LOCALAPPDATA: '/p/local', USERPROFILE: '/p', HOME: '/h' }, system),
    ).toBe(join('/p/local', 'Tabdock'));
    expect(ownerTokenDirectory({ USERPROFILE: '/p' }, system)).toBe(
      join('/p', 'AppData', 'Local', 'Tabdock'),
    );
    expect(ownerTokenDirectory({}, system)).toBe(
      join('/injected/profile', 'AppData', 'Local', 'Tabdock'),
    );
  });

  it('reads only the environment it is given, and asks for TABDOCK_HOME when there is no home at all', () => {
    // process.env has a TABDOCK_HOME from the vitest setup; it must not leak in.
    expect(process.env.TABDOCK_HOME).toBeDefined();
    expect(ownerTokenDirectory({ HOME: '/x/home' }, linux)).toBe(
      join('/x/home', '.config', 'tabdock'),
    );
    expect(refusal(() => ownerTokenDirectory({}, { platform: 'linux', homedir: '' }))).toMatch(
      /cannot find your home directory.*set TABDOCK_HOME/,
    );
  });
});

describe('the first start and the next', () => {
  it.skipIf(!POSIX)(
    'creates a 0700 directory and a 0600 file holding tabdock_ and 43 base64url characters',
    () => {
      const base = scratch();
      const home = join(base, 'nested', 'tabdock');
      const owner = loadOwnerToken({ TABDOCK_HOME: home });
      expect(owner.created).toBe(true);
      expect(owner.path).toBe(join(home, OWNER_TOKEN_FILE));
      expect(TOKEN_SHAPE.test(owner.token)).toBe(true);
      expect(readFileSync(owner.path, 'latin1') === `${owner.token}\n`).toBe(true);
      expect(statSync(home).mode & 0o777).toBe(0o700);
      expect(statSync(join(base, 'nested')).mode & 0o777).toBe(0o700);
      expect(statSync(owner.path).mode & 0o777).toBe(0o600);
      // The temporary file it was linked from is gone.
      expect(readdirSync(home).sort()).toEqual(BESIDE_TOKEN);
    },
  );

  it('reuses the file byte for byte on the next start, and draws a different token in another home', () => {
    const home = join(scratch(), 'tabdock');
    const first = loadOwnerToken({ TABDOCK_HOME: home });
    const bytes = readFileSync(first.path);
    const second = loadOwnerToken({ TABDOCK_HOME: home });
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
    expect(second.token === first.token).toBe(true);
    expect(readFileSync(first.path).equals(bytes)).toBe(true);
    const other = loadOwnerToken({ TABDOCK_HOME: join(scratch(), 'tabdock') });
    expect(other.token === first.token).toBe(false);
  });

  it('accepts a file written without its final newline', () => {
    const home = join(scratch(), 'tabdock');
    plant(home, SAMPLE);
    const owner = loadOwnerToken({ TABDOCK_HOME: home });
    expect(owner.created).toBe(false);
    expect(owner.token === SAMPLE).toBe(true);
  });

  it('ends two starts at once with one token, whoever links first', async () => {
    for (let round = 0; round < 5; round += 1) {
      const home = join(scratch(), 'tabdock');
      const gate = new SharedArrayBuffer(8);
      const slots = new Int32Array(gate);
      const racers = 6;
      const fixture = new URL('./fixtures/owner-token-race.ts', import.meta.url);
      const results = Array.from(
        { length: racers },
        () =>
          new Promise<{ ok: boolean; token?: string; created?: boolean; message?: string }>(
            (resolveResult, rejectResult) => {
              const worker = new Worker(fixture, { workerData: { home, gate } });
              worker.once('message', (message: { ok: boolean }) => {
                resolveResult(message);
                void worker.terminate();
              });
              worker.once('error', rejectResult);
            },
          ),
      );
      while (Atomics.load(slots, 0) < racers) {
        await new Promise((wait) => setTimeout(wait, 5));
      }
      Atomics.store(slots, 1, 1);
      Atomics.notify(slots, 1);
      const answers = await Promise.all(results);
      expect(answers.map((answer) => answer.message ?? 'ok')).toEqual(
        Array.from({ length: racers }, () => 'ok'),
      );
      const tokens = new Set(answers.map((answer) => answer.token));
      expect(tokens.size).toBe(1);
      expect(answers.filter((answer) => answer.created === true)).toHaveLength(1);
      expect(readdirSync(home).sort()).toEqual(BESIDE_TOKEN);
    }
  }, 30_000);

  it('a start that loses the race to link reads the winner, leaving its file untouched', () => {
    const home = join(scratch(), 'tabdock');
    const winner = loadOwnerToken({ TABDOCK_HOME: home });
    const bytes = readFileSync(winner.path);
    expect(drawOwnerToken(home)).toBe(false);
    expect(readFileSync(winner.path).equals(bytes)).toBe(true);
    expect(readdirSync(home).sort()).toEqual(BESIDE_TOKEN);
    expect(loadOwnerToken({ TABDOCK_HOME: home }).token === winner.token).toBe(true);
  });

  it('readOwnerToken never creates the directory or the file', () => {
    const home = join(scratch(), 'tabdock');
    expect(readOwnerToken({ TABDOCK_HOME: home })).toBeNull();
    expect(existsSync(home)).toBe(false);
    mkdirSync(home, { mode: 0o700 });
    chmodSync(home, 0o700);
    expect(readOwnerToken({ TABDOCK_HOME: home })).toBeNull();
    expect(readdirSync(home)).toEqual([]);
    const owner = loadOwnerToken({ TABDOCK_HOME: home });
    const read = readOwnerToken({ TABDOCK_HOME: home });
    expect(read?.created).toBe(false);
    expect(read?.path).toBe(owner.path);
    expect(read?.token === owner.token).toBe(true);
  });
});

describe('refusals: each names the path, from TABDOCK_HOME when it gave it, and the fix, never the contents', () => {
  it('a directory inside the checkout, compared by realpath, and nothing is created there', () => {
    const inside = join(CHECKOUT, `.tabdock-token-test-${String(process.pid)}`);
    const docsHome = join(CHECKOUT, 'docs', 'tabdock');
    const rootToken = join(CHECKOUT, OWNER_TOKEN_FILE);
    const rootTokenBefore = existsSync(rootToken);
    // What a regression would leave is removed before and after, so it fails
    // once, leaves no token where git add could stage it, and a later run of
    // the fixed code does not fail on what an earlier run left behind.
    const tidy = (): void => {
      rmSync(inside, { recursive: true, force: true });
      rmSync(docsHome, { recursive: true, force: true });
      if (!rootTokenBefore) rmSync(rootToken, { force: true });
    };
    tidy();
    try {
      for (const load of [loadOwnerToken, readOwnerToken]) {
        const message = refusal(() => load({ TABDOCK_HOME: inside }));
        fromHome(message, inside);
        // The checkout is the relay's own place, so it is named in full.
        expect(message).toContain(`inside the checkout ${realpathSync(CHECKOUT)},`);
        expect(message).toMatch(
          /inside the checkout.*set TABDOCK_HOME to an absolute path outside it/,
        );
        expect(existsSync(inside)).toBe(false);
      }
      // Through a symlink from outside that leads back in.
      const link = join(scratch(), 'link');
      symlinkSync(join(CHECKOUT, 'docs'), link);
      const through = join(link, 'tabdock');
      expect(refusal(() => loadOwnerToken({ TABDOCK_HOME: through }))).toMatch(
        /inside the checkout/,
      );
      expect(existsSync(docsHome)).toBe(false);
      // The checkout itself counts.
      expect(refusal(() => loadOwnerToken({ TABDOCK_HOME: CHECKOUT }))).toMatch(
        /inside the checkout/,
      );
      expect(existsSync(rootToken)).toBe(rootTokenBefore);
    } finally {
      tidy();
    }
  });

  it('compares paths case-insensitively on macOS and Windows, and exactly elsewhere', () => {
    const base = scratch();
    const checkout = join(base, 'Repo');
    mkdirSync(checkout);
    const home = join(base, 'repo', 'tokens');
    for (const platform of ['darwin', 'win32'] as const) {
      expect(
        refusal(() =>
          loadOwnerToken({ TABDOCK_HOME: home, LOCALAPPDATA: base }, { platform, checkout }),
        ),
      ).toMatch(/inside the checkout/);
    }
    expect(existsSync(home)).toBe(false);
    // Only a case-sensitive file system makes repo and Repo two directories.
    if (!existsSync(join(base, 'repo'))) {
      expect(loadOwnerToken({ TABDOCK_HOME: home }, { platform: 'linux', checkout }).created).toBe(
        true,
      );
    }
  });

  it.skipIf(!POSIX)('a directory that another account owns', () => {
    const home = join(scratch(), 'tabdock');
    loadOwnerToken({ TABDOCK_HOME: home });
    const lstat = (path: string): FileFacts =>
      path === home ? ownedBy(lstatSync(path), (process.getuid?.() ?? 0) + 4242) : lstatSync(path);
    for (const load of [loadOwnerToken, readOwnerToken]) {
      const message = refusal(() => load({ TABDOCK_HOME: home }, { lstat }));
      fromHome(message, home);
      expect(message).toMatch(/another account owns it.*delete it and start again/);
    }
    // The same seen from the other side: the relay running as another account,
    // with the directories above played as root's, which every account trusts.
    const uid = (process.getuid?.() ?? 0) + 4242;
    const above = (path: string): FileFacts =>
      path === home ? lstatSync(path) : ownedBy(lstatSync(path), 0);
    const seen = refusal(() => loadOwnerToken({ TABDOCK_HOME: home }, { uid, lstat: above }));
    expect(seen).toContain(`${GIVEN_HOME}: another account owns it`);
    expect(seen).not.toContain(home);
  });

  it.skipIf(!POSIX)('a directory that grants its group or others any permission', () => {
    for (const mode of [0o755, 0o750, 0o710, 0o701, 0o770, 0o707]) {
      const home = join(scratch(), 'tabdock');
      mkdirSync(home);
      chmodSync(home, mode);
      const message = refusal(() => loadOwnerToken({ TABDOCK_HOME: home }));
      fromHome(message, home);
      expect(message).toMatch(new RegExp(`mode ${mode.toString(8)}\\); run chmod 700 on it`));
      // Refused, not repaired, and no token drawn into it.
      expect(statSync(home).mode & 0o777).toBe(mode);
      expect(readdirSync(home)).toEqual([]);
    }
  });

  it('a TABDOCK_HOME that is not a directory', () => {
    const file = join(scratch(), 'not-a-directory');
    writeFileSync(file, 'x');
    const message = refusal(() => loadOwnerToken({ TABDOCK_HOME: file }));
    fromHome(message, file);
    expect(message).toMatch(/not a directory; delete it and start again/);
  });

  it.skipIf(!POSIX)('a file that another account owns', () => {
    const home = join(scratch(), 'tabdock');
    const owner = loadOwnerToken({ TABDOCK_HOME: home });
    const fstat = (fd: number): FileFacts =>
      ownedBy(fstatSync(fd), (process.getuid?.() ?? 0) + 4242);
    for (const load of [loadOwnerToken, readOwnerToken]) {
      const message = refusal(() => load({ TABDOCK_HOME: home }, { fstat }));
      fromHome(message, home, `${OWNER_TOKEN_FILE} in ${GIVEN_HOME}`);
      expect(message).toMatch(/another account owns it.*delete it and start again/);
      expect(leakIn(message, owner.token)).toBeNull();
    }
  });

  it.skipIf(!POSIX)(
    'judges the file by what its open descriptor says, not by its name alone',
    () => {
      const home = join(scratch(), 'tabdock');
      const owner = loadOwnerToken({ TABDOCK_HOME: home });
      // The file on disk is 0600; the descriptor reports what a swapped-in file would.
      const fstat = (fd: number): FileFacts => {
        const facts = fstatSync(fd);
        return {
          uid: facts.uid,
          mode: (facts.mode & ~0o777) | 0o644,
          size: facts.size,
          isFile: () => facts.isFile(),
          isDirectory: () => facts.isDirectory(),
          isSymbolicLink: () => facts.isSymbolicLink(),
        };
      };
      const message = refusal(() => loadOwnerToken({ TABDOCK_HOME: home }, { fstat }));
      expect(message).toMatch(/\(mode 644\); run chmod 600 on it/);
      expect(leakIn(message, owner.token)).toBeNull();
    },
  );

  it.skipIf(!POSIX)('a file that grants its group or others any permission', () => {
    for (const mode of [0o640, 0o604, 0o620, 0o602, 0o644, 0o666]) {
      const home = join(scratch(), 'tabdock');
      const file = plant(home, `${SAMPLE}\n`, mode);
      const message = refusal(() => loadOwnerToken({ TABDOCK_HOME: home }));
      fromHome(message, file, `${OWNER_TOKEN_FILE} in ${GIVEN_HOME}`);
      expect(message).toMatch(
        /chmod 600 on it if nobody else could have read it.*delete it and start again/,
      );
      expect(leakIn(message, SAMPLE)).toBeNull();
      expect(statSync(file).mode & 0o777).toBe(mode);
      expect(readFileSync(file, 'latin1')).toBe(`${SAMPLE}\n`);
    }
  });

  it.skipIf(!POSIX)('a symbolic link, even to a good token file', () => {
    const elsewhere = join(scratch(), 'elsewhere');
    const real = plant(elsewhere, `${SAMPLE}\n`);
    const home = join(scratch(), 'tabdock');
    mkdirSync(home, { mode: 0o700 });
    chmodSync(home, 0o700);
    symlinkSync(real, join(home, OWNER_TOKEN_FILE));
    for (const load of [loadOwnerToken, readOwnerToken]) {
      const message = refusal(() => load({ TABDOCK_HOME: home }));
      fromHome(message, home, `${OWNER_TOKEN_FILE} in ${GIVEN_HOME}`);
      expect(message).toMatch(/symbolic link.*delete it and start again/);
      expect(leakIn(message, SAMPLE)).toBeNull();
    }
    // A dangling one too: never followed, never written through.
    rmSync(real);
    expect(refusal(() => loadOwnerToken({ TABDOCK_HOME: home }))).toMatch(/symbolic link/);
    expect(existsSync(real)).toBe(false);
  });

  it('something other than a regular file', () => {
    const home = join(scratch(), 'tabdock');
    mkdirSync(join(home, OWNER_TOKEN_FILE), { recursive: true, mode: 0o700 });
    chmodSync(home, 0o700);
    const message = refusal(() => loadOwnerToken({ TABDOCK_HOME: home }));
    expect(message).toMatch(/not a regular file; delete it and start again/);
  });

  it.skipIf(!POSIX || spawnSync('mkfifo', ['--help']).error !== undefined)(
    'a FIFO, refused without waiting for a writer',
    () => {
      const home = join(scratch(), 'tabdock');
      mkdirSync(home, { mode: 0o700 });
      chmodSync(home, 0o700);
      const fifo = join(home, OWNER_TOKEN_FILE);
      expect(spawnSync('mkfifo', ['-m', '600', fifo]).status).toBe(0);
      expect(refusal(() => loadOwnerToken({ TABDOCK_HOME: home }))).toMatch(/not a regular file/);
    },
  );

  it('a file that is not a well-formed token, never quoting it', () => {
    const random = 'SeCrEtPaRt0123456789abcdefghijklmnopqrstu';
    for (const contents of [
      '',
      '\n',
      `tabdock_${random}`,
      `tabdock_${random}xyz`,
      `TABDOCK_${random}xy`,
      `tabdock_${random}x+`,
      ` tabdock_${random}xy`,
      `tabdock_${random}xy\n\n`,
      `tabdock_${random}xy\r\n`,
      `tabdock_${random}xy\nmore`,
      `tabdock_${random}xy\n${'#'.repeat(20)}`,
      'x'.repeat(4096),
    ]) {
      const home = join(scratch(), 'tabdock');
      const file = plant(home, contents);
      for (const load of [loadOwnerToken, readOwnerToken]) {
        const message = refusal(() => load({ TABDOCK_HOME: home }));
        expect(message, JSON.stringify(contents.slice(0, 20))).toMatch(
          /not a well-formed owner token; delete it and start again/,
        );
        fromHome(message, file, `${OWNER_TOKEN_FILE} in ${GIVEN_HOME}`);
        expect(message).not.toContain('SeCrEt');
      }
      // Refused, never rewritten.
      expect(readFileSync(file, 'latin1')).toBe(contents);
    }
  });

  it.skipIf(!POSIX)(
    'spells out no path TABDOCK_HOME gave, nor one in or above it, whatever the refusal',
    () => {
      // A dev token or client secret may start with '/', so one pasted into
      // TABDOCK_HOME passes as an absolute path; the mark stands in for it.
      const MARK = 'Zq7Home9Wq';
      const base = join(scratch(), MARK);
      mkdirSync(base, { mode: 0o700 });
      // readOwnerToken never looks at the helper, so that case is loadOwnerToken's alone.
      type Load = (env: TokenEnv) => unknown;
      const homes: [label: string, make: () => string, loads?: Load[]][] = [
        // Node's own realpath errors quote the path: a loop of links, and a name past the limit.
        [
          'a loop of links',
          () => {
            symlinkSync(join(base, 'loop'), join(base, 'loop'));
            return join(base, 'loop', 'tabdock');
          },
        ],
        ['a name too long', () => join(base, MARK.repeat(30))],
        ['a work tree', () => join(workTreeAt(join(base, 'repo')), 'tabdock')],
        [
          'a directory others may write above it',
          () => {
            mkdirSync(join(base, 'open'));
            chmodSync(join(base, 'open'), 0o777);
            return join(base, 'open', 'tabdock');
          },
        ],
        [
          'a directory others may enter',
          () => {
            mkdirSync(join(base, 'wide'));
            chmodSync(join(base, 'wide'), 0o755);
            return join(base, 'wide');
          },
        ],
        [
          'a file where the directory should be',
          () => {
            writeFileSync(join(base, 'file'), 'x');
            return join(base, 'file');
          },
        ],
        ['a token file others may read', () => dirname(plant(join(base, 'read'), '', 0o644))],
        ['a malformed token', () => dirname(plant(join(base, 'bad'), 'tabdock_short\n'))],
        [
          'a helper that is a link',
          () => {
            const home = join(base, 'helper');
            loadOwnerToken({ TABDOCK_HOME: home });
            rmSync(join(home, HEADERS_HELPER_FILE));
            symlinkSync(join(base, 'elsewhere'), join(home, HEADERS_HELPER_FILE));
            return home;
          },
          [loadOwnerToken],
        ],
      ];
      for (const [label, make, loads = [loadOwnerToken, readOwnerToken] as Load[]] of homes) {
        const home = make();
        for (const load of loads) {
          // refusal() also holds every one to OwnerTokenError, never node's own error.
          const message = refusal(() => load({ TABDOCK_HOME: home }));
          expect(message, label).toContain(GIVEN_HOME);
          expect(message, label).not.toContain(MARK);
        }
      }
    },
  );
});

describe.skipIf(!POSIX)('the directories above it (ADR 0028)', () => {
  // Claude Code keeps running the header helper by its path long after the
  // relay last checked it, so a directory another account could make again
  // once it is gone would hand that account code execution as the user.
  it('refuses a token directory below a sticky directory everyone can write, as /tmp is, making nothing', () => {
    const shared = join(scratch(), 'shared');
    mkdirSync(shared);
    chmodSync(shared, 0o1777);
    const home = join(shared, 'tabdock');
    for (const load of [loadOwnerToken, readOwnerToken]) {
      const message = refusal(() => load({ TABDOCK_HOME: home }));
      expect(message).toBe(
        `local mode refuses ${GIVEN_HOME} for its owner token: the directory just above it can be written by other accounts (mode 1777), so another account could make the directory again once it is gone and have Claude Code run a header helper of its own; set TABDOCK_HOME to an absolute path under your home directory (ADR 0028)`,
      );
    }
    expect(existsSync(home)).toBe(false);
  });

  it('refuses one below the real /tmp, whoever runs it', () => {
    const tmp = realpathSync('/tmp');
    if ((statSync(tmp).mode & 0o1022) !== 0o1022) return;
    const home = join(tmp, `tabdock-review-${String(process.pid)}`, 'tabdock');
    expect(refusal(() => loadOwnerToken({ TABDOCK_HOME: home }))).toContain(
      ': the directory 2 levels above it can be written by other accounts (mode 1777)',
    );
    expect(existsSync(join(tmp, `tabdock-review-${String(process.pid)}`))).toBe(false);
  });

  it('refuses one below a directory of its own its group may write, naming chmod as a fix', () => {
    for (const mode of [0o775, 0o757, 0o722]) {
      const parent = join(scratch(), 'group');
      mkdirSync(parent);
      chmodSync(parent, mode);
      const home = join(parent, 'deeper', 'tabdock');
      const message = refusal(() => loadOwnerToken({ TABDOCK_HOME: home }));
      expect(message).toContain(
        `: the directory 2 levels above it can be written by other accounts (mode ${mode.toString(8)}), so another account could make the directory again`,
      );
      expect(message).toContain(
        'run chmod go-w on it, or set TABDOCK_HOME to an absolute path under your home directory (ADR 0028)',
      );
      expect(existsSync(join(parent, 'deeper'))).toBe(false);
    }
  });

  it('refuses one below a directory another account owns, and the default one under such a home', () => {
    const base = scratch();
    const theirs = join(base, 'theirs');
    mkdirSync(theirs, { mode: 0o755 });
    const other = (process.getuid?.() ?? 0) + 4242;
    const lstat = (path: string): FileFacts =>
      path === theirs ? ownedBy(lstatSync(path), other) : lstatSync(path);
    const home = join(theirs, 'tabdock');
    expect(refusal(() => loadOwnerToken({ TABDOCK_HOME: home }, { lstat }))).toContain(
      `: the directory just above it belongs to another account (uid ${String(other)}), so another account could make the directory again once it is gone and have Claude Code run a header helper of its own; set TABDOCK_HOME to an absolute path under your home directory (ADR 0028)`,
    );
    const env = { HOME: theirs };
    expect(refusal(() => loadOwnerToken(env, { lstat, platform: 'linux' }))).toContain(
      `local mode refuses ${join(theirs, '.config', 'tabdock')} for its owner token: ${theirs} above it belongs to another account`,
    );
    expect(existsSync(join(theirs, '.config'))).toBe(false);
    // Directories root owns, and ours that only we may write, are trusted.
    expect(loadOwnerToken({ TABDOCK_HOME: join(base, 'mine', 'tabdock') }).created).toBe(true);
  });
});

describe('names for paths TABDOCK_HOME gave, on a platform that folds case', () => {
  it('names a path whose case differs from the setting by what lies below it, never by climbing out', () => {
    const names = pathNames(
      { TABDOCK_HOME: '/nonexistent-tabdock/Users/me/TabDockZq7Mark9Wq' },
      { platform: 'darwin' },
    );
    expect(names.of('/nonexistent-tabdock/Users/me/tabdockzq7mark9wq/owner-token')).toBe(
      `owner-token in ${GIVEN_HOME}`,
    );
    expect(names.of('/nonexistent-tabdock/Users/me/TABDOCKZQ7MARK9WQ/audit/audit.lock')).toBe(
      `audit/audit.lock in ${GIVEN_HOME}`,
    );
    expect(names.of('/nonexistent-tabdock/users/ME/tabdockzq7mark9wq')).toBe(GIVEN_HOME);
    // Where case counts, a path in another case is another directory.
    const strict = pathNames(
      { TABDOCK_HOME: '/nonexistent-tabdock/Users/me/TabDockZq7Mark9Wq' },
      { platform: 'linux' },
    );
    expect(strict.of('/nonexistent-tabdock/Users/me/tabdockzq7mark9wq/owner-token')).not.toMatch(
      /mark9wq/i,
    );
  });
});

describe('on Windows, where Node reports no owner and lacks O_NOFOLLOW', () => {
  function windows(base: string): { env: TokenEnv; local: string; profile: string } {
    const local = join(base, 'local');
    const profile = join(base, 'profile');
    mkdirSync(local);
    mkdirSync(profile);
    return { env: { LOCALAPPDATA: local, USERPROFILE: profile }, local, profile };
  }

  it('takes a directory under %LOCALAPPDATA% or %USERPROFILE%, compared case-insensitively, and nothing else', () => {
    const base = scratch();
    const { env, local, profile } = windows(base);
    const system = { platform: 'win32' } as const;
    expect(loadOwnerToken(env, system).path).toBe(join(local, 'Tabdock', OWNER_TOKEN_FILE));
    expect(loadOwnerToken({ ...env, TABDOCK_HOME: join(profile, 'tabdock') }, system).created).toBe(
      true,
    );
    expect(
      loadOwnerToken(
        { ...env, LOCALAPPDATA: local.toUpperCase(), TABDOCK_HOME: join(local, 'Other') },
        system,
      ).created,
    ).toBe(true);
    const outside = join(base, 'elsewhere');
    for (const load of [loadOwnerToken, readOwnerToken]) {
      const message = refusal(() => load({ ...env, TABDOCK_HOME: outside }, system));
      fromHome(message, outside);
      expect(message).toMatch(
        /must lie under %LOCALAPPDATA% or %USERPROFILE%.*set TABDOCK_HOME to a directory there/,
      );
    }
    expect(existsSync(outside)).toBe(false);
  });

  it.skipIf(!POSIX)('lets the owner and mode checks give way, which Windows cannot express', () => {
    const { env, local } = windows(scratch());
    const home = join(local, 'Tabdock');
    mkdirSync(home);
    chmodSync(home, 0o755);
    plant(home, `${SAMPLE}\n`, 0o644);
    chmodSync(home, 0o755);
    const owner = loadOwnerToken(env, { platform: 'win32' });
    expect(owner.created).toBe(false);
    expect(owner.token === SAMPLE).toBe(true);
  });

  it.skipIf(!POSIX)('refuses a symbolic link through lstat, and still a malformed file', () => {
    const base = scratch();
    const { env, local } = windows(base);
    const home = join(local, 'Tabdock');
    const real = plant(join(base, 'real'), `${SAMPLE}\n`);
    mkdirSync(home);
    symlinkSync(real, join(home, OWNER_TOKEN_FILE));
    expect(refusal(() => loadOwnerToken(env, { platform: 'win32' }))).toMatch(/not a regular file/);
    rmSync(join(home, OWNER_TOKEN_FILE));
    plant(home, 'tabdock_short\n');
    expect(refusal(() => loadOwnerToken(env, { platform: 'win32' }))).toMatch(
      /not a well-formed owner token/,
    );
  });
});

describe('the repository rule (ADR 0028), in a checkout and in the package alike', () => {
  /** A directory made a work tree the way the rule sees one: a `.git` directory, or a file as a linked worktree or submodule has. */
  function workTree(path: string, as: 'directory' | 'file' = 'directory'): string {
    mkdirSync(path, { recursive: true });
    if (as === 'directory') mkdirSync(join(path, '.git'));
    else writeFileSync(join(path, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
    return path;
  }

  /** Runs `run` with the current directory at `cwd`, which the rule must not depend on. */
  function from<T>(cwd: string, run: () => T): T {
    const before = process.cwd();
    process.chdir(cwd);
    try {
      return run();
    } finally {
      process.chdir(before);
    }
  }

  // The package has no checkout to compare with; a checkout keeps its own
  // comparison besides, here with a directory nothing lies in.
  const modes: [string, (base: string) => Partial<LocalTokenSystem>][] = [
    ['from a checkout', (base) => ({ checkout: join(base, 'some-checkout') })],
    ['from the package', () => ({ checkout: null })],
  ];

  for (const [mode, systemFor] of modes) {
    describe(mode, () => {
      it('refuses a token directory inside the work tree around the current directory, creating nothing', () => {
        const base = scratch();
        const repo = workTree(join(base, 'project'));
        const home = join(repo, '.tabdock');
        for (const load of [loadOwnerToken, readOwnerToken]) {
          const message = from(repo, () =>
            refusal(() => load({ TABDOCK_HOME: home }, systemFor(base))),
          );
          fromHome(message, repo);
          expect(message).toContain(
            'inside a git work tree whose top is the directory just above it, where the token could be committed; set TABDOCK_HOME to an absolute path outside every repository, or unset it (ADR 0028)',
          );
          expect(existsSync(home)).toBe(false);
        }
      });

      it('counts a .git file, as a linked worktree or a submodule has, and a directory deep inside', () => {
        const base = scratch();
        const repo = workTree(join(base, 'linked'), 'file');
        const home = join(repo, 'deep', 'er', 'tabdock');
        expect(refusal(() => loadOwnerToken({ TABDOCK_HOME: home }, systemFor(base)))).toContain(
          'inside a git work tree whose top is the directory 3 levels above it',
        );
        expect(existsSync(join(repo, 'deep'))).toBe(false);
      });

      it('refuses TABDOCK_HOME in the outer repository from a current directory inside a submodule', () => {
        const base = scratch();
        const outer = workTree(join(base, 'outer'));
        const submodule = workTree(join(outer, 'vendor', 'sub'), 'file');
        const home = join(outer, '.tabdock');
        const message = from(submodule, () =>
          refusal(() => loadOwnerToken({ TABDOCK_HOME: home }, systemFor(base))),
        );
        expect(message).toContain(
          'inside a git work tree whose top is the directory just above it,',
        );
        // A token directory inside the submodule names the nearer tree, not the outer 4 levels up.
        const inner = join(submodule, '.tabdock');
        expect(refusal(() => loadOwnerToken({ TABDOCK_HOME: inner }, systemFor(base)))).toContain(
          'inside a git work tree whose top is the directory just above it,',
        );
      });

      it('refuses TABDOCK_HOME inside a work tree from a current directory outside any', () => {
        const base = scratch();
        const repo = workTree(join(base, 'repo'));
        const outside = join(base, 'not-a-repo');
        mkdirSync(outside);
        const message = from(outside, () =>
          refusal(() => loadOwnerToken({ TABDOCK_HOME: join(repo, 'tokens') }, systemFor(base))),
        );
        expect(message).toContain(
          'inside a git work tree whose top is the directory just above it,',
        );
      });

      it('refuses a project that installed the package, run from elsewhere with TABDOCK_HOME inside it', () => {
        const base = scratch();
        const project = workTree(join(base, 'app'));
        const installed = join(project, 'node_modules', '@tabdock', 'relay', 'dist');
        mkdirSync(installed, { recursive: true });
        const message = from(base, () =>
          refusal(() =>
            loadOwnerToken(
              { TABDOCK_HOME: join(project, '.config', 'tabdock') },
              { ...systemFor(base), checkout: mode === 'from a checkout' ? installed : null },
            ),
          ),
        );
        expect(message).toContain(
          'inside a git work tree whose top is the directory 2 levels above it,',
        );
      });

      it('refuses the default directory when ~/.config, or the home itself, is a work tree, naming TABDOCK_HOME as the fix', () => {
        for (const dotfiles of ['config', 'home'] as const) {
          const base = scratch();
          const home = join(base, 'home');
          mkdirSync(home);
          const tree = workTree(dotfiles === 'home' ? home : join(home, '.config'));
          const env = { HOME: home };
          const system = { ...systemFor(base), platform: 'linux' as const };
          for (const load of [loadOwnerToken, readOwnerToken]) {
            const message = refusal(() => load(env, system));
            expect(message).toContain(join(home, '.config', 'tabdock'));
            expect(
              message.endsWith(
                `inside the git work tree ${tree}, where the token could be committed; set TABDOCK_HOME to an absolute path outside every repository (ADR 0028)`,
              ),
              message,
            ).toBe(true);
          }
          expect(existsSync(join(home, '.config', 'tabdock'))).toBe(false);
          // The fix the message names works.
          const kept = join(base, 'elsewhere', 'tabdock');
          expect(loadOwnerToken({ ...env, TABDOCK_HOME: kept }, system).created).toBe(true);
        }
      });

      it('follows a symlink from outside into a work tree, by realpath', () => {
        const base = scratch();
        const repo = workTree(join(base, 'repo'));
        mkdirSync(join(repo, 'docs'));
        const link = join(base, 'link');
        symlinkSync(join(repo, 'docs'), link);
        expect(
          refusal(() => loadOwnerToken({ TABDOCK_HOME: join(link, 'tabdock') }, systemFor(base))),
        ).toContain('inside a git work tree whose top is the directory 2 levels above it,');
        expect(existsSync(join(repo, 'docs', 'tabdock'))).toBe(false);
      });

      it("refuses the work tree of every other version control tool that could commit it, as git's", () => {
        // Jujutsu snapshots new files into the working-copy commit on its own,
        // so a token there needs no `add` at all to reach a push.
        const tools: [string, string][] = [
          ['.jj', 'Jujutsu'],
          ['.hg', 'Mercurial'],
          ['.sl', 'Sapling'],
          ['.svn', 'Subversion'],
          ['.bzr', 'Bazaar'],
        ];
        for (const [marker, tool] of tools) {
          const base = scratch();
          const repo = join(base, 'repo');
          mkdirSync(join(repo, marker), { recursive: true });
          const home = join(repo, '.tabdock');
          for (const load of [loadOwnerToken, readOwnerToken]) {
            const message = refusal(() => load({ TABDOCK_HOME: home }, systemFor(base)));
            expect(message, marker).toContain(
              `inside a ${tool} work tree whose top is the directory just above it, where the token could be committed;`,
            );
          }
          expect(existsSync(home), marker).toBe(false);
        }
        // A colocated Jujutsu repository holds both, and git's name comes first.
        const base = scratch();
        const both = join(base, 'colocated');
        mkdirSync(join(both, '.jj'), { recursive: true });
        mkdirSync(join(both, '.git'));
        expect(
          refusal(() => loadOwnerToken({ TABDOCK_HOME: join(both, 't') }, systemFor(base))),
        ).toContain('inside a git work tree whose top is the directory just above it,');
      });

      it('takes a directory under no work tree at all', () => {
        const base = scratch();
        const home = join(base, 'plain', 'tabdock');
        const owner = from(base, () => loadOwnerToken({ TABDOCK_HOME: home }, systemFor(base)));
        expect(owner.created).toBe(true);
        expect(readOwnerToken({ TABDOCK_HOME: home }, systemFor(base))?.path).toBe(owner.path);
      });
    });
  }

  it('refuses rather than guesses when it cannot look for a .git entry', () => {
    const base = scratch();
    const home = join(base, 'tabdock');
    const lstat = (path: string): FileFacts => {
      if (path === join(base, '.git')) {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
      return lstatSync(path);
    };
    expect(refusal(() => loadOwnerToken({ TABDOCK_HOME: home }, { lstat }))).toContain(
      `cannot tell whether the directory just above ${GIVEN_HOME} is a repository's work tree (EACCES on its .git)`,
    );
    expect(existsSync(home)).toBe(false);
  });

  it('keeps the checkout comparison, which still guards a checkout without .git', () => {
    const base = scratch();
    const archive = join(base, 'unpacked-source');
    mkdirSync(archive);
    const home = join(archive, 'tabdock');
    expect(refusal(() => loadOwnerToken({ TABDOCK_HOME: home }, { checkout: archive }))).toMatch(
      /inside the checkout/,
    );
    // The package has no checkout, and this one is no work tree.
    expect(loadOwnerToken({ TABDOCK_HOME: home }, { checkout: null }).created).toBe(true);
  });
});

describe('--new-token (ADR 0028)', () => {
  /** The commit loadOwnerToken hands over, and the start it made. */
  function replacing(
    env: TokenEnv,
    overrides: Partial<LocalTokenSystem> = {},
  ): { commit: () => void; token: string; path: string; created: boolean } {
    const handed: (() => void)[] = [];
    const owner = loadOwnerToken(env, {
      ...overrides,
      replaceToken: (commit) => {
        handed.push(commit);
      },
    });
    const [commit] = handed;
    if (commit === undefined || handed.length !== 1) throw new Error('expected one commit');
    return { commit, ...owner };
  }

  it('draws a new token, leaves the old file alone until the commit, then renames the new one into place', () => {
    const home = join(scratch(), 'tabdock');
    const old = loadOwnerToken({ TABDOCK_HOME: home });
    const before = readFileSync(old.path);
    const next = replacing({ TABDOCK_HOME: home });
    expect(next.created).toBe(true);
    expect(next.path).toBe(old.path);
    expect(TOKEN_SHAPE.test(next.token)).toBe(true);
    expect(next.token === old.token).toBe(false);
    expect(readFileSync(old.path).equals(before)).toBe(true);
    const inode = statSync(old.path).ino;
    next.commit();
    expect(readFileSync(old.path, 'latin1') === `${next.token}\n`).toBe(true);
    // A new file renamed over the name, not the old one rewritten in place.
    expect(statSync(old.path).ino).not.toBe(inode);
    if (POSIX) expect(statSync(old.path).mode & 0o777).toBe(0o600);
    expect(readdirSync(home).sort()).toEqual(BESIDE_TOKEN);
    expect(loadOwnerToken({ TABDOCK_HOME: home }).token === next.token).toBe(true);
    // A second run of the same commit changes nothing.
    next.commit();
    expect(loadOwnerToken({ TABDOCK_HOME: home }).token === next.token).toBe(true);
  });

  it('works on a first start too, when there is no old token', () => {
    const home = join(scratch(), 'tabdock');
    const next = replacing({ TABDOCK_HOME: home });
    expect(existsSync(next.path)).toBe(false);
    next.commit();
    expect(loadOwnerToken({ TABDOCK_HOME: home }).token === next.token).toBe(true);
  });

  it.skipIf(!POSIX)(
    'never reads the old file, so one refused for its mode or contents, or a link, is replaced',
    () => {
      for (const bad of ['mode', 'contents', 'link'] as const) {
        const base = scratch();
        const home = join(base, 'tabdock');
        let target: string | null = null;
        if (bad === 'mode') plant(home, `${SAMPLE}\n`, 0o644);
        if (bad === 'contents') plant(home, 'not a token at all\n');
        if (bad === 'link') {
          target = plant(join(base, 'elsewhere'), `${SAMPLE}\n`);
          mkdirSync(home, { mode: 0o700 });
          chmodSync(home, 0o700);
          symlinkSync(target, join(home, OWNER_TOKEN_FILE));
        }
        expect(() => loadOwnerToken({ TABDOCK_HOME: home }), bad).toThrow(OwnerTokenError);
        const next = replacing({ TABDOCK_HOME: home });
        next.commit();
        expect(lstatSync(next.path).isFile(), bad).toBe(true);
        expect(loadOwnerToken({ TABDOCK_HOME: home }).token === next.token, bad).toBe(true);
        // The link was replaced, never written through.
        if (target !== null) expect(readFileSync(target, 'latin1')).toBe(`${SAMPLE}\n`);
      }
    },
  );

  it.skipIf(!POSIX)(
    'still refuses a directory that fails the checks, and hands over nothing',
    () => {
      const home = join(scratch(), 'tabdock');
      mkdirSync(home);
      chmodSync(home, 0o755);
      const handed: (() => void)[] = [];
      const message = refusal(() =>
        loadOwnerToken(
          { TABDOCK_HOME: home },
          {
            replaceToken: (commit) => {
              handed.push(commit);
            },
          },
        ),
      );
      expect(message).toMatch(/mode 755\); run chmod 700 on it/);
      expect(handed).toEqual([]);
      expect(readdirSync(home)).toEqual([]);
    },
  );

  it('refuses inside a work tree as every start does', () => {
    const base = scratch();
    mkdirSync(join(base, 'repo', '.git'), { recursive: true });
    const home = join(base, 'repo', 'tabdock');
    expect(
      refusal(() => loadOwnerToken({ TABDOCK_HOME: home }, { replaceToken: () => undefined })),
    ).toMatch(/inside a git work tree whose top is/);
    expect(existsSync(home)).toBe(false);
  });

  it('names the file, from TABDOCK_HOME, when something that is not a file holds the name', () => {
    const home = join(scratch(), 'tabdock');
    mkdirSync(join(home, OWNER_TOKEN_FILE, 'inside'), { recursive: true, mode: 0o700 });
    chmodSync(home, 0o700);
    const next = replacing({ TABDOCK_HOME: home });
    const message = refusal(() => {
      next.commit();
    });
    fromHome(message, home, `${OWNER_TOKEN_FILE} in ${GIVEN_HOME}`);
    expect(message).toMatch(/cannot put a new owner token in place.*delete it and start again/);
    expect(leakIn(message, next.token)).toBeNull();
    expect(readdirSync(home).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

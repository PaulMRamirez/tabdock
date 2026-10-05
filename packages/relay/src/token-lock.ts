// Local mode's token directory lock (ADR 0028's notes from the Step 2
// packaging review). Every local-mode relay holds `owner-token.lock` beside
// its owner token from its auth plugin's start, before it listens, to its
// stop, whatever TABDOCK_AUDIT_DIR or TABDOCK_PORT it was given. So a second
// relay that shares the token directory refuses before it serves anyone, and
// `--new-token` beside a running relay refuses before the token changes: the
// audit directory's lock guards only relays that also share that directory,
// and a relay left serving the old token after a rotation would keep a leaked
// token valid for as long as it runs.
//
// A lock reads `<pid> <boot> <pid namespace> <id>\n`, as the audit lock does
// (audit-file.ts): the holder's pid, this boot of the machine and the pid
// namespace where Linux names them ('-' where not), and 16 random bytes, so
// no two locks read alike. Local mode serves one machine, so a lock is judged
// by its pid alone where the pid means the same to both relays: one whose pid
// runs is held, one whose pid is gone was left by a crash and is broken. A
// lock from an earlier boot is stale too, since no process outlives a boot. A
// lock from another pid namespace on this boot, or one that cannot be read,
// cannot be judged here, so the start refuses and names the file for the
// person to delete if no relay runs; it never guesses. Local mode serves one
// machine: a relay on another machine sharing the directory over a network
// file system leaves a lock that looks like one from an earlier boot here,
// and is not seen.

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { AuthPlugin } from './auth.ts';

export const TOKEN_LOCK_FILE = 'owner-token.lock';

/** How many locks a start tries to take or break before it gives up. */
const ATTEMPTS = 5;
/** A lock is a few dozen bytes; anything longer is no lock this relay wrote. */
const MAX_LOCK_BYTES = 256;

/** A refusal to take the lock: names the lock's path and the fix, nothing else. */
export class TokenLockError extends Error {
  override readonly name = 'TokenLockError';
}

export interface TokenLock {
  readonly path: string;
  /** Gives the lock up, leaving alone one that is no longer this relay's. Safe to call twice. */
  release(): void;
}

/** Token directories this process holds the lock of, by real path. */
const heldHere = new Set<string>();

function errorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return 'error';
  return typeof error.code === 'string' ? error.code : 'error';
}

/** This boot of the machine, where Linux names it. */
function bootId(): string {
  try {
    const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return /^[0-9a-f-]{1,64}$/.test(id) ? id : '-';
  } catch {
    return '-';
  }
}

/** This process's pid namespace, where Linux names it. */
function pidNamespace(): string {
  try {
    return /^pid:\[(\d{1,20})\]$/.exec(readlinkSync('/proc/self/ns/pid', 'utf8'))?.[1] ?? '-';
  } catch {
    return '-';
  }
}

/** Whether a pid runs, as this process sees pids; EPERM means it runs as another account. */
function running(pid: number): boolean {
  // Never 0 or below, which kill(2) reads as a process group.
  if (pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

const NO_FOLLOW = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;

/** The lock's text, or null when there is none; read without following a link. */
function look(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    // A link or something unreadable: no lock this relay wrote, and not one to judge.
    return '';
  }
  try {
    const facts = fstatSync(fd);
    if (!facts.isFile() || facts.size > MAX_LOCK_BYTES) return '';
    return readFileSync(fd, 'latin1');
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}

type Verdict =
  { kind: 'live'; pid: number } | { kind: 'here' } | { kind: 'gone' } | { kind: 'unknown' };

function judge(text: string, boot: string, ns: string): Verdict {
  const match = /^(\d{1,10}) ([0-9a-f-]{1,64}) (\d{1,20}|-) [0-9a-f]{32}\n$/.exec(text);
  if (match === null) return { kind: 'unknown' };
  const pid = Number(match[1]);
  const lockBoot = match[2] ?? '-';
  const lockNs = match[3] ?? '-';
  // No process outlives a boot, so a lock from an earlier one was left by a relay that is gone.
  if (lockBoot !== '-' && boot !== '-' && lockBoot !== boot) return { kind: 'gone' };
  // Linux always has pid namespaces, so without /proc to name them a pid tells nothing there.
  const sharesPids =
    lockBoot === boot &&
    lockNs === ns &&
    (process.platform !== 'linux' || (boot !== '-' && ns !== '-'));
  if (!sharesPids) return { kind: 'unknown' };
  if (pid === process.pid) return { kind: 'here' };
  return running(pid) ? { kind: 'live', pid } : { kind: 'gone' };
}

/** Puts `text` in place at `path` whole or not at all, through a file of this process's own linked there; false when a lock is there. */
function place(dir: string, path: string, text: string): boolean {
  const own = join(dir, `.${TOKEN_LOCK_FILE}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    const fd = openSync(
      own,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    try {
      writeSync(fd, Buffer.from(text, 'latin1'));
    } finally {
      closeSync(fd);
    }
    linkSync(own, path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false;
    throw new TokenLockError(
      `local mode cannot lock its token directory ${dir} (${errorCode(error)}); the relay must be able to create ${TOKEN_LOCK_FILE} there (ADR 0028)`,
    );
  } finally {
    try {
      unlinkSync(own);
    } catch {
      // Never made.
    }
  }
}

/**
 * Removes the lock at `path` only if it still reads `expected`: renamed aside
 * first, which only one process can do to one file, then checked, and put
 * back under its name when it turns out to be another's.
 */
function remove(path: string, expected: string): boolean {
  const aside = `${path}.${randomBytes(8).toString('hex')}.aside`;
  try {
    renameSync(path, aside);
  } catch {
    return false;
  }
  const ours = look(aside) === expected;
  if (!ours) {
    try {
      linkSync(aside, path);
    } catch {
      // Another lock took the name meanwhile; its holder keeps it.
    }
  }
  try {
    unlinkSync(aside);
  } catch {
    // Nothing left to remove.
  }
  return ours;
}

/**
 * Takes the token directory's lock for a local-mode relay, or throws a
 * TokenLockError naming the lock and the fix. `dir` is the token directory,
 * already checked by loadOwnerToken.
 */
export function lockTokenDirectory(dir: string): TokenLock {
  const real = realpathSync.native(dir);
  const path = join(real, TOKEN_LOCK_FILE);
  if (heldHere.has(real)) {
    throw new TokenLockError(
      `local mode's token directory ${real} is already in use by a relay in this process; one relay serves one owner token (ADR 0028)`,
    );
  }
  const boot = bootId();
  const ns = pidNamespace();
  const text = `${String(process.pid)} ${boot} ${ns} ${randomBytes(16).toString('hex')}\n`;
  const inUse = (by: string): TokenLockError =>
    new TokenLockError(
      `local mode's token directory ${real} is in use by another relay, ${by}; stop that relay first (and with it the old owner token), or, if none is running, delete ${path} and start again (ADR 0028)`,
    );
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (place(real, path, text)) {
      heldHere.add(real);
      let held = true;
      return {
        path,
        release() {
          if (!held) return;
          held = false;
          heldHere.delete(real);
          if (look(path) === text) remove(path, text);
        },
      };
    }
    const seen = look(path);
    // Released between the link and the look: try again.
    if (seen === null) continue;
    const verdict = judge(seen, boot, ns);
    if (verdict.kind === 'live') throw inUse(`pid ${String(verdict.pid)}, which holds ${path}`);
    if (verdict.kind === 'unknown') {
      throw inUse(`perhaps in another container, whose lock ${path} this relay cannot judge`);
    }
    // 'here' with nothing held here is a lock an earlier process with this pid left, as is 'gone'.
    remove(path, seen);
  }
  throw new TokenLockError(
    `local mode cannot lock its token directory ${real}: another relay keeps taking ${path} (ADR 0028)`,
  );
}

/**
 * Local mode's auth plugin holding the token directory's lock from its start,
 * which createRelay runs before it listens, to its stop, which it runs when
 * the relay closes or fails to start.
 */
export function holdingTokenLock(auth: AuthPlugin, dir: string): AuthPlugin {
  let lock: TokenLock | null = null;
  return {
    ...auth,
    async start(context) {
      lock = lockTokenDirectory(dir);
      await auth.start?.(context);
    },
    stop() {
      auth.stop?.();
      lock?.release();
      lock = null;
    },
  };
}

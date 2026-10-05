// Local mode's token directory lock (token-lock.ts, ADR 0028's notes): held
// from a relay's start to its stop, so neither a second relay nor
// `--new-token` can act on a token a running relay still serves. A lock left
// by a relay that is gone is broken; one this relay cannot judge is refused
// with the file named for the person to delete, never guessed at.

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lockTokenDirectory, TOKEN_LOCK_FILE, TokenLockError } from '../src/token-lock.ts';

const LINUX = process.platform === 'linux';

const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tokenDirectory(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tabdock-token-lock-')));
  scratches.push(dir);
  const tokens = join(dir, 'tabdock');
  mkdirSync(tokens, { mode: 0o700 });
  return tokens;
}

/** This boot and pid namespace as a lock names them, so a test can write one as a relay would. */
function view(): { boot: string; ns: string } {
  if (!LINUX) return { boot: '-', ns: '-' };
  return {
    boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    ns: /^pid:\[(\d+)\]$/.exec(readlinkSync('/proc/self/ns/pid'))?.[1] ?? '-',
  };
}

function lockText(pid: number, boot: string, ns: string): string {
  return `${String(pid)} ${boot} ${ns} ${'ab'.repeat(16)}\n`;
}

/** A pid that ran and is gone. */
function gonePid(): number {
  const ran = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  });
  return Number(ran.stdout);
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TokenLockError);
    return error instanceof Error ? error.message : '';
  }
  throw new Error('expected a refusal');
}

describe("the token directory's lock", () => {
  it('is held until released, refused to a second relay in this process meanwhile, and gone after', () => {
    const dir = tokenDirectory();
    const lock = lockTokenDirectory(dir);
    expect(lock.path).toBe(join(dir, TOKEN_LOCK_FILE));
    expect(readFileSync(lock.path, 'latin1')).toMatch(/^\d+ [0-9a-f-]+ (?:\d+|-) [0-9a-f]{32}\n$/);
    expect(refusal(() => lockTokenDirectory(dir))).toContain(
      'is already in use by a relay in this process',
    );
    lock.release();
    lock.release();
    expect(existsSync(lock.path)).toBe(false);
    lockTokenDirectory(dir).release();
  });

  it('refuses beside a live relay, naming its pid, the lock and the fix, and leaves its lock', () => {
    const dir = tokenDirectory();
    const { boot, ns } = view();
    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore',
    });
    try {
      const pid = live.pid ?? 0;
      const text = lockText(pid, boot, ns);
      writeFileSync(join(dir, TOKEN_LOCK_FILE), text, { mode: 0o600 });
      const message = refusal(() => lockTokenDirectory(dir));
      expect(message).toContain(
        `is in use by another relay, pid ${String(pid)}, which holds ${join(dir, TOKEN_LOCK_FILE)}; stop that relay first`,
      );
      expect(message).toContain(`if none is running, delete ${join(dir, TOKEN_LOCK_FILE)}`);
      expect(readFileSync(join(dir, TOKEN_LOCK_FILE), 'latin1')).toBe(text);
    } finally {
      live.kill('SIGKILL');
    }
  });

  it('breaks a lock its relay left behind, on this boot or an earlier one', () => {
    const dir = tokenDirectory();
    const { boot, ns } = view();
    const stale = [lockText(gonePid(), boot, ns)];
    if (LINUX) stale.push(lockText(process.pid, '00000000-0000-4000-8000-000000000000', ns));
    for (const text of stale) {
      writeFileSync(join(dir, TOKEN_LOCK_FILE), text, { mode: 0o600 });
      const lock = lockTokenDirectory(dir);
      expect(readFileSync(lock.path, 'latin1')).not.toBe(text);
      lock.release();
    }
  });

  it('refuses a lock it cannot judge, another pid namespace or no lock at all, and never breaks it', () => {
    const dir = tokenDirectory();
    const { boot } = view();
    const unjudged = ['not a lock\n', ''];
    if (LINUX) unjudged.push(lockText(1, boot, '1'));
    for (const text of unjudged) {
      writeFileSync(join(dir, TOKEN_LOCK_FILE), text, { mode: 0o600 });
      expect(refusal(() => lockTokenDirectory(dir))).toContain(
        `whose lock ${join(dir, TOKEN_LOCK_FILE)} this relay cannot judge; stop that relay first (and with it the old owner token), or, if none is running, delete ${join(dir, TOKEN_LOCK_FILE)} and start again`,
      );
      expect(readFileSync(join(dir, TOKEN_LOCK_FILE), 'latin1')).toBe(text);
    }
  });

  it('on release leaves alone a lock that is no longer its own', () => {
    const dir = tokenDirectory();
    const lock = lockTokenDirectory(dir);
    const other = lockText(1, 'other', '-');
    writeFileSync(lock.path, other);
    lock.release();
    expect(readFileSync(lock.path, 'latin1')).toBe(other);
  });
});

// Local mode's owner token (ADR 0022): where it lives, how the first start
// draws it, and the checks every start makes before trusting it. The token is
// the only credential a local relay has, and anyone who reads the file can use
// every page `you` is attached to, so the rules follow ssh's for a private key:
// a file or directory that another account owns, that grants anyone else any
// permission, or that is not what it should be is refused, never repaired,
// since a readable file may already be copied and rewriting a bad one would
// hide tampering. Every refusal names the path and the fix, never the contents.
//
// The environment, platform, uid, home directory and stat calls are injected,
// so tests can play another platform or account without touching the real
// home; the file system itself is always the real one.

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const OWNER_TOKEN_FILE = 'owner-token';
const TOKEN_PREFIX = 'tabdock_';
/** 256 bits, as 43 base64url characters. */
const TOKEN_BYTES = 32;
/** A well-formed file is 52 bytes; anything past this is not one, so nothing more is read. */
const MAX_FILE_BYTES = 64;
const TOKEN_FILE_PATTERN = /^tabdock_[A-Za-z0-9_-]{43}\n?$/;
const TOKEN_LENGTH = TOKEN_PREFIX.length + 43;

/** The one user local mode knows: whoever holds the owner token. */
export const LOCAL_USER = { userId: 'you', displayName: 'You' } as const;

/** The checkout this code runs from; the token must never land inside it. */
const CHECKOUT = resolve(import.meta.dirname, '../../..');

/** What the checks read from a stat call; node's Stats has all of it. */
export type FileFacts = Pick<
  Stats,
  'uid' | 'mode' | 'size' | 'isFile' | 'isDirectory' | 'isSymbolicLink'
>;

export interface LocalTokenSystem {
  platform: NodeJS.Platform;
  /** The account the relay runs as; undefined on Windows, which has no uid. */
  uid: number | undefined;
  /** os.homedir(), used only when the environment names no home of its own. */
  homedir: string;
  /** The checkout the relay runs from, compared by realpath. */
  checkout: string;
  lstat(path: string): FileFacts;
  fstat(fd: number): FileFacts;
}

/** Where the variables come from: process.env, or a test's own object. */
export type TokenEnv = Readonly<Record<string, string | undefined>>;

export interface OwnerToken {
  /** The file's real path, which the banner prints and the printed command reads. */
  path: string;
  /** For createDevTokenAuth and nothing else: never printed, logged or kept. */
  token: string;
  /** Whether this start drew it. */
  created: boolean;
}

/** A refusal: its message names a path and a fix, never the token or the file's contents. */
export class OwnerTokenError extends Error {
  override readonly name = 'OwnerTokenError';
}

export function defaultTokenSystem(): LocalTokenSystem {
  let home = '';
  try {
    home = homedir();
  } catch {
    // No home at all; the resolver then asks for TABDOCK_HOME.
  }
  return {
    platform: process.platform,
    uid: process.getuid?.(),
    homedir: home,
    checkout: CHECKOUT,
    lstat: (path) => lstatSync(path),
    fstat: (fd) => fstatSync(fd),
  };
}

function systemOf(overrides: Partial<LocalTokenSystem>): LocalTokenSystem {
  return { ...defaultTokenSystem(), ...overrides };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/** A variable's value, or undefined when it is unset or blank, as .env.example leaves it. */
function setting(env: TokenEnv, name: string): string | undefined {
  const value = env[name]?.trim() ?? '';
  return value === '' ? undefined : value;
}

/** A variable that names a directory counts only when absolute (XDG Base Directory 0.8). */
function absoluteSetting(env: TokenEnv, name: string): string | undefined {
  const value = setting(env, name);
  return value !== undefined && isAbsolute(value) ? resolve(value) : undefined;
}

function homeOf(env: TokenEnv, name: string, system: LocalTokenSystem): string {
  const home = absoluteSetting(env, name) ?? system.homedir;
  if (!isAbsolute(home)) {
    throw new OwnerTokenError(
      'local mode cannot find your home directory for its owner token; set TABDOCK_HOME to an absolute path outside the checkout (ADR 0022)',
    );
  }
  return home;
}

/**
 * The directory that holds the owner token: TABDOCK_HOME when set, else the
 * per-user configuration directory, the local (not roaming) profile on
 * Windows since the token is good only on this machine. Variables are read
 * from `env` alone.
 */
export function ownerTokenDirectory(
  env: TokenEnv,
  overrides: Partial<LocalTokenSystem> = {},
): string {
  const system = systemOf(overrides);
  const explicit = setting(env, 'TABDOCK_HOME');
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) {
      // The value is not repeated: whatever sits in the wrong variable may be a secret.
      throw new OwnerTokenError(
        'TABDOCK_HOME must be an absolute path; leave it unset for the per-user configuration directory (ADR 0022)',
      );
    }
    return resolve(explicit);
  }
  if (system.platform === 'win32') {
    const local =
      absoluteSetting(env, 'LOCALAPPDATA') ??
      join(homeOf(env, 'USERPROFILE', system), 'AppData', 'Local');
    return join(local, 'Tabdock');
  }
  if (system.platform === 'darwin') {
    return join(homeOf(env, 'HOME', system), 'Library', 'Application Support', 'Tabdock');
  }
  const config =
    absoluteSetting(env, 'XDG_CONFIG_HOME') ?? join(homeOf(env, 'HOME', system), '.config');
  return join(config, 'tabdock');
}

/** Where the owner token is or would be, for messages; reading it is loadOwnerToken's job. */
export function ownerTokenPath(env: TokenEnv, overrides: Partial<LocalTokenSystem> = {}): string {
  return join(ownerTokenDirectory(env, overrides), OWNER_TOKEN_FILE);
}

/**
 * The real path of `path`, or of its nearest existing ancestor with the rest
 * appended, so a directory can be placed before it is made: nothing is
 * created inside the checkout only to be refused.
 */
function realpathNearest(path: string): string {
  const rest: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(current), ...rest);
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    rest.unshift(basename(current));
    current = parent;
  }
}

/** Paths compare case-insensitively where the file systems usually do. */
function caseless(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

function isWithin(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const fold = (path: string): string => (caseless(platform) ? path.toLowerCase() : path);
  const rel = relative(fold(parent), fold(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Where the directory may lie: never inside the checkout, where the token
 * could be committed, and on Windows only under the profile, whose default
 * access list admits only the user, SYSTEM and Administrators, since Node
 * reports no owner or mode there to check instead.
 */
function checkPlace(dir: string, env: TokenEnv, system: LocalTokenSystem): void {
  const real = realpathNearest(dir);
  const checkout = realpathNearest(system.checkout);
  if (isWithin(real, checkout, system.platform)) {
    throw new OwnerTokenError(
      `local mode refuses ${dir} for its owner token: it lies inside the checkout ${checkout}, where the token could be committed; set TABDOCK_HOME to an absolute path outside it, or unset it (ADR 0022)`,
    );
  }
  if (system.platform !== 'win32') return;
  const anchors = [
    absoluteSetting(env, 'LOCALAPPDATA'),
    absoluteSetting(env, 'USERPROFILE') ?? system.homedir,
  ].filter((anchor): anchor is string => anchor !== undefined && isAbsolute(anchor));
  if (!anchors.some((anchor) => isWithin(real, realpathNearest(anchor), system.platform))) {
    throw new OwnerTokenError(
      `local mode refuses ${dir} for its owner token: on Windows it must lie under %LOCALAPPDATA% or %USERPROFILE%, whose default access list admits only you, SYSTEM and Administrators; set TABDOCK_HOME to a directory there, or unset it (ADR 0022)`,
    );
  }
}

function makeDirectory(dir: string): void {
  try {
    // Parents made here get 0700 too, which suits a per-user configuration directory.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    // Something already there that is not a directory is named by checkDirectory.
    if (errorCode(error) === 'EEXIST') return;
    throw new OwnerTokenError(
      `local mode cannot create ${dir} for its owner token (${errorCode(error) ?? 'error'}); set TABDOCK_HOME to an absolute path you can write, outside the checkout (ADR 0022)`,
    );
  }
}

function realDirectory(dir: string): string | null {
  try {
    return realpathSync.native(dir);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new OwnerTokenError(
      `local mode cannot open ${dir}, which holds its owner token (${errorCode(error) ?? 'error'}); delete it and start again, or set TABDOCK_HOME (ADR 0022)`,
    );
  }
}

function octal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

function checkDirectory(dir: string, system: LocalTokenSystem): void {
  const facts = system.lstat(dir);
  if (!facts.isDirectory()) {
    throw new OwnerTokenError(
      `local mode refuses ${dir}: it should be the directory holding the owner token but is not a directory; delete it and start again (ADR 0022)`,
    );
  }
  if (system.platform === 'win32') return;
  if (facts.uid !== system.uid) {
    throw new OwnerTokenError(
      `local mode refuses ${dir}: another account owns it, so the owner token inside cannot be trusted; delete it and start again, or set TABDOCK_HOME to a directory of your own (ADR 0022)`,
    );
  }
  if ((facts.mode & 0o077) !== 0) {
    throw new OwnerTokenError(
      `local mode refuses ${dir}: it lets other accounts in (mode ${octal(facts.mode)}); run chmod 700 on it and start again (ADR 0022)`,
    );
  }
}

function malformed(file: string): OwnerTokenError {
  return new OwnerTokenError(
    `local mode refuses ${file}: it is not a well-formed owner token; delete it and start again for a new one (ADR 0022)`,
  );
}

/**
 * The token in `file`, or null when there is none. The file is opened without
 * following a symlink (O_NONBLOCK keeps a FIFO from stalling the open) and
 * checked through the descriptor, so what is checked is what is read.
 */
function readTokenFile(file: string, system: LocalTokenSystem): string | null {
  const windows = system.platform === 'win32';
  let fd: number;
  try {
    if (windows) {
      // Node has no O_NOFOLLOW on Windows, so lstat stands in for it.
      if (!system.lstat(file).isFile()) {
        throw new OwnerTokenError(
          `local mode refuses ${file}: it is not a regular file; delete it and start again (ADR 0022)`,
        );
      }
      fd = openSync(file, constants.O_RDONLY);
    } else {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    }
  } catch (error) {
    if (error instanceof OwnerTokenError) throw error;
    const code = errorCode(error);
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new OwnerTokenError(
        `local mode refuses ${file}: it is a symbolic link, not the owner token itself; delete it and start again (ADR 0022)`,
      );
    }
    throw new OwnerTokenError(
      `local mode cannot open ${file} (${code ?? 'error'}); it should belong to you with mode 600: delete it and start again (ADR 0022)`,
    );
  }
  try {
    const facts = system.fstat(fd);
    if (!facts.isFile()) {
      throw new OwnerTokenError(
        `local mode refuses ${file}: it is not a regular file; delete it and start again (ADR 0022)`,
      );
    }
    if (!windows) {
      if (facts.uid !== system.uid) {
        throw new OwnerTokenError(
          `local mode refuses ${file}: another account owns it, so it cannot be trusted; delete it and start again (ADR 0022)`,
        );
      }
      if ((facts.mode & 0o077) !== 0) {
        throw new OwnerTokenError(
          `local mode refuses ${file}: other accounts may read or write it (mode ${octal(facts.mode)}); run chmod 600 on it if nobody else could have read it, or else delete it and start again for a new token (ADR 0022)`,
        );
      }
    }
    if (facts.size > MAX_FILE_BYTES) throw malformed(file);
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length === buffer.length) break;
    }
    // latin1 maps each byte to one character, so no decoding can turn junk into a match.
    const text = buffer.toString('latin1', 0, length);
    buffer.fill(0);
    if (length > MAX_FILE_BYTES || !TOKEN_FILE_PATTERN.test(text)) throw malformed(file);
    return text.slice(0, TOKEN_LENGTH);
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text, 'latin1');
  let written = 0;
  while (written < bytes.length) {
    written += writeSync(fd, bytes, written, bytes.length - written);
  }
  bytes.fill(0);
}

/** So the new name survives a crash as well as the bytes do; not every system allows it. */
function syncDirectory(dir: string): void {
  try {
    const fd = openSync(dir, constants.O_RDONLY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // The file itself is synced; a directory that cannot be synced only costs durability.
  }
}

/**
 * Draws a token into a temporary 0600 file of its own (O_CREAT | O_EXCL),
 * syncs it, and hard-links it to `owner-token`, which fails if that name
 * exists, so a racing start never sees an empty or half-written token.
 * Returns whether this call's link made the file; false means another start
 * got there first, and its token is the one to read.
 */
export function drawOwnerToken(dir: string, overrides: Partial<LocalTokenSystem> = {}): boolean {
  const system = systemOf(overrides);
  const file = join(dir, OWNER_TOKEN_FILE);
  const temp = join(dir, `.${OWNER_TOKEN_FILE}.${randomBytes(8).toString('hex')}.tmp`);
  const flags =
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_WRONLY |
    (system.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
  let fd: number;
  try {
    fd = openSync(temp, flags, 0o600);
  } catch (error) {
    throw new OwnerTokenError(
      `local mode cannot write its owner token in ${dir} (${errorCode(error) ?? 'error'}); set TABDOCK_HOME to an absolute path you can write, outside the checkout (ADR 0022)`,
    );
  }
  try {
    try {
      writeAll(fd, `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temp, file);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return false;
      throw new OwnerTokenError(
        `local mode cannot put its owner token in place in ${dir} (${errorCode(error) ?? 'error'}), which needs a file system with hard links; set TABDOCK_HOME to a directory on a local disk (ADR 0022)`,
      );
    }
    if (system.platform !== 'win32') syncDirectory(dir);
    return true;
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // Already gone; nothing to tidy.
    }
  }
}

/** The directory, checked; null when it does not exist and `create` is false. */
function preparedDirectory(
  env: TokenEnv,
  system: LocalTokenSystem,
  create: boolean,
): string | null {
  const dir = ownerTokenDirectory(env, system);
  checkPlace(dir, env, system);
  if (create) makeDirectory(dir);
  const real = realDirectory(dir);
  if (real === null) {
    if (create) {
      throw new OwnerTokenError(
        `local mode cannot create ${dir} for its owner token; set TABDOCK_HOME to an absolute path you can write, outside the checkout (ADR 0022)`,
      );
    }
    return null;
  }
  // Again on the real path, now that it exists: a symlink may have pointed elsewhere.
  checkPlace(real, env, system);
  checkDirectory(real, system);
  return real;
}

/**
 * Local mode's start: the owner token, drawn on the first start. Throws an
 * OwnerTokenError naming the path and the fix when anything is not as it
 * should be.
 */
export function loadOwnerToken(
  env: TokenEnv,
  overrides: Partial<LocalTokenSystem> = {},
): OwnerToken {
  const system = systemOf(overrides);
  const dir = preparedDirectory(env, system, true);
  if (dir === null) throw new OwnerTokenError('local mode could not prepare its token directory');
  const file = join(dir, OWNER_TOKEN_FILE);
  // A file deleted between the failed link and the read, by hand or by a
  // racing start's loser, sends the loop round again; three rounds is plenty.
  for (let round = 0; round < 3; round += 1) {
    const found = readTokenFile(file, system);
    if (found !== null) return { path: file, token: found, created: false };
    if (drawOwnerToken(dir, system)) {
      const drawn = readTokenFile(file, system);
      if (drawn !== null) return { path: file, token: drawn, created: true };
    }
  }
  throw new OwnerTokenError(
    `local mode could not keep its owner token at ${file}: something keeps removing it; stop whatever does and start again (ADR 0022)`,
  );
}

/**
 * The owner token when there is one, for tools that talk to a running local
 * relay, such as pnpm spike:latency; null when none exists yet. It never
 * creates the directory or the file, and refuses as loadOwnerToken does.
 */
export function readOwnerToken(
  env: TokenEnv,
  overrides: Partial<LocalTokenSystem> = {},
): OwnerToken | null {
  const system = systemOf(overrides);
  const dir = preparedDirectory(env, system, false);
  if (dir === null) return null;
  const file = join(dir, OWNER_TOKEN_FILE);
  const token = readTokenFile(file, system);
  return token === null ? null : { path: file, token, created: false };
}

// Local mode's owner token (ADR 0022): where it lives, how the first start
// draws it, and the checks every start makes before trusting it. The token is
// the only credential a local relay has, and anyone who reads the file can use
// every page `you` is attached to, so the rules follow ssh's for a private key:
// a file or directory that another account owns, that grants anyone else any
// permission, or that is not what it should be is refused, never repaired,
// since a readable file may already be copied and rewriting a bad one would
// hide tampering. Every refusal names the path and the fix, never the contents,
// and with TABDOCK_HOME set names the path only from that setting (PathNames).
//
// ADR 0028 adds three things. A token directory inside any repository's work
// tree is refused, in a checkout and in the package alike, since the token
// could be committed from there. On POSIX systems each start keeps
// `claude-headers` beside the token, a fixed script Claude Code runs to read
// the token at each connection, so Claude Code's configuration never holds
// it; the script is checked as the token is and holds no token. And
// `--new-token` draws a token without reading the old file, and puts it in
// place in one rename when its caller says so.
//
// The environment, platform, uid, home directory and stat calls are injected,
// so tests can play another platform or account without touching the real
// home; the file system itself is always the real one.

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { quotePosix } from './shell-quote.ts';
import { PACKAGED } from './packaged.ts';

export const OWNER_TOKEN_FILE = 'owner-token';
const TOKEN_PREFIX = 'tabdock_';
/** 256 bits, as 43 base64url characters. */
const TOKEN_BYTES = 32;
/** A well-formed file is 52 bytes; anything past this is not one, so nothing more is read. */
const MAX_FILE_BYTES = 64;
const TOKEN_FILE_PATTERN = /^tabdock_[A-Za-z0-9_-]{43}\n?$/;
const TOKEN_LENGTH = TOKEN_PREFIX.length + 43;

/** The script Claude Code runs to read the token, kept beside it on POSIX systems (ADR 0028). */
export const HEADERS_HELPER_FILE = 'claude-headers';

/** The one user local mode knows: whoever holds the owner token. */
export const LOCAL_USER = { userId: 'you', displayName: 'You' } as const;

/**
 * The checkout this code runs from; the token must never land inside it. The
 * package has none: from the bundle this path would name a directory under
 * node_modules, so there the work tree rule stands alone (ADR 0028).
 */
const CHECKOUT: string | null = PACKAGED ? null : resolve(import.meta.dirname, '../../..');

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
  /** The checkout the relay runs from, compared by realpath; null in the package, which has none. */
  checkout: string | null;
  lstat(path: string): FileFacts;
  fstat(fd: number): FileFacts;
  /**
   * Set only for `--new-token` (ADR 0028): loadOwnerToken then never reads the
   * old file but draws a new token, and hands this a function that renames it
   * over owner-token. The caller runs that function only once its relay holds
   * the token directory's lock (token-lock.ts) and listens, so a start beside
   * a running relay that shares the directory, or one that fails on its way
   * up, refuses before anything changes.
   */
  replaceToken?: ((commit: () => void) => void) | undefined;
}

/** Where the variables come from: process.env, or a test's own object. */
export type TokenEnv = Readonly<Record<string, string | undefined>>;

/**
 * How refusals name the token directory and the paths around it. With
 * TABDOCK_HOME set the directory is that setting's value, and a value pasted
 * into the wrong variable passes as a directory once it is absolute: a dev
 * token or the /pair client secret may be any printable characters, '/'
 * among them (auth.ts, config.ts). So the directory, anything in it and
 * anything above it are then named from the variable, never spelled out, as
 * the audit reader names a path it was given (ADR 0028); the checkout, which
 * the relay knows without it, is still named in full. Without TABDOCK_HOME the
 * directory comes from the platform's own variables and is named in full, as
 * the banner names it.
 */
export interface PathNames {
  /** Whether paths are named from TABDOCK_HOME rather than spelled out. */
  readonly fromSetting: boolean;
  /** A path at, in or above the token directory, as a refusal names it. */
  of(path: string): string;
  /** How many levels `path` lies above the token directory (0 at it), or null when it does not. */
  levelsAbove(path: string): number | null;
}

/** How a path given by TABDOCK_HOME is named, as the audit reader names --dir's. */
export const GIVEN_HOME = 'the path TABDOCK_HOME gives';

/** Paths spelled out: the per-user default, and tools that chose the directory themselves. */
export const SHOWN_PATHS: PathNames = {
  fromSetting: false,
  of: (path) => path,
  levelsAbove: () => null,
};

/** The platform's facts, and how this start's refusals name paths. */
interface TokenContext extends LocalTokenSystem {
  readonly names: PathNames;
}

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

/** The helper script beside a token file, whose path the banner prints. */
export function headersHelperPath(tokenPath: string): string {
  return join(dirname(tokenPath), HEADERS_HELPER_FILE);
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

/** A directory some levels above another, before the other's name: "the directory just above". */
function aboveText(levels: number): string {
  return levels === 1 ? 'the directory just above' : `the directory ${String(levels)} levels above`;
}

/**
 * PathNames for this environment: from TABDOCK_HOME when it is set and
 * absolute (a relative one is refused without naming it), else spelled out.
 * The directory is known both as given and as its real path, since a check
 * may name either; resolving the real path may itself fail, and then the
 * given one alone anchors the names.
 */
export function pathNames(env: TokenEnv, overrides: Partial<LocalTokenSystem> = {}): PathNames {
  const given = setting(env, 'TABDOCK_HOME');
  if (given === undefined || !isAbsolute(given)) return SHOWN_PATHS;
  const { platform } = systemOf(overrides);
  const resolved = resolve(given);
  const anchors = [resolved];
  try {
    anchors.push(realpathNearest(resolved));
  } catch {
    // Named from the path as given.
  }
  const fold = (path: string): string => (caseless(platform) ? path.toLowerCase() : path);
  const levelsAbove = (path: string): number | null => {
    for (const anchor of anchors) {
      if (!isWithin(anchor, path, platform)) continue;
      let levels = 0;
      for (let current = anchor; fold(current) !== fold(path); current = dirname(current)) {
        if (dirname(current) === current) return null;
        levels += 1;
      }
      return levels;
    }
    return null;
  };
  return {
    fromSetting: true,
    of(path) {
      const levels = levelsAbove(path);
      if (levels === 0) return GIVEN_HOME;
      if (levels !== null) return `${aboveText(levels)} ${GIVEN_HOME}`;
      const inside = anchors.find((anchor) => isWithin(path, anchor, platform));
      if (inside !== undefined) return `${relative(inside, path)} in ${GIVEN_HOME}`;
      // Nothing a check names lies elsewhere, but if something did it could hold the value.
      return `a path ${GIVEN_HOME} leads to`;
    },
    levelsAbove,
  };
}

function contextOf(names: PathNames, overrides: Partial<LocalTokenSystem>): TokenContext {
  return { ...systemOf(overrides), names };
}

/**
 * What marks the top of a work tree, for each version control tool that could
 * commit a file left inside one, git first so a colocated Jujutsu repository
 * is named as git's. Jujutsu needs no `add` at all: it snapshots new files
 * into the working-copy commit on its own, so `jj git push` sends them on.
 */
const WORK_TREE_MARKERS: readonly (readonly [entry: string, tool: string])[] = [
  ['.git', 'git'],
  ['.jj', 'Jujutsu'],
  ['.hg', 'Mercurial'],
  ['.sl', 'Sapling'],
  ['.svn', 'Subversion'],
  ['.bzr', 'Bazaar'],
];

/**
 * The work tree of a repository that `real` lies in: the nearest of it and
 * its ancestors, up to the file system's root, that holds one of
 * WORK_TREE_MARKERS of any kind, a directory or a file (a linked worktree's
 * or a submodule's `.git`), with the tool it belongs to; or null when none
 * does. An entry the relay cannot even look for is refused rather than
 * guessed absent.
 */
function workTreeAround(real: string, system: TokenContext): { path: string; tool: string } | null {
  let current = real;
  for (;;) {
    for (const [marker, tool] of WORK_TREE_MARKERS) {
      const entry = join(current, marker);
      try {
        system.lstat(entry);
        return { path: current, tool };
      } catch (error) {
        const code = errorCode(error);
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          throw new OwnerTokenError(
            `local mode cannot tell whether ${system.names.of(current)} is a repository's work tree (${code ?? 'error'} on its ${marker}), so it will not keep its owner token below it; set TABDOCK_HOME to an absolute path outside any repository (ADR 0028)`,
          );
        }
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** An ancestor another account could change, and why. */
export interface SharedAncestor {
  path: string;
  why: string;
  /**
   * Whether `chmod go-w` on it is the fix: it is this account's, and not a
   * sticky directory such as /tmp, which is there to be shared.
   */
  fixable: boolean;
}

/**
 * The nearest of `path` and its ancestors, up to the file system's root, that
 * an account other than this one or root could change, or null when none
 * could, as OpenSSH's StrictModes asks of the path to a key: one writable by
 * its group or by others, sticky or not, or owned by another account, which
 * may make it writable whenever it likes. A sticky directory such as /tmp
 * keeps others from removing what is in it, never from making a name again
 * once it is gone, and Claude Code keeps running the header helper by its
 * path long after this relay last checked it. Names that do not exist yet
 * are passed over; the walk judges the nearest that does and every one
 * above it.
 */
export function sharedAncestor(
  path: string,
  overrides: Partial<LocalTokenSystem> = {},
): SharedAncestor | null {
  const system = systemOf(overrides);
  let current = realpathNearest(path);
  for (;;) {
    let facts: FileFacts | null = null;
    try {
      facts = system.lstat(current);
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return { path: current, why: `cannot be examined (${code ?? 'error'})`, fixable: false };
      }
    }
    if (facts !== null) {
      const ours = system.uid !== undefined && facts.uid === system.uid;
      if (system.uid !== undefined && facts.uid !== 0 && !ours) {
        return {
          path: current,
          why: `belongs to another account (uid ${String(facts.uid)})`,
          fixable: false,
        };
      }
      if ((facts.mode & 0o022) !== 0) {
        const mode = (facts.mode & 0o7777).toString(8).padStart(3, '0');
        return {
          path: current,
          why: `can be written by other accounts (mode ${mode})`,
          fixable: ours && (facts.mode & 0o1000) === 0,
        };
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Where the directory may lie: never inside the checkout or any repository's
 * work tree, where the token could be committed; on POSIX systems never
 * below a directory another account could change (sharedAncestor), from which
 * that account could make the directory again once it is gone and have
 * Claude Code run a header helper of its own; and on Windows only under the
 * profile, whose default access list admits only the user, SYSTEM and
 * Administrators, since Node reports no owner or mode there to check instead.
 * The checkout comparison still guards a checkout with no `.git`, such as an
 * unpacked source archive; the work tree rule covers every repository the
 * token could be committed from, whoever started the relay from wherever.
 */
function checkPlace(dir: string, env: TokenEnv, system: TokenContext): void {
  try {
    checkPlaceOf(dir, env, system);
  } catch (error) {
    if (error instanceof OwnerTokenError) throw error;
    // A realpath or stat that failed past ENOENT: node's own message would quote the path.
    throw new OwnerTokenError(
      `local mode cannot examine ${system.names.of(dir)} for its owner token (${errorCode(error) ?? 'error'}); set TABDOCK_HOME to an absolute path you can reach, outside every repository (ADR 0022)`,
    );
  }
}

/** A directory above the token directory, after a clause whose subject is the token directory. */
function aboveIt(path: string, system: TokenContext): string {
  const levels = system.names.levelsAbove(path);
  return levels === null ? `${system.names.of(path)} above it` : `${aboveText(levels)} it`;
}

function checkPlaceOf(dir: string, env: TokenEnv, system: TokenContext): void {
  const named = system.names.of(dir);
  const real = realpathNearest(dir);
  if (system.checkout !== null) {
    const checkout = realpathNearest(system.checkout);
    if (isWithin(real, checkout, system.platform)) {
      // The checkout is the relay's own place, known without TABDOCK_HOME, so it is named.
      throw new OwnerTokenError(
        `local mode refuses ${named} for its owner token: it lies inside the checkout ${checkout}, where the token could be committed; set TABDOCK_HOME to an absolute path outside it, or unset it (ADR 0022)`,
      );
    }
  }
  const tree = workTreeAround(real, system);
  if (tree !== null) {
    const fix =
      setting(env, 'TABDOCK_HOME') === undefined
        ? 'set TABDOCK_HOME to an absolute path outside every repository'
        : 'set TABDOCK_HOME to an absolute path outside every repository, or unset it';
    const levels = system.names.levelsAbove(tree.path);
    const where =
      levels === null
        ? `the ${tree.tool} work tree ${tree.path}`
        : `a ${tree.tool} work tree whose top is ${levels === 0 ? 'that directory itself' : `${aboveText(levels)} it`}`;
    throw new OwnerTokenError(
      `local mode refuses ${named} for its owner token: it lies inside ${where}, where the token could be committed; ${fix} (ADR 0028)`,
    );
  }
  if (system.platform !== 'win32') {
    // The directory itself is checkDirectory's, whose message names its own fix.
    const shared = sharedAncestor(dirname(real), system);
    if (shared !== null) {
      const elsewhere = 'set TABDOCK_HOME to an absolute path under your home directory';
      const fix = shared.fixable ? `run chmod go-w on it, or ${elsewhere}` : elsewhere;
      throw new OwnerTokenError(
        `local mode refuses ${named} for its owner token: ${aboveIt(shared.path, system)} ${shared.why}, so another account could make the directory again once it is gone and have Claude Code run a header helper of its own; ${fix} (ADR 0028)`,
      );
    }
    return;
  }
  const anchors = [
    absoluteSetting(env, 'LOCALAPPDATA'),
    absoluteSetting(env, 'USERPROFILE') ?? system.homedir,
  ].filter((anchor): anchor is string => anchor !== undefined && isAbsolute(anchor));
  if (!anchors.some((anchor) => isWithin(real, realpathNearest(anchor), system.platform))) {
    throw new OwnerTokenError(
      `local mode refuses ${named} for its owner token: on Windows it must lie under %LOCALAPPDATA% or %USERPROFILE%, whose default access list admits only you, SYSTEM and Administrators; set TABDOCK_HOME to a directory there, or unset it (ADR 0022)`,
    );
  }
}

/**
 * Why local mode would refuse a token directory at `dir` for where it lies,
 * or null when it would not; the directory itself is not examined. For tools
 * that choose such a directory, as the tests' scratch space does.
 */
export function placeRefusal(
  dir: string,
  overrides: Partial<LocalTokenSystem> = {},
): string | null {
  try {
    // The caller chose the directory itself, so the refusal may spell it out.
    checkPlace(resolve(dir), { TABDOCK_HOME: dir }, contextOf(SHOWN_PATHS, overrides));
    return null;
  } catch (error) {
    if (error instanceof OwnerTokenError) return error.message;
    throw error;
  }
}

function makeDirectory(dir: string, system: TokenContext): void {
  try {
    // Parents made here get 0700 too, which suits a per-user configuration directory.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    // Something already there that is not a directory is named by checkDirectory.
    if (errorCode(error) === 'EEXIST') return;
    throw new OwnerTokenError(
      `local mode cannot create ${system.names.of(dir)} for its owner token (${errorCode(error) ?? 'error'}); set TABDOCK_HOME to an absolute path you can write, outside the checkout (ADR 0022)`,
    );
  }
}

function realDirectory(dir: string, system: TokenContext): string | null {
  try {
    return realpathSync.native(dir);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new OwnerTokenError(
      `local mode cannot open ${system.names.of(dir)}, which holds its owner token (${errorCode(error) ?? 'error'}); delete it and start again, or set TABDOCK_HOME (ADR 0022)`,
    );
  }
}

function octal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

function checkDirectory(dir: string, system: TokenContext): void {
  const named = system.names.of(dir);
  const facts = system.lstat(dir);
  if (!facts.isDirectory()) {
    throw new OwnerTokenError(
      `local mode refuses ${named}: it should be the directory holding the owner token but is not a directory; delete it and start again (ADR 0022)`,
    );
  }
  if (system.platform === 'win32') return;
  if (facts.uid !== system.uid) {
    throw new OwnerTokenError(
      `local mode refuses ${named}: another account owns it, so the owner token inside cannot be trusted; delete it and start again, or set TABDOCK_HOME to a directory of your own (ADR 0022)`,
    );
  }
  if ((facts.mode & 0o077) !== 0) {
    throw new OwnerTokenError(
      `local mode refuses ${named}: it lets other accounts in (mode ${octal(facts.mode)}); run chmod 700 on it and start again (ADR 0022)`,
    );
  }
}

function malformed(file: string, system: TokenContext): OwnerTokenError {
  return new OwnerTokenError(
    `local mode refuses ${system.names.of(file)}: it is not a well-formed owner token; delete it and start again for a new one (ADR 0022)`,
  );
}

/**
 * The token in `file`, or null when there is none. The file is opened without
 * following a symlink (O_NONBLOCK keeps a FIFO from stalling the open) and
 * checked through the descriptor, so what is checked is what is read.
 */
function readTokenFile(file: string, system: TokenContext): string | null {
  const windows = system.platform === 'win32';
  const named = system.names.of(file);
  let fd: number;
  try {
    if (windows) {
      // Node has no O_NOFOLLOW on Windows, so lstat stands in for it.
      if (!system.lstat(file).isFile()) {
        throw new OwnerTokenError(
          `local mode refuses ${named}: it is not a regular file; delete it and start again (ADR 0022)`,
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
        `local mode refuses ${named}: it is a symbolic link, not the owner token itself; delete it and start again (ADR 0022)`,
      );
    }
    throw new OwnerTokenError(
      `local mode cannot open ${named} (${code ?? 'error'}); it should belong to you with mode 600: delete it and start again (ADR 0022)`,
    );
  }
  try {
    const facts = system.fstat(fd);
    if (!facts.isFile()) {
      throw new OwnerTokenError(
        `local mode refuses ${named}: it is not a regular file; delete it and start again (ADR 0022)`,
      );
    }
    if (!windows) {
      if (facts.uid !== system.uid) {
        throw new OwnerTokenError(
          `local mode refuses ${named}: another account owns it, so it cannot be trusted; delete it and start again (ADR 0022)`,
        );
      }
      if ((facts.mode & 0o077) !== 0) {
        throw new OwnerTokenError(
          `local mode refuses ${named}: other accounts may read or write it (mode ${octal(facts.mode)}); run chmod 600 on it if nobody else could have read it, or else delete it and start again for a new token (ADR 0022)`,
        );
      }
    }
    if (facts.size > MAX_FILE_BYTES) throw malformed(file, system);
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
    if (length > MAX_FILE_BYTES || !TOKEN_FILE_PATTERN.test(text)) throw malformed(file, system);
    return text.slice(0, TOKEN_LENGTH);
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, text: string, encoding: 'latin1' | 'utf8' = 'latin1'): void {
  const bytes = Buffer.from(text, encoding);
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

function freshToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

/**
 * A synced temporary file of its own in `dir` (O_CREAT | O_EXCL, never
 * through a link) holding `text` with exactly `mode`, whatever the umask;
 * the caller links or renames it into place and removes the name after.
 */
function writeTemporary(
  dir: string,
  name: string,
  text: string,
  mode: number,
  system: TokenContext,
  encoding: 'latin1' | 'utf8' = 'latin1',
): string {
  const temp = join(dir, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
  const windows = system.platform === 'win32';
  const flags =
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_WRONLY |
    (windows ? 0 : constants.O_NOFOLLOW);
  let fd: number;
  try {
    fd = openSync(temp, flags, mode);
  } catch (error) {
    throw new OwnerTokenError(
      `local mode cannot write its ${name} in ${system.names.of(dir)} (${errorCode(error) ?? 'error'}); set TABDOCK_HOME to an absolute path you can write, outside the checkout (ADR 0022)`,
    );
  }
  try {
    if (!windows) fchmodSync(fd, mode);
    writeAll(fd, text, encoding);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    removeQuietly(temp);
    throw error;
  }
  closeSync(fd);
  return temp;
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone; nothing to tidy.
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
  return drawInto(dir, contextOf(SHOWN_PATHS, overrides));
}

function drawInto(dir: string, system: TokenContext): boolean {
  const file = join(dir, OWNER_TOKEN_FILE);
  const temp = writeTemporary(dir, OWNER_TOKEN_FILE, `${freshToken()}\n`, 0o600, system);
  try {
    try {
      linkSync(temp, file);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return false;
      throw new OwnerTokenError(
        `local mode cannot put its owner token in place in ${system.names.of(dir)} (${errorCode(error) ?? 'error'}), which needs a file system with hard links; set TABDOCK_HOME to a directory on a local disk (ADR 0022)`,
      );
    }
    if (system.platform !== 'win32') syncDirectory(dir);
    return true;
  } finally {
    removeQuietly(temp);
  }
}

/**
 * Puts `token` in place as owner-token in one rename, for `--new-token`. A
 * rename, not a link, since a link cannot replace a name: a reader sees the
 * old token or the new one, never part of either. The directory is checked
 * again first, since time has passed since the start checked it, and the file
 * is read back through the usual checks afterwards.
 */
function replaceOwnerToken(dir: string, token: string, system: TokenContext): void {
  checkDirectory(dir, system);
  const file = join(dir, OWNER_TOKEN_FILE);
  const temp = writeTemporary(dir, OWNER_TOKEN_FILE, `${token}\n`, 0o600, system);
  try {
    renameSync(temp, file);
  } catch (error) {
    removeQuietly(temp);
    throw new OwnerTokenError(
      `local mode cannot put a new owner token in place at ${system.names.of(file)} (${errorCode(error) ?? 'error'}); delete it and start again (ADR 0028)`,
    );
  }
  if (system.platform !== 'win32') syncDirectory(dir);
  if (readTokenFile(file, system) !== token) {
    throw new OwnerTokenError(
      `local mode put a new owner token at ${system.names.of(file)} but read back another; something else writes there: stop it, delete the file and start again (ADR 0028)`,
    );
  }
}

/**
 * The helper's text for a token at `tokenPath`: a POSIX shell script that
 * reads the token's first line by its absolute path, checks its shape so
 * nothing but a token can reach the JSON, and prints Claude Code's header
 * object. It uses only shell builtins, so no PATH can change what it runs, and
 * it holds no token. A start that finds a file holding exactly an earlier
 * release's text replaces it, so EARLIER_HELPER_TEXTS keeps each text this
 * function returned in a published release, oldest first.
 */
export function headersHelperText(tokenPath: string): string {
  const quotedPath = quotePosix(tokenPath);
  return `#!/bin/sh
# Claude Code's headersHelper for the local Tabdock relay (ADR 0028): it reads
# the owner token from the file named below at each connection and prints the
# Authorization header as JSON, so Claude Code's settings never hold the token,
# and neither does this file. The relay writes it and refuses a changed copy
# at its next start; to change anything, delete it and start the relay again.
token=
IFS= read -r token < ${quotedPath} || [ -n "$token" ] || {
  echo 'tabdock: cannot read the owner token; start the Tabdock relay to make one' >&2
  exit 1
}
case $token in
  tabdock_*[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-]*) ;;
  tabdock_???????????????????????????????????????????)
    printf '{"Authorization":"Bearer %s"}\\n' "$token"
    exit 0
    ;;
esac
echo 'tabdock: the owner token file is not well formed; start the Tabdock relay with --new-token' >&2
exit 1
`;
}

/** Texts of the helper in earlier published releases, for a token path; none yet. */
export const EARLIER_HELPER_TEXTS: readonly ((tokenPath: string) => string)[] = [];

/** What the start found beside the token, after ensureHeadersHelper. */
export type HelperOutcome = 'kept' | 'written' | 'replaced';

/**
 * Makes sure `claude-headers` beside the token is this release's helper, as
 * every local start on a POSIX system does (ADR 0028). Missing, it is written
 * as the token is, a synced temporary file linked into place, mode 0700. Found,
 * it must be a regular file, opened without following a link, owned by this
 * account, granting nothing to group or others, executable by its owner, and
 * holding exactly this release's text; one holding an earlier release's exact
 * text is replaced in one rename, and anything else is refused, never
 * repaired, naming the path and the fix.
 */
export function ensureHeadersHelper(
  tokenPath: string,
  overrides: Partial<LocalTokenSystem> = {},
  earlier: readonly ((tokenPath: string) => string)[] = EARLIER_HELPER_TEXTS,
): HelperOutcome {
  return ensureHelper(tokenPath, contextOf(SHOWN_PATHS, overrides), earlier);
}

function ensureHelper(
  tokenPath: string,
  system: TokenContext,
  earlier: readonly ((tokenPath: string) => string)[] = EARLIER_HELPER_TEXTS,
): HelperOutcome {
  const dir = dirname(tokenPath);
  const file = join(dir, HEADERS_HELPER_FILE);
  const text = headersHelperText(tokenPath);
  const older = earlier.map((make) => make(tokenPath)).filter((old) => old !== text);
  // Two rounds: a racing start may link its copy between this one's look and its link.
  for (let round = 0; round < 2; round += 1) {
    const found = readHelper(file, system, [text, ...older]);
    if (found === text) return 'kept';
    if (found !== null) {
      const temp = writeTemporary(dir, HEADERS_HELPER_FILE, text, 0o700, system, 'utf8');
      try {
        renameSync(temp, file);
      } catch (error) {
        removeQuietly(temp);
        throw new OwnerTokenError(
          `local mode cannot replace ${system.names.of(file)}, which an earlier release wrote (${errorCode(error) ?? 'error'}); delete it and start again (ADR 0028)`,
        );
      }
      syncDirectory(dir);
      return 'replaced';
    }
    const temp = writeTemporary(dir, HEADERS_HELPER_FILE, text, 0o700, system, 'utf8');
    try {
      linkSync(temp, file);
      syncDirectory(dir);
      return 'written';
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw new OwnerTokenError(
          `local mode cannot put ${system.names.of(file)} in place (${errorCode(error) ?? 'error'}); set TABDOCK_HOME to a directory on a local disk (ADR 0028)`,
        );
      }
    } finally {
      removeQuietly(temp);
    }
  }
  throw new OwnerTokenError(
    `local mode could not keep ${system.names.of(file)} in place: something keeps changing it; stop whatever does and start again (ADR 0028)`,
  );
}

/**
 * The helper's text when it is one of `allowed`, or null when there is no
 * file; anything else is refused. Read through the descriptor it was checked
 * through, never following a link.
 */
function readHelper(file: string, system: TokenContext, allowed: readonly string[]): string | null {
  const refuse = (why: string, fix = 'delete it and start again'): OwnerTokenError =>
    new OwnerTokenError(`local mode refuses ${system.names.of(file)}: ${why}; ${fix} (ADR 0028)`);
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw refuse('it is a symbolic link, not the header helper itself');
    }
    throw refuse(`it cannot be opened (${code ?? 'error'})`);
  }
  try {
    const facts = system.fstat(fd);
    if (!facts.isFile()) throw refuse('it is not a regular file');
    if (facts.uid !== system.uid) throw refuse('another account owns it, so it cannot be trusted');
    if ((facts.mode & 0o077) !== 0) {
      throw refuse(`other accounts may read or change it (mode ${octal(facts.mode)})`);
    }
    if ((facts.mode & 0o100) === 0) {
      throw refuse(
        `Claude Code could not run it (mode ${octal(facts.mode)})`,
        'run chmod 700 on it, or delete it and start again',
      );
    }
    const limit = Math.max(...allowed.map((text) => Buffer.byteLength(text, 'utf8')));
    if (facts.size > limit) throw refuse('it is not the header helper this release writes');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length === buffer.length) break;
    }
    const text = buffer.toString('utf8', 0, length);
    const match = allowed.find((candidate) => candidate === text);
    if (match === undefined) throw refuse('it is not the header helper this release writes');
    return match;
  } finally {
    closeSync(fd);
  }
}

/** The directory, checked; null when it does not exist and `create` is false. */
function preparedDirectory(env: TokenEnv, system: TokenContext, create: boolean): string | null {
  const dir = ownerTokenDirectory(env, system);
  checkPlace(dir, env, system);
  if (create) makeDirectory(dir, system);
  const real = realDirectory(dir, system);
  if (real === null) {
    if (create) {
      throw new OwnerTokenError(
        `local mode cannot create ${system.names.of(dir)} for its owner token; set TABDOCK_HOME to an absolute path you can write, outside the checkout (ADR 0022)`,
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
 * Local mode's start: the owner token, drawn on the first start, with the
 * header helper beside it on POSIX systems. With `replaceToken` set
 * (`--new-token`) the old file is never read, so one refused for its mode or
 * contents can be replaced this way; the new token goes into place only when
 * the caller runs the commit it is handed. Throws an OwnerTokenError naming
 * the path and the fix when anything is not as it should be.
 */
export function loadOwnerToken(
  env: TokenEnv,
  overrides: Partial<LocalTokenSystem> = {},
): OwnerToken {
  const system = contextOf(pathNames(env, overrides), overrides);
  const dir = preparedDirectory(env, system, true);
  if (dir === null) throw new OwnerTokenError('local mode could not prepare its token directory');
  const file = join(dir, OWNER_TOKEN_FILE);
  const owner = system.replaceToken
    ? newOwnerToken(dir, file, system, system.replaceToken)
    : existingOrDrawn(dir, file, system);
  // Windows gets no helper until a Windows run shows which shell runs one there (ADR 0028).
  if (system.platform !== 'win32') ensureHelper(file, system);
  return owner;
}

function newOwnerToken(
  dir: string,
  file: string,
  system: TokenContext,
  replaceToken: (commit: () => void) => void,
): OwnerToken {
  const token = freshToken();
  let committed = false;
  replaceToken(() => {
    if (committed) return;
    committed = true;
    replaceOwnerToken(dir, token, system);
  });
  return { path: file, token, created: true };
}

function existingOrDrawn(dir: string, file: string, system: TokenContext): OwnerToken {
  // A file deleted between the failed link and the read, by hand or by a
  // racing start's loser, sends the loop round again; three rounds is plenty.
  for (let round = 0; round < 3; round += 1) {
    const found = readTokenFile(file, system);
    if (found !== null) return { path: file, token: found, created: false };
    if (drawInto(dir, system)) {
      const drawn = readTokenFile(file, system);
      if (drawn !== null) return { path: file, token: drawn, created: true };
    }
  }
  throw new OwnerTokenError(
    `local mode could not keep its owner token at ${system.names.of(file)}: something keeps removing it; stop whatever does and start again (ADR 0022)`,
  );
}

/**
 * The owner token when there is one, for tools that talk to a running local
 * relay, such as pnpm spike:latency; null when none exists yet. It never
 * creates the directory, the file or the helper, and refuses as
 * loadOwnerToken does.
 */
export function readOwnerToken(
  env: TokenEnv,
  overrides: Partial<LocalTokenSystem> = {},
): OwnerToken | null {
  const system = contextOf(pathNames(env, overrides), overrides);
  const dir = preparedDirectory(env, system, false);
  if (dir === null) return null;
  const file = join(dir, OWNER_TOKEN_FILE);
  const token = readTokenFile(file, system);
  return token === null ? null : { path: file, token, created: false };
}

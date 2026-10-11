// The relay's members (ADRs 0014 and 0043): who OAuth signs in as a member
// rather than an invitee. They come from TABDOCK_OAUTH_USERS, read once, or
// from a members file TABDOCK_MEMBERS_FILE names, which the relay reads at
// start and again whenever it changes, so adding or removing someone needs no
// restart. Both are read through the protocol's members schemas, one entry
// form for both: `sub=userId:Display Name`.
//
// The file is polled with stat every MEMBERS_POLL_MS, never watched: fs.watch
// misses an editor that saves by renaming, and a signal would need a binary
// the image lacks (docs/notes/verified.md). A changed stat waits one more poll
// so a write still in progress is never read; a stable one is read once, and
// applied only when its text differs from the text applied last. A file that
// is malformed, empty, too large, missing, unreadable or that another account
// could change keeps the list applied last, so a half-saved file can never
// empty the room in the middle of a lesson; at start the same problems refuse
// to start. Refusals name a line by number and a fixed phrase, never the
// line's text or the file's path: a token pasted into the wrong place must not
// reach a log (S11).
//
// MemberList is the live list the oauth plugin maps subjects through. Its
// replace() says whose user id the change moved, which the relay then ends
// everywhere (hub.membershipChanged, S8 and S13).

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  type Stats,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, sep } from 'node:path';
import {
  IdSchema,
  INVITEE_ID_PREFIX,
  MAX_DISPLAY_NAME_CHARS,
  MAX_MEMBERS,
  MAX_MEMBERS_FILE_BYTES,
  type MemberEntry,
  MemberEntrySchema,
  MemberSubSchema,
  type User,
} from '@tabdock/protocol';
import { type LocalTokenSystem, sharedAncestor } from './local-token.ts';
import type { Logger } from './log.ts';
import { digestHex } from './secrets.ts';

/** Why a member list or the members file was refused, as one fixed word a log line may carry. */
export type MembersProblem =
  | 'missing'
  | 'unreadable'
  | 'not_file'
  | 'unsafe'
  | 'too_large'
  | 'not_utf8'
  | 'malformed'
  | 'duplicate'
  | 'empty'
  | 'too_many';

/** A refusal whose message names a setting and a line number at most, never a value. */
export class MembersError extends Error {
  override readonly name = 'MembersError';
  readonly problem: MembersProblem;
  /** The line at fault, by number, for a file; null for the file as a whole or a variable. */
  readonly line: number | null;

  constructor(problem: MembersProblem, message: string, line: number | null = null) {
    super(message);
    this.problem = problem;
    this.line = line;
  }
}

/**
 * One `sub=userId:Display Name` entry, the name optional (the user id stands
 * in). Only the first '=' and the first ':' after it split, so a name may hold
 * either. `label` names where the entry sits ("TABDOCK_OAUTH_USERS entry 2",
 * "TABDOCK_MEMBERS_FILE line 7"); the entry's own text is never repeated.
 */
export function parseMemberEntry(
  text: string,
  label: string,
  line: number | null = null,
): MemberEntry {
  const refused = (what: string): MembersError =>
    new MembersError('malformed', `${label} ${what}`, line);
  const split = text.indexOf('=');
  const sub = split > 0 ? text.slice(0, split).trim() : '';
  const rest = split > 0 ? text.slice(split + 1) : '';
  const colon = rest.indexOf(':');
  const userId = (colon === -1 ? rest : rest.slice(0, colon)).trim();
  const displayName = colon === -1 ? userId : rest.slice(colon + 1).trim();
  if (sub === '' || userId === '') throw refused('is not of the form sub=userId:Display Name');
  if (!MemberSubSchema.safeParse(sub).success) {
    throw refused('has a sub that is not 1 to 255 printable characters');
  }
  if (!IdSchema.safeParse(userId).success) {
    throw refused("has a user id that is not 1 to 64 letters, digits, '_' or '-'");
  }
  if (userId.startsWith(INVITEE_ID_PREFIX)) {
    throw refused("has a user id starting g_, which only an invitee's may (ADR 0017)");
  }
  if (displayName.length === 0 || displayName.length > MAX_DISPLAY_NAME_CHARS) {
    throw refused(
      `has a display name that is not 1 to ${String(MAX_DISPLAY_NAME_CHARS)} characters`,
    );
  }
  // The protocol's schema has the last word, so the variable and the file
  // can never accept an entry it would not.
  const entry = MemberEntrySchema.safeParse({ sub, userId, displayName });
  if (!entry.success) throw refused('is not a member entry');
  return entry.data;
}

/**
 * Refuses a sub or user id listed twice, naming both places by number
 * (`plural` is "TABDOCK_OAUTH_USERS entries" or "TABDOCK_MEMBERS_FILE lines"),
 * never by the id, since a secret pasted into the list could sit there.
 */
export function refuseRepeats(
  entries: readonly { entry: MemberEntry; at: number }[],
  plural: string,
): void {
  const subs = new Map<string, number>();
  const ids = new Map<string, number>();
  for (const { entry, at } of entries) {
    const sub = subs.get(entry.sub);
    if (sub !== undefined) {
      throw new MembersError(
        'duplicate',
        `${plural} ${String(sub)} and ${String(at)} share a sub`,
        at,
      );
    }
    const id = ids.get(entry.userId);
    if (id !== undefined) {
      throw new MembersError(
        'duplicate',
        `${plural} ${String(id)} and ${String(at)} name the same user id`,
        at,
      );
    }
    subs.set(entry.sub, at);
    ids.set(entry.userId, at);
  }
}

/**
 * A members file's text: one entry per line, a comma free to appear in a
 * name since the line, not the comma, separates entries. Blank lines and
 * lines whose first character past any space is '#' are skipped; CRLF and a
 * leading byte order mark are accepted. At most MAX_MEMBERS entries, and at
 * least one.
 */
export function parseMembersFile(text: string): MemberEntry[] {
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  const lines = body.split('\n');
  const entries: { entry: MemberEntry; at: number }[] = [];
  for (const [index, raw] of lines.entries()) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1).trim() : raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const at = index + 1;
    if (entries.length === MAX_MEMBERS) {
      throw new MembersError(
        'too_many',
        `TABDOCK_MEMBERS_FILE lists more than ${String(MAX_MEMBERS)} members (ADR 0043)`,
        at,
      );
    }
    entries.push({
      entry: parseMemberEntry(line, `TABDOCK_MEMBERS_FILE line ${String(at)}`, at),
      at,
    });
  }
  if (entries.length === 0) {
    throw new MembersError('empty', 'TABDOCK_MEMBERS_FILE lists no members (ADR 0043)');
  }
  refuseRepeats(entries, 'TABDOCK_MEMBERS_FILE lines');
  return entries.map(({ entry }) => entry);
}

/**
 * The account key of a subject that is not a member: a digest, so the
 * subject never leaves the plugin (ADR 0016). An invitee's user id is
 * INVITEE_ID_PREFIX and this.
 */
export function inviteeKeyOf(sub: string): string {
  return digestHex(`invitee ${sub}`).slice(0, 32);
}

function userIdOf(members: ReadonlyMap<string, User>, sub: string): string {
  return members.get(sub)?.userId ?? `${INVITEE_ID_PREFIX}${inviteeKeyOf(sub)}`;
}

/** What one change to the member list did, for the relay to act on. */
export interface MemberChange {
  /**
   * Every user id an account held before and holds no longer, and every id
   * that only now names a member: whatever is still held under any of them
   * belongs to someone the list no longer gives it to (S8, S13).
   */
  ended: ReadonlySet<string>;
  /** Members whose user id stayed and whose display name changed, to the new name. */
  renamed: ReadonlyMap<string, string>;
  /** User ids that are members now and were not. */
  added: readonly string[];
  /** User ids that were members and are not now. */
  removed: readonly string[];
  /** How many members the list holds now. */
  total: number;
  /** Every member's display name now, against which an invitee's name is checked (ADR 0017). */
  memberNames: readonly string[];
}

function indexed(entries: readonly MemberEntry[]): Map<string, User> {
  const bySub = new Map<string, User>();
  const ids = new Set<string>();
  for (const entry of entries) {
    const checked = MemberEntrySchema.safeParse(entry);
    // Every caller checked its entries already; this keeps a list the relay maps people through whole.
    if (!checked.success || bySub.has(entry.sub) || ids.has(entry.userId)) {
      throw new Error('a member list holds an entry that is malformed or listed twice');
    }
    bySub.set(entry.sub, { userId: entry.userId, displayName: entry.displayName });
    ids.add(entry.userId);
  }
  return bySub;
}

/**
 * How many ended user ids a list remembers for endedSince. One change ends at
 * most about three ids per member (an old id, a subject's invitee id and a
 * new id), so this holds a whole change of the largest list; past it the
 * oldest are forgotten, and a request signed in before them is refused.
 */
export const ENDED_IDS_KEPT = 4 * MAX_MEMBERS;

/**
 * The members, by subject, read live: the oauth plugin maps every request's
 * subject through it, so the request after a replace() already maps as the
 * new list says.
 */
export class MemberList {
  #bySub: Map<string, User>;
  #names: readonly string[];
  #userIds: ReadonlySet<string>;
  #digest: string | null;
  #generation = 0;
  // Each id a change ended, at the generation that change made, oldest first.
  readonly #endedAt = new Map<string, number>();
  // A request signed in under an older generation than this can no longer be told apart.
  #forgottenBefore = 0;

  /** `digest` is the SHA-256 of the file text the entries came from, or null for a list given in code. */
  constructor(entries: readonly MemberEntry[], digest: string | null = null) {
    this.#bySub = indexed(entries);
    this.#names = [...this.#bySub.values()].map((user) => user.displayName);
    this.#userIds = new Set([...this.#bySub.values()].map((user) => user.userId));
    this.#digest = digest;
  }

  get size(): number {
    return this.#bySub.size;
  }

  /** The digest of the file text in force, or null when the list came from code or the variable. */
  get digest(): string | null {
    return this.#digest;
  }

  bySub(sub: string): User | undefined {
    const user = this.#bySub.get(sub);
    return user === undefined ? undefined : { ...user };
  }

  names(): readonly string[] {
    return this.#names;
  }

  userIds(): ReadonlySet<string> {
    return this.#userIds;
  }

  /**
   * Every entry, as copies: the restart snapshot (ADR 0046) binds a member's
   * attachment to the subject its id stood for, so a start whose list gives
   * the id to someone else restores nothing under it, as replace() ends it.
   */
  entries(): MemberEntry[] {
    return [...this.#bySub].map(([sub, user]) => ({ sub, ...user }));
  }

  /** Raised by every replace(); relay.ts keeps the one each /mcp request signed in under. */
  get generation(): number {
    return this.#generation;
  }

  /**
   * Whether a change made since `generation` ended `userId`. A request that
   * signed in under it as that id, and whose body was still on its way when
   * the change applied, held nothing the change could end, and acts for
   * someone the list no longer gives the id to (S8, S13). Answers true when
   * the list no longer remembers that far back.
   */
  endedSince(generation: number, userId: string): boolean {
    if (generation >= this.#generation) return false;
    if (generation < this.#forgottenBefore) return true;
    return (this.#endedAt.get(userId) ?? generation) > generation;
  }

  /**
   * Swaps in a new list, compared with the old by subject: an account whose
   * user id moves (a member removed or added, a sub given another id, an id
   * given another sub) ends under its old id, and a member whose name alone
   * changed keeps everything under the new name.
   */
  replace(entries: readonly MemberEntry[], digest: string | null): MemberChange {
    const before = this.#bySub;
    const beforeIds = this.#userIds;
    const next = indexed(entries);
    const ended = new Set<string>();
    const renamed = new Map<string, string>();
    for (const sub of new Set([...before.keys(), ...next.keys()])) {
      const was = userIdOf(before, sub);
      const now = userIdOf(next, sub);
      if (was !== now) {
        ended.add(was);
        continue;
      }
      const old = before.get(sub);
      const fresh = next.get(sub);
      if (old !== undefined && fresh !== undefined && old.displayName !== fresh.displayName) {
        renamed.set(now, fresh.displayName);
      }
    }
    const nowIds = new Set([...next.values()].map((user) => user.userId));
    const added = [...nowIds].filter((id) => !beforeIds.has(id));
    const removed = [...beforeIds].filter((id) => !nowIds.has(id));
    // A member id never starts g_, so nobody but a member could hold one; an
    // id no member had a moment ago holds only what a former member left.
    for (const id of added) ended.add(id);
    this.#bySub = next;
    this.#names = [...next.values()].map((user) => user.displayName);
    this.#userIds = nowIds;
    this.#digest = digest;
    this.#generation += 1;
    for (const id of ended) {
      // Deleted first, so the map stays in the order of the changes.
      this.#endedAt.delete(id);
      this.#endedAt.set(id, this.#generation);
    }
    for (const [id, at] of this.#endedAt) {
      if (this.#endedAt.size <= ENDED_IDS_KEPT) break;
      this.#endedAt.delete(id);
      this.#forgottenBefore = Math.max(this.#forgottenBefore, at);
    }
    return { ended, renamed, added, removed, total: next.size, memberNames: this.#names };
  }
}

/**
 * Two changes as one, the second made on top of the first: every id either
 * ended, and the names, members and counts the second leaves. An id the
 * first added and the second removed again, or the reverse, is neither.
 */
export function joinChanges(first: MemberChange, second: MemberChange): MemberChange {
  const ended = new Set([...first.ended, ...second.ended]);
  const renamed = new Map([...first.renamed, ...second.renamed]);
  for (const id of ended) renamed.delete(id);
  return {
    ended,
    renamed,
    added: [
      ...first.added.filter((id) => !second.removed.includes(id)),
      ...second.added.filter((id) => !first.removed.includes(id)),
    ],
    removed: [
      ...first.removed.filter((id) => !second.added.includes(id)),
      ...second.removed.filter((id) => !first.added.includes(id)),
    ],
    total: second.total,
    memberNames: second.memberNames,
  };
}

/**
 * Puts each new list in force and has `settle` end what it changed (the
 * relay hands it the hub, the pair flow and the sessions). The list maps the
 * next request at once, so a change whose settling throws part way stays
 * owed and is settled again with the next one: from the file that is the
 * same text once more, since the watcher applies a text until an apply
 * returns. Without this, the retry would compare the list with itself, find
 * nothing ended, and leave an id the change took away holding what it held
 * (S8).
 */
export function settlingMembers(
  list: MemberList,
  settle: (change: MemberChange) => void,
): (entries: readonly MemberEntry[], digest: string | null) => void {
  let owed: MemberChange | null = null;
  return (entries, digest) => {
    const fresh = list.replace(entries, digest);
    const change = owed === null ? fresh : joinChanges(owed, fresh);
    owed = change;
    settle(change);
    owed = null;
  };
}

// Reading the file

/** What the poll compares: a write, a rename over the file or a chmod each changes it. */
export type MemberFileStat = Pick<
  Stats,
  'size' | 'mtimeMs' | 'ctimeMs' | 'ino' | 'dev' | 'mode' | 'uid'
>;

/**
 * The platform, as the members file's checks see it; tests stand in for
 * parts of it, as local mode's place checks let them (local-token.ts).
 */
export interface MembersSystem extends Pick<
  LocalTokenSystem,
  'platform' | 'uid' | 'lstat' | 'fstat'
> {
  /** stat(2), following symbolic links, for the poll. */
  stat(path: string): MemberFileStat;
  readlink(path: string): string;
}

export function defaultMembersSystem(): MembersSystem {
  return {
    platform: process.platform,
    uid: process.getuid?.(),
    lstat: (path) => lstatSync(path),
    fstat: (fd) => fstatSync(fd),
    stat: (path) => statSync(path),
    readlink: (path) => readlinkSync(path),
  };
}

function systemOf(overrides: Partial<MembersSystem>): MembersSystem {
  return { ...defaultMembersSystem(), ...overrides };
}

/** As the kernel's own limit on links followed in one path (ELOOP). */
const MAX_LINK_HOPS = 40;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/** A failed open, stat or read, by its error code alone: node's own message quotes the path. */
function ioRefusal(error: unknown): MembersError {
  const code = errorCode(error);
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new MembersError(
      'missing',
      'TABDOCK_MEMBERS_FILE names a file that does not exist (ADR 0043)',
    );
  }
  if (code === 'ELOOP') {
    return new MembersError(
      'unreadable',
      'TABDOCK_MEMBERS_FILE leads through a loop of symbolic links (ELOOP) (ADR 0043)',
    );
  }
  return new MembersError(
    'unreadable',
    `TABDOCK_MEMBERS_FILE names a file the relay cannot read (${code ?? 'error'}) (ADR 0043)`,
  );
}

function parts(path: string): string[] {
  return path.split(sep).filter((part) => part !== '' && part !== '.');
}

/**
 * Every directory a symbolic link on the way to `path` lies in, resolved:
 * whoever can write one could point the link elsewhere, so each is held to
 * the same rule as the file's own directories.
 */
function linkHomes(path: string, system: MembersSystem): string[] {
  const homes: string[] = [];
  const pending = parts(path);
  let current = parse(path).root;
  let hops = 0;
  for (let part = pending.shift(); part !== undefined; part = pending.shift()) {
    if (part === '..') {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    if (!system.lstat(next).isSymbolicLink()) {
      current = next;
      continue;
    }
    hops += 1;
    if (hops > MAX_LINK_HOPS) throw ioRefusal({ code: 'ELOOP' });
    homes.push(current);
    const target = system.readlink(next);
    if (isAbsolute(target)) current = parse(target).root;
    pending.unshift(...parts(target));
  }
  return homes;
}

/** Where a shared ancestor of the file lies, after "TABDOCK_MEMBERS_FILE names a file another account could change:". */
function whereOf(shared: string, real: string): string {
  if (shared === real) return 'the file itself';
  let levels = 0;
  for (let current = real; current !== shared; current = dirname(current)) {
    if (dirname(current) === current) return 'a directory above it';
    levels += 1;
  }
  return levels === 1
    ? 'the directory holding it'
    : `the directory ${String(levels)} levels above it`;
}

function unsafe(where: string, why: string): MembersError {
  return new MembersError(
    'unsafe',
    `TABDOCK_MEMBERS_FILE names a file another account could change: ${where} ${why}, and whoever can change it can make anyone a member; keep the file where only the relay's account and root can write it and every directory above it (ADR 0043)`,
  );
}

/**
 * On POSIX, refuses a file that an account other than the relay's or root
 * could change, as OpenSSH asks of authorized_keys: the file, every directory
 * above it, and every directory a symbolic link on the way lies in must be
 * writable by neither group nor others and owned by the relay's account or
 * root (sharedAncestor). Windows has no modes to read; the guide says where to
 * keep the file there (ADR 0043).
 */
function refuseShared(path: string, system: MembersSystem): void {
  const real = realpathSync.native(path);
  const shared = sharedAncestor(real, system);
  if (shared !== null) throw unsafe(whereOf(shared.path, real), shared.why);
  for (const home of linkHomes(path, system)) {
    const above = sharedAncestor(home, system);
    if (above !== null) {
      throw unsafe(
        'a directory a symbolic link on the way to it lies in, or one above that,',
        above.why,
      );
    }
  }
}

/** The file's text, read through one descriptor, so what is checked is what is read. */
function readText(path: string, system: MembersSystem): string {
  const windows = system.platform === 'win32';
  // O_NONBLOCK keeps a FIFO from stalling the open; Windows has no such flag.
  const fd = openSync(
    path,
    windows ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NONBLOCK,
  );
  try {
    const facts = system.fstat(fd);
    if (!facts.isFile()) {
      throw new MembersError(
        'not_file',
        'TABDOCK_MEMBERS_FILE names something that is not a regular file once symbolic links are followed (ADR 0043)',
      );
    }
    if (!windows) {
      // Again on the open file: one swapped in after the path was checked is judged too.
      if ((facts.mode & 0o022) !== 0) {
        const mode = (facts.mode & 0o7777).toString(8).padStart(3, '0');
        throw unsafe('the file itself', `can be written by other accounts (mode ${mode})`);
      }
      if (system.uid !== undefined && facts.uid !== 0 && facts.uid !== system.uid) {
        throw unsafe('the file itself', `belongs to another account (uid ${String(facts.uid)})`);
      }
    }
    const tooLarge = (): MembersError =>
      new MembersError(
        'too_large',
        `TABDOCK_MEMBERS_FILE is larger than ${String(MAX_MEMBERS_FILE_BYTES)} bytes (ADR 0043)`,
      );
    if (facts.size > MAX_MEMBERS_FILE_BYTES) throw tooLarge();
    const buffer = Buffer.alloc(MAX_MEMBERS_FILE_BYTES + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length === buffer.length) break;
    }
    if (length > MAX_MEMBERS_FILE_BYTES) throw tooLarge();
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    } catch {
      throw new MembersError('not_utf8', 'TABDOCK_MEMBERS_FILE is not UTF-8 text (ADR 0043)');
    }
  } finally {
    closeSync(fd);
  }
}

/** The text of the members file at `path`, an absolute path, once it passes every check. */
export function readMembersFile(path: string, overrides: Partial<MembersSystem> = {}): string {
  const system = systemOf(overrides);
  try {
    if (system.platform !== 'win32') refuseShared(path, system);
    return readText(path, system);
  } catch (error) {
    if (error instanceof MembersError) throw error;
    throw ioRefusal(error);
  }
}

/** The SHA-256 of a members file's text, hex: what a reload compares, never logged. */
export function membersDigest(text: string): string {
  return digestHex(text);
}

/** The members file read and parsed, with the digest of its text; throws MembersError. */
export function loadMembersFile(
  path: string,
  overrides: Partial<MembersSystem> = {},
): { entries: MemberEntry[]; digest: string } {
  const text = readMembersFile(path, overrides);
  return { entries: parseMembersFile(text), digest: membersDigest(text) };
}

// Watching the file

/** What one reading of the file came to. */
export type MembersReload = 'applied' | 'unchanged' | 'refused';

export interface MembersWatchOptions {
  /** The file's absolute path. */
  path: string;
  system?: Partial<MembersSystem> | undefined;
  /** How often to stat it (RelayTimings.membersPollMs). */
  intervalMs: number;
  /** The digest of the text in force at start, or null when none came from this file. */
  applied: string | null;
  /** Puts a new list in force; called only with entries that passed every check. */
  apply(entries: MemberEntry[], digest: string): void;
  log: Logger;
}

export interface MembersWatch {
  /** Reads the file now, without waiting for it to settle, as a poll that found it stable would. */
  reloadNow(): MembersReload;
  stop(): void;
}

function statKey(stat: MemberFileStat): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode, stat.uid].join(' ');
}

/**
 * Polls the members file with stat on an unref'd timer. A stat that differs
 * from the last poll's waits one more poll; one that held still is read once,
 * and its text applied only when its digest differs from the one in force.
 * A refusal keeps the list in force and logs once for each distinct problem,
 * naming a fixed word and a line number, never the file's text or path.
 */
export function watchMembersFile(options: MembersWatchOptions): MembersWatch {
  const { path, intervalMs, log } = options;
  const system = systemOf(options.system ?? {});
  let applied = options.applied;
  /** The stat the last poll saw, or null when it saw none. */
  let seen: string | null = null;
  /** The stat whose read came to something other than a refusal, so it need not be read again. */
  let settled: string | null = null;
  /** The text last refused, so the same bad text is neither parsed nor logged again. */
  let refusedDigest: string | null = null;
  /** The problem last logged, so a file left broken logs once. */
  let warned: string | null = null;

  const refuse = (error: MembersError): MembersReload => {
    const key = `${error.problem} ${String(error.line)}`;
    if (warned !== key) {
      warned = key;
      log.warn('members file refused; keeping the list read last', {
        problem: error.problem,
        line: error.line,
      });
    }
    return 'refused';
  };

  const reloadNow = (): MembersReload => {
    let text: string;
    try {
      text = readMembersFile(path, system);
    } catch (error) {
      if (error instanceof MembersError) return refuse(error);
      throw error;
    }
    const digest = membersDigest(text);
    if (digest === applied) {
      warned = null;
      return 'unchanged';
    }
    if (digest === refusedDigest) return 'refused';
    let entries: MemberEntry[];
    try {
      entries = parseMembersFile(text);
    } catch (error) {
      if (!(error instanceof MembersError)) throw error;
      refusedDigest = digest;
      return refuse(error);
    }
    options.apply(entries, digest);
    applied = digest;
    refusedDigest = null;
    warned = null;
    return 'applied';
  };

  const poll = (): void => {
    let key: string;
    try {
      key = statKey(system.stat(path));
    } catch (error) {
      seen = null;
      refuse(ioRefusal(error));
      return;
    }
    if (key !== seen) {
      // Changed since the last poll: a write may still be under way.
      seen = key;
      return;
    }
    if (key === settled) return;
    if (reloadNow() !== 'refused') settled = key;
  };

  const timer = setInterval(() => {
    try {
      poll();
    } catch (error) {
      // A fault here must not stop the polls or the relay; the next poll tries
      // again. Its name alone: a message from the file system quotes the path.
      log.error('members file poll failed', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }, intervalMs);
  // The poll must never keep the process alive on its own.
  timer.unref();
  return {
    reloadNow,
    stop() {
      clearInterval(timer);
    },
  };
}

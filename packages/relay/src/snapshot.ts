// The restart snapshot on disk (ADR 0046). With TABDOCK_RESTART_SNAPSHOT on,
// a graceful stop writes the hub's store (hub.ts, exportSnapshot) to one file
// in the audit directory, at mode 0600, through a temporary file of its own
// that is synced and renamed into place, as the owner token is written; the
// stop then records the file's SHA-256 in a snapshot_written record, and
// relay_stop follows it at once. The next start, before it writes
// relay_start, takes the file: it opens it, a regular file only, without
// following a link or waiting on a FIFO, reads it, and unlinks it before
// anything else is decided, so a file is read at most once whatever comes
// of it, and an unlink that fails means no load.
// It then loads only a file the audit log binds to the stop that wrote it:
// the log's last two lines must be that snapshot_written, naming this file's
// digest, and the relay_stop chained to it. A file planted, kept from an
// earlier run or written by a stop whose records never reached the disk
// therefore never loads, and neither does one past RESUME_WINDOW_MS, one
// from the future, one written in another mode, or one that does not parse
// strictly at SNAPSHOT_VERSION. Anything else is a fresh start, as with the
// setting off, and a refusal names why in fixed words, never a value from
// the file. With the setting off, a file an earlier run left is removed
// unread, so emails and titles never wait on disk for a later start.
//
// The binding is tamper evidence, as the audit chain is: whoever can write
// the audit directory can forge both, but cannot make an old snapshot load
// once a later run has written to the log.

import { createHash, randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import {
  INVITEE_ID_PREFIX,
  MAX_SNAPSHOT_BYTES,
  MEMBER_RESERVED_SEATS,
  narrowPolicy,
  type RelayMode,
  type RelaySnapshot,
  RelaySnapshotSchema,
  RESUME_WINDOW_MS,
  type SessionEndReason,
  SNAPSHOT_VERSION,
  type SnapshotAgent,
  type SnapshotAttachment,
  type SnapshotInvite,
  type SnapshotPage,
  type UserKind,
} from '@tabdock/protocol';
import { lineHash, listAuditFiles, readLine } from './audit-file.ts';
import { NO_ORIGIN, type ResolvedConfig } from './config.ts';
import { inviteeKeyOf, type MemberList } from './members.ts';
import type {
  AgentTokenRecord,
  AttachmentRecord,
  InviteRecord,
  PageRecord,
  TimedSession,
} from './store.ts';

/** The snapshot's name in the audit directory, which no audit file name can match. */
export const SNAPSHOT_FILE = 'relay-snapshot.json';

/** Owner read and write only, as the audit files are. */
const SNAPSHOT_MODE = 0o600;

/**
 * The temporary file a stop writes before renaming it into place is
 * `.relay-snapshot.json.<16 hex characters>.tmp`: a name no audit file and no
 * snapshot can have, so a start can tell one a stop cut short left behind.
 */
const TEMPORARY_PREFIX = `.${SNAPSHOT_FILE}.`;
const TEMPORARY_SUFFIX = '.tmp';
const TEMPORARY_ID = /^[0-9a-f]{16}$/;

function isTemporaryName(name: string): boolean {
  return (
    name.startsWith(TEMPORARY_PREFIX) &&
    name.endsWith(TEMPORARY_SUFFIX) &&
    TEMPORARY_ID.test(name.slice(TEMPORARY_PREFIX.length, -TEMPORARY_SUFFIX.length))
  );
}

/**
 * How much of each audit file's end the binding check reads: the two lines
 * it needs are a few hundred bytes, and a line longer than this cannot be
 * one of them, so a file whose end holds fewer whole lines refuses.
 */
const TAIL_BYTES = 16_384;

/** The file system calls the snapshot makes, so a test can make any of them fail. */
export type SnapshotFs = Pick<
  typeof nodeFs,
  | 'closeSync'
  | 'fchmodSync'
  | 'fstatSync'
  | 'fsyncSync'
  | 'lstatSync'
  | 'openSync'
  | 'readSync'
  | 'readdirSync'
  | 'renameSync'
  | 'unlinkSync'
  | 'writeSync'
>;

const windows = process.platform === 'win32';
/** O_NOFOLLOW where the platform has it: a link at the snapshot's name is refused, never followed. */
const NO_FOLLOW = windows ? 0 : nodeFs.constants.O_NOFOLLOW;
/**
 * How the start opens what it reads: never through a link, and without
 * waiting, so a FIFO put at the name (or swapped in after the lstat) cannot
 * hold the open, and the start with it, until a writer comes; the fstat
 * after the open refuses it. Windows has neither flag.
 */
const READ_FLAGS =
  nodeFs.constants.O_RDONLY | NO_FOLLOW | (windows ? 0 : nodeFs.constants.O_NONBLOCK);

export type WriteOutcome =
  { kind: 'written'; sha256: string } | { kind: 'refused'; reason: string };

/** What a start found. `removed` says whether the file is gone, as it must be before any load. */
export type TakeOutcome =
  | { kind: 'none' }
  | { kind: 'refused'; reason: string; removed: boolean }
  | { kind: 'loaded'; snapshot: RelaySnapshot; ageMs: number };

export interface TakeOptions {
  /** The audit directory, which the open audit log holds the lock on. */
  dir: string;
  /** TABDOCK_RESTART_SNAPSHOT: off, a file found is removed unread. */
  enabled: boolean;
  now: number;
  /** The mode this relay runs in; a snapshot from another mode names other people's accounts. */
  mode: RelayMode;
  fs?: SnapshotFs | undefined;
}

function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    if (typeof code === 'string') return code;
  }
  return 'error';
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** So a rename or an unlink survives a crash as the bytes do; not every system allows it. */
function syncDirectory(dir: string, fs: SnapshotFs): void {
  try {
    const fd = fs.openSync(dir, nodeFs.constants.O_RDONLY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // The file itself is synced; a directory that cannot be synced costs only durability.
  }
}

function removeQuietly(path: string, fs: SnapshotFs): void {
  try {
    fs.unlinkSync(path);
  } catch {
    // Already gone; nothing to tidy.
  }
}

/**
 * Removes, unread, every temporary file a stop cut short left in `dir` (a
 * kill between writeSnapshot's open and its rename), and answers how many.
 * A start calls it whatever the setting, since such a file holds a whole
 * snapshot, emails and page titles included, and nothing else would ever
 * remove it. unlink never follows a link, and a directory under such a name
 * is left as it is.
 */
export function removeTemporaryFiles(dir: string, fs: SnapshotFs = nodeFs): number {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!isTemporaryName(name)) continue;
    try {
      fs.unlinkSync(join(dir, name));
      removed += 1;
    } catch {
      // A directory, or gone already: nothing a snapshot wrote.
    }
  }
  if (removed > 0) syncDirectory(dir, fs);
  return removed;
}

/**
 * Writes the snapshot into `dir` as SNAPSHOT_FILE, after checking it against
 * the schema a start reads it with, so a stop never leaves a file a start
 * would refuse. Answers its SHA-256, which the snapshot_written record
 * carries, or why nothing was written; it never throws, and removes its
 * temporary file on every failure it sees. A process killed between the
 * open and the rename leaves the file, which the next start removes unread
 * (removeTemporaryFiles).
 */
export function writeSnapshot(
  dir: string,
  snapshot: RelaySnapshot,
  fs: SnapshotFs = nodeFs,
): WriteOutcome {
  const parsed = RelaySnapshotSchema.safeParse(snapshot);
  if (!parsed.success) return { kind: 'refused', reason: 'the store failed the snapshot schema' };
  const bytes = Buffer.from(JSON.stringify(parsed.data), 'utf8');
  if (bytes.length > MAX_SNAPSHOT_BYTES) {
    return { kind: 'refused', reason: 'larger than MAX_SNAPSHOT_BYTES' };
  }
  const temp = join(dir, `${TEMPORARY_PREFIX}${randomBytes(8).toString('hex')}${TEMPORARY_SUFFIX}`);
  let fd: number;
  try {
    fd = fs.openSync(
      temp,
      nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL | nodeFs.constants.O_WRONLY | NO_FOLLOW,
      SNAPSHOT_MODE,
    );
  } catch (error) {
    return { kind: 'refused', reason: `cannot create its file (${codeOf(error)})` };
  }
  try {
    // The mode as asked, whatever the process umask left of it.
    if (!windows) fs.fchmodSync(fd, SNAPSHOT_MODE);
    let written = 0;
    while (written < bytes.length) {
      written += fs.writeSync(fd, bytes, written, bytes.length - written);
    }
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    removeQuietly(temp, fs);
    return { kind: 'refused', reason: `cannot write its file (${codeOf(error)})` };
  }
  fs.closeSync(fd);
  try {
    // A rename replaces whatever has the name, a link included, and never follows it.
    fs.renameSync(temp, join(dir, SNAPSHOT_FILE));
  } catch (error) {
    removeQuietly(temp, fs);
    return { kind: 'refused', reason: `cannot put its file in place (${codeOf(error)})` };
  }
  syncDirectory(dir, fs);
  return { kind: 'written', sha256: sha256(bytes) };
}

/** Reads the whole file through an open descriptor, refusing anything but this account's own 0600 regular file. */
function readOwnFile(path: string, fs: SnapshotFs): Buffer | string {
  let fd: number;
  try {
    fd = fs.openSync(path, READ_FLAGS);
  } catch (error) {
    return `cannot open it (${codeOf(error)})`;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return 'not a regular file';
    // A second name for it, made with a hard link, would outlive the unlink.
    if (stat.nlink !== 1) return 'it has another link';
    if (!windows) {
      const uid = process.getuid?.();
      if (uid !== undefined && stat.uid !== uid) return "another account's file";
      if ((stat.mode & 0o077) !== 0) return 'readable or writable by other accounts';
    }
    if (stat.size > MAX_SNAPSHOT_BYTES) return 'larger than MAX_SNAPSHOT_BYTES';
    // One byte more than allowed, so a file that grew since the fstat is caught too.
    const buffer = Buffer.alloc(stat.size + 1);
    let read = 0;
    for (;;) {
      const got = fs.readSync(fd, buffer, read, buffer.length - read, read);
      if (got === 0) break;
      read += got;
      if (read > MAX_SNAPSHOT_BYTES || read === buffer.length) return 'it changed while read';
    }
    return buffer.subarray(0, read);
  } catch (error) {
    return `cannot read it (${codeOf(error)})`;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The whole lines at the end of one audit file, oldest first, and whether
 * they are all its lines: false when the file is longer than what was read,
 * so a line before them was not seen. null when the end is no whole line.
 */
function fileTail(path: string, fs: SnapshotFs): { lines: string[]; whole: boolean } | null {
  let fd: number;
  try {
    fd = fs.openSync(path, READ_FLAGS);
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    // listAuditFiles lists regular files only; this holds for one swapped in since.
    if (!stat.isFile()) return null;
    const { size } = stat;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const got = fs.readSync(fd, buffer, read, buffer.length - read, start + read);
      if (got === 0) return null;
      read += got;
    }
    if (size === 0) return { lines: [], whole: true };
    // The relay closes a torn last line with a newline when it opens the log,
    // so an end without one is a line still being written, never a record.
    if (buffer[buffer.length - 1] !== 0x0a) return null;
    const lines = buffer
      .subarray(0, buffer.length - 1)
      .toString('utf8')
      .split('\n');
    // A read that began mid-file began mid-line.
    if (start > 0) lines.shift();
    return { lines, whole: start === 0 };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The audit log's last `count` lines, oldest first, read from the end of the
 * newest file and, when that holds fewer, the ones before it; null when they
 * cannot all be seen.
 */
function auditTail(dir: string, count: number, fs: SnapshotFs): string[] | null {
  let files: string[];
  try {
    files = listAuditFiles(dir, fs).map((file) => file.name);
  } catch {
    return null;
  }
  const tail: string[] = [];
  for (let index = files.length - 1; index >= 0 && tail.length < count; index -= 1) {
    const name = files[index];
    if (name === undefined) return null;
    const read = fileTail(join(dir, name), fs);
    if (read === null) return null;
    tail.unshift(...read.lines.slice(-(count - tail.length)));
    if (tail.length < count && !read.whole) return null;
  }
  return tail.length === count ? tail : null;
}

/**
 * Why the audit log does not bind this file, or null when it does: its last
 * line is relay_stop, and the line before it is the snapshot_written that
 * names the file's digest, the stop's prev being that line's own digest and
 * its seq the next, so the two were written one after the other and nothing
 * followed them.
 */
export function bindingProblem(
  dir: string,
  digest: string,
  fs: SnapshotFs = nodeFs,
): string | null {
  const tail = auditTail(dir, 2, fs);
  if (tail === null) return "the audit log's last records cannot be read";
  const [writtenText, stopText] = tail;
  if (writtenText === undefined || stopText === undefined) {
    return "the audit log's last records cannot be read";
  }
  const written = readLine('', 0, writtenText).record;
  const stop = readLine('', 0, stopText).record;
  if (stop?.type !== 'relay_stop') return 'the audit log does not end with a relay_stop';
  if (written?.type !== 'snapshot_written') {
    return 'the relay_stop that ends the audit log follows no snapshot_written';
  }
  if (stop.seq !== written.seq + 1 || stop.prev !== lineHash(writtenText)) {
    return "the audit log's last two records are not chained";
  }
  if (written.sha256 !== digest) return 'the snapshot_written record names another file';
  return null;
}

/**
 * Takes the snapshot a graceful stop left, at most once: whatever comes of
 * it, the file is gone afterwards, or nothing loads. Call it after the audit
 * log is open (so its lock is held and a torn last line is closed) and before
 * relay_start, whose line would end the binding.
 */
export function takeSnapshot(options: TakeOptions): TakeOutcome {
  const fs = options.fs ?? nodeFs;
  const path = join(options.dir, SNAPSHOT_FILE);
  // Only a regular file is ever opened: a FIFO, a device, a directory or a
  // link at the name is refused by what lstat says, before any open.
  let unreadable: string | null = null;
  try {
    if (!fs.lstatSync(path).isFile()) unreadable = 'not a regular file';
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return { kind: 'none' };
    unreadable = `cannot inspect it (${codeOf(error)})`;
  }
  const bytes = !options.enabled
    ? 'TABDOCK_RESTART_SNAPSHOT is off, so it was removed unread'
    : (unreadable ?? readOwnFile(path, fs));
  try {
    fs.unlinkSync(path);
  } catch (error) {
    return {
      kind: 'refused',
      reason: `it could not be removed (${codeOf(error)})`,
      removed: false,
    };
  }
  syncDirectory(options.dir, fs);
  if (typeof bytes === 'string') return { kind: 'refused', reason: bytes, removed: true };
  const unbound = bindingProblem(options.dir, sha256(bytes), fs);
  if (unbound !== null) return { kind: 'refused', reason: unbound, removed: true };
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { kind: 'refused', reason: 'it is not JSON', removed: true };
  }
  const parsed = RelaySnapshotSchema.safeParse(value);
  if (!parsed.success) {
    return {
      kind: 'refused',
      reason: `it is no version ${String(SNAPSHOT_VERSION)} snapshot`,
      removed: true,
    };
  }
  const snapshot = parsed.data;
  const ageMs = options.now - snapshot.writtenAt;
  if (ageMs < 0) return { kind: 'refused', reason: 'it was written in the future', removed: true };
  if (ageMs >= RESUME_WINDOW_MS) {
    return { kind: 'refused', reason: 'it is older than the resume window', removed: true };
  }
  if (snapshot.mode !== options.mode) {
    return { kind: 'refused', reason: 'it was written in another mode', removed: true };
  }
  return { kind: 'loaded', snapshot, ageMs };
}

/**
 * Why this relay cannot take the snapshot as it is configured now, or null:
 * more page sessions than it holds, a page from an origin it no longer lets
 * attach, invites or invitees with invites off, agent tokens with them off,
 * or a page whose attachments its seats could never have let in. Each would
 * put back what this relay could not have let in, so the whole snapshot is
 * refused rather than cut.
 */
export function fitProblem(snapshot: RelaySnapshot, config: ResolvedConfig): string | null {
  const { limits, invites, agentTokens } = config;
  if (snapshot.pages.length > limits.pageSessions)
    return 'more page sessions than this relay holds';
  // Its tab could never resume through the origin check (S2), and its
  // people, invites and tokens would sit listed for the whole resume window.
  const allowed = (origin: string): boolean =>
    origin === NO_ORIGIN ? config.allowMissingOrigin : config.isOriginAllowed(origin);
  if (!snapshot.pages.every((page) => allowed(page.origin))) {
    return 'a page from an origin this relay does not allow';
  }
  if (!invites && snapshot.invites.length > 0) return 'live invites, and invites are off';
  if (!invites && snapshot.attachments.some((attachment) => attachment.kind === 'invitee')) {
    return 'invited accounts, and invites are off';
  }
  if (!agentTokens && snapshot.agents.length > 0) return 'agent tokens, and they are off';
  return seatProblem(snapshot.attachments, config);
}

/**
 * Why a page's attachments could not all have been let in under this
 * relay's seats, or null. Seats are counted as the hub counts them (hub.ts,
 * #seatOf): an invitee's observer watches while there are watching seats,
 * and everyone else is among the page's people. Only what the hub holds to
 * at every moment is asked of the file, so a snapshot of a state the hub
 * allows always fits: the people never pass usersPerPage (#pageFull), those
 * an invite let in among them leave members their reserve
 * (#inviteSeatsFull), and the watchers a watch invite or an agent token let
 * in never pass the watching seats (#watchingFull). A watcher an operator
 * moved down from the people takes no seat to move (#noSeatFor), so the
 * watchers in all may pass their seats until someone leaves, and are not
 * counted against them here. With a limit lowered while the relay was down,
 * the start refuses what the lower limit would have kept out (S9).
 */
function seatProblem(
  attachments: readonly SnapshotAttachment[],
  config: ResolvedConfig,
): string | null {
  const { usersPerPage, observersPerPage } = config.limits;
  const watchingSeats = config.invites ? observersPerPage : 0;
  const people = new Map<string, number>();
  const invitedPeople = new Map<string, number>();
  const invitedWatchers = new Map<string, number>();
  const add = (counts: Map<string, number>, pageId: string): number => {
    const count = (counts.get(pageId) ?? 0) + 1;
    counts.set(pageId, count);
    return count;
  };
  for (const attachment of attachments) {
    const { pageId } = attachment;
    const watching =
      watchingSeats > 0 && attachment.kind === 'invitee' && attachment.role === 'observer';
    if (watching) {
      // A watch invite never made a driver, and an agent token's invite is a watch one.
      if (attachment.inviteRole === 'observer' && add(invitedWatchers, pageId) > watchingSeats) {
        return 'a page with more watchers by invite than its watching seats';
      }
      continue;
    }
    if (add(people, pageId) > usersPerPage) return 'a page with more people than its seats';
    if (
      attachment.inviteId !== null &&
      add(invitedPeople, pageId) > usersPerPage - MEMBER_RESERVED_SEATS
    ) {
      return "a page whose invited people take its members' reserved seats";
    }
  }
  return null;
}

/**
 * Who a restored account still is, under the member list in force (ADR
 * 0043). A member's attachment carries a digest of the subject its user id
 * stood for at the stop, and loads only when the list gives that id the same
 * subject now, so an id removed or handed to someone else while the relay was
 * down restores nothing, as a live list change ends it (S8, S13). An invitee
 * whose subject the list now names as a member signs in as that member, so
 * what it held as an invitee goes too. A relay with no list, dev tokens or
 * local mode, binds nothing: its members come back as they were.
 */
export interface SnapshotAccounts {
  /** The key a member's attachment is saved with: null with no list, or for an id the list no longer names. */
  readonly memberKey: (userId: string) => string | null;
  /** Whether a saved account is still the same person now. */
  readonly stillHolds: (account: {
    userId: string;
    kind: UserKind;
    memberKey: string | null;
  }) => boolean;
}

export function snapshotAccounts(members: MemberList | null): SnapshotAccounts {
  if (members === null) {
    return {
      memberKey: () => null,
      stillHolds: (account) => account.kind === 'invitee' || account.memberKey === null,
    };
  }
  const entries = members.entries();
  const subOf = new Map(entries.map((entry) => [entry.userId, entry.sub]));
  const asInvitees = new Set(
    entries.map((entry) => `${INVITEE_ID_PREFIX}${inviteeKeyOf(entry.sub)}`),
  );
  const memberKey = (userId: string): string | null => {
    const sub = subOf.get(userId);
    return sub === undefined
      ? null
      : createHash('sha256')
          .update(JSON.stringify(['tabdock restart snapshot member', sub, userId]), 'utf8')
          .digest('hex');
  };
  return {
    memberKey,
    stillHolds: (account) =>
      account.kind === 'invitee'
        ? !asInvitees.has(account.userId)
        : account.memberKey !== null && account.memberKey === memberKey(account.userId),
  };
}

// The store's records and the snapshot's entries, field by field both ways,
// so a field added to a record fails to compile here until the snapshot says
// what it does with it.

/** A page session as saved; `sessionEnded` is one the page has yet to hear of. */
export function savedPage(
  page: PageRecord,
  sessionEnded: { sessionId: string; reason: SessionEndReason } | null,
): SnapshotPage {
  const session = page.timedSession;
  return {
    pageId: page.pageId,
    origin: page.origin,
    title: page.title,
    url: page.url,
    adapterVersion: page.adapterVersion,
    connectedAt: page.connectedAt,
    ceiling: narrowPolicy(page.ceiling, null),
    timedSession: session === null ? null : { ...session, policy: { ...session.policy } },
    sessionEnded: session === null && sessionEnded !== null ? { ...sessionEnded } : null,
    resumeTokenHash: page.resumeTokenHash,
  };
}

/**
 * A page session as a start puts it back: asleep since `now`, its tools to
 * come with its next tools frame, and the policy in force worked out again
 * from its ceiling and session, never read from the file.
 */
export function restoredPage(saved: SnapshotPage, now: number): PageRecord {
  const session: TimedSession | null =
    saved.timedSession === null
      ? null
      : { ...saved.timedSession, policy: { ...saved.timedSession.policy } };
  return {
    pageId: saved.pageId,
    origin: saved.origin,
    title: saved.title,
    url: saved.url,
    adapterVersion: saved.adapterVersion,
    policy: narrowPolicy(saved.ceiling, session?.policy ?? null),
    ceiling: narrowPolicy(saved.ceiling, null),
    timedSession: session,
    tools: [],
    toolsPending: false,
    state: 'asleep',
    resumeTokenHash: saved.resumeTokenHash,
    connectedAt: saved.connectedAt,
    asleepAt: now,
    goneAt: null,
    formerAttachments: [],
  };
}

export function savedAttachment(
  attachment: AttachmentRecord,
  memberKey: string | null,
): SnapshotAttachment {
  return {
    pageId: attachment.pageId,
    userId: attachment.userId,
    displayName: attachment.displayName,
    kind: attachment.kind,
    role: attachment.role,
    grantedAt: attachment.grantedAt,
    lastUsedAt: attachment.lastUsedAt,
    expiresAt: attachment.expiresAt,
    clients: attachment.clients.map((client) => ({ ...client })),
    inviteId: attachment.inviteId,
    endsAt: attachment.endsAt,
    inviteRole: attachment.inviteRole,
    sponsorId: attachment.sponsorId,
    emailHash: attachment.emailHash,
    memberKey: attachment.kind === 'member' ? memberKey : null,
  };
}

export function restoredAttachment(saved: SnapshotAttachment): AttachmentRecord {
  return {
    pageId: saved.pageId,
    userId: saved.userId,
    displayName: saved.displayName,
    kind: saved.kind,
    role: saved.role,
    grantedAt: saved.grantedAt,
    lastUsedAt: saved.lastUsedAt,
    expiresAt: saved.expiresAt,
    clients: saved.clients.map((client) => ({ ...client })),
    inviteId: saved.inviteId,
    endsAt: saved.endsAt,
    inviteRole: saved.inviteRole,
    sponsorId: saved.sponsorId,
    emailHash: saved.emailHash,
  };
}

/** A live invite as saved: never the redemption waiting on it, which the restart ends. */
export function savedInvite(invite: InviteRecord): SnapshotInvite {
  return {
    inviteId: invite.inviteId,
    pageId: invite.pageId,
    role: invite.role,
    label: invite.label,
    uses: invite.uses,
    usesLeft: invite.usesLeft,
    createdAt: invite.createdAt,
    requestedExpiresAt: invite.requestedExpiresAt,
    expiresAt: invite.expiresAt,
    ownExpiresAt: invite.ownExpiresAt,
    secretHash: invite.secretHash,
    sponsor: { ...invite.sponsor },
    refusals: invite.refusals,
    barredUserIds: [...invite.barredUserIds],
    barredEmailHashes: [...invite.barredEmailHashes],
  };
}

export function restoredInvite(saved: SnapshotInvite): InviteRecord {
  return {
    inviteId: saved.inviteId,
    pageId: saved.pageId,
    role: saved.role,
    label: saved.label,
    uses: saved.uses,
    usesLeft: saved.usesLeft,
    createdAt: saved.createdAt,
    requestedExpiresAt: saved.requestedExpiresAt,
    expiresAt: saved.expiresAt,
    ownExpiresAt: saved.ownExpiresAt,
    secretHash: saved.secretHash,
    sponsor: { ...saved.sponsor },
    pendingRequestId: null,
    refusals: saved.refusals,
    barredUserIds: [...saved.barredUserIds],
    barredEmailHashes: [...saved.barredEmailHashes],
  };
}

/** A live agent token as saved: never the prompt its request raised, which the restart ends. */
export function savedAgent(agent: AgentTokenRecord): SnapshotAgent {
  return {
    tokenId: agent.tokenId,
    pageId: agent.pageId,
    label: agent.label,
    secretHash: agent.secretHash,
    createdAt: agent.createdAt,
    expiresAt: agent.expiresAt,
    requestedExpiresAt: agent.requestedExpiresAt,
    sponsor: { ...agent.sponsor },
    state: agent.state,
    timeouts: agent.timeouts,
    userId: agent.userId,
    client: agent.client === null ? null : { ...agent.client },
  };
}

/** A token that was asking comes back dormant, as when its page sleeps (hub.ts, #dropRequests). */
export function restoredAgent(saved: SnapshotAgent): AgentTokenRecord {
  return {
    tokenId: saved.tokenId,
    pageId: saved.pageId,
    label: saved.label,
    secretHash: saved.secretHash,
    createdAt: saved.createdAt,
    expiresAt: saved.expiresAt,
    requestedExpiresAt: saved.requestedExpiresAt,
    sponsor: { ...saved.sponsor },
    state: saved.state === 'asking' ? 'dormant' : saved.state,
    requestId: null,
    timeouts: saved.timeouts,
    userId: saved.userId,
    client: saved.client === null ? null : { ...saved.client },
  };
}

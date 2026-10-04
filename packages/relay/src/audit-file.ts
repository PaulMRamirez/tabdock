// The persistent audit log (S7, ADR 0019): JSON Lines files in one directory,
// on a host its volume. Each record is one line written with a single
// writeSync on an O_APPEND descriptor, so a crash leaves at most one torn line
// at the end of a file, which the next start closes with a newline. Lines are
// synced at most once a second, at rotation and at close, which the relay
// calls after hub.shutdown() so the calls it fails are on disk too. A file
// rotates at AUDIT_ROTATE_MB or at UTC midnight, so each file holds one UTC
// day and is named for it; files go once their day is past the retention or
// once all of them pass the size cap, oldest first, never the current one.
//
// Each line carries a sequence number and the SHA-256 of the previous line as
// written (its UTF-8 text without the newline), chained across files and
// restarts, and a checkpoint line (seq and head) goes to stderr every 15
// minutes, at rotation and at stop. That is tamper evidence, not prevention:
// whoever holds the disk can rewrite everything after the last checkpoint the
// platform's logs still keep, but cannot edit or drop a line before it unseen.
// It uses node:crypto's SHA-256 and no key.
//
// append never throws and never waits, so no call fails for a disk: a write
// that fails leaves the record on stderr only (recordAudit writes that copy),
// and once a write works again an audit_gap record counts what the file
// missed. Failing closed would let a full disk stop every page; a write that
// lands every byte but the newline is a whole record, kept as one. Every line
// is checked against AuditLineSchema and the checked record is what is
// written, so a field no record type lists, such as a token, cannot reach the
// file even by a bug, nested inside another field or not. One log holds its
// directory's lock (audit.lock) from open to close, so a second relay on the
// same directory refuses to start rather than fork the chain.

import { createHash, randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import {
  AUDIT_VERSION,
  type AuditEvent,
  type AuditEventOf,
  type AuditLine,
  AuditLineSchema,
} from '@tabdock/protocol';
import { AUDIT_ROTATE_MB } from './config.ts';
import type { Logger } from './log.ts';
import { type AuditLineMeta, type AuditLog, MemoryAuditLog } from './store.ts';

/** The file system calls the log makes, so a test can make any of them fail. */
export type AuditFs = Pick<
  typeof nodeFs,
  | 'chmodSync'
  | 'closeSync'
  | 'fchmodSync'
  | 'fdatasyncSync'
  | 'fstatSync'
  | 'linkSync'
  | 'lstatSync'
  | 'mkdirSync'
  | 'openSync'
  | 'readFileSync'
  | 'readSync'
  | 'readdirSync'
  | 'statSync'
  | 'unlinkSync'
  | 'writeSync'
>;

export interface FileAuditLogOptions {
  /** An absolute directory; made 0700 if missing. */
  dir: string;
  /** Files whose UTC day ended longer ago than this are deleted. */
  retentionDays: number;
  /** Past this many bytes in all, the oldest files are deleted. */
  maxBytes: number;
  log: Logger;
  /** A file rotates before a line would take it past this; AUDIT_ROTATE_MB MiB unless a test says otherwise. */
  rotateBytes?: number | undefined;
  /** The clock rotation and retention read; Date.now unless a test says otherwise. */
  now?: (() => number) | undefined;
  fs?: AuditFs | undefined;
  /** How many records records() keeps in memory. */
  ringCapacity?: number | undefined;
}

/** A file is audit-<its UTC day>-<the sequence number of its first line, 12 digits>.jsonl. */
const FILE_NAME = /^audit-(\d{4}-\d{2}-\d{2})-(\d{12})\.jsonl$/;

/** Unsynced lines wait at most this long for fdatasync. */
export const AUDIT_SYNC_MS = 1000;
/** How often a checkpoint goes to stderr, besides rotation and stop. */
export const AUDIT_CHECKPOINT_MS = 15 * 60_000;
/** How often retention runs, besides each rotation and the start. */
export const AUDIT_RETENTION_CHECK_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const NEWLINE = 0x0a;

/** Owner read and write only; the directory adds search for its owner. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Why the audit directory cannot be used; the relay refuses to start with it. */
export class AuditDirError extends Error {
  override name = 'AuditDirError';
}

/** The digest each line's successor carries as prev: SHA-256 of its UTF-8 text without the newline. */
export function lineHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The UTC day of a time, as file names carry it. */
export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export interface AuditFileInfo {
  name: string;
  /** The UTC day its records belong to. */
  day: string;
  /** The sequence number its first line was given. */
  firstSeq: number;
}

/** The audit files in a directory, oldest first; anything else there is left alone. */
export function listAuditFiles(
  dir: string,
  fs: Pick<AuditFs, 'readdirSync'> = nodeFs,
): AuditFileInfo[] {
  const files: AuditFileInfo[] = [];
  // Regular files only: a symlink or directory under an audit file's name is never read or appended to.
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const match = entry.isFile() ? FILE_NAME.exec(entry.name) : null;
    if (match === null) continue;
    files.push({ name: entry.name, day: match[1] ?? '', firstSeq: Number(match[2]) });
  }
  return files.sort((a, b) => a.firstSeq - b.firstSeq || a.name.localeCompare(b.name));
}

/** One line of an audit file as a reader sees it: a record, or why it is none. */
export interface ReadLine {
  file: string;
  /** 1-based, within its file. */
  lineNumber: number;
  text: string;
  record: AuditLine | null;
  /** Why the line is no record: not JSON at all (a torn or damaged line), or JSON that is no valid record. */
  problem: 'not_json' | 'not_a_record' | null;
}

/** Reads one line's record, or names why it has none. */
export function readLine(file: string, lineNumber: number, text: string): ReadLine {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { file, lineNumber, text, record: null, problem: 'not_json' };
  }
  const parsed = AuditLineSchema.safeParse(value);
  return parsed.success
    ? { file, lineNumber, text, record: parsed.data, problem: null }
    : { file, lineNumber, text, record: null, problem: 'not_a_record' };
}

/** Every line of the audit files in a directory, oldest first. */
export function* readAuditLines(
  dir: string,
  fs: Pick<AuditFs, 'readdirSync' | 'readFileSync'> = nodeFs,
): Generator<ReadLine> {
  for (const file of listAuditFiles(dir, fs)) {
    const content = fs.readFileSync(join(dir, file.name), 'utf8');
    const lines = content.split('\n');
    // A file ends with a newline, so the last piece is empty unless the file is torn.
    if (lines.at(-1) === '') lines.pop();
    for (const [index, text] of lines.entries()) yield readLine(file.name, index + 1, text);
  }
}

export interface VerifyProblem {
  file: string;
  lineNumber: number;
  problem: string;
}

export interface VerifyReport {
  files: number;
  records: number;
  firstSeq: number | null;
  lastSeq: number | null;
  /** The digest of the last record's line, as a checkpoint names it. */
  head: string | null;
  /**
   * Lines that are not JSON at all: a line torn by a crash or a failed write,
   * which the relay closed with a newline. Named, but no failure while the
   * sequence and chain run on across them, since then no record went missing.
   */
  torn: { file: string; lineNumber: number }[];
  /** Anything that breaks the log: a line that is JSON but no record, a gap in seq, a broken chain, a checkpoint that does not match. */
  problems: VerifyProblem[];
}

/**
 * Checks the chain: every record parses, each seq is one more than the last
 * record's, and each prev is the digest of the last record's line. The first
 * record available is taken as given, since retention may have deleted what
 * came before it. A checkpoint from the platform's logs (seq and head), when
 * given, must match the line of that seq, which also shows an edit to the
 * last lines that no later line could reveal.
 */
export function verifyAuditLines(
  lines: Iterable<ReadLine>,
  checkpoint?: { seq: number; head: string },
): VerifyReport {
  const report: VerifyReport = {
    files: 0,
    records: 0,
    firstSeq: null,
    lastSeq: null,
    head: null,
    torn: [],
    problems: [],
  };
  let file: string | null = null;
  let checkpointSeen = false;
  for (const line of lines) {
    if (line.file !== file) {
      file = line.file;
      report.files += 1;
    }
    if (line.problem === 'not_json') {
      report.torn.push({ file: line.file, lineNumber: line.lineNumber });
      continue;
    }
    const record = line.record;
    if (record === null) {
      report.problems.push({ ...where(line), problem: 'valid JSON but not an audit record' });
      continue;
    }
    if (report.lastSeq !== null) {
      if (record.seq !== report.lastSeq + 1) {
        report.problems.push({
          ...where(line),
          problem: `seq ${String(record.seq)} follows ${String(report.lastSeq)}: records are missing or out of order`,
        });
      }
      if (record.prev !== report.head) {
        report.problems.push({
          ...where(line),
          problem:
            'prev is not the digest of the previous record: a line before it was changed or removed',
        });
      }
    }
    const hash = lineHash(line.text);
    if (checkpoint !== undefined && record.seq === checkpoint.seq) {
      checkpointSeen = true;
      if (hash !== checkpoint.head) {
        report.problems.push({
          ...where(line),
          problem: `the line with seq ${String(checkpoint.seq)} does not match the checkpoint: it was changed`,
        });
      }
    }
    report.records += 1;
    report.firstSeq ??= record.seq;
    report.lastSeq = record.seq;
    report.head = hash;
  }
  if (checkpoint !== undefined && !checkpointSeen) {
    report.problems.push({
      file: file ?? '(none)',
      lineNumber: 0,
      problem: `no record has the checkpoint's seq ${String(checkpoint.seq)}: it was removed, or retention deleted its file`,
    });
  }
  return report;
}

function where(line: ReadLine): { file: string; lineNumber: number } {
  return { file: line.file, lineNumber: line.lineNumber };
}

function codeOf(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return error instanceof Error ? error.name : typeof error;
}

/** The file the log appends to now. */
interface CurrentFile {
  name: string;
  day: string;
  fd: number | null;
  size: number;
}

/** What the file missed while writing failed, for the audit_gap record that follows. */
interface Gap {
  lost: number;
  firstAt: number;
  lastAt: number;
}

export class FileAuditLog implements AuditLog {
  readonly #dir: string;
  readonly #retentionMs: number;
  readonly #maxBytes: number;
  readonly #rotateBytes: number;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #fs: AuditFs;
  readonly #ring: MemoryAuditLog;
  #current: CurrentFile | null = null;
  /** The seq the next line gets. */
  #nextSeq: number;
  /** The digest of the last line written; null before any line was ever written here. */
  #head: string | null;
  #gap: Gap | null = null;
  /** Whether a failure has been logged since writing last worked, so a full disk logs once. */
  #failing = false;
  /** Lines written since the last fdatasync. */
  #dirty = false;
  #syncTimer: NodeJS.Timeout | null = null;
  readonly #intervals: NodeJS.Timeout[] = [];
  #closed = false;
  /** Held from open to close, so no second relay writes this directory meanwhile. */
  readonly #lock: AuditLock;

  private constructor(
    options: FileAuditLogOptions,
    recovered: { nextSeq: number; head: string | null },
    lock: AuditLock,
  ) {
    this.#lock = lock;
    this.#dir = options.dir;
    this.#retentionMs = options.retentionDays * DAY_MS;
    this.#maxBytes = options.maxBytes;
    this.#rotateBytes = options.rotateBytes ?? AUDIT_ROTATE_MB * 1024 * 1024;
    this.#log = options.log;
    this.#now = options.now ?? Date.now;
    this.#fs = options.fs ?? nodeFs;
    this.#ring = new MemoryAuditLog(options.ringCapacity);
    this.#nextSeq = recovered.nextSeq;
    this.#head = recovered.head;
  }

  /**
   * Opens the log in its directory, making the directory if missing, and
   * picks up the sequence and chain where the last line left them, closing a
   * torn last line first. Throws AuditDirError when the directory cannot be
   * used at all; a write that fails later never throws.
   */
  static open(options: FileAuditLogOptions): FileAuditLog {
    const fs = options.fs ?? nodeFs;
    prepareDir(options.dir, fs);
    // Before anything is read or written, so a second relay changes nothing.
    const lock = takeLock(options.dir, fs, options.log);
    let recovered: { nextSeq: number; head: string | null };
    try {
      recovered = recover(options.dir, fs, options.log);
    } catch (error) {
      releaseLock(lock, fs);
      throw error;
    }
    const audit = new FileAuditLog(options, recovered, lock);
    audit.#retain();
    const checkpoints = setInterval(() => {
      audit.#checkpoint();
    }, AUDIT_CHECKPOINT_MS);
    const retention = setInterval(() => {
      audit.#retain();
    }, AUDIT_RETENTION_CHECK_MS);
    checkpoints.unref();
    retention.unref();
    audit.#intervals.push(checkpoints, retention);
    return audit;
  }

  /** The directory the files live in. */
  get dir(): string {
    return this.#dir;
  }

  append(event: AuditEvent): AuditLineMeta | null {
    // What the file missed comes first, so the gap record precedes the record that found writing working again.
    if (this.#closed || (this.#gap !== null && !this.#writeGap())) {
      this.#ring.append(event);
      if (!this.#closed) this.#lose(event);
      return null;
    }
    this.#ring.append(event);
    const meta = this.#write(event);
    if (meta === null) this.#lose(event);
    return meta;
  }

  records(): AuditEvent[] {
    return this.#ring.records();
  }

  /**
   * Syncs what was written now; false if that failed or no file is open. The
   * relay calls it once after relay_start, which production must have on disk
   * before it serves anyone (ADR 0019).
   */
  sync(): boolean {
    if (this.#syncTimer !== null) clearTimeout(this.#syncTimer);
    this.#syncTimer = null;
    const fd = this.#current?.fd ?? null;
    if (fd === null) return false;
    if (!this.#dirty) return true;
    try {
      this.#fs.fdatasyncSync(fd);
      this.#dirty = false;
      return true;
    } catch (error) {
      this.#log.warn(
        'audit file sync failed; the lines since the last sync may not survive a power loss',
        {
          error: codeOf(error),
        },
      );
      return false;
    }
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    for (const interval of this.#intervals) clearInterval(interval);
    this.sync();
    this.#checkpoint();
    this.#closeCurrent();
    releaseLock(this.#lock, this.#fs);
    return Promise.resolve();
  }

  /** Writes one record's line, rotating first when due; null when the file did not take it. */
  #write(event: AuditEvent): AuditLineMeta | null {
    const meta: AuditLineMeta = { seq: this.#nextSeq, prev: this.#head };
    const checked = AuditLineSchema.safeParse({ ...event, seq: meta.seq, prev: meta.prev });
    if (!checked.success) {
      // A bug, never a disk: the record stays in memory and on stderr, and the file stays clean.
      this.#log.error('audit record does not match its schema; it was not written to the file', {
        type: event.type,
        fields: checked.error.issues.map((issue) => issue.path.join('.')).slice(0, 10),
      });
      return null;
    }
    // What the schema let through is written, never the object it was given:
    // a nested object such as client keeps only the keys its schema lists, so
    // nothing rides along inside one. seq right after v, so a person reading
    // the file sees it early, and prev last, where the schema puts it; the
    // digest covers the text as written.
    const { v, seq, ...fields } = checked.data;
    const text = JSON.stringify({ v, seq, ...fields });
    const bytes = Buffer.byteLength(text, 'utf8') + 1;
    /** Whether the whole line reached the file, its newline perhaps still owed. */
    let landed = false;
    try {
      const current = this.#fileFor(bytes);
      const fd = current.fd ?? this.#openCurrent(current);
      const buffer = Buffer.from(`${text}\n`, 'utf8');
      const written = this.#fs.writeSync(fd, buffer);
      current.size += written;
      if (written === buffer.length - 1) {
        // Every byte but the newline landed, as a disk that fills at the last
        // byte leaves it: the line is whole, so it is this record, and only
        // its newline is owed. Counting it lost would give the next line its
        // seq and a prev that skips it.
        landed = true;
        const closed = this.#fs.writeSync(fd, Buffer.from('\n'));
        current.size += closed;
        if (closed !== 1) throw Object.assign(new Error('short write'), { code: 'ESHORT' });
      } else if (written !== buffer.length) {
        // Part of the line landed; the next open sees the torn end and closes it.
        throw Object.assign(new Error('short write'), { code: 'ESHORT' });
      }
    } catch (error) {
      this.#failed(error);
      // A whole line is in the file even so, and the next open gives it its newline.
      if (!landed) return null;
    }
    this.#nextSeq += 1;
    this.#head = lineHash(text);
    if ((this.#current?.fd ?? null) !== null) {
      this.#failing = false;
      this.#dirty = true;
      this.#syncSoon();
    }
    return meta;
  }

  /** Writes the audit_gap record for what the file missed; false while writing still fails. */
  #writeGap(): boolean {
    const gap = this.#gap;
    if (gap === null) return true;
    const record: AuditEventOf<'audit_gap'> = {
      v: AUDIT_VERSION,
      type: 'audit_gap',
      at: this.#now(),
      lost: gap.lost,
      firstAt: gap.firstAt,
      lastAt: gap.lastAt,
    };
    const meta = this.#write(record);
    if (meta === null) return false;
    this.#gap = null;
    this.#ring.append(record);
    // This log made the record itself, so it writes the stderr copy too (ADR 0019's notes).
    this.#log.info(record.type, { audit: { ...record, ...meta } });
    return true;
  }

  #lose(event: AuditEvent): void {
    const gap = this.#gap;
    this.#gap =
      gap === null
        ? { lost: 1, firstAt: event.at, lastAt: event.at }
        : {
            lost: gap.lost + 1,
            firstAt: Math.min(gap.firstAt, event.at),
            lastAt: Math.max(gap.lastAt, event.at),
          };
  }

  #failed(error: unknown): void {
    if (!this.#failing) {
      this.#failing = true;
      this.#log.error(
        'audit file write failed; records reach only stderr until writing works again, then an audit_gap record counts them (ADR 0019)',
        { error: codeOf(error) },
      );
    }
    // Closed, so the next attempt opens the file again and checks how it ends.
    if (this.#current !== null) this.#closeFd(this.#current);
  }

  /** The file the next line goes to, after rotating when the day changed or the line would not fit. */
  #fileFor(bytes: number): CurrentFile {
    const day = utcDay(this.#now());
    const current = this.#current;
    const rotating = current !== null;
    if (current !== null) {
      const full = current.size > 0 && current.size + bytes > this.#rotateBytes;
      if (current.day === day && !full) return current;
      this.#rotate();
    }
    const name = `audit-${day}-${String(this.#nextSeq).padStart(12, '0')}.jsonl`;
    const next: CurrentFile = { name, day, fd: null, size: 0 };
    this.#current = next;
    // After each rotation, with the new file already current, so it is never a candidate.
    if (rotating) this.#retain();
    return next;
  }

  #rotate(): void {
    this.sync();
    this.#checkpoint();
    this.#closeCurrent();
  }

  /**
   * Opens the current file for appending, never through a symlink, and closes
   * a torn last line first, since a failed or short write may have left one.
   */
  #openCurrent(current: CurrentFile): number {
    const path = join(this.#dir, current.name);
    const fd = this.#fs.openSync(
      path,
      nodeFs.constants.O_WRONLY | nodeFs.constants.O_APPEND | nodeFs.constants.O_CREAT | noFollow(),
      FILE_MODE,
    );
    try {
      this.#fs.fchmodSync(fd, FILE_MODE);
      const size = this.#fs.fstatSync(fd).size;
      if (size > 0 && lastByte(this.#fs, path, size) !== NEWLINE) {
        this.#fs.writeSync(fd, Buffer.from('\n'));
        current.size = size + 1;
      } else {
        current.size = size;
      }
    } catch (error) {
      this.#fs.closeSync(fd);
      throw error;
    }
    current.fd = fd;
    return fd;
  }

  #closeCurrent(): void {
    if (this.#current !== null) this.#closeFd(this.#current);
    this.#current = null;
  }

  #closeFd(current: CurrentFile): void {
    if (current.fd === null) return;
    try {
      this.#fs.closeSync(current.fd);
    } catch {
      // A descriptor the disk already broke has nothing left to flush.
    }
    current.fd = null;
    this.#dirty = false;
  }

  #syncSoon(): void {
    if (this.#syncTimer !== null) return;
    this.#syncTimer = setTimeout(() => {
      this.#syncTimer = null;
      this.sync();
    }, AUDIT_SYNC_MS);
    this.#syncTimer.unref();
  }

  /** seq and head to stderr, where the platform's logs keep a copy the disk's holder cannot rewrite. */
  #checkpoint(): void {
    if (this.#head === null) return;
    this.#log.info('audit checkpoint', { seq: this.#nextSeq - 1, head: this.#head });
  }

  /** Deletes files past the retention, then the oldest past the size cap; never the current file. */
  #retain(): void {
    let files: (AuditFileInfo & { size: number })[];
    try {
      files = listAuditFiles(this.#dir, this.#fs).map((file) => ({
        ...file,
        size: this.#fs.statSync(join(this.#dir, file.name)).size,
      }));
    } catch (error) {
      this.#log.warn('audit retention could not list the audit directory', {
        error: codeOf(error),
      });
      return;
    }
    // Before the first line of a start no file is open, and the newest, which
    // the chain was just read from, counts as current.
    const current = this.#current?.name ?? files.at(-1)?.name;
    const cutoff = this.#now() - this.#retentionMs;
    let total = files.reduce((sum, file) => sum + file.size, 0);
    const remove = (file: AuditFileInfo & { size: number }, reason: 'age' | 'size'): void => {
      try {
        this.#fs.unlinkSync(join(this.#dir, file.name));
        total -= file.size;
        this.#log.info('audit file deleted by retention', { file: file.name, reason });
      } catch (error) {
        this.#log.warn('audit retention could not delete a file', {
          file: file.name,
          error: codeOf(error),
        });
      }
    };
    const kept: (AuditFileInfo & { size: number })[] = [];
    for (const file of files) {
      // A file holds one UTC day, so it goes once that whole day is past the retention.
      const dayEnds = Date.parse(`${file.day}T00:00:00.000Z`) + DAY_MS;
      if (file.name !== current && dayEnds <= cutoff) remove(file, 'age');
      else kept.push(file);
    }
    for (const file of kept) {
      if (total <= this.#maxBytes) break;
      if (file.name !== current) remove(file, 'size');
    }
  }
}

/**
 * The lock file a log holds in its directory from open to close. Two relays
 * appending to one directory would each go on from the chain's head as they
 * last saw it, so their lines would share seq numbers and prev digests, and
 * --verify would report an untouched log as broken; so the second relay
 * refuses to start before it reads or writes anything, naming the lock.
 */
export const AUDIT_LOCK_NAME = 'audit.lock';

/** A lock this process holds: its path, its text, and the directory it is held for. */
interface AuditLock {
  path: string;
  text: string;
  dir: string;
}

/**
 * Directories this process holds the lock of, by real path. The pid in a
 * lock cannot tell this process's own lock from one an earlier run left with
 * the same pid (in a container the relay is pid 1 every time), so a second
 * log in this process is refused here.
 */
const heldHere = new Set<string>();

/** This boot of the machine, where Linux names it; a lock from another boot is stale whatever its pid. */
function bootId(fs: AuditFs): string {
  try {
    const id = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return /^[0-9a-f-]{1,64}$/.test(id) ? id : '-';
  } catch {
    return '-';
  }
}

/**
 * The pid of the relay that wrote a lock, when it may still be running: a pid
 * on this boot, not this process's own, that the system says exists; else
 * null. A lock that cannot be read as one was left by no relay, since a lock
 * is written whole before it takes its name.
 */
function lockHolder(text: string, boot: string): number | null {
  const match = /^(\d{1,10}) ([0-9a-f-]{1,64})\n$/.exec(text);
  if (match === null) return null;
  const pid = Number(match[1]);
  const lockBoot = match[2] ?? '-';
  if (lockBoot !== '-' && boot !== '-' && lockBoot !== boot) return null;
  if (pid === process.pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    // EPERM: it runs, as another account.
    return codeOf(error) === 'EPERM' ? pid : null;
  }
}

/**
 * Takes the directory's lock: the pid and boot go into a file of this
 * process's own, which is then linked to the lock's name, so the lock appears
 * whole or not at all and a second relay never reads half of one. A lock left
 * by a relay that is gone (a crash, a container restarted) is replaced.
 */
function takeLock(dir: string, fs: AuditFs, log: Logger): AuditLock {
  const real = nodeFs.realpathSync(dir);
  if (heldHere.has(real)) {
    throw new AuditDirError(
      `the audit directory ${dir} (TABDOCK_AUDIT_DIR) is already open in this process; one relay writes one audit log (ADR 0019)`,
    );
  }
  const path = join(dir, AUDIT_LOCK_NAME);
  const text = `${String(process.pid)} ${bootId(fs)}\n`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const own = join(
      dir,
      `${AUDIT_LOCK_NAME}.${String(process.pid)}.${randomBytes(6).toString('hex')}`,
    );
    try {
      const fd = fs.openSync(
        own,
        nodeFs.constants.O_WRONLY | nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL | noFollow(),
        FILE_MODE,
      );
      try {
        fs.writeSync(fd, Buffer.from(text));
      } finally {
        fs.closeSync(fd);
      }
      fs.linkSync(own, path);
      heldHere.add(real);
      return { path, text, dir: real };
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') {
        throw new AuditDirError(
          `cannot lock the audit directory ${dir} (TABDOCK_AUDIT_DIR, ${codeOf(error)}); the relay must be able to create ${AUDIT_LOCK_NAME} there`,
        );
      }
    } finally {
      try {
        fs.unlinkSync(own);
      } catch {
        // Never made, or already gone.
      }
    }
    let held: string;
    try {
      held = fs.readFileSync(path, 'utf8');
    } catch (error) {
      // Released between the link and the read: try again.
      if (codeOf(error) === 'ENOENT') continue;
      throw new AuditDirError(`cannot read the audit lock ${path} (${codeOf(error)})`);
    }
    const pid = lockHolder(held, bootId(fs));
    if (pid !== null) {
      throw new AuditDirError(
        `the audit directory ${dir} (TABDOCK_AUDIT_DIR) is in use by another relay, pid ${String(pid)}, which holds ${path}; two relays writing one audit log would break its chain (ADR 0019). Stop that relay first or, if none is running, delete ${path}`,
      );
    }
    log.warn('replaced an audit directory lock left by a relay that is gone', {
      lock: AUDIT_LOCK_NAME,
    });
    try {
      fs.unlinkSync(path);
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') {
        throw new AuditDirError(`cannot remove the stale audit lock ${path} (${codeOf(error)})`);
      }
    }
  }
  throw new AuditDirError(
    `cannot lock the audit directory ${dir} (TABDOCK_AUDIT_DIR): another relay keeps taking ${path}`,
  );
}

/** Gives the lock up, leaving alone a lock that is no longer this log's. */
function releaseLock(lock: AuditLock, fs: AuditFs): void {
  heldHere.delete(lock.dir);
  try {
    if (fs.readFileSync(lock.path, 'utf8') === lock.text) fs.unlinkSync(lock.path);
  } catch {
    // Gone already: no lock is all a release must leave.
  }
}

/** O_NOFOLLOW where the platform has it; Node has none on Windows, where prepareDir's lstat stands in. */
function noFollow(): number {
  return process.platform === 'win32' ? 0 : nodeFs.constants.O_NOFOLLOW;
}

function lastByte(fs: AuditFs, path: string, size: number): number {
  const fd = fs.openSync(path, nodeFs.constants.O_RDONLY | noFollow());
  try {
    const buffer = Buffer.alloc(1);
    fs.readSync(fd, buffer, 0, 1, size - 1);
    return buffer[0] ?? NEWLINE;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Makes the directory 0700 if it is missing, and refuses one that is no
 * directory or belongs to another account. A directory of ours that others
 * may read is narrowed rather than refused: unlike the owner token, the files
 * in it were written 0600, so nothing in it was exposed by the wider mode.
 */
function prepareDir(dir: string, fs: AuditFs): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  } catch (error) {
    throw new AuditDirError(
      `cannot create the audit directory ${dir} (TABDOCK_AUDIT_DIR, ${codeOf(error)}); its parent must be writable by the account the relay runs as. On a host volume, see "Volume ownership fallback" in docs/deploy.md`,
    );
  }
  let stat: nodeFs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch (error) {
    throw new AuditDirError(
      `cannot read the audit directory ${dir} (TABDOCK_AUDIT_DIR, ${codeOf(error)})`,
    );
  }
  if (!stat.isDirectory()) {
    throw new AuditDirError(
      `the audit directory ${dir} (TABDOCK_AUDIT_DIR) is not a directory, or is a symlink; give the real directory`,
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && process.platform !== 'win32' && stat.uid !== uid) {
    throw new AuditDirError(
      `the audit directory ${dir} (TABDOCK_AUDIT_DIR) belongs to another account; chown it to the account the relay runs as (uid ${String(uid)}). On a host volume, see "Volume ownership fallback" in docs/deploy.md`,
    );
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    try {
      fs.chmodSync(dir, DIR_MODE);
    } catch (error) {
      throw new AuditDirError(
        `cannot narrow the audit directory ${dir} (TABDOCK_AUDIT_DIR) to mode 700 (${codeOf(error)}); run chmod 700 on it`,
      );
    }
  }
}

/**
 * Where the log goes on: one past the last record's seq, chained to that
 * record's line. A torn last line, which a crash leaves, is closed with a
 * newline here so the next record starts a line of its own; older files are
 * read only when the newest holds no record at all.
 */
function recover(dir: string, fs: AuditFs, log: Logger): { nextSeq: number; head: string | null } {
  let files: AuditFileInfo[];
  try {
    files = listAuditFiles(dir, fs);
  } catch (error) {
    throw new AuditDirError(
      `cannot list the audit directory ${dir} (TABDOCK_AUDIT_DIR, ${codeOf(error)})`,
    );
  }
  for (const [index, file] of [...files].reverse().entries()) {
    const path = join(dir, file.name);
    let content: string;
    try {
      content = fs.readFileSync(path, 'utf8');
    } catch (error) {
      throw new AuditDirError(`cannot read the audit file ${path} (${codeOf(error)})`);
    }
    if (index === 0 && content.length > 0 && !content.endsWith('\n')) {
      closeTornLine(path, fs);
      log.warn('closed a torn last line in the audit log, left by a crash or a failed write', {
        file: file.name,
      });
    }
    const lines = content.split('\n');
    for (let at = lines.length - 1; at >= 0; at -= 1) {
      const text = lines[at] ?? '';
      if (text === '') continue;
      const record = readLine(file.name, at + 1, text).record;
      if (record !== null) return { nextSeq: record.seq + 1, head: lineHash(text) };
    }
  }
  return { nextSeq: 1, head: null };
}

function closeTornLine(path: string, fs: AuditFs): void {
  const fd = fs.openSync(path, nodeFs.constants.O_WRONLY | nodeFs.constants.O_APPEND | noFollow());
  try {
    fs.writeSync(fd, Buffer.from('\n'));
    fs.fdatasyncSync(fd);
  } catch (error) {
    throw new AuditDirError(
      `cannot close a torn line in the audit file ${path} (${codeOf(error)})`,
    );
  } finally {
    fs.closeSync(fd);
  }
}

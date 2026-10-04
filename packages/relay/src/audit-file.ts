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
// restarts, and a checkpoint line goes to stderr at open, every 15 minutes,
// at rotation, after retention deletes a file and at stop: the last seq, its
// line's digest (head) and the seq the log starts at (first). first moves
// only when retention deletes the oldest file, so a file removed from the
// start any other way while the log is open stays missing in every later
// checkpoint, and the open's checkpoint shows one removed while it was
// closed against the stop's before it. That is tamper evidence, not
// prevention: whoever holds the disk can rewrite everything after the newest
// checkpoint the platform's logs still keep, but cannot edit or drop a line
// from its first to its seq unseen. A file whose first record is not the one
// its name gives shows lines cut from its start even without a checkpoint. It
// uses node:crypto's SHA-256 and no key.
//
// append never throws and never waits, so no call fails for a disk: a write
// that fails leaves the record on stderr only (recordAudit writes that copy),
// and once a write works again an audit_gap record counts what the file
// missed. A gap still owed at close is tried once more, then written over
// audit.gap, padding the log wrote at open while the disk worked, which takes
// no new blocks even on a full disk; the next open writes that audit_gap
// first, and stderr has the count either way. --verify names every
// relay_start that follows no relay_stop, since only the platform's logs may
// count what the run before lost last. Failing closed would let a full disk
// stop every page; a write that lands every byte but the newline is a whole
// record, kept as one. Every line is checked against AuditLineSchema and the
// checked record is what is written, so a field no record type lists, such
// as a token, cannot reach the file even by a bug, nested inside another
// field or not.
// One log holds its directory's lock (audit.lock) from open to close,
// refreshing it, so a second relay on the same directory, in this container
// or another on the same volume, refuses to start rather than fork the chain.

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
  | 'readlinkSync'
  | 'renameSync'
  | 'statSync'
  | 'unlinkSync'
  | 'utimesSync'
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
  /**
   * How long a lock may go without its holder's refresh before it counts as
   * left by a relay that is gone; AUDIT_LOCK_STALE_MS unless a test says
   * otherwise. The holder refreshes it six times as often.
   */
  lockStaleMs?: number | undefined;
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
  /**
   * The audit_gap records: what the file missed while its disk failed, each
   * counted, their copies on stderr only. Named, but no failure: ADR 0019
   * fails open.
   */
  gaps: {
    file: string;
    lineNumber: number;
    seq: number;
    lost: number;
    firstAt: number;
    lastAt: number;
  }[];
  /**
   * relay_start records that follow no relay_stop: the run before ended
   * without one on disk (a crash, a kill, or a disk that failed), so records
   * it made last may be missing here, and only the platform's logs may count
   * them. afterGap says an audit_gap comes just before: that gap counts what
   * the file missed up to when it was written, perhaps the relay_stop among
   * them, and anything lost after it is counted on stderr alone. Named, but
   * no failure, since the chain is whole.
   */
  uncleanStops: { file: string; lineNumber: number; seq: number; afterGap: boolean }[];
  /** Anything that breaks the log: a line that is JSON but no record, a gap in seq, a broken chain, a checkpoint that does not match, records cut from the start. */
  problems: VerifyProblem[];
}

/** A checkpoint from the platform's logs, as the relay writes it: the last seq, its line's digest, and the seq the log then started at. */
export interface AuditCheckpoint {
  seq: number;
  head: string;
  /** Absent from a checkpoint copied without it; then where the log starts goes unchecked. */
  first?: number | undefined;
}

/**
 * Checks the chain: every record parses, each seq is one more than the last
 * record's, and each prev is the digest of the last record's line. The first
 * record available is taken as given, since retention may have deleted what
 * came before it; but retention deletes whole files only, so a file whose
 * first record is not the seq its name gives lost lines from its start. A
 * checkpoint from the platform's logs, when given, must match the line of its
 * seq, which also shows an edit to the last lines that no later line could
 * reveal; and the log must still start at or before its first, since a
 * relay moves first only when its retention deletes the oldest file, and
 * checkpoints at once when it does.
 */
export function verifyAuditLines(
  lines: Iterable<ReadLine>,
  checkpoint?: AuditCheckpoint,
): VerifyReport {
  const report: VerifyReport = {
    files: 0,
    records: 0,
    firstSeq: null,
    lastSeq: null,
    head: null,
    torn: [],
    gaps: [],
    uncleanStops: [],
    problems: [],
  };
  let file: string | null = null;
  /** The seq the current file's name gives its first record, until that record is checked. */
  let named: number | null = null;
  let previousType: AuditLine['type'] | null = null;
  let start: { file: string; lineNumber: number } | null = null;
  let checkpointSeen = false;
  for (const line of lines) {
    if (line.file !== file) {
      file = line.file;
      report.files += 1;
      const match = FILE_NAME.exec(line.file);
      named = match === null ? null : Number(match[2]);
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
    if (named !== null) {
      if (record.seq !== named) {
        report.problems.push({
          ...where(line),
          problem: `the file's name says its first record is seq ${String(named)}, but it is seq ${String(record.seq)}: lines were removed from its start, or the file was renamed`,
        });
      }
      named = null;
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
    if (record.type === 'audit_gap') {
      const { seq, lost, firstAt, lastAt } = record;
      report.gaps.push({ ...where(line), seq, lost, firstAt, lastAt });
    }
    // An audit_gap just before is no clean stop: it may be one written mid-run,
    // with more lost after it than the disk ever counted.
    if (record.type === 'relay_start' && previousType !== null && previousType !== 'relay_stop') {
      report.uncleanStops.push({
        ...where(line),
        seq: record.seq,
        afterGap: previousType === 'audit_gap',
      });
    }
    previousType = record.type;
    start ??= where(line);
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
  const first = checkpoint?.first;
  if (first !== undefined && report.firstSeq !== null && report.firstSeq > first) {
    report.problems.push({
      ...(start ?? { file: file ?? '(none)', lineNumber: 0 }),
      problem: `the log starts at seq ${String(report.firstSeq)}, but the checkpoint says it kept every record from seq ${String(first)}: records were removed from its start. Retention deletes whole files only and checkpoints after each deletion, so check against the newest checkpoint`,
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

/** Where a log goes on from: the seq its next line gets, the last line's digest, and the seq its oldest file starts at. */
interface Recovered {
  nextSeq: number;
  head: string | null;
  first: number;
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
  /**
   * The seq the log starts at, which each checkpoint names: where the oldest
   * file started at open, moved on only by this log's own retention.
   */
  #first: number;
  /** The range of seqs last reported missing from the log's start, so a hole is logged once. */
  #missingReported: string | null = null;
  /** Whether #gap came from AUDIT_GAP_NAME, which is cleared once its record is written. */
  #gapOwed = false;
  /** AUDIT_GAP_NAME, open from open to close, so close can write an owed gap over it in place. */
  #gapFile: number | null = null;
  /** Held from open to close, so no second relay writes this directory meanwhile. */
  readonly #lock: AuditLock;
  readonly #lockRefreshMs: number;
  /** When the lock was last refreshed and checked, on a clock a wall-clock step cannot move. */
  #lockCheckedAt: number;
  /** Set once another relay holds the lock: from then on this log writes nothing there. */
  #lockLost = false;
  /** Whether a failed refresh has been logged since one last worked. */
  #lockUnrefreshed = false;

  private constructor(options: FileAuditLogOptions, recovered: Recovered, lock: AuditLock) {
    this.#lock = lock;
    this.#lockRefreshMs = lockRefreshMs(options.lockStaleMs ?? AUDIT_LOCK_STALE_MS);
    this.#lockCheckedAt = performance.now();
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
    this.#first = recovered.first;
  }

  /**
   * Opens the log in its directory, making the directory if missing, and
   * picks up the sequence and chain where the last line left them, closing a
   * torn last line first, and any audit_gap a log that closed while its disk
   * failed still owes, which the first append writes. Throws AuditDirError
   * when the directory cannot be used at all; a write that fails later never
   * throws.
   */
  static open(options: FileAuditLogOptions): FileAuditLog {
    const fs = options.fs ?? nodeFs;
    prepareDir(options.dir, fs);
    // Before anything is read or written, so a second relay changes nothing.
    const lock = takeLock(options.dir, fs, options.log, options.lockStaleMs ?? AUDIT_LOCK_STALE_MS);
    let recovered: Recovered;
    let owed: Gap | null;
    try {
      recovered = recover(options.dir, fs, options.log);
      owed = owedGap(options.dir, fs, options.log, recovered);
    } catch (error) {
      releaseLock(lock, fs);
      throw error;
    }
    const audit = new FileAuditLog(options, recovered, lock);
    if (owed !== null) {
      audit.#gap = owed;
      audit.#gapOwed = true;
    }
    // Now, while the disk works: a full disk at close could make no new file.
    audit.#gapFile = openGapFile(options.dir, fs, options.log, owed !== null);
    // Where this start found the log starting, before retention moves it: a
    // file removed while no relay ran shows as a first past the stop's.
    audit.#checkpoint();
    audit.#retain();
    const checkpoints = setInterval(() => {
      audit.#checkpoint();
    }, AUDIT_CHECKPOINT_MS);
    const retention = setInterval(() => {
      audit.#retain();
    }, AUDIT_RETENTION_CHECK_MS);
    const refresh = setInterval(() => {
      audit.#holdLock();
    }, audit.#lockRefreshMs);
    checkpoints.unref();
    retention.unref();
    refresh.unref();
    audit.#intervals.push(checkpoints, retention, refresh);
    return audit;
  }

  /** The directory the files live in. */
  get dir(): string {
    return this.#dir;
  }

  append(event: AuditEvent): AuditLineMeta | null {
    // A refresh overdue means this process stalled, and another relay may
    // have taken the directory meanwhile: check before writing a line.
    if (performance.now() - this.#lockCheckedAt >= this.#lockRefreshMs) this.#holdLock();
    // What the file missed comes first, so the gap record precedes the record that found writing working again.
    if (this.#closed || this.#lockLost || (this.#gap !== null && !this.#writeGap())) {
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
    // Whatever is written now goes into a directory this log still holds.
    this.#holdLock();
    // A disk that came back since the last record takes the gap now.
    if (this.#gap !== null && !this.#lockLost) this.#writeGap();
    this.#closed = true;
    for (const interval of this.#intervals) clearInterval(interval);
    if (this.#gap !== null) this.#owe(this.#gap);
    this.#closeGapFile();
    this.sync();
    this.#checkpoint();
    this.#closeCurrent();
    releaseLock(this.#lock, this.#fs);
    return Promise.resolve();
  }

  /**
   * Keeps the count of a gap this log is closing without writing: in
   * AUDIT_GAP_NAME, which the next open turns into the audit_gap record
   * before anything else, and on stderr whatever happens, so a restart
   * while the disk fails leaves no silent hole (S7, ADR 0019). The count
   * goes over the padding open wrote, in place, since a full disk takes no
   * new file; failing that, into a new file renamed over it; failing both,
   * the file goes, since an older count left in it would have the next start
   * write that as if it were the whole.
   */
  #owe(gap: Gap): void {
    const line: AuditLine = {
      v: AUDIT_VERSION,
      seq: this.#nextSeq,
      type: 'audit_gap',
      at: this.#now(),
      lost: gap.lost,
      firstAt: gap.firstAt,
      lastAt: gap.lastAt,
      prev: this.#head,
    };
    const fields = { lost: gap.lost, firstAt: gap.firstAt, lastAt: gap.lastAt };
    // Never into a directory another relay holds now.
    if (this.#lockLost) {
      this.#log.error(
        'audit file missed records, and another relay holds the audit directory now, so this relay counts them nowhere on disk; only this line keeps the count (ADR 0019)',
        fields,
      );
      return;
    }
    const text = gapFileText(line);
    let kept =
      text !== null && this.#gapFile !== null && writeGapOver(this.#gapFile, this.#fs, text);
    // Closed before a rename over it or its removal, which a file held open blocks on some systems.
    this.#closeGapFile();
    if (!kept && text !== null) kept = writeGapFile(this.#dir, this.#fs, text);
    if (kept) {
      this.#log.error(
        `audit file missed records and the log is closing before it could count them there; ${AUDIT_GAP_NAME} keeps the count, and the next start writes it as an audit_gap before anything else (ADR 0019)`,
        fields,
      );
      return;
    }
    this.#log.error(
      removeGapFile(this.#dir, this.#fs)
        ? 'audit file missed records and the log is closing before it could count them anywhere on disk; only this line keeps the count, and --verify names the next start as one that follows no relay_stop (ADR 0019)'
        : `audit file missed records and the log is closing before it could count them anywhere on disk; only this line keeps the whole count: ${AUDIT_GAP_NAME}, which may hold an older, smaller one, could not be removed, and the next start writes any it holds as an audit_gap; --verify names that start as one that follows no relay_stop (ADR 0019)`,
      fields,
    );
  }

  #closeGapFile(): void {
    if (this.#gapFile === null) return;
    try {
      this.#fs.closeSync(this.#gapFile);
    } catch {
      // Nothing written through it is owed a flush: every write there was synced.
    }
    this.#gapFile = null;
  }

  /**
   * Refreshes the lock's mtime, which is all that tells a relay unable to
   * see this process's pid (one in another container) that the lock is
   * live, and checks the lock is still this log's. Once another relay holds
   * it, this log writes nothing more there, since two writers would fork the
   * chain; its records still reach stderr, and close counts them.
   */
  #holdLock(): void {
    if (this.#closed || this.#lockLost) return;
    this.#lockCheckedAt = performance.now();
    const state = refreshLock(this.#lock, this.#fs);
    if (state === 'unrefreshed') {
      if (!this.#lockUnrefreshed) {
        this.#lockUnrefreshed = true;
        this.#log.warn(
          'could not refresh the audit directory lock; a relay that cannot see this one may take it once it goes unrefreshed (ADR 0019)',
          { lock: AUDIT_LOCK_NAME },
        );
      }
      return;
    }
    this.#lockUnrefreshed = false;
    if (state === 'retaken') {
      this.#log.warn(
        'the audit directory lock was deleted while this relay held it; it took it again',
        { lock: AUDIT_LOCK_NAME },
      );
    } else if (state === 'lost') {
      this.#lockLost = true;
      this.#log.error(
        "the audit directory's lock is another relay's now, so this relay stops writing the audit files to keep their chain whole; its records reach only stderr, and close counts them (ADR 0019)",
        { lock: AUDIT_LOCK_NAME },
      );
      this.sync();
      this.#closeCurrent();
      // AUDIT_GAP_NAME is that relay's now too.
      this.#closeGapFile();
    }
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
    if (this.#gapOwed) {
      this.#gapOwed = false;
      // On disk before the count it replaces goes, so a power loss keeps one or the other.
      this.sync();
      this.#clearGapFile();
    }
    return true;
  }

  /**
   * Puts AUDIT_GAP_NAME back to padding alone once its count is in the log,
   * in place where the file is padding's size, so the padding stays ready
   * for a full disk; otherwise in a new file renamed over it; otherwise it
   * goes.
   */
  #clearGapFile(): void {
    const padding = gapFileText(null);
    if (this.#gapFile !== null && padding !== null) {
      try {
        if (
          this.#fs.fstatSync(this.#gapFile).size === GAP_FILE_BYTES &&
          writeGapOver(this.#gapFile, this.#fs, padding)
        ) {
          return;
        }
      } catch {
        // Tried below another way.
      }
    }
    this.#closeGapFile();
    if (padding !== null && writeGapFile(this.#dir, this.#fs, padding)) {
      this.#gapFile = openGapFile(this.#dir, this.#fs, this.#log, false);
      return;
    }
    // Harmless if this fails too: the next open sees the file's record past the seq it names and clears it.
    if (!removeGapFile(this.#dir, this.#fs)) {
      this.#log.warn('could not clear the audit_gap a closed log owed, now written', {
        file: AUDIT_GAP_NAME,
      });
    }
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

  /**
   * seq, head and first to stderr, where the platform's logs keep a copy the
   * disk's holder cannot rewrite. Never once another relay holds the
   * directory: its chain is that relay's to name.
   */
  #checkpoint(): void {
    if (this.#head === null || this.#lockLost) return;
    this.#log.info('audit checkpoint', {
      seq: this.#nextSeq - 1,
      head: this.#head,
      first: this.#first,
    });
  }

  /**
   * Deletes files past the retention, then the oldest past the size cap;
   * never the current file. A deletion moves where the log starts, so a
   * checkpoint follows at once. Only this log's own deletions move first: a
   * log whose oldest file starts after first lost the files between some
   * other way, so first stays and the hole is logged, and every checkpoint
   * from then on still shows it to --verify (ADR 0019).
   */
  #retain(): void {
    if (this.#lockLost) return;
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
    const deleted = new Set<string>();
    const remove = (file: AuditFileInfo & { size: number }, reason: 'age' | 'size'): void => {
      try {
        this.#fs.unlinkSync(join(this.#dir, file.name));
        total -= file.size;
        deleted.add(file.name);
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
    // Where the files started before this pass, which only a hole puts past first.
    const start = files[0]?.firstSeq;
    if (this.#head !== null && (start === undefined || start > this.#first)) {
      this.#reportMissing(start ?? this.#nextSeq);
    } else {
      // With no file left on disk, the next line starts the log.
      const oldest = files.find((file) => !deleted.has(file.name))?.firstSeq ?? this.#nextSeq;
      this.#first = Math.max(this.#first, oldest);
    }
    if (deleted.size > 0) this.#checkpoint();
  }

  /** Logs, once for each hole, seqs gone from the log's start that retention did not delete. */
  #reportMissing(start: number): void {
    const range = `${String(this.#first)}-${String(start - 1)}`;
    if (this.#missingReported === range) return;
    this.#missingReported = range;
    this.#log.error(
      'audit records are missing from the start of the log, removed by something other than its retention; each checkpoint this relay writes goes on naming the seq the log started at, so --verify against it reports the hole (ADR 0019)',
      { from: this.#first, to: start - 1 },
    );
  }
}

/**
 * The lock file a log holds in its directory from open to close. Two relays
 * appending to one directory would each go on from the chain's head as they
 * last saw it, so their lines would share seq numbers and prev digests, and
 * --verify would report an untouched log as broken; so the second relay
 * refuses to start before it reads or writes anything, naming the lock.
 *
 * A lock reads `<pid> <boot> <pid namespace> <owner id>`: the holder's pid
 * as it sees itself, this boot of the machine and the holder's pid namespace
 * where Linux names them ('-' where not), and 16 random bytes the log drew
 * at open. The owner id makes every lock's text its own, so a log never
 * mistakes another relay's lock for its own, even one with the same pid, as
 * every relay in a container is pid 1. While the log is open its holder sets
 * the lock's mtime every sixth of AUDIT_LOCK_STALE_MS, which is how a relay
 * that cannot see the holder's pid, in another container on the same volume,
 * still tells a live lock from one a crash left: by watching it change.
 */
export const AUDIT_LOCK_NAME = 'audit.lock';

/** How long a lock may go without its holder's refresh before it counts as left by a relay that is gone. */
export const AUDIT_LOCK_STALE_MS = 30_000;
const LOCK_REFRESHES_PER_STALE = 6;
/**
 * How many of the holder's refresh intervals a relay watches a lock it
 * cannot judge by pid, on its own monotonic clock, before it may break it,
 * however old the lock's mtime looks: an mtime is the holder's clock, which
 * may run far behind this one's, so a live lock can look abandoned at first
 * sight, but its holder refreshes it once an interval, and two leave room
 * for a refresh a busy holder runs late.
 */
const LOCK_WATCH_REFRESHES = 2;
/** How many locks open tries to take or break before it gives up. */
const LOCK_ATTEMPTS = 10;

/** How often a holder refreshes its lock, for a given stale interval. */
function lockRefreshMs(staleMs: number): number {
  return Math.max(1, Math.floor(staleMs / LOCK_REFRESHES_PER_STALE));
}

/** A lock this process holds: its path, its text, and the directory it is held for. */
interface AuditLock {
  path: string;
  text: string;
  dir: string;
}

/** A lock file as another relay sees it: its text and how it last changed. */
interface SeenLock {
  text: string;
  ino: number;
  mtimeMs: number;
}

/** What a pid in a lock is measured against: this boot and this process's pid namespace. */
interface LockView {
  boot: string;
  ns: string;
}

/**
 * Directories this process holds the lock of, by real path. The pid in a
 * lock cannot tell this process's own lock from one an earlier run left with
 * the same pid (in a container the relay is pid 1 every time), so a second
 * log in this process is refused here.
 */
const heldHere = new Set<string>();

/** This boot of the machine, where Linux names it; a pid from another boot means nothing here. */
function bootId(fs: AuditFs): string {
  try {
    const id = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return /^[0-9a-f-]{1,64}$/.test(id) ? id : '-';
  } catch {
    return '-';
  }
}

/** This process's pid namespace, where Linux names it: a pid means one process only inside one namespace. */
function pidNamespace(fs: AuditFs): string {
  try {
    const link = fs.readlinkSync('/proc/self/ns/pid', 'utf8');
    return /^pid:\[(\d{1,20})\]$/.exec(link)?.[1] ?? '-';
  } catch {
    return '-';
  }
}

/** Whether a pid runs, as this process sees pids; EPERM means it runs as another account. */
function running(pid: number): boolean {
  // Never 0 or below, which kill(2) reads as a process group, not a process.
  if (pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) === 'EPERM';
  }
}

type Verdict = { kind: 'live'; pid: number } | { kind: 'gone' } | { kind: 'unseen' };

/**
 * What a lock says of its relay. Its pid tells only where it means the same
 * to both: the same boot and the same pid namespace. There a pid that runs
 * and is not this process's holds the lock, and any other is gone, this
 * process's own included, since heldHere stands for this process. A relay in
 * another container on the same host is pid 1 there as here, so its pid says
 * nothing, and its lock is unseen: judged by watching for its refreshes
 * (waitOut), never at first sight, as is a lock that cannot be read. A lock
 * in the format before owner ids (`<pid> <boot>`) names no namespace: a pid
 * it names that runs on this boot, not this process's, still refuses, as it
 * did then; otherwise it too is watched for refreshes, which such a relay
 * never made.
 */
function judge(seen: SeenLock, view: LockView): Verdict {
  const current = /^(\d{1,10}) ([0-9a-f-]{1,64}) (\d{1,20}|-) [0-9a-f]{32}\n$/.exec(seen.text);
  if (current !== null) {
    const pid = Number(current[1]);
    const sharesPids =
      current[2] === view.boot &&
      current[3] === view.ns &&
      // Linux always has pid namespaces, so without /proc to name them nothing can be told.
      (process.platform !== 'linux' || (view.boot !== '-' && view.ns !== '-'));
    if (sharesPids) {
      return pid !== process.pid && running(pid) ? { kind: 'live', pid } : { kind: 'gone' };
    }
  }
  const before = /^(\d{1,10}) ([0-9a-f-]{1,64})\n$/.exec(seen.text);
  if (before !== null) {
    const pid = Number(before[1]);
    const boot = before[2] ?? '-';
    const sameBoot = boot === view.boot || boot === '-' || view.boot === '-';
    if (sameBoot && pid !== process.pid && running(pid)) return { kind: 'live', pid };
  }
  // Never gone by its mtime alone, which is the holder's clock, not this one's.
  return { kind: 'unseen' };
}

/** The lock at path as it is now, text and stat from one descriptor so both describe one file; null when there is none. */
function look(path: string, fs: AuditFs): SeenLock | null {
  let fd: number;
  try {
    fd = fs.openSync(path, nodeFs.constants.O_RDONLY | noFollow());
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return null;
    throw new AuditDirError(`cannot read the audit lock ${path} (${codeOf(error)})`);
  }
  try {
    const stat = fs.fstatSync(fd);
    return { text: fs.readFileSync(fd, 'utf8'), ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch (error) {
    throw new AuditDirError(`cannot read the audit lock ${path} (${codeOf(error)})`);
  } finally {
    fs.closeSync(fd);
  }
}

function sameLock(a: SeenLock, b: SeenLock): boolean {
  return a.text === b.text && a.ino === b.ino && a.mtimeMs === b.mtimeMs;
}

/**
 * Puts a lock in place whole or not at all: the text goes into a file of
 * this process's own, which is then linked to the lock's name, so no relay
 * ever reads half a lock, and link fails rather than replace one that is
 * there. False when a lock is there already.
 */
function linkLock(dir: string, path: string, text: string, fs: AuditFs): boolean {
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
    return true;
  } catch (error) {
    if (codeOf(error) === 'EEXIST') return false;
    throw error;
  } finally {
    try {
      fs.unlinkSync(own);
    } catch {
      // Never made.
    }
  }
}

/**
 * Removes the lock at path in one step, and only if it is still the one
 * expected. Reading a lock and then deleting it by name would race: another
 * relay could put its own lock there between the two, and the delete would
 * take that one instead. So the lock is renamed aside, which only one
 * process can do to one file, then checked; a lock that turns out to be
 * another's goes back under its name.
 */
function removeLock(path: string, fs: AuditFs, expected: (aside: SeenLock) => boolean): boolean {
  const aside = `${path}.${randomBytes(6).toString('hex')}.aside`;
  try {
    fs.renameSync(path, aside);
  } catch {
    // Gone already: another relay broke or released it first.
    return false;
  }
  let moved: SeenLock | null = null;
  try {
    moved = look(aside, fs);
  } catch {
    // Unreadable now: not provably the lock expected, so it goes back.
  }
  const removed = moved !== null && expected(moved);
  if (!removed) {
    try {
      fs.linkSync(aside, path);
    } catch {
      // A third relay took the name meanwhile; the one whose lock was moved finds that at its next refresh.
    }
  }
  try {
    fs.unlinkSync(aside);
  } catch {
    // Nothing left to remove.
  }
  return removed;
}

/** Blocks the thread; FileAuditLog.open is synchronous and runs before the relay serves anyone, so it holds up no one. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Watches a lock whose pid says nothing here until it shows its relay runs
 * (a refresh, or another lock in its place), goes, or counts as stale: this
 * relay has watched it unchanged for LOCK_WATCH_REFRESHES of the holder's
 * refresh intervals on its own monotonic clock, and it has gone staleMs
 * without a refresh, by that watch or by its mtime. An old mtime may so
 * shorten the wait but never skip the watch, since a holder whose clock runs
 * behind this one's writes mtimes that look old while it is live; and a
 * clock that runs ahead cannot stretch the wait past staleMs. A container
 * restarted after a crash waits here, between the watch and staleMs, for the
 * lock its last run left; a graceful stop releases its lock and costs no
 * wait.
 */
function waitOut(
  path: string,
  seen: SeenLock,
  staleMs: number,
  fs: AuditFs,
  log: Logger,
): 'released' | 'refreshed' | 'stale' {
  const watch = Math.min(staleMs, LOCK_WATCH_REFRESHES * lockRefreshMs(staleMs));
  const since = performance.now();
  const remaining = (): number => {
    const watched = performance.now() - since;
    const unrefreshed = Math.max(Date.now() - seen.mtimeMs, watched);
    return Math.max(watch - watched, staleMs - unrefreshed, 0);
  };
  log.warn(
    'the audit directory lock was left by a relay this one cannot see, perhaps in another container on the same volume; watching it for a refresh before taking it (ADR 0019)',
    { lock: AUDIT_LOCK_NAME, waitMs: Math.ceil(remaining()) },
  );
  const poll = Math.max(10, Math.min(100, Math.floor(staleMs / 8)));
  for (;;) {
    const left = remaining();
    if (left <= 0) return 'stale';
    pause(Math.max(1, Math.min(poll, Math.ceil(left))));
    const now = look(path, fs);
    if (now === null) return 'released';
    if (!sameLock(now, seen)) return 'refreshed';
  }
}

/**
 * Takes the directory's lock (see AUDIT_LOCK_NAME). A lock a live relay
 * holds refuses the start; one its relay left behind (a crash, a container
 * restarted) is broken in one step and replaced; one whose relay this
 * process cannot see is watched until it shows itself live or stale.
 */
function takeLock(dir: string, fs: AuditFs, log: Logger, staleMs: number): AuditLock {
  const real = nodeFs.realpathSync(dir);
  if (heldHere.has(real)) {
    throw new AuditDirError(
      `the audit directory ${dir} (TABDOCK_AUDIT_DIR) is already open in this process; one relay writes one audit log (ADR 0019)`,
    );
  }
  const path = join(dir, AUDIT_LOCK_NAME);
  const view: LockView = { boot: bootId(fs), ns: pidNamespace(fs) };
  const text = `${String(process.pid)} ${view.boot} ${view.ns} ${randomBytes(16).toString('hex')}\n`;
  const inUse = (by: string): AuditDirError =>
    new AuditDirError(
      `the audit directory ${dir} (TABDOCK_AUDIT_DIR) is in use by another relay, ${by}; two relays writing one audit log would break its chain (ADR 0019). Stop that relay first or, if none is running, delete ${path}`,
    );
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    let placed: boolean;
    try {
      placed = linkLock(dir, path, text, fs);
    } catch (error) {
      throw new AuditDirError(
        `cannot lock the audit directory ${dir} (TABDOCK_AUDIT_DIR, ${codeOf(error)}); the relay must be able to create ${AUDIT_LOCK_NAME} there`,
      );
    }
    if (placed) {
      heldHere.add(real);
      return { path, text, dir: real };
    }
    const seen = look(path, fs);
    // Released between the link and the look: try again.
    if (seen === null) continue;
    const verdict = judge(seen, view);
    if (verdict.kind === 'live') throw inUse(`pid ${String(verdict.pid)}, which holds ${path}`);
    if (verdict.kind === 'unseen') {
      const waited = waitOut(path, seen, staleMs, fs, log);
      if (waited === 'released') continue;
      if (waited === 'refreshed') {
        throw inUse(
          `perhaps in another container on the same volume, which refreshed or replaced ${path} while this one waited`,
        );
      }
    }
    // Only the lock judged stale goes; one another relay put there since stays, and the next attempt judges it.
    if (removeLock(path, fs, (aside) => sameLock(aside, seen))) {
      log.warn('replaced an audit directory lock left by a relay that is gone', {
        lock: AUDIT_LOCK_NAME,
      });
    }
  }
  throw new AuditDirError(
    `cannot lock the audit directory ${dir} (TABDOCK_AUDIT_DIR): another relay keeps taking ${path}`,
  );
}

/**
 * What a holder finds when it refreshes its lock: still its own, and now
 * refreshed; deleted, and so taken again; another relay's; or nothing it
 * could tell, as when the disk refuses, which a later refresh tries again.
 */
function refreshLock(lock: AuditLock, fs: AuditFs): 'held' | 'retaken' | 'lost' | 'unrefreshed' {
  try {
    const seen = look(lock.path, fs);
    if (seen !== null && seen.text === lock.text) {
      const now = new Date();
      fs.utimesSync(lock.path, now, now);
      return 'held';
    }
    if (seen !== null) return 'lost';
    if (linkLock(lock.dir, lock.path, lock.text, fs)) return 'retaken';
    // Another lock took the name first.
    return look(lock.path, fs)?.text === lock.text ? 'held' : 'lost';
  } catch {
    return 'unrefreshed';
  }
}

/** Gives the lock up, leaving alone a lock that is no longer this log's. */
function releaseLock(lock: AuditLock, fs: AuditFs): void {
  heldHere.delete(lock.dir);
  try {
    // Read first, so another relay's lock is never even moved aside.
    if (look(lock.path, fs)?.text !== lock.text) return;
    removeLock(lock.path, fs, (aside) => aside.text === lock.text);
  } catch {
    // Unreadable: a lock this log cannot read is not one it may remove.
  }
}

/**
 * The audit_gap a log closed without writing, kept beside the files as the
 * line it owes (seq, prev and all), so the next open writes the record
 * before anything else. The relay is stopped or redeployed while its disk
 * fails (on Fly a restart is how an extended volume is picked up), and
 * without this the next start would chain relay_start to the last good
 * line, and nothing on disk would show what the file missed.
 *
 * The file is GAP_FILE_BYTES of real bytes, kept between runs: spaces and a
 * newline while nothing is owed, or the owed line padded with spaces. Each
 * open makes it, or checks it, while the disk works, and keeps it open, so a
 * close on a full disk writes its count over bytes already there, which
 * takes no new blocks, where a new file would fail for want of space.
 */
export const AUDIT_GAP_NAME = 'audit.gap';

/** AUDIT_GAP_NAME's size: one sector, more than twice the longest audit_gap line. */
const GAP_FILE_BYTES = 512;

/**
 * What AUDIT_GAP_NAME holds: an owed audit_gap line, schema-checked, padded
 * with spaces to GAP_FILE_BYTES, or the padding alone for null; null when the
 * line fails its schema. A line too long for the padding goes whole, longer.
 */
function gapFileText(line: AuditLine | null): Buffer | null {
  let text = '';
  if (line !== null) {
    const checked = AuditLineSchema.safeParse(line);
    if (!checked.success) return null;
    text = JSON.stringify(checked.data);
  }
  const pad = Math.max(0, GAP_FILE_BYTES - 1 - Buffer.byteLength(text, 'utf8'));
  return Buffer.from(`${text}${' '.repeat(pad)}\n`, 'utf8');
}

/** The first line of AUDIT_GAP_NAME's text, without its padding; empty when nothing is owed. */
function gapFileLine(text: string): string {
  return (text.split('\n')[0] ?? '').trimEnd();
}

/**
 * Writes AUDIT_GAP_NAME's new text over the old, in place from its start,
 * and syncs it: on bytes the file already holds this needs no new blocks.
 * False when the disk refused.
 */
function writeGapOver(fd: number, fs: AuditFs, text: Buffer): boolean {
  try {
    if (fs.writeSync(fd, text, 0, text.length, 0) !== text.length) return false;
    fs.fdatasyncSync(fd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Puts AUDIT_GAP_NAME's text in place whole or not at all: written to a file
 * of its own and synced, then renamed over the old, so the next open finds a
 * whole line or none. Throws when the disk takes not even that.
 */
function replaceGapFile(dir: string, fs: AuditFs, text: Buffer): void {
  const temp = join(dir, `${AUDIT_GAP_NAME}.${randomBytes(6).toString('hex')}`);
  try {
    const fd = fs.openSync(
      temp,
      nodeFs.constants.O_WRONLY | nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL | noFollow(),
      FILE_MODE,
    );
    try {
      if (fs.writeSync(fd, text) !== text.length) {
        throw Object.assign(new Error('short write'), { code: 'ESHORT' });
      }
      fs.fdatasyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, join(dir, AUDIT_GAP_NAME));
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Renamed into place, or never made.
    }
  }
}

function writeGapFile(dir: string, fs: AuditFs, text: Buffer): boolean {
  try {
    replaceGapFile(dir, fs, text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes AUDIT_GAP_NAME, which needs no space. True when no count is left
 * in it for the next open to write: it is gone, or what stayed holds no
 * audit_gap record.
 */
function removeGapFile(dir: string, fs: AuditFs): boolean {
  const path = join(dir, AUDIT_GAP_NAME);
  try {
    fs.unlinkSync(path);
    return true;
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return true;
  }
  try {
    const line = gapFileLine(fs.readFileSync(path, 'utf8'));
    return line === '' || readLine(AUDIT_GAP_NAME, 1, line).record?.type !== 'audit_gap';
  } catch {
    return false;
  }
}

/**
 * Opens AUDIT_GAP_NAME for the log's run, to read and write, never through a
 * symlink: as it stands while it holds a gap still owed, which close may
 * write over; otherwise as padding alone, made or rewritten now, while the
 * disk works. Null, with a warning, when the disk refuses: close can then
 * only try a new file, which a full disk refuses too, and the count is left
 * on stderr alone.
 */
function openGapFile(dir: string, fs: AuditFs, log: Logger, owed: boolean): number | null {
  const path = join(dir, AUDIT_GAP_NAME);
  const padding = gapFileText(null) ?? Buffer.alloc(0);
  const openIt = (): number => {
    const fd = fs.openSync(path, nodeFs.constants.O_RDWR | noFollow());
    try {
      if (!fs.fstatSync(fd).isFile()) {
        throw Object.assign(new Error('not a regular file'), { code: 'ENOTREG' });
      }
      fs.fchmodSync(fd, FILE_MODE);
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
    return fd;
  };
  try {
    let fd: number | null = null;
    try {
      fd = openIt();
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error;
    }
    if (fd !== null) {
      if (owed) return fd;
      if (fs.fstatSync(fd).size === padding.length) {
        const now = Buffer.alloc(padding.length);
        fs.readSync(fd, now, 0, now.length, 0);
        if (now.equals(padding) || writeGapOver(fd, fs, padding)) return fd;
      }
      fs.closeSync(fd);
    }
    replaceGapFile(dir, fs, padding);
    return openIt();
  } catch (error) {
    log.warn(
      `could not make ${AUDIT_GAP_NAME} ready, so a log that closes on a full disk before it can write an audit_gap leaves the count on stderr alone (ADR 0019)`,
      { file: AUDIT_GAP_NAME, error: codeOf(error) },
    );
    return null;
  }
}

/**
 * The gap a closed log still owes, from AUDIT_GAP_NAME; null when there is
 * none, as when it holds padding alone. One whose seq the log has passed was
 * written already (by an open that could not clear the file after), so no
 * gap counts twice: openGapFile clears it. One that does not follow the
 * log's last line means lines went from the log's end since it was left:
 * its count still stands, and the warning says so.
 */
function owedGap(dir: string, fs: AuditFs, log: Logger, recovered: Recovered): Gap | null {
  const path = join(dir, AUDIT_GAP_NAME);
  let text: string;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') {
      log.warn(
        'cannot read the audit_gap a closed log left; --verify still names the start that follows no relay_stop',
        {
          file: AUDIT_GAP_NAME,
          error: codeOf(error),
        },
      );
    }
    return null;
  }
  const line = gapFileLine(text);
  if (line === '') return null;
  const record = readLine(AUDIT_GAP_NAME, 1, line).record;
  if (record?.type !== 'audit_gap') {
    log.warn(
      'the audit_gap file a closed log left holds no audit_gap record; it is cleared unused',
      {
        file: AUDIT_GAP_NAME,
      },
    );
    return null;
  }
  if (record.seq < recovered.nextSeq) return null;
  if (record.seq !== recovered.nextSeq || record.prev !== recovered.head) {
    log.warn(
      'the audit log does not end where the audit_gap a closed log owes says it did: lines were removed from its end since; the gap is still written',
      { file: AUDIT_GAP_NAME, owedSeq: record.seq, nextSeq: recovered.nextSeq },
    );
  }
  return { lost: record.lost, firstAt: record.firstAt, lastAt: record.lastAt };
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
 * read only when the newest holds no record at all. first is where the
 * oldest file says it starts, until retention looks again.
 */
function recover(dir: string, fs: AuditFs, log: Logger): Recovered {
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
      if (record !== null) {
        return { nextSeq: record.seq + 1, head: lineHash(text), first: files[0]?.firstSeq ?? 1 };
      }
    }
  }
  return { nextSeq: 1, head: null, first: 1 };
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

// The persistent audit log (S7, ADR 0019) on its own: JSON Lines in a 0700
// directory of 0600 files, a sequence and a SHA-256 chain that run on across
// files and restarts, rotation by size and UTC day, retention by age and
// total size that never deletes the current file, a torn line from a crash
// closed at the next start, failing open with an audit_gap record once
// writing works again, a schema check before every line whose checked form
// is what is written, a lock that keeps a second writer out, syncs at most
// once a second, checkpoints every 15 minutes, and the reader's --verify,
// which names torn lines and fails on an edited or removed one.

import { spawn } from 'node:child_process';
import * as nodeFs from 'node:fs';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUDIT_VERSION,
  type AuditEvent,
  type AuditEventOf,
  AuditLineSchema,
} from '@tabdock/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_ROTATE_MB } from '../src/config.ts';
import {
  AUDIT_CHECKPOINT_MS,
  AUDIT_GAP_NAME,
  AUDIT_LOCK_NAME,
  AUDIT_RETENTION_CHECK_MS,
  AUDIT_SYNC_MS,
  AuditDirError,
  type AuditFs,
  createLogger,
  FileAuditLog,
  type FileAuditLogOptions,
  lineHash,
  listAuditFiles,
  readAuditLines,
  utcDay,
  verifyAuditLines,
} from '../src/index.ts';

const scratches: string[] = [];
const opened: FileAuditLog[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const audit of opened.splice(0)) await audit.close();
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tabdock-audit-'));
  scratches.push(dir);
  return join(dir, 'audit');
}

const DAY = 24 * 60 * 60_000;
const T0 = Date.parse('2026-10-04T12:00:00.000Z');

function call(at: number, extra: Partial<AuditEventOf<'call'>> = {}): AuditEventOf<'call'> {
  return {
    v: AUDIT_VERSION,
    type: 'call',
    at,
    pageId: 'pg_1',
    origin: 'https://app.example',
    userId: 'alice',
    client: { name: 'test', version: '1.0.0' },
    tool: 'get_view',
    outcome: 'ok',
    durationMs: 3,
    ...extra,
  };
}

interface Opened {
  audit: FileAuditLog;
  dir: string;
  lines: string[];
  clock: { now: number };
}

function open(
  dir: string,
  options: Partial<FileAuditLogOptions> = {},
  clock = { now: T0 },
): Opened {
  const lines: string[] = [];
  const audit = FileAuditLog.open({
    dir,
    retentionDays: 30,
    maxBytes: 64 * 1024 * 1024,
    log: createLogger({ sink: (line) => lines.push(line) }),
    now: () => clock.now,
    ...options,
  });
  opened.push(audit);
  return { audit, dir, lines, clock };
}

function fileLines(dir: string): string[] {
  return listAuditFiles(dir).flatMap((file) =>
    readFileSync(join(dir, file.name), 'utf8')
      .split('\n')
      .filter((line) => line !== ''),
  );
}

describe('the audit files (ADR 0019)', () => {
  it('writes one JSON line per record into a 0700 directory of 0600 files, chained from seq 1', async () => {
    const { audit, dir } = open(scratch());
    expect(audit.append(call(T0))).toEqual({ seq: 1, prev: null });
    const second = audit.append(call(T0 + 1, { tool: 'add_item', outcome: 'role_denied' }));
    const [first] = fileLines(dir);
    expect(second).toEqual({ seq: 2, prev: lineHash(first ?? '') });
    await audit.close();
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      for (const file of listAuditFiles(dir)) {
        expect(statSync(join(dir, file.name)).mode & 0o777).toBe(0o600);
      }
    }
    const lines = fileLines(dir).map((line) => AuditLineSchema.parse(JSON.parse(line)));
    expect(lines.map((line) => [line.seq, line.type])).toEqual([
      [1, 'call'],
      [2, 'call'],
    ]);
    // A person reading the file sees v and seq first, and prev last.
    const raw = Object.keys(JSON.parse(fileLines(dir)[0] ?? '{}') as object);
    expect(raw.slice(0, 3)).toEqual(['v', 'seq', 'type']);
    expect(raw.at(-1)).toBe('prev');
    expect(listAuditFiles(dir).map((file) => file.name)).toEqual([
      'audit-2026-10-04-000000000001.jsonl',
    ]);
  });

  it('narrows a directory of its own that others could read, and refuses one it cannot use', () => {
    const dir = scratch();
    nodeFs.mkdirSync(dir, { mode: 0o755 });
    nodeFs.chmodSync(dir, 0o755);
    open(dir);
    if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700);
    const notADir = join(scratch(), 'file');
    nodeFs.mkdirSync(join(notADir, '..'), { recursive: true });
    writeFileSync(notADir, 'x');
    expect(() => open(notADir)).toThrow(AuditDirError);
    expect(() => open(join(notADir, 'below'))).toThrow(/cannot create the audit directory/);
  });

  it('picks up the sequence and the chain where the last start left them', async () => {
    const dir = scratch();
    const first = open(dir);
    first.audit.append(call(T0));
    first.audit.append(call(T0 + 1));
    await first.audit.close();
    const second = open(dir);
    const last = fileLines(dir).at(-1) ?? '';
    expect(second.audit.append(call(T0 + 2))).toEqual({ seq: 3, prev: lineHash(last) });
    await second.audit.close();
    const report = verifyAuditLines(readAuditLines(dir));
    expect(report).toMatchObject({ records: 3, firstSeq: 1, lastSeq: 3, problems: [], torn: [] });
  });

  it('closes a torn last line at the next start and chains past it, which verify names but accepts', async () => {
    const dir = scratch();
    const first = open(dir);
    first.audit.append(call(T0));
    first.audit.append(call(T0 + 1));
    await first.audit.close();
    const [file] = listAuditFiles(dir);
    // A crash in the middle of a write: half a record and no newline.
    const path = join(dir, file?.name ?? '');
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"v":1,"seq":3,"type":"ca`);
    const second = open(dir);
    expect(second.lines.join('\n')).toContain('closed a torn last line');
    expect(readFileSync(path, 'utf8').endsWith('"ca\n')).toBe(true);
    // The torn record never became one, so its seq is given again.
    expect(second.audit.append(call(T0 + 2))?.seq).toBe(3);
    await second.audit.close();
    const report = verifyAuditLines(readAuditLines(dir));
    expect(report.torn).toEqual([{ file: file?.name, lineNumber: 3 }]);
    expect(report.problems).toEqual([]);
    expect(report.lastSeq).toBe(3);
  });

  it('rotates at the size limit and at UTC midnight, chaining across files and checkpointing each time', async () => {
    const { audit, dir, lines, clock } = open(scratch(), { rotateBytes: 600 });
    for (let index = 0; index < 4; index += 1) audit.append(call(T0 + index));
    // Past midnight UTC, whatever the size.
    clock.now = Date.parse('2026-10-05T00:00:01.000Z');
    audit.append(call(clock.now));
    await audit.close();
    const files = listAuditFiles(dir);
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.at(-1)?.day).toBe('2026-10-05');
    expect(files.slice(0, -1).every((file) => file.day === '2026-10-04')).toBe(true);
    for (const file of files) {
      expect(statSync(join(dir, file.name)).size).toBeLessThanOrEqual(600);
    }
    expect(verifyAuditLines(readAuditLines(dir))).toMatchObject({
      records: 5,
      files: files.length,
      problems: [],
    });
    const checkpoints = lines.filter((line) => line.includes('"msg":"audit checkpoint"'));
    // One per rotation and one at close, each naming the head the chain had then.
    expect(checkpoints.length).toBe(files.length);
    const lastCheckpoint = JSON.parse(checkpoints.at(-1) ?? '{}') as { seq: number; head: string };
    expect(lastCheckpoint).toMatchObject({
      seq: 5,
      head: lineHash(fileLines(dir).at(-1) ?? ''),
    });
  });

  it('deletes files past the retention days and the oldest past the size cap, never the current file', async () => {
    const dir = scratch();
    const clock = { now: Date.parse('2026-09-01T10:00:00.000Z') };
    const writer = open(dir, {}, clock);
    for (let day = 0; day < 5; day += 1) {
      clock.now = Date.parse('2026-09-01T10:00:00.000Z') + day * DAY;
      writer.audit.append(call(clock.now));
    }
    await writer.audit.close();
    expect(listAuditFiles(dir).map((file) => file.day)).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
    ]);
    // Two days of retention on 6 September: the 1st to the 3rd are past it.
    const retained = open(
      dir,
      { retentionDays: 2 },
      { now: Date.parse('2026-09-06T08:00:00.000Z') },
    );
    expect(listAuditFiles(dir).map((file) => file.day)).toEqual(['2026-09-04', '2026-09-05']);
    expect(retained.lines.filter((line) => line.includes('deleted by retention'))).toHaveLength(3);
    await retained.audit.close();

    // A cap of one byte deletes everything it may, which is never the file in use:
    // at a start, the newest, whose last line the chain goes on from.
    const capped = open(dir, { maxBytes: 1 }, { now: Date.parse('2026-09-06T08:00:00.000Z') });
    expect(listAuditFiles(dir).map((file) => file.day)).toEqual(['2026-09-05']);
    capped.audit.append(call(Date.parse('2026-09-06T08:00:00.000Z')));
    capped.audit.append(call(Date.parse('2026-09-06T08:00:01.000Z')));
    // Rotation runs retention again; force one with a new day.
    capped.clock.now = Date.parse('2026-09-07T00:00:01.000Z');
    capped.audit.append(call(capped.clock.now));
    expect(listAuditFiles(dir).map((file) => file.day)).toEqual(['2026-09-07']);
    await capped.audit.close();
  });

  it('fails open: a write that fails costs no call, and an audit_gap counts what the file missed', async () => {
    let failing = false;
    let opens = 0;
    const fs: AuditFs = {
      ...nodeFs,
      writeSync: ((...args: Parameters<typeof nodeFs.writeSync>) => {
        if (failing) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
        return nodeFs.writeSync(...args);
      }) as typeof nodeFs.writeSync,
      openSync: (...args: Parameters<typeof nodeFs.openSync>) => {
        opens += 1;
        return nodeFs.openSync(...args);
      },
    };
    const { audit, dir, lines } = open(scratch(), { fs });
    expect(audit.append(call(T0))?.seq).toBe(1);
    failing = true;
    expect(audit.append(call(T0 + 10))).toBeNull();
    expect(audit.append(call(T0 + 20))).toBeNull();
    expect(audit.append(call(T0 + 30))).toBeNull();
    // Logged once for the whole outage, by error code only.
    const failures = lines.filter((line) => line.includes('audit file write failed'));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('ENOSPC');
    const opensWhileFailing = opens;
    failing = false;
    const back = audit.append(call(T0 + 40));
    // The file opened again, and the gap record went first.
    expect(opens).toBeGreaterThan(opensWhileFailing);
    expect(back?.seq).toBe(3);
    await audit.close();
    const records = fileLines(dir).map((line) => AuditLineSchema.parse(JSON.parse(line)));
    expect(records.map((record) => record.type)).toEqual(['call', 'audit_gap', 'call']);
    expect(records[1]).toMatchObject({ seq: 2, lost: 3, firstAt: T0 + 10, lastAt: T0 + 30 });
    // The log made the gap record itself, so it wrote the stderr copy too.
    expect(
      lines.some((line) => line.includes('"msg":"audit_gap"') && line.includes('"lost":3')),
    ).toBe(true);
    // Memory still holds every record, the lost ones included.
    expect(audit.records().map((record) => record.type)).toEqual([
      'call',
      'call',
      'call',
      'call',
      'audit_gap',
      'call',
    ]);
    expect(verifyAuditLines(readAuditLines(dir)).problems).toEqual([]);
  });

  it('closes a line a short write tore before the next record, and verify accepts the result', async () => {
    let short = false;
    const fs: AuditFs = {
      ...nodeFs,
      writeSync: ((fd: number, buffer: NodeJS.ArrayBufferView) => {
        if (short) {
          short = false;
          return nodeFs.writeSync(fd, buffer as Buffer, 0, 10);
        }
        return nodeFs.writeSync(fd, buffer as Buffer);
      }) as typeof nodeFs.writeSync,
    };
    const { audit, dir } = open(scratch(), { fs });
    audit.append(call(T0));
    short = true;
    expect(audit.append(call(T0 + 1))).toBeNull();
    // The gap record takes seq 2, then the record that found writing working again.
    expect(audit.append(call(T0 + 2))).toMatchObject({ seq: 3 });
    await audit.close();
    const report = verifyAuditLines(readAuditLines(dir));
    expect(report.torn).toHaveLength(1);
    expect(report.problems).toEqual([]);
    expect(
      fileLines(dir).map((line) => {
        try {
          return (JSON.parse(line) as { type: string }).type;
        } catch {
          return 'torn';
        }
      }),
    ).toEqual(['call', 'torn', 'audit_gap', 'call']);
  });

  it('writes no line that fails its schema, so a stray field such as a token never reaches the file', async () => {
    const { audit, dir, lines } = open(scratch());
    const tainted = { ...call(T0), token: 'tabdock_secret-that-must-not-land' } as AuditEvent;
    expect(audit.append(tainted)).toBeNull();
    expect(lines.join('\n')).toContain('does not match its schema');
    expect(lines.join('\n')).not.toContain('secret-that-must-not-land');
    audit.append(call(T0 + 1));
    await audit.close();
    expect(readFileSync(join(dir, listAuditFiles(dir)[0]?.name ?? ''), 'utf8')).not.toContain(
      'secret-that-must-not-land',
    );
  });

  it('syncs on demand, and on close after the last record', async () => {
    let syncs = 0;
    const fs: AuditFs = {
      ...nodeFs,
      fdatasyncSync: (fd: number) => {
        syncs += 1;
        nodeFs.fdatasyncSync(fd);
      },
    };
    const { audit } = open(scratch(), { fs });
    expect(audit.sync()).toBe(false);
    audit.append(call(T0));
    expect(audit.sync()).toBe(true);
    expect(syncs).toBe(1);
    // Nothing new: no second sync.
    expect(audit.sync()).toBe(true);
    expect(syncs).toBe(1);
    audit.append(call(T0 + 1));
    await audit.close();
    expect(syncs).toBe(2);
    // A closed log takes nothing more into its files.
    expect(audit.append(call(T0 + 2))).toBeNull();
  });
});

describe('verify (pnpm audit:log --verify)', () => {
  async function written(count: number): Promise<string> {
    const { audit, dir } = open(scratch());
    for (let index = 0; index < count; index += 1) audit.append(call(T0 + index));
    await audit.close();
    return dir;
  }

  function rewrite(dir: string, change: (lines: string[]) => string[]): void {
    const [file] = listAuditFiles(dir);
    const path = join(dir, file?.name ?? '');
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
    writeFileSync(path, `${change(lines).join('\n')}\n`);
  }

  it('fails on an edited line, a removed line, or a line that is JSON but no record', async () => {
    const edited = await written(4);
    rewrite(edited, (lines) =>
      lines.map((line, index) => (index === 1 ? line.replace('"ok"', '"tool_error"') : line)),
    );
    const editedProblems = verifyAuditLines(readAuditLines(edited)).problems;
    expect(editedProblems.map((problem) => problem.lineNumber)).toEqual([3]);
    expect(editedProblems[0]?.problem).toMatch(/prev is not the digest/);

    const removed = await written(4);
    rewrite(removed, (lines) => lines.filter((_, index) => index !== 2));
    const problems = verifyAuditLines(readAuditLines(removed)).problems.map((p) => p.problem);
    expect(problems.some((problem) => /seq 4 follows 2/.test(problem))).toBe(true);

    const foreign = await written(2);
    rewrite(foreign, (lines) => [...lines, JSON.stringify({ v: 1, seq: 3, type: 'call' })]);
    expect(verifyAuditLines(readAuditLines(foreign)).problems).toEqual([
      expect.objectContaining({ problem: 'valid JSON but not an audit record' }),
    ]);
  });

  it('checks the last line against a checkpoint, which only a checkpoint can show was changed', async () => {
    const dir = await written(3);
    const last = fileLines(dir).at(-1) ?? '';
    expect(
      verifyAuditLines(readAuditLines(dir), { seq: 3, head: lineHash(last) }).problems,
    ).toEqual([]);
    rewrite(dir, (lines) =>
      lines.map((line, index) => (index === 2 ? line.replace('"ok"', '"tool_error"') : line)),
    );
    // The chain alone cannot see an edit to the last line.
    expect(verifyAuditLines(readAuditLines(dir)).problems).toEqual([]);
    const changed = verifyAuditLines(readAuditLines(dir), {
      seq: 3,
      head: lineHash(last),
    }).problems;
    expect(changed.map((problem) => problem.problem)).toEqual([
      expect.stringMatching(/does not match the checkpoint/) as string,
    ]);
    const missing = verifyAuditLines(readAuditLines(dir), {
      seq: 9,
      head: lineHash(last),
    }).problems;
    expect(missing.map((problem) => problem.problem)).toEqual([
      expect.stringMatching(/no record has the checkpoint/) as string,
    ]);
  });

  it('fails on lines removed from the start of a file, whose name still says where it began', async () => {
    const dir = await written(9);
    rewrite(dir, (lines) => lines.slice(3));
    const report = verifyAuditLines(readAuditLines(dir));
    expect(report.firstSeq).toBe(4);
    expect(report.problems).toEqual([
      expect.objectContaining({
        lineNumber: 1,
        problem: expect.stringMatching(
          /name says its first record is seq 1, but it is seq 4: lines were removed from its start/,
        ) as string,
      }),
    ]);
  });

  it('fails on whole files removed from the start against a checkpoint, which names the first record the log keeps', async () => {
    // Small files, so nine records span several.
    const { audit, dir, lines } = open(scratch(), { rotateBytes: 600 });
    for (let index = 0; index < 9; index += 1) audit.append(call(T0 + index));
    await audit.close();
    const files = listAuditFiles(dir);
    expect(files.length).toBeGreaterThan(2);
    const stop = checkpoints(lines).at(-1);
    expect(stop).toEqual({ seq: 9, head: lineHash(fileLines(dir).at(-1) ?? ''), first: 1 });
    expect(verifyAuditLines(readAuditLines(dir), stop).problems).toEqual([]);
    // Whoever holds the disk deletes the oldest file, which retention would still keep.
    rmSync(join(dir, files[0]?.name ?? ''));
    const second = files[1]?.firstSeq ?? 0;
    // Without the checkpoint a file gone from the start reads as retention's work.
    expect(verifyAuditLines(readAuditLines(dir)).problems).toEqual([]);
    expect(verifyAuditLines(readAuditLines(dir), stop).problems).toEqual([
      expect.objectContaining({
        file: files[1]?.name,
        lineNumber: 1,
        problem: expect.stringMatching(
          new RegExp(
            `the log starts at seq ${String(second)}, but the checkpoint says it kept every record from seq 1`,
          ),
        ) as string,
      }),
    ]);
  });

  it('checkpoints after retention deletes a file, so the newest checkpoint names where the log now starts', async () => {
    const { audit, dir, lines } = open(scratch(), { rotateBytes: 600, maxBytes: 1500 });
    for (let index = 0; index < 12; index += 1) audit.append(call(T0 + index));
    await audit.close();
    const deleted = lines.findLastIndex((line) => line.includes('deleted by retention'));
    expect(deleted).toBeGreaterThan(-1);
    const after = lines.slice(deleted).find((line) => line.includes('"msg":"audit checkpoint"'));
    const first = listAuditFiles(dir)[0]?.firstSeq;
    expect(first).toBeGreaterThan(1);
    expect(JSON.parse(after ?? '{}')).toMatchObject({ first });
    // Retention removed whole files and said so, so the newest checkpoint finds nothing missing.
    expect(verifyAuditLines(readAuditLines(dir), checkpoints(lines).at(-1)).problems).toEqual([]);
  });
});

/** The checkpoints a log wrote to stderr, oldest first, as --checkpoint takes them. */
function checkpoints(lines: string[]): { seq: number; head: string; first: number }[] {
  return lines
    .filter((line) => line.includes('"msg":"audit checkpoint"'))
    .map((line) => {
      const { seq, head, first } = JSON.parse(line) as { seq: number; head: string; first: number };
      return { seq, head, first };
    });
}

describe('a gap still owed when the log closes (ADR 0019)', () => {
  /**
   * A disk whose writes can be made to fail: to the audit files alone, as a
   * file the disk broke fails while the directory still takes a small new
   * file, or to everything, as a full disk does.
   */
  function failingDisk(): { fs: AuditFs; fail: 'none' | 'files' | 'all' } {
    const auditFds = new Set<number>();
    const disk: { fs: AuditFs; fail: 'none' | 'files' | 'all' } = {
      fail: 'none',
      fs: {
        ...nodeFs,
        openSync: (...args: Parameters<typeof nodeFs.openSync>) => {
          const fd = nodeFs.openSync(...args);
          if (/audit-[^/\\]*\.jsonl$/.test(String(args[0]))) auditFds.add(fd);
          return fd;
        },
        closeSync: (fd: number) => {
          auditFds.delete(fd);
          nodeFs.closeSync(fd);
        },
        writeSync: ((fd: number, ...rest: [NodeJS.ArrayBufferView]) => {
          if (disk.fail === 'all' || (disk.fail === 'files' && auditFds.has(fd))) {
            throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
          }
          return nodeFs.writeSync(fd, ...rest);
        }) as typeof nodeFs.writeSync,
      },
    };
    return disk;
  }

  function start(at: number): AuditEventOf<'relay_start'> {
    return {
      v: AUDIT_VERSION,
      type: 'relay_start',
      at,
      version: 'test',
      env: 'production',
      mode: 'hosted',
      invites: false,
    };
  }

  function stop(at: number): AuditEventOf<'relay_stop'> {
    return { v: AUDIT_VERSION, type: 'relay_stop', at };
  }

  /** A run that loses 50 calls and its relay_stop to the disk, then closes. */
  async function stopWhileFailing(
    dir: string,
    disk: ReturnType<typeof failingDisk>,
    fail: 'files' | 'all',
  ): Promise<string[]> {
    const run = open(dir, { fs: disk.fs });
    expect(run.audit.append(start(T0))?.seq).toBe(1);
    expect(run.audit.append(call(T0 + 1))?.seq).toBe(2);
    disk.fail = fail;
    for (let index = 0; index < 50; index += 1) {
      expect(run.audit.append(call(T0 + 10 + index))).toBeNull();
    }
    expect(run.audit.append(stop(T0 + 100))).toBeNull();
    await run.audit.close();
    opened.splice(opened.indexOf(run.audit), 1);
    disk.fail = 'none';
    return run.lines;
  }

  /** The next start, on a disk that works again: relay_start and one call. */
  async function restart(
    dir: string,
    options: Partial<FileAuditLogOptions> = {},
  ): Promise<string[]> {
    const run = open(dir, options, { now: T0 + 1000 });
    run.audit.append(start(T0 + 1000));
    run.audit.append(call(T0 + 1001));
    await run.audit.close();
    return run.lines;
  }

  it('keeps the count in audit.gap, and the next start writes its audit_gap before anything else, which verify reports', async () => {
    const dir = scratch();
    const disk = failingDisk();
    const lines = await stopWhileFailing(dir, disk, 'files');
    // Whatever the disk does, the platform's logs keep the count.
    expect(
      lines.find((line) => line.includes('"level":"error"') && line.includes('"lost":51')),
    ).toMatch(/audit file missed records and the log is closing/);
    expect(existsSync(join(dir, AUDIT_GAP_NAME))).toBe(true);
    await restart(dir);
    expect(typesIn(dir)).toEqual(['relay_start', 'call', 'audit_gap', 'relay_start', 'call']);
    const gap = AuditLineSchema.parse(JSON.parse(fileLines(dir)[2] ?? '{}'));
    expect(gap).toMatchObject({ seq: 3, lost: 51, firstAt: T0 + 10, lastAt: T0 + 100 });
    // Written and synced, so the count is no longer owed.
    expect(existsSync(join(dir, AUDIT_GAP_NAME))).toBe(false);
    const report = verifyAuditLines(readAuditLines(dir));
    expect(report.problems).toEqual([]);
    expect(report.gaps).toEqual([
      expect.objectContaining({ seq: 3, lost: 51, firstAt: T0 + 10, lastAt: T0 + 100 }),
    ]);
    // The audit_gap accounts for the missing relay_stop.
    expect(report.uncleanStops).toEqual([]);
  });

  it('names the hole when nothing could be written at close: stderr keeps the count, and verify reports the stop without relay_stop', async () => {
    const dir = scratch();
    const disk = failingDisk();
    const lines = await stopWhileFailing(dir, disk, 'all');
    expect(
      lines.some((line) => line.includes('"level":"error"') && line.includes('"lost":51')),
    ).toBe(true);
    await restart(dir);
    expect(typesIn(dir)).toEqual(['relay_start', 'call', 'relay_start', 'call']);
    const report = verifyAuditLines(readAuditLines(dir));
    expect(report.problems).toEqual([]);
    expect(report.gaps).toEqual([]);
    expect(report.uncleanStops).toEqual([expect.objectContaining({ seq: 3, lineNumber: 1 })]);
  });

  it('writes the gap at close when the disk came back after the last record', async () => {
    const disk = failingDisk();
    const { audit, dir } = open(scratch(), { fs: disk.fs });
    audit.append(call(T0));
    disk.fail = 'all';
    expect(audit.append(call(T0 + 1))).toBeNull();
    expect(audit.append(call(T0 + 2))).toBeNull();
    disk.fail = 'none';
    await audit.close();
    expect(typesIn(dir)).toEqual(['call', 'audit_gap']);
    expect(AuditLineSchema.parse(JSON.parse(fileLines(dir)[1] ?? '{}'))).toMatchObject({
      lost: 2,
      firstAt: T0 + 1,
      lastAt: T0 + 2,
    });
    expect(existsSync(join(dir, AUDIT_GAP_NAME))).toBe(false);
  });

  it('counts an owed gap once, even when audit.gap could not be removed after its record was written', async () => {
    const dir = scratch();
    const disk = failingDisk();
    await stopWhileFailing(dir, disk, 'files');
    const stuck: AuditFs = {
      ...nodeFs,
      unlinkSync: (path: nodeFs.PathLike) => {
        if (String(path).endsWith(AUDIT_GAP_NAME)) {
          throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
        }
        nodeFs.unlinkSync(path);
      },
    };
    await restart(dir, { fs: stuck });
    expect(existsSync(join(dir, AUDIT_GAP_NAME))).toBe(true);
    // The next start sees the file's record already past the gap it names, and drops it.
    await restart(dir);
    expect(existsSync(join(dir, AUDIT_GAP_NAME))).toBe(false);
    expect(typesIn(dir)).toEqual([
      'relay_start',
      'call',
      'audit_gap',
      'relay_start',
      'call',
      'relay_start',
      'call',
    ]);
    expect(verifyAuditLines(readAuditLines(dir)).problems).toEqual([]);
  });
});

/** The record types of the lines in a directory, a line that is no JSON as 'torn'. */
function typesIn(dir: string): string[] {
  return fileLines(dir).map((line) => {
    try {
      return (JSON.parse(line) as { type: string }).type;
    } catch {
      return 'torn';
    }
  });
}

describe('a short write that leaves only the newline out (ADR 0019)', () => {
  /** An fs whose next armed record write lands every byte but the last, as a disk filling there does. */
  function shortByOne(newline: 'lands' | 'fails'): { fs: AuditFs; arm(): void } {
    let armed = false;
    let owed = false;
    const fs: AuditFs = {
      ...nodeFs,
      writeSync: ((fd: number, buffer: NodeJS.ArrayBufferView) => {
        const bytes = buffer as Buffer;
        if (armed && bytes.length > 1) {
          armed = false;
          owed = true;
          return nodeFs.writeSync(fd, bytes, 0, bytes.length - 1);
        }
        if (owed && newline === 'fails') {
          owed = false;
          throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
        }
        owed = false;
        return nodeFs.writeSync(fd, bytes);
      }) as typeof nodeFs.writeSync,
    };
    return {
      fs,
      arm: () => {
        armed = true;
      },
    };
  }

  it('keeps the record, writing the newline after it, so no seq repeats and verify is clean', async () => {
    const disk = shortByOne('lands');
    const { audit, dir, lines } = open(scratch(), { fs: disk.fs });
    audit.append(call(T0));
    disk.arm();
    expect(audit.append(call(T0 + 1))).toMatchObject({ seq: 2 });
    expect(audit.append(call(T0 + 2))).toMatchObject({ seq: 3 });
    await audit.close();
    expect(typesIn(dir)).toEqual(['call', 'call', 'call']);
    expect(lines.join('\n')).not.toContain('audit file write failed');
    const report = verifyAuditLines(readAuditLines(dir));
    expect(report).toMatchObject({ records: 3, lastSeq: 3, problems: [], torn: [] });
  });

  it('keeps the record when its newline fails too, and the next open closes the line', async () => {
    const disk = shortByOne('fails');
    const { audit, dir, lines } = open(scratch(), { fs: disk.fs });
    audit.append(call(T0));
    disk.arm();
    // The line is whole in the file, so it is a record: no gap, and its seq is not given again.
    expect(audit.append(call(T0 + 1))).toMatchObject({ seq: 2 });
    expect(lines.join('\n')).toContain('audit file write failed');
    expect(audit.append(call(T0 + 2))).toMatchObject({ seq: 3 });
    await audit.close();
    expect(typesIn(dir)).toEqual(['call', 'call', 'call']);
    const report = verifyAuditLines(readAuditLines(dir));
    expect(report).toMatchObject({ records: 3, lastSeq: 3, problems: [], torn: [] });
  });
});

describe('what reaches a line (ADR 0019, S11)', () => {
  it('writes the schema-checked record, so a field no schema lists is dropped even inside a nested object', async () => {
    const { audit, dir } = open(scratch());
    const secret = 'eyJhbGciOiJSUzI1NiJ9.SECRET-TOKEN';
    const tainted = call(T0, {
      client: {
        name: 'test',
        version: '1.0.0',
        accessToken: secret,
      } as AuditEventOf<'call'>['client'],
    });
    expect(audit.append(tainted)).toEqual({ seq: 1, prev: null });
    await audit.close();
    const [file] = listAuditFiles(dir);
    const text = readFileSync(join(dir, file?.name ?? ''), 'utf8');
    expect(text).not.toContain('SECRET-TOKEN');
    expect(text).not.toContain('accessToken');
    const [record] = fileLines(dir).map((line) => AuditLineSchema.parse(JSON.parse(line)));
    expect(record).toMatchObject({
      seq: 1,
      type: 'call',
      client: { name: 'test', version: '1.0.0' },
    });
    // The chain covers the line as written.
    expect(verifyAuditLines(readAuditLines(dir)).problems).toEqual([]);
  });
});

describe('one writer per directory (ADR 0019)', () => {
  /** A process that runs until killed, to hold a pid that is alive and not this one. */
  async function otherProcess(
    args: string[] = ['-e', 'setInterval(() => {}, 1000)'],
  ): Promise<{ pid: number; stop(): Promise<void> }> {
    const child = spawn(process.execPath, args, { stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    return {
      pid: child.pid ?? 0,
      stop: () =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once('exit', () => {
            resolve();
          });
          child.kill('SIGKILL');
        }),
    };
  }

  /** A process that sets a file's mtime to now every 50 ms, as a live relay refreshes its lock. */
  function refresher(path: string): Promise<{ pid: number; stop(): Promise<void> }> {
    return otherProcess([
      '-e',
      'const fs = require("node:fs"); setInterval(() => { const t = new Date(); try { fs.utimesSync(process.argv[1], t, t); } catch {} }, 50);',
      path,
    ]);
  }

  /** A relay's log open in another process, holding the directory's lock as a relay does. */
  async function holder(
    dir: string,
    staleMs?: number,
  ): Promise<{ pid: number; stop(): Promise<void> }> {
    const child = spawn(
      process.execPath,
      [
        join(import.meta.dirname, 'fixtures', 'hold-audit-lock.ts'),
        dir,
        ...(staleMs === undefined ? [] : [String(staleMs)]),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('held')) resolve();
      });
      child.once('exit', () => {
        reject(new Error(`the lock holder exited: ${output}`));
      });
    });
    return {
      pid: child.pid ?? 0,
      stop: () =>
        new Promise<void>((resolve) => {
          child.removeAllListeners('exit');
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once('exit', () => {
            resolve();
          });
          child.kill('SIGTERM');
        }),
    };
  }

  /** Blocks this thread, as a relay paused between two steps would be. */
  function pause(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  /**
   * How this process's lock names the machine and its pid namespace: the
   * fields between the pid and the owner id of a lock it took itself.
   */
  async function ownView(): Promise<string> {
    const { audit, dir } = open(scratch());
    const text = readFileSync(join(dir, AUDIT_LOCK_NAME), 'utf8');
    await audit.close();
    opened.splice(opened.indexOf(audit), 1);
    return text.trim().split(' ').slice(1, -1).join(' ');
  }

  function owner(byte: string): string {
    return byte.repeat(16);
  }

  function aged(path: string, ms: number): void {
    const then = new Date(Date.now() - ms);
    utimesSync(path, then, then);
  }

  it('refuses a second log on a directory this process already writes, before it reads or writes a line', async () => {
    const dir = scratch();
    const first = open(dir);
    first.audit.append(call(T0));
    expect(existsSync(join(dir, AUDIT_LOCK_NAME))).toBe(true);
    expect(() => open(dir)).toThrow(AuditDirError);
    expect(() => open(dir)).toThrow(/already open in this process/);
    first.audit.append(call(T0 + 1));
    await first.audit.close();
    // Released at close; the next log goes on with the chain.
    expect(existsSync(join(dir, AUDIT_LOCK_NAME))).toBe(false);
    const second = open(dir);
    expect(second.audit.append(call(T0 + 2))?.seq).toBe(3);
    await second.audit.close();
    expect(verifyAuditLines(readAuditLines(dir))).toMatchObject({ records: 3, problems: [] });
  });

  it('refuses a lock a live relay in this pid namespace holds, naming its pid, and at once replaces one whose relay is gone or was an earlier run with this pid', async () => {
    const view = await ownView();
    const dir = scratch();
    open(dir).audit.append(call(T0));
    for (const audit of opened.splice(0)) await audit.close();
    const lock = join(dir, AUDIT_LOCK_NAME);
    const before = readFileSync(join(dir, listAuditFiles(dir)[0]?.name ?? ''), 'utf8');
    const other = await otherProcess();
    try {
      writeFileSync(lock, `${String(other.pid)} ${view} ${owner('ab')}\n`);
      expect(() => open(dir)).toThrow(
        new RegExp(
          `in use by another relay, pid ${String(other.pid)}.*delete .*${AUDIT_LOCK_NAME}`,
        ),
      );
      // Nothing was read into a chain or written.
      expect(readFileSync(join(dir, listAuditFiles(dir)[0]?.name ?? ''), 'utf8')).toBe(before);
    } finally {
      await other.stop();
    }
    // Its relay is gone now, as after a crash: the lock is replaced at once, with a warning.
    const after = open(dir);
    expect(after.lines.join('\n')).toContain('replaced an audit directory lock');
    expect(after.audit.append(call(T0 + 1))?.seq).toBe(2);
    await after.audit.close();
    // A lock naming this very pid in this namespace, under another owner id, was left by an earlier run.
    writeFileSync(lock, `${String(process.pid)} ${view} ${owner('cd')}\n`);
    const again = open(dir);
    expect(again.audit.append(call(T0 + 2))?.seq).toBe(3);
    await again.audit.close();
    expect(verifyAuditLines(readAuditLines(dir)).problems).toEqual([]);
  }, 20_000);

  it("refuses a lock another container's relay holds and refreshes, even one that names this pid", async () => {
    const view = await ownView();
    const boot = view.split(' ')[0] ?? '-';
    const dir = scratch();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lock = join(dir, AUDIT_LOCK_NAME);
    // Another container on this host and volume: pid 1 there as here, the
    // same boot, a pid namespace of its own; then the same lock as the format
    // before owner ids wrote it.
    for (const text of [
      `${String(process.pid)} ${boot} 4026500001 ${owner('ef')}\n`,
      `${String(process.pid)} ${boot}\n`,
    ]) {
      writeFileSync(lock, text);
      const live = await refresher(lock);
      try {
        expect(() => open(dir, { lockStaleMs: 15_000 })).toThrow(/in use by another relay/);
      } finally {
        await live.stop();
      }
      expect(readFileSync(lock, 'utf8')).toBe(text);
      expect(listAuditFiles(dir)).toEqual([]);
    }
  }, 20_000);

  it('waits out a lock from a relay it cannot see, and replaces it only once nobody refreshed it for the stale interval', async () => {
    const view = await ownView();
    const boot = view.split(' ')[0] ?? '-';
    const dir = scratch();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lock = join(dir, AUDIT_LOCK_NAME);
    // Another pid namespace with this pid, then another boot of the machine.
    for (const text of [
      `${String(process.pid)} ${boot} 4026500001 ${owner('ef')}\n`,
      `1 00000000-0000-0000-0000-000000000000 4026500001 ${owner('ef')}\n`,
    ]) {
      writeFileSync(lock, text);
      const started = Date.now();
      const log = open(dir, { lockStaleMs: 400 });
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
      expect(log.lines.join('\n')).toContain('replaced an audit directory lock');
      expect(readFileSync(lock, 'utf8')).toMatch(new RegExp(`^${String(process.pid)} `));
      expect(readFileSync(lock, 'utf8')).not.toBe(text);
      await log.audit.close();
      opened.splice(opened.indexOf(log.audit), 1);
    }
    // A lock nobody refreshed for longer than that goes at once.
    writeFileSync(lock, `1 ${boot} 4026500001 ${owner('ef')}\n`);
    aged(lock, 10 * 60_000);
    const started = Date.now();
    const log = open(dir);
    expect(Date.now() - started).toBeLessThan(1000);
    await log.audit.close();
  }, 20_000);

  it('breaks a stale lock in one step, so a relay that read it never removes the lock another relay took meanwhile', async () => {
    const dir = scratch();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lock = join(dir, AUDIT_LOCK_NAME);
    const stale = '999999 -\n';
    writeFileSync(lock, stale);
    aged(lock, 10 * 60_000);
    const race: { other: Promise<{ pid: number; stop(): Promise<void> }> | null } = {
      other: null,
    };
    /** This relay has read the stale lock and is about to break it; another starts now and gets there first. */
    const interleave = (path: nodeFs.PathLike): void => {
      if (race.other !== null || String(path) !== lock) return;
      race.other = holder(dir);
      for (let waited = 0; waited < 15_000; waited += 20) {
        pause(20);
        let text = stale;
        try {
          text = nodeFs.readFileSync(lock, 'utf8');
        } catch {
          // Between the other relay's break and its link.
        }
        if (text !== stale) return;
      }
    };
    const fs: AuditFs = {
      ...nodeFs,
      renameSync: (from: nodeFs.PathLike, to: nodeFs.PathLike) => {
        interleave(from);
        nodeFs.renameSync(from, to);
      },
      unlinkSync: (path: nodeFs.PathLike) => {
        interleave(path);
        nodeFs.unlinkSync(path);
      },
    };
    try {
      expect(() => open(dir, { fs })).toThrow(/in use by another relay/);
      const taken = await (race.other ?? Promise.reject(new Error('no other relay started')));
      // The other relay's lock is where it put it, whole.
      expect(readFileSync(lock, 'utf8')).toMatch(new RegExp(`^${String(taken.pid)} `));
      await taken.stop();
      expect(existsSync(lock)).toBe(false);
    } finally {
      // Stopped however the test went, so no holder outlives it.
      await (await race.other?.catch(() => null))?.stop();
    }
  }, 20_000);

  it('leaves at close a lock that is no longer its own, even one that differs only in its owner id', async () => {
    const { audit, dir } = open(scratch());
    audit.append(call(T0));
    const lock = join(dir, AUDIT_LOCK_NAME);
    const own = readFileSync(lock, 'utf8');
    // A relay in another container, pid 1 as this one, took the directory while this one was paused.
    const theirs = own.replace(/ [0-9a-f]{32}\n$/, ` ${owner('9a')}\n`);
    rmSync(lock);
    writeFileSync(lock, theirs);
    await audit.close();
    expect(readFileSync(lock, 'utf8')).toBe(theirs);
  });

  it('stops writing its files once another relay holds its lock, and says so', async () => {
    const { audit, dir, lines } = open(scratch(), { lockStaleMs: 600 });
    expect(audit.append(call(T0))?.seq).toBe(1);
    const lock = join(dir, AUDIT_LOCK_NAME);
    const theirs = readFileSync(lock, 'utf8').replace(/ [0-9a-f]{32}\n$/, ` ${owner('9a')}\n`);
    rmSync(lock);
    writeFileSync(lock, theirs);
    // Longer than the 100 ms between refreshes that a 600 ms stale interval gives.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(audit.append(call(T0 + 1))).toBeNull();
    expect(lines.join('\n')).toMatch(/audit directory's lock is another relay's now/);
    await audit.close();
    expect(fileLines(dir)).toHaveLength(1);
    expect(readFileSync(lock, 'utf8')).toBe(theirs);
  });

  it('takes its lock again when it was deleted while the log was open, and keeps writing', async () => {
    const { audit, dir, lines } = open(scratch(), { lockStaleMs: 600 });
    audit.append(call(T0));
    const lock = join(dir, AUDIT_LOCK_NAME);
    const own = readFileSync(lock, 'utf8');
    rmSync(lock);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(audit.append(call(T0 + 1))?.seq).toBe(2);
    expect(readFileSync(lock, 'utf8')).toBe(own);
    expect(lines.join('\n')).toContain('took it again');
    await audit.close();
    expect(existsSync(lock)).toBe(false);
  });
});

describe('the timers and defaults ADR 0019 sets', () => {
  /** An fs that counts fdatasync calls. */
  function counting(): { fs: AuditFs; readonly syncs: number } {
    let syncs = 0;
    return {
      fs: {
        ...nodeFs,
        fdatasyncSync: (fd: number) => {
          syncs += 1;
          nodeFs.fdatasyncSync(fd);
        },
      },
      get syncs() {
        return syncs;
      },
    };
  }

  it('syncs at most once a second, one sync for a burst, and none when nothing is new', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const disk = counting();
    const { audit } = open(scratch(), { fs: disk.fs });
    audit.append(call(T0));
    expect(disk.syncs).toBe(0);
    vi.advanceTimersByTime(AUDIT_SYNC_MS - 1);
    expect(disk.syncs).toBe(0);
    vi.advanceTimersByTime(1);
    expect(disk.syncs).toBe(1);
    for (let index = 1; index <= 5; index += 1) audit.append(call(T0 + index));
    expect(disk.syncs).toBe(1);
    vi.advanceTimersByTime(AUDIT_SYNC_MS);
    expect(disk.syncs).toBe(2);
    vi.advanceTimersByTime(10 * AUDIT_SYNC_MS);
    expect(disk.syncs).toBe(2);
    expect(AUDIT_SYNC_MS).toBe(1000);
  });

  it('writes a checkpoint to stderr every 15 minutes, naming the head', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { audit, dir, lines } = open(scratch());
    audit.append(call(T0));
    const checkpoints = (): string[] =>
      lines.filter((line) => line.includes('"msg":"audit checkpoint"'));
    vi.advanceTimersByTime(AUDIT_CHECKPOINT_MS - 1);
    expect(checkpoints()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(checkpoints()).toHaveLength(1);
    expect(JSON.parse(checkpoints()[0] ?? '{}')).toMatchObject({
      seq: 1,
      head: lineHash(fileLines(dir)[0] ?? ''),
    });
    vi.advanceTimersByTime(AUDIT_CHECKPOINT_MS);
    expect(checkpoints()).toHaveLength(2);
    expect(AUDIT_CHECKPOINT_MS).toBe(15 * 60_000);
  });

  it(`rotates at ${String(AUDIT_ROTATE_MB)} MiB when no test says otherwise`, async () => {
    expect(AUDIT_ROTATE_MB).toBe(8);
    const limit = AUDIT_ROTATE_MB * 1024 * 1024;
    const { audit, dir } = open(scratch());
    // Long origins make long lines, so a few thousand of them fill a file.
    const origin = `https://${'o'.repeat(2000)}.example`;
    audit.append(call(T0, { origin }));
    audit.append(call(T0, { origin }));
    const line = statSync(join(dir, listAuditFiles(dir)[0]?.name ?? '')).size / 2;
    // Enough lines to pass the limit by a few, and no more, whatever the limit really is.
    const enough = Math.ceil((limit / line) * 1.01) + 20;
    for (let count = 2; count < enough && listAuditFiles(dir).length < 2; count += 1) {
      expect(audit.append(call(T0, { origin }))).not.toBeNull();
    }
    await audit.close();
    const files = listAuditFiles(dir).map((file) => statSync(join(dir, file.name)).size);
    expect(files).toHaveLength(2);
    expect(files[0]).toBeLessThanOrEqual(limit);
    expect(files[0]).toBeGreaterThan(limit - 2 * (line + 20));
    expect(verifyAuditLines(readAuditLines(dir)).problems).toEqual([]);
  });

  it('keeps the file the chain goes on from at a start, however old, until a newer one exists', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const dir = scratch();
    const first = open(dir);
    first.audit.append(call(T0));
    await first.audit.close();
    const [only] = listAuditFiles(dir);
    // 31 days on, with 30 days of retention: the only file is still the current one.
    const later = { now: T0 + 31 * DAY };
    const reopened = open(dir, {}, later);
    expect(listAuditFiles(dir)).toEqual([only]);
    expect(reopened.lines.join('\n')).not.toContain('deleted by retention');
    // Once a record goes to today's file, the old one is past the retention and goes at the next pass.
    expect(reopened.audit.append(call(later.now))?.seq).toBe(2);
    vi.advanceTimersByTime(AUDIT_RETENTION_CHECK_MS);
    expect(listAuditFiles(dir).map((file) => file.day)).toEqual([utcDay(later.now)]);
    await reopened.audit.close();
  });

  it('narrows a file that already exists to 0600 before writing to it', () => {
    if (process.platform === 'win32') return;
    const dir = scratch();
    mkdirSync(dir, { mode: 0o700 });
    const path = join(dir, `audit-${utcDay(T0)}-000000000001.jsonl`);
    writeFileSync(path, '');
    chmodSync(path, 0o644);
    const { audit } = open(dir);
    expect(audit.append(call(T0))?.seq).toBe(1);
    expect(listAuditFiles(dir).map((file) => file.name)).toEqual([
      `audit-${utcDay(T0)}-000000000001.jsonl`,
    ]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

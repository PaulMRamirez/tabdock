// The persistent audit log (S7, ADR 0019) on its own: JSON Lines in a 0700
// directory of 0600 files, a sequence and a SHA-256 chain that run on across
// files and restarts, rotation by size and UTC day, retention by age and
// total size that never deletes the current file, a torn line from a crash
// closed at the next start, failing open with an audit_gap record once
// writing works again, a schema check before every line, and the reader's
// --verify, which names torn lines and fails on an edited or removed one.

import * as nodeFs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUDIT_VERSION,
  type AuditEvent,
  type AuditEventOf,
  AuditLineSchema,
} from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuditDirError,
  type AuditFs,
  createLogger,
  FileAuditLog,
  type FileAuditLogOptions,
  lineHash,
  listAuditFiles,
  readAuditLines,
  verifyAuditLines,
} from '../src/index.ts';

const scratches: string[] = [];
const opened: FileAuditLog[] = [];

afterEach(async () => {
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
});

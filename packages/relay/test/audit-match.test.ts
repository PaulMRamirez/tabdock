// `pnpm audit:log --match` (ADR 0045, A6.25): a session record the operator
// saved, held to the hash-chained audit log call by call on the invoke's
// callId. Against a real run (a relay with an audit directory, a page that
// keeps what it was handed on a clock 90 s ahead, and SDK clients), the
// genuine record matches, and a call added, removed or changed fails it.
// Against logs written line by line: two lines with one callId fail; a call
// the record lacks within its dropped span, or whose invoke may never have
// arrived, and a call missing inside an audit_gap, are notes; an invitee
// matches by short id; a proposal matches its lines. The file is refused
// before it is read when larger than any record, a refusal never repeats the
// path it was given, what a file wrote reaches the terminal escaped, --match
// takes no filter, and --call finds one call line.

import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import {
  AUDIT_VERSION,
  type AuditEvent,
  type AuditLine,
  encodeSessionRecord,
  plainLine,
  SESSION_RECORD_MAX_BYTES,
  SESSION_RECORD_MAX_CALLS,
  type SessionRecord,
  SessionRecordSchema,
} from '@tabdock/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAuditCli } from '../src/audit-cli.ts';
import { readAuditLines } from '../src/audit-file.ts';
import { matchSessionRecord } from '../src/audit-match.ts';
import { createLogger, FileAuditLog } from '../src/index.ts';
import { connectPage, type InvokeFrame, type TestPage, TOOLS } from './helpers/page-client.ts';
import {
  ALICE,
  BOB,
  callTool,
  connectClient,
  pairAndApprove,
  startRelay,
  type TestRelay,
} from './helpers/relay.ts';

// readFileSync passes through, watched, so a test can show a file too large is never read.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const scratches: string[] = [];
const relays: TestRelay[] = [];
const pages: TestPage[] = [];
const clients: Client[] = [];

afterEach(async () => {
  vi.mocked(readFileSync).mockClear();
  for (const client of clients.splice(0)) await client.close();
  for (const page of pages.splice(0)) page.ws.terminate();
  for (const relay of relays.splice(0)) await relay.close();
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tabdock-audit-match-')));
  scratches.push(dir);
  return dir;
}

function run(argv: string[]): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = runAuditCli(
    argv,
    {},
    { out: (line) => out.push(line), err: (line) => err.push(line) },
  );
  return { code, out, err };
}

/** The record as a file, and the reader's answer to --match on it. */
function match(
  record: SessionRecord,
  dir: string,
  ...more: string[]
): { code: number; out: string[]; err: string[] } {
  const file = join(scratch(), 'tabdock-record.json');
  writeFileSync(file, encodeSessionRecord(SessionRecordSchema.parse(record)));
  return run(['--match', file, '--dir', dir, ...more]);
}

/** The page's clock runs this far ahead of the relay's. */
const PAGE_AHEAD_MS = 90_000;

type Person = SessionRecord['calls'][number]['user'];
type Call = SessionRecord['calls'][number];

const EMPTY_DROPPED: SessionRecord['dropped'] = {
  calls: 0,
  attachments: 0,
  proposals: 0,
  firstAt: null,
  lastAt: null,
  byUser: [],
  otherCalls: 0,
};

/** A record still being kept, saved at its `to` as the recorder saves one, unless `more` says otherwise. */
function sessionRecord(more: Partial<SessionRecord>): SessionRecord {
  const to = more.to ?? 1;
  return {
    format: 'tabdock.session-record',
    v: 1,
    adapterVersion: '0.1.0',
    exportedAt: to,
    page: { origin: 'http://localhost:5173', path: '/', title: 'Test page' },
    relay: '127.0.0.1',
    policy: SessionRecordSchema.shape.policy.parse({}),
    pageIds: ['pg_1'],
    scope: { kind: 'page' },
    from: 0,
    to,
    sealed: false,
    attachments: [],
    calls: [],
    proposals: [],
    dropped: EMPTY_DROPPED,
    ...more,
  };
}

/**
 * A real run: Alice and Bob pair and call the page, which keeps each invoke
 * it was handed with its arrival on its own clock. The record a page would
 * save of it, spanning a minute either side, and the audit directory.
 */
async function realRun(): Promise<{ dir: string; record: SessionRecord }> {
  const dir = join(scratch(), 'audit');
  const relay = await startRelay({ audit: { dir } });
  relays.push(relay);
  const handed: { frame: InvokeFrame; at: number }[] = [];
  const page = await connectPage(relay.relay.pageUrl, {
    tools: TOOLS,
    policy: { maxDrivers: 2 },
    onInvoke: (frame) => {
      handed.push({ frame, at: Date.now() + PAGE_AHEAD_MS });
      return { ok: true, content: 'done' };
    },
  });
  pages.push(page);
  const pageId = page.pageId;
  const from = Date.now() + PAGE_AHEAD_MS - 60_000;
  const joined: { user: Person; at: number }[] = [];
  for (const user of [ALICE, BOB]) {
    const client = await connectClient(relay.relay, user, { name: 'match-test' });
    clients.push(client);
    await pairAndApprove(client, page, 'driver');
    joined.push({
      user: { id: user.userId, name: user.displayName, kind: 'member' },
      at: Date.now() + PAGE_AHEAD_MS,
    });
  }
  const [alice, bob] = clients;
  if (alice === undefined || bob === undefined) throw new Error('no clients');
  for (const [client, tool, args] of [
    [alice, 'get_view', {}],
    [bob, 'add_item', { label: 'one' }],
    [alice, 'get_view', {}],
    [bob, 'get_view', {}],
    [alice, 'add_item', { label: 'two' }],
  ] as const) {
    const answer = await callTool(client, 'call_page_tool', {
      page: pageId,
      tool,
      arguments: args,
    });
    expect(answer.isError, answer.text).toBe(false);
  }
  // A refusal no page saw writes a line without a callId, which the record never needs.
  const refused = await callTool(alice, 'call_page_tool', {
    page: pageId,
    tool: 'add_item',
    arguments: {},
  });
  expect(refused.isError).toBe(true);
  await relay.close();
  relays.splice(0);

  const calls: Call[] = handed.map(({ frame, at }) => ({
    callId: frame.callId,
    pageId,
    at,
    user: { id: frame.caller.userId, name: frame.caller.displayName, kind: 'member' },
    client:
      frame.caller.client === null
        ? null
        : plainLine(`${frame.caller.client.name} ${frame.caller.client.version}`),
    tool: frame.tool,
    outcome: 'ok',
    durationMs: 3,
    confirmedBy: null,
    proposalId: null,
  }));
  expect(calls).toHaveLength(5);
  const record = sessionRecord({
    pageIds: [pageId],
    page: { origin: 'http://localhost:5173', path: '/', title: 'Test page' },
    from,
    to: Date.now() + PAGE_AHEAD_MS + 60_000,
    attachments: joined.map(({ user, at }) => ({
      user,
      pageId,
      how: 'approved',
      inviteId: null,
      before: false,
      joinedAt: at,
      leftAt: null,
      ended: null,
      roles: [{ at, role: 'driver' }],
      rolesDropped: 0,
    })),
    calls,
  });
  return { dir, record };
}

describe('audit --match against a real run', () => {
  it('passes the genuine record, citing the file by its SHA-256, with the page clock 90 s ahead', async () => {
    const { dir, record } = await realRun();
    const file = join(scratch(), 'record.json');
    writeFileSync(file, encodeSessionRecord(record));
    const result = run(['--match', file, '--dir', dir, '--verify']);
    expect(result.code, [...result.out, ...result.err].join('\n')).toBe(0);
    expect(result.out).toEqual([]);
    const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
    expect(result.err).toContain(`record sha256 ${digest}`);
    expect(result.err.at(-1)).toMatch(
      /^match: agrees with the log; 5 calls matched, 0 missing, 0 conflicts, 0 unrecorded \(and 0 within the record's dropped span, 0 that may never have reached the page, 0 that cannot be placed\), median skew 9\d\.\d s$/,
    );
    expect(result.err.some((line) => line.startsWith('verify: chain intact'))).toBe(true);
  }, 30_000);

  it('fails a record with a call added, removed or changed', async () => {
    const { dir, record } = await realRun();
    const [first, second, third] = record.calls;
    if (first === undefined || second === undefined || third === undefined)
      throw new Error('no calls');

    const added = match(
      { ...record, calls: [...record.calls, { ...second, callId: 'cl_forged' }] },
      dir,
    );
    expect(added.code).toBe(1);
    expect(added.out).toEqual([
      expect.stringMatching(/^FAIL missing: call cl_forged \(add_item by Bob \(bob\) at /),
    ]);

    const removed = match({ ...record, calls: record.calls.filter((call) => call !== third) }, dir);
    expect(removed.code).toBe(1);
    expect(removed.out).toEqual([
      expect.stringMatching(
        new RegExp(`^FAIL unrecorded: call ${third.callId} \\(get_view by alice at `),
      ),
    ]);

    const changes: [string, Partial<Call>][] = [
      ['tool', { tool: 'clear_board' }],
      ['user', { user: { id: 'carol', name: 'Carol', kind: 'member' } }],
      ['confirmedBy', { confirmedBy: 'client' }],
      ['outcome', { outcome: 'denied_by_operator' }],
      ['page', { pageId: 'pg_another' }],
    ];
    for (const [field, change] of changes) {
      const pageIds =
        change.pageId === undefined ? record.pageIds : [...record.pageIds, change.pageId];
      const changed = match(
        { ...record, pageIds, calls: [first, { ...second, ...change }, ...record.calls.slice(2)] },
        dir,
      );
      expect(changed.code, field).toBe(1);
      expect(changed.out, field).toEqual([
        `FAIL conflict: call ${second.callId} (${change.tool ?? second.tool} by ${change.user?.name ?? 'Bob'} (${change.user?.id ?? 'bob'}) at ${new Date(second.at).toISOString()}): its line differs in ${field}`,
      ]);
    }
    // The page's own Allow is no field the log keeps, so it matches the line's absence.
    expect(
      match(
        { ...record, calls: [first, { ...second, confirmedBy: 'page' }, ...record.calls.slice(2)] },
        dir,
      ).code,
    ).toBe(0);
  }, 30_000);

  it('finds one call line by its callId with --call', async () => {
    const { dir, record } = await realRun();
    const [first, second] = record.calls;
    if (first === undefined || second === undefined) throw new Error('no calls');
    const found = run(['--dir', dir, '--call', first.callId, '--json']);
    expect(found.code).toBe(0);
    expect(found.out.map((line) => JSON.parse(line) as { callId?: string })).toEqual([
      expect.objectContaining({ type: 'call', callId: first.callId }),
    ]);
    expect(run(['--dir', dir, '--call', `${first.callId},${second.callId}`]).out).toHaveLength(2);
    expect(run(['--dir', dir, '--call', 'cl_none']).out).toEqual([]);
  }, 30_000);
});

/** A log written line by line, as a relay would, its chain whole. */
async function writeLog(events: AuditEvent[]): Promise<string> {
  const dir = join(scratch(), 'audit');
  const audit = FileAuditLog.open({
    dir,
    retentionDays: 30,
    maxBytes: 64 * 1024 * 1024,
    log: createLogger({ sink: () => undefined }),
  });
  for (const event of events) audit.append(event);
  await audit.close();
  return dir;
}

/** The log's records as the reader reads them, for calling the matcher without a file. */
function logLines(dir: string): AuditLine[] {
  return [...readAuditLines(dir)].flatMap((line) => (line.record === null ? [] : [line.record]));
}

const GUEST_ID = `g_0123abcd${'e'.repeat(24)}`;
const guest: Person = { id: 'g_0123abcd', name: 'guest@example.com', kind: 'invitee' };
const alice: Person = { id: 'alice', name: 'Alice', kind: 'member' };

type CallEvent = Extract<AuditEvent, { type: 'call' }>;
type ClosedEvent = Extract<AuditEvent, { type: 'proposal_closed' }>;
type Proposal = SessionRecord['proposals'][number];

/** A call line, carrying the callId c_<n> unless `callId` says none went out. */
function callLine(
  n: number,
  more: Partial<CallEvent> = {},
  callId: string | null = `c_${String(n)}`,
): CallEvent {
  return {
    v: AUDIT_VERSION,
    type: 'call',
    at: 1_000_000 + n * 1_000,
    pageId: 'pg_1',
    origin: 'http://localhost:5173',
    userId: 'alice',
    client: { name: 'claude-code', version: '2.1.288' },
    tool: 'set_view',
    outcome: 'ok',
    durationMs: 5,
    ...(callId === null ? {} : { callId }),
    ...more,
  };
}

function recordCall(n: number, more: Partial<Call> = {}): Call {
  return {
    callId: `c_${String(n)}`,
    pageId: 'pg_1',
    at: 1_000_000 + n * 1_000 + 20,
    user: alice,
    client: 'claude-code 2.1.288',
    tool: 'set_view',
    outcome: 'ok',
    durationMs: 5,
    confirmedBy: null,
    proposalId: null,
    ...more,
  };
}

/** A record of calls 0 to 59 at a second apart, but for those left out, spanning them with a minute either side. */
function recordOf(skip: number[], more: Partial<SessionRecord> = {}): SessionRecord {
  return sessionRecord({
    from: 1_000_000 - 60_000,
    to: 1_000_000 + 120_000,
    calls: Array.from({ length: 60 }, (_, n) => n)
      .filter((n) => !skip.includes(n))
      .map((n) => recordCall(n)),
    ...more,
  });
}

const sixty = (more: (n: number) => Partial<CallEvent> = () => ({})) =>
  Array.from({ length: 60 }, (_, n) => callLine(n, more(n)));

describe('audit --match against logs written line by line', () => {
  it('fails two call lines that carry one callId', async () => {
    const dir = await writeLog([...sixty(), callLine(30)]);
    const result = match(recordOf([]), dir, '--verify');
    expect(result.code).toBe(1);
    expect(result.out).toEqual([
      expect.stringMatching(/^FAIL duplicate: call c_30 .*: 2 call lines carry its callId$/),
    ]);
  });

  it('takes the calls a full record dropped, as its counts give them, and nothing more', async () => {
    // A full ring of SESSION_RECORD_MAX_CALLS after its oldest ten went: c_0 to c_4 the relay
    // answered timeout while the page saw ok, and c_5 to c_9 the page answered tool_error.
    const total = SESSION_RECORD_MAX_CALLS + 10;
    const dir = await writeLog(
      Array.from({ length: total }, (_, n) =>
        callLine(n, n < 5 ? { outcome: 'timeout' } : n < 10 ? { outcome: 'tool_error' } : {}),
      ),
    );
    const lines = logLines(dir);
    const ring = (more: Partial<SessionRecord> = {}): SessionRecord =>
      sessionRecord({
        from: 1_000_000 - 60_000,
        to: 1_000_000 + total * 1_000 + 60_000,
        calls: Array.from({ length: SESSION_RECORD_MAX_CALLS }, (_, n) => recordCall(n + 10)),
        dropped: {
          ...EMPTY_DROPPED,
          calls: 10,
          firstAt: 1_000_000 + 20,
          lastAt: 1_000_000 + 9_000 + 20,
          // Listed first, so a line the relay answered would take these if it went first.
          byUser: [{ user: 'alice', counts: { tool_error: 5, ok: 5 } }],
        },
        ...more,
      });
    const capped = match(ring(), dir);
    expect(capped.code, capped.out.join('\n')).toBe(0);
    expect(capped.out).toHaveLength(10);
    expect(capped.out[0]).toMatch(
      /^note explained: call c_0 .* falls within the calls the record's cap dropped$/,
    );
    expect(capped.err.at(-1)).toContain("0 unrecorded (and 10 within the record's dropped span");

    const failsWith = (record: SessionRecord, unrecorded: number): void => {
      const report = matchSessionRecord(SessionRecordSchema.parse(record), lines);
      expect(report.failed).toBe(true);
      expect(report.unrecorded).toBe(unrecorded);
    };
    const dropped = ring().dropped;
    // A record short of the cap dropped nothing from its ring, whatever its counts say.
    failsWith(ring({ calls: ring().calls.filter((call) => call.callId !== 'c_40') }), 11);
    // Dropped calls are older than every call the ring kept.
    failsWith(ring({ dropped: { ...dropped, lastAt: 1_000_000 + 10_000 + 21 } }), 10);
    // The counts by user and outcome cover no more lines than they count.
    failsWith(
      ring({ dropped: { ...dropped, byUser: [{ user: 'alice', counts: { ok: 10 } }] } }),
      5,
    );
    failsWith(
      ring({
        dropped: { ...dropped, byUser: [{ user: 'alice', counts: { tool_error: 5, ok: 4 } }] },
      }),
      1,
    );
    failsWith(ring({ dropped: { ...dropped, byUser: [{ user: 'bob', counts: { ok: 10 } }] } }), 10);
    // A call still running when dropped fits any outcome, and users past the
    // byUser cap are counted together.
    for (const more of [
      { byUser: [{ user: 'alice', counts: { running: 10 } }] },
      { byUser: [], otherCalls: 10 },
    ]) {
      expect(matchSessionRecord(ring({ dropped: { ...dropped, ...more } }), lines).failed).toBe(
        false,
      );
    }
  }, 30_000);

  it('fails a record with a call removed and a dropped span written over it', async () => {
    const dir = await writeLog(sixty());
    const widened = match(
      recordOf([30], {
        dropped: {
          ...EMPTY_DROPPED,
          calls: 1,
          firstAt: 950_000,
          lastAt: 1_110_000,
          byUser: [{ user: 'alice', counts: { ok: 1 } }],
        },
      }),
      dir,
    );
    expect(widened.code).toBe(1);
    expect(widened.out).toEqual([expect.stringMatching(/^FAIL unrecorded: call c_30 /)]);
  });

  it('fails a record whose span was narrowed to leave a removed call out', async () => {
    const dir = await writeLog(sixty());
    const narrowed = match(recordOf([30], { from: 1, to: 1 }), dir);
    expect(narrowed.code).toBe(1);
    expect(narrowed.out.filter((line) => line.startsWith('FAIL window: call '))).toHaveLength(59);
    expect(narrowed.out).toContainEqual(expect.stringMatching(/^FAIL unrecorded: call c_30 /));
    // Moving the kept calls' own times so the span can start after the removed one
    // changes nothing: between two calls the record holds, the relay's order decides.
    const shifted = recordOf([3], {
      from: 1_000_000 + 8_100,
      calls: recordOf([3]).calls.map((call, n) =>
        n < 8 ? { ...call, at: 1_000_000 + 8_100 + n } : call,
      ),
    });
    const moved = match(shifted, dir);
    expect(moved.code).toBe(1);
    expect(moved.out).toEqual([expect.stringMatching(/^FAIL unrecorded: call c_3 /)]);
    // A sealed record cannot end after it was saved, and a kept one ends when it was saved.
    expect(match(recordOf([], { sealed: true, exportedAt: 1_000_000 }), dir).out).toEqual([
      "FAIL window: the record's span does not end where its export says it does",
    ]);
    expect(match(recordOf([], { exportedAt: 1_200_000 }), dir).code).toBe(1);
    expect(match(recordOf([], { sealed: true, exportedAt: 1_200_000 }), dir).code).toBe(0);
  });

  it('fails a record whose spans, proposals or dropped calls lie outside its own span', async () => {
    const lines = logLines(await writeLog(sixty()));
    const span: SessionRecord['attachments'][number] = {
      user: alice,
      pageId: 'pg_1',
      how: 'approved',
      inviteId: null,
      before: false,
      joinedAt: 1_000_000,
      leftAt: 1_050_000,
      ended: 'left',
      roles: [{ at: 1_000_000, role: 'driver' }],
      rolesDropped: 0,
    };
    const findings = (more: Partial<SessionRecord>): string[] =>
      matchSessionRecord(SessionRecordSchema.parse(recordOf([], more)), lines)
        .findings.filter((finding) => finding.kind === 'window')
        .map((finding) => finding.text);
    expect(findings({ attachments: [span] })).toEqual([]);
    for (const changed of [
      { ...span, joinedAt: 900_000, roles: [{ at: 900_000, role: 'driver' as const }] },
      { ...span, leftAt: 990_000 },
      { ...span, leftAt: 1_200_000 },
      { ...span, roles: [...span.roles, { at: 1_200_000, role: 'observer' as const }] },
    ]) {
      expect(findings({ attachments: [changed] })).toEqual([
        'Alice (alice), who joined at 1970-01-01T00:' +
          (changed.joinedAt === 900_000 ? '15:00.000Z' : '16:40.000Z') +
          ", has times outside the record's span",
      ]);
    }
    const proposal: Proposal = {
      proposalId: 'pr_1',
      pageId: 'pg_1',
      at: 1_000_000,
      user: alice,
      tool: 'set_view',
      status: 'dismissed',
      decidedAt: 1_200_000,
      callId: null,
    };
    expect(findings({ proposals: [proposal] })).toEqual([
      "proposal pr_1 at 1970-01-01T00:16:40.000Z has times outside the record's span",
    ]);
    expect(
      findings({ proposals: [{ ...proposal, at: 1_200_000, decidedAt: null, status: 'pending' }] }),
    ).toHaveLength(1);
    // A proposal still pending when the record began was made before it.
    expect(findings({ proposals: [{ ...proposal, at: 900_000, decidedAt: 1_010_000 }] })).toEqual(
      [],
    );
    expect(
      findings({ dropped: { ...EMPTY_DROPPED, calls: 1, firstAt: 900_000, lastAt: 900_000 } }),
    ).toEqual(["the calls the record's cap dropped have times outside its span"]);
  });

  it('fails a record that lists a call or a proposal twice', async () => {
    const dir = await writeLog(sixty());
    const base = recordOf([]);
    const [, , , , , , , , , , tenth] = base.calls;
    if (tenth === undefined) throw new Error('no call');
    const twice = match({ ...base, calls: [...base.calls, tenth] }, dir);
    expect(twice.code).toBe(1);
    expect(twice.out).toEqual(['FAIL repeated: call c_10 is listed more than once in the record']);
  });

  it('notes a call the record lacks whose invoke may never have arrived, and one at its edge', async () => {
    const dir = await writeLog(
      sixty((n) =>
        n === 30 ? { outcome: 'page_asleep' } : n === 31 ? { outcome: 'page_gone' } : {},
      ),
    );
    const result = match(recordOf([30, 31]), dir);
    expect(result.code, result.out.join('\n')).toBe(0);
    expect(result.out).toEqual([
      expect.stringMatching(
        /^note explained: call c_30 .* ended page_asleep, so its invoke may never have arrived$/,
      ),
      expect.stringMatching(/^note explained: call c_31 .* ended page_gone/),
    ]);
    // A record that ends as the last call starts may have missed it honestly.
    const edge = match(recordOf([59], { to: 1_000_000 + 59_000 }), dir);
    expect(edge.code).toBe(0);
    expect(edge.out).toContainEqual(
      expect.stringMatching(
        /^note edge: call c_59 .* may have reached the page just outside the record$/,
      ),
    );
  });

  it('explains a call with no line inside an audit_gap or before the log begins, and fails one with neither', async () => {
    const gap: AuditEvent = {
      v: AUDIT_VERSION,
      type: 'audit_gap',
      at: 1_100_000,
      lost: 3,
      firstAt: 1_030_000,
      lastAt: 1_032_000,
    };
    const lines = sixty().filter((_, n) => n < 30 || n > 32);
    const dir = await writeLog([...lines.slice(5), gap]);
    const result = match(recordOf([]), dir);
    expect(result.code, result.out.join('\n')).toBe(0);
    expect(result.out.filter((line) => line.includes('audit_gap'))).toHaveLength(3);
    expect(
      result.out.filter((line) => line.includes("before the log's first record")),
    ).toHaveLength(5);
    const shorter = await writeLog(lines.slice(5, -1));
    expect(match(recordOf([]), shorter).out).toContainEqual(
      expect.stringMatching(/^FAIL missing: call c_59 /),
    );
  });

  it("matches an invitee by short id, whatever ~n the record added, and no one else's", async () => {
    const dir = await writeLog(sixty((n) => (n === 7 ? { userId: GUEST_ID } : {})));
    const as = (user: Person) =>
      recordOf([], {
        calls: recordOf([]).calls.map((call, n) => (n === 7 ? { ...call, user } : call)),
      });
    expect(match(as(guest), dir).code).toBe(0);
    expect(match(as({ ...guest, id: 'g_0123abcd~2' }), dir).code).toBe(0);
    expect(match(as({ ...guest, id: 'g_0123abce' }), dir).code).toBe(1);
    expect(
      match(as({ id: 'g_0123abcd', name: 'x', kind: 'invitee' }), await writeLog(sixty())).code,
    ).toBe(1);
  });

  it('matches a proposal to the line that made it and its accepted run, and fails one the log does not bear out', async () => {
    // Making a proposal sends no invoke, so its line has no callId (ADR 0042).
    const made = callLine(
      70,
      { outcome: 'proposed', proposalId: 'pr_1', tool: 'go_to_stop', userId: GUEST_ID },
      null,
    );
    const ran = callLine(71, {
      proposalId: 'pr_1',
      acceptedOnPage: true,
      tool: 'go_to_stop',
      userId: GUEST_ID,
    });
    const dir = await writeLog([...sixty(), made, ran]);
    const proposal = {
      proposalId: 'pr_1',
      pageId: 'pg_1',
      at: 1_070_020,
      user: guest,
      tool: 'go_to_stop',
      status: 'accepted' as const,
      decidedAt: 1_071_000,
      callId: 'c_71',
    };
    const run71 = recordCall(71, {
      user: guest,
      tool: 'go_to_stop',
      proposalId: 'pr_1',
      confirmedBy: 'page',
    });
    const base = recordOf([]);
    const good = match({ ...base, calls: [...base.calls, run71], proposals: [proposal] }, dir);
    expect(good.code, good.out.join('\n')).toBe(0);
    const otherTool = match(
      { ...base, calls: [...base.calls, run71], proposals: [{ ...proposal, tool: 'wipe' }] },
      dir,
    );
    expect(otherTool.code).toBe(1);
    expect(otherTool.out).toEqual([
      expect.stringMatching(
        /^FAIL conflict: proposal pr_1 .*: the line that made it names another page, tool or user$/,
      ),
      expect.stringMatching(
        /^FAIL conflict: proposal pr_1 .*: the line that ended it names another page, tool or user$/,
      ),
    ]);
    const invented = match(
      {
        ...base,
        proposals: [{ ...proposal, proposalId: 'pr_9', status: 'dismissed', callId: null }],
      },
      dir,
    );
    expect(invented.code).toBe(1);
    expect(invented.out).toContainEqual(expect.stringMatching(/^FAIL missing: proposal pr_9 /));
  });

  it('fails a proposal whose end the record changed, or that it left out', async () => {
    const proposed = (n: number, id: string): CallEvent =>
      callLine(
        n,
        { outcome: 'proposed', proposalId: id, tool: 'go_to_stop', userId: GUEST_ID },
        null,
      );
    const closedLine = (n: number, id: string, reason: ClosedEvent['reason']): ClosedEvent => ({
      v: AUDIT_VERSION,
      type: 'proposal_closed',
      at: 1_000_000 + n * 1_000,
      pageId: 'pg_1',
      origin: 'http://localhost:5173',
      proposalId: id,
      userId: GUEST_ID,
      tool: 'go_to_stop',
      reason,
    });
    const ran = callLine(71, {
      proposalId: 'pr_1',
      acceptedOnPage: true,
      tool: 'go_to_stop',
      userId: GUEST_ID,
    });
    const dir = await writeLog([
      ...sixty(),
      proposed(70, 'pr_1'),
      ran,
      proposed(72, 'pr_2'),
      closedLine(73, 'pr_2', 'dismissed'),
      proposed(74, 'pr_3'),
      closedLine(75, 'pr_3', 'expired'),
      proposed(76, 'pr_4'),
      closedLine(77, 'pr_4', 'refused'),
    ]);
    const made = (n: number, id: string, more: Partial<Proposal>): Proposal => ({
      proposalId: id,
      pageId: 'pg_1',
      at: 1_000_000 + n * 1_000 + 20,
      user: guest,
      tool: 'go_to_stop',
      status: 'dismissed',
      decidedAt: 1_000_000 + (n + 1) * 1_000,
      callId: null,
      ...more,
    });
    const accepted = made(70, 'pr_1', { status: 'accepted', callId: 'c_71' });
    const dismissed = made(72, 'pr_2', {});
    // The relay expired it as the operator dismissed it: a race, so a note.
    const raced = made(74, 'pr_3', {});
    const run71 = recordCall(71, {
      user: guest,
      tool: 'go_to_stop',
      proposalId: 'pr_1',
      confirmedBy: 'page',
    });
    const base = recordOf([]);
    const record = (proposals: Proposal[]): SessionRecord => ({
      ...base,
      calls: [...base.calls, run71],
      proposals,
    });
    // The page refused pr_4 as it arrived, so a record may lack it.
    const genuine = match(record([accepted, dismissed, raced]), dir);
    expect(genuine.code, genuine.out.join('\n')).toBe(0);
    expect(genuine.out).toEqual([
      expect.stringMatching(
        /^note outcome: proposal pr_3 .*: the page saw dismissed, the relay closed it as expired$/,
      ),
      expect.stringMatching(
        /^note explained: proposal pr_4 .* was refused by the page as it arrived$/,
      ),
    ]);

    const fails = (proposals: Proposal[], ...expected: RegExp[]): void => {
      const result = match(record(proposals), dir);
      expect(result.code).toBe(1);
      for (const line of expected) expect(result.out).toContainEqual(expect.stringMatching(line));
    };
    fails(
      [{ ...accepted, status: 'dismissed', callId: null }, dismissed, raced],
      /^FAIL conflict: proposal pr_1 .*: the record has it dismissed, and the log ran it$/,
      /^FAIL conflict: call c_71 ran proposal pr_1, which the record has dismissed$/,
    );
    fails(
      [{ ...accepted, callId: null }, dismissed, raced],
      /^FAIL conflict: proposal pr_1 .*: the line that ran it carries another callId than the record's$/,
    );
    fails(
      [accepted, { ...dismissed, status: 'accepted' }, raced],
      /^FAIL conflict: proposal pr_2 .*: the record has it accepted, and the log closed it as dismissed$/,
    );
    fails(
      [accepted, { ...dismissed, status: 'expired' }, raced],
      /^FAIL conflict: proposal pr_2 .*: the record has it expired, and the log closed it as dismissed$/,
    );
    fails(
      [accepted, raced],
      /^FAIL unrecorded: proposal pr_2 .* is in the log within the record's span, and not in the record$/,
    );
    fails(
      [accepted, dismissed, raced, dismissed],
      /^FAIL repeated: proposal pr_2 is listed more than once in the record$/,
    );
  });

  it('notes a join with no attach line, and prints what the file wrote escaped', async () => {
    const dir = await writeLog(sixty());
    const mallory: Person = { id: 'mallory', name: 'Mal\u202elory\u001b[31m', kind: 'member' };
    const result = match(
      recordOf([], {
        attachments: [
          {
            user: mallory,
            pageId: 'pg_1',
            how: 'approved',
            inviteId: null,
            before: false,
            joinedAt: 1_000_000,
            leftAt: null,
            ended: null,
            roles: [{ at: 1_000_000, role: 'observer' }],
            rolesDropped: 0,
          },
        ],
      }),
      dir,
      '--json',
    );
    expect(result.code).toBe(0);
    expect(result.out).toHaveLength(1);
    expect(result.out[0]).not.toContain('\u202e');
    expect(result.out[0]).not.toContain('\u001b');
    expect(result.out[0]).toContain('Mal\\u202elory\\u001b[31m');
    expect(JSON.parse(result.out[0] ?? '{}')).toMatchObject({
      level: 'note',
      kind: 'attachment',
      text: expect.stringContaining('Mal\u202elory') as unknown,
    });
  });

  it('fails a record with no call the log can place, rather than calling it a match', async () => {
    const dir = await writeLog(sixty());
    const result = match(sessionRecord({ from: 0, to: 5_000_000 }), dir);
    expect(result.code).toBe(1);
    expect(result.out).toEqual([
      "FAIL unplaced: no call or proposal in the record has a line, so 60 lines for its pages cannot be placed on the page's clock, and the record cannot be shown to hold them",
    ]);
    expect(result.err.at(-1)).toMatch(
      /^match: FAILED; .*60 that cannot be placed\), no call matched/,
    );
    // A record of another page's session says nothing of this one's lines.
    expect(match(sessionRecord({ pageIds: ['pg_2'], from: 0, to: 5_000_000 }), dir).code).toBe(0);
  });

  it('fails a running call with no line once the log goes on past its deadline', async () => {
    const dir = await writeLog(sixty());
    const base = recordOf([]);
    const running = (n: number): SessionRecord => ({
      ...base,
      calls: [
        ...base.calls,
        recordCall(n, { callId: 'c_forged', outcome: 'running', durationMs: null }),
      ],
    });
    // Saved as it began, a second before the log's last line: its line may come yet.
    const late = match(running(58), dir);
    expect(late.code, late.out.join('\n')).toBe(0);
    expect(late.out).toEqual([
      expect.stringMatching(/^note running: call c_forged .* has no line yet$/),
    ]);
    // Begun a minute before the log's last line, which the relay wrote after it must have answered.
    const forged = match(running(0), dir);
    expect(forged.code).toBe(1);
    expect(forged.out).toEqual([
      expect.stringMatching(
        /^FAIL missing: call c_forged .* although the log goes on past when the relay must have answered it$/,
      ),
    ]);
  });

  it('never explains a call before the log began when the record says it was outside its own span', async () => {
    const dir = await writeLog(sixty().slice(5));
    const base = recordOf([0, 1, 2, 3, 4]);
    const early = match(
      { ...base, calls: [recordCall(0, { callId: 'c_early', at: 1_000 }), ...base.calls] },
      dir,
    );
    expect(early.code).toBe(1);
    expect(early.out).toContainEqual(
      expect.stringMatching(/^FAIL window: call c_early at .* lies outside the record's span$/),
    );
    // A proposal still pending when a record began may predate it, but a record
    // that began after the log did cannot blame the log for missing its line.
    const later = recordOf([0, 1, 2, 3, 4, 5], {
      from: 1_006_000,
      proposals: [
        {
          proposalId: 'pr_old',
          pageId: 'pg_1',
          at: 1_001_020,
          user: guest,
          tool: 'go_to_stop',
          status: 'pending',
          decidedAt: null,
          callId: null,
        },
      ],
    });
    const blamed = match(later, dir);
    expect(blamed.code).toBe(1);
    expect(blamed.out).toContainEqual(
      expect.stringMatching(
        /^FAIL missing: proposal pr_old .* is in the record, and no line made it$/,
      ),
    );
  });

  it('prints a time past what a date holds as a number, never throwing', async () => {
    const dir = await writeLog(sixty());
    const far = 9_000_000_000_000_000;
    const result = match(
      sessionRecord({ from: 0, to: far, calls: [recordCall(0, { callId: 'c_far', at: far })] }),
      dir,
    );
    expect(result.code).toBe(1);
    expect(result.out).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^FAIL missing: call c_far \\(set_view by Alice \\(alice\\) at ${String(far)} ms\\)`,
        ),
      ),
    );
  });
});

describe('audit --match refusals', () => {
  it('refuses a file larger than any record before reading a byte of it', async () => {
    const dir = await writeLog(sixty());
    const big = join(scratch(), 'big.json');
    writeFileSync(big, '');
    truncateSync(big, SESSION_RECORD_MAX_BYTES + 1);
    const result = run(['--match', big, '--dir', dir]);
    expect(result.code).toBe(2);
    expect(result.err).toEqual([
      `the file --match gives is larger than any session record (${String(SESSION_RECORD_MAX_BYTES)} bytes)`,
    ]);
    expect(vi.mocked(readFileSync).mock.calls.some(([path]) => path === big)).toBe(false);
  });

  it('refuses a file that is no record, or of another version, never naming the path it was given', async () => {
    const dir = await writeLog(sixty());
    const secret = 'tabdock-secret-pasted-here';
    const folder = join(scratch(), secret);
    const cases: [string, string, RegExp][] = [
      ['not json', '{', /^the file --match gives is not a Tabdock session record \(not JSON\)$/],
      [
        'another shape',
        JSON.stringify({ [secret]: 1, format: 'other' }),
        /^the file --match gives is not a Tabdock session record \(/,
      ],
      [
        'another version',
        JSON.stringify({ ...recordOf([]), v: 2 }),
        /^the file --match gives is a session record of another version; this reader takes version 1$/,
      ],
    ];
    for (const [name, text, message] of cases) {
      const file = join(scratch(), `${secret}-${name.replace(' ', '-')}.json`);
      writeFileSync(file, text);
      const result = run(['--match', file, '--dir', dir]);
      expect(result.code, name).toBe(2);
      expect(result.err, name).toEqual([expect.stringMatching(message)]);
      expect(result.err.join('\n'), name).not.toContain(secret);
    }
    const missing = run(['--match', join(folder, 'none.json'), '--dir', dir]);
    expect(missing.err).toEqual(['cannot read the file --match gives (ENOENT)']);
    const directory = run(['--match', scratch(), '--dir', dir]);
    expect(directory.err).toEqual(['the file --match gives is not a file']);
  });

  it('takes no filter beside --match', async () => {
    const dir = await writeLog(sixty());
    const file = join(scratch(), 'record.json');
    writeFileSync(file, encodeSessionRecord(recordOf([])));
    for (const filter of [
      ['--user', 'alice'],
      ['--page', 'pg_1'],
      ['--type', 'call'],
      ['--outcome', 'ok'],
      ['--call', 'c_1'],
      ['--since', '1h'],
      ['--until', '1h'],
    ]) {
      const result = run(['--match', file, '--dir', dir, ...filter]);
      expect(result.code, filter[0]).toBe(2);
      expect(result.err, filter[0]).toEqual([
        'with --match the reader takes only --dir, --verify, --checkpoint and --json',
      ]);
    }
    expect(run(['--match', file, '--dir', dir, '--json']).code).toBe(0);
  });

  it('finds every call missing from a log that holds none', () => {
    expect(matchSessionRecord(recordOf([]), [])).toMatchObject({
      failed: true,
      matched: 0,
      missing: 60,
      skewMs: null,
    });
  });
});

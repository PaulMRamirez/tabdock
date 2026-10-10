// ADR 0045's session record: a full record parses; every object in it is
// strict, so a key added at any level (an argument or a result among them)
// makes it no record; every cap and rule refuses one past it; and a reason
// for refusing a file never repeats what the file held.

import { describe, expect, it } from 'vitest';
import {
  encodeSessionRecord,
  parseSessionRecord,
  SESSION_RECORD_MAX_ATTACHMENTS,
  SESSION_RECORD_MAX_BYTES,
  SESSION_RECORD_MAX_CALLS,
  SESSION_RECORD_MAX_DROPPED_USERS,
  SESSION_RECORD_MAX_PAGE_IDS,
  SESSION_RECORD_MAX_PROPOSALS,
  SESSION_RECORD_MAX_ROLE_CHANGES,
  SESSION_RECORD_VERSION,
  SessionRecordSchema,
} from './index.ts';

const alice = { id: 'alice', name: 'Alice', kind: 'member' };
const guest = { id: 'g_0123abcd', name: 'guest@example.com', kind: 'invitee' };

const call = {
  callId: 'c_1',
  pageId: 'pg_1',
  at: 1_100,
  user: alice,
  client: 'claude-code 2.1.288',
  tool: 'set_view',
  outcome: 'ok',
  durationMs: 12,
  confirmedBy: 'page',
  proposalId: null,
};

const attachment = {
  user: guest,
  pageId: 'pg_1',
  how: 'invite',
  inviteId: 'inv_1',
  before: false,
  joinedAt: 1_050,
  leftAt: 1_900,
  ended: 'session_ended',
  roles: [{ at: 1_050, role: 'observer' }],
  rolesDropped: 0,
};

const proposal = {
  proposalId: 'pr_1',
  pageId: 'pg_1',
  at: 1_200,
  user: guest,
  tool: 'go_to_stop',
  status: 'accepted',
  decidedAt: 1_250,
  callId: 'c_2',
};

const scope = {
  kind: 'session',
  sessionId: 'ss_1',
  label: 'Period 3',
  startedAt: 1_000,
  endsAt: 3_001_000,
  endedAt: 2_000,
  endedBy: 'operator',
  maxDrivers: 1,
  proposals: 'all',
  observers: 35,
  invites: 2,
};

const dropped = {
  calls: 0,
  attachments: 0,
  proposals: 0,
  firstAt: null,
  lastAt: null,
  byUser: [],
  otherCalls: 0,
};

const record = {
  format: 'tabdock.session-record',
  v: 1,
  adapterVersion: '0.1.0',
  exportedAt: 2_100,
  page: { origin: 'https://maps.example', path: '/lesson', title: 'Plate tectonics' },
  relay: 'relay.example',
  policy: {
    autoApprove: 'none',
    maxDrivers: 1,
    consequential: 'confirm',
    consequentialTools: ['reset_edits'],
    invites: 'watch',
    confirmVia: 'page',
    imageTools: ['capture_view'],
    proposals: 'all',
  },
  pageIds: ['pg_1'],
  scope,
  from: 1_000,
  to: 2_000,
  sealed: true,
  attachments: [attachment],
  calls: [call],
  proposals: [proposal],
  dropped,
};

function parses(value: unknown): boolean {
  return SessionRecordSchema.safeParse(value).success;
}

describe('a session record', () => {
  it('parses whole, and reads back from its file', () => {
    expect(SESSION_RECORD_VERSION).toBe(1);
    expect(SessionRecordSchema.parse(record)).toEqual(record);
    const parsed = parseSessionRecord(encodeSessionRecord(SessionRecordSchema.parse(record)));
    expect(parsed).toEqual({ ok: true, record });
    expect(encodeSessionRecord(SessionRecordSchema.parse(record))).toContain('\n  "format"');
    expect(parses({ ...record, scope: { kind: 'page' } })).toBe(true);
  });

  it('refuses a key added at any level', () => {
    for (const [where, value] of [
      ['record', { ...record, extra: 1 }],
      ['call', { ...record, calls: [{ ...call, extra: 1 }] }],
      ['attachment', { ...record, attachments: [{ ...attachment, extra: 1 }] }],
      [
        'role',
        { ...record, attachments: [{ ...attachment, roles: [{ at: 1, role: null, extra: 1 }] }] },
      ],
      ['proposal', { ...record, proposals: [{ ...proposal, extra: 1 }] }],
      ['scope', { ...record, scope: { ...scope, extra: 1 } }],
      ['page scope', { ...record, scope: { kind: 'page', extra: 1 } }],
      ['person', { ...record, calls: [{ ...call, user: { ...alice, extra: 1 } }] }],
      ['page', { ...record, page: { ...record.page, query: '?x' } }],
      ['dropped', { ...record, dropped: { ...dropped, extra: 1 } }],
    ] as const) {
      expect(parses(value), where).toBe(false);
    }
  });

  it("never holds a call's arguments or result, or a proposal's arguments", () => {
    expect(parses({ ...record, calls: [{ ...call, arguments: { label: 'x' } }] })).toBe(false);
    expect(parses({ ...record, calls: [{ ...call, result: 'page output' }] })).toBe(false);
    expect(
      parses({ ...record, calls: [{ ...call, image: { mimeType: 'image/png', bytes: 1 } }] }),
    ).toBe(false);
    expect(parses({ ...record, proposals: [{ ...proposal, arguments: { stop: 3 } }] })).toBe(false);
  });

  it('refuses more than its caps hold', () => {
    const many = <T>(count: number, make: (index: number) => T): T[] =>
      Array.from({ length: count }, (_, index) => make(index));
    const calls = (count: number): unknown[] =>
      many(count, (i) => ({ ...call, callId: `c_${String(i)}` }));
    expect(parses({ ...record, calls: calls(SESSION_RECORD_MAX_CALLS) })).toBe(true);
    expect(parses({ ...record, calls: calls(SESSION_RECORD_MAX_CALLS + 1) })).toBe(false);
    const spans = (count: number): unknown[] => many(count, () => attachment);
    expect(parses({ ...record, attachments: spans(SESSION_RECORD_MAX_ATTACHMENTS) })).toBe(true);
    expect(parses({ ...record, attachments: spans(SESSION_RECORD_MAX_ATTACHMENTS + 1) })).toBe(
      false,
    );
    const proposals = (count: number): unknown[] => many(count, () => proposal);
    expect(parses({ ...record, proposals: proposals(SESSION_RECORD_MAX_PROPOSALS) })).toBe(true);
    expect(parses({ ...record, proposals: proposals(SESSION_RECORD_MAX_PROPOSALS + 1) })).toBe(
      false,
    );
    const pageIds = (count: number): string[] => [
      'pg_1',
      ...many(count - 1, (i) => `pg_x${String(i)}`),
    ];
    expect(parses({ ...record, pageIds: pageIds(SESSION_RECORD_MAX_PAGE_IDS) })).toBe(true);
    expect(parses({ ...record, pageIds: pageIds(SESSION_RECORD_MAX_PAGE_IDS + 1) })).toBe(false);
    expect(parses({ ...record, pageIds: [] })).toBe(false);
    const roles = (count: number): unknown[] => many(count, (i) => ({ at: i, role: 'observer' }));
    const withRoles = (count: number): unknown => ({
      ...record,
      attachments: [{ ...attachment, roles: roles(count) }],
    });
    expect(parses(withRoles(SESSION_RECORD_MAX_ROLE_CHANGES))).toBe(true);
    expect(parses(withRoles(SESSION_RECORD_MAX_ROLE_CHANGES + 1))).toBe(false);
    expect(parses(withRoles(0))).toBe(false);
    const byUser = (count: number): unknown => ({
      ...record,
      dropped: { ...dropped, byUser: many(count, () => ({ user: 'alice', counts: { ok: 2 } })) },
    });
    expect(parses(byUser(SESSION_RECORD_MAX_DROPPED_USERS))).toBe(true);
    expect(parses(byUser(SESSION_RECORD_MAX_DROPPED_USERS + 1))).toBe(false);
  });

  it("names an invitee by its short id only, and no member by an invitee's", () => {
    const withUser = (user: unknown): unknown => ({ ...record, calls: [{ ...call, user }] });
    expect(parses(withUser(guest))).toBe(true);
    expect(parses(withUser({ ...guest, id: 'g_0123abcd~2' }))).toBe(true);
    for (const bad of [
      { ...guest, id: `g_${'0123abcd'.repeat(4)}` },
      { ...guest, id: 'g_0123abc' },
      { ...guest, id: 'g_0123abcd~0' },
      { ...guest, id: 'alice' },
      { ...alice, id: 'g_0123abcd' },
      { ...alice, id: 'g_member' },
      { ...alice, name: '' },
      { ...alice, name: 'x'.repeat(101) },
    ]) {
      expect(parses(withUser(bad)), JSON.stringify(bad)).toBe(false);
    }
  });

  it('holds each entry to its own rules', () => {
    for (const [what, value] of [
      ['a running call with a duration', { ...record, calls: [{ ...call, outcome: 'running' }] }],
      ['a finished call without one', { ...record, calls: [{ ...call, durationMs: null }] }],
      [
        'a confirmation by anyone else',
        { ...record, calls: [{ ...call, confirmedBy: 'operator' }] },
      ],
      ['an outcome no page reports', { ...record, calls: [{ ...call, outcome: 'proposed' }] }],
      [
        'an accepted proposal without its decision',
        { ...record, proposals: [{ ...proposal, decidedAt: null }] },
      ],
      [
        'a pending proposal with a call',
        { ...record, proposals: [{ ...proposal, status: 'pending', decidedAt: null }] },
      ],
      [
        'a dismissed proposal with a call',
        { ...record, proposals: [{ ...proposal, status: 'dismissed' }] },
      ],
      [
        'a span that left without saying how',
        { ...record, attachments: [{ ...attachment, ended: null }] },
      ],
      [
        'an invite span without its invite',
        { ...record, attachments: [{ ...attachment, inviteId: null }] },
      ],
      [
        'an approved span naming an invite',
        { ...record, attachments: [{ ...attachment, how: 'approved' }] },
      ],
      ['an entry on another page', { ...record, calls: [{ ...call, pageId: 'pg_2' }] }],
      ['an end before the start', { ...record, from: 3_000 }],
      ['another format', { ...record, format: 'tabdock.audit' }],
      ['another version', { ...record, v: 2 }],
    ] as const) {
      expect(parses(value), what).toBe(false);
    }
    const running = { ...call, outcome: 'running', durationMs: null };
    expect(parses({ ...record, calls: [running] })).toBe(true);
    const pending = { ...proposal, status: 'pending', decidedAt: null, callId: null };
    expect(parses({ ...record, proposals: [pending] })).toBe(true);
  });

  it("names its scope as ADR 0043 does, ended by the adapter's four reasons", () => {
    for (const endedBy of ['operator', 'time', 'page_gone', 'relay', null]) {
      expect(parses({ ...record, scope: { ...scope, endedBy } }), String(endedBy)).toBe(true);
    }
    for (const bad of [
      { ...scope, endedBy: 'page_closed' },
      { ...scope, endedBy: 'ended' },
      { ...scope, observers: 101 },
      { ...scope, invites: 11 },
      { ...scope, maxDrivers: 101 },
      { ...scope, proposals: 'some' },
      { ...scope, label: '' },
      { kind: 'session', sessionId: 'ss_1', plannedEndAt: 3_001_000 },
    ]) {
      expect(parses({ ...record, scope: bad }), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('parseSessionRecord', () => {
  it('says why a file is no record without repeating anything it held', () => {
    const marker = 'secretmarker';
    for (const value of [
      { ...record, [marker]: 1 },
      { ...record, calls: [{ ...call, user: { ...alice, name: 7 }, [marker]: marker }] },
      { ...record, dropped: { ...dropped, byUser: [{ user: 'alice', counts: { [marker]: 1 } }] } },
      { ...record, scope: { ...scope, label: marker.repeat(10) } },
      { ...record, relay: marker.repeat(40) },
    ]) {
      const parsed = parseSessionRecord(JSON.stringify(value));
      expect(parsed.ok).toBe(false);
      expect(JSON.stringify(parsed)).not.toContain(marker);
    }
    expect(parseSessionRecord('not json')).toEqual({ ok: false, reason: 'not JSON' });
  });

  it('refuses a text past the file cap before parsing it', () => {
    expect(SESSION_RECORD_MAX_BYTES).toBe(8 * 1024 * 1024);
    const parsed = parseSessionRecord(' '.repeat(SESSION_RECORD_MAX_BYTES + 1));
    expect(parsed).toEqual({ ok: false, reason: 'larger than 8388608 bytes' });
  });
});

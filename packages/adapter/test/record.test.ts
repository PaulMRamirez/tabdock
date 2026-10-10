// ADR 0045's recorder on synthetic events, before the core calls it (W3-A
// wires it): every call it is told of up to 5,000, the oldest then dropped and
// counted by person and outcome; attachment spans that open, change role and
// close as left, revoked, page_session_ended or session_ended; where a call
// was confirmed; proposals without their arguments; the current, previous and
// ended records a new page session, a time-boxed session and its end make;
// and a snapshot the protocol's strict schema checks, which names an invitee
// by short id and never holds an argument, a result or a secret.

import {
  type AttachmentView,
  PolicySchema,
  SESSION_RECORD_MAX_ATTACHMENTS,
  SESSION_RECORD_MAX_CALLS,
  SESSION_RECORD_MAX_DROPPED_USERS,
  SESSION_RECORD_MAX_PAGE_IDS,
  SESSION_RECORD_MAX_PROPOSALS,
  SESSION_RECORD_MAX_ROLE_CHANGES,
  SessionRecordSchema,
  type User,
} from '@tabdock/protocol';
import { describe, expect, it } from 'vitest';
import type {
  ActivityEntry,
  PageRole,
  PendingProposal,
  ProposalLogEntry,
  SessionView,
} from '../src/core.ts';
import { sessionRecordJson, sessionRecordMarkdown } from '../src/record-markdown.ts';
import {
  createRecorder,
  type RecordContext,
  type Recorder,
  type RecordWayIn,
} from '../src/record.ts';

const CONTEXT: RecordContext = {
  adapterVersion: '0.1.0',
  origin: 'https://board.example',
  path: '/lesson',
  title: 'Board',
  relay: 'relay.example',
  policy: PolicySchema.parse({ proposals: 'all' }),
};

const alice: User = { userId: 'alice', displayName: 'Alice' };
const bob: User = { userId: 'bob', displayName: 'Bob' };
/** An invitee's full id: g_ and a 32 hex account key, which no record may hold. */
const GUEST_KEY = `g_0123abcd${'e'.repeat(24)}`;
const guest: User = { userId: GUEST_KEY, displayName: 'guest@example.com' };

function entry(
  callId: string,
  user: User = alice,
  more: Partial<ActivityEntry> = {},
): ActivityEntry {
  return {
    callId,
    time: 1_000,
    user,
    client: { name: 'claude-code', version: '2.1.288' },
    tool: 'set_view',
    outcome: 'running',
    confirmedBy: null,
    durationMs: null,
    handlerRunning: false,
    image: null,
    proposalId: null,
    acceptedOnPage: false,
    ...more,
  };
}

function view(
  user: User,
  role: 'driver' | 'observer' = 'driver',
  inviteId: string | null = null,
): AttachmentView {
  return {
    ...user,
    kind: user.userId.startsWith('g_') ? 'invitee' : 'member',
    role,
    grantedAt: 0,
    lastUsedAt: null,
    expiresAt: null,
    clients: [],
    inviteId,
    endsAt: inviteId === null ? null : 99_000_000,
  };
}

function pageRole(user: User, role: PageRole['role']): PageRole {
  return { userId: user.userId, role, revoked: false, inviteRole: null };
}

/** How the page let each one in: an invite when the roster says one made the attachment. */
function wayIn(attachments: readonly AttachmentView[]) {
  return (userId: string): RecordWayIn => {
    const inviteId = attachments.find((attachment) => attachment.userId === userId)?.inviteId;
    return inviteId ? { how: 'invite', inviteId } : { how: 'approved', inviteId: null };
  };
}

function roster(recorder: Recorder, at: number, ...attachments: AttachmentView[]): void {
  recorder.roster(
    attachments,
    attachments.map((attachment) => pageRole(attachment, attachment.role)),
    wayIn(attachments),
    at,
  );
}

/** A snapshot that must exist, checked once more against the protocol's schema. */
function snap(recorder: Recorder, which: 'current' | 'previous' | 'ended' = 'current', at = 9_000) {
  const record = recorder.snapshot(which, CONTEXT, at);
  if (record === null) throw new Error(`no ${which} record`);
  expect(SessionRecordSchema.parse(record)).toEqual(record);
  return record;
}

function session(more: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: 'ss_1',
    label: 'Period 3',
    startedAt: 5_000,
    endsAt: 5_000 + 30 * 60_000,
    lengthMinutes: 30,
    policy: PolicySchema.parse({ maxDrivers: 2, proposals: 'all' }),
    observers: 35,
    inviteIds: ['inv_watch'],
    sponsor: alice,
    ...more,
  };
}

describe('the recorder (ADR 0045)', () => {
  it('holds nothing before the first welcome, then the page session it names', () => {
    const recorder = createRecorder();
    expect(recorder.views()).toEqual([]);
    expect(recorder.snapshot('current', CONTEXT, 1)).toBeNull();
    expect(recorder.call(entry('c_0'), 'pg_1')).toBeNull();

    recorder.pageSession('pg_1', false, 100);
    const record = snap(recorder);
    expect(record).toMatchObject({
      format: 'tabdock.session-record',
      v: 1,
      adapterVersion: '0.1.0',
      exportedAt: 9_000,
      page: { origin: 'https://board.example', path: '/lesson', title: 'Board' },
      relay: 'relay.example',
      pageIds: ['pg_1'],
      scope: { kind: 'page' },
      from: 100,
      to: 9_000,
      sealed: false,
      attachments: [],
      calls: [],
      proposals: [],
    });
    expect(record.policy.proposals).toBe('all');
    expect(Object.isFrozen(record)).toBe(true);
  });

  it('keeps every call it is told of with its final outcome, each update reaching its own call', () => {
    const recorder = createRecorder();
    recorder.pageSession('pg_1', false, 100);
    const handles = Array.from({ length: 120 }, (_, n) =>
      recorder.call(entry(`c_${String(n)}`, alice, { time: 1_000 + n }), 'pg_1'),
    );
    // Settled out of order, the first among them long after 50 newer calls came.
    for (const [n, handle] of [...handles.entries()].reverse()) {
      recorder.update(
        handle,
        entry(`c_${String(n)}`, alice, { outcome: n % 2 ? 'ok' : 'tool_error', durationMs: n }),
      );
    }
    const { calls } = snap(recorder);
    expect(calls).toHaveLength(120);
    expect(calls.map((call) => call.callId)).toEqual(handles.map((_, n) => `c_${String(n)}`));
    expect(calls[0]).toEqual({
      callId: 'c_0',
      pageId: 'pg_1',
      at: 1_000,
      user: { id: 'alice', name: 'Alice', kind: 'member' },
      client: 'claude-code 2.1.288',
      tool: 'set_view',
      outcome: 'tool_error',
      durationMs: 0,
      confirmedBy: null,
      proposalId: null,
    });
    expect(calls[119]).toMatchObject({ outcome: 'ok', durationMs: 119 });
  });

  it('keeps the newest 5,000 calls and counts the rest by person and outcome', () => {
    const recorder = createRecorder();
    recorder.pageSession('pg_1', false, 100);
    const total = SESSION_RECORD_MAX_CALLS + 10;
    const handles: (number | null)[] = [];
    for (let n = 0; n < total; n++) {
      const who = n % 2 === 0 ? alice : guest;
      const done = n < 6 ? { outcome: 'ok' as const, durationMs: 1 } : {};
      handles.push(
        recorder.call(entry(`c_${String(n)}`, who, { time: 1_000 + n, ...done }), 'pg_1'),
      );
    }
    // A call the cap pushed out stays as it was counted; one still held settles.
    recorder.update(
      handles[0] ?? null,
      entry('c_0', alice, { outcome: 'tool_error', durationMs: 5 }),
    );
    recorder.update(handles[10] ?? null, entry('c_10', alice, { outcome: 'ok', durationMs: 5 }));
    const record = snap(recorder);
    expect(record.calls).toHaveLength(SESSION_RECORD_MAX_CALLS);
    expect(record.calls[0]).toMatchObject({ callId: 'c_10', outcome: 'ok', durationMs: 5 });
    expect(record.calls.at(-1)?.callId).toBe(`c_${String(total - 1)}`);
    expect(record.dropped).toEqual({
      calls: 10,
      attachments: 0,
      proposals: 0,
      firstAt: 1_000,
      lastAt: 1_009,
      byUser: [
        { user: 'alice', counts: { ok: 3, running: 2 } },
        { user: 'g_0123abcd', counts: { ok: 3, running: 2 } },
      ],
      otherCalls: 0,
    });
    expect(recorder.views()[0]).toMatchObject({ calls: SESSION_RECORD_MAX_CALLS, dropped: 10 });
  });

  it(`names at most ${String(SESSION_RECORD_MAX_DROPPED_USERS)} people among dropped calls and counts the rest together`, () => {
    const recorder = createRecorder();
    recorder.pageSession('pg_1', false, 100);
    const users = SESSION_RECORD_MAX_DROPPED_USERS + 5;
    for (let n = 0; n < users; n++) {
      recorder.call(entry(`c_${String(n)}`, { userId: `u${String(n)}`, displayName: 'U' }), 'pg_1');
    }
    for (let n = 0; n < SESSION_RECORD_MAX_CALLS; n++)
      recorder.call(entry(`d_${String(n)}`), 'pg_1');
    const { dropped } = snap(recorder);
    expect(dropped.calls).toBe(users);
    expect(dropped.byUser).toHaveLength(SESSION_RECORD_MAX_DROPPED_USERS);
    expect(dropped.otherCalls).toBe(5);
  });

  it('never holds arguments, results, image data, the full invitee key or anything else an entry or proposal carries', () => {
    const recorder = createRecorder();
    const marker = 'MARKER-0f9e8d7c';
    recorder.pageSession('pg_1', false, 100);
    roster(recorder, 200, view(guest, 'observer', 'inv_1'), view(alice));
    // Fields no entry has today, as a later change might add them: copied by name, they never arrive.
    const loaded = {
      ...entry('c_1', guest),
      arguments: { note: marker },
      result: marker,
      image: { mimeType: 'image/png', bytes: 3, data: marker },
    } as ActivityEntry;
    const handle = recorder.call(loaded, 'pg_1');
    recorder.update(handle, { ...loaded, outcome: 'ok', durationMs: 4 });
    const proposal: PendingProposal & { secret: string } = {
      proposalId: 'pr_1',
      tool: 'go_to_stop',
      proposer: { ...guest, client: null, role: 'observer' },
      arguments: JSON.stringify({ stop: marker }),
      argumentChars: 30,
      consequential: false,
      receivedAt: 300,
      expiresAt: 60_300,
      secret: marker,
    };
    recorder.proposal(proposal, 'pg_1');
    const record = snap(recorder);
    const json = sessionRecordJson(record);
    const markdown = sessionRecordMarkdown(record, { offsetMinutes: 0 });
    for (const text of [json, markdown]) {
      expect(text).not.toContain(marker);
      expect(text).not.toContain(GUEST_KEY);
    }
    expect(record.calls[0]?.user).toEqual({
      id: 'g_0123abcd',
      name: 'guest@example.com',
      kind: 'invitee',
    });
    expect(Object.keys(record.calls[0] ?? {})).not.toContain('image');
    expect(record.proposals[0]).toEqual({
      proposalId: 'pr_1',
      pageId: 'pg_1',
      at: 300,
      user: { id: 'g_0123abcd', name: 'guest@example.com', kind: 'invitee' },
      tool: 'go_to_stop',
      status: 'pending',
      decidedAt: null,
      callId: null,
    });
  });

  it('names two invitees that share a short id apart, and a member whose name shows nothing by id', () => {
    const recorder = createRecorder();
    recorder.pageSession('pg_1', false, 100);
    const twin: User = { userId: `g_0123abcd${'f'.repeat(24)}`, displayName: 'twin@example.com' };
    const blank: User = { userId: 'carol', displayName: '\u202e\u200b' };
    const odd: User = { userId: 'dave', displayName: 'Dave\u2028\u0007 Jones' };
    for (const [n, user] of [guest, twin, blank, odd, guest].entries()) {
      recorder.call(entry(`c_${String(n)}`, user), 'pg_1');
    }
    expect(snap(recorder).calls.map((call) => call.user)).toEqual([
      { id: 'g_0123abcd', name: 'guest@example.com', kind: 'invitee' },
      { id: 'g_0123abcd~2', name: 'twin@example.com', kind: 'invitee' },
      { id: 'carol', name: 'carol', kind: 'member' },
      { id: 'dave', name: 'Dave Jones', kind: 'member' },
      { id: 'g_0123abcd', name: 'guest@example.com', kind: 'invitee' },
    ]);
    expect(recorder.views()[0]).toMatchObject({ people: 4, invitees: 2 });
  });

  it('opens a span per attachment with how it came in, follows its role, and closes it as left or revoked', () => {
    const recorder = createRecorder();
    recorder.pageSession('pg_1', false, 100);
    roster(recorder, 200, view(alice), view(guest, 'observer', 'inv_1'));
    // The page runs Alice's calls as an observer now, and then nothing; the relay's role is unchanged.
    recorder.roster(
      [view(alice), view(guest, 'observer', 'inv_1'), view(bob, 'observer')],
      [pageRole(alice, 'observer'), pageRole(guest, 'observer'), pageRole(bob, 'observer')],
      wayIn([view(guest, 'observer', 'inv_1')]),
      300,
    );
    recorder.roster(
      [view(alice), view(guest, 'observer', 'inv_1'), view(bob, 'observer')],
      [pageRole(alice, null), pageRole(guest, 'observer'), pageRole(bob, 'observer')],
      wayIn([view(guest, 'observer', 'inv_1')]),
      350,
    );
    recorder.revoking(guest.userId);
    roster(recorder, 400, view(alice), view(bob, 'observer'));
    roster(recorder, 500, view(alice));
    const { attachments } = snap(recorder);
    expect(attachments).toEqual([
      {
        user: { id: 'alice', name: 'Alice', kind: 'member' },
        pageId: 'pg_1',
        how: 'approved',
        inviteId: null,
        before: false,
        joinedAt: 200,
        leftAt: null,
        ended: null,
        roles: [
          { at: 200, role: 'driver' },
          { at: 300, role: 'observer' },
          { at: 350, role: null },
          // The page runs Alice's calls as a driver again.
          { at: 400, role: 'driver' },
        ],
        rolesDropped: 0,
      },
      expect.objectContaining({
        user: { id: 'g_0123abcd', name: 'guest@example.com', kind: 'invitee' },
        how: 'invite',
        inviteId: 'inv_1',
        joinedAt: 200,
        leftAt: 400,
        ended: 'revoked',
        roles: [{ at: 200, role: 'observer' }],
      }),
      expect.objectContaining({
        user: { id: 'bob', name: 'Bob', kind: 'member' },
        how: 'approved',
        joinedAt: 300,
        leftAt: 500,
        ended: 'left',
      }),
    ]);
  });

  it('marks everyone a revoke-all named as revoked, and only them', () => {
    const recorder = createRecorder();
    recorder.pageSession('pg_1', false, 100);
    roster(recorder, 200, view(alice), view(bob));
    recorder.revoking('*');
    roster(recorder, 300);
    // Bob comes back; leaving on his own later is a leave, not the old revoke.
    roster(recorder, 400, view(bob));
    roster(recorder, 500);
    expect(snap(recorder).attachments.map((span) => [span.user.id, span.ended])).toEqual([
      ['alice', 'revoked'],
      ['bob', 'revoked'],
      ['bob', 'left'],
    ]);
  });

  it(`keeps the first role and the latest past ${String(SESSION_RECORD_MAX_ROLE_CHANGES)} changes, and counts the rest`, () => {
    const recorder = createRecorder();
    recorder.pageSession('pg_1', false, 100);
    const changes = SESSION_RECORD_MAX_ROLE_CHANGES + 4;
    for (let n = 0; n <= changes; n++) {
      recorder.roster(
        [view(alice)],
        [pageRole(alice, n % 2 ? 'observer' : 'driver')],
        wayIn([]),
        200 + n,
      );
    }
    const [span] = snap(recorder).attachments;
    expect(span?.roles).toHaveLength(SESSION_RECORD_MAX_ROLE_CHANGES);
    expect(span?.roles[0]).toEqual({ at: 200, role: 'driver' });
    expect(span?.roles.at(-1)).toEqual({ at: 200 + changes, role: 'driver' });
    expect(span?.rolesDropped).toBe(changes + 1 - SESSION_RECORD_MAX_ROLE_CHANGES);
  });

  it(`drops the oldest ended span past ${String(SESSION_RECORD_MAX_ATTACHMENTS)}, never an open one, and counts it`, () => {
    const recorder = createRecorder();
    recorder.pageSession('pg_1', false, 100);
    roster(recorder, 150, view(alice));
    for (let n = 0; n < SESSION_RECORD_MAX_ATTACHMENTS; n++) {
      const visitor = view({ userId: `v${String(n)}`, displayName: 'V' }, 'observer');
      roster(recorder, 200 + 2 * n, view(alice), visitor);
      roster(recorder, 201 + 2 * n, view(alice));
    }
    const { attachments, dropped } = snap(recorder);
    expect(attachments).toHaveLength(SESSION_RECORD_MAX_ATTACHMENTS);
    expect(attachments[0]?.user.id).toBe('alice');
    expect(attachments[1]?.user.id).toBe('v1');
    expect(dropped.attachments).toBe(1);
  });

  it('records where a call was confirmed: on the page, in the client, or nowhere', () => {
    const recorder = createRecorder();
    recorder.pageSession('pg_1', false, 100);
    const allowed = recorder.call(entry('c_1', alice, { tool: 'wipe' }), 'pg_1');
    recorder.confirmedOnPage(allowed);
    recorder.update(allowed, entry('c_1', alice, { tool: 'wipe', outcome: 'ok', durationMs: 9 }));
    const inClient = recorder.call(
      entry('c_2', alice, { tool: 'wipe', confirmedBy: 'client' }),
      'pg_1',
    );
    recorder.update(
      inClient,
      entry('c_2', alice, { tool: 'wipe', confirmedBy: 'client', outcome: 'ok', durationMs: 3 }),
    );
    const denied = recorder.call(entry('c_3', alice, { tool: 'wipe' }), 'pg_1');
    recorder.update(
      denied,
      entry('c_3', alice, { tool: 'wipe', outcome: 'denied_by_operator', durationMs: 7 }),
    );
    expect(
      snap(recorder).calls.map((call) => [call.callId, call.confirmedBy, call.outcome]),
    ).toEqual([
      ['c_1', 'page', 'ok'],
      ['c_2', 'client', 'ok'],
      ['c_3', null, 'denied_by_operator'],
    ]);
  });

  it('keeps a page session through a resumed welcome, and seals it at a new one with its spans ended when the link went', () => {
    const recorder = createRecorder();
    recorder.pageSession('pg_1', false, 100);
    roster(recorder, 200, view(alice));
    recorder.call(entry('c_1'), 'pg_1');
    recorder.linkLost(300);
    recorder.pageSession('pg_1', true, 400);
    roster(recorder, 410, view(alice));
    expect(recorder.views().map((record) => record.which)).toEqual(['current']);
    expect(snap(recorder).attachments).toEqual([
      expect.objectContaining({ joinedAt: 200, leftAt: null }),
    ]);

    recorder.linkLost(500);
    recorder.linkLost(550);
    recorder.pageSession('pg_2', false, 600);
    const previous = snap(recorder, 'previous');
    expect(previous).toMatchObject({ pageIds: ['pg_1'], from: 100, to: 500, sealed: true });
    expect(previous.attachments).toEqual([
      expect.objectContaining({ leftAt: 500, ended: 'page_session_ended' }),
    ]);
    expect(previous.calls.map((call) => call.callId)).toEqual(['c_1']);
    expect(snap(recorder)).toMatchObject({
      pageIds: ['pg_2'],
      from: 600,
      attachments: [],
      calls: [],
    });

    // An empty page session never replaces the record kept before it; one that holds anything does.
    recorder.pageSession('pg_3', false, 700);
    expect(snap(recorder, 'previous').pageIds).toEqual(['pg_1']);
    recorder.call(entry('c_3'), 'pg_3');
    recorder.pageSession('pg_4', false, 800);
    expect(snap(recorder, 'previous').pageIds).toEqual(['pg_3']);
  });

  it('settles a call in the record that held it when the page session changed while it ran', () => {
    const recorder = createRecorder();
    recorder.pageSession('pg_1', false, 100);
    const handle = recorder.call(entry('c_1'), 'pg_1');
    recorder.pageSession('pg_2', false, 200);
    recorder.call(entry('c_2'), 'pg_2');
    recorder.update(handle, entry('c_1', alice, { outcome: 'cancelled', durationMs: 150 }));
    expect(snap(recorder, 'previous').calls[0]).toMatchObject({
      callId: 'c_1',
      outcome: 'cancelled',
    });
    expect(snap(recorder).calls).toEqual([
      expect.objectContaining({ callId: 'c_2', outcome: 'running' }),
    ]);
  });

  it('marks who was already here when a reload resumed the page session', () => {
    const recorder = createRecorder();
    recorder.pageSession('pg_1', true, 100);
    roster(recorder, 150, view(alice));
    roster(recorder, 250, view(alice), view(bob));
    expect(
      snap(recorder).attachments.map((span) => [span.user.id, span.before, span.joinedAt]),
    ).toEqual([
      ['alice', true, 100],
      ['bob', false, 250],
    ]);
  });

  it('restarts the current record from now when discarded, and drops a sealed one', () => {
    const recorder = createRecorder();
    recorder.pageSession('pg_1', false, 100);
    roster(recorder, 200, view(alice));
    recorder.call(entry('c_1'), 'pg_1');
    recorder.pageSession('pg_2', false, 300);
    roster(recorder, 310, view(bob));
    recorder.call(entry('c_2', bob), 'pg_2');
    expect(recorder.discard('current', 400)).toBe(true);
    expect(snap(recorder)).toMatchObject({
      from: 400,
      calls: [],
      attachments: [
        expect.objectContaining({
          user: expect.objectContaining({ id: 'bob' }) as unknown,
          before: true,
          joinedAt: 400,
        }),
      ],
    });
    expect(recorder.discard('previous', 500)).toBe(true);
    expect(recorder.discard('previous', 500)).toBe(false);
    expect(recorder.discard('ended', 500)).toBe(false);
    expect(recorder.snapshot('previous', CONTEXT, 600)).toBeNull();
  });

  it('lets go of everything on dropAll', () => {
    const recorder = createRecorder();
    recorder.pageSession('pg_1', false, 100);
    recorder.call(entry('c_1'), 'pg_1');
    recorder.pageSession('pg_2', false, 200);
    recorder.dropAll();
    expect(recorder.views()).toEqual([]);
    for (const which of ['current', 'previous', 'ended'] as const) {
      expect(recorder.snapshot(which, CONTEXT, 300)).toBeNull();
    }
  });

  it('gives the same frozen list of views until a count changes', () => {
    const recorder = createRecorder();
    recorder.pageSession('pg_1', false, 100);
    const first = recorder.views();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    const handle = recorder.call(entry('c_1'), 'pg_1');
    const second = recorder.views();
    expect(second).not.toBe(first);
    recorder.update(handle, entry('c_1', alice, { outcome: 'ok', durationMs: 1 }));
    expect(recorder.views()).toBe(second);
    expect(second).toEqual([
      {
        which: 'current',
        scope: 'page',
        label: null,
        from: 100,
        to: null,
        calls: 1,
        people: 1,
        invitees: 0,
        proposals: 0,
        dropped: 0,
        failed: false,
      },
    ]);
  });

  it('hands out a fresh copy each time, so editing one changes no later snapshot', () => {
    const recorder = createRecorder();
    recorder.pageSession('pg_1', false, 100);
    recorder.call(entry('c_1'), 'pg_1');
    const first = snap(recorder);
    const [kept] = first.calls;
    if (kept === undefined) throw new Error('no call');
    (kept as { tool: string }).tool = 'edited';
    first.calls.push({ ...kept, callId: 'c_forged' });
    expect(snap(recorder).calls).toEqual([
      expect.objectContaining({ callId: 'c_1', tool: 'set_view' }),
    ]);
  });

  it('links an accepted proposal to the call that ran it, and records how every other one ended', () => {
    const recorder = createRecorder();
    recorder.pageSession('pg_1', false, 100);
    const pending = (proposalId: string, receivedAt: number): PendingProposal => ({
      proposalId,
      tool: 'go_to_stop',
      proposer: { ...guest, client: null, role: 'observer' },
      arguments: '{}',
      argumentChars: 2,
      consequential: true,
      receivedAt,
      expiresAt: receivedAt + 60_000,
    });
    const settled = (
      proposalId: string,
      outcome: ProposalLogEntry['outcome'],
      callId: string | null,
    ): ProposalLogEntry => ({
      proposalId,
      tool: 'go_to_stop',
      proposer: guest,
      client: null,
      outcome,
      callId,
      time: 900,
    });
    recorder.proposal(pending('pr_1', 200), 'pg_1');
    recorder.proposal(pending('pr_2', 210), 'pg_1');
    recorder.proposal(pending('pr_3', 220), 'pg_1');
    const run = recorder.call(
      entry('c_1', guest, { tool: 'go_to_stop', proposalId: 'pr_1' }),
      'pg_1',
    );
    recorder.confirmedOnPage(run);
    recorder.update(
      run,
      entry('c_1', guest, {
        tool: 'go_to_stop',
        proposalId: 'pr_1',
        acceptedOnPage: true,
        outcome: 'ok',
        durationMs: 2,
      }),
    );
    recorder.proposalSettled(settled('pr_1', 'accepted', 'c_1'));
    recorder.proposalSettled(settled('pr_2', 'dismissed', null));
    recorder.proposalSettled(settled('pr_3', 'not_run', 'c_ignored'));
    // A second word on one already settled changes nothing.
    recorder.proposalSettled(settled('pr_2', 'expired', null));
    const record = snap(recorder);
    expect(record.proposals.map((p) => [p.proposalId, p.status, p.decidedAt, p.callId])).toEqual([
      ['pr_1', 'accepted', 900, 'c_1'],
      ['pr_2', 'dismissed', 900, null],
      ['pr_3', 'not_run', 900, null],
    ]);
    expect(record.calls[0]).toMatchObject({
      callId: 'c_1',
      proposalId: 'pr_1',
      confirmedBy: 'page',
    });
  });

  it(`drops the oldest decided proposal past ${String(SESSION_RECORD_MAX_PROPOSALS)}, and counts it`, () => {
    const recorder = createRecorder();
    recorder.pageSession('pg_1', false, 100);
    for (let n = 0; n <= SESSION_RECORD_MAX_PROPOSALS; n++) {
      const proposalId = `pr_${String(n)}`;
      recorder.proposal(
        {
          proposalId,
          tool: 't',
          proposer: { ...bob, client: null, role: 'observer' },
          arguments: '{}',
          argumentChars: 2,
          consequential: false,
          receivedAt: n,
          expiresAt: n + 1,
        },
        'pg_1',
      );
      if (n > 0) {
        recorder.proposalSettled({
          proposalId,
          tool: 't',
          proposer: bob,
          client: null,
          outcome: 'expired',
          callId: null,
          time: n + 1,
        });
      }
    }
    const { proposals, dropped } = snap(recorder);
    expect(proposals).toHaveLength(SESSION_RECORD_MAX_PROPOSALS);
    expect(proposals[0]).toMatchObject({ proposalId: 'pr_0', status: 'pending' });
    expect(proposals[1]?.proposalId).toBe('pr_2');
    expect(dropped.proposals).toBe(1);
  });
});

describe('a time-boxed session in the record (ADR 0043)', () => {
  it('seals the page record at its start, spans page sessions, and is sealed into ended at its end', () => {
    const recorder = createRecorder();
    recorder.pageSession('pg_1', false, 100);
    roster(recorder, 200, view(alice));
    recorder.call(entry('c_0'), 'pg_1');
    recorder.sessionStarted(session());
    expect(snap(recorder, 'previous')).toMatchObject({
      to: 5_000,
      scope: { kind: 'page' },
      sealed: true,
    });
    roster(recorder, 5_100, view(alice), view(guest, 'observer', 'inv_watch'));
    recorder.call(entry('c_1', guest, { tool: 'get_view' }), 'pg_1');
    // Extended: the same session, a later end.
    recorder.sessionStarted(session({ endsAt: 5_000 + 60 * 60_000, lengthMinutes: 60 }));
    // A deploy in the lesson: a new page session joins the same record.
    recorder.linkLost(6_000);
    recorder.pageSession('pg_2', false, 6_100);
    roster(recorder, 6_200, view(alice), view(guest, 'observer', 'inv_watch2'));
    recorder.call(entry('c_2', guest, { tool: 'get_view' }), 'pg_2');
    recorder.sessionEnded({
      sessionId: 'ss_1',
      label: 'Period 3',
      reason: 'operator',
      time: 7_000,
    });

    const lesson = snap(recorder, 'ended');
    expect(lesson).toMatchObject({
      pageIds: ['pg_1', 'pg_2'],
      from: 5_000,
      to: 7_000,
      sealed: true,
      scope: {
        kind: 'session',
        sessionId: 'ss_1',
        label: 'Period 3',
        startedAt: 5_000,
        endsAt: 5_000 + 60 * 60_000,
        endedAt: 7_000,
        endedBy: 'operator',
        maxDrivers: 2,
        proposals: 'all',
        observers: 35,
        invites: 1,
      },
    });
    expect(lesson.calls.map((call) => [call.callId, call.pageId])).toEqual([
      ['c_1', 'pg_1'],
      ['c_2', 'pg_2'],
    ]);
    expect(
      lesson.attachments.map((span) => [span.user.id, span.pageId, span.before, span.ended]),
    ).toEqual([
      ['alice', 'pg_1', true, 'page_session_ended'],
      ['g_0123abcd', 'pg_1', false, 'page_session_ended'],
      ['alice', 'pg_2', false, null],
      ['g_0123abcd', 'pg_2', false, 'session_ended'],
    ]);
    // After the lesson a page record runs again, with whoever stayed there from its start.
    expect(snap(recorder)).toMatchObject({
      scope: { kind: 'page' },
      pageIds: ['pg_2'],
      from: 7_000,
      attachments: [
        expect.objectContaining({
          user: expect.objectContaining({ id: 'alice' }) as unknown,
          before: true,
        }),
      ],
    });
    expect(recorder.views().map((record) => [record.which, record.scope, record.label])).toEqual([
      ['current', 'page', null],
      ['previous', 'page', null],
      ['ended', 'session', 'Period 3'],
    ]);
  });

  it('carries a pending proposal into the session record, which alone learns how it ended', () => {
    const recorder = createRecorder();
    recorder.pageSession('pg_1', false, 100);
    recorder.proposal(
      {
        proposalId: 'pr_1',
        tool: 'go_to_stop',
        proposer: { ...guest, client: null, role: 'observer' },
        arguments: '{}',
        argumentChars: 2,
        consequential: false,
        receivedAt: 200,
        expiresAt: 60_200,
      },
      'pg_1',
    );
    recorder.sessionStarted(session());
    recorder.proposalSettled({
      proposalId: 'pr_1',
      tool: 'go_to_stop',
      proposer: guest,
      client: null,
      outcome: 'withdrawn',
      callId: null,
      time: 5_500,
    });
    expect(snap(recorder, 'previous').proposals[0]?.status).toBe('pending');
    expect(snap(recorder).proposals[0]).toMatchObject({ status: 'withdrawn', decidedAt: 5_500 });
  });

  it('ignores the end of a session it does not hold', () => {
    const recorder = createRecorder();
    recorder.pageSession('pg_1', false, 100);
    recorder.sessionEnded({ sessionId: 'ss_9', label: 'Other', reason: 'time', time: 200 });
    recorder.sessionStarted(session());
    recorder.sessionEnded({ sessionId: 'ss_9', label: 'Other', reason: 'time', time: 300 });
    expect(recorder.views().map((record) => record.which)).toEqual(['current']);
    expect(snap(recorder).scope.kind).toBe('session');
  });

  it(`names at most ${String(SESSION_RECORD_MAX_PAGE_IDS)} page sessions, counting calls on any later one as dropped`, () => {
    const recorder = createRecorder();
    recorder.pageSession('pg_0', false, 100);
    recorder.sessionStarted(session());
    for (let n = 1; n <= SESSION_RECORD_MAX_PAGE_IDS; n++)
      recorder.pageSession(`pg_${String(n)}`, false, 5_000 + n);
    recorder.call(entry('c_late'), `pg_${String(SESSION_RECORD_MAX_PAGE_IDS)}`);
    const record = snap(recorder);
    expect(record.pageIds).toHaveLength(SESSION_RECORD_MAX_PAGE_IDS);
    expect(record.calls).toEqual([]);
    expect(record.dropped.calls).toBe(1);
  });
});

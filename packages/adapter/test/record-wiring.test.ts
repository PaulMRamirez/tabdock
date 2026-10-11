// ADR 0045's recorder as the core keeps it (A6.25): every call the page
// accepted, past the fifty the activity log keeps, each with its final
// outcome even once pushed out of that log; attachment spans with how the
// page's own grants let each one in, their roles, and how each ended; where
// each call was confirmed; proposals linked to the call that ran them and
// never their arguments; a page record sealed by a new page session or a
// session's start, and a session's record sealed into `ended` at its end;
// agents by the label their token has here, in the record and the activity
// log alike; nothing a frame or a result carried beyond the names the
// widget shows; and a recorder that throws, which stops the record and
// changes no call.

import {
  type AttachmentView,
  agentKeyInput,
  type PageFrame,
  PROPOSAL_TTL_MS,
  type RelayFrame,
  type Role,
  type SessionRecord,
  SessionRecordSchema,
} from '@tabdock/protocol';
import { describe, expect, it } from 'vitest';
import { ACTIVITY_LIMIT } from '../src/core.ts';
import { sessionRecordJson, sessionRecordMarkdown } from '../src/record-markdown.ts';
import { createRecorder, type Recorder } from '../src/record.ts';
import {
  attachment,
  type FakeSocket,
  flush,
  grant,
  GUEST,
  type Harness,
  invitedAttachment,
  invitesFrame,
  invoke,
  link,
  mint,
  redemption,
  results,
  setup,
  sha256Hex,
  SPONSOR,
  until,
  welcome,
} from './harness.ts';

type Which = 'current' | 'previous' | 'ended';

/** The record the handle gives, which must exist, checked against the protocol's strict schema. */
function saved(h: Harness, which: Which = 'current'): SessionRecord {
  const record = h.dock.sessionRecord(which);
  if (record === null) throw new Error(`no ${which} record`);
  expect(SessionRecordSchema.parse(record)).toEqual(record);
  return record;
}

/** Every time a record holds lies within its span, as `audit --match` first checks. */
function whole(record: SessionRecord): void {
  const inside = (at: number): boolean => at >= record.from && at <= record.to;
  for (const call of record.calls) expect(inside(call.at), call.callId).toBe(true);
  for (const span of record.attachments) {
    expect(inside(span.joinedAt)).toBe(true);
    for (const role of span.roles) expect(inside(role.at)).toBe(true);
    if (span.leftAt !== null) expect(inside(span.leftAt)).toBe(true);
  }
}

/**
 * Someone attaches as on a real relay: they ask, the operator allows, and
 * the relay's next roster lists them, after whoever `listed` holds.
 */
function join(
  h: Harness,
  socket: FakeSocket,
  listed: AttachmentView[],
  userId: string,
  role: Role,
): void {
  grant(h, socket, userId, role);
  listed.push(attachment(userId, role, h.clock.now));
  socket.deliver({ t: 'roster', attachments: [...listed] });
}

/** A page nobody has approved yet, then Alice attached as its driver. */
async function withAlice(core: Parameters<typeof setup>[0] = {}) {
  const h = setup(core);
  const socket = await link(h, {}, {});
  const listed: AttachmentView[] = [];
  join(h, socket, listed, 'alice', 'driver');
  return { h, socket, listed };
}

describe('the calls the record keeps (ADR 0045)', () => {
  it(`keeps every call the page accepted with its final outcome, past the ${String(ACTIVITY_LIMIT)} the activity log keeps`, async () => {
    const { h, socket } = await withAlice();
    for (let n = 0; n < 120; n += 1) {
      socket.deliver(invoke('get_value', { callId: `call-${String(n)}` }));
    }
    await until(() => results(socket).length === 120, 'every result');
    expect(h.dock.state.activity).toHaveLength(ACTIVITY_LIMIT);
    const record = saved(h);
    expect(record.calls.map((call) => call.callId)).toEqual(
      Array.from({ length: 120 }, (_, n) => `call-${String(n)}`),
    );
    expect(record.calls.every((call) => call.outcome === 'ok' && call.durationMs !== null)).toBe(
      true,
    );
    expect(record.calls[0]).toMatchObject({
      pageId: 'page-1',
      user: { id: 'alice', name: 'Alice', kind: 'member' },
      tool: 'get_value',
      confirmedBy: null,
      proposalId: null,
    });
    expect(h.dock.state.records).toEqual([
      expect.objectContaining({ which: 'current', scope: 'page', calls: 120, people: 1 }),
    ]);
  });

  it('settles a call in the record after fifty newer ones pushed it out of the activity log', async () => {
    const { h, socket } = await withAlice();
    let release: () => void = () => undefined;
    h.context.handlers.set(
      'set_value',
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve('done');
          };
        }),
    );
    socket.deliver(invoke('set_value', { callId: 'slow' }));
    await until(() => h.context.runs.length === 1, 'the write to start');
    for (let n = 0; n < ACTIVITY_LIMIT; n += 1) {
      socket.deliver(invoke('get_value', { callId: `read-${String(n)}` }));
    }
    await until(() => results(socket).length === ACTIVITY_LIMIT, 'the reads');
    expect(h.dock.state.activity.some((entry) => entry.callId === 'slow')).toBe(false);
    release();
    await until(() => results(socket).length === ACTIVITY_LIMIT + 1, 'the write');
    expect(saved(h).calls[0]).toMatchObject({ callId: 'slow', outcome: 'ok' });
    expect(saved(h).calls[0]?.durationMs).not.toBeNull();
  });

  it('records where each call was confirmed: on the page, in the client, or nowhere', async () => {
    const { h, socket } = await withAlice({ core: { policy: { confirmVia: 'client' } } });
    socket.deliver(invoke('wipe', { callId: 'allowed' }));
    await until(() => h.dock.state.pendingConfirms.length === 1, 'the prompt');
    h.dock.confirm('allowed', true);
    socket.deliver(
      invoke('wipe', {
        callId: 'in-client',
        caller: {
          userId: 'alice',
          displayName: 'Alice',
          client: { name: 'claude-code', version: '2.1.296' },
          role: 'driver',
        },
        confirmation: { by: 'client', confirmationId: 'cf_1', at: h.clock.now },
      }),
    );
    socket.deliver(invoke('wipe', { callId: 'denied' }));
    await until(
      () => h.dock.state.pendingConfirms.some((pending) => pending.callId === 'denied'),
      'the second prompt',
    );
    h.dock.confirm('denied', false);
    await until(() => results(socket).length === 3, 'every result');
    expect(
      saved(h).calls.map((call) => [call.callId, call.confirmedBy, call.outcome, call.client]),
    ).toEqual([
      ['allowed', 'page', 'ok', null],
      ['in-client', 'client', 'ok', 'claude-code 2.1.296'],
      ['denied', null, 'denied_by_operator', null],
    ]);
  });
});

describe('attachment spans and page sessions (ADR 0045, decision 5)', () => {
  it('opens a span per attachment, follows its role, and closes it as revoked, left or page_session_ended', async () => {
    const { h, socket, listed } = await withAlice();
    join(h, socket, listed, 'bob', 'observer');
    join(h, socket, listed, 'carol', 'observer');
    h.clock.now += 1_000;
    expect(h.dock.setRole('bob', 'driver')).toBe(true);
    socket.deliver({
      t: 'roster',
      attachments: listed.map((entry) =>
        entry.userId === 'bob' ? { ...entry, role: 'driver' as const } : entry,
      ),
    });
    h.clock.now += 1_000;
    expect(h.dock.revoke('bob')).toBe(true);
    socket.deliver({ t: 'roster', attachments: listed.filter((entry) => entry.userId !== 'bob') });
    h.clock.now += 1_000;
    socket.deliver({
      t: 'roster',
      attachments: listed.filter((entry) => entry.userId === 'alice'),
    });
    const kept = saved(h).attachments;
    expect(kept.map((span) => [span.user.id, span.how, span.ended])).toEqual([
      ['alice', 'approved', null],
      ['bob', 'approved', 'revoked'],
      ['carol', 'approved', 'left'],
    ]);
    expect(kept[1]?.roles.map((role) => role.role)).toEqual(['observer', 'driver']);

    // A resumed welcome keeps the record and its open spans.
    socket.drop(1006);
    await h.clock.advance(1_000);
    let again = h.socket();
    again.accept();
    again.deliver(welcome(h.clock, { resumed: true, roster: [attachment('alice', 'driver', 0)] }));
    await flush();
    expect(h.dock.state.records.map((view) => view.which)).toEqual(['current']);
    expect(saved(h).attachments[0]).toMatchObject({ user: { id: 'alice' }, leftAt: null });

    // A new page session seals it, everyone leaving when the link went.
    again.drop(1006);
    const lost = h.clock.now;
    await h.clock.advance(1_000);
    again = h.socket();
    again.accept();
    again.deliver(welcome(h.clock, { pageId: 'page-2', resumed: false }));
    await flush();
    const previous = saved(h, 'previous');
    whole(previous);
    expect(previous).toMatchObject({ pageIds: ['page-1'], sealed: true });
    expect(previous.attachments[0]).toMatchObject({
      user: { id: 'alice' },
      leftAt: lost,
      ended: 'page_session_ended',
    });
    expect(saved(h)).toMatchObject({ pageIds: ['page-2'], attachments: [], calls: [] });
    expect(h.dock.state.records.map((view) => [view.which, view.to === null])).toEqual([
      ['current', true],
      ['previous', false],
    ]);
  });

  it('restarts the current record from now on Clear, with whoever is here from its start', async () => {
    const { h, socket } = await withAlice();
    socket.deliver(invoke('get_value', { callId: 'before' }));
    await until(() => results(socket).length === 1, 'the result');
    h.clock.now += 5_000;
    expect(h.dock.discardRecord('current')).toBe(true);
    const record = saved(h);
    expect(record).toMatchObject({ from: h.clock.now, calls: [] });
    expect(record.attachments).toEqual([
      expect.objectContaining({
        user: expect.objectContaining({ id: 'alice' }) as unknown,
        before: true,
      }),
    ]);
    // Nothing else is a record, and nothing a page script passes picks one.
    expect(h.dock.discardRecord('previous')).toBe(false);
    expect(h.dock.discardRecord('all' as 'current')).toBe(false);
    expect(h.dock.sessionRecord('all' as 'current')).toBeNull();
  });

  it('lets go of every record when the page detaches', async () => {
    const { h, socket } = await withAlice();
    socket.deliver(invoke('get_value'));
    await until(() => results(socket).length === 1, 'the result');
    expect(h.dock.state.records).toHaveLength(1);
    h.dock.close();
    expect(h.dock.sessionRecord()).toBeNull();
    expect(h.dock.state.records).toEqual([]);
  });
});

describe('what a record never holds (ADR 0045, decision 25; S11)', () => {
  it('holds no argument, result, pairing code, resume token, invite secret or full invitee key', async () => {
    const h = setup({ core: { policy: { invites: 'all' } } });
    const socket = await link(h, {}, {});
    const listed: AttachmentView[] = [];
    join(h, socket, listed, 'alice', 'driver');
    const invites = [] as Parameters<typeof mint>[3];
    socket.deliver(invitesFrame([]));
    const minted = await mint(h, socket, { label: 'Friends', role: 'observer', uses: 3 }, invites);
    socket.deliver(redemption(h.clock, minted));
    await until(
      () =>
        socket.framesOf('attach_decision').some((frame) => frame.requestId.startsWith('redeem')),
      'the redemption',
    );
    listed.push(invitedAttachment(GUEST, 'observer', minted.inviteId, h.clock.now + 3_600_000));
    socket.deliver({ t: 'roster', attachments: [...listed] });
    h.context.handlers.set('set_value', () => ({ said: 'MARKER-RESULT' }));
    socket.deliver(invoke('set_value', { callId: 'marked', arguments: { note: 'MARKER-ARG' } }));
    socket.deliver(
      invoke('get_value', {
        callId: 'guest-read',
        caller: { userId: GUEST, displayName: 'guest@example.com', client: null, role: 'observer' },
      }),
    );
    await until(() => results(socket).length === 2, 'both results');
    expect(JSON.stringify(results(socket))).toContain('MARKER-RESULT');

    const record = saved(h);
    expect(record.attachments.map((span) => [span.user.id, span.how, span.inviteId])).toEqual([
      ['alice', 'approved', null],
      ['g_1a2b3c4d', 'invite', minted.inviteId],
    ]);
    const texts = [
      sessionRecordJson(record),
      sessionRecordMarkdown(record),
      JSON.stringify(h.dock.state.records),
    ];
    for (const text of texts) {
      for (const secret of [
        'MARKER-ARG',
        'MARKER-RESULT',
        'ABCDE-FGHJK',
        'resume-1',
        minted.secret,
        GUEST,
        GUEST.slice(2),
      ]) {
        expect(text).not.toContain(secret);
      }
    }
    expect(texts[0]).toContain('g_1a2b3c4d');
  });
});

describe('proposals in the record (ADR 0042)', () => {
  it('links an accepted proposal and the call that ran it both ways, confirmed on the page, without its arguments', async () => {
    const { h, socket, listed } = await withAlice({ core: { policy: { proposals: 'members' } } });
    join(h, socket, listed, 'bob', 'observer');
    const bob = { userId: 'bob', displayName: 'Bob', client: null, role: 'observer' } as const;
    const proposal = (proposalId: string): RelayFrame => ({
      t: 'proposal',
      proposalId,
      tool: 'wipe',
      arguments: { note: 'MARKER-PROPOSED' },
      proposer: bob,
      expiresAt: h.clock.now + PROPOSAL_TTL_MS,
    });
    socket.deliver(proposal('pr_1'));
    socket.deliver(proposal('pr_2'));
    await until(() => h.dock.state.proposals.length === 2, 'both proposals');
    expect(h.dock.state.records[0]?.proposals).toBe(2);
    expect(h.dock.acceptProposal('pr_1')).toBe(true);
    expect(h.dock.dismissProposal('pr_2')).toBe(true);
    socket.deliver(
      invoke('wipe', {
        callId: 'call-9',
        caller: bob,
        arguments: { note: 'MARKER-PROPOSED' },
        proposal: { proposalId: 'pr_1' },
      }),
    );
    await until(() => results(socket).length === 1, 'the result');
    const record = saved(h);
    expect(record.proposals.map((held) => [held.proposalId, held.status, held.callId])).toEqual([
      ['pr_1', 'accepted', 'call-9'],
      ['pr_2', 'dismissed', null],
    ]);
    expect(record.calls).toEqual([
      expect.objectContaining({
        callId: 'call-9',
        proposalId: 'pr_1',
        confirmedBy: 'page',
        outcome: 'ok',
      }),
    ]);
    whole(record);
    expect(sessionRecordJson(record)).not.toContain('MARKER-PROPOSED');
    expect(sessionRecordMarkdown(record)).not.toContain('MARKER-PROPOSED');
  });
});

describe('a time-boxed session in the record (ADR 0043)', () => {
  type SessionStart = Extract<PageFrame, { t: 'session_start' }>;
  const listed = (start: SessionStart): RelayFrame => ({
    t: 'session',
    session: {
      sessionId: start.sessionId,
      lengthMs: start.lengthMs,
      remainingMs: start.lengthMs,
      policy: start.policy,
    },
  });

  async function offering() {
    const h = setup({ core: { policy: { invites: 'watch', maxDrivers: 2 } } });
    const limits = { ...welcome(h.clock).limits, usersPerPage: 10, observersPerPage: 40 };
    const socket = await link(h, { limits }, {});
    const roster: AttachmentView[] = [];
    join(h, socket, roster, 'alice', 'driver');
    join(h, socket, roster, 'carol', 'driver');
    socket.deliver(invitesFrame([]));
    socket.deliver({ t: 'session', session: null });
    await flush();
    return { h, socket, roster };
  }

  it('seals the page record at its start, after what it took in before the relay listed it, and offers the lesson as ended', async () => {
    const { h, socket, roster } = await offering();
    socket.deliver(invoke('get_value', { callId: 'before' }));
    await until(() => results(socket).length === 1, 'the first result');
    const pending = h.dock.startSession({ label: 'Period 3', lengthMinutes: 30, drivers: 1 });
    await until(() => socket.framesOf('session_start').length === 1, 'a session_start');
    const [start] = socket.framesOf('session_start');
    if (start === undefined) throw new Error('no session_start');
    // The relay answers the demotion before it lists the session.
    h.clock.now += 100;
    socket.deliver({
      t: 'roster',
      attachments: roster.map((entry) =>
        entry.userId === 'carol' ? { ...entry, role: 'observer' as const } : entry,
      ),
    });
    h.clock.now += 100;
    socket.deliver(listed(start));
    expect((await pending).ok).toBe(true);
    const page = saved(h, 'previous');
    whole(page);
    expect(page.calls.map((call) => call.callId)).toEqual(['before']);
    expect(page.attachments.find((span) => span.user.id === 'carol')?.roles.at(-1)?.role).toBe(
      'observer',
    );

    socket.deliver(invoke('get_value', { callId: 'during' }));
    await until(() => results(socket).length === 2, 'the second result');
    h.clock.now += 60_000;
    expect(h.dock.endSession()).toBe(true);
    const lesson = saved(h, 'ended');
    whole(lesson);
    expect(lesson).toMatchObject({
      sealed: true,
      scope: {
        kind: 'session',
        sessionId: start.sessionId,
        label: 'Period 3',
        endedBy: 'operator',
        maxDrivers: 1,
      },
      calls: [expect.objectContaining({ callId: 'during' })],
    });
    expect(
      h.dock.state.records.map((view) => [view.which, view.scope, view.label, view.calls]),
    ).toEqual([
      ['current', 'page', null, 0],
      ['previous', 'page', null, 1],
      ['ended', 'session', 'Period 3', 1],
    ]);
  });
});

describe('agents in the record and the activity log (ADR 0044)', () => {
  it('names an agent by its token’s label here, how it came in as agent, its token as its way in', async () => {
    const h = setup({ core: { policy: { invites: 'all' } } });
    const socket = await link(h, {}, {});
    const roster: AttachmentView[] = [];
    join(h, socket, roster, 'alice', 'driver');
    socket.deliver({ t: 'agents', endpoint: 'https://relay.example/g/mcp', agents: [] });
    await flush();
    const pending = h.dock.agentToken({ label: 'Nightly checker' });
    await until(() => socket.framesOf('agent_create').length === 1, 'an agent_create');
    const [create] = socket.framesOf('agent_create');
    if (create === undefined) throw new Error('no agent_create');
    socket.deliver({
      t: 'agents',
      endpoint: 'https://relay.example/g/mcp',
      agents: [
        {
          tokenId: create.tokenId,
          label: create.label,
          expiresAt: create.expiresAt,
          sponsor: SPONSOR,
          state: 'dormant',
          timeouts: 0,
        },
      ],
    });
    const minted = await pending;
    if (!minted.ok) throw new Error(minted.reason);
    const agent = `g_${(await sha256Hex(agentKeyInput('page-1', minted.tokenId))).slice(0, 32)}`;
    const relayName = `agent ${agent.slice(2, 10)}`;
    socket.deliver({
      t: 'attach_request',
      requestId: 'agent-req',
      user: { userId: agent, displayName: relayName },
      account: { kind: 'invitee', verified: false },
      via: 'agent',
      agent: { tokenId: minted.tokenId, secret: minted.token, label: create.label },
      client: { name: 'claude-code', version: '2.1.296' },
      expiresAt: h.clock.now + 60_000,
    });
    await until(() => h.dock.state.pendingRequests.length === 1, 'the agent prompt');
    expect(h.dock.approve('agent-req', 'observer')).toBe(true);
    roster.push({
      ...invitedAttachment(agent, 'observer', minted.tokenId, h.clock.now + 3_600_000),
      displayName: relayName,
    });
    socket.deliver({ t: 'roster', attachments: [...roster] });
    socket.deliver(
      invoke('get_value', {
        callId: 'agent-read',
        caller: { userId: agent, displayName: relayName, client: null, role: 'observer' },
      }),
    );
    await until(() => results(socket).length === 1, 'the result');
    expect(h.dock.state.activity[0]?.user).toEqual({
      userId: agent,
      displayName: 'agent "Nightly checker"',
    });
    const record = saved(h);
    expect(record.attachments[1]).toMatchObject({
      user: { id: agent.slice(0, 10), name: 'agent "Nightly checker"', kind: 'invitee' },
      how: 'agent',
      inviteId: minted.tokenId,
    });
    expect(record.calls[0]?.user.name).toBe('agent "Nightly checker"');
    expect(sessionRecordJson(record)).not.toContain(minted.token);
  });
});

describe('a recorder fault (ADR 0045, decision 22)', () => {
  /** A recorder that keeps what createRecorder keeps until `failing` throws, then throws from every hook. */
  function failing(hook: keyof Recorder): Recorder {
    const inner = createRecorder();
    let broken = false;
    return Object.fromEntries(
      Object.entries(inner).map(([name, run]) => [
        name,
        (...args: unknown[]): unknown => {
          if (name === hook) broken = true;
          if (broken) throw new TypeError('the recorder broke');
          return (run as (...given: unknown[]) => unknown)(...args);
        },
      ]),
    ) as unknown as Recorder;
  }

  /** A page that runs a read, an allowed write and a denied one, and every frame it sent. */
  async function run(recorder?: Recorder) {
    const { h, socket } = await withAlice(recorder ? { core: { recorder } } : {});
    socket.deliver(invoke('get_value', { callId: 'read' }));
    socket.deliver(invoke('wipe', { callId: 'allowed' }));
    await until(() => h.dock.state.pendingConfirms.length === 1, 'the prompt');
    h.dock.confirm('allowed', true);
    socket.deliver(invoke('wipe', { callId: 'denied' }));
    await until(
      () => h.dock.state.pendingConfirms.some((pending) => pending.callId === 'denied'),
      'the second prompt',
    );
    h.dock.confirm('denied', false);
    await until(() => results(socket).length === 3, 'every result');
    socket.deliver({ t: 'roster', attachments: [] });
    return { h, frames: socket.frames() };
  }

  for (const hook of ['call', 'pageSession', 'roster', 'update', 'confirmedOnPage'] as const) {
    it(`stops the record when ${hook} throws, and every call runs and is answered as without it`, async () => {
      const clean = await run();
      const broken = await run(failing(hook));
      expect(broken.frames).toEqual(clean.frames);
      expect(broken.h.dock.state.activity).toEqual(clean.h.dock.state.activity);
      expect(broken.h.logs.filter((line) => line.includes('session record stopped'))).toEqual([
        'warn session record stopped: TypeError',
      ]);
      expect(broken.h.dock.state.records).toEqual([
        expect.objectContaining({ which: 'current', failed: true, calls: 0 }),
      ]);
      expect(broken.h.dock.sessionRecord()).toBeNull();
      expect(broken.h.dock.discardRecord('current')).toBe(false);
      expect(clean.h.dock.state.records[0]?.failed).toBe(false);
    });
  }
});

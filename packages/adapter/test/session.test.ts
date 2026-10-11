// A time-boxed session on the page's side (ADR 0043; A6.15 to A6.17): the
// adapter never sends a session wider than attach()'s policy, demotes the
// drivers past its seats before the relay hears, mints its watch invites
// with their ends at the session's longest, adopts only a session it
// started, never lets a relay stretch one, and at its own end, a silent
// relay or not, drops every grant an invite let in. The relay here is the
// test, playing each frame through the harness's socket.

import {
  MAX_SESSION_MS,
  type PageFrame,
  type RelayFrame,
  SESSION_END_GRACE_MS,
} from '@tabdock/protocol';
import { describe, expect, it } from 'vitest';
import type { Harness } from './harness.ts';
import {
  attachment,
  FakeSocket,
  flush,
  GUEST,
  invitedAttachment,
  OTHER_GUEST,
  invitesFrame,
  invoke,
  link,
  listingOf,
  MapStorage,
  redemption,
  results,
  setup,
  until,
  welcome,
} from './harness.ts';

// Written out, as harness.ts writes the M4 keys, so a change to how records are keyed shows here.
const SESSION_KEY = 'tabdock:session:["ws://relay.test/page","http://127.0.0.1:5173/board"]';
const MINUTE = 60_000;

type SessionStart = Extract<PageFrame, { t: 'session_start' }>;
type SessionFrame = Extract<RelayFrame, { t: 'session' }>;

/** A linked page whose relay offers invites and sessions, with Alice, a member, its driver. */
async function offering(
  policy: Record<string, unknown> = { invites: 'watch' },
  roster = [attachment('alice', 'driver')],
  grants: Record<string, 'driver' | 'observer'> = { alice: 'driver' },
  storage?: MapStorage,
) {
  const h = setup({ core: { policy }, ...(storage === undefined ? {} : { storage }) });
  const limits = { ...welcome(h.clock).limits, usersPerPage: 10, observersPerPage: 40 };
  const socket = await link(h, { roster, limits }, grants);
  socket.deliver(invitesFrame([]));
  socket.deliver({ t: 'session', session: null });
  await flush();
  return { h, socket };
}

/** What a relay that applies the start says: listed, with its whole length left unless told. */
function listed(start: SessionStart, remainingMs = start.lengthMs): SessionFrame {
  return {
    t: 'session',
    session: {
      sessionId: start.sessionId,
      lengthMs: start.lengthMs,
      remainingMs,
      policy: start.policy,
    },
  };
}

/** Starts a session through the handle, the relay listing it and every invite it is asked for. */
async function started(
  h: Harness,
  socket: FakeSocket,
  options: Parameters<Harness['dock']['startSession']>[0],
  remainingMs?: number,
) {
  const pending = h.dock.startSession(options);
  await until(() => socket.framesOf('session_start').length === 1, 'a session_start');
  const [start] = socket.framesOf('session_start');
  if (start === undefined) throw new Error('no session_start');
  socket.deliver(listed(start, remainingMs));
  const wanted = Math.ceil((options.observers ?? 0) / 20);
  const listings: ReturnType<typeof listingOf>[] = [];
  for (let n = 0; n < wanted; n += 1) {
    await until(() => socket.framesOf('invite_create').length > n, 'an invite_create');
    const create = socket.framesOf('invite_create')[n];
    if (create === undefined) throw new Error('no invite_create');
    listings.push(listingOf(create));
    socket.deliver(invitesFrame([...listings]));
  }
  const result = await pending;
  if (!result.ok) throw new Error(`the session was refused: ${result.reason}`);
  return { start, result };
}

const codes = (socket: FakeSocket) => results(socket).map((frame) => frame.error?.code ?? 'ok');

describe('S5: a session is never wider than attach()', () => {
  it('refuses wider seats or proposals, or anything malformed, and sends nothing', async () => {
    const { h, socket } = await offering({ invites: 'watch', maxDrivers: 2, proposals: 'members' });
    for (const [options, reason] of [
      [{ label: 'Class', lengthMinutes: 30, drivers: 3 }, 'policy'],
      [{ label: 'Class', lengthMinutes: 30, proposals: 'all' }, 'policy'],
      [{ label: 'Class', lengthMinutes: 29 }, 'invalid'],
      [{ label: 'Class', lengthMinutes: 241 }, 'invalid'],
      [{ label: 'Class', lengthMinutes: 30.5 }, 'invalid'],
      [{ label: 'Class', lengthMinutes: '30' }, 'invalid'],
      [{ label: '', lengthMinutes: 30 }, 'invalid'],
      [{ label: 'Class', lengthMinutes: 30, drivers: 0 }, 'invalid'],
      [{ label: 'Class', lengthMinutes: 30, observers: 41 }, 'invalid'],
      [{ label: 'Class', lengthMinutes: 30, observers: 1.5 }, 'invalid'],
    ] as const) {
      expect(
        await h.dock.startSession(options as Parameters<typeof h.dock.startSession>[0]),
        JSON.stringify(options),
      ).toEqual({ ok: false, reason });
    }
    expect(socket.framesOf('session_start')).toEqual([]);
    expect(h.dock.state.session).toBeNull();
  });

  it('offers none on a relay that sent no session frame, and no observers without invites', async () => {
    const h = setup({ core: { policy: { invites: 'off' } } });
    const socket = await link(h);
    expect(await h.dock.startSession({ label: 'Class', lengthMinutes: 30 })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    socket.deliver({ t: 'session', session: null });
    expect(h.dock.state.sessionsOffered).toBe(true);
    expect(await h.dock.startSession({ label: 'Class', lengthMinutes: 30, observers: 3 })).toEqual({
      ok: false,
      reason: 'policy',
    });
    expect(socket.framesOf('session_start')).toEqual([]);
  });

  it('demotes the drivers past its seats, newest first, before the relay hears of it', async () => {
    const { h, socket } = await offering(
      { invites: 'watch', maxDrivers: 2 },
      [attachment('alice', 'driver', 0), attachment('bob', 'driver', 1000)],
      { alice: 'driver', bob: 'driver' },
    );
    const pending = h.dock.startSession({ label: 'Class', lengthMinutes: 30, drivers: 1 });
    await until(() => socket.framesOf('session_start').length === 1, 'a session_start');
    const sent = socket.frames().map((frame) => frame.t);
    expect(sent.indexOf('set_role')).toBeLessThan(sent.indexOf('session_start'));
    expect(socket.framesOf('set_role')).toEqual([
      { t: 'set_role', userId: 'bob', role: 'observer' },
    ]);
    // A relay that still calls Bob a driver cannot make him one here.
    socket.deliver(
      invoke('set_value', {
        caller: { userId: 'bob', displayName: 'Bob', client: null, role: 'driver' },
      }),
    );
    await flush();
    expect(codes(socket)).toEqual(['role_denied']);
    const [start] = socket.framesOf('session_start');
    if (start === undefined) throw new Error('no session_start');
    expect(start.policy).toEqual({ maxDrivers: 1, proposals: 'off' });
    socket.deliver(listed(start));
    expect((await pending).ok).toBe(true);
  });

  it('narrows only maxDrivers and proposals, leaving every other field as attach() set it', async () => {
    const { h, socket } = await offering({
      invites: 'watch',
      maxDrivers: 2,
      proposals: 'all',
      imageTools: ['get_value'],
      consequentialTools: ['wipe'],
    });
    await started(h, socket, {
      label: 'Class',
      lengthMinutes: 30,
      drivers: 1,
      proposals: 'members',
    });
    expect(h.dock.state.session?.policy).toMatchObject({
      maxDrivers: 1,
      proposals: 'members',
      imageTools: ['get_value'],
      consequentialTools: ['wipe'],
      invites: 'watch',
    });
    // The hello's policy, what the page shows as attach()'s, is unchanged.
    expect(h.dock.state.policy).toMatchObject({ maxDrivers: 2, proposals: 'all' });
  });

  it('adopts no wider policy and no longer end than it asked for, whatever the relay says', async () => {
    const { h, socket } = await offering({ invites: 'watch', maxDrivers: 3, proposals: 'all' });
    const now = h.clock.now;
    const pending = h.dock.startSession({
      label: 'Class',
      lengthMinutes: 30,
      drivers: 1,
      proposals: 'members',
    });
    await until(() => socket.framesOf('session_start').length === 1, 'a session_start');
    const [start] = socket.framesOf('session_start');
    if (start === undefined) throw new Error('no session_start');
    socket.deliver({
      t: 'session',
      session: {
        sessionId: start.sessionId,
        lengthMs: MAX_SESSION_MS,
        remainingMs: MAX_SESSION_MS,
        policy: { maxDrivers: 3, proposals: 'all' },
      },
    });
    expect((await pending).ok).toBe(true);
    expect(h.dock.state.session).toMatchObject({
      endsAt: now + 30 * MINUTE,
      lengthMinutes: 30,
      policy: { maxDrivers: 1, proposals: 'members' },
    });
    // A narrower one, as a smaller ceiling on the relay's side makes it, is taken.
    socket.deliver({
      t: 'session',
      session: {
        sessionId: start.sessionId,
        lengthMs: 30 * MINUTE,
        remainingMs: 30 * MINUTE,
        policy: { maxDrivers: 1, proposals: 'off' },
      },
    });
    await flush();
    expect(h.dock.state.session?.policy).toMatchObject({ maxDrivers: 1, proposals: 'off' });
  });

  it('adopts only a session it started, and ends one it holds no record of: a relay cannot impose one', async () => {
    const { h, socket } = await offering();
    socket.deliver({
      t: 'session',
      session: {
        sessionId: 'ses_foreign',
        lengthMs: 30 * MINUTE,
        remainingMs: 30 * MINUTE,
        policy: { maxDrivers: 1, proposals: 'off' },
      },
    });
    await flush();
    expect(h.dock.state.session).toBeNull();
    expect(h.logs).toContain('warn ended session ses_foreign, which this page holds no record of');
    expect(socket.framesOf('session_end')).toEqual([
      { t: 'session_end', sessionId: 'ses_foreign' },
    ]);
    // Nor swap its own for another: a relay that holds some other session holds none of this page's.
    const { start } = await started(h, socket, { label: 'Class', lengthMinutes: 30 });
    socket.deliver({
      t: 'session',
      session: {
        sessionId: 'ses_foreign',
        lengthMs: 240 * MINUTE,
        remainingMs: 240 * MINUTE,
        policy: { maxDrivers: 1, proposals: 'off' },
      },
    });
    await flush();
    expect(h.dock.state.session).toBeNull();
    expect(h.dock.state.sessionEnded).toMatchObject({
      sessionId: start.sessionId,
      reason: 'relay',
    });
    // Asked once on this link, however often the relay lists it.
    expect(socket.framesOf('session_end')).toEqual([
      { t: 'session_end', sessionId: 'ses_foreign' },
    ]);
  });

  it('ends one the relay still holds after a reload lost the end made here, so the next can start', async () => {
    const storage = new MapStorage();
    const first = await offering(undefined, undefined, undefined, storage);
    const { start } = await started(first.h, first.socket, { label: 'Class', lengthMinutes: 30 });
    // The operator ends it while the relay cannot hear, then the tab reloads.
    first.socket.drop();
    expect(first.h.dock.endSession()).toBe(true);
    expect(first.socket.framesOf('session_end')).toEqual([]);
    first.h.core.close('unload');

    const h = setup({ core: { policy: { invites: 'watch' } }, storage });
    h.core.start();
    const socket = h.socket();
    socket.accept();
    socket.deliver(welcome(h.clock, { resumed: true, roster: [attachment('alice', 'driver')] }));
    socket.deliver(invitesFrame([]));
    socket.deliver(listed(start, 20 * MINUTE));
    socket.deliver(listed(start, 20 * MINUTE));
    await flush();
    expect(h.dock.state.session).toBeNull();
    expect(socket.framesOf('session_end')).toEqual([
      { t: 'session_end', sessionId: start.sessionId },
    ]);
    socket.deliver({
      t: 'session',
      session: null,
      ended: { sessionId: start.sessionId, reason: 'operator' },
    });
    const next = await started(h, socket, { label: 'Next class', lengthMinutes: 30 });
    expect(next.result.ok).toBe(true);
    expect(h.dock.state.session).toMatchObject({ label: 'Next class' });
  });

  it('leaves nothing behind when the relay refuses the start', async () => {
    const { h, socket } = await offering();
    const pending = h.dock.startSession({ label: 'Class', lengthMinutes: 30 });
    await until(() => socket.framesOf('session_start').length === 1, 'a session_start');
    const [start] = socket.framesOf('session_start');
    socket.deliver({
      t: 'session',
      session: null,
      refused: { sessionId: start?.sessionId ?? '', reason: 'active' },
    });
    expect(await pending).toEqual({ ok: false, reason: 'active' });
    expect(h.dock.state.session).toBeNull();
    expect(h.dock.state.sessionEnded).toBeNull();
    expect(h.storage.getItem(SESSION_KEY)).toBeNull();
  });
});

describe("the session's watch invites (ADR 0043, conflict C12)", () => {
  it('mint one for every 20 observers, labelled as the session, ending at its longest', async () => {
    const { h, socket } = await offering();
    const now = h.clock.now;
    const { result } = await started(h, socket, {
      label: 'Class 7B',
      lengthMinutes: 45,
      observers: 25,
    });
    expect(
      socket.framesOf('invite_create').map(({ role, label, uses, expiresAt }) => ({
        role,
        label,
        uses,
        expiresAt,
      })),
    ).toEqual([
      { role: 'observer', label: 'Class 7B', uses: 20, expiresAt: now + MAX_SESSION_MS },
      { role: 'observer', label: 'Class 7B', uses: 5, expiresAt: now + MAX_SESSION_MS },
    ]);
    expect(result.links).toHaveLength(2);
    expect(result.link).toBe(result.links[0]?.link);
    expect(h.dock.state.session).toMatchObject({
      label: 'Class 7B',
      observers: 25,
      inviteIds: result.links.map((entry) => entry.inviteId),
      sponsor: { userId: 'alice', displayName: 'Alice' },
    });
    // S11: the links' secrets are in the result and nowhere the page keeps.
    const stored = h.storage.getItem(SESSION_KEY) ?? '';
    expect(JSON.parse(stored)).not.toHaveProperty('link');
    for (const { link: shown } of result.links) {
      const secret = shown.slice(shown.indexOf('#') + 1);
      for (const where of [
        JSON.stringify([...h.storage.items]),
        JSON.stringify(h.dock.state),
        h.logs.join('\n'),
        socket.sent.join('\n'),
      ]) {
        expect(where).not.toContain(secret);
      }
    }
  });

  it('are minted anew after a reload, the old ones cancelled', async () => {
    const storage = new MapStorage();
    const first = await offering(undefined, undefined, undefined, storage);
    const startedAt = first.h.clock.now;
    const { start, result } = await started(first.h, first.socket, {
      label: 'Class',
      lengthMinutes: 60,
      observers: 5,
    });
    const [old] = result.links;
    const [create] = first.socket.framesOf('invite_create');
    if (old === undefined || create === undefined) throw new Error('no invite');
    first.h.core.close('unload');

    // The reload: the same tab's storage, a resumed page session.
    const h = setup({ core: { policy: { invites: 'watch' } }, storage });
    h.core.start();
    const socket = h.socket();
    socket.accept();
    socket.deliver(welcome(h.clock, { resumed: true, roster: [attachment('alice', 'driver')] }));
    socket.deliver(invitesFrame([listingOf(create)]));
    socket.deliver(listed(start));
    await flush();
    expect(h.dock.state.session).toMatchObject({ label: 'Class', inviteIds: [old.inviteId] });
    const pending = h.dock.renewSessionLink();
    await until(() => socket.framesOf('invite_create').length === 1, 'an invite_create');
    expect(socket.framesOf('invite_cancel')).toEqual([
      { t: 'invite_cancel', inviteId: old.inviteId },
    ]);
    const [renewed] = socket.framesOf('invite_create');
    if (renewed === undefined) throw new Error('no invite_create');
    expect(renewed).toMatchObject({
      label: 'Class',
      uses: 5,
      expiresAt: startedAt + MAX_SESSION_MS,
    });
    socket.deliver(invitesFrame([listingOf(renewed)]));
    const minted = await pending;
    expect(minted.ok).toBe(true);
    expect(h.dock.state.session?.inviteIds).toEqual([renewed.inviteId]);
  });
});

describe("the session's end on the page's own clock (A6.17)", () => {
  async function withGuest() {
    const { h, socket } = await offering();
    // The relay's clock says ten seconds are left, so the page's own end comes then.
    const { start, result } = await started(
      h,
      socket,
      { label: 'Class', lengthMinutes: 30, observers: 3 },
      10_000,
    );
    if (result.link === null) throw new Error('no link');
    const [create] = socket.framesOf('invite_create');
    if (create === undefined) throw new Error('no invite_create');
    const secret = result.link.slice(result.link.indexOf('#') + 1);
    socket.deliver(redemption(h.clock, { inviteId: create.inviteId, secret, create }));
    await until(
      () =>
        socket
          .framesOf('attach_decision')
          .some((frame) => frame.requestId === `redeem-${create.inviteId}`),
      'the join',
    );
    socket.deliver({
      t: 'roster',
      attachments: [
        attachment('alice', 'driver'),
        invitedAttachment(GUEST, 'observer', create.inviteId, h.clock.now + 10_000),
      ],
    });
    const guest = {
      userId: GUEST,
      displayName: 'guest@example.com',
      client: null,
      role: 'observer' as const,
    };
    socket.deliver(invoke('get_value', { callId: 'before', caller: guest }));
    await flush();
    expect(codes(socket)).toEqual(['ok']);
    return { h, socket, start, guest, create, secret };
  }

  it('drops every grant an invite made even when the relay says nothing, then tells it', async () => {
    const { h, socket, start, guest } = await withGuest();
    await h.clock.advance(10_000);
    expect(h.dock.state.session).toBeNull();
    expect(h.dock.state.sessionEnded).toMatchObject({ sessionId: start.sessionId, reason: 'time' });
    socket.deliver(invoke('get_value', { callId: 'after', caller: guest }));
    await flush();
    expect(codes(socket)).toEqual(['ok', 'role_denied']);
    expect(h.dock.state.invites).toEqual([]);
    // The relay's own end gets SESSION_END_GRACE_MS to come first; it did not.
    expect(socket.framesOf('session_end')).toEqual([]);
    await h.clock.advance(SESSION_END_GRACE_MS);
    expect(socket.framesOf('session_end')).toEqual([
      { t: 'session_end', sessionId: start.sessionId },
    ]);
  });

  it('refuses the guest, and anyone redeeming its link, once its end has passed, before its timer has run', async () => {
    const { h, socket, guest, create, secret } = await withGuest();
    // The clock moves with no timer run, as in a tab the browser froze.
    h.clock.now += 10_000;
    socket.deliver(invoke('get_value', { callId: 'late', caller: guest }));
    await flush();
    expect(codes(socket)).toEqual(['ok', 'role_denied']);
    // The link has uses left and its own four hours, but the session it was minted for is over.
    socket.deliver(
      redemption(
        h.clock,
        { inviteId: create.inviteId, secret, create },
        { requestId: 'late-join', user: { userId: OTHER_GUEST, displayName: 'late@example.com' } },
      ),
    );
    await until(
      () => socket.framesOf('attach_decision').some((frame) => frame.requestId === 'late-join'),
      'the late redemption answered',
    );
    expect(socket.framesOf('attach_decision').at(-1)).toEqual({
      t: 'attach_decision',
      requestId: 'late-join',
      allow: false,
    });
  });

  it("says nothing more when the relay's own end comes within the grace", async () => {
    const { h, socket, start } = await withGuest();
    await h.clock.advance(10_000);
    socket.deliver({
      t: 'session',
      session: null,
      ended: { sessionId: start.sessionId, reason: 'time' },
    });
    await h.clock.advance(SESSION_END_GRACE_MS);
    expect(socket.framesOf('session_end')).toEqual([]);
  });

  it("ends at the relay's word, dropping the grants, and tells it nothing back", async () => {
    const { h, socket, start, guest } = await withGuest();
    socket.deliver({
      t: 'session',
      session: null,
      ended: { sessionId: start.sessionId, reason: 'operator' },
    });
    await flush();
    expect(h.dock.state.sessionEnded).toMatchObject({ reason: 'operator' });
    socket.deliver(invoke('get_value', { callId: 'after', caller: guest }));
    await flush();
    expect(codes(socket)).toEqual(['ok', 'role_denied']);
    await h.clock.advance(SESSION_END_GRACE_MS);
    expect(socket.framesOf('session_end')).toEqual([]);
    // Gone for good: a relay that drops the guest and then lists them again gets them nothing.
    socket.deliver({ t: 'roster', attachments: [attachment('alice', 'driver')] });
    socket.deliver({
      t: 'roster',
      attachments: [
        attachment('alice', 'driver'),
        invitedAttachment(GUEST, 'observer', 'inv_any', h.clock.now + 10_000),
      ],
    });
    socket.deliver(invoke('get_value', { callId: 'again', caller: guest }));
    await flush();
    expect(codes(socket)).toEqual(['ok', 'role_denied', 'role_denied']);
  });

  it("ends at once on the operator's End, telling the relay", async () => {
    const { h, socket, start } = await withGuest();
    expect(h.dock.endSession()).toBe(true);
    expect(socket.framesOf('session_end')).toEqual([
      { t: 'session_end', sessionId: start.sessionId },
    ]);
    expect(h.dock.state.sessionEnded).toMatchObject({ reason: 'operator' });
    expect(h.dock.endSession()).toBe(false);
  });
});

describe('a session across page sessions', () => {
  it('is dropped when the relay starts a new page session, and kept when it resumes', async () => {
    const stored = {
      pageId: 'page-1',
      sessionId: 'ses_kept',
      label: 'Class',
      startedAt: Date.UTC(2026, 9, 2, 12, 0, 0),
      endsAt: Date.UTC(2026, 9, 2, 12, 30, 0),
      lengthMs: 30 * MINUTE,
      policy: { maxDrivers: 1, proposals: 'off' },
      observers: 0,
      inviteIds: [],
    };
    const fresh = new MapStorage();
    fresh.setItem(SESSION_KEY, JSON.stringify(stored));
    const h = setup({ storage: fresh });
    await link(h, { pageId: 'page-2' });
    expect(h.dock.state.session).toBeNull();
    expect(h.dock.state.sessionEnded).toMatchObject({ sessionId: 'ses_kept', reason: 'relay' });
    expect(fresh.getItem(SESSION_KEY)).toBeNull();

    const kept = new MapStorage();
    kept.setItem(SESSION_KEY, JSON.stringify(stored));
    const again = setup({ storage: kept });
    const socket = await link(again, { resumed: true });
    expect(again.dock.state.session).toMatchObject({ sessionId: 'ses_kept', label: 'Class' });
    socket.deliver({
      t: 'session',
      session: {
        sessionId: 'ses_kept',
        lengthMs: 30 * MINUTE,
        remainingMs: 20 * MINUTE,
        policy: { maxDrivers: 1, proposals: 'off' },
      },
    });
    await flush();
    expect(again.dock.state.session).toMatchObject({ endsAt: again.clock.now + 20 * MINUTE });
    // A stored record holding a link is no record (StoredSessionSchema is strict).
    const tampered = new MapStorage();
    tampered.setItem(SESSION_KEY, JSON.stringify({ ...stored, link: 'https://relay.example/i#x' }));
    const third = setup({ storage: tampered });
    await link(third, { resumed: true });
    expect(third.dock.state.session).toBeNull();
    expect(third.logs).toContain('warn ignored a stored session that did not parse');
  });

  it('extends only through the relay, and only the operator', async () => {
    const { h, socket } = await offering();
    const { start } = await started(h, socket, { label: 'Class', lengthMinutes: 30 });
    expect(h.dock.extendSession(0)).toBe(false);
    expect(h.dock.extendSession(211)).toBe(false);
    expect(h.dock.extendSession(15)).toBe(true);
    expect(socket.framesOf('session_extend')).toEqual([
      { t: 'session_extend', sessionId: start.sessionId, lengthMs: 45 * MINUTE },
    ]);
    // Not longer until the relay says so.
    expect(h.dock.state.session?.lengthMinutes).toBe(30);
    socket.deliver({
      t: 'session',
      session: {
        sessionId: start.sessionId,
        lengthMs: 45 * MINUTE,
        remainingMs: 45 * MINUTE,
        policy: start.policy,
      },
    });
    await flush();
    expect(h.dock.state.session?.lengthMinutes).toBe(45);
  });
});

// Every frame the page sent stays a valid one, so the harness's parse covers the session frames too.
describe('the session frames', () => {
  it('parse as the protocol says', async () => {
    const { h, socket } = await offering();
    await started(h, socket, { label: 'Class', lengthMinutes: 30 });
    h.dock.endSession();
    expect(() => socket.frames()).not.toThrow();
  });
});

// Time-boxed sessions on the relay (ADR 0043; A6.15 and A6.16): a session the
// page's operator starts narrows its policy only within the hello's, demotes
// the drivers past its seats newest first, and at its end, on the relay's own
// clock whatever its timer, ends every invite-made attachment with its calls
// and every live invite, and the page's own policy returns. Against the relay
// in public URL mode with the stand-in provider, two members and invitees who
// sign up; the page is the test's own stand-in, never the adapter, so each
// test shows what the relay alone does.

import { MAX_INVITE_LIFETIME_MS, type PolicyInput } from '@tabdock/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachMember,
  call,
  type InviteRelay,
  joinAtI,
  latest,
  mintOk,
  signedInAtI,
  startInviteRelay,
} from './helpers/invites.ts';
import { AgentTokens } from '../src/agents.ts';
import { OPERATOR_GRANTS_PER_PAGE } from '../src/hub.ts';
import { PageParts } from '../src/page-parts.ts';
import { connectPage, type TestPage } from './helpers/page-client.ts';

let current: InviteRelay | undefined;

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await current?.close();
  current = undefined;
});

async function setup(options: Parameters<typeof startInviteRelay>[0] = {}): Promise<InviteRelay> {
  current = await startInviteRelay(options);
  return current;
}

const MINUTE = 60_000;
const GUEST = 'sub-guest';
const GUEST_EMAIL = 'guest@example.com';

type Policy = { maxDrivers: number; proposals: 'off' | 'members' | 'all' };

/** Starts a session on the page and returns the relay's answer to it. */
async function start(page: TestPage, sessionId: string, policy: Policy, minutes = 30) {
  page.send({ t: 'session_start', sessionId, lengthMs: minutes * MINUTE, policy });
  return latest(page, 'session');
}

function events(relay: InviteRelay, type: string): Record<string, unknown>[] {
  return relay.relay.audit
    .events()
    .filter((event) => event.type === type)
    .map((event) => ({ ...event }));
}

const getView = (page: string) => ({ page, tool: 'get_view', arguments: {} });
const addItem = (page: string) => ({ page, tool: 'add_item', arguments: { label: 'x' } });

/** A page sharing watch invites, Alice attached as its driver, and a guest let in by a watch invite. */
async function classroom(policy: Record<string, unknown> = {}) {
  const relay = await setup();
  const page = await relay.page({ policy: { invites: 'watch', ...policy } });
  const alice = await relay.claude('sub-alice');
  await attachMember(alice, page);
  return { relay, page, alice };
}

/** The page reloading after its socket went: a new one that resumes its page session under `policy`. */
async function resumeOf(
  relay: InviteRelay,
  page: TestPage,
  policy: PolicyInput,
): Promise<TestPage> {
  const reloaded = await connectPage(relay.relay.pageUrl, {
    resumeToken: page.welcome?.resumeToken ?? '',
    policy,
  });
  relay.pages.push(reloaded);
  expect(reloaded.welcome?.resumed).toBe(true);
  return reloaded;
}

/**
 * AgentTokens.closePage as the hub calls it, answering `closed`: each call's
 * page and reason, and whether `guest`'s invite-made attachment was still
 * there then. ADR 0044's tokens come with W2-D, so this stands in for them.
 */
function watchTokenCloses(relay: InviteRelay, guest: string, closed: number) {
  const calls: { pageId: string; reason: string; guestAttached: boolean }[] = [];
  vi.spyOn(AgentTokens.prototype, 'closePage').mockImplementation((pageId, reason) => {
    calls.push({
      pageId,
      reason,
      guestAttached: relay.store.attachments.get(pageId, guest) !== undefined,
    });
    return closed;
  });
  return calls;
}

/** A guest joins at /i with a signed-in browser, as a session's QR is scanned, then calls from Claude. */
async function letGuestIn(relay: InviteRelay, page: TestPage, secret: string, sub = GUEST) {
  const phone = await signedInAtI(relay, sub, GUEST_EMAIL);
  const { request, settled } = await joinAtI(phone, page, secret, {
    allow: true,
    role: 'observer',
  });
  expect(settled.status).toBe('approved');
  return { guest: await relay.claude(sub, GUEST_EMAIL), userId: request.user.userId };
}

describe('a session follows every welcome (ADR 0043)', () => {
  it('as session null on a page that has none', async () => {
    const relay = await setup();
    const page = await relay.page();
    expect(page.all('session')).toEqual([{ t: 'session', session: null }]);
  });
});

describe('S5: a session only narrows the page policy', () => {
  it('is refused, never clamped, when wider than the hello allows, and the policy stays', async () => {
    const { relay, page } = await classroom({ maxDrivers: 1, proposals: 'members' });
    for (const policy of [
      { maxDrivers: 2, proposals: 'members' },
      { maxDrivers: 1, proposals: 'all' },
    ] as const) {
      const answer = await start(page, 'ses_wide', policy);
      expect(answer).toEqual({
        t: 'session',
        session: null,
        refused: { sessionId: 'ses_wide', reason: 'policy' },
      });
    }
    expect(relay.store.pages.get(page.pageId)?.timedSession).toBeNull();
    expect(relay.store.pages.get(page.pageId)?.policy).toMatchObject({
      maxDrivers: 1,
      proposals: 'members',
    });
    // Still one driver seat: Bob, asking to drive, is seated as an observer.
    await attachMember(await relay.claude('sub-bob'), page, 'driver');
    expect((await latest(page, 'roster')).attachments).toMatchObject([
      { userId: 'alice', role: 'driver' },
      { userId: 'bob', role: 'observer' },
    ]);
    expect(events(relay, 'session_start')).toEqual([]);
  });

  it('demotes the drivers past its seats, newest first, until its end', async () => {
    const { relay, page } = await classroom({ maxDrivers: 2 });
    const bob = await relay.claude('sub-bob');
    await attachMember(bob, page, 'driver');
    const answer = await start(page, 'ses_one', { maxDrivers: 1, proposals: 'off' });
    expect(answer.session).toMatchObject({
      sessionId: 'ses_one',
      lengthMs: 30 * MINUTE,
      policy: { maxDrivers: 1, proposals: 'off' },
    });
    expect(answer.session?.remainingMs).toBeGreaterThan(29 * MINUTE);
    expect((await latest(page, 'roster')).attachments).toMatchObject([
      { userId: 'alice', role: 'driver' },
      { userId: 'bob', role: 'observer' },
    ]);
    expect(events(relay, 'role')).toEqual([
      expect.objectContaining({ userId: 'bob', role: 'observer', previous: 'driver' }),
    ]);
    expect(events(relay, 'session_start')).toEqual([
      expect.objectContaining({
        sessionId: 'ses_one',
        lengthMs: 30 * MINUTE,
        maxDrivers: 1,
        proposals: 'off',
        demoted: 1,
      }),
    ]);
    // The relay holds Bob to it: his write is refused before it reaches the page.
    const write = await call(bob, 'call_page_tool', addItem(page.pageId));
    expect(write.text).toMatch(/^role_denied: /);
    // Making him a driver again is capped at the session's one seat.
    page.send({ t: 'set_role', userId: 'bob', role: 'driver' });
    expect((await latest(page, 'roster')).attachments).toMatchObject([
      { userId: 'alice', role: 'driver' },
      { userId: 'bob', role: 'observer' },
    ]);
    // Its end gives the page its own two seats back; nobody is promoted unasked.
    page.send({ t: 'session_end', sessionId: 'ses_one' });
    expect(await latest(page, 'session')).toEqual({
      t: 'session',
      session: null,
      ended: { sessionId: 'ses_one', reason: 'operator' },
    });
    expect((await latest(page, 'roster')).attachments).toMatchObject([
      { userId: 'alice', role: 'driver' },
      { userId: 'bob', role: 'observer' },
    ]);
    page.send({ t: 'set_role', userId: 'bob', role: 'driver' });
    expect((await latest(page, 'roster')).attachments).toMatchObject([
      { userId: 'alice', role: 'driver' },
      { userId: 'bob', role: 'driver' },
    ]);
    expect(relay.store.pages.get(page.pageId)?.policy).toMatchObject({ maxDrivers: 2 });
  });

  it('refuses a second session while one is live, and answers its own start again', async () => {
    const { page } = await classroom();
    await start(page, 'ses_a', { maxDrivers: 1, proposals: 'off' });
    expect((await start(page, 'ses_b', { maxDrivers: 1, proposals: 'off' })).refused).toEqual({
      sessionId: 'ses_b',
      reason: 'active',
    });
    const again = await start(page, 'ses_a', { maxDrivers: 1, proposals: 'off' });
    expect(again.session?.sessionId).toBe('ses_a');
    expect(again.refused).toBeUndefined();
  });
});

describe('S8 and S14: a session end ends what its invites let in', () => {
  it('cancels an invitee call in flight, closes every invite and keeps the members', async () => {
    const { relay, page, alice } = await classroom();
    await start(page, 'ses_end', { maxDrivers: 1, proposals: 'off' });
    const minted = await mintOk(page, { uses: 5, label: 'Class' });
    const { guest, userId } = await letGuestIn(relay, page, minted.secret);
    page.onInvoke = (frame) =>
      frame.caller.userId === userId ? undefined : { ok: true, content: 'answered' };
    const pending = call(guest, 'call_page_tool', getView(page.pageId));
    const invoke = await page.next('invoke');
    expect(invoke.caller.userId).toBe(userId);

    page.send({ t: 'session_end', sessionId: 'ses_end' });
    expect(await page.next('cancel')).toEqual({
      t: 'cancel',
      callId: invoke.callId,
      reason: 'revoked',
    });
    expect((await pending).text).toBe(
      'not_attached: the time-boxed session you joined by invite has ended',
    );
    expect((await latest(page, 'roster')).attachments.map((entry) => entry.userId)).toEqual([
      'alice',
    ]);
    expect((await latest(page, 'invites')).invites).toEqual([]);
    expect(await latest(page, 'session')).toMatchObject({
      session: null,
      ended: { sessionId: 'ses_end', reason: 'operator' },
    });
    // The member keeps the page.
    expect((await call(alice, 'call_page_tool', getView(page.pageId))).isError).toBe(false);
    expect(events(relay, 'expire')).toEqual([
      expect.objectContaining({ userId, reason: 'session_ended' }),
    ]);
    expect(events(relay, 'invite_closed')).toEqual([
      expect.objectContaining({ inviteId: minted.inviteId, reason: 'session_ended' }),
    ]);
    expect(events(relay, 'session_end')).toEqual([
      expect.objectContaining({
        sessionId: 'ses_end',
        reason: 'operator',
        attachments: 1,
        invites: 1,
        agents: 0,
      }),
    ]);
    // An end for a session that is no longer live changes nothing more.
    page.send({ t: 'session_end', sessionId: 'ses_end' });
    await page.sync();
    expect(events(relay, 'session_end')).toHaveLength(1);
  });

  it("closes the page's agent tokens as session_ended before any attachment its invites made, and counts them (C11)", async () => {
    const { relay, page } = await classroom();
    await start(page, 'ses_tokens', { maxDrivers: 1, proposals: 'off' });
    const minted = await mintOk(page, { uses: 5 });
    const { userId } = await letGuestIn(relay, page, minted.secret);
    const closes = watchTokenCloses(relay, userId, 2);
    page.send({ t: 'session_end', sessionId: 'ses_tokens' });
    expect((await latest(page, 'session')).ended).toEqual({
      sessionId: 'ses_tokens',
      reason: 'operator',
    });
    // First, so a token's close ends the attachment it made as the session's
    // end, and a token not yet used closes all the same.
    expect(closes).toEqual([{ pageId: page.pageId, reason: 'session_ended', guestAttached: true }]);
    expect(relay.store.attachments.get(page.pageId, userId)).toBeUndefined();
    expect(events(relay, 'session_end')).toEqual([
      expect.objectContaining({ attachments: 1, invites: 1, agents: 2 }),
    ]);
  });

  it('caps the invites and invite-made attachments already live when it starts at its end', async () => {
    const { relay, page } = await classroom();
    const minted = await mintOk(page, { uses: 5, expiresAt: Date.now() + 4 * 60 * MINUTE });
    const { userId } = await letGuestIn(relay, page, minted.secret);
    const before = (await latest(page, 'roster')).attachments.find((a) => a.userId === userId);
    expect(before?.endsAt).toBeGreaterThan(Date.now() + 23 * 60 * MINUTE);
    await start(page, 'ses_after', { maxDrivers: 1, proposals: 'off' });
    const endsAt = relay.store.pages.get(page.pageId)?.timedSession?.endsAt;
    expect(endsAt).toBeLessThan(Date.now() + 31 * MINUTE);
    expect(relay.store.invites.get(page.pageId, minted.inviteId)?.expiresAt).toBe(endsAt);
    const joined = (await latest(page, 'roster')).attachments.find((a) => a.userId === userId);
    expect(joined?.endsAt).toBe(endsAt);
    expect(joined?.expiresAt).toBeLessThanOrEqual(endsAt ?? 0);
  });

  it('ends on the relay clock at its end, with its timer not yet run', async () => {
    const { relay, page } = await classroom();
    await start(page, 'ses_late', { maxDrivers: 1, proposals: 'off' });
    // Minted for four hours: the session caps it at its own end.
    const minted = await mintOk(page, { uses: 5, expiresAt: Date.now() + 4 * 60 * MINUTE });
    const session = relay.store.pages.get(page.pageId)?.timedSession;
    const invite = relay.store.invites.get(page.pageId, minted.inviteId);
    expect(invite?.expiresAt).toBe(session?.endsAt);
    expect(invite?.ownExpiresAt).toBeGreaterThan((session?.endsAt ?? 0) + 3 * 60 * MINUTE);
    const { guest, userId } = await letGuestIn(relay, page, minted.secret);
    const joined = (await latest(page, 'roster')).attachments.find((a) => a.userId === userId);
    expect(joined?.endsAt).toBe(session?.endsAt);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime((session?.endsAt ?? 0) + 1000);
    expect((await call(guest, 'call_page_tool', getView(page.pageId))).text).toMatch(
      /^not_attached: /,
    );
    const late = await signedInAtI(relay, 'sub-late', 'late@example.com');
    expect(await late.post('/i/claim', { secret: minted.secret })).toMatchObject({
      status: 404,
      data: { error: 'pairing_expired' },
    });
    expect(events(relay, 'session_end')).toEqual([
      expect.objectContaining({ sessionId: 'ses_late', reason: 'time', attachments: 1 }),
    ]);
    expect(events(relay, 'invite_closed')).toEqual([
      expect.objectContaining({ inviteId: minted.inviteId, reason: 'session_ended' }),
    ]);
    expect(relay.store.pages.get(page.pageId)?.timedSession).toBeNull();
  });

  it('lengthens within four hours of its start, moving the ends it capped, and refuses the rest', async () => {
    const { relay, page } = await classroom();
    const first = await start(page, 'ses_long', { maxDrivers: 1, proposals: 'off' });
    const minted = await mintOk(page, { uses: 5 });
    const { userId } = await letGuestIn(relay, page, minted.secret);
    page.send({ t: 'session_extend', sessionId: 'ses_long', lengthMs: 45 * MINUTE });
    const longer = await latest(page, 'session');
    expect(longer.session?.lengthMs).toBe(45 * MINUTE);
    expect(longer.session?.remainingMs).toBeGreaterThan(
      (first.session?.remainingMs ?? 0) + 14 * MINUTE,
    );
    const session = relay.store.pages.get(page.pageId)?.timedSession;
    expect(session?.endsAt).toBe((session?.startedAt ?? 0) + 45 * MINUTE);
    const guestAttachment = relay.store.attachments.get(page.pageId, userId);
    expect(guestAttachment?.endsAt).toBe(session?.endsAt);
    expect(relay.store.invites.get(page.pageId, minted.inviteId)?.expiresAt).toBe(session?.endsAt);
    expect(events(relay, 'session_extend')).toEqual([
      expect.objectContaining({ sessionId: 'ses_long', lengthMs: 45 * MINUTE }),
    ]);

    for (const [frame, reason] of [
      [{ sessionId: 'ses_long', lengthMs: 45 * MINUTE }, 'length'],
      [{ sessionId: 'ses_long', lengthMs: 40 * MINUTE }, 'length'],
      [{ sessionId: 'ses_other', lengthMs: 60 * MINUTE }, 'unknown'],
    ] as const) {
      page.send({ t: 'session_extend', ...frame });
      expect((await latest(page, 'session')).refused).toEqual({
        sessionId: frame.sessionId,
        reason,
      });
    }
    // More than four hours from its start is a malformed frame.
    page.send({ t: 'session_extend', sessionId: 'ses_long', lengthMs: 241 * MINUTE });
    expect((await page.closed).code).toBe(1008);
  });

  it('never moves an attachment past its own 24 hours from redemption (S14)', async () => {
    const { relay, page } = await classroom();
    const minted = await mintOk(page, { uses: 5 });
    const { userId } = await letGuestIn(relay, page, minted.secret);
    await start(page, 'ses_day', { maxDrivers: 1, proposals: 'off' });
    const firstEnd = relay.store.pages.get(page.pageId)?.timedSession?.endsAt ?? 0;
    // As if the guest had redeemed 23.5 hours ago: their own 24 hours end
    // just as the session's first 30 minutes do.
    const guest = relay.store.attachments.get(page.pageId, userId);
    if (guest === undefined) throw new Error('the guest is not attached');
    relay.store.attachments.put({
      ...guest,
      grantedAt: firstEnd - MAX_INVITE_LIFETIME_MS,
      endsAt: firstEnd,
    });
    page.send({ t: 'session_extend', sessionId: 'ses_day', lengthMs: 45 * MINUTE });
    expect((await latest(page, 'session')).session?.lengthMs).toBe(45 * MINUTE);
    expect(relay.store.pages.get(page.pageId)?.timedSession?.endsAt).toBe(firstEnd + 15 * MINUTE);
    expect(relay.store.attachments.get(page.pageId, userId)?.endsAt).toBe(firstEnd);
  });

  it("counts starts and extensions against the page's operator grants", async () => {
    const { relay, page } = await classroom();
    // Approving Alice took none of them; this start takes one.
    await start(page, 'ses_grants', { maxDrivers: 1, proposals: 'off' });
    for (let i = 1; i < OPERATOR_GRANTS_PER_PAGE; i += 1) {
      page.send({ t: 'session_extend', sessionId: 'ses_grants', lengthMs: (30 + i) * MINUTE });
      expect((await latest(page, 'session')).refused, String(i)).toBeUndefined();
    }
    page.send({ t: 'session_extend', sessionId: 'ses_grants', lengthMs: 60 * MINUTE });
    expect((await latest(page, 'session')).refused).toEqual({
      sessionId: 'ses_grants',
      reason: 'limit',
    });
    expect(relay.store.pages.get(page.pageId)?.timedSession?.lengthMs).toBe(
      (30 + OPERATOR_GRANTS_PER_PAGE - 1) * MINUTE,
    );
  });
});

describe('a session across the page link', () => {
  it('survives a resume, and a smaller ceiling on reload narrows it further', async () => {
    const relay = await setup();
    const wide = { invites: 'watch', maxDrivers: 3, proposals: 'all' } as const;
    const page = await relay.page({ policy: wide });
    await attachMember(await relay.claude('sub-alice'), page);
    await attachMember(await relay.claude('sub-bob'), page, 'driver');
    await start(page, 'ses_resume', { maxDrivers: 2, proposals: 'members' });
    page.ws.terminate();
    await page.closed;
    const reloaded = await connectPage(relay.relay.pageUrl, {
      resumeToken: page.welcome?.resumeToken ?? '',
      policy: { ...wide, maxDrivers: 1 },
    });
    relay.pages.push(reloaded);
    expect(reloaded.welcome?.resumed).toBe(true);
    // Bob, the newer driver, is an observer before the welcome lists anyone.
    expect(reloaded.welcome?.roster).toMatchObject([
      { userId: 'alice', role: 'driver' },
      { userId: 'bob', role: 'observer' },
    ]);
    const told = await reloaded.next('session');
    expect(told.session).toMatchObject({
      sessionId: 'ses_resume',
      policy: { maxDrivers: 1, proposals: 'members' },
    });
    expect(relay.store.pages.get(page.pageId)).toMatchObject({
      ceiling: { maxDrivers: 1, proposals: 'all' },
      policy: { maxDrivers: 1, proposals: 'members' },
      timedSession: { sessionId: 'ses_resume', policy: { maxDrivers: 1, proposals: 'members' } },
    });
  });

  it('ends as page_gone once its page is gone, once, before the attachments go', async () => {
    const relay = await setup({ timings: { resumeWindowMs: 300 } });
    const page = await relay.page({ policy: { invites: 'watch' } });
    await attachMember(await relay.claude('sub-alice'), page);
    await start(page, 'ses_gone', { maxDrivers: 1, proposals: 'off' });
    const minted = await mintOk(page, { uses: 5 });
    const { userId } = await letGuestIn(relay, page, minted.secret);
    const endsAt = relay.store.pages.get(page.pageId)?.timedSession?.endsAt ?? 0;
    const closes = watchTokenCloses(relay, userId, 1);
    page.ws.terminate();
    await page.closed;
    await vi.waitFor(() => {
      expect(relay.store.pages.get(page.pageId)?.state).toBe('gone');
    });
    expect(events(relay, 'session_end')).toEqual([
      expect.objectContaining({ reason: 'page_gone', attachments: 1, invites: 1, agents: 1 }),
    ]);
    expect(closes).toEqual([{ pageId: page.pageId, reason: 'page_gone', guestAttached: true }]);
    expect(events(relay, 'expire').map((event) => event.reason)).toEqual([
      'page_gone',
      'page_gone',
    ]);
    // Its timer went with it: past the original end nothing more is written.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(endsAt + 1000);
    expect(await call(await relay.claude('sub-alice'), 'list_pages')).toMatchObject({
      isError: false,
    });
    expect(events(relay, 'session_end')).toHaveLength(1);
  });

  it('tells a page that slept through its end once, after its next welcome', async () => {
    const policy = { invites: 'watch' } as const;
    const relay = await setup();
    const page = await relay.page({ policy });
    const alice = await relay.claude('sub-alice');
    await attachMember(alice, page);
    await start(page, 'ses_slept', { maxDrivers: 1, proposals: 'off' });
    const minted = await mintOk(page, { uses: 5 });
    const { userId } = await letGuestIn(relay, page, minted.secret);
    const endsAt = relay.store.pages.get(page.pageId)?.timedSession?.endsAt ?? 0;
    page.ws.terminate();
    await page.closed;
    await vi.waitFor(() => {
      expect(relay.store.pages.get(page.pageId)?.state).toBe('asleep');
    });
    // Its end passes while the page sleeps, and a member's read ends it on the relay's clock.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(endsAt + 1000);
    expect(await call(alice, 'list_pages')).toMatchObject({ isError: false });
    expect(events(relay, 'session_end')).toEqual([
      expect.objectContaining({ sessionId: 'ses_slept', reason: 'time', attachments: 1 }),
    ]);
    expect(relay.store.attachments.get(page.pageId, userId)).toBeUndefined();

    const reloaded = await resumeOf(relay, page, policy);
    expect(reloaded.welcome?.roster.map((entry) => entry.userId)).toEqual(['alice']);
    expect(await reloaded.next('session')).toEqual({
      t: 'session',
      session: null,
      ended: { sessionId: 'ses_slept', reason: 'time' },
    });
    // Told once: the welcome after that says only that none is live.
    reloaded.ws.terminate();
    await reloaded.closed;
    const again = await resumeOf(relay, reloaded, policy);
    expect(await again.next('session')).toEqual({ t: 'session', session: null });
  });

  it('tells the page parts its policy changed at its start, at a narrowing resume and at its end', async () => {
    const changed = vi.spyOn(PageParts.prototype, 'policyChanged');
    const relay = await setup();
    const wide = { invites: 'watch', maxDrivers: 3, proposals: 'all' } as const;
    const page = await relay.page({ policy: wide });
    await attachMember(await relay.claude('sub-alice'), page);
    expect(changed).not.toHaveBeenCalled();
    await start(page, 'ses_parts', { maxDrivers: 2, proposals: 'members' });
    expect(changed.mock.calls).toEqual([[page.pageId]]);
    // The same ceiling again narrows nothing, so says nothing.
    page.ws.terminate();
    await page.closed;
    const same = await resumeOf(relay, page, wide);
    await same.next('session');
    expect(changed).toHaveBeenCalledTimes(1);
    // A smaller one narrows the session, so the parts hear of it.
    same.ws.terminate();
    await same.closed;
    const smaller = await resumeOf(relay, same, { ...wide, proposals: 'off' });
    expect((await smaller.next('session')).session?.policy).toEqual({
      maxDrivers: 2,
      proposals: 'off',
    });
    expect(changed).toHaveBeenCalledTimes(2);
    smaller.send({ t: 'session_end', sessionId: 'ses_parts' });
    expect((await latest(smaller, 'session')).ended?.reason).toBe('operator');
    expect(changed.mock.calls).toEqual([[page.pageId], [page.pageId], [page.pageId]]);
  });

  it('spends the budget for frames that change nothing on an end for no live session, never the link', async () => {
    const relay = await setup({ rateLimits: { ignoredFramesPerSocket: 2 } });
    const page = await relay.page();
    for (let i = 0; i < 5; i += 1) page.send({ t: 'session_end', sessionId: 'ses_none' });
    await page.sync();
    expect(page.ws.readyState).toBe(page.ws.OPEN);
    await relay.close();
    const held = relay
      .events()
      .filter((event) => event.msg === 'page frames that changed nothing went unlogged');
    expect(held).toHaveLength(1);
    expect((held[0]?.frames as Record<string, number>).session_end).toBe(3);
  });
});

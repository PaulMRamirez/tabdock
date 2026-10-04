// S14, one clause at a time (SPEC section 9; ADRs 0016 and 0017), against the
// relay in public URL mode with the stand-in provider, two members (Alice and
// Bob) and invitees who sign up there. The page is the test's own stand-in, not
// the adapter, so each test shows what the relay itself does: the adapter's
// half (its own record, the presented secret) is workstream B's. Here a page
// answers every attach request itself, which is what shows that the relay
// never grants an invite-made attachment without that answer.

import {
  AuditEventSchema,
  INVITE_BURN_REFUSALS,
  MAX_INVITE_LIFETIME_MS,
  MAX_LIVE_INVITES_PER_PAGE,
  MIN_INVITE_REMAINING_MS,
} from '@tabdock/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPERATOR_GRANTS_PER_PAGE } from '../src/hub.ts';
import { DEFAULT_RATE_LIMITS, emailBarDigest } from '../src/index.ts';
import {
  type AttachRequestFrame,
  attachMember,
  call,
  type InviteRelay,
  joinAtI,
  latest,
  LINK_BASE,
  MEMBERS,
  mint,
  mintOk,
  newSecret,
  redeem,
  settledAtI,
  signedInAtI,
  startInviteRelay,
} from './helpers/invites.ts';
import { connectPage } from './helpers/page-client.ts';
import { Phone } from './helpers/phone.ts';
import { startRelay, type TestRelay } from './helpers/relay.ts';

let current: InviteRelay | undefined;
let plain: TestRelay | undefined;

afterEach(async () => {
  vi.useRealTimers();
  await current?.close();
  current = undefined;
  await plain?.close();
  plain = undefined;
});

async function setup(options: Parameters<typeof startInviteRelay>[0] = {}): Promise<InviteRelay> {
  current = await startInviteRelay(options);
  return current;
}

const GUEST = 'sub-guest';
const GUEST_EMAIL = 'guest@example.com';
/**
 * The window a page's promotions and mints count in (OPERATOR_GRANTS_PER_PAGE);
 * a mint past them is refused as `limit`, as one past the live limit is.
 */
const GRANT_WINDOW_MS = DEFAULT_RATE_LIMITS.windowMs;

/** A relay, a page that allows control invites, and Alice attached as its driver. */
async function sharedPage(options: Parameters<typeof startInviteRelay>[0] = {}) {
  const relay = await setup(options);
  const page = await relay.page({ policy: { invites: 'all' } });
  const alice = await relay.claude('sub-alice');
  await attachMember(alice, page);
  return { relay, page, alice };
}

const getView = (pageId: string) => ({ page: pageId, tool: 'get_view' });

describe('S14: minted only while an allowlisted sponsor is attached', () => {
  it('refuses with nobody attached, and sends the invites right after every welcome', async () => {
    const relay = await setup();
    const page = await relay.page({ policy: { invites: 'all' } });
    expect(page.all('invites')).toEqual([{ t: 'invites', linkBase: LINK_BASE, invites: [] }]);
    const refused = await mint(page);
    expect(refused.answer.refused).toEqual({ inviteId: refused.inviteId, reason: 'no_sponsor' });
    expect(refused.answer.invites).toEqual([]);
  });

  it('refuses while only an invitee is attached: an invitee sponsors nothing', async () => {
    const relay = await setup();
    const page = await relay.page({ policy: { invites: 'all' } });
    relay.store.attachments.put({
      pageId: page.pageId,
      userId: `g_${'a'.repeat(32)}`,
      displayName: GUEST_EMAIL,
      kind: 'invitee',
      role: 'observer',
      grantedAt: Date.now(),
      lastUsedAt: null,
      expiresAt: null,
      clients: [],
      inviteId: null,
      endsAt: null,
      inviteRole: null,
      sponsorId: null,
      emailHash: null,
    });
    expect((await mint(page)).answer.refused?.reason).toBe('no_sponsor');
  });

  it('names the member attached longest as the sponsor, for good', async () => {
    const relay = await setup();
    const page = await relay.page({ policy: { invites: 'all' } });
    const bob = await relay.claude('sub-bob');
    await attachMember(bob, page, 'observer');
    const alice = await relay.claude('sub-alice');
    await attachMember(alice, page);
    const minted = await mintOk(page);
    expect(minted.answer.invites).toEqual([
      {
        inviteId: minted.inviteId,
        role: 'observer',
        label: 'Friends',
        uses: 1,
        expiresAt: expect.any(Number) as number,
        usesLeft: 1,
        sponsor: { userId: 'bob', displayName: 'Bob' },
        pending: false,
        refusals: 0,
      },
    ]);
  });

  it.each(['Carol is', 'nobody else is'] as const)(
    'passes over a member whose own sponsor is past their end before the timer runs, when %s attached',
    async (others) => {
      // Bob, let in by Alice's invite, calls halfway through, so his own end
      // moves on while Alice passes hers with her timer not yet run. He lasts
      // only while she does (S14), so he sponsors nothing: the mint ends them
      // both as the timers would, then names Carol, or refuses with nobody left,
      // rather than list a link that would be refused on arrival.
      const idleMs = 30 * 60_000;
      const relay = await setup({
        users: [...MEMBERS, { sub: 'sub-carol', userId: 'carol', displayName: 'Carol' }],
        timings: { attachmentIdleMs: idleMs },
      });
      const page = await relay.page({ policy: { invites: 'all' } });
      await attachMember(await relay.claude('sub-alice'), page);
      vi.useFakeTimers({ toFake: ['Date'] });
      const start = Date.now();
      const bob = await relay.claude('sub-bob');
      expect((await redeem(bob, page, (await mintOk(page)).link)).outcome.isError).toBe(false);
      expect(relay.store.attachments.get(page.pageId, 'bob')?.sponsorId).toBe('alice');
      const calling = [bob];
      if (others === 'Carol is') {
        vi.setSystemTime(start + 1000);
        const carol = await relay.claude('sub-carol');
        await attachMember(carol, page, 'observer');
        calling.push(carol);
      }
      vi.setSystemTime(start + idleMs / 2);
      for (const who of calling) {
        expect((await call(who, 'call_page_tool', getView(page.pageId))).isError).toBe(false);
      }
      vi.setSystemTime(start + idleMs + 60_000);
      const minted = await mint(page);
      const events = relay.relay.audit.events();
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'expire', userId: 'alice', reason: 'idle' }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'expire', userId: 'bob', reason: 'sponsor_gone' }),
      );
      if (others === 'nobody else is') {
        expect(minted.answer.refused).toEqual({ inviteId: minted.inviteId, reason: 'no_sponsor' });
        expect(minted.answer.invites).toEqual([]);
        expect(relay.store.attachments.listForPage(page.pageId)).toEqual([]);
        return;
      }
      expect(minted.answer.refused).toBeUndefined();
      expect(
        minted.answer.invites.find((invite) => invite.inviteId === minted.inviteId)?.sponsor,
      ).toEqual({ userId: 'carol', displayName: 'Carol' });
      expect(relay.store.attachments.listForPage(page.pageId).map((a) => a.userId)).toEqual([
        'carol',
      ]);
      // The link it lists works: the page hears the redemption and lets the guest in.
      const guest = await relay.claude(GUEST, GUEST_EMAIL);
      const { outcome } = await redeem(guest, page, `${LINK_BASE}#${minted.secret}`);
      expect(outcome.isError, outcome.text).toBe(false);
      expect(outcome.text).toContain('Shared by Carol.');
    },
    15_000,
  );
});

describe('S14: as far as policy.invites allows', () => {
  it.each([
    ['off', 'observer', 'policy'],
    ['off', 'driver', 'policy'],
    ['watch', 'driver', 'policy'],
    ['watch', 'observer', undefined],
    ['all', 'driver', undefined],
  ] as const)('policy %s, role %s: refused %s', async (policy, role, reason) => {
    const relay = await setup();
    const page = await relay.page({ policy: { invites: policy } });
    await attachMember(await relay.claude('sub-alice'), page);
    expect((await mint(page, { role })).answer.refused?.reason).toBe(reason);
  });

  it('defaults to watch: control invites need a page that opts in', async () => {
    const relay = await setup();
    const page = await relay.page();
    await attachMember(await relay.claude('sub-alice'), page);
    expect((await mint(page, { role: 'driver' })).answer.refused?.reason).toBe('policy');
    expect((await mint(page, { role: 'observer' })).answer.refused).toBeUndefined();
  });

  it('mints nothing without a public URL, saying so after the welcome', async () => {
    plain = await startRelay({ invites: true });
    const page = await connectPage(plain.relay.pageUrl, { policy: { invites: 'all' } });
    try {
      expect(page.all('invites')).toEqual([{ t: 'invites', linkBase: null, invites: [] }]);
      expect((await mint(page)).answer.refused?.reason).toBe('no_public_url');
    } finally {
      page.ws.terminate();
    }
  });
});

describe('S14: at most 10 live per page, each for at most 24 hours and 20 uses', () => {
  it('refuses the eleventh live invite, and a duplicate id or secret', async () => {
    const { relay, page } = await sharedPage();
    const ids: string[] = [];
    for (let i = 0; i < MAX_LIVE_INVITES_PER_PAGE; i += 1) {
      ids.push((await mintOk(page, { uses: 20 })).inviteId);
    }
    // Ten mints also spend the page's grants for this window, and a mint past
    // those is refused with the same reason, so the clock moves past the window
    // first: what refuses the eleventh is then the live limit alone.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + GRANT_WINDOW_MS + 1000);
    expect((await mint(page)).answer.refused?.reason).toBe('limit');
    // A slot freed takes the next mint, and the one after is refused again.
    page.send({ t: 'invite_cancel', inviteId: ids.pop() ?? '' });
    await mintOk(page);
    expect((await mint(page)).answer.refused?.reason).toBe('limit');
    expect((await latest(page, 'invites')).invites).toHaveLength(MAX_LIVE_INVITES_PER_PAGE);
    expect((await mint(page, { inviteId: ids[0] ?? '' })).answer.refused?.reason).toBe('duplicate');

    const other = await relay.page({ policy: { invites: 'all' } });
    await attachMember(await relay.claude('sub-bob'), other);
    const first = await mintOk(other, { inviteId: 'inv_same' });
    expect((await mint(other, { inviteId: 'inv_same' })).answer.refused?.reason).toBe('duplicate');
    // The same secret under another id is a duplicate too: digests are unique relay-wide.
    other.send({
      t: 'invite_create',
      inviteId: 'inv_other',
      role: 'observer',
      label: 'Again',
      uses: 1,
      expiresAt: null,
      secretHash: first.hash,
    });
    expect((await latest(other, 'invites')).refused).toEqual({
      inviteId: 'inv_other',
      reason: 'duplicate',
    });
  });

  it('takes more than 20 uses, or a control invite of more than one, for a malformed frame', async () => {
    for (const terms of [
      { role: 'observer', uses: 21 },
      { role: 'driver', uses: 2 },
    ]) {
      const relay = await setup();
      const page = await relay.page({ policy: { invites: 'all' } });
      page.send({
        t: 'invite_create',
        inviteId: 'inv_bad',
        label: 'Too many',
        expiresAt: null,
        secretHash: newSecret().hash,
        ...terms,
      });
      expect((await page.closed).code).toBe(1008);
      await relay.close();
    }
  });

  it('ends "while the page is open" after 24 hours, and refuses an expiry under a minute away', async () => {
    const { relay, page } = await sharedPage();
    const before = Date.now();
    const open = await mintOk(page, { expiresAt: null });
    const kept = relay.store.invites.get(page.pageId, open.inviteId);
    expect(kept?.requestedExpiresAt).toBeNull();
    expect(kept?.expiresAt).toBeGreaterThanOrEqual(before + MAX_INVITE_LIFETIME_MS);
    expect(kept?.expiresAt).toBeLessThanOrEqual(Date.now() + MAX_INVITE_LIFETIME_MS);
    // A page clock running ahead stretches nothing past 24 hours on the relay's,
    // and the page still sees its own terms back.
    const asked = Date.now() + 3 * MAX_INVITE_LIFETIME_MS;
    const far = await mintOk(page, { expiresAt: asked });
    expect(relay.store.invites.get(page.pageId, far.inviteId)?.expiresAt).toBeLessThanOrEqual(
      Date.now() + MAX_INVITE_LIFETIME_MS,
    );
    const listed = (await latest(page, 'invites')).invites.find((i) => i.inviteId === far.inviteId);
    expect(listed?.expiresAt).toBe(asked);
    // A page clock behind by more than the lifetime gets expired.
    const behind = await mint(page, { expiresAt: Date.now() + MIN_INVITE_REMAINING_MS - 1000 });
    expect(behind.answer.refused?.reason).toBe('expired');
  });

  it('stops working at its expiry, when its link reads as no invite', async () => {
    const { relay, page } = await sharedPage();
    const minted = await mintOk(page, { expiresAt: Date.now() + MIN_INVITE_REMAINING_MS + 500 });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + MIN_INVITE_REMAINING_MS + 1000);
    const guest = await relay.claude(GUEST, GUEST_EMAIL);
    expect((await call(guest, 'pair_page', { invite: minted.link })).text).toBe(
      'pairing_expired: this invite is invalid, used up or expired',
    );
  });
});

describe('S14: an invite closes at its expiry', () => {
  it('leaves the list, frees its live slot and is recorded as expired', async () => {
    const { relay, page } = await sharedPage();
    for (let i = 1; i < MAX_LIVE_INVITES_PER_PAGE; i += 1) await mintOk(page);
    // The relay's own timer, faked from the mint on, so the test need not wait a minute.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const short = await mintOk(page, { expiresAt: Date.now() + MIN_INVITE_REMAINING_MS + 1000 });
    // Past the window the ten mints' grants count in, and short of the short
    // invite's end, so the live limit alone refuses.
    expect(GRANT_WINDOW_MS + 500).toBeLessThan(MIN_INVITE_REMAINING_MS + 1000);
    vi.advanceTimersByTime(GRANT_WINDOW_MS + 500);
    expect((await mint(page)).answer.refused?.reason).toBe('limit');
    vi.advanceTimersByTime(MIN_INVITE_REMAINING_MS + 2000 - (GRANT_WINDOW_MS + 500));
    const listed = (await latest(page, 'invites')).invites.map((invite) => invite.inviteId);
    expect(listed).toHaveLength(MAX_LIVE_INVITES_PER_PAGE - 1);
    expect(listed).not.toContain(short.inviteId);
    expect(relay.store.invites.get(page.pageId, short.inviteId)).toBeUndefined();
    expect(relay.relay.audit.events()).toContainEqual(
      expect.objectContaining({
        type: 'invite_closed',
        inviteId: short.inviteId,
        reason: 'expired',
      }),
    );
    // Its slot is free again, and only the one: the next mint, a single grant
    // into this window, meets the live limit.
    await mintOk(page);
    expect((await mint(page)).answer.refused?.reason).toBe('limit');
  });
});

describe('S14: watch invites approve observers in advance', () => {
  it('reach the page as a request via invite with the presented secret, even under autoApprove', async () => {
    const relay = await setup();
    const page = await relay.page({ policy: { invites: 'watch', autoApprove: 'observer' } });
    // A member's code needs no answer on this page; a redemption still does.
    const alice = await relay.claude('sub-alice');
    expect((await call(alice, 'pair_page', { code: page.code })).isError).toBe(false);
    const { secret, inviteId, link } = await mintOk(page, { label: 'Book club' });
    const guest = await relay.claude(GUEST, GUEST_EMAIL);
    const { outcome, request } = await redeem(guest, page, link, { allow: true, role: 'driver' });
    // The adapter checks the secret against its own record, so the relay forwards it as shown.
    expect(request).toMatchObject({
      via: 'invite',
      invite: { inviteId, secret, label: 'Book club' },
      account: { kind: 'invitee', verified: true },
      user: { displayName: GUEST_EMAIL },
    });
    // A watch invite grants observer, whatever role the answer named.
    expect(outcome.isError, outcome.text).toBe(false);
    expect(outcome.structured).toMatchObject({ role: 'observer', sponsor: 'Alice' });
    expect(outcome.text).toContain('Shared by Alice.');
    const roster = await latest(page, 'roster');
    expect(roster.attachments.find((entry) => entry.kind === 'invitee')).toMatchObject({
      role: 'observer',
      inviteId,
      endsAt: expect.any(Number) as number,
    });
    // Its one use is spent, so it is no longer live.
    expect((await latest(page, 'invites')).invites).toEqual([]);
  });

  it('spend one use per approval, and only on approval, wherever they are redeemed', async () => {
    const { relay, page } = await sharedPage();
    const { secret, inviteId } = await mintOk(page, { uses: 3 });
    const first = await signedInAtI(relay, 'sub-g1', 'g1@example.com');
    const { request, settled } = await joinAtI(first, page, secret, { allow: false });
    expect(request).toMatchObject({ via: 'invite', invite: { inviteId, secret } });
    expect(settled).toEqual({ status: 'denied' });
    expect((await latest(page, 'invites')).invites[0]).toMatchObject({ usesLeft: 3, refusals: 0 });
    const second = await signedInAtI(relay, 'sub-g2', 'g2@example.com');
    expect((await joinAtI(second, page, secret)).settled).toEqual({
      status: 'approved',
      role: 'observer',
    });
    expect((await latest(page, 'invites')).invites[0]).toMatchObject({
      usesLeft: 2,
      pending: false,
    });
  });

  it('grant no more than the invite role: a watch guest is never promoted', async () => {
    const relay = await setup();
    // Driver seats to spare, so only the invite's role can hold the guest back.
    const page = await relay.page({ policy: { invites: 'all', maxDrivers: 3 } });
    await attachMember(await relay.claude('sub-alice'), page);
    const { link } = await mintOk(page);
    const guest = await relay.claude(GUEST, GUEST_EMAIL);
    const { request } = await redeem(guest, page, link, { allow: true, role: 'driver' });
    const roleOf = async (userId: string) =>
      (await latest(page, 'roster')).attachments.find((entry) => entry.userId === userId)?.role;
    expect(await roleOf(request.user.userId)).toBe('observer');
    page.send({ t: 'set_role', userId: request.user.userId, role: 'driver' });
    expect(await roleOf(request.user.userId)).toBe('observer');
    // A member let in by a watch invite is held to it too, while seats are free.
    const bobLink = await mintOk(page);
    const bob = await relay.claude('sub-bob');
    await redeem(bob, page, bobLink.link, { allow: true, role: 'driver' });
    page.send({ t: 'set_role', userId: 'bob', role: 'driver' });
    expect(await roleOf('bob')).toBe('observer');
    // The relay refuses its writes (S5), whatever the page might do.
    const write = { page: page.pageId, tool: 'add_item', arguments: { label: 'x' } };
    expect((await call(guest, 'call_page_tool', write)).text).toMatch(/^role_denied: /);
    expect((await call(guest, 'call_page_tool', getView(page.pageId))).isError).toBe(false);
  });
});

describe('S14: control invites prompt, allow one pending request and burn after three refusals or timeouts', () => {
  it('prompt naming the account and label, hold one prompt at a time, and are spent only on approval', async () => {
    const { relay, page } = await sharedPage();
    const { inviteId, link } = await mintOk(page, { role: 'driver', label: 'Pair session' });
    const guest = await relay.claude(GUEST, GUEST_EMAIL);
    const other = await relay.claude('sub-other', 'other@example.com');
    const waiting = call(guest, 'pair_page', { invite: link });
    const request = await page.next('attach_request');
    expect(request).toMatchObject({
      via: 'invite',
      user: { displayName: GUEST_EMAIL },
      account: { kind: 'invitee', verified: true },
      invite: { inviteId, label: 'Pair session' },
    });
    expect((await latest(page, 'invites')).invites[0]).toMatchObject({
      pending: true,
      usesLeft: 1,
    });
    // A second account meanwhile is turned away, and the page hears nothing of it.
    expect((await call(other, 'pair_page', { invite: link })).text).toMatch(/^page_busy: /);
    page.send({ t: 'attach_decision', requestId: request.requestId, allow: true, role: 'driver' });
    // Alice drives and maxDrivers is 1, so the guest joins as observer.
    expect((await waiting).structured).toMatchObject({ role: 'observer' });
    expect(relay.store.attachments.get(page.pageId, request.user.userId)).toMatchObject({
      inviteRole: 'driver',
      sponsorId: 'alice',
      emailHash: emailBarDigest(GUEST_EMAIL),
    });
    // Spent on approval: its record is gone and the link is dead.
    expect(relay.store.invites.get(page.pageId, inviteId)).toBeUndefined();
    expect((await call(other, 'pair_page', { invite: link })).text).toMatch(/^pairing_expired: /);
    await page.sync();
    expect(page.all('attach_request')).toHaveLength(2);
  });

  it('let the operator promote a control guest who joined as observer once a driver seat is free', async () => {
    const { relay, page } = await sharedPage();
    const { link } = await mintOk(page, { role: 'driver' });
    const guest = await relay.claude(GUEST, GUEST_EMAIL);
    const { request } = await redeem(guest, page, link, { allow: true, role: 'driver' });
    const guestId = request.user.userId;
    expect((await latest(page, 'roster')).attachments.find((a) => a.userId === guestId)?.role).toBe(
      'observer',
    );
    page.send({ t: 'set_role', userId: 'alice', role: 'observer' });
    page.send({ t: 'set_role', userId: guestId, role: 'driver' });
    expect((await latest(page, 'roster')).attachments.find((a) => a.userId === guestId)?.role).toBe(
      'driver',
    );
  });

  it(`burn after ${String(INVITE_BURN_REFUSALS)} refusals or timeouts, counting each`, async () => {
    const { relay, page } = await sharedPage({ timings: { attachRequestTtlMs: 300 } });
    const { inviteId, link } = await mintOk(page, { role: 'driver' });
    const guest = await relay.claude(GUEST, GUEST_EMAIL);
    for (let refusals = 1; refusals <= 2; refusals += 1) {
      const { outcome } = await redeem(guest, page, link, { allow: false });
      expect(outcome.text).toMatch(/^denied_by_operator: /);
      const listed = (await latest(page, 'invites')).invites.find((i) => i.inviteId === inviteId);
      expect(listed?.refusals).toBe(refusals);
    }
    // A third, by silence: the request runs out and burns the invite.
    const { outcome } = await redeem(guest, page, link, null);
    expect(outcome.text).toMatch(/^timeout: /);
    await vi.waitFor(() => {
      expect(relay.store.invites.get(page.pageId, inviteId)).toBeUndefined();
    });
    expect((await call(guest, 'pair_page', { invite: link })).text).toMatch(/^pairing_expired: /);
    expect(relay.relay.audit.events()).toContainEqual(
      expect.objectContaining({ type: 'invite_closed', inviteId, reason: 'burned' }),
    );
  });

  it('a watch invite counts no refusals and is not burned by them', async () => {
    const { relay, page } = await sharedPage();
    const { inviteId, link } = await mintOk(page);
    const guest = await relay.claude(GUEST, GUEST_EMAIL);
    for (let i = 0; i < INVITE_BURN_REFUSALS; i += 1) {
      await redeem(guest, page, link, { allow: false });
    }
    expect(relay.store.invites.get(page.pageId, inviteId)).toMatchObject({
      refusals: 0,
      usesLeft: 1,
    });
  });
});

describe('S14: the relay grants nothing without the page, and no more than the invite role', () => {
  it('holds a redemption until the page answers, and a denial attaches nobody', async () => {
    const { relay, page } = await sharedPage();
    const { link } = await mintOk(page);
    const guest = await relay.claude(GUEST, GUEST_EMAIL);
    const { outcome } = await redeem(guest, page, link, { allow: false });
    expect(outcome.text).toMatch(/^denied_by_operator: /);
    expect((await call(guest, 'list_pages')).structured).toEqual({ pages: [] });
  });

  it('gives a member redeeming an invite an invite-made attachment, and changes nothing for someone attached', async () => {
    const { relay, page, alice } = await sharedPage();
    const { link, inviteId } = await mintOk(page);
    const bob = await relay.claude('sub-bob');
    const { outcome } = await redeem(bob, page, link, { allow: true, role: 'driver' });
    expect(outcome.structured).toMatchObject({ role: 'observer' });
    expect(relay.store.attachments.get(page.pageId, 'bob')).toMatchObject({
      kind: 'member',
      inviteId,
      inviteRole: 'observer',
      sponsorId: 'alice',
      emailHash: null,
      endsAt: expect.any(Number) as number,
    });
    // Alice is attached already: her redemption changes nothing and spends no use.
    const unspent = await mintOk(page);
    const again = await call(alice, 'pair_page', { invite: unspent.link });
    expect(again.structured).toMatchObject({ role: 'driver' });
    expect(again.text).toContain('You were already attached.');
    expect(relay.store.invites.get(page.pageId, unspent.inviteId)?.usesLeft).toBe(1);
  });

  it.each(['pair_page', '/i'] as const)(
    'and treats a member past their own end, before its timer fires, as not attached when they redeem through %s',
    async (route) => {
      // Bob's code-made attachment passes its idle end with its timer not yet
      // run, while Alice, who sponsors the invite, calls halfway through and
      // stays in time. An attachment past its time is over, so the redemption
      // ends Bob's as his timer would before it looks for one: the page hears
      // the redemption and Bob gets an invite-made attachment, rather than an
      // answer that he was attached already and not_attached on his next call.
      const idleMs = 30 * 60_000;
      const { relay, page, alice } = await sharedPage({ timings: { attachmentIdleMs: idleMs } });
      vi.useFakeTimers({ toFake: ['Date'] });
      const start = Date.now();
      const bob = await relay.claude('sub-bob');
      await attachMember(bob, page, 'observer');
      const minted = await mintOk(page, { uses: route === 'pair_page' ? 1 : 3 });
      expect(
        minted.answer.invites.find((invite) => invite.inviteId === minted.inviteId)?.sponsor.userId,
      ).toBe('alice');
      vi.setSystemTime(start + idleMs / 2);
      expect((await call(alice, 'call_page_tool', getView(page.pageId))).isError).toBe(false);
      vi.setSystemTime(start + idleMs + 60_000);
      await page.sync();
      const asked = page.all('attach_request').length;
      let request: AttachRequestFrame;
      if (route === 'pair_page') {
        const redeemed = await redeem(bob, page, minted.link);
        request = redeemed.request;
        expect(redeemed.outcome.isError, redeemed.outcome.text).toBe(false);
        expect(redeemed.outcome.text).not.toContain('You were already attached.');
        expect(redeemed.outcome.text).toContain('Shared by Alice.');
      } else {
        // Signed in after the step, since a /pair session lasts 15 minutes.
        const phone = await signedInAtI(relay, 'sub-bob', null);
        const joined = await joinAtI(phone, page, minted.secret);
        request = joined.request;
        expect(joined.settled).toEqual({ status: 'approved', role: 'observer' });
      }
      expect(request).toMatchObject({
        via: 'invite',
        user: { userId: 'bob' },
        invite: { inviteId: minted.inviteId },
      });
      await page.sync();
      expect(page.all('attach_request')).toHaveLength(asked + 1);
      expect(relay.store.attachments.get(page.pageId, 'bob')).toMatchObject({
        kind: 'member',
        inviteId: minted.inviteId,
        sponsorId: 'alice',
        endsAt: expect.any(Number) as number,
      });
      expect((await call(bob, 'call_page_tool', getView(page.pageId))).isError).toBe(false);
      const events = relay.relay.audit.events();
      expect(
        events
          .filter((event) => event.type === 'expire')
          .map((event) => [event.userId, event.reason]),
      ).toEqual([['bob', 'idle']]);
      expect(events.filter((event) => event.type === 'invite_redeemed')).toEqual([
        expect.objectContaining({ inviteId: minted.inviteId, userId: 'bob' }),
      ]);
    },
    15_000,
  );
});

describe('S14: pair_page accepts only an invite minted for one use', () => {
  it('answers a multi-use link, an unknown one, a foreign one and a malformed one alike', async () => {
    const { relay, page } = await sharedPage();
    const many = await mintOk(page, { uses: 2 });
    const one = await mintOk(page, { uses: 1 });
    const guest = await relay.claude(GUEST, GUEST_EMAIL);
    const answers = [
      await call(guest, 'pair_page', { invite: many.link }),
      await call(guest, 'pair_page', { invite: many.secret }),
      await call(guest, 'pair_page', { invite: `${LINK_BASE}#${newSecret().secret}` }),
      await call(guest, 'pair_page', { invite: `https://other.example/i#${one.secret}` }),
      await call(guest, 'pair_page', { invite: 'not an invite' }),
    ];
    for (const answer of answers) {
      expect(answer.text).toBe('pairing_expired: this invite is invalid, used up or expired');
    }
    await page.sync();
    expect(page.all('attach_request').filter((request) => request.via === 'invite')).toEqual([]);
    // Neither and both are refused before anything is looked at.
    expect((await call(guest, 'pair_page', {})).text).toMatch(/^invalid_arguments: /);
    const both = await call(guest, 'pair_page', { code: page.code, invite: one.link });
    expect(both.text).toMatch(/^invalid_arguments: /);
    // The one-use link works, given as its bare secret too.
    const { outcome, request } = await redeem(guest, page, one.secret);
    expect(request.invite?.inviteId).toBe(one.inviteId);
    expect(outcome.isError).toBe(false);
  });
});

describe("S14: revoke('*') cancels every live invite", () => {
  it('closes every link and ends every attachment, invite-made or not', async () => {
    const { relay, page, alice } = await sharedPage();
    const watch = await mintOk(page);
    const many = await mintOk(page, { uses: 3 });
    const control = await mintOk(page, { role: 'driver' });
    const guest = await relay.claude(GUEST, GUEST_EMAIL);
    await redeem(guest, page, watch.link);
    page.send({ t: 'revoke', userId: '*' });
    expect((await latest(page, 'invites')).invites).toEqual([]);
    expect((await call(guest, 'pair_page', { invite: control.link })).text).toMatch(
      /^pairing_expired: /,
    );
    const late = await signedInAtI(relay, 'sub-late', 'late@example.com');
    expect(await late.post('/i/claim', { secret: many.secret })).toMatchObject({
      status: 404,
      data: { error: 'pairing_expired' },
    });
    expect((await call(alice, 'list_pages')).structured).toEqual({ pages: [] });
    expect((await call(guest, 'list_pages')).structured).toEqual({ pages: [] });
    // The single-use invite went when its use was spent; Revoke all closed the others.
    const closed = relay.relay.audit
      .events()
      .flatMap((event) => (event.type === 'invite_closed' ? [event.reason] : []));
    expect(closed).toEqual(['used_up', 'revoked', 'revoked']);
  });
});

describe('S14: revoking an invitee bars that account and its verified email from the invite', () => {
  it('bars the account, and a new sign-up with the same email, while the link stays live for others', async () => {
    const { relay, page } = await sharedPage();
    const { secret, inviteId } = await mintOk(page, { uses: 5 });
    const guest = await signedInAtI(relay, GUEST, GUEST_EMAIL);
    const { request } = await joinAtI(guest, page, secret);
    page.send({ t: 'revoke', userId: request.user.userId });
    await page.sync();
    expect(relay.store.attachments.get(page.pageId, request.user.userId)).toBeUndefined();
    const kept = relay.store.invites.get(page.pageId, inviteId);
    expect(kept?.barredUserIds).toEqual([request.user.userId]);
    expect(kept?.barredEmailHashes).toEqual([emailBarDigest(GUEST_EMAIL)]);
    // No redemption clears a revoke, and the page never hears of these.
    const barred = { status: 403, data: { error: 'denied_by_operator' } };
    expect(await guest.post('/i/claim', { secret })).toMatchObject(barred);
    // Deleted at the provider and signed up again: a new subject, the same address in another case.
    const again = await signedInAtI(relay, 'sub-guest-again', 'GUEST@Example.com');
    expect(await again.post('/i/claim', { secret })).toMatchObject(barred);
    await page.sync();
    expect(page.all('attach_request').filter((frame) => frame.via === 'invite')).toHaveLength(1);
    // Someone else still joins by it: a revoke of one user never cancels the invite.
    const friend = await signedInAtI(relay, 'sub-friend', 'friend@example.com');
    expect((await joinAtI(friend, page, secret)).settled).toMatchObject({ status: 'approved' });
  });

  it('bars an unverified account by its id alone', async () => {
    const { relay, page } = await sharedPage();
    const { secret, inviteId } = await mintOk(page, { uses: 3 });
    const guest = await signedInAtI(relay, GUEST, null);
    const { request } = await joinAtI(guest, page, secret);
    expect(request).toMatchObject({
      account: { kind: 'invitee', verified: false },
      user: { displayName: 'unverified account' },
    });
    page.send({ t: 'revoke', userId: request.user.userId });
    await page.sync();
    expect(relay.store.invites.get(page.pageId, inviteId)?.barredEmailHashes).toEqual([]);
    expect(await guest.post('/i/claim', { secret })).toMatchObject({
      status: 403,
      data: { error: 'denied_by_operator' },
    });
  });

  it('refuses on approval a redemption that was waiting when its verified email was barred', async () => {
    const { relay, page } = await sharedPage();
    const { secret } = await mintOk(page, { uses: 5 });
    const first = await signedInAtI(relay, GUEST, GUEST_EMAIL);
    const { request } = await joinAtI(first, page, secret);
    // The same address under a new subject, its redemption waiting on the operator.
    const again = await signedInAtI(relay, 'sub-guest-again', 'Guest@Example.COM');
    const claimed = await again.post('/i/claim', { secret });
    expect(claimed.status).toBe(200);
    const waiting = await page.next('attach_request');
    page.send({ t: 'revoke', userId: request.user.userId });
    page.send({ t: 'attach_decision', requestId: waiting.requestId, allow: true });
    expect(await settledAtI(again, String(claimed.data.claim))).toEqual({ status: 'expired' });
    expect(relay.store.attachments.get(page.pageId, waiting.user.userId)).toBeUndefined();
    expect((await latest(page, 'roster')).attachments.map((entry) => entry.userId)).toEqual([
      'alice',
    ]);
  });

  it('bars someone whose redemption was still waiting', async () => {
    const { relay, page } = await sharedPage();
    const { link, inviteId } = await mintOk(page);
    const guest = await relay.claude(GUEST, GUEST_EMAIL);
    const waiting = call(guest, 'pair_page', { invite: link });
    const request = await page.next('attach_request');
    page.send({ t: 'revoke', userId: request.user.userId });
    expect((await waiting).text).toMatch(/^denied_by_operator: /);
    expect(relay.store.invites.get(page.pageId, inviteId)?.barredUserIds).toEqual([
      request.user.userId,
    ]);
  });
});

describe("S14: when a sponsor's attachment ends, so do its invites and the attachments they made", () => {
  it.each(['detach', 'revoke', 'expire'] as const)(
    'when the sponsor leaves by %s',
    async (how) => {
      const { relay, page, alice } = await sharedPage({
        timings: how === 'expire' ? { attachmentIdleMs: 1500 } : {},
      });
      const bob = await relay.claude('sub-bob');
      await attachMember(bob, page, 'observer');
      const used = await mintOk(page);
      const first = await mintOk(page, { uses: 3 });
      const guest = await relay.claude(GUEST, GUEST_EMAIL);
      await redeem(guest, page, used.link);
      // Everyone but Alice keeps calling, so only her attachment can run out.
      const keepAlive = setInterval(() => {
        for (const who of [bob, guest]) {
          void call(who, 'call_page_tool', getView(page.pageId)).catch(() => undefined);
        }
      }, 250);
      try {
        if (how === 'detach') await call(alice, 'detach_page', { page: page.pageId });
        if (how === 'revoke') page.send({ t: 'revoke', userId: 'alice' });
        await vi.waitFor(
          () => {
            expect(relay.store.invites.get(page.pageId, first.inviteId)).toBeUndefined();
          },
          { timeout: 5000 },
        );
      } finally {
        clearInterval(keepAlive);
      }
      expect((await call(guest, 'list_pages')).structured).toEqual({ pages: [] });
      // The page hears its invites closed, as on every change (ADR 0017).
      expect((await latest(page, 'invites')).invites).toEqual([]);
      const late = await signedInAtI(relay, 'sub-late', 'late@example.com');
      expect((await late.post('/i/claim', { secret: first.secret })).status).toBe(404);
      // Bob's own attachment stays: only what Alice's invites made ended with her.
      expect(relay.store.attachments.get(page.pageId, 'bob')).toBeDefined();
      const events = relay.relay.audit.events();
      expect(events.find((event) => event.type === 'sponsor_gone')).toMatchObject({
        sponsor: 'alice',
        invites: 1,
        attachments: 1,
      });
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'expire', reason: 'sponsor_gone' }),
      );
    },
    15_000,
  );

  it.each(['pair_page', '/i'] as const)(
    'and stay ended when the sponsor redeems one through %s after their own end, before its timer fires',
    async (route) => {
      // An idle end the test never waits for, with only Date stepped past it: the
      // gap between an attachment's expiresAt and the timer that ends it, which a
      // busy event loop widens. The redemption is what notices the end, and closes
      // the invite under the very redemption that presented it.
      const idleMs = 30 * 60_000;
      const { relay, page } = await sharedPage({ timings: { attachmentIdleMs: idleMs } });
      const minted = await mintOk(page, { uses: route === 'pair_page' ? 1 : 3 });
      await page.sync();
      const asked = page.all('attach_request').length;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + idleMs + 60_000);
      if (route === 'pair_page') {
        const alice = await relay.claude('sub-alice');
        expect((await call(alice, 'pair_page', { invite: minted.link })).text).toBe(
          'pairing_expired: this invite is invalid, used up or expired',
        );
      } else {
        const alice = await signedInAtI(relay, 'sub-alice', null);
        expect((await alice.post('/i/claim', { secret: minted.secret })).status).toBe(404);
        // Nor does a stranger get in by its other uses.
        const guest = await signedInAtI(relay, GUEST, GUEST_EMAIL);
        expect((await guest.post('/i/claim', { secret: minted.secret })).status).toBe(404);
      }
      // The page never hears a redemption of an invite that closed, and the
      // invite does not come back: not in the store, the list or the audit log.
      await page.sync();
      expect(page.all('attach_request')).toHaveLength(asked);
      expect(relay.store.invites.get(page.pageId, minted.inviteId)).toBeUndefined();
      expect((await latest(page, 'invites')).invites).toEqual([]);
      expect(relay.store.attachments.listForPage(page.pageId)).toEqual([]);
      const events = relay.relay.audit.events();
      expect(
        events.filter(
          (event) => event.type === 'invite_closed' && event.inviteId === minted.inviteId,
        ),
      ).toEqual([expect.objectContaining({ reason: 'sponsor_gone' })]);
      expect(events.filter((event) => event.type === 'invite_redeemed')).toEqual([]);
    },
    15_000,
  );

  it.each(['pair_page', '/i'] as const)(
    "and refuse a stranger's redemption through %s while the sponsor is past their end, before its timer fires",
    async (route) => {
      // The same gap, with someone other than the sponsor redeeming: an
      // attachment past its time sponsors nothing, so the lookup ends Alice as
      // her timer would, and the invite with her, before /i shows it or the
      // page hears of it.
      const idleMs = 30 * 60_000;
      const { relay, page } = await sharedPage({ timings: { attachmentIdleMs: idleMs } });
      const minted = await mintOk(page, { uses: route === 'pair_page' ? 1 : 3 });
      await page.sync();
      const asked = page.all('attach_request').length;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + idleMs + 60_000);
      if (route === 'pair_page') {
        const guest = await relay.claude(GUEST, GUEST_EMAIL);
        expect((await call(guest, 'pair_page', { invite: minted.link })).text).toBe(
          'pairing_expired: this invite is invalid, used up or expired',
        );
      } else {
        const guest = await signedInAtI(relay, GUEST, GUEST_EMAIL);
        expect((await guest.post('/i/preview', { secret: minted.secret })).status).toBe(404);
        expect((await guest.post('/i/claim', { secret: minted.secret })).status).toBe(404);
      }
      await page.sync();
      expect(page.all('attach_request')).toHaveLength(asked);
      expect(relay.store.invites.get(page.pageId, minted.inviteId)).toBeUndefined();
      expect((await latest(page, 'invites')).invites).toEqual([]);
      expect(relay.store.attachments.listForPage(page.pageId)).toEqual([]);
      const events = relay.relay.audit.events();
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'expire', userId: 'alice', reason: 'idle' }),
      );
      expect(
        events.filter(
          (event) => event.type === 'invite_closed' && event.inviteId === minted.inviteId,
        ),
      ).toEqual([expect.objectContaining({ reason: 'sponsor_gone' })]);
      expect(events.filter((event) => event.type === 'invite_redeemed')).toEqual([]);
      expect(events.flatMap((event) => (event.type === 'attach' ? [event.userId] : []))).toEqual([
        'alice',
      ]);
    },
    15_000,
  );

  it.each(['pair_page', '/i'] as const)(
    'and refuse on approval a redemption through %s that waited while the sponsor passed their end',
    async (route) => {
      // Under the 15 minutes a /pair session lasts, so the /i browser can still
      // read its claim once the clock has stepped past Alice's end.
      const idleMs = 10 * 60_000;
      const { relay, page } = await sharedPage({ timings: { attachmentIdleMs: idleMs } });
      const minted = await mintOk(page, { uses: route === 'pair_page' ? 1 : 3 });
      vi.useFakeTimers({ toFake: ['Date'] });
      let settled: () => Promise<unknown>;
      if (route === 'pair_page') {
        const guest = await relay.claude(GUEST, GUEST_EMAIL);
        const pending = call(guest, 'pair_page', { invite: minted.link });
        settled = async () => (await pending).text;
      } else {
        const guest = await signedInAtI(relay, GUEST, GUEST_EMAIL);
        const claimed = await guest.post('/i/claim', { secret: minted.secret });
        expect(claimed.status, JSON.stringify(claimed.data)).toBe(200);
        settled = () => settledAtI(guest, String(claimed.data.claim));
      }
      const request = await page.next('attach_request');
      // Alice passes her end while the operator decides, and her timer has not fired.
      vi.setSystemTime(Date.now() + idleMs + 60_000);
      page.send({ t: 'attach_decision', requestId: request.requestId, allow: true });
      expect(await settled()).toEqual(
        route === 'pair_page'
          ? 'denied_by_operator: the member who shared this invite is no longer attached, so it closed'
          : { status: 'denied' },
      );
      expect(relay.store.invites.get(page.pageId, minted.inviteId)).toBeUndefined();
      expect((await latest(page, 'invites')).invites).toEqual([]);
      expect(relay.store.attachments.listForPage(page.pageId)).toEqual([]);
      const events = relay.relay.audit.events();
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'expire', userId: 'alice', reason: 'idle' }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'attach_refused',
          userId: request.user.userId,
          inviteId: minted.inviteId,
          outcome: 'denied_by_operator',
        }),
      );
      expect(events.filter((event) => event.type === 'invite_redeemed')).toEqual([]);
      expect(events.flatMap((event) => (event.type === 'attach' ? [event.userId] : []))).toEqual([
        'alice',
      ]);
    },
    15_000,
  );

  it.each(['call_page_tool', 'list_page_tools', 'list_pages', 'detach_page'] as const)(
    'and end what their invites made when a guest next uses the page through %s while the sponsor is past their end, before its timer fires',
    async (tool) => {
      // The guest calls halfway through, which moves their own end on, while
      // Alice passes hers with her timer not yet run. An attachment past its
      // time is over, and so is everything its invites made (S14), so each
      // way in ends Alice as her timer would, and the guest with her, before
      // it answers: nothing reaches the page.
      const idleMs = 30 * 60_000;
      const { relay, page } = await sharedPage({ timings: { attachmentIdleMs: idleMs } });
      vi.useFakeTimers({ toFake: ['Date'] });
      const start = Date.now();
      const minted = await mintOk(page);
      const guest = await relay.claude(GUEST, GUEST_EMAIL);
      const { outcome, request } = await redeem(guest, page, minted.link);
      expect(outcome.isError, outcome.text).toBe(false);
      vi.setSystemTime(start + idleMs / 2);
      expect((await call(guest, 'call_page_tool', getView(page.pageId))).isError).toBe(false);
      vi.setSystemTime(start + idleMs + 60_000);
      await page.sync();
      const invoked = page.all('invoke').length;
      const args =
        tool === 'list_pages'
          ? {}
          : tool === 'call_page_tool'
            ? getView(page.pageId)
            : { page: page.pageId };
      const answer = await call(guest, tool, args);
      if (tool === 'list_pages') expect(answer.structured).toEqual({ pages: [] });
      else expect(answer.text).toMatch(/^not_attached: /);
      expect((await call(guest, 'call_page_tool', getView(page.pageId))).text).toMatch(
        /^not_attached: /,
      );
      await page.sync();
      expect(page.all('invoke')).toHaveLength(invoked);
      expect(relay.store.attachments.listForPage(page.pageId)).toEqual([]);
      const events = relay.relay.audit.events();
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'expire', userId: 'alice', reason: 'idle' }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'expire',
          userId: request.user.userId,
          reason: 'sponsor_gone',
        }),
      );
      expect(events.find((event) => event.type === 'sponsor_gone')).toMatchObject({
        sponsor: 'alice',
        attachments: 1,
      });
      expect(events.filter((event) => event.type === 'detach')).toEqual([]);
    },
    15_000,
  );

  it('and ask the page afresh when a member their invite let in pairs by code while the sponsor is past their end', async () => {
    // Bob's invite-made attachment lasts only while Alice's does, so a code he
    // pairs with once she is past her end, her timer not yet run, finds him
    // not attached: the relay ends them both as the timers would, and the
    // operator decides again, which gives him an attachment of his own.
    const idleMs = 30 * 60_000;
    const { relay, page } = await sharedPage({ timings: { attachmentIdleMs: idleMs } });
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const bob = await relay.claude('sub-bob');
    expect((await redeem(bob, page, (await mintOk(page)).link)).outcome.isError).toBe(false);
    vi.setSystemTime(start + idleMs / 2);
    expect((await call(bob, 'call_page_tool', getView(page.pageId))).isError).toBe(false);
    vi.setSystemTime(start + idleMs + 60_000);
    // A code shown now, since the one on screen expired on the stepped clock.
    page.send({ t: 'rotate_pairing' });
    await page.sync();
    const pending = call(bob, 'pair_page', { code: page.code });
    const request = await page.next('attach_request');
    expect(request).toMatchObject({ via: 'code', user: { userId: 'bob' } });
    page.send({
      t: 'attach_decision',
      requestId: request.requestId,
      allow: true,
      role: 'observer',
    });
    const outcome = await pending;
    expect(outcome.isError, outcome.text).toBe(false);
    expect(outcome.text).not.toContain('You were already attached.');
    expect(relay.store.attachments.listForPage(page.pageId)).toEqual([
      expect.objectContaining({ userId: 'bob', inviteId: null, sponsorId: null, endsAt: null }),
    ]);
    const events = relay.relay.audit.events();
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'expire', userId: 'alice', reason: 'idle' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'expire', userId: 'bob', reason: 'sponsor_gone' }),
    );
  }, 15_000);

  it('and refuse a redemption while the member whose invite let the sponsor in is past their end', async () => {
    // A member let in by another member's invite lasts only while that member
    // does (S14), so the lookup walks up the chain. A mint never names such a
    // member while the one above them is attached, since that one attached
    // first and a mint ends anyone past their time; so this test moves Alice's
    // grant after Bob's in the store, a state the relay never makes, to show
    // that the walk holds on its own. Bob, let in by Alice's invite, sponsors
    // and calls halfway through, which moves his own end on; a redemption of
    // his invite once Alice is past her end ends her, Bob with her, and his
    // invite with him.
    const idleMs = 30 * 60_000;
    const { relay, page } = await sharedPage({ timings: { attachmentIdleMs: idleMs } });
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const bob = await relay.claude('sub-bob');
    const first = await mintOk(page);
    expect((await redeem(bob, page, first.link)).outcome.isError).toBe(false);
    expect(relay.store.attachments.get(page.pageId, 'bob')?.sponsorId).toBe('alice');
    const alice = relay.store.attachments.get(page.pageId, 'alice');
    if (alice === undefined) throw new Error('Alice is not attached');
    relay.store.attachments.put({ ...alice, grantedAt: start + 1 });
    const second = await mintOk(page);
    expect(
      second.answer.invites.find((invite) => invite.inviteId === second.inviteId)?.sponsor.userId,
    ).toBe('bob');
    vi.setSystemTime(start + idleMs / 2);
    expect((await call(bob, 'call_page_tool', getView(page.pageId))).isError).toBe(false);
    vi.setSystemTime(start + idleMs + 60_000);
    await page.sync();
    const asked = page.all('attach_request').length;
    const guest = await relay.claude(GUEST, GUEST_EMAIL);
    expect((await call(guest, 'pair_page', { invite: second.link })).text).toBe(
      'pairing_expired: this invite is invalid, used up or expired',
    );
    await page.sync();
    expect(page.all('attach_request')).toHaveLength(asked);
    expect(relay.store.invites.get(page.pageId, second.inviteId)).toBeUndefined();
    expect(relay.store.attachments.listForPage(page.pageId)).toEqual([]);
    const events = relay.relay.audit.events();
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'expire', userId: 'alice', reason: 'idle' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'expire', userId: 'bob', reason: 'sponsor_gone' }),
    );
    expect(
      events.filter(
        (event) => event.type === 'invite_closed' && event.inviteId === second.inviteId,
      ),
    ).toEqual([expect.objectContaining({ reason: 'sponsor_gone' })]);
    expect(
      events.filter(
        (event) => event.type === 'invite_redeemed' && event.inviteId === second.inviteId,
      ),
    ).toEqual([]);
  }, 15_000);
});

describe('S14: invite-made attachments end with the page session, on revoke or after 24 hours', () => {
  it('end with the page session, and the invites with them', async () => {
    const { relay, page } = await sharedPage({ timings: { resumeWindowMs: 200 } });
    const used = await mintOk(page);
    const { inviteId } = await mintOk(page, { uses: 3 });
    const guest = await relay.claude(GUEST, GUEST_EMAIL);
    await redeem(guest, page, used.link);
    page.ws.terminate();
    await vi.waitFor(() => {
      expect(relay.store.invites.get(page.pageId, inviteId)).toBeUndefined();
    });
    expect((await call(guest, 'call_page_tool', getView(page.pageId))).text).toMatch(
      /^page_gone: /,
    );
    expect(relay.relay.audit.events()).toContainEqual(
      expect.objectContaining({ type: 'invite_closed', inviteId, reason: 'page_gone' }),
    );
    expect(relay.relay.audit.events()).toContainEqual(
      expect.objectContaining({ type: 'expire', reason: 'page_gone' }),
    );
  });

  it('end 24 hours after redemption, however often they are used', async () => {
    const { relay, page, alice } = await sharedPage();
    const { link } = await mintOk(page, { expiresAt: null });
    const guest = await relay.claude(GUEST, GUEST_EMAIL);
    await redeem(guest, page, link);
    const read = (who: typeof guest) => call(who, 'call_page_tool', getView(page.pageId));
    // Only Date is faked: tokens are minted on the stepped clock, timers stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    for (let hour = 1; hour < 24; hour += 1) {
      vi.setSystemTime(start + hour * 60 * 60_000);
      expect((await read(guest)).isError, `hour ${String(hour)}`).toBe(false);
      expect((await read(alice)).isError).toBe(false);
    }
    vi.setSystemTime(start + MAX_INVITE_LIFETIME_MS + 1000);
    expect((await read(guest)).text).toMatch(/^not_attached: /);
    // A member's own attachment has no such end.
    expect((await read(alice)).isError).toBe(false);
    expect(relay.relay.audit.events()).toContainEqual(
      expect.objectContaining({ type: 'expire', reason: 'ends_at' }),
    );
  }, 20_000);

  it('end on revoke at once (S8)', async () => {
    const { relay, page } = await sharedPage();
    const { link } = await mintOk(page);
    const guest = await relay.claude(GUEST, GUEST_EMAIL);
    const { request } = await redeem(guest, page, link);
    page.send({ t: 'revoke', userId: request.user.userId });
    await page.sync();
    expect((await call(guest, 'call_page_tool', getView(page.pageId))).text).toMatch(
      /^not_attached: /,
    );
  });

  it('a cancelled invite closes its link and ends none of the attachments it made', async () => {
    const { relay, page } = await sharedPage();
    const { secret, inviteId } = await mintOk(page, { uses: 3 });
    await joinAtI(await signedInAtI(relay, GUEST, GUEST_EMAIL), page, secret);
    page.send({ t: 'invite_cancel', inviteId });
    expect((await latest(page, 'invites')).invites).toEqual([]);
    // The same account on Claude still reads the page.
    const guest = await relay.claude(GUEST, GUEST_EMAIL);
    expect((await call(guest, 'call_page_tool', getView(page.pageId))).isError).toBe(false);
    const other = await signedInAtI(relay, 'sub-other', 'other@example.com');
    expect((await other.post('/i/claim', { secret })).status).toBe(404);
    expect(relay.relay.audit.events()).toContainEqual(
      expect.objectContaining({ type: 'invite_closed', inviteId, reason: 'cancelled' }),
    );
  });
});

describe('S14: invite-made attachments leave members two seats', () => {
  it('turns invitees away past usersPerPage minus two, while a member still pairs', async () => {
    const { relay, page } = await sharedPage({ limits: { usersPerPage: 4 } });
    const { secret } = await mintOk(page, { uses: 5 });
    for (const sub of ['sub-g1', 'sub-g2']) {
      const guest = await signedInAtI(relay, sub, `${sub}@example.com`);
      expect((await joinAtI(guest, page, secret)).settled).toMatchObject({ status: 'approved' });
    }
    const third = await signedInAtI(relay, 'sub-g3', 'g3@example.com');
    expect(await third.post('/i/claim', { secret })).toMatchObject({
      status: 409,
      data: { error: 'page_busy' },
    });
    // The last seat is a member's.
    await attachMember(await relay.claude('sub-bob'), page, 'observer');
    expect((await latest(page, 'roster')).attachments).toHaveLength(4);
  });
});

describe("S14: a name that copies a member's shows the short id", () => {
  it('names an invitee whose verified email folds to a member name by its short id', async () => {
    const relay = await setup({
      users: [
        { sub: 'sub-alice', userId: 'alice', displayName: 'alice@example.com' },
        { sub: 'sub-bob', userId: 'bob', displayName: 'Bob' },
      ],
    });
    const page = await relay.page({ policy: { invites: 'all' } });
    await attachMember(await relay.claude('sub-alice'), page);
    const { link } = await mintOk(page);
    const copycat = await relay.claude('sub-copycat', 'ALICE@example.COM');
    const { request } = await redeem(copycat, page, link);
    const name = `invitee ${request.user.userId.slice(2, 10)}`;
    expect(request.user.displayName).toBe(name);
    expect((await latest(page, 'roster')).attachments.map((entry) => entry.displayName)).toContain(
      name,
    );
  });
});

describe('S14: redemption is limited per user, per invite and per page', () => {
  it("per user: redemptions share the user's pairing budget", async () => {
    const { relay, page } = await sharedPage({ rateLimits: { pairAttemptsPerUser: 2 } });
    const { link } = await mintOk(page);
    const guest = await relay.claude(GUEST, GUEST_EMAIL);
    await call(guest, 'pair_page', { invite: `${LINK_BASE}#${newSecret().secret}` });
    await call(guest, 'pair_page', { invite: `${LINK_BASE}#${newSecret().secret}` });
    expect((await call(guest, 'pair_page', { invite: link })).text).toMatch(/^rate_limited: /);
  });

  it('per invite, whoever redeems it', async () => {
    const { relay, page } = await sharedPage({ rateLimits: { redemptionsPerInvite: 2 } });
    const { link } = await mintOk(page, { role: 'driver' });
    const first = await relay.claude('sub-g1', 'g1@example.com');
    // Left waiting on the operator; the relay's close answers it.
    void call(first, 'pair_page', { invite: link }).catch(() => undefined);
    await page.next('attach_request');
    const second = await relay.claude('sub-g2', 'g2@example.com');
    expect((await call(second, 'pair_page', { invite: link })).text).toMatch(/^page_busy: /);
    const third = await relay.claude('sub-g3', 'g3@example.com');
    expect((await call(third, 'pair_page', { invite: link })).text).toMatch(/^rate_limited: /);
  });

  it('per page: every pairing and redemption that lands on it', async () => {
    const { relay, page } = await sharedPage({ rateLimits: { pairAttemptsPerPage: 2 } });
    // Alice's own pairing counted one.
    const one = await mintOk(page);
    const two = await mintOk(page);
    const first = await relay.claude('sub-g1', 'g1@example.com');
    expect((await redeem(first, page, one.link)).outcome.isError).toBe(false);
    const second = await relay.claude('sub-g2', 'g2@example.com');
    expect((await call(second, 'pair_page', { invite: two.link })).text).toMatch(/^rate_limited: /);
  });
});

describe("S14: pair_page and /pair/claim answer an invitee's pairing code with invite_required", () => {
  it('at /pair/claim, before the nonce is read, so it survives', async () => {
    const { relay, page } = await sharedPage();
    relay.provider.signInSubject = GUEST;
    const phone = new Phone(relay.relay.url);
    try {
      await phone.signIn();
    } finally {
      relay.provider.signInSubject = null;
    }
    expect((await phone.preview(page.nonce)).data.account).toEqual({
      signedIn: true,
      member: false,
      inviteRequired: true,
    });
    await page.sync();
    const pairings = page.all('pairing').length;
    const claimed = await phone.claim(page.nonce);
    expect(claimed).toMatchObject({ status: 403, data: { error: 'invite_required' } });
    await page.sync();
    expect(page.all('pairing')).toHaveLength(pairings);
    expect(page.all('attach_request')).toHaveLength(1);
    // Counted and recorded as pair_page's would be (ADR 0019), with no page named.
    const refusals = () =>
      relay.relay.audit
        .events()
        .flatMap((event) =>
          event.type === 'attach_refused' && event.kind === 'invitee' ? [event] : [],
        );
    expect(refusals()).toEqual([
      expect.objectContaining({ via: 'qr', outcome: 'invite_required', pageId: null }),
    ]);
    // The per-user pairing limit (10 a minute) counts these too.
    for (let i = 2; i <= 10; i += 1) {
      expect((await phone.claim(page.nonce)).data.error).toBe('invite_required');
    }
    expect(await phone.claim(page.nonce)).toMatchObject({
      status: 429,
      data: { error: 'rate_limited' },
    });
    await page.sync();
    expect(page.all('pairing')).toHaveLength(pairings);
    // Ten lines for a stranger, then its refusals go into the window's summary.
    expect(refusals()).toHaveLength(10);
    await relay.close();
    const guestId = refusals()[0]?.userId;
    expect(relay.relay.audit.events()).toContainEqual(
      expect.objectContaining({
        type: 'refused_summary',
        scope: expect.objectContaining({
          kind: 'relay',
          busiest: [{ userId: guestId, counts: { rate_limited: 1 } }],
        }) as unknown,
      }),
    );
  });

  it('on pair_page, before the code is matched, so it is neither spent nor rotated', async () => {
    const { relay, page } = await sharedPage();
    const guest = await relay.claude(GUEST, GUEST_EMAIL);
    await page.sync();
    const code = page.code;
    expect((await call(guest, 'pair_page', { code })).text).toMatch(/^invite_required: /);
    await page.sync();
    expect(page.code).toBe(code);
    // The same code still pairs a member.
    const bob = await relay.claude('sub-bob');
    void call(bob, 'pair_page', { code }).catch(() => undefined);
    expect((await page.next('attach_request')).user.userId).toBe('bob');
  });
});

describe('S7: what invites leave in the audit log (ADR 0019)', () => {
  it('records minting, redemption, attachment and closing, each valid, with no secret, label or sub', async () => {
    const { relay, page } = await sharedPage();
    const minted = await mintOk(page, { uses: 1, label: 'Secret label' });
    const guest = await relay.claude(GUEST, GUEST_EMAIL);
    await redeem(guest, page, minted.link);
    const events = relay.relay.audit.events();
    for (const event of events) expect(AuditEventSchema.parse(event)).toEqual(event);
    expect(events.map((event) => event.type)).toEqual([
      'attach',
      'invite_minted',
      'attach',
      'invite_redeemed',
      'invite_closed',
    ]);
    expect(events[2]).toMatchObject({
      kind: 'invitee',
      via: 'invite',
      inviteId: minted.inviteId,
      email: GUEST_EMAIL,
      role: 'observer',
    });
    expect(events[1]).toMatchObject({ inviteId: minted.inviteId, sponsor: 'alice', uses: 1 });
    expect(events[4]).toMatchObject({ inviteId: minted.inviteId, reason: 'used_up' });
    const text = JSON.stringify(events);
    for (const kept of [minted.secret, minted.hash, minted.link, 'Secret label', GUEST]) {
      expect(text).not.toContain(kept);
    }
    // The stderr copy is the record less the email (ADR 0020).
    const all = relay.lines.join('\n');
    for (const kept of [minted.secret, minted.hash, GUEST_EMAIL, 'Secret label']) {
      expect(all).not.toContain(kept);
    }
    expect(all).toContain('"msg":"invite_redeemed"');
  });
});

describe('S7: a page cannot flush the audit log with operator frames (ADR 0019)', () => {
  it('bounds the promotions and mints a page makes, while what takes access away always goes through', async () => {
    // Past the grants most of this flood changes nothing, which a budget of
    // its own would close the socket for (the next test); lifted here, so the
    // grants are seen alone.
    const relay = await setup({
      rateLimits: { ignoredFramesPerSocket: 10_000, ignoredFramesPerAddress: 10_000 },
    });
    // Free driver seats, so every promotion would change a role and write a record.
    const page = await relay.page({ policy: { invites: 'all', maxDrivers: 3 } });
    await attachMember(await relay.claude('sub-alice'), page, 'observer');
    for (let i = 0; i < 200; i += 1) {
      page.send({ t: 'set_role', userId: 'alice', role: i % 2 === 0 ? 'driver' : 'observer' });
      page.send({
        t: 'invite_create',
        inviteId: `inv_flood_${String(i)}`,
        role: 'observer',
        label: 'Flood',
        uses: 1,
        expiresAt: null,
        secretHash: newSecret().hash,
      });
      page.send({ t: 'invite_cancel', inviteId: `inv_flood_${String(i)}` });
    }
    await page.sync();
    const events = relay.relay.audit.events();
    const count = (type: string, extra: (event: (typeof events)[number]) => boolean = () => true) =>
      events.filter((event) => event.type === type && extra(event)).length;
    const promotions = count('role', (event) => 'role' in event && event.role === 'driver');
    const minted = count('invite_minted');
    // Promotions and mints share the page's budget; demotions and cancels follow what they
    // undo, the demotion after the last promotion included, though it came past the budget.
    expect(promotions + minted).toBe(OPERATOR_GRANTS_PER_PAGE);
    expect(count('role')).toBe(2 * promotions);
    expect(count('invite_closed')).toBe(minted);
    // Past it, a mint is refused like one past the live limit, so invite() still settles.
    const answers = page.all('invites').filter((frame) => frame.refused !== undefined);
    expect(answers.at(-1)?.refused).toEqual({ inviteId: 'inv_flood_199', reason: 'limit' });
    // A promotion past it is refused, and the roster shows the role unchanged.
    page.send({ t: 'set_role', userId: 'alice', role: 'driver' });
    expect((await latest(page, 'roster')).attachments[0]?.role).toBe('observer');
    // The budget is a window's: the next one promotes again.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61_000);
    page.send({ t: 'set_role', userId: 'alice', role: 'driver' });
    expect((await latest(page, 'roster')).attachments[0]?.role).toBe('driver');
    vi.useRealTimers();
    // Revoke is never refused (S8).
    page.send({ t: 'revoke', userId: 'alice' });
    expect((await latest(page, 'roster')).attachments).toEqual([]);
    // The flood itself left one warning, not a line per frame.
    expect(relay.lines.filter((line) => line.includes('the page made too many'))).toHaveLength(1);
  });

  it('closes the socket of a page that keeps sending promotions and mints past its grants (A4.3)', async () => {
    const relay = await setup();
    const page = await relay.page({ policy: { invites: 'all', maxDrivers: 3 } });
    await attachMember(await relay.claude('sub-alice'), page, 'observer');
    for (let i = 0; i < 200; i += 1) {
      page.send({ t: 'set_role', userId: 'alice', role: i % 2 === 0 ? 'driver' : 'observer' });
      page.send({
        t: 'invite_create',
        inviteId: `inv_flood_${String(i)}`,
        role: 'observer',
        label: 'Flood',
        uses: 1,
        expiresAt: null,
        secretHash: newSecret().hash,
      });
      page.send({ t: 'invite_cancel', inviteId: `inv_flood_${String(i)}` });
    }
    expect(await page.closed).toEqual({ code: 1008, reason: 'too many ignored frames' });
    // Each refused mint writes a line, so only the budget's worth were written.
    const refusedLines = relay.lines.filter((line) => line.includes('"msg":"invite refused"'));
    expect(refusedLines.length).toBeGreaterThan(0);
    expect(refusedLines.length).toBeLessThanOrEqual(DEFAULT_RATE_LIMITS.ignoredFramesPerSocket + 1);
    // A policy close is no detach: the page sleeps, and Alice stays attached for its return.
    const back = await relay.page({
      policy: { invites: 'all', maxDrivers: 3 },
      resumeToken: page.welcome?.resumeToken ?? '',
    });
    expect(back.welcome?.resumed).toBe(true);
    expect(back.welcome?.roster).toMatchObject([{ userId: 'alice' }]);
  });
});

describe('S11: invite secrets never appear in logs', () => {
  it('keeps the secret, its hash and the link out of every line, wherever they arrive', async () => {
    const { relay, page } = await sharedPage();
    const minted = await mintOk(page, { uses: 1 });
    const guest = await relay.claude(GUEST, GUEST_EMAIL);
    // In the wrong places too: as a code, in a path, in a query.
    await call(guest, 'pair_page', { code: minted.secret });
    const phone = new Phone(relay.relay.url);
    await phone.request(`/i/${minted.secret}`);
    await phone.request(`/i?secret=${minted.secret}`);
    await phone.post('/i/preview', { secret: minted.secret });
    await redeem(guest, page, minted.link);
    await relay.close();
    const all = relay.lines.join('\n');
    for (const kept of [minted.secret, minted.hash, minted.link]) expect(all).not.toContain(kept);
    expect(all).toContain('attach request sent');
  });
});

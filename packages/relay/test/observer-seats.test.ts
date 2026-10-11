// ADR 0044, A6.19: invitees watching by invite sit in watching seats of
// their own (TABDOCK_MAX_OBSERVERS_PER_PAGE), counted apart from the page's
// people (TABDOCK_MAX_USERS_PER_PAGE), which alone keep members their two
// seats (S14). Against the relay in public URL mode with the stand-in
// provider, the page answering every request as the adapter would.

import { MAX_INVITE_USES } from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachMember,
  call,
  type InviteRelay,
  latest,
  MEMBERS,
  mintOk,
  redeem,
  signedInAtI,
  startInviteRelay,
} from './helpers/invites.ts';
import type { TestPage } from './helpers/page-client.ts';
import { fillRoom, guestEmail, guestSub, joinRoom, roomLimits } from './helpers/room.ts';

const MORE_MEMBERS = [
  { sub: 'sub-carol', userId: 'carol', displayName: 'Carol' },
  { sub: 'sub-dave', userId: 'dave', displayName: 'Dave' },
];

let current: InviteRelay | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function setup(options: Parameters<typeof startInviteRelay>[0] = {}): Promise<InviteRelay> {
  current = await startInviteRelay({
    users: [...MEMBERS, ...MORE_MEMBERS],
    ...options,
    rateLimits: { ...roomLimits, ...options.rateLimits },
  });
  return current;
}

async function rolesOf(page: TestPage): Promise<Record<string, string>> {
  const { attachments } = await latest(page, 'roster');
  return Object.fromEntries(attachments.map((entry) => [entry.userId, entry.role]));
}

/** The page's people and watchers, as the seats count them. */
async function seats(page: TestPage): Promise<{ people: number; watching: number }> {
  const { attachments } = await latest(page, 'roster');
  const watching = attachments.filter(
    (entry) => entry.kind === 'invitee' && entry.role === 'observer',
  ).length;
  return { people: attachments.length - watching, watching };
}

/** A /i claim the relay must refuse with page_busy before the page hears of it. */
async function refusedAtI(
  relay: InviteRelay,
  page: TestPage,
  index: number,
  secret: string,
): Promise<void> {
  await page.sync();
  const asked = page.all('attach_request').length;
  const phone = await signedInAtI(relay, guestSub(index), guestEmail(index));
  expect(await phone.post('/i/claim', { secret })).toMatchObject({
    status: 409,
    data: { error: 'page_busy' },
  });
  await page.sync();
  expect(page.all('attach_request')).toHaveLength(asked);
}

/** Control guests as the people seats take them: one control invite each, allowed as driver. */
async function controlGuest(relay: InviteRelay, page: TestPage, name: string) {
  const { link } = await mintOk(page, { role: 'driver' });
  const guest = await relay.claude(`sub-${name}`, `${name}@example.com`);
  const { outcome, request } = await redeem(guest, page, link, { allow: true, role: 'driver' });
  return { guest, outcome, userId: request.user.userId };
}

describe('watching seats beside the people (ADR 0044, A6.19)', () => {
  it('seat forty invitees by two watch invites while members keep the people seats, and turn the 41st away', async () => {
    const relay = await setup();
    const page = await relay.page({ policy: { invites: 'all' } });
    await attachMember(await relay.claude('sub-alice'), page);
    await attachMember(await relay.claude('sub-bob'), page, 'observer');
    const { secrets } = await fillRoom(relay, page, 40);
    expect(secrets).toHaveLength(40 / MAX_INVITE_USES);
    expect(await seats(page)).toEqual({ people: 2, watching: 40 });
    const { secret } = await mintOk(page, { uses: 2 });
    await refusedAtI(relay, page, 40, secret);
    // The people still have their seats.
    await attachMember(await relay.claude('sub-carol'), page, 'observer');
    expect(await seats(page)).toEqual({ people: 3, watching: 40 });
  }, 60_000);

  it('refuse a watcher past the seats with page_busy and its attach_refused record, while a member still pairs', async () => {
    const relay = await setup({ limits: { usersPerPage: 4, observersPerPage: 5 } });
    const page = await relay.page({ policy: { invites: 'all' } });
    await attachMember(await relay.claude('sub-alice'), page);
    await attachMember(await relay.claude('sub-bob'), page, 'observer');
    const { secrets } = await fillRoom(relay, page, 5);
    expect(await seats(page)).toEqual({ people: 2, watching: 5 });
    const [secret = ''] = secrets;
    await refusedAtI(relay, page, 5, secret);
    expect(relay.relay.audit.events()).toContainEqual(
      expect.objectContaining({
        type: 'attach_refused',
        kind: 'invitee',
        via: 'invite',
        outcome: 'page_busy',
        pageId: null,
      }),
    );
    // Seat three of the people is a member's.
    await attachMember(await relay.claude('sub-carol'), page, 'observer');
    expect(await seats(page)).toEqual({ people: 3, watching: 5 });
  });

  it("count a watch redemption waiting on the operator, so a full page's operator is never asked", async () => {
    const relay = await setup({ limits: { observersPerPage: 1 } });
    const page = await relay.page({ policy: { invites: 'all' } });
    await attachMember(await relay.claude('sub-alice'), page);
    const { link } = await mintOk(page);
    const first = await relay.claude('sub-w1', 'w1@example.com');
    // Left waiting on the operator; the relay's close answers it.
    void call(first, 'pair_page', { invite: link }).catch(() => undefined);
    await page.next('attach_request');
    const { secret } = await mintOk(page, { uses: 2 });
    await refusedAtI(relay, page, 1, secret);
  });

  it('keep the reserve of two member seats among the people from control guests', async () => {
    const relay = await setup({ limits: { usersPerPage: 4, observersPerPage: 5 } });
    const page = await relay.page({ policy: { invites: 'all', maxDrivers: 3 } });
    await attachMember(await relay.claude('sub-alice'), page);
    for (const name of ['c1', 'c2']) {
      const { outcome } = await controlGuest(relay, page, name);
      expect(outcome.structured).toMatchObject({ role: 'driver' });
    }
    expect(await seats(page)).toEqual({ people: 3, watching: 0 });
    // A third control guest would take a member's seat, so the page never hears of them.
    const { link } = await mintOk(page, { role: 'driver' });
    const third = await relay.claude('sub-c3', 'c3@example.com');
    await page.sync();
    const asked = page.all('attach_request').length;
    expect((await call(third, 'pair_page', { invite: link })).text).toMatch(
      /^page_busy: the page has no seat left for someone joining by invite/,
    );
    await page.sync();
    expect(page.all('attach_request')).toHaveLength(asked);
    // Watching seats are another matter, and the reserve's last seat a member's.
    const { secret } = await mintOk(page, { uses: 2 });
    await joinRoom(relay, page, 0, secret);
    await attachMember(await relay.claude('sub-bob'), page, 'observer');
    expect(await seats(page)).toEqual({ people: 4, watching: 1 });
  });

  it('refuse an approval the watching seats filled up for while the operator decided', async () => {
    const relay = await setup({ limits: { usersPerPage: 4, observersPerPage: 1 } });
    const page = await relay.page({ policy: { invites: 'all', maxDrivers: 3 } });
    await attachMember(await relay.claude('sub-alice'), page);
    const control = await controlGuest(relay, page, 'c1');
    const { link } = await mintOk(page);
    const watcher = await relay.claude('sub-w1', 'w1@example.com');
    const { outcome, request } = await (async () => {
      const pending = call(watcher, 'pair_page', { invite: link });
      const asked = await page.next('attach_request');
      // Meanwhile the operator moves the control guest into the one watching seat.
      page.send({ t: 'set_role', userId: control.userId, role: 'observer' });
      await page.sync();
      page.send({ t: 'attach_decision', requestId: asked.requestId, allow: true });
      return { outcome: await pending, request: asked };
    })();
    expect(outcome.text).toMatch(/^page_busy: the page has no room left for anyone else to watch/);
    expect((await rolesOf(page))[request.user.userId]).toBeUndefined();
    expect(await seats(page)).toEqual({ people: 1, watching: 1 });
  });
});

describe('moving between the seats (ADR 0044)', () => {
  it('leaves a watcher an observer when the people have no seat for a promotion', async () => {
    const relay = await setup({ limits: { usersPerPage: 4, observersPerPage: 5 } });
    const page = await relay.page({ policy: { invites: 'all' } });
    await attachMember(await relay.claude('sub-alice'), page);
    // maxDrivers is 1 and Alice drives, so the control guest joins as an observer, watching.
    const { userId } = await controlGuest(relay, page, 'c1');
    expect(await seats(page)).toEqual({ people: 1, watching: 1 });
    for (const sub of ['sub-bob', 'sub-carol', 'sub-dave']) {
      await attachMember(await relay.claude(sub), page, 'observer');
    }
    expect(await seats(page)).toEqual({ people: 4, watching: 1 });
    page.send({ t: 'set_role', userId: 'alice', role: 'observer' });
    page.send({ t: 'set_role', userId, role: 'driver' });
    await page.sync();
    expect((await rolesOf(page))[userId]).toBe('observer');
    expect(relay.events()).toContainEqual(
      expect.objectContaining({ msg: "set_role refused: no seat left among the page's people" }),
    );
    // A member leaving frees the seat, and the same promotion goes through.
    page.send({ t: 'revoke', userId: 'dave' });
    page.send({ t: 'set_role', userId, role: 'driver' });
    await page.sync();
    expect((await rolesOf(page))[userId]).toBe('driver');
    expect(await seats(page)).toEqual({ people: 4, watching: 0 });
  });

  it("leaves a watcher an observer when the people's seats invites may use are taken", async () => {
    const relay = await setup({ limits: { usersPerPage: 4, observersPerPage: 5 } });
    // Driver seats to spare, so only the people's seats can hold the promotion back.
    const page = await relay.page({ policy: { invites: 'all', maxDrivers: 5 } });
    await attachMember(await relay.claude('sub-alice'), page);
    await controlGuest(relay, page, 'c1');
    // A control guest the operator lets in as an observer watches.
    const { userId } = await (async () => {
      const { link } = await mintOk(page, { role: 'driver' });
      const guest = await relay.claude('sub-c3', 'c3@example.com');
      const { request } = await redeem(guest, page, link, { allow: true, role: 'observer' });
      return { userId: request.user.userId };
    })();
    await controlGuest(relay, page, 'c2');
    expect(await seats(page)).toEqual({ people: 3, watching: 1 });
    page.send({ t: 'set_role', userId, role: 'driver' });
    await page.sync();
    // One seat is free, but it is the members' reserve.
    expect((await rolesOf(page))[userId]).toBe('observer');
    // A member in it is no guest, and keeps the guests' count where it was.
    await attachMember(await relay.claude('sub-bob'), page, 'observer');
    expect(await seats(page)).toEqual({ people: 4, watching: 1 });
  });

  it('never refuses a demotion, which may fill the watching seats past their number and holds the next watcher back', async () => {
    const relay = await setup({ limits: { usersPerPage: 4, observersPerPage: 2 } });
    const page = await relay.page({ policy: { invites: 'all', maxDrivers: 3 } });
    await attachMember(await relay.claude('sub-alice'), page);
    const control = await controlGuest(relay, page, 'c1');
    const { secrets, guests } = await fillRoom(relay, page, 2, { uses: 5 });
    expect(await seats(page)).toEqual({ people: 2, watching: 2 });
    page.send({ t: 'set_role', userId: control.userId, role: 'observer' });
    await page.sync();
    expect((await rolesOf(page))[control.userId]).toBe('observer');
    expect(await seats(page)).toEqual({ people: 1, watching: 3 });
    const [secret = ''] = secrets;
    await refusedAtI(relay, page, 2, secret);
    // Two leaving brings the watchers under their number again.
    page.send({ t: 'revoke', userId: guests[0]?.userId ?? '' });
    page.send({ t: 'revoke', userId: guests[1]?.userId ?? '' });
    await page.sync();
    await joinRoom(relay, page, 3, secret);
    expect(await seats(page)).toEqual({ people: 1, watching: 2 });
  });
});

describe('with no watching seats (TABDOCK_MAX_OBSERVERS_PER_PAGE=0)', () => {
  it("seats watchers among the people under M5's rule", async () => {
    const relay = await setup({ limits: { usersPerPage: 4, observersPerPage: 0 } });
    const page = await relay.page({ policy: { invites: 'all' } });
    await attachMember(await relay.claude('sub-alice'), page);
    const { secrets } = await fillRoom(relay, page, 2, { uses: 5 });
    const [secret = ''] = secrets;
    await refusedAtI(relay, page, 2, secret);
    await attachMember(await relay.claude('sub-bob'), page, 'observer');
    expect((await latest(page, 'roster')).attachments).toHaveLength(4);
    expect(page.welcome?.limits.observersPerPage).toBe(0);
  });
});

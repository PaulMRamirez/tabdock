// ADR 0044 on the page: when the operator makes a watcher a driver and the
// relay keeps them an observer because the page's people have no seat for
// them, the page says so in the operator's own words, as it does for the
// driver limit. The roster carries no reason, so the page judges it from the
// welcome's seat numbers and the roster, for its words only.

import { describe, expect, it } from 'vitest';
import {
  attachment,
  flush,
  GUEST,
  invitedAttachment,
  invitesFrame,
  link,
  mint,
  redemption,
  setup,
  welcome,
} from './harness.ts';

/**
 * Alice and Bob attached as members, and a guest a Can control invite let
 * in whom the driver limit left watching; the welcome says the page holds
 * `usersPerPage` people beside 40 watching seats.
 */
async function watchedPage(usersPerPage: number) {
  const h = setup({ core: { policy: { invites: 'all' } } });
  const limits = { ...welcome(h.clock).limits, usersPerPage, observersPerPage: 40 };
  const socket = await link(h, { limits }, { alice: 'driver', bob: 'observer' });
  socket.deliver(invitesFrame([]));
  const minted = await mint(h, socket, { label: 'Pair', role: 'driver' });
  socket.deliver(redemption(h.clock, minted));
  await flush();
  expect(h.dock.approve(`redeem-${minted.inviteId}`, 'driver')).toBe(true);
  const guest = invitedAttachment(GUEST, 'observer', minted.inviteId, h.clock.now + 60_000);
  const roster = [attachment('alice', 'observer'), attachment('bob', 'observer'), guest];
  socket.deliver({ t: 'roster', attachments: roster });
  await flush();
  return { h, socket, roster };
}

describe('a promotion the people have no seat for (ADR 0044)', () => {
  it('records a seat the people held, which the widget words as such', async () => {
    const { h, socket, roster } = await watchedPage(2);
    expect(h.dock.state.observerSeats).toEqual([]);
    expect(h.dock.setRole(GUEST, 'driver')).toBe(true);
    socket.deliver({ t: 'roster', attachments: roster });
    await flush();
    expect(h.dock.state.observerSeats).toMatchObject([
      { user: { userId: GUEST }, account: null, asked: 'promote', heldBy: 'people' },
    ]);
    expect(
      h.logs.some((line) =>
        line.endsWith('is still an observer: the page has no seat left among its people'),
      ),
    ).toBe(true);
  });

  it('says only that the relay kept them while a seat is free among the people', async () => {
    const { h, socket, roster } = await watchedPage(10);
    expect(h.dock.setRole(GUEST, 'driver')).toBe(true);
    socket.deliver({ t: 'roster', attachments: roster });
    await flush();
    expect(h.dock.state.observerSeats).toEqual([]);
    expect(h.logs.some((line) => /^info the relay kept .+ an observer$/.test(line))).toBe(true);
  });
});

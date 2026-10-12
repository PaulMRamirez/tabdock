// The slots waiting fixed tool calls share (waits.ts, conflict C2 of the M6
// plan): two per user across every page and both waiting tools, one for each
// seat a page may hold, and the page's invitees held to that less the two
// seats members keep, each given back once however often it is released.

import { MAX_WAITS_PER_USER, MEMBER_RESERVED_SEATS } from '@tabdock/protocol';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.ts';
import { createDevTokenAuth } from '../src/index.ts';
import { type WaitSlot, WaitSlots, waitLimitsOf } from '../src/waits.ts';
import { ALICE } from './helpers/relay.ts';

const auth = createDevTokenAuth([ALICE]);

/** The slot, failing the test if a limit refused it. */
function slot(taken: WaitSlot | string): WaitSlot {
  if (typeof taken === 'string') throw new Error(`refused: ${taken}`);
  return taken;
}

describe('the wait limits a relay settings give', () => {
  it('are two per user, and per page the people and the watching seats, with invites on', () => {
    expect(MAX_WAITS_PER_USER).toBe(2);
    expect(waitLimitsOf(resolveConfig({ auth, invites: true }))).toEqual({
      perUser: 2,
      perPage: 10 + 40,
      inviteesPerPage: 10 + 40 - MEMBER_RESERVED_SEATS,
    });
    expect(
      waitLimitsOf(
        resolveConfig({ auth, invites: true, limits: { usersPerPage: 4, observersPerPage: 0 } }),
      ),
    ).toEqual({ perUser: 2, perPage: 4, inviteesPerPage: 2 });
  });

  it('count no watching seats with invites off', () => {
    expect(waitLimitsOf(resolveConfig({ auth }))).toEqual({
      perUser: 2,
      perPage: 10,
      inviteesPerPage: 8,
    });
    expect(waitLimitsOf(resolveConfig({ auth, limits: { usersPerPage: 1 } }))).toEqual({
      perUser: 2,
      perPage: 1,
      inviteesPerPage: 0,
    });
  });
});

describe('WaitSlots', () => {
  it('gives each user two slots across every page, and refuses the third as theirs', () => {
    const slots = new WaitSlots({ perUser: 2, perPage: 10, inviteesPerPage: 8 });
    const first = slot(slots.take('alice', 'pg_A', false));
    slot(slots.take('alice', 'pg_B', false));
    expect(slots.take('alice', 'pg_C', false)).toBe('user');
    expect(slots.take('alice', 'pg_A', false)).toBe('user');
    expect(slots.heldBy('alice')).toBe(2);
    // Another user is untouched.
    slot(slots.take('bob', 'pg_A', false));
    first.release();
    expect(slots.heldBy('alice')).toBe(1);
    slot(slots.take('alice', 'pg_C', false));
  });

  it("refuses past the page's count, and the user's own cap first", () => {
    const slots = new WaitSlots({ perUser: 2, perPage: 3, inviteesPerPage: 1 });
    slot(slots.take('a', 'pg_A', false));
    slot(slots.take('b', 'pg_A', false));
    slot(slots.take('c', 'pg_A', false));
    expect(slots.take('d', 'pg_A', false)).toBe('page');
    expect(slots.take('d', 'pg_A', true)).toBe('page');
    // Another page has its own count.
    slot(slots.take('d', 'pg_B', false));
    slot(slots.take('d', 'pg_C', false));
    expect(slots.take('d', 'pg_A', false)).toBe('user');
    expect(slots.heldOn('pg_A')).toEqual({ all: 3, invitees: 0 });
  });

  it("keeps the page's last two slots from invitees, so members can still wait", () => {
    const slots = new WaitSlots({ perUser: 2, perPage: 4, inviteesPerPage: 2 });
    const guest = slot(slots.take('g_1', 'pg_A', true));
    slot(slots.take('g_2', 'pg_A', true));
    expect(slots.take('g_3', 'pg_A', true)).toBe('invitee');
    // Members take the two the invitees cannot.
    slot(slots.take('alice', 'pg_A', false));
    slot(slots.take('bob', 'pg_A', false));
    expect(slots.take('carol', 'pg_A', false)).toBe('page');
    expect(slots.heldOn('pg_A')).toEqual({ all: 4, invitees: 2 });
    guest.release();
    expect(slots.heldOn('pg_A')).toEqual({ all: 3, invitees: 1 });
    slot(slots.take('g_3', 'pg_A', true));
  });

  it('gives back each count once, however often a slot is released', () => {
    const slots = new WaitSlots({ perUser: 2, perPage: 2, inviteesPerPage: 1 });
    const guest = slot(slots.take('g_1', 'pg_A', true));
    const member = slot(slots.take('alice', 'pg_A', false));
    guest.release();
    guest.release();
    member.release();
    member.release();
    expect(slots.heldBy('g_1')).toBe(0);
    expect(slots.heldBy('alice')).toBe(0);
    expect(slots.heldOn('pg_A')).toEqual({ all: 0, invitees: 0 });
    // A double release never made room past the limits.
    slot(slots.take('g_1', 'pg_A', true));
    expect(slots.take('g_2', 'pg_A', true)).toBe('invitee');
    slot(slots.take('alice', 'pg_A', false));
    expect(slots.take('bob', 'pg_A', false)).toBe('page');
  });

  it('refuses every wait on a page with no slots, and every invitee where they have none', () => {
    const none = new WaitSlots({ perUser: 2, perPage: 0, inviteesPerPage: 0 });
    expect(none.take('alice', 'pg_A', false)).toBe('page');
    const membersOnly = new WaitSlots({ perUser: 2, perPage: 2, inviteesPerPage: 0 });
    expect(membersOnly.take('g_1', 'pg_A', true)).toBe('invitee');
    slot(membersOnly.take('alice', 'pg_A', false));
  });

  it('keeps its own copy of the limits it was given', () => {
    const limits = { perUser: 1, perPage: 1, inviteesPerPage: 1 };
    const slots = new WaitSlots(limits);
    limits.perUser = 5;
    slot(slots.take('alice', 'pg_A', false));
    expect(slots.take('alice', 'pg_B', false)).toBe('user');
  });
});

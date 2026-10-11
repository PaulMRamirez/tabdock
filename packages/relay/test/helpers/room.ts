// A class joining one page (ADR 0044): invitees sign in at /i through the
// stand-in provider, each with a verified email of their own, and join by
// watch invites of up to MAX_INVITE_USES uses, minted as the room needs them.
// The test page allows each request, standing in for the adapter honouring a
// watch invite against its own record (ADR 0017). The page's pairing limit
// counts every redemption that lands on it (S14), so a test filling a room in
// one window raises pairAttemptsPerPage; see roomLimits.

import { MAX_INVITE_USES } from '@tabdock/protocol';
import { expect } from 'vitest';
import type { RelayOptions } from '../../src/index.ts';
import { type InviteRelay, joinAtI, mintOk, signedInAtI } from './invites.ts';
import type { TestPage } from './page-client.ts';
import type { Phone } from './phone.ts';

/** One student: their subject at the provider, the id the relay gave them, and their browser at /i. */
export interface Guest {
  sub: string;
  email: string;
  userId: string;
  phone: Phone;
}

export function guestSub(index: number): string {
  return `sub-room-${String(index)}`;
}

export function guestEmail(index: number): string {
  return `student${String(index)}@example.com`;
}

/**
 * Rate limits for a room that joins within one window: the page's pairing
 * limit and the relay's sign-ins at /i, each far above the room, so a test
 * shows the seats and nothing else refusing.
 */
export const roomLimits = {
  pairAttemptsPerPage: 500,
  pairSignIns: 500,
} satisfies NonNullable<RelayOptions['rateLimits']>;

export interface FillOptions {
  /** The first guest's index, so a second call adds new people. */
  from?: number;
  /** Uses for each invite minted; MAX_INVITE_USES unless set. */
  uses?: number;
  label?: string;
}

/**
 * Signs `count` invitees in at /i and has each join by the newest watch
 * invite, minting another whenever the last is used up, so a room of n
 * takes ceil(n / uses) invites. Every join must be approved, as an observer.
 */
export async function fillRoom(
  relay: InviteRelay,
  page: TestPage,
  count: number,
  options: FillOptions = {},
): Promise<{ guests: Guest[]; secrets: string[] }> {
  const from = options.from ?? 0;
  const uses = options.uses ?? MAX_INVITE_USES;
  const guests: Guest[] = [];
  const secrets: string[] = [];
  for (let at = 0; at < count; at += 1) {
    if (at % uses === 0) {
      const minted = await mintOk(page, { uses, label: options.label ?? 'Class' });
      secrets.push(minted.secret);
    }
    const index = from + at;
    const guest = await joinRoom(relay, page, index, secrets.at(-1) ?? '');
    guests.push(guest);
  }
  return { guests, secrets };
}

/** One student joins by a watch invite's secret at /i and is let in. */
export async function joinRoom(
  relay: InviteRelay,
  page: TestPage,
  index: number,
  secret: string,
): Promise<Guest> {
  const sub = guestSub(index);
  const email = guestEmail(index);
  const phone = await signedInAtI(relay, sub, email);
  const { request, settled } = await joinAtI(phone, page, secret);
  expect(settled, `guest ${String(index)}`).toEqual({ status: 'approved', role: 'observer' });
  return { sub, email, userId: request.user.userId, phone };
}

// The slots that waiting fixed tool calls take (ADRs 0040 and 0042, conflict
// C2 of the M6 plan): wait_for_page_state and get_proposal's wait share one
// set of limits, so two tools cannot let one account hold twice as many
// waits. A wait is a request held open, and each still holds its request
// charge (#holdBytes in hub.ts); these counts bound how many there are:
//
// - per user: MAX_WAITS_PER_USER across every page and both tools, enough
//   for a looping agent to overlap at the turn of its loop;
// - per page: one for each person and each watching seat the page may hold
//   (usersPerPage, plus observersPerPage with invites on), so a full room of
//   looping agents fits (ADR 0044);
// - invitees on one page: that less MEMBER_RESERVED_SEATS, so the page's
//   members can always wait however many guests do, as they keep two of its
//   seats (ADR 0017).
//
// Counts only: nothing here times a wait or wakes one.

import { MAX_WAITS_PER_USER, MEMBER_RESERVED_SEATS } from '@tabdock/protocol';
import type { ResolvedConfig } from './config.ts';

/** A wait's place in every count it took; release gives all of them back, once. */
export interface WaitSlot {
  release(): void;
}

/** Which limit refused a wait: the user's own, the page's, or the page's invitees'. */
export type WaitRefusal = 'user' | 'page' | 'invitee';

export interface WaitLimits {
  perUser: number;
  perPage: number;
  inviteesPerPage: number;
}

/** The limits a relay's settings give, as the comment above lays them out. */
export function waitLimitsOf(config: Pick<ResolvedConfig, 'invites' | 'limits'>): WaitLimits {
  const { usersPerPage, observersPerPage } = config.limits;
  // With invites off nobody holds a watching seat, so it adds no waits.
  const perPage = usersPerPage + (config.invites ? observersPerPage : 0);
  return {
    perUser: MAX_WAITS_PER_USER,
    perPage,
    inviteesPerPage: Math.max(0, perPage - MEMBER_RESERVED_SEATS),
  };
}

function bump(counts: Map<string, number>, key: string, by: number): void {
  const next = (counts.get(key) ?? 0) + by;
  if (next > 0) counts.set(key, next);
  else counts.delete(key);
}

export class WaitSlots {
  readonly #limits: WaitLimits;
  readonly #byUser = new Map<string, number>();
  readonly #byPage = new Map<string, number>();
  readonly #inviteesByPage = new Map<string, number>();

  constructor(limits: WaitLimits) {
    this.#limits = { ...limits };
  }

  /**
   * A slot for one wait by this user on this page, or which limit refuses
   * it. The user's own limit is looked at first, so an account at its own
   * cap hears that rather than that the page is full.
   */
  take(userId: string, pageId: string, invitee: boolean): WaitSlot | WaitRefusal {
    const { perUser, perPage, inviteesPerPage } = this.#limits;
    if ((this.#byUser.get(userId) ?? 0) >= perUser) return 'user';
    if ((this.#byPage.get(pageId) ?? 0) >= perPage) return 'page';
    if (invitee && (this.#inviteesByPage.get(pageId) ?? 0) >= inviteesPerPage) return 'invitee';
    bump(this.#byUser, userId, 1);
    bump(this.#byPage, pageId, 1);
    if (invitee) bump(this.#inviteesByPage, pageId, 1);
    let held = true;
    return {
      release: () => {
        if (!held) return;
        held = false;
        bump(this.#byUser, userId, -1);
        bump(this.#byPage, pageId, -1);
        if (invitee) bump(this.#inviteesByPage, pageId, -1);
      },
    };
  }

  /** The waits a user holds now, across every page. */
  heldBy(userId: string): number {
    return this.#byUser.get(userId) ?? 0;
  }

  /** The waits on a page now, and how many of them invitees hold. */
  heldOn(pageId: string): { all: number; invitees: number } {
    return {
      all: this.#byPage.get(pageId) ?? 0,
      invitees: this.#inviteesByPage.get(pageId) ?? 0,
    };
  }
}

// What the relay keeps of proposals (ADR 0042, S9), tested on PageProposals
// itself: a narrowed policy cancels what it no longer admits and tells the
// page why; settled outcomes stay readable ten minutes, on their own timer,
// forty a page at most, each charged until forgotten; kept results give
// way, oldest first, to new proposals and new results, and kept outcomes to
// new proposals, never a pending proposal's arguments, past which a new
// proposal is refused.

import {
  type JsonObject,
  MAX_PROPOSAL_RESULT_CHARS,
  MAX_SETTLED_PROPOSALS_PER_PAGE,
  PROPOSAL_OUTCOME_KEEP_MS,
} from '@tabdock/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallerIdentity } from '../src/hub.ts';
import {
  MAX_PROPOSAL_CHARGE,
  PageProposals,
  PROPOSAL_HEAP_BYTES,
  proposalCharge,
  type ProposalRecord,
  type ProposalReservation,
} from '../src/proposals.ts';
import { PAGE_ORIGIN } from './helpers/page-client.ts';
import { ARGS } from './helpers/proposals.ts';

afterEach(() => {
  vi.useRealTimers();
});

function caller(userId: string): CallerIdentity {
  return {
    userId,
    displayName: userId,
    account: { kind: 'member', email: null },
    oauthClientId: null,
    client: null,
    agentPageId: null,
  };
}

function held(budgetBytes = 64 * 1024 * 1024, admitted = true) {
  const ended: [string, string, string | null][] = [];
  const proposals = new PageProposals({
    ttlMs: 600_000,
    budgetBytes,
    ended: (record, reason, frame) => {
      ended.push([record.proposalId, reason, frame]);
    },
    admitted: () => admitted,
  });
  let n = 0;
  const make = (
    pageId: string,
    userId: string,
    args: JsonObject = ARGS,
  ): ProposalRecord | Exclude<ReturnType<PageProposals['reserve']>, ProposalReservation> => {
    const reservation = proposals.reserve(pageId, userId, proposalCharge(args), Date.now());
    if (typeof reservation === 'string') return reservation;
    n += 1;
    return proposals.commit(reservation, {
      proposalId: `pr_${String(n).padStart(10, '0')}`,
      origin: PAGE_ORIGIN,
      proposer: caller(userId),
      grantedAt: 1,
      tool: 'add_item',
      args,
      createdAt: Date.now(),
    });
  };
  const made = (pageId: string, userId: string, args?: JsonObject): ProposalRecord => {
    const record = make(pageId, userId, args);
    if (typeof record === 'string') throw new Error(`refused: ${record}`);
    return record;
  };
  return { proposals, ended, make, made };
}

describe('PageProposals', () => {
  it("cancels the pending proposals a narrowed policy no longer admits, telling the page 'policy'", () => {
    const { proposals, ended, made } = held(undefined, false);
    const record = made('pg_1', 'bob');
    proposals.policyChanged('pg_1');
    expect(ended).toEqual([[record.proposalId, 'cancelled', 'policy']]);
    expect(record.status).toBe('cancelled');
    expect(record.args).toBeNull();
    // Its arguments went; its outcome is kept, and charged, for its proposer.
    expect(proposals.held).toBe(PROPOSAL_HEAP_BYTES);
    proposals.close();
  });

  it('keeps every pending proposal a policy still admits', () => {
    const { proposals, ended, made } = held(undefined, true);
    made('pg_1', 'bob');
    proposals.policyChanged('pg_1');
    expect(ended).toEqual([]);
    proposals.close();
  });

  it('keeps at most 40 settled outcomes a page, the oldest going first', () => {
    const { proposals, made } = held();
    const first = made('pg_1', 'user0');
    proposals.end(first, 'dismissed', null);
    let last = first;
    for (let n = 1; n <= MAX_SETTLED_PROPOSALS_PER_PAGE; n += 1) {
      last = made('pg_1', `user${String(n)}`);
      proposals.end(last, 'dismissed', null);
    }
    expect(proposals.find('pg_1', first.proposalId, Date.now())).toBeUndefined();
    expect(proposals.find('pg_1', last.proposalId, Date.now())).toBe(last);
    proposals.close();
  });

  it('forgets an outcome 10 minutes after it settled', () => {
    const { proposals, made } = held();
    const record = made('pg_1', 'bob');
    proposals.end(record, 'withdrawn', 'withdrawn');
    const settled = record.settledAt ?? 0;
    expect(proposals.find('pg_1', record.proposalId, settled + PROPOSAL_OUTCOME_KEEP_MS)).toBe(
      record,
    );
    expect(
      proposals.find('pg_1', record.proposalId, settled + PROPOSAL_OUTCOME_KEEP_MS + 1),
    ).toBeUndefined();
    proposals.close();
  });

  it('charges a kept outcome until it is forgotten, so the budget bounds outcomes too (S9)', () => {
    const { proposals, made } = held();
    const record = made('pg_1', 'bob');
    expect(proposals.held).toBe(proposalCharge(ARGS));
    proposals.end(record, 'dismissed', null);
    expect(proposals.held).toBe(PROPOSAL_HEAP_BYTES);
    proposals.gone('pg_1');
    expect(proposals.held).toBe(0);
    proposals.close();
  });

  it('forgets an outcome on its own timer 10 minutes after it settled, though nobody looks', () => {
    vi.useFakeTimers();
    const { proposals, made } = held();
    const record = made('pg_1', 'bob');
    proposals.end(record, 'withdrawn', 'withdrawn');
    vi.advanceTimersByTime(PROPOSAL_OUTCOME_KEEP_MS - 1);
    expect(proposals.byId(record.proposalId)).toBe(record);
    vi.advanceTimersByTime(1);
    expect(proposals.byId(record.proposalId)).toBeUndefined();
    expect(proposals.held).toBe(0);
    proposals.close();
  });

  it('makes room for a new proposal by forgetting the oldest kept outcomes, and drops none when that would not do', () => {
    const outcomes = 3 * PROPOSAL_HEAP_BYTES;
    const medium = { label: 'x'.repeat(1000) };
    // Three outcomes and one medium proposal do not fit together; two outcomes and one do.
    const budget = outcomes + proposalCharge(medium) - 1;
    const { proposals, make, made } = held(budget);
    const settled = ['a', 'b', 'c'].map((userId) => made('pg_1', userId));
    for (const record of settled) proposals.end(record, 'dismissed', null);
    expect(proposals.held).toBe(outcomes);
    made('pg_2', 'd', medium);
    expect(settled.map((record) => proposals.byId(record.proposalId))).toEqual([
      undefined,
      settled[1],
      settled[2],
    ]);
    // Larger than the whole budget less what is pending: refused, and the kept two stay.
    expect(make('pg_2', 'e', { label: 'x'.repeat(5000) })).toBe('relay');
    expect(proposals.byId(settled[1]?.proposalId ?? '')).toBe(settled[1]);
    expect(proposals.byId(settled[2]?.proposalId ?? '')).toBe(settled[2]);
    proposals.close();
  });

  it("gives each user an eighth of the budget across pages, never less than one proposal at the caps, before the relay's", () => {
    const MIB = 1024 * 1024;
    expect(held(16 * MIB).proposals.userShare).toBe(2 * MIB);
    expect(held(MIB).proposals.userShare).toBe(MAX_PROPOSAL_CHARGE);
    const { proposals, make, made } = held(2 * MIB);
    // About 127 KiB each: two fit in a 256 KiB share.
    const dense = { label: 'x', n: Array.from({ length: 995 }, () => 0) };
    const first = made('pg_1', 'bob', dense);
    made('pg_2', 'bob', dense);
    expect(make('pg_3', 'bob', dense)).toBe('share');
    expect(make('pg_3', 'carol', dense)).toMatchObject({ proposer: { userId: 'carol' } });
    // Settling frees its arguments' charge, and with it the share.
    proposals.end(first, 'dismissed', null);
    expect(make('pg_3', 'bob', dense)).toMatchObject({ proposer: { userId: 'bob' } });
    proposals.close();
  });

  it('drops the oldest kept results to make room, never a pending proposal, and refuses past that', () => {
    // Room for two results of about 42 KiB and little else.
    const { proposals, make, made } = held(100 * 1024);
    const older = made('pg_1', 'a');
    const newer = made('pg_2', 'b');
    for (const record of [older, newer]) {
      proposals.accept(record);
      proposals.settleRun(record, 'ok', {
        text: 'r'.repeat(MAX_PROPOSAL_RESULT_CHARS + 10),
        image: false,
      });
    }
    expect(older.result?.text.startsWith('r'.repeat(MAX_PROPOSAL_RESULT_CHARS))).toBe(true);
    expect(older.result?.cut).toBe(true);
    // A pending proposal of about 34 KiB makes room by dropping the older result only.
    made('pg_3', 'c', { label: 'x'.repeat(16_000) });
    expect(older.result).toBeNull();
    expect(older.dropped).toBe(true);
    expect(newer.result).not.toBeNull();
    made('pg_4', 'd', { label: 'x'.repeat(16_000) });
    expect(newer.result).toBeNull();
    // Only pending proposals hold the budget now, and none gives way.
    expect(make('pg_5', 'e', { label: 'x'.repeat(16_000) })).toBe('relay');
    proposals.close();
  });

  it("wakes a wait on an ended attachment's accepted run at once, with why, and no one else's (S8)", async () => {
    const { proposals, made } = held();
    const bobs = made('pg_1', 'bob');
    const carols = made('pg_1', 'carol');
    expect(proposals.accept(bobs) && proposals.accept(carols)).toBe(true);
    const never = new AbortController().signal;
    const bobWaits = proposals.wait(bobs, 60_000, never);
    const carolWaits = proposals.wait(carols, 50, never);
    const why = { kind: 'error', code: 'not_attached', message: 'revoked' } as const;
    proposals.attachmentsEnded('pg_1', new Set(['bob']), why);
    expect(await bobWaits).toEqual(why);
    expect(await carolWaits).toEqual({ kind: 'timeout' });
    proposals.close();
  });

  it('wakes a wait when its proposal leaves pending, and a later one when the run settles', async () => {
    const { proposals, made } = held();
    const record = made('pg_1', 'bob');
    const never = new AbortController().signal;
    const first = proposals.wait(record, 60_000, never);
    expect(proposals.accept(record)).toBe(true);
    expect(await first).toEqual({ kind: 'changed' });
    const second = proposals.wait(record, 60_000, never);
    proposals.settleRun(record, 'ok', { text: 'done', image: false });
    expect(await second).toEqual({ kind: 'changed' });
    proposals.close();
  });

  it.each([
    ['sleeps', 'sleep', 'page_asleep', /^the page disconnected while you waited/],
    ['reloads', 'resumed', 'page_asleep', /^the page reloaded while you waited/],
    ['goes', 'gone', 'page_gone', /^the page closed and did not come back/],
  ] as const)(
    'answers every wait on the page at once when it %s, pending or running, and cancels what is pending',
    async (_, how, code, message) => {
      const { proposals, ended, made } = held();
      const pending = made('pg_1', 'bob');
      const running = made('pg_1', 'carol');
      const elsewhere = made('pg_2', 'bob');
      proposals.accept(running);
      const never = new AbortController().signal;
      const waits = [pending, running].map((record) => proposals.wait(record, 60_000, never));
      const other = proposals.wait(elsewhere, 50, never);
      proposals[how]('pg_1');
      for (const woken of await Promise.all(waits)) {
        expect(woken).toEqual({
          kind: 'error',
          code,
          message: expect.stringMatching(message) as unknown,
        });
      }
      expect(await other).toEqual({ kind: 'timeout' });
      expect(ended).toEqual([[pending.proposalId, 'cancelled', null]]);
      proposals.close();
    },
  );

  it('forgets every proposal of a page that is gone, pending or kept', () => {
    const { proposals, ended, made } = held();
    const pending = made('pg_1', 'bob');
    const settled = made('pg_1', 'carol');
    proposals.end(settled, 'dismissed', null);
    proposals.gone('pg_1');
    expect(ended).toEqual([
      [settled.proposalId, 'dismissed', null],
      [pending.proposalId, 'cancelled', null],
    ]);
    expect(proposals.byId(pending.proposalId)).toBeUndefined();
    expect(proposals.byId(settled.proposalId)).toBeUndefined();
    expect(proposals.held).toBe(0);
    proposals.close();
  });
});

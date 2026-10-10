// ADR 0043's protocol pieces: a session's policy against the page's ceiling,
// the session the adapter keeps in the tab's storage, the members file's
// entries, and the session numbers. withinCeiling and narrowPolicy run over
// every combination a small ceiling allows, so a proposal order out of place
// or a field left unclamped fails here.

import { describe, expect, it } from 'vitest';
import {
  MAX_MEMBERS,
  MAX_MEMBERS_FILE_BYTES,
  MAX_SESSION_MS,
  MEMBERS_POLL_MS,
  MemberEntrySchema,
  MemberSubSchema,
  MIN_SESSION_MS,
  narrowPolicy,
  type Policy,
  PolicySchema,
  type ProposalPolicy,
  PROPOSALS_ORDER,
  SESSION_END_GRACE_MS,
  SESSION_EXTEND_MS,
  SESSION_LENGTH_UNIT_MS,
  SESSION_WARNINGS_MS,
  type SessionPolicy,
  SNAPSHOT_VERSION,
  StoredSessionSchema,
  withinCeiling,
} from './index.ts';

const PROPOSALS: readonly ProposalPolicy[] = ['off', 'members', 'all'];

function ceilingOf(maxDrivers: number, proposals: ProposalPolicy): Policy {
  return PolicySchema.parse({
    maxDrivers,
    proposals,
    consequentialTools: ['reset_edits'],
    imageTools: ['capture_view'],
    invites: 'all',
  });
}

const combinations: [Policy, SessionPolicy][] = [];
for (const ceilingDrivers of [1, 2, 3]) {
  for (const ceilingProposals of PROPOSALS) {
    for (const maxDrivers of [1, 2, 3]) {
      for (const proposals of PROPOSALS) {
        combinations.push([ceilingOf(ceilingDrivers, ceilingProposals), { maxDrivers, proposals }]);
      }
    }
  }
}

describe('a session against its ceiling', () => {
  it('orders proposals from narrowest to widest', () => {
    expect(PROPOSALS_ORDER).toEqual(['off', 'members', 'all']);
  });

  it('never narrows to anything wider than the ceiling, field by field', () => {
    for (const [ceiling, wanted] of combinations) {
      const policy = narrowPolicy(ceiling, wanted);
      const label = JSON.stringify({ ceiling: [ceiling.maxDrivers, ceiling.proposals], wanted });
      expect(policy.maxDrivers, label).toBe(Math.min(ceiling.maxDrivers, wanted.maxDrivers));
      expect(PROPOSALS_ORDER.indexOf(policy.proposals), label).toBe(
        Math.min(
          PROPOSALS_ORDER.indexOf(ceiling.proposals),
          PROPOSALS_ORDER.indexOf(wanted.proposals),
        ),
      );
      // Every other field is the ceiling's own.
      expect({ ...policy, maxDrivers: 0, proposals: 'off' }, label).toEqual({
        ...ceiling,
        maxDrivers: 0,
        proposals: 'off',
      });
    }
  });

  it('is within the ceiling exactly when narrowing leaves it as asked', () => {
    let within = 0;
    for (const [ceiling, wanted] of combinations) {
      const policy = narrowPolicy(ceiling, wanted);
      const unchanged =
        policy.maxDrivers === wanted.maxDrivers && policy.proposals === wanted.proposals;
      expect(
        withinCeiling(ceiling, wanted),
        JSON.stringify([ceiling.maxDrivers, ceiling.proposals, wanted]),
      ).toBe(unchanged);
      if (unchanged) within += 1;
    }
    // Of 81 pairs, 6 seat pairs times 6 proposal pairs stay within.
    expect(within).toBe(36);
  });

  it('is the ceiling, copied, with no session', () => {
    const ceiling = ceilingOf(2, 'members');
    const policy = narrowPolicy(ceiling, null);
    expect(policy).toEqual(ceiling);
    expect(policy).not.toBe(ceiling);
    expect(policy.consequentialTools).not.toBe(ceiling.consequentialTools);
    expect(policy.imageTools).not.toBe(ceiling.imageTools);
  });
});

describe('the stored session', () => {
  const stored = {
    pageId: 'pg_0123456789',
    sessionId: 'ss_1',
    label: 'Period 3',
    startedAt: 1_000,
    endsAt: 3_001_000,
    lengthMs: 3_000_000,
    policy: { maxDrivers: 1, proposals: 'all' },
    observers: 35,
    inviteIds: ['inv_1', 'inv_2'],
  };

  it('reads back as written', () => {
    expect(StoredSessionSchema.parse(stored)).toEqual(stored);
  });

  it('is no record when it holds a link, a secret or anything else', () => {
    for (const extra of [
      { link: 'https://relay.example/i#abc' },
      { secret: 's'.repeat(22) },
      { policy: { ...stored.policy, consequential: 'allow' } },
    ]) {
      expect(
        StoredSessionSchema.safeParse({ ...stored, ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('holds its counts to their caps', () => {
    expect(StoredSessionSchema.safeParse({ ...stored, observers: 100 }).success).toBe(true);
    expect(StoredSessionSchema.safeParse({ ...stored, observers: 101 }).success).toBe(false);
    const ids = (count: number): string[] =>
      Array.from({ length: count }, (_, i) => `inv_${String(i)}`);
    expect(StoredSessionSchema.safeParse({ ...stored, inviteIds: ids(10) }).success).toBe(true);
    expect(StoredSessionSchema.safeParse({ ...stored, inviteIds: ids(11) }).success).toBe(false);
    expect(StoredSessionSchema.safeParse({ ...stored, lengthMs: 29 * 60_000 }).success).toBe(false);
  });
});

describe('a members file entry', () => {
  const entry = { sub: 'user_01HABC', userId: 'alice', displayName: 'Alice Example' };

  it("takes a provider's subject as OIDC bounds it", () => {
    expect(MemberSubSchema.safeParse('x'.repeat(255)).success).toBe(true);
    for (const bad of ['', 'x'.repeat(256), 'has space', 'tab\tbed', 'é', 'line\n']) {
      expect(MemberSubSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('is a subject, a user id no invitee could have and a name, and nothing else', () => {
    expect(MemberEntrySchema.parse(entry)).toEqual(entry);
    for (const bad of [
      { ...entry, userId: `g_${'0'.repeat(32)}` },
      { ...entry, userId: 'g_short' },
      { ...entry, userId: 'has space' },
      { ...entry, displayName: '' },
      { ...entry, displayName: 'x'.repeat(101) },
      { ...entry, email: 'alice@example.com' },
    ]) {
      expect(MemberEntrySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("ADR 0043's numbers", () => {
  // Literal values, so a change to a bound fails here rather than slipping through.
  it('match the ADR', () => {
    expect(MIN_SESSION_MS).toBe(30 * 60_000);
    expect(MAX_SESSION_MS).toBe(4 * 60 * 60_000);
    expect(SESSION_LENGTH_UNIT_MS).toBe(60_000);
    expect(SESSION_EXTEND_MS).toBe(15 * 60_000);
    expect(SESSION_WARNINGS_MS).toEqual([5 * 60_000, 60_000]);
    expect(SESSION_END_GRACE_MS).toBe(5_000);
    expect(MAX_MEMBERS).toBe(500);
    expect(MAX_MEMBERS_FILE_BYTES).toBe(262_144);
    expect(MEMBERS_POLL_MS).toBe(2_000);
    expect(SNAPSHOT_VERSION).toBe(1);
  });
});

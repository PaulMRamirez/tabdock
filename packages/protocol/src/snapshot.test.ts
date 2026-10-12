// The restart snapshot's schema (ADR 0046): every object strict, so a field
// no record lists, a secret among them, makes the whole file unreadable; the
// policy in force is never stored, only the ceiling and the session that
// narrows it; and what refers to what holds as the relay's store keeps it,
// a sponsor still attached for everything it sponsors (S14), each page,
// invite and token once, and no two sharing a digest.

import { describe, expect, it } from 'vitest';
import {
  MAX_LIVE_INVITES_PER_PAGE,
  MAX_ROSTER_CLIENTS_PER_INVITEE,
  PolicySchema,
  type RelaySnapshot,
  RelaySnapshotSchema,
  SNAPSHOT_VERSION,
  snapshotCounts,
} from './index.ts';

const HEX = (char: string): string => char.repeat(64);
const GUEST_ID = `g_${'1'.repeat(32)}`;
const AGENT_ID = `g_${'2'.repeat(32)}`;

function sample(): RelaySnapshot {
  return {
    v: SNAPSHOT_VERSION,
    writtenAt: 1_000,
    mode: 'public',
    credentials: HEX('9'),
    pages: [
      {
        pageId: 'pg_A',
        origin: 'https://app.example',
        title: 'Board',
        url: 'https://app.example/board',
        adapterVersion: '0.1.0',
        connectedAt: 500,
        ceiling: PolicySchema.parse({ maxDrivers: 2, proposals: 'members', invites: 'all' }),
        timedSession: {
          sessionId: 'ses_1',
          startedAt: 600,
          endsAt: 600 + 1_800_000,
          lengthMs: 1_800_000,
          policy: { maxDrivers: 1, proposals: 'off' },
        },
        sessionEnded: null,
        resumeTokenHash: HEX('a'),
      },
    ],
    attachments: [
      {
        pageId: 'pg_A',
        userId: 'alice',
        displayName: 'Alice',
        kind: 'member',
        role: 'driver',
        grantedAt: 700,
        lastUsedAt: null,
        expiresAt: 800,
        clients: [{ name: 'Claude', version: '1' }],
        inviteId: null,
        endsAt: null,
        inviteRole: null,
        sponsorId: null,
        emailHash: null,
        memberKey: HEX('b'),
      },
      {
        pageId: 'pg_A',
        userId: GUEST_ID,
        displayName: 'guest@example.com',
        kind: 'invitee',
        role: 'observer',
        grantedAt: 710,
        lastUsedAt: 720,
        expiresAt: 900,
        clients: [],
        inviteId: 'inv_1',
        endsAt: 900,
        inviteRole: 'observer',
        sponsorId: 'alice',
        emailHash: HEX('c'),
        memberKey: null,
      },
      {
        pageId: 'pg_A',
        userId: AGENT_ID,
        displayName: 'agent 22222222',
        kind: 'invitee',
        role: 'observer',
        grantedAt: 730,
        lastUsedAt: null,
        expiresAt: 900,
        clients: [],
        inviteId: 'agt_1',
        endsAt: 900,
        inviteRole: 'observer',
        sponsorId: 'alice',
        emailHash: null,
        memberKey: null,
      },
    ],
    invites: [
      {
        inviteId: 'inv_2',
        pageId: 'pg_A',
        role: 'observer',
        label: 'Class',
        uses: 5,
        usesLeft: 4,
        createdAt: 740,
        requestedExpiresAt: null,
        expiresAt: 900,
        ownExpiresAt: 1_000,
        secretHash: HEX('d'),
        sponsor: { userId: 'alice', displayName: 'Alice' },
        refusals: 0,
        barredUserIds: [],
        barredEmailHashes: [],
      },
    ],
    agents: [
      {
        tokenId: 'agt_1',
        pageId: 'pg_A',
        label: 'Lab agent',
        secretHash: HEX('e'),
        createdAt: 725,
        expiresAt: 3_600_725,
        requestedExpiresAt: 3_600_725,
        sponsor: { userId: 'alice', displayName: 'Alice' },
        state: 'attached',
        timeouts: 0,
        userId: AGENT_ID,
        client: null,
      },
    ],
  };
}

function refusal(snapshot: unknown): string | null {
  const parsed = RelaySnapshotSchema.safeParse(snapshot);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'refused');
}

describe('a restart snapshot (ADR 0046)', () => {
  it('reads a whole store back as written, and counts it as snapshot_written does', () => {
    const snapshot = sample();
    expect(RelaySnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    expect(snapshotCounts(snapshot)).toEqual({
      pages: 1,
      attachments: 3,
      invites: 1,
      sessions: 1,
    });
  });

  it('refuses another version and any field no record lists, at every level', () => {
    expect(refusal({ ...sample(), v: SNAPSHOT_VERSION + 1 })).not.toBeNull();
    expect(refusal({ ...sample(), pairingCode: 'ABCD-1234' })).not.toBeNull();
    const snapshot = sample();
    const withExtra = (path: 'pages' | 'attachments' | 'invites' | 'agents'): unknown => ({
      ...snapshot,
      [path]: snapshot[path].map((entry) => ({ ...entry, token: 'tda_secret' })),
    });
    for (const path of ['pages', 'attachments', 'invites', 'agents'] as const) {
      expect(refusal(withExtra(path)), path).not.toBeNull();
    }
    // The policy in force is worked out at a start, never read from the file.
    const page = snapshot.pages[0];
    expect(refusal({ ...snapshot, pages: [{ ...page, policy: page?.ceiling }] })).not.toBeNull();
    // Nor does a ceiling or session take a field a policy does not list.
    expect(
      refusal({ ...snapshot, pages: [{ ...page, ceiling: { ...page?.ceiling, extra: 1 } }] }),
    ).not.toBeNull();
  });

  it('holds digests where the store keeps them, never a token in their place', () => {
    const snapshot = sample();
    const page = snapshot.pages[0];
    expect(
      refusal({ ...snapshot, pages: [{ ...page, resumeTokenHash: 'not-a-digest' }] }),
    ).not.toBeNull();
    const agent = snapshot.agents[0];
    expect(
      refusal({ ...snapshot, agents: [{ ...agent, secretHash: `tda_${'A'.repeat(43)}` }] }),
    ).not.toBeNull();
  });

  it('refuses a session wider than its ceiling, or one whose end is not its length on', () => {
    const snapshot = sample();
    const page = snapshot.pages[0];
    const session = page?.timedSession;
    if (page === undefined || session === undefined || session === null) throw new Error('sample');
    expect(
      refusal({
        ...snapshot,
        pages: [
          { ...page, timedSession: { ...session, policy: { maxDrivers: 3, proposals: 'off' } } },
        ],
      }),
    ).toBe('a session never sets more than the page allows');
    expect(
      refusal({ ...snapshot, pages: [{ ...page, timedSession: { ...session, endsAt: 1 } }] }),
    ).toBe('a session ends its length after it started');
    expect(
      refusal({
        ...snapshot,
        pages: [{ ...page, sessionEnded: { sessionId: 'ses_0', reason: 'time' } }],
      }),
    ).toBe('a page with a live session has no ended one to tell');
  });

  it('keeps what an invite made apart from what an approval made, and a member key to members', () => {
    const snapshot = sample();
    const [alice, guest] = snapshot.attachments;
    expect(
      refusal({
        ...snapshot,
        attachments: [{ ...alice, endsAt: 900 }, ...snapshot.attachments.slice(1)],
      }),
    ).toBe('an invite-made attachment keeps its end, cap and sponsor, and no other has any');
    expect(
      refusal({
        ...snapshot,
        attachments: [alice, { ...guest, memberKey: HEX('f') }, snapshot.attachments[2]],
      }),
    ).toBe('only a member has a member key');
    expect(
      refusal({
        ...snapshot,
        attachments: [alice, { ...guest, role: 'driver' }, snapshot.attachments[2]],
      }),
    ).toBe('a watch invite never made a driver');
    // An invitee keeps the clients its roster row shows; a member keeps up to twenty.
    const clients = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ name: `c${String(index)}`, version: '1' }));
    expect(
      refusal({
        ...snapshot,
        attachments: [
          alice,
          { ...guest, clients: clients(MAX_ROSTER_CLIENTS_PER_INVITEE) },
          snapshot.attachments[2],
        ],
      }),
    ).toBeNull();
    expect(
      refusal({
        ...snapshot,
        attachments: [
          alice,
          { ...guest, clients: clients(MAX_ROSTER_CLIENTS_PER_INVITEE + 1) },
          snapshot.attachments[2],
        ],
      }),
    ).toBe('an invitee keeps only its newest few clients');
    expect(
      refusal({
        ...snapshot,
        attachments: [{ ...alice, clients: clients(20) }, ...snapshot.attachments.slice(1)],
      }),
    ).toBeNull();
    expect(
      refusal({
        ...snapshot,
        attachments: [{ ...alice, userId: GUEST_ID.replace('1', '3') }],
        invites: [],
        agents: [],
      }),
    ).not.toBeNull();
  });

  it('refuses anything that outlived its sponsor or names a page it lacks', () => {
    const snapshot = sample();
    const [alice, guest, agentAttachment] = snapshot.attachments;
    if (alice === undefined || guest === undefined || agentAttachment === undefined) {
      throw new Error('sample');
    }
    // Alice gone, and with her everything she sponsored: each refused on its own.
    expect(refusal({ ...snapshot, attachments: [guest, agentAttachment] })).toBe(
      'an invite-made attachment outlived its sponsor',
    );
    expect(
      refusal({
        ...snapshot,
        attachments: [alice, agentAttachment],
        agents: snapshot.agents,
        invites: snapshot.invites,
      }),
    ).toBe(null);
    expect(
      refusal({
        ...snapshot,
        invites: snapshot.invites.map((invite) => ({
          ...invite,
          sponsor: { userId: 'bob', displayName: 'Bob' },
        })),
      }),
    ).toBe('an invite outlived its sponsor');
    expect(
      refusal({
        ...snapshot,
        agents: snapshot.agents.map((agent) => ({
          ...agent,
          sponsor: { userId: 'bob', displayName: 'Bob' },
        })),
      }),
    ).toBe('an agent token outlived its sponsor');
    expect(
      refusal({
        ...snapshot,
        attachments: snapshot.attachments.map((attachment) => ({ ...attachment, pageId: 'pg_B' })),
      }),
    ).toBe('an attachment names a page the snapshot lacks');
  });

  it('holds each page, attachment, invite and token once, and no digest twice', () => {
    const snapshot = sample();
    const page = snapshot.pages[0];
    const invite = snapshot.invites[0];
    const agent = snapshot.agents[0];
    if (page === undefined || invite === undefined || agent === undefined)
      throw new Error('sample');
    expect(refusal({ ...snapshot, pages: [page, page] })).toBe('a page is listed twice');
    expect(refusal({ ...snapshot, pages: [page, { ...page, pageId: 'pg_B' }] })).toBe(
      'two pages share a resume token',
    );
    expect(refusal({ ...snapshot, invites: [invite, invite] })).toBe('an invite is listed twice');
    expect(refusal({ ...snapshot, invites: [invite, { ...invite, inviteId: 'inv_3' }] })).toBe(
      'two invites or tokens share a secret',
    );
    expect(refusal({ ...snapshot, agents: [{ ...agent, secretHash: invite.secretHash }] })).toBe(
      'two invites or tokens share a secret',
    );
    const many = Array.from({ length: MAX_LIVE_INVITES_PER_PAGE + 1 }, (_, index) => ({
      ...invite,
      inviteId: `inv_${String(index + 10)}`,
      secretHash: index.toString(16).padStart(64, '0'),
    }));
    expect(refusal({ ...snapshot, invites: many })).toBe(
      'a page holds more live invites than allowed',
    );
  });

  it("holds an attached token's attachment, and none for a token that is not", () => {
    const snapshot = sample();
    const agent = snapshot.agents[0];
    if (agent === undefined) throw new Error('sample');
    expect(refusal({ ...snapshot, agents: [{ ...agent, state: 'dormant' }] })).toBe(
      "an agent token's state does not match its attachment",
    );
    expect(refusal({ ...snapshot, attachments: snapshot.attachments.slice(0, 2) })).toBe(
      "an agent token's state does not match its attachment",
    );
  });
});

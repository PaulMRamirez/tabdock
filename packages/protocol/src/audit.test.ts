// ADR 0019's audit records: one sample of every type, each of which must
// round-trip as an event and as a line of the persistent log, and must refuse
// every field the ADR keeps out of the log. M6's fields and record types
// (ADRs 0039 to 0046) are additive within version 1, so every line written
// before them still parses.

import { describe, expect, it } from 'vitest';
import {
  AUDIT_EVENT_TYPES,
  AUDIT_VERSION,
  type AuditEvent,
  AuditEventSchema,
  AuditLineSchema,
  auditPageId,
  auditToolName,
  REFUSED_SUMMARY_BUSIEST,
  UNVERIFIED_EMAIL,
} from './index.ts';

const PAGE = { pageId: 'pg_0123456789', origin: 'https://app.example' };
const GUEST = `g_${'0'.repeat(32)}`;

/** One valid record of every type, as the hub would append it. */
const SAMPLES: Record<AuditEvent['type'], AuditEvent> = {
  call: {
    v: 1,
    type: 'call',
    at: 1,
    ...PAGE,
    userId: 'alice',
    client: { name: 'claude-code', version: '2.1.288' },
    tool: 'get_view',
    outcome: 'ok',
    durationMs: 12,
  },
  attach: {
    v: 1,
    type: 'attach',
    at: 2,
    ...PAGE,
    userId: GUEST,
    kind: 'invitee',
    role: 'observer',
    via: 'invite',
    clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
    inviteId: 'inv_1',
    email: 'guest@example.com',
  },
  attach_refused: {
    v: 1,
    type: 'attach_refused',
    at: 3,
    pageId: null,
    origin: null,
    userId: GUEST,
    kind: 'invitee',
    via: 'code',
    inviteId: null,
    outcome: 'invite_required',
  },
  role: { v: 1, type: 'role', at: 4, ...PAGE, userId: 'bob', role: 'driver', previous: 'observer' },
  revoke: { v: 1, type: 'revoke', at: 5, ...PAGE, userId: 'bob', everyone: false },
  detach: { v: 1, type: 'detach', at: 6, ...PAGE, userId: 'bob' },
  expire: { v: 1, type: 'expire', at: 7, ...PAGE, userId: 'bob', reason: 'idle' },
  invite_minted: {
    v: 1,
    type: 'invite_minted',
    at: 8,
    ...PAGE,
    inviteId: 'inv_1',
    role: 'observer',
    uses: 5,
    expiresAt: null,
    sponsor: 'alice',
  },
  invite_redeemed: {
    v: 1,
    type: 'invite_redeemed',
    at: 9,
    ...PAGE,
    inviteId: 'inv_1',
    userId: GUEST,
    kind: 'invitee',
    usesLeft: 4,
  },
  invite_closed: {
    v: 1,
    type: 'invite_closed',
    at: 10,
    ...PAGE,
    inviteId: 'inv_1',
    reason: 'revoked',
  },
  sponsor_gone: {
    v: 1,
    type: 'sponsor_gone',
    at: 11,
    ...PAGE,
    sponsor: 'alice',
    invites: 2,
    attachments: 3,
  },
  relay_start: {
    v: 1,
    type: 'relay_start',
    at: 12,
    version: '0.0.0',
    env: 'production',
    mode: 'hosted',
    invites: true,
  },
  relay_stop: { v: 1, type: 'relay_stop', at: 13 },
  audit_gap: { v: 1, type: 'audit_gap', at: 14, lost: 7, firstAt: 10, lastAt: 13 },
  refused_summary: {
    v: 1,
    type: 'refused_summary',
    at: 60_015,
    since: 15,
    scope: {
      kind: 'relay',
      busiest: [{ userId: GUEST, counts: { not_attached: 40, rate_limited: 2 } }],
      others: { accounts: 3, counts: { not_attached: 9 } },
    },
  },
  request_refused: {
    v: 1,
    type: 'request_refused',
    at: 16,
    userId: GUEST,
    kind: 'invitee',
    client: { name: 'claude-ai', version: '1.0' },
    tool: 'list_page_tools',
    pageId: 'pg_0123456789',
    outcome: 'rate_limited',
  },
  proposal_closed: {
    v: 1,
    type: 'proposal_closed',
    at: 17,
    ...PAGE,
    proposalId: 'pr_1',
    userId: GUEST,
    tool: 'add_item',
    reason: 'dismissed',
  },
  session_start: {
    v: 1,
    type: 'session_start',
    at: 18,
    ...PAGE,
    sessionId: 'ss_1',
    lengthMs: 3_000_000,
    maxDrivers: 2,
    proposals: 'all',
    demoted: 1,
  },
  session_extend: {
    v: 1,
    type: 'session_extend',
    at: 19,
    ...PAGE,
    sessionId: 'ss_1',
    lengthMs: 3_900_000,
  },
  session_end: {
    v: 1,
    type: 'session_end',
    at: 20,
    ...PAGE,
    sessionId: 'ss_1',
    reason: 'time',
    attachments: 30,
    invites: 2,
    agents: 1,
  },
  members_reloaded: {
    v: 1,
    type: 'members_reloaded',
    at: 21,
    members: 12,
    added: ['carol'],
    removed: ['bob'],
    renamed: 1,
    attachments: 1,
  },
  snapshot_written: {
    v: 1,
    type: 'snapshot_written',
    at: 22,
    pages: 2,
    attachments: 5,
    invites: 1,
    sessions: 1,
    sha256: 'd'.repeat(64),
  },
  snapshot_loaded: {
    v: 1,
    type: 'snapshot_loaded',
    at: 23,
    ageMs: 4_000,
    pages: 2,
    attachments: 4,
    invites: 1,
    sessions: 1,
    dropped: 1,
  },
  agent_minted: {
    v: 1,
    type: 'agent_minted',
    at: 24,
    ...PAGE,
    tokenId: 'ag_1',
    expiresAt: 3_600_024,
    sponsor: 'alice',
  },
  agent_closed: {
    v: 1,
    type: 'agent_closed',
    at: 25,
    ...PAGE,
    tokenId: 'ag_1',
    reason: 'session_ended',
  },
};

/** What ADR 0019 keeps out of every record, by the names a careless call site might use. */
const FORBIDDEN = {
  arguments: { note: 'x' },
  result: 'page output',
  token: 'tabdock_secret',
  code: 'ABCDE12345',
  nonce: 'n'.repeat(22),
  secret: 's'.repeat(22),
  secretHash: 'a'.repeat(64),
  resumeTokenHash: 'b'.repeat(64),
  cookie: 'c=1',
  sub: 'user_01ABC',
  address: '203.0.113.7',
  label: 'Friends',
  title: 'Board',
  url: 'https://app.example/board',
  // From M6: image data, page state, an agent token and members' names.
  data: 'iVBORw0KGgo=',
  value: { a: 1 },
  agentToken: `tda_${'A'.repeat(43)}`,
  displayName: 'Alice',
};

describe('the audit record types', () => {
  it('are the fifteen ADR 0019 lists, request_refused from its notes and the nine of M6, at version 1', () => {
    expect(AUDIT_VERSION).toBe(1);
    expect([...AUDIT_EVENT_TYPES].sort()).toEqual(Object.keys(SAMPLES).sort());
    expect(AUDIT_EVENT_TYPES).toHaveLength(25);
  });

  it.each(AUDIT_EVENT_TYPES)('%s round-trips as an event and as a line', (type) => {
    const event = SAMPLES[type];
    expect(AuditEventSchema.parse(event)).toEqual(event);
    const line = { ...event, seq: 41, prev: 'f'.repeat(64) };
    expect(AuditLineSchema.parse(line)).toEqual(line);
    // The first line a log ever holds has nothing before it.
    expect(AuditLineSchema.safeParse({ ...event, seq: 0, prev: null }).success).toBe(true);
  });

  it.each(AUDIT_EVENT_TYPES)('%s refuses every field the log never holds', (type) => {
    for (const [field, value] of Object.entries(FORBIDDEN)) {
      expect(AuditEventSchema.safeParse({ ...SAMPLES[type], [field]: value }).success, field).toBe(
        false,
      );
    }
  });

  it.each(AUDIT_EVENT_TYPES.filter((type) => type !== 'attach'))(
    '%s refuses an email, which only an attach record holds',
    (type) => {
      expect(
        AuditEventSchema.safeParse({ ...SAMPLES[type], email: 'guest@example.com' }).success,
      ).toBe(false);
    },
  );

  it('refuses another version, an unknown type, and a line without its place in the log', () => {
    expect(AuditEventSchema.safeParse({ ...SAMPLES.detach, v: 2 }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...SAMPLES.detach, type: 'login' }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...SAMPLES.detach, seq: 1, prev: null }).success).toBe(
      false,
    );
    expect(AuditLineSchema.safeParse(SAMPLES.detach).success).toBe(false);
    expect(
      AuditLineSchema.safeParse({ ...SAMPLES.detach, seq: 1, prev: 'F'.repeat(64) }).success,
    ).toBe(false);
    expect(AuditLineSchema.safeParse({ ...SAMPLES.detach, seq: -1, prev: null }).success).toBe(
      false,
    );
  });
});

describe('attach records', () => {
  const attach = SAMPLES.attach;

  it("hold an invitee's verified email, or unverified, and nothing for a member", () => {
    expect(AuditEventSchema.safeParse({ ...attach, email: UNVERIFIED_EMAIL }).success).toBe(true);
    expect(AuditEventSchema.safeParse({ ...attach, email: undefined }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...attach, email: 'not an email' }).success).toBe(false);
    const member = {
      ...attach,
      userId: 'alice',
      kind: 'member',
      via: 'code',
      inviteId: null,
      clientId: null,
      email: undefined,
    };
    expect(AuditEventSchema.safeParse(member).success).toBe(true);
    expect(AuditEventSchema.safeParse({ ...member, email: 'alice@example.com' }).success).toBe(
      false,
    );
  });

  it('name an invite exactly when it made the attachment', () => {
    expect(AuditEventSchema.safeParse({ ...attach, inviteId: null }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...attach, via: 'qr' }).success).toBe(false);
    // A member who redeems an invite gets an invite-made attachment too (ADR 0017).
    const member = { ...attach, userId: 'alice', kind: 'member', email: undefined };
    expect(AuditEventSchema.safeParse(member).success).toBe(true);
  });

  it('refuse a client_id that is no client_id', () => {
    expect(AuditEventSchema.safeParse({ ...attach, clientId: 'has space' }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...attach, clientId: '' }).success).toBe(false);
  });
});

describe('other record rules', () => {
  it('give a refused attach a page and its origin together, or neither', () => {
    const refused = SAMPLES.attach_refused;
    expect(AuditEventSchema.safeParse({ ...refused, ...PAGE }).success).toBe(true);
    expect(AuditEventSchema.safeParse({ ...refused, pageId: PAGE.pageId }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...refused, outcome: 'ok' }).success).toBe(false);
  });

  it('refuse a request past the budget for the three tools with no record of their own', () => {
    const refused = SAMPLES.request_refused;
    const listPages = { ...refused, tool: 'list_pages', pageId: null };
    expect(AuditEventSchema.safeParse(listPages).success).toBe(true);
    const invalid = { ...refused, tool: 'detach_page', pageId: auditPageId('not a page id') };
    expect(AuditEventSchema.safeParse(invalid).success).toBe(true);
    for (const bad of [
      // A call past the budget is a call record, and a pairing an attach_refused one.
      { ...refused, tool: 'call_page_tool' },
      { ...refused, tool: 'pair_page' },
      { ...listPages, pageId: 'pg_0123456789' },
      { ...refused, pageId: null },
      { ...refused, pageId: 'not a page id' },
      { ...refused, outcome: 'not_attached' },
      { ...refused, kind: 'guest' },
    ]) {
      expect(AuditEventSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('keep a gap in order', () => {
    expect(AuditEventSchema.safeParse({ ...SAMPLES.audit_gap, firstAt: 14 }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...SAMPLES.audit_gap, lost: 0 }).success).toBe(false);
  });

  it('summarise one account, or the strangers by their busiest 20 and the rest together', () => {
    const user = {
      ...SAMPLES.refused_summary,
      scope: { kind: 'user', userId: 'alice', counts: { not_attached: 3 } },
    };
    expect(AuditEventSchema.safeParse(user).success).toBe(true);
    const busiest = Array.from({ length: REFUSED_SUMMARY_BUSIEST + 1 }, (_, index) => ({
      userId: `g_${String(index).padStart(32, '0')}`,
      counts: { not_attached: 1 },
    }));
    const tooMany = {
      ...SAMPLES.refused_summary,
      scope: { kind: 'relay', busiest, others: { accounts: 0, counts: {} } },
    };
    expect(AuditEventSchema.safeParse(tooMany).success).toBe(false);
    const badOutcome = { ...user, scope: { ...user.scope, counts: { nope: 1 } } };
    expect(AuditEventSchema.safeParse(badOutcome).success).toBe(false);
    const zero = { ...user, scope: { ...user.scope, counts: { not_attached: 0 } } };
    expect(AuditEventSchema.safeParse(zero).success).toBe(false);
    const mixed = { ...user, scope: { ...user.scope, others: { accounts: 1, counts: {} } } };
    expect(AuditEventSchema.safeParse(mixed).success).toBe(false);
  });
});

describe('client text in a call record', () => {
  it('is kept when it is an id or a tool name, and stored by length otherwise', () => {
    expect(auditPageId('pg_0123456789')).toBe('pg_0123456789');
    expect(auditPageId('not a page id')).toBe('(invalid, 13 chars)');
    expect(auditToolName('a.b-c_d')).toBe('a.b-c_d');
    expect(auditToolName('drop table;')).toBe('(invalid, 11 chars)');
    const call = {
      ...SAMPLES.call,
      pageId: auditPageId('x'.repeat(100)),
      tool: auditToolName(`<${'y'.repeat(150)}>`),
    };
    expect(AuditEventSchema.parse(call)).toEqual(call);
    expect(AuditEventSchema.safeParse({ ...SAMPLES.call, pageId: 'not a page id' }).success).toBe(
      false,
    );
    expect(AuditEventSchema.safeParse({ ...SAMPLES.call, tool: 'drop table;' }).success).toBe(
      false,
    );
  });
});

/** A call line exactly as M5's relay wrote it, before any M6 field existed. */
const M5_CALL_LINE = {
  ...SAMPLES.call,
  confirmedBy: 'client',
  seq: 7,
  prev: 'e'.repeat(64),
};

describe("M6's call record fields", () => {
  const call = SAMPLES.call;
  const image = { mimeType: 'image/png', bytes: 48_213, sha256: 'a'.repeat(64) };

  it('keep every line written before them as it was', () => {
    expect(AuditLineSchema.parse(M5_CALL_LINE)).toEqual(M5_CALL_LINE);
    expect(AuditEventSchema.parse(call)).toEqual(call);
  });

  it('carry the invoke id of a call that reached its page, and only an id (ADR 0045)', () => {
    const reached = { ...call, callId: 'c_42' };
    expect(AuditEventSchema.parse(reached)).toEqual(reached);
    expect(AuditLineSchema.safeParse({ ...reached, seq: 1, prev: null }).success).toBe(true);
    expect(AuditEventSchema.safeParse({ ...call, callId: 'x y' }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...call, callId: '' }).success).toBe(false);
  });

  it("record an image's type, size and digest beside ok, never its data (ADR 0039)", () => {
    expect(AuditEventSchema.safeParse({ ...call, image }).success).toBe(true);
    for (const bad of [
      { ...call, outcome: 'tool_error', image },
      { ...call, imageRefused: 'size' },
      { ...call, outcome: 'tool_error', image, imageRefused: 'size' },
      { ...call, image: { ...image, sha256: 'A'.repeat(64) } },
      { ...call, image: { ...image, sha256: 'a'.repeat(63) } },
      { ...call, image: { ...image, mimeType: 'image/svg+xml' } },
      { ...call, image: { ...image, mimeType: 'image/gif' } },
      { ...call, image: { ...image, bytes: 0 } },
      { ...call, image: { ...image, bytes: 524_289 } },
      { ...call, image: { ...image, data: 'iVBORw0KGgo=' } },
      { ...call, outcome: 'tool_error', imageRefused: 'too_big' },
    ]) {
      expect(AuditEventSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    for (const reason of [
      'undeclared',
      'off',
      'type',
      'encoding',
      'size',
      'signature',
      'dimensions',
    ]) {
      const refusedImage = { ...call, outcome: 'tool_error', imageRefused: reason };
      expect(AuditEventSchema.safeParse(refusedImage).success, reason).toBe(true);
    }
    expect(
      AuditLineSchema.safeParse({ ...call, outcome: 'tool_error', image, seq: 2, prev: null })
        .success,
    ).toBe(false);
  });

  it('give a proposal a proposed line and a run accepted on the page, each naming it (ADR 0042)', () => {
    const proposed = { ...call, outcome: 'proposed', proposalId: 'pr_1' };
    const run = { ...call, outcome: 'ok', proposalId: 'pr_1', acceptedOnPage: true, callId: 'c_9' };
    expect(AuditEventSchema.parse(proposed)).toEqual(proposed);
    expect(AuditEventSchema.parse(run)).toEqual(run);
    // A run that never reached the page still names its proposal.
    expect(
      AuditEventSchema.safeParse({ ...run, outcome: 'not_attached', callId: undefined }).success,
    ).toBe(true);
    for (const bad of [
      { ...call, acceptedOnPage: true },
      { ...run, confirmedBy: 'client' },
      { ...run, outcome: 'proposed' },
      { ...call, outcome: 'proposed' },
      { ...proposed, callId: 'c_1' },
      { ...proposed, image },
      { ...call, proposalId: 'pr_1' },
      { ...call, outcome: 'tool_error', proposalId: 'pr_1' },
      { ...run, acceptedOnPage: false },
      { ...proposed, proposalId: 'not an id' },
    ]) {
      expect(AuditEventSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      expect(AuditLineSchema.safeParse({ ...bad, seq: 3, prev: null }).success).toBe(false);
    }
  });

  it('keep the confirmation rule first, so its message is unchanged', () => {
    const contradictory = AuditEventSchema.safeParse({
      ...call,
      outcome: 'not_confirmed',
      confirmedBy: 'client',
    });
    expect(contradictory.error?.issues[0]?.message).toBe(
      'a call refused for its confirmation went out unconfirmed, so no client confirmed it',
    );
  });
});

describe("M6's reasons and refusal records", () => {
  it('end attachments on a members reload or a session end, and invites on a session end (ADR 0043)', () => {
    for (const reason of ['membership_changed', 'session_ended']) {
      expect(AuditEventSchema.safeParse({ ...SAMPLES.expire, reason }).success, reason).toBe(true);
    }
    expect(
      AuditEventSchema.safeParse({ ...SAMPLES.invite_closed, reason: 'session_ended' }).success,
    ).toBe(true);
    expect(AuditEventSchema.safeParse({ ...SAMPLES.expire, reason: 'ended' }).success).toBe(false);
  });

  it('take agent attachments as invitees naming their token, and refused ones (ADR 0044)', () => {
    const agent = {
      ...SAMPLES.attach,
      via: 'agent',
      inviteId: 'ag_1',
      clientId: null,
      email: UNVERIFIED_EMAIL,
    };
    expect(AuditEventSchema.safeParse(agent).success).toBe(true);
    expect(AuditEventSchema.safeParse({ ...agent, inviteId: null }).success).toBe(false);
    const member = { ...agent, userId: 'alice', kind: 'member', email: undefined };
    expect(AuditEventSchema.safeParse(member).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...agent, token: `tda_${'A'.repeat(43)}` }).success).toBe(
      false,
    );
    const refused = {
      ...SAMPLES.attach_refused,
      ...PAGE,
      via: 'agent',
      inviteId: 'ag_1',
      outcome: 'denied_by_operator',
    };
    expect(AuditEventSchema.safeParse(refused).success).toBe(true);
  });

  it('refuse requests past the budget for the waiting tools and the proposal tools', () => {
    for (const tool of [
      'get_page_state',
      'wait_for_page_state',
      'get_proposal',
      'withdraw_proposal',
    ]) {
      const refused = { ...SAMPLES.request_refused, tool };
      expect(AuditEventSchema.safeParse(refused).success, tool).toBe(true);
      // Each names its page, as every tool but list_pages does.
      expect(AuditEventSchema.safeParse({ ...refused, pageId: null }).success, tool).toBe(false);
    }
    expect(
      AuditEventSchema.safeParse({ ...SAMPLES.request_refused, tool: 'call_page_tool' }).success,
    ).toBe(false);
  });

  it('say whether agent tokens and the restart snapshot were on, and keep older starts readable', () => {
    const start = { ...SAMPLES.relay_start, agentTokens: true, restartSnapshot: false };
    expect(AuditEventSchema.parse(start)).toEqual(start);
    expect(AuditEventSchema.parse(SAMPLES.relay_start)).toEqual(SAMPLES.relay_start);
    expect(AuditEventSchema.safeParse({ ...start, agentTokens: 'yes' }).success).toBe(false);
  });

  it('hold only the bounded fields of each new record', () => {
    const tooMany = Array.from({ length: 501 }, (_, index) => `m${String(index)}`);
    expect(
      AuditEventSchema.safeParse({ ...SAMPLES.members_reloaded, added: tooMany }).success,
    ).toBe(false);
    expect(
      AuditEventSchema.safeParse({ ...SAMPLES.members_reloaded, removed: tooMany }).success,
    ).toBe(false);
    expect(
      AuditEventSchema.safeParse({ ...SAMPLES.members_reloaded, added: ['g x'] }).success,
    ).toBe(false);
    expect(AuditEventSchema.safeParse({ ...SAMPLES.session_start, lengthMs: 60_000 }).success).toBe(
      false,
    );
    expect(AuditEventSchema.safeParse({ ...SAMPLES.session_start, maxDrivers: 0 }).success).toBe(
      false,
    );
    expect(AuditEventSchema.safeParse({ ...SAMPLES.session_end, reason: 'ended' }).success).toBe(
      false,
    );
    expect(
      AuditEventSchema.safeParse({ ...SAMPLES.snapshot_written, sha256: 'D'.repeat(64) }).success,
    ).toBe(false);
    expect(AuditEventSchema.safeParse({ ...SAMPLES.agent_closed, reason: 'lost' }).success).toBe(
      false,
    );
    expect(
      AuditEventSchema.safeParse({ ...SAMPLES.proposal_closed, reason: 'accepted' }).success,
    ).toBe(false);
  });
});

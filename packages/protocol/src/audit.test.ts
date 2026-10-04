// ADR 0019's audit records: one sample of every type, each of which must
// round-trip as an event and as a line of the persistent log, and must refuse
// every field the ADR keeps out of the log.

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
};

describe('the audit record types', () => {
  it('are the fifteen ADR 0019 lists, at version 1', () => {
    expect(AUDIT_VERSION).toBe(1);
    expect([...AUDIT_EVENT_TYPES].sort()).toEqual(Object.keys(SAMPLES).sort());
    expect(AUDIT_EVENT_TYPES).toHaveLength(15);
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

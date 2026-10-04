// The M4 wire format (ADR 0017): invite frames, the account and invite on an
// attach request, roster kinds and ends, policy.invites, invite links,
// pair_page's input and the adapter's stored records. Every new shape is
// checked both ways: what it accepts round-trips, and each bound refuses.

import { describe, expect, it } from 'vitest';
import {
  AccountSchema,
  CONTROL_INVITE_USES,
  DEFAULT_INVITE_LIFETIME_MS,
  EmailSchema,
  INVITE_BURN_REFUSALS,
  INVITE_PATH,
  INVITE_SECRET_BYTES,
  INVITE_SECRET_CHARS,
  INVITEE_ID_PREFIX,
  INVITEE_KEY_HEX_CHARS,
  INVITEE_SHORT_ID_CHARS,
  InviteeIdSchema,
  inviteLink,
  inviteSecretOf,
  isInviteLinkBase,
  MAX_CODE_INPUT_CHARS,
  MAX_DISPLAY_NAME_CHARS,
  MAX_EMAIL_CHARS,
  MAX_INVITE_INPUT_CHARS,
  MAX_INVITE_LABEL_CHARS,
  MAX_INVITE_LIFETIME_MS,
  MAX_INVITE_USES,
  MAX_LIVE_INVITES_PER_PAGE,
  MEMBER_RESERVED_SEATS,
  MIN_INVITE_REMAINING_MS,
  PairPageInputSchema,
  parsePageFrame,
  parseRelayFrame,
  PolicySchema,
  SHORT_INVITE_LIFETIME_MS,
  StoredGrantSchema,
  StoredInviteSchema,
  StoredInvitesSchema,
  UNVERIFIED_ACCOUNT_NAME,
} from './index.ts';

const SECRET = 'AbCdEfGhIjKlMnOpQrStU_';
const HASH = 'a'.repeat(64);
const LINK_BASE = 'https://relay.example/i';

const create = {
  t: 'invite_create',
  inviteId: 'inv_1',
  role: 'observer',
  label: 'Friends from book club',
  uses: 5,
  expiresAt: 1_700_000_000_000,
  secretHash: HASH,
};

const listing = {
  inviteId: 'inv_1',
  role: 'observer',
  label: 'Friends',
  uses: 5,
  expiresAt: null,
  usesLeft: 4,
  sponsor: { userId: 'alice', displayName: 'Alice' },
  pending: false,
  refusals: 0,
};

const request = {
  t: 'attach_request',
  requestId: 'rq_1',
  user: { userId: `g_${'0'.repeat(32)}`, displayName: 'guest@example.com' },
  account: { kind: 'invitee', verified: true },
  via: 'invite',
  invite: { inviteId: 'inv_1', secret: SECRET, label: 'Friends' },
  client: null,
  expiresAt: 1_700_000_000_000,
};

const rosterEntry = {
  userId: `g_${'0'.repeat(32)}`,
  displayName: 'guest@example.com',
  kind: 'invitee',
  role: 'observer',
  grantedAt: 1,
  lastUsedAt: null,
  expiresAt: 2,
  clients: [],
  inviteId: 'inv_1',
  endsAt: 86_400_001,
};

function page(frame: object): string {
  return parsePageFrame(JSON.stringify(frame)).kind;
}

function relay(frame: object): string {
  return parseRelayFrame(JSON.stringify(frame)).kind;
}

describe('the numbers ADRs 0016, 0017 and 0019 fix', () => {
  it('are the ones the ADRs give', () => {
    expect(INVITE_PATH).toBe('/i');
    expect(INVITE_SECRET_BYTES).toBe(16);
    expect(INVITE_SECRET_CHARS).toBe(22);
    // 22 base64url characters carry the 128 bits, and no more.
    expect(Math.ceil((INVITE_SECRET_BYTES * 8) / 6)).toBe(INVITE_SECRET_CHARS);
    expect(MAX_INVITE_LABEL_CHARS).toBe(60);
    expect(MAX_INVITE_USES).toBe(20);
    expect(CONTROL_INVITE_USES).toBe(1);
    expect(MAX_LIVE_INVITES_PER_PAGE).toBe(10);
    expect(MAX_INVITE_LIFETIME_MS).toBe(24 * 60 * 60 * 1000);
    expect(SHORT_INVITE_LIFETIME_MS).toBe(15 * 60 * 1000);
    expect(DEFAULT_INVITE_LIFETIME_MS).toBe(60 * 60 * 1000);
    expect(INVITE_BURN_REFUSALS).toBe(3);
    expect(MIN_INVITE_REMAINING_MS).toBe(60 * 1000);
    expect(MEMBER_RESERVED_SEATS).toBe(2);
    expect(MAX_INVITE_INPUT_CHARS).toBe(300);
    expect(MAX_CODE_INPUT_CHARS).toBe(64);
    expect(INVITEE_ID_PREFIX).toBe('g_');
    expect(INVITEE_KEY_HEX_CHARS).toBe(32);
    expect(INVITEE_SHORT_ID_CHARS).toBe(8);
    expect(UNVERIFIED_ACCOUNT_NAME).toBe('unverified account');
    expect(MAX_EMAIL_CHARS).toBe(320);
    expect(MAX_DISPLAY_NAME_CHARS).toBe(100);
  });
});

describe('invite_create', () => {
  it('round-trips a watch invite and a control invite for one use', () => {
    expect(parsePageFrame(JSON.stringify(create))).toEqual({ kind: 'ok', frame: create });
    const control = { ...create, role: 'driver', uses: 1, expiresAt: null };
    expect(parsePageFrame(JSON.stringify(control))).toEqual({ kind: 'ok', frame: control });
  });

  it.each([
    ['an empty label', { label: '' }],
    ['a label over 60 characters', { label: 'x'.repeat(61) }],
    ['no uses', { uses: 0 }],
    ['more than 20 uses', { uses: 21 }],
    ['a fraction of a use', { uses: 1.5 }],
    ['a control invite with two uses', { role: 'driver', uses: 2 }],
    ['a role that is no role', { role: 'admin' }],
    ['an upper-case hash', { secretHash: 'A'.repeat(64) }],
    ['a short hash', { secretHash: 'a'.repeat(63) }],
    ['a long hash', { secretHash: 'a'.repeat(65) }],
    ['the secret instead of its hash', { secretHash: SECRET }],
    ['a negative expiry', { expiresAt: -1 }],
    ['an id that is no id', { inviteId: 'has space' }],
    ['no id', { inviteId: undefined }],
  ])('refuses %s', (_name, change) => {
    expect(page({ ...create, ...change })).toBe('invalid');
  });

  it('names a bad field without echoing the hash', () => {
    const parsed = parsePageFrame(JSON.stringify({ ...create, secretHash: `${'b'.repeat(63)}Z` }));
    expect(parsed.kind).toBe('invalid');
    expect(JSON.stringify(parsed)).not.toContain('b'.repeat(63));
  });
});

describe('invite_cancel', () => {
  it('round-trips, and refuses an id that is no id', () => {
    const cancel = { t: 'invite_cancel', inviteId: 'inv_1' };
    expect(parsePageFrame(JSON.stringify(cancel))).toEqual({ kind: 'ok', frame: cancel });
    expect(page({ t: 'invite_cancel', inviteId: '' })).toBe('invalid');
    expect(page({ t: 'invite_cancel' })).toBe('invalid');
  });
});

describe('invites', () => {
  it('round-trips a list with its link base, and with none and a refusal', () => {
    const frame = { t: 'invites', linkBase: LINK_BASE, invites: [listing] };
    expect(parseRelayFrame(JSON.stringify(frame))).toEqual({ kind: 'ok', frame });
    const refused = {
      t: 'invites',
      linkBase: null,
      invites: [],
      refused: { inviteId: 'inv_2', reason: 'no_public_url' },
    };
    expect(parseRelayFrame(JSON.stringify(refused))).toEqual({ kind: 'ok', frame: refused });
    for (const reason of [
      'no_sponsor',
      'policy',
      'limit',
      'duplicate',
      'no_public_url',
      'expired',
    ]) {
      expect(relay({ ...refused, refused: { inviteId: 'inv_2', reason } })).toBe('ok');
    }
  });

  it('holds at most 10 live invites', () => {
    const ten = Array.from({ length: 10 }, (_, index) => ({
      ...listing,
      inviteId: `inv_${index}`,
    }));
    expect(relay({ t: 'invites', linkBase: LINK_BASE, invites: ten })).toBe('ok');
    expect(
      relay({
        t: 'invites',
        linkBase: LINK_BASE,
        invites: [...ten, { ...listing, inviteId: 'x' }],
      }),
    ).toBe('invalid');
  });

  it.each([
    ['a reason that is not one', { refused: { inviteId: 'inv_1', reason: 'because' } }],
    ['more refusals than burn an invite', { invites: [{ ...listing, refusals: 4 }] }],
    ['more uses left than uses', { invites: [{ ...listing, usesLeft: 6 }] }],
    ['a control invite with two uses', { invites: [{ ...listing, role: 'driver', uses: 2 }] }],
    ['a sponsor with no name', { invites: [{ ...listing, sponsor: { userId: 'alice' } }] }],
    ['a link base over http', { linkBase: 'http://relay.example/i' }],
    ['a link base on another path', { linkBase: 'https://relay.example/pair' }],
    ['a link base with a query', { linkBase: 'https://relay.example/i?x=1' }],
    ['a link base with a fragment', { linkBase: 'https://relay.example/i#x' }],
    ['a link base with credentials', { linkBase: 'https://u:p@relay.example/i' }],
    ['a link base that is not a URL', { linkBase: 'javascript:alert(1)' }],
  ])('refuses %s', (_name, change) => {
    expect(relay({ t: 'invites', linkBase: LINK_BASE, invites: [listing], ...change })).toBe(
      'invalid',
    );
  });
});

describe('attach_request from M4', () => {
  it('round-trips an invitee redeeming an invite, and a member pairing by code', () => {
    expect(parseRelayFrame(JSON.stringify(request))).toEqual({ kind: 'ok', frame: request });
    const member = {
      ...request,
      user: { userId: 'alice', displayName: 'Alice' },
      account: { kind: 'member', verified: true },
      via: 'code',
      invite: undefined,
    };
    expect(relay(member)).toBe('ok');
  });

  it.each([
    ['an invite request without its invite', { invite: undefined }],
    ['a code request carrying an invite', { via: 'qr' }],
    ['no account', { account: undefined }],
    ['an unverified member', { account: { kind: 'member', verified: false } }],
    ['a kind that is not one', { account: { kind: 'guest', verified: true } }],
    ['a secret that is no secret', { invite: { inviteId: 'inv_1', secret: 'short', label: 'x' } }],
    ['an invite with no label', { invite: { inviteId: 'inv_1', secret: SECRET, label: '' } }],
    ['a via that is not one', { via: 'link' }],
    [
      "a member with an invitee's id",
      { account: { kind: 'member', verified: true }, via: 'code', invite: undefined },
    ],
    [
      "an invitee without an invitee's id",
      { user: { userId: 'g_guest', displayName: 'guest@example.com' } },
    ],
  ])('refuses %s', (_name, change) => {
    expect(relay({ ...request, ...change })).toBe('invalid');
  });

  it('never echoes a presented secret when it refuses one', () => {
    const parsed = parseRelayFrame(
      JSON.stringify({ ...request, invite: { ...request.invite, secret: `${SECRET}!` } }),
    );
    expect(parsed.kind).toBe('invalid');
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
  });

  it('accepts an unverified invitee', () => {
    expect(AccountSchema.safeParse({ kind: 'invitee', verified: false }).success).toBe(true);
  });
});

describe('roster entries from M4', () => {
  it('round-trip with their kind, invite and end', () => {
    const roster = { t: 'roster', attachments: [rosterEntry] };
    expect(parseRelayFrame(JSON.stringify(roster))).toEqual({ kind: 'ok', frame: roster });
    const member = {
      ...rosterEntry,
      userId: 'alice',
      kind: 'member',
      inviteId: null,
      endsAt: null,
    };
    expect(relay({ t: 'roster', attachments: [member] })).toBe('ok');
  });

  it.each([
    ['kind', { kind: undefined }],
    ['inviteId', { inviteId: undefined }],
    ['endsAt', { endsAt: undefined }],
  ])('require %s', (_name, change) => {
    expect(relay({ t: 'roster', attachments: [{ ...rosterEntry, ...change }] })).toBe('invalid');
  });

  // ADR 0017: the kind follows from the id, so the page can tell a caller's kind
  // from its id alone; and only an invite-made attachment has an end.
  it.each([
    ["a member with an invitee's id", { kind: 'member' }],
    ["an invitee without an invitee's id", { userId: 'bob' }],
    ['an invite without an end', { endsAt: null }],
    ['an end without an invite', { inviteId: null }],
  ])('refuse %s', (_name, change) => {
    const roster = { t: 'roster', attachments: [{ ...rosterEntry, ...change }] };
    expect(relay(roster)).toBe('invalid');
    const welcome = {
      t: 'welcome',
      pageId: 'pg_1',
      resumeToken: 'rt_1',
      resumed: false,
      pairing: { code: 'ABCDE-12345', expiresAt: 1 },
      roster: [{ ...rosterEntry, ...change }],
      limits: {
        maxFrameBytes: 1,
        maxResultChars: 1,
        maxDescriptionChars: 1,
        pingIntervalMs: 1,
        idleTimeoutMs: 1,
        resumeWindowMs: 1,
        attachRequestTtlMs: 1,
      },
    };
    expect(relay(welcome)).toBe('invalid');
    expect(relay({ ...welcome, roster: [rosterEntry] })).toBe('ok');
  });
});

describe('policy.invites', () => {
  it('defaults to watch, takes off and all, and refuses anything else (ADR 0016)', () => {
    expect(PolicySchema.parse({}).invites).toBe('watch');
    expect(PolicySchema.parse({ invites: 'off' }).invites).toBe('off');
    expect(PolicySchema.parse({ invites: 'all' }).invites).toBe('all');
    expect(PolicySchema.safeParse({ invites: 'control' }).success).toBe(false);
  });
});

describe('accounts', () => {
  it("shape an invitee's id as g_ and 32 hex characters", () => {
    expect(InviteeIdSchema.safeParse(`g_${'0a'.repeat(16)}`).success).toBe(true);
    for (const id of [
      'alice',
      `g_${'0'.repeat(31)}`,
      `g_${'A'.repeat(32)}`,
      `x_${'0'.repeat(32)}`,
    ]) {
      expect(InviteeIdSchema.safeParse(id).success, id).toBe(false);
    }
  });

  it('take an email with one @ and no space or control character, up to 320', () => {
    expect(EmailSchema.safeParse('guest@example.com').success).toBe(true);
    expect(EmailSchema.safeParse(`${'a'.repeat(308)}@example.com`).success).toBe(true);
    for (const text of [
      'no-at-sign',
      'two@@example.com',
      'a b@example.com',
      'tab\t@example.com',
      `${'a'.repeat(309)}@example.com`,
      '@example.com',
      'guest@',
    ]) {
      expect(EmailSchema.safeParse(text).success, text).toBe(false);
    }
  });
});

describe('invite links', () => {
  it('put the secret in the fragment of the link base, and nowhere else', () => {
    expect(inviteLink(LINK_BASE, SECRET)).toBe(`${LINK_BASE}#${SECRET}`);
    expect(() => inviteLink('https://relay.example/pair', SECRET)).toThrow(TypeError);
    expect(() => inviteLink(LINK_BASE, 'not-a-secret')).toThrow(TypeError);
  });

  it('read a secret from a bare secret or a whole link, trimmed', () => {
    expect(inviteSecretOf(SECRET)).toBe(SECRET);
    expect(inviteSecretOf(`  ${SECRET}\n`)).toBe(SECRET);
    expect(inviteSecretOf(`${LINK_BASE}#${SECRET}`)).toBe(SECRET);
    expect(inviteSecretOf(`https://relay.example:8443/i#${SECRET}`)).toBe(SECRET);
    expect(inviteSecretOf(`${LINK_BASE}#${SECRET}`, LINK_BASE)).toBe(SECRET);
  });

  it.each([
    ['another relay', `https://other.example/i#${SECRET}`, LINK_BASE],
    ['another path', `https://relay.example/pair#${SECRET}`, undefined],
    ['a query', `https://relay.example/i?x=1#${SECRET}`, undefined],
    ['plain http', `http://relay.example/i#${SECRET}`, undefined],
    ['a short secret', `${LINK_BASE}#${SECRET.slice(1)}`, undefined],
    ['a second fragment', `${LINK_BASE}#${SECRET}#${SECRET}`, undefined],
    ['no fragment', LINK_BASE, undefined],
    ['a pairing code', 'ABCDE-12345', undefined],
    ['anything over 300 characters', `${LINK_BASE}#${SECRET}${' '.repeat(300)}`, undefined],
  ])('read no secret from %s', (_name, input, base) => {
    expect(inviteSecretOf(input, base)).toBeNull();
  });

  it('take only https origins with the invite path as their base', () => {
    expect(isInviteLinkBase(LINK_BASE)).toBe(true);
    expect(isInviteLinkBase('https://[2001:db8::1]:8443/i')).toBe(true);
    expect(isInviteLinkBase('https://Relay.example/i')).toBe(false);
    expect(isInviteLinkBase('https://relay.example/i/')).toBe(false);
    expect(isInviteLinkBase(`https://${'a'.repeat(2048)}.example/i`)).toBe(false);
  });
});

describe("pair_page's input from M4", () => {
  it('takes exactly one of a code and an invite, each within its bound', () => {
    expect(PairPageInputSchema.safeParse({ code: 'ABCDE-12345' }).success).toBe(true);
    expect(PairPageInputSchema.safeParse({ invite: `${LINK_BASE}#${SECRET}` }).success).toBe(true);
    expect(PairPageInputSchema.safeParse({}).success).toBe(false);
    expect(PairPageInputSchema.safeParse({ code: 'ABCDE-12345', invite: SECRET }).success).toBe(
      false,
    );
    expect(PairPageInputSchema.safeParse({ code: 'x'.repeat(65) }).success).toBe(false);
    expect(PairPageInputSchema.safeParse({ invite: 'x'.repeat(301) }).success).toBe(false);
    expect(PairPageInputSchema.safeParse({ invite: 'x'.repeat(300) }).success).toBe(true);
  });
});

describe("the adapter's stored records (ADRs 0011 and 0017)", () => {
  it('read a grant as { role, inviteId?, endsAt?, inviteRole? }, and an older bare role as a grant with none', () => {
    expect(StoredGrantSchema.parse('driver')).toEqual({ role: 'driver' });
    expect(StoredGrantSchema.parse({ role: 'observer' })).toEqual({ role: 'observer' });
    const invited = {
      role: 'observer',
      inviteId: 'inv_1',
      endsAt: 86_400_000,
      inviteRole: 'observer',
    };
    expect(StoredGrantSchema.parse(invited)).toEqual(invited);
    // A control guest who joined as observer while the driver seats were full keeps
    // the cap that lets the operator promote them later (ADR 0017).
    const control = { ...invited, inviteRole: 'driver' };
    expect(StoredGrantSchema.parse(control)).toEqual(control);
    expect(StoredGrantSchema.parse({ ...control, role: 'driver' })).toEqual({
      ...control,
      role: 'driver',
    });
    for (const bad of [
      'admin',
      { role: 'admin' },
      { role: 'driver', extra: 1 },
      { inviteId: 'x' },
      // A watch guest is never a driver, whatever the stored role says.
      { ...invited, role: 'driver' },
      // An invite, its end and its cap come together or not at all.
      { role: 'observer', inviteId: 'inv_1', endsAt: 86_400_000 },
      { role: 'observer', inviteRole: 'observer' },
      { role: 'observer', endsAt: 86_400_000, inviteRole: 'driver' },
      { ...invited, inviteRole: 'admin' },
    ]) {
      expect(StoredGrantSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  const stored = {
    inviteId: 'inv_1',
    secretHash: HASH,
    role: 'observer',
    label: 'Friends',
    uses: 5,
    usesLeft: 5,
    createdAt: 1,
    expiresAt: null,
    refusals: 0,
    barred: [],
  };

  it('keep an invite by its hash and terms, never its secret', () => {
    expect(StoredInviteSchema.parse(stored)).toEqual(stored);
    expect(StoredInviteSchema.safeParse({ ...stored, secret: SECRET }).success).toBe(false);
    expect(StoredInviteSchema.safeParse({ ...stored, role: 'driver', uses: 2 }).success).toBe(
      false,
    );
    expect(StoredInviteSchema.safeParse({ ...stored, usesLeft: 6 }).success).toBe(false);
    expect(StoredInviteSchema.safeParse({ ...stored, refusals: 4 }).success).toBe(false);
    const page = { pageId: 'pg_1', invites: [stored] };
    expect(StoredInvitesSchema.parse(page)).toEqual(page);
    const eleven = Array.from({ length: 11 }, () => stored);
    expect(StoredInvitesSchema.safeParse({ pageId: 'pg_1', invites: eleven }).success).toBe(false);
  });
});

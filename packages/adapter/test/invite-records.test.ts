// Workstream B's invites in the adapter core (ADRs 0016 and 0017): minting
// with a WebCrypto secret whose hash alone leaves the page, the page's own
// record beside its grants, and the honour path, which trusts that record and
// the presented secret over anything the relay says. Many tests play a lying
// relay, as S5 and S14 ask: one that redeems without the secret, past the
// invite's uses, end, refusals or bars, above its role, or after a revoke.

import {
  INVITE_BURN_REFUSALS,
  INVITE_SECRET_CHARS,
  type InviteRefusalReason,
  MAX_INVITE_LIFETIME_MS,
  MAX_INVITE_USES,
  MAX_LIVE_INVITES_PER_PAGE,
  type PolicyInput,
  StoredInvitesSchema,
} from '@tabdock/protocol';
import { describe, expect, it } from 'vitest';
import {
  type AttachAnswer,
  type CryptoLike,
  type InviteResult,
  MINT_ANSWER_MS,
  type UiPort,
} from '../src/core.ts';
import {
  attachment,
  attachRequest,
  type FakeSocket,
  flush,
  GRANTS_KEY,
  GUEST,
  type Harness,
  invitedAttachment,
  type InviteListing,
  INVITES_KEY,
  invitesFrame,
  invoke,
  link,
  LINK_BASE,
  listingOf,
  MapStorage,
  mint,
  type Minted,
  OTHER_GUEST,
  redemption,
  results,
  setup,
  sha256Hex,
  SPONSOR,
  until,
} from './harness.ts';

const HOUR = 60 * 60_000;

/** A page linked to a relay that offers invites, with Alice attached as its sponsor. */
async function offering(
  policy: PolicyInput = {},
  storage?: MapStorage,
): Promise<{ h: Harness; socket: FakeSocket; listed: InviteListing[] }> {
  const h = setup({
    core: { policy: { invites: 'all', ...policy } },
    ...(storage ? { storage } : {}),
  });
  const socket = await link(h);
  socket.deliver(invitesFrame([]));
  return { h, socket, listed: [] };
}

type InviteCreate = Minted['create'];

function decisions(socket: FakeSocket) {
  return socket.framesOf('attach_decision');
}

/**
 * Delivers a redemption and waits until the page answers it or puts it
 * before the operator: the secret's hash takes the real WebCrypto a moment.
 */
async function redeem(
  h: Harness,
  socket: FakeSocket,
  frame: Parameters<FakeSocket['deliver']>[0],
): Promise<void> {
  const answered = decisions(socket).length;
  const shown = h.dock.state.pendingRequests.length;
  socket.deliver(frame);
  await until(
    () => decisions(socket).length > answered || h.dock.state.pendingRequests.length > shown,
    'an answer or a prompt',
  );
}

function storedInvites(storage: MapStorage) {
  const text = storage.getItem(INVITES_KEY);
  return text === null ? null : StoredInvitesSchema.parse(JSON.parse(text));
}

function codes(socket: FakeSocket) {
  return results(socket).map((frame) => frame.error?.code ?? 'ok');
}

const guestCaller = (role: 'driver' | 'observer' = 'driver') => ({
  userId: GUEST,
  displayName: 'guest@example.com',
  client: null,
  role,
});

/**
 * Node's WebCrypto, counting the digests that have settled, so a test can
 * act while a presented secret is still being hashed and then wait for the
 * hash to settle without guessing how long it takes.
 */
function countingCrypto(): { crypto: CryptoLike; digests: () => number } {
  let digests = 0;
  return {
    crypto: {
      getRandomValues: (array) => globalThis.crypto.getRandomValues(array),
      subtle: {
        digest: async (algorithm, data) => {
          const hash = await globalThis.crypto.subtle.digest(algorithm, data);
          digests += 1;
          return hash;
        },
      },
    },
    digests: () => digests,
  };
}

describe('dock.invite() mints (ADR 0017)', () => {
  it('draws a 128-bit secret, sends only its hash, keeps a record without it and resolves with the link once listed', async () => {
    const { h, socket } = await offering();
    const minted = await mint(h, socket, { label: 'Friends', role: 'observer', uses: 3 });
    expect(minted.secret).toMatch(new RegExp(`^[A-Za-z0-9_-]{${INVITE_SECRET_CHARS}}$`));
    expect(minted.link).toBe(`${LINK_BASE}#${minted.secret}`);
    expect(minted.inviteId).toMatch(/^inv_[A-Za-z0-9_-]{12}$/);
    // The hash is the relay's digestHex of the secret's text, and the frame carries nothing else of it.
    expect(minted.create).toEqual({
      t: 'invite_create',
      inviteId: minted.inviteId,
      role: 'observer',
      label: 'Friends',
      uses: 3,
      expiresAt: h.clock.now + HOUR,
      secretHash: await sha256Hex(minted.secret),
    });
    expect(storedInvites(h.storage)).toEqual({
      pageId: 'page-1',
      invites: [
        {
          inviteId: minted.inviteId,
          secretHash: minted.create.secretHash,
          role: 'observer',
          label: 'Friends',
          uses: 3,
          usesLeft: 3,
          createdAt: h.clock.now,
          expiresAt: h.clock.now + HOUR,
          refusals: 0,
          barred: [],
        },
      ],
    });
    expect(h.dock.state.invites).toEqual([
      {
        inviteId: minted.inviteId,
        role: 'observer',
        label: 'Friends',
        uses: 3,
        usesLeft: 3,
        joined: 0,
        expiresAt: h.clock.now + HOUR,
        sponsor: { userId: 'alice', displayName: 'Alice' },
        pending: false,
        refusals: 0,
      },
    ]);
    // S11: the secret is in the link and nowhere else.
    for (const where of [
      h.logs.join('\n'),
      socket.sent.join('\n'),
      JSON.stringify(h.dock.state),
      JSON.stringify([...h.storage.items]),
    ]) {
      expect(where).not.toContain(minted.secret);
    }
  });

  it('draws a different secret and id every time', async () => {
    const { h, socket, listed } = await offering();
    const seen = new Set<string>();
    for (let n = 0; n < 5; n += 1) {
      const minted = await mint(h, socket, { label: `Guest ${n}`, role: 'observer' }, listed);
      seen.add(minted.secret);
      seen.add(minted.inviteId);
    }
    expect(seen.size).toBe(10);
  });

  it('sets each lifetime on the page clock, one use by default and exactly one for Can control', async () => {
    const { h, socket, listed } = await offering();
    const now = h.clock.now;
    const short = await mint(h, socket, { label: 'a', role: 'observer', lifetime: '15m' }, listed);
    const hour = await mint(h, socket, { label: 'b', role: 'observer' }, listed);
    const open = await mint(h, socket, { label: 'c', role: 'observer', lifetime: 'open' }, listed);
    const control = await mint(h, socket, { label: 'd', role: 'driver', uses: 1 }, listed);
    expect([short, hour, open, control].map((m) => [m.create.expiresAt, m.create.uses])).toEqual([
      [now + 15 * 60_000, 1],
      [now + HOUR, 1],
      [null, 1],
      [now + HOUR, 1],
    ]);
  });

  it.each<InviteRefusalReason>([
    'no_sponsor',
    'policy',
    'limit',
    'duplicate',
    'no_public_url',
    'expired',
  ])("settles with the relay's refusal %s and forgets the invite", async (reason) => {
    const { h, socket } = await offering();
    const pending = h.dock.invite({ label: 'Friends', role: 'observer' });
    await until(() => socket.framesOf('invite_create').length === 1);
    const [create] = socket.framesOf('invite_create');
    socket.deliver(invitesFrame([], { refused: { inviteId: create?.inviteId ?? '', reason } }));
    expect(await pending).toEqual({ ok: false, reason });
    expect(h.storage.getItem(INVITES_KEY)).toBeNull();
    expect(h.dock.state.invites).toEqual([]);
  });

  it('refuses without asking the relay when it has no public URL, or the page holds ten', async () => {
    const h = setup();
    const socket = await link(h);
    socket.deliver(invitesFrame([], { linkBase: null }));
    expect(await h.dock.invite({ label: 'Friends', role: 'observer' })).toEqual({
      ok: false,
      reason: 'no_public_url',
    });
    expect(socket.framesOf('invite_create')).toEqual([]);

    const full = await offering();
    for (let n = 0; n < MAX_LIVE_INVITES_PER_PAGE; n += 1) {
      await mint(full.h, full.socket, { label: `Guest ${n}`, role: 'observer' }, full.listed);
    }
    expect(await full.h.dock.invite({ label: 'One more', role: 'observer' })).toEqual({
      ok: false,
      reason: 'limit',
    });
    expect(full.socket.framesOf('invite_create')).toHaveLength(MAX_LIVE_INVITES_PER_PAGE);
  });

  it('refuses as unavailable on a page without WebCrypto, as outside a secure context', async () => {
    const insecure = { getRandomValues: (array: Uint8Array) => array } as unknown as CryptoLike;
    const h = setup({ core: { policy: { invites: 'all' }, crypto: insecure } });
    const socket = await link(h);
    socket.deliver(invitesFrame([]));
    expect(await h.dock.invite({ label: 'Friends', role: 'observer' })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(socket.framesOf('invite_create')).toEqual([]);
  });

  it('settles link_down when the link drops before the answer, and closes the invite should a resumed relay list it', async () => {
    const { h, socket } = await offering();
    const pending = h.dock.invite({ label: 'Friends', role: 'observer' });
    await until(() => socket.framesOf('invite_create').length === 1);
    const [create] = socket.framesOf('invite_create');
    if (!create) throw new Error('no invite_create');
    socket.drop();
    expect(await pending).toEqual({ ok: false, reason: 'link_down' });
    expect(h.storage.getItem(INVITES_KEY)).toBeNull();

    await h.clock.advance(1000);
    const next = h.socket();
    next.accept();
    next.deliver({
      t: 'welcome',
      pageId: 'page-1',
      resumeToken: 'resume-2',
      resumed: true,
      pairing: { code: 'ABCDE-FGHJK', expiresAt: h.clock.now + 120_000 },
      roster: [attachment('alice', 'driver')],
      limits: {
        maxFrameBytes: 1024 * 1024,
        maxResultChars: 120_000,
        maxDescriptionChars: 1000,
        pingIntervalMs: 15_000,
        idleTimeoutMs: 30_000,
        resumeWindowMs: 600_000,
        attachRequestTtlMs: 60_000,
      },
    });
    next.deliver(invitesFrame([listingOf(create)]));
    next.deliver(invitesFrame([listingOf(create)]));
    expect(next.framesOf('invite_cancel')).toEqual([
      { t: 'invite_cancel', inviteId: create.inviteId },
    ]);
    expect(h.dock.state.invites).toEqual([]);
  });

  it('gives up on a relay that never answers, and forgets the invite', async () => {
    const { h, socket } = await offering();
    const pending = h.dock.invite({ label: 'Friends', role: 'observer' });
    await until(() => socket.framesOf('invite_create').length === 1);
    // The relay pings, so the link stays up while the answer never comes.
    for (let waited = 0; waited < MINT_ANSWER_MS; waited += 5000) {
      socket.deliver({ t: 'ping' });
      await h.clock.advance(5000);
    }
    expect(await pending).toEqual({ ok: false, reason: 'unavailable' });
    expect(h.storage.getItem(INVITES_KEY)).toBeNull();
    expect(socket.framesOf('invite_cancel')).toHaveLength(1);
  });

  it('closes, and never shows, an invite the relay lists on other terms than it was minted with', async () => {
    const { h, socket } = await offering();
    const pending = h.dock.invite({ label: 'Friends', role: 'observer' });
    await until(() => socket.framesOf('invite_create').length === 1);
    const [create] = socket.framesOf('invite_create');
    if (!create) throw new Error('no invite_create');
    // A watch invite listed back as Can control.
    socket.deliver(invitesFrame([listingOf(create, { role: 'driver', uses: 1, usesLeft: 1 })]));
    expect(await pending).toEqual({ ok: false, reason: 'unavailable' });
    expect(socket.framesOf('invite_cancel')).toEqual([
      { t: 'invite_cancel', inviteId: create.inviteId },
    ]);
    expect(h.dock.state.invites).toEqual([]);
  });
});

describe('dock.invite() against a relay that answers wrongly (S14)', () => {
  it.each<[string, (create: InviteCreate) => Partial<InviteListing>]>([
    ['another label', () => ({ label: 'Family' })],
    ['another expiry', (create) => ({ expiresAt: (create.expiresAt ?? 0) + 60_000 })],
    ['no expiry', () => ({ expiresAt: null })],
    ['more uses', (create) => ({ uses: create.uses + 1, usesLeft: create.uses + 1 })],
  ])(
    'settles unavailable, shows nothing and closes the invite when the relay lists it with %s',
    async (_name, other) => {
      const { h, socket } = await offering();
      const pending = h.dock.invite({ label: 'Friends', role: 'observer', uses: 2 });
      await until(() => socket.framesOf('invite_create').length === 1);
      const [create] = socket.framesOf('invite_create');
      if (!create) throw new Error('no invite_create');
      socket.deliver(invitesFrame([listingOf(create, other(create))]));
      expect(await pending).toEqual({ ok: false, reason: 'unavailable' });
      expect(socket.framesOf('invite_cancel')).toEqual([
        { t: 'invite_cancel', inviteId: create.inviteId },
      ]);
      expect(h.dock.state.invites).toEqual([]);
      expect(h.storage.getItem(INVITES_KEY)).toBeNull();
    },
  );

  it('settles link_down at once, keeping no record, when invite_create cannot be sent', async () => {
    const { h, socket } = await offering();
    // The socket is closing and its close event has not arrived: the link still
    // looks up, but nothing can be sent on it, so no relay will ever answer.
    socket.readyState = 2;
    const settled: { result?: InviteResult } = {};
    void h.dock.invite({ label: 'Friends', role: 'observer' }).then((result) => {
      settled.result = result;
    });
    await until(() => settled.result !== undefined, 'the mint to settle');
    expect(settled.result).toEqual({ ok: false, reason: 'link_down' });
    expect(socket.framesOf('invite_create')).toEqual([]);
    expect(h.storage.getItem(INVITES_KEY)).toBeNull();
  });

  it('closes an invite it holds no record of once per link, and again on the next link', async () => {
    const { h, socket } = await offering();
    const stranger: InviteListing = {
      inviteId: 'inv_not_minted_here',
      role: 'observer',
      label: 'Not ours',
      uses: 1,
      expiresAt: null,
      usesLeft: 1,
      sponsor: SPONSOR,
      pending: false,
      refusals: 0,
    };
    const cancel = { t: 'invite_cancel', inviteId: stranger.inviteId };
    socket.deliver(invitesFrame([stranger]));
    socket.deliver(invitesFrame([stranger]));
    expect(socket.framesOf('invite_cancel')).toEqual([cancel]);
    // A cancel sent on a link that then dropped may never have arrived.
    socket.drop();
    await h.clock.advance(1000);
    const next = h.socket();
    next.accept();
    next.deliver(welcomeAgain(h));
    next.deliver(invitesFrame([stranger]));
    next.deliver(invitesFrame([stranger]));
    expect(next.framesOf('invite_cancel')).toEqual([cancel]);
  });
});

describe('the live list (ADR 0017)', () => {
  it('shows the fewer uses left, and its own count of who joined, whatever the relay claims', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mint(h, socket, { label: 'Friends', role: 'observer', uses: 3 }, listed);
    await redeem(h, socket, redemption(h.clock, minted));
    // A relay claiming every use is still left, and one claiming fewer.
    socket.deliver(invitesFrame([listingOf(minted.create, { usesLeft: 3 })]));
    expect(h.dock.state.invites[0]).toMatchObject({ usesLeft: 2, joined: 1 });
    socket.deliver(invitesFrame([listingOf(minted.create, { usesLeft: 1, pending: true })]));
    expect(h.dock.state.invites[0]).toMatchObject({ usesLeft: 1, joined: 1, pending: true });
  });

  it('drops an invite the relay stops listing: used up, cancelled or expired there', async () => {
    const { h, socket, listed } = await offering();
    const first = await mint(h, socket, { label: 'First', role: 'observer' }, listed);
    const second = await mint(h, socket, { label: 'Second', role: 'observer' }, listed);
    expect(h.dock.state.invites.map((view) => view.label)).toEqual(['First', 'Second']);
    socket.deliver(invitesFrame([listingOf(second.create)]));
    expect(h.dock.state.invites.map((view) => view.label)).toEqual(['Second']);
    expect(storedInvites(h.storage)?.invites.map((invite) => invite.inviteId)).toEqual([
      second.inviteId,
    ]);
    // The dropped one is honoured no more.
    await redeem(h, socket, redemption(h.clock, first));
    expect(decisions(socket).at(-1)).toMatchObject({ allow: false });
  });

  it('Cancel closes the link and forgets the record at once, offline too, and a resumed relay still listing it hears the cancel', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mint(h, socket, { label: 'Friends', role: 'observer', uses: 5 }, listed);
    expect(h.dock.cancelInvite(minted.inviteId)).toBe(true);
    expect(socket.framesOf('invite_cancel')).toEqual([
      { t: 'invite_cancel', inviteId: minted.inviteId },
    ]);
    expect(h.dock.state.invites).toEqual([]);
    expect(h.storage.getItem(INVITES_KEY)).toBeNull();
    expect(h.dock.cancelInvite(minted.inviteId)).toBe(false);
    // The relay has not applied it yet, and a redemption arrives anyway.
    await redeem(h, socket, redemption(h.clock, minted));
    expect(decisions(socket).at(-1)).toMatchObject({ allow: false });

    const other = await mint(h, socket, { label: 'Other', role: 'observer' }, [
      listingOf(minted.create),
    ]);
    socket.drop();
    expect(h.dock.cancelInvite(other.inviteId)).toBe(true);
    await h.clock.advance(1000);
    const next = h.socket();
    next.accept();
    next.deliver({ ...welcomeAgain(h), resumed: true });
    next.deliver(invitesFrame([listingOf(other.create)]));
    expect(next.framesOf('invite_cancel')).toEqual([
      { t: 'invite_cancel', inviteId: other.inviteId },
    ]);
  });
});

function welcomeAgain(h: Harness) {
  return {
    t: 'welcome' as const,
    pageId: 'page-1',
    resumeToken: 'resume-2',
    resumed: true,
    pairing: { code: 'ABCDE-FGHJK', expiresAt: h.clock.now + 120_000 },
    roster: [attachment('alice', 'driver')],
    limits: {
      maxFrameBytes: 1024 * 1024,
      maxResultChars: 120_000,
      maxDescriptionChars: 1000,
      pingIntervalMs: 15_000,
      idleTimeoutMs: 30_000,
      resumeWindowMs: 600_000,
      attachRequestTtlMs: 60_000,
    },
  };
}

describe('honouring a redemption (S4, S14)', () => {
  it('lets a Can watch link in as observer without a prompt, as a grant with its invite, end and cap', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mint(h, socket, { label: 'Friends', role: 'observer', uses: 3 }, listed);
    await redeem(h, socket, redemption(h.clock, minted));
    expect(h.dock.state.pendingRequests).toEqual([]);
    expect(decisions(socket)).toContainEqual({
      t: 'attach_decision',
      requestId: `redeem-${minted.inviteId}`,
      allow: true,
      role: 'observer',
    });
    const grants = JSON.parse(h.storage.getItem(GRANTS_KEY) ?? '{}') as {
      grants: Record<string, unknown>;
    };
    expect(grants.grants[GUEST]).toEqual({
      role: 'observer',
      inviteId: minted.inviteId,
      endsAt: h.clock.now + MAX_INVITE_LIFETIME_MS,
      inviteRole: 'observer',
    });
    expect(storedInvites(h.storage)?.invites[0]).toMatchObject({ usesLeft: 2 });
  });

  it.each([
    [
      'a wrong secret',
      (m: Minted) => ({
        invite: { inviteId: m.inviteId, secret: 'A'.repeat(22), label: 'Friends' },
      }),
    ],
    [
      'an invite the page never minted',
      (m: Minted) => ({ invite: { inviteId: 'inv_made_up', secret: m.secret, label: 'Friends' } }),
    ],
    [
      'another invite of the page',
      (m: Minted) => ({
        invite: { inviteId: m.inviteId, secret: 'B'.repeat(22), label: 'Friends' },
      }),
    ],
    [
      'a label the invite never had',
      (m: Minted) => ({ invite: { inviteId: m.inviteId, secret: m.secret, label: 'Family' } }),
    ],
  ])('refuses %s without a prompt, a grant or a spent use', async (_name, tamper) => {
    const { h, socket, listed } = await offering();
    const minted = await mint(h, socket, { label: 'Friends', role: 'observer', uses: 3 }, listed);
    await redeem(h, socket, redemption(h.clock, minted, tamper(minted)));
    expect(decisions(socket).at(-1)).toEqual({
      t: 'attach_decision',
      requestId: `redeem-${minted.inviteId}`,
      allow: false,
    });
    expect(h.dock.state.pendingRequests).toEqual([]);
    expect(h.storage.getItem(GRANTS_KEY)).not.toContain(GUEST);
    expect(storedInvites(h.storage)?.invites[0]).toMatchObject({ usesLeft: 3 });
  });

  it('refuses a link past its expiry on the page clock, though the relay still lists it', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mint(
      h,
      socket,
      { label: 'Friends', role: 'observer', lifetime: '15m' },
      listed,
    );
    h.clock.now += 15 * 60_000;
    await redeem(h, socket, redemption(h.clock, minted));
    expect(decisions(socket).at(-1)).toMatchObject({ allow: false });
  });

  it('ends "while the page is open" 24 hours after minting all the same', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mint(
      h,
      socket,
      { label: 'Friends', role: 'observer', lifetime: 'open' },
      listed,
    );
    h.clock.now += MAX_INVITE_LIFETIME_MS;
    await redeem(h, socket, redemption(h.clock, minted));
    expect(decisions(socket).at(-1)).toMatchObject({ allow: false });
  });

  it('honours no more redemptions than the invite has uses, whatever the relay counts', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mint(h, socket, { label: 'Friends', role: 'observer', uses: 2 }, listed);
    const accounts = [GUEST, OTHER_GUEST, `g_${'9'.repeat(32)}`];
    for (const [n, userId] of accounts.entries()) {
      await redeem(
        h,
        socket,
        redemption(h.clock, minted, {
          requestId: `r${n}`,
          user: { userId, displayName: 'unverified account' },
          account: { kind: 'invitee', verified: false },
        }),
      );
    }
    expect(
      decisions(socket)
        .filter((frame) => /^r\d$/.test(frame.requestId))
        .map((frame) => frame.allow),
    ).toEqual([true, true, false]);
  });

  it('refuses someone already attached, since a redemption changes nothing for them', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mint(h, socket, { label: 'Friends', role: 'observer', uses: 3 }, listed);
    await redeem(
      h,
      socket,
      redemption(h.clock, minted, {
        user: { userId: 'alice', displayName: 'Alice' },
        account: { kind: 'member', verified: true },
      }),
    );
    expect(decisions(socket).at(-1)).toMatchObject({ allow: false });
  });

  it('lets a member who is not attached in by invite, with the same cap and end', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mint(h, socket, { label: 'Friends', role: 'observer' }, listed);
    await redeem(
      h,
      socket,
      redemption(h.clock, minted, {
        user: { userId: 'bob', displayName: 'Bob' },
        account: { kind: 'member', verified: true },
      }),
    );
    expect(decisions(socket).at(-1)).toMatchObject({ allow: true, role: 'observer' });
    socket.deliver({
      t: 'roster',
      attachments: [
        attachment('alice', 'driver'),
        invitedAttachment(
          'bob',
          'driver',
          minted.inviteId,
          h.clock.now + MAX_INVITE_LIFETIME_MS,
          'Bob',
        ),
      ],
    });
    expect(h.dock.state.pageRoles[1]).toEqual({
      userId: 'bob',
      role: 'observer',
      revoked: false,
      inviteRole: 'observer',
    });
    expect(h.dock.setRole('bob', 'driver')).toBe(false);
  });

  it('asks the operator about a Can control link, grants what they choose and spends it', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mint(h, socket, { label: 'Help', role: 'driver' }, listed);
    await redeem(h, socket, redemption(h.clock, minted));
    expect(h.dock.state.pendingRequests).toHaveLength(1);
    expect(decisions(socket)).toEqual([expect.objectContaining({ requestId: 'grant-alice' })]);
    expect(h.dock.approve(`redeem-${minted.inviteId}`, 'driver')).toBe(true);
    expect(decisions(socket).at(-1)).toEqual({
      t: 'attach_decision',
      requestId: `redeem-${minted.inviteId}`,
      allow: true,
      role: 'driver',
    });
    socket.deliver({
      t: 'roster',
      attachments: [
        attachment('alice', 'driver'),
        invitedAttachment(GUEST, 'driver', minted.inviteId, h.clock.now + MAX_INVITE_LIFETIME_MS),
      ],
    });
    socket.deliver(invoke('set_value', { caller: guestCaller() }));
    await flush();
    expect(codes(socket)).toEqual(['ok']);
    // Spent: another account's redemption is refused without a prompt.
    await redeem(
      h,
      socket,
      redemption(h.clock, minted, {
        requestId: 'again',
        user: { userId: OTHER_GUEST, displayName: 'other@example.com' },
      }),
    );
    expect(decisions(socket).at(-1)).toMatchObject({ requestId: 'again', allow: false });
  });

  it('holds one Can control prompt at a time, refusing a second account meanwhile', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mint(h, socket, { label: 'Help', role: 'driver' }, listed);
    await redeem(h, socket, redemption(h.clock, minted, { requestId: 'first' }));
    await redeem(
      h,
      socket,
      redemption(h.clock, minted, {
        requestId: 'second',
        user: { userId: OTHER_GUEST, displayName: 'other@example.com' },
      }),
    );
    expect(h.dock.state.pendingRequests.map((request) => request.requestId)).toEqual(['first']);
    expect(decisions(socket).at(-1)).toMatchObject({ requestId: 'second', allow: false });
  });

  it('burns a Can control link after three refusals or timeouts, and counts nothing it refused itself', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mint(h, socket, { label: 'Help', role: 'driver' }, listed);
    // A rule's refusal (a wrong secret) is not the operator's and burns nothing.
    await redeem(
      h,
      socket,
      redemption(h.clock, minted, {
        requestId: 'forged',
        invite: { inviteId: minted.inviteId, secret: 'C'.repeat(22), label: 'Help' },
      }),
    );
    for (let n = 1; n <= INVITE_BURN_REFUSALS; n += 1) {
      await redeem(h, socket, redemption(h.clock, minted, { requestId: `try-${n}` }));
      if (n === 2) {
        // Silence until the request's end is a refusal too; the relay keeps pinging meanwhile.
        for (let waited = 0; waited < 60_000; waited += 20_000) {
          socket.deliver({ t: 'ping' });
          await h.clock.advance(20_000);
        }
      } else {
        expect(h.dock.deny(`try-${n}`)).toBe(true);
      }
      expect(storedInvites(h.storage)?.invites[0]?.refusals).toBe(n);
    }
    await redeem(h, socket, redemption(h.clock, minted, { requestId: 'after' }));
    expect(h.dock.state.pendingRequests).toEqual([]);
    expect(decisions(socket).at(-1)).toMatchObject({ requestId: 'after', allow: false });
  });

  it('checks the invite again as the operator approves, refusing one closed while its prompt was up', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mint(h, socket, { label: 'Help', role: 'driver' }, listed);
    await redeem(h, socket, redemption(h.clock, minted));
    const asked = h.dock.state.pendingRequests[0];
    expect(asked?.requestId).toBe(`redeem-${minted.inviteId}`);
    // Revoke all closes every invite; the prompt goes with its invite.
    expect(h.dock.revoke('*')).toBe(true);
    expect(h.dock.state.pendingRequests).toEqual([]);
    expect(decisions(socket).at(-1)).toMatchObject({ requestId: asked?.requestId, allow: false });
    expect(h.dock.approve(asked?.requestId ?? '', 'driver')).toBe(false);
  });

  it('refuses an approval made after the Can control invite expired while its prompt was up, spending and counting nothing', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mint(
      h,
      socket,
      { label: 'Help', role: 'driver', lifetime: '15m' },
      listed,
    );
    // Redeemed 30 s before the invite ends; its prompt lasts a minute.
    h.clock.now += 15 * 60_000 - 30_000;
    await redeem(h, socket, redemption(h.clock, minted));
    const requestId = `redeem-${minted.inviteId}`;
    socket.deliver({ t: 'ping' });
    await h.clock.advance(31_000);
    expect(h.dock.state.pendingRequests.map((request) => request.requestId)).toEqual([requestId]);
    h.dock.approve(requestId, 'driver');
    expect(decisions(socket).at(-1)).toEqual({ t: 'attach_decision', requestId, allow: false });
    expect(h.dock.state.pendingRequests).toEqual([]);
    expect(h.storage.getItem(GRANTS_KEY)).not.toContain(GUEST);
    // Not the operator's refusal, so it burns nothing either.
    expect(storedInvites(h.storage)?.invites[0]).toMatchObject({ usesLeft: 1, refusals: 0 });
  });

  it('refuses an approval for an account that got attached another way while its Can control prompt was up', async () => {
    const { h, socket, listed } = await offering();
    const control = await mint(h, socket, { label: 'Help', role: 'driver' }, listed);
    const watch = await mint(h, socket, { label: 'Friends', role: 'observer', uses: 2 }, listed);
    await redeem(h, socket, redemption(h.clock, control));
    // Meanwhile the same guest joins by the Can watch link, and the relay lists them.
    await redeem(h, socket, redemption(h.clock, watch));
    expect(decisions(socket).at(-1)).toMatchObject({ allow: true, role: 'observer' });
    socket.deliver({
      t: 'roster',
      attachments: [
        attachment('alice', 'driver'),
        invitedAttachment(GUEST, 'observer', watch.inviteId, h.clock.now + HOUR),
      ],
    });
    const requestId = `redeem-${control.inviteId}`;
    h.dock.approve(requestId, 'driver');
    expect(decisions(socket).at(-1)).toEqual({ t: 'attach_decision', requestId, allow: false });
    // Still the Can watch grant, capped at observer, and the Can control link unspent.
    expect(h.dock.state.pageRoles[1]).toMatchObject({ role: 'observer', inviteRole: 'observer' });
    const controlRecord = storedInvites(h.storage)?.invites.find(
      (invite) => invite.inviteId === control.inviteId,
    );
    expect(controlRecord).toMatchObject({ usesLeft: 1, refusals: 0 });
  });

  it('leaves no prompt behind for a redemption revoked while its secret was being hashed', async () => {
    const counted = countingCrypto();
    const h = setup({ core: { policy: { invites: 'all' }, crypto: counted.crypto } });
    const socket = await link(h);
    socket.deliver(invitesFrame([]));
    const minted = await mint(h, socket, { label: 'Help', role: 'driver' });
    const hashed = counted.digests();
    socket.deliver(redemption(h.clock, minted));
    // Revoked before the hash settles: the request ends at once, on the page
    // and, through the revoke frame, on the relay, so the page sends no
    // decision for it (A4.3), then or once the hash settles.
    expect(h.dock.revoke(GUEST)).toBe(true);
    expect(socket.framesOf('revoke').at(-1)).toEqual({ t: 'revoke', userId: GUEST });
    expect(h.dock.state.pendingRequests).toEqual([]);
    await until(() => counted.digests() > hashed, 'the presented secret to be hashed');
    await flush();
    expect(h.dock.state.pendingRequests).toEqual([]);
    expect(decisions(socket).filter((frame) => frame.requestId !== 'grant-alice')).toEqual([]);
  });

  it('gives the handle nothing to approve while a secret is still being checked', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mint(h, socket, { label: 'Help', role: 'driver' }, listed);
    socket.deliver(
      redemption(h.clock, minted, {
        invite: { inviteId: minted.inviteId, secret: 'D'.repeat(22), label: 'Help' },
      }),
    );
    // Delivered, and not yet hashed: a script racing the check gets nowhere.
    expect(h.dock.approve(`redeem-${minted.inviteId}`, 'driver')).toBe(false);
    await until(() => decisions(socket).length === 2);
    expect(decisions(socket).at(-1)).toMatchObject({ allow: false });
  });

  it('still checks the secret under autoApprove, and gives an invitee the relay lists unasked nothing', async () => {
    const { h, socket, listed } = await offering({ autoApprove: 'observer' });
    const minted = await mint(h, socket, { label: 'Friends', role: 'observer' }, listed);
    await redeem(
      h,
      socket,
      redemption(h.clock, minted, {
        invite: { inviteId: minted.inviteId, secret: 'E'.repeat(22), label: 'Friends' },
      }),
    );
    expect(decisions(socket).at(-1)).toMatchObject({ allow: false });
    // A relay that attached them anyway: autoApprove covers members only.
    socket.deliver({
      t: 'roster',
      attachments: [
        attachment('alice', 'driver'),
        invitedAttachment(GUEST, 'observer', minted.inviteId, h.clock.now + HOUR),
        attachment('carol', 'observer'),
      ],
    });
    socket.deliver(invoke('get_value', { caller: guestCaller('observer') }));
    socket.deliver(
      invoke('get_value', {
        callId: 'carol-1',
        caller: { userId: 'carol', displayName: 'Carol', client: null, role: 'observer' },
      }),
    );
    await flush();
    expect(codes(socket)).toEqual(['role_denied', 'ok']);
    expect(h.dock.setRole(GUEST, 'observer')).toBe(false);
  });

  it("refuses an invitee's code or QR request without asking, since invitees join only by invite", async () => {
    const { h, socket } = await offering();
    for (const via of ['code', 'qr'] as const) {
      socket.deliver({
        ...attachRequest(h.clock, `by-${via}`),
        user: { userId: GUEST, displayName: 'guest@example.com' },
        account: { kind: 'invitee', verified: true },
        via,
      });
    }
    expect(h.dock.state.pendingRequests).toEqual([]);
    expect(decisions(socket).slice(-2)).toEqual([
      { t: 'attach_decision', requestId: 'by-code', allow: false },
      { t: 'attach_decision', requestId: 'by-qr', allow: false },
    ]);
  });
});

describe("an invite's role cap and end (S5, S14)", () => {
  async function watchGuest() {
    const { h, socket, listed } = await offering();
    const minted = await mint(h, socket, { label: 'Friends', role: 'observer', uses: 3 }, listed);
    await redeem(h, socket, redemption(h.clock, minted));
    const endsAt = h.clock.now + MAX_INVITE_LIFETIME_MS;
    return { h, socket, minted, endsAt };
  }

  it('runs a Can watch guest as observer whatever the roster and the invoke claim, and refuses Make driver', async () => {
    const { h, socket, minted, endsAt } = await watchGuest();
    // A lying relay: the guest drives, and so does every invoke it sends.
    socket.deliver({
      t: 'roster',
      attachments: [
        attachment('alice', 'driver'),
        invitedAttachment(GUEST, 'driver', minted.inviteId, endsAt),
      ],
    });
    socket.deliver(invoke('set_value', { caller: guestCaller() }));
    socket.deliver(invoke('get_value', { callId: 'read', caller: guestCaller() }));
    await flush();
    expect(codes(socket)).toEqual(['role_denied', 'ok']);
    expect(h.dock.state.pageRoles[1]).toEqual({
      userId: GUEST,
      role: 'observer',
      revoked: false,
      inviteRole: 'observer',
    });
    expect(h.dock.setRole(GUEST, 'driver')).toBe(false);
    expect(socket.framesOf('set_role')).toEqual([]);
    // The page's log names the guest by short id, never by email (ADR 0020).
    expect(h.logs.join('\n')).toContain('by invitee 1a2b3c4d (driver)');
    expect(h.logs.join('\n')).not.toContain('guest@example.com');
  });

  it('lets the operator promote a Can control guest who joined as observer while the seats were full', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mint(h, socket, { label: 'Help', role: 'driver' }, listed);
    await redeem(h, socket, redemption(h.clock, minted));
    expect(h.dock.approve(`redeem-${minted.inviteId}`, 'observer')).toBe(true);
    socket.deliver({
      t: 'roster',
      attachments: [
        attachment('alice', 'driver'),
        invitedAttachment(GUEST, 'observer', minted.inviteId, h.clock.now + HOUR),
      ],
    });
    expect(h.dock.state.pageRoles[1]).toMatchObject({ role: 'observer', inviteRole: 'driver' });
    expect(h.dock.setRole(GUEST, 'driver')).toBe(true);
    expect(socket.framesOf('set_role')).toEqual([{ t: 'set_role', userId: GUEST, role: 'driver' }]);
  });

  it('ends an invite-made grant 24 hours after redemption, whatever the relay still lists', async () => {
    const { h, socket, minted, endsAt } = await watchGuest();
    socket.deliver({
      t: 'roster',
      attachments: [
        attachment('alice', 'driver'),
        invitedAttachment(GUEST, 'observer', minted.inviteId, endsAt + HOUR),
      ],
    });
    expect(h.dock.state.pageRoles[1]?.role).toBe('observer');
    // Just before the end, then past it: the shown role changes on its own.
    h.clock.now = endsAt - 10;
    socket.deliver({ t: 'ping' });
    await h.clock.advance(20);
    expect(h.dock.state.pageRoles[1]?.role).toBeNull();
    socket.deliver(invoke('get_value', { caller: guestCaller('observer') }));
    await flush();
    expect(codes(socket)).toEqual(['role_denied']);
    expect(h.dock.setRole(GUEST, 'observer')).toBe(false);
  });
});

describe('Revoke and invites (S8, S14)', () => {
  async function guestIn(uses: number) {
    const { h, socket, listed } = await offering();
    const minted = await mint(h, socket, { label: 'Friends', role: 'observer', uses }, listed);
    await redeem(h, socket, redemption(h.clock, minted));
    socket.deliver({
      t: 'roster',
      attachments: [
        attachment('alice', 'driver'),
        invitedAttachment(GUEST, 'observer', minted.inviteId, h.clock.now + HOUR),
      ],
    });
    return { h, socket, minted, listed };
  }

  it("closes a multi-use invitee's link by default, after barring them and sending the revoke", async () => {
    const { h, socket, minted } = await guestIn(3);
    expect(h.dock.revoke(GUEST)).toBe(true);
    expect(socket.frames().slice(-2)).toEqual([
      { t: 'revoke', userId: GUEST },
      { t: 'invite_cancel', inviteId: minted.inviteId },
    ]);
    expect(h.dock.state.invites).toEqual([]);
    expect(h.storage.getItem(INVITES_KEY)).toBeNull();
  });

  it('with the link left open, bars the revoked account from it for good, and only them', async () => {
    const { h, socket, minted } = await guestIn(3);
    expect(h.dock.revoke(GUEST, { closeInvite: false })).toBe(true);
    expect(socket.framesOf('invite_cancel')).toEqual([]);
    expect(storedInvites(h.storage)?.invites[0]?.barred).toEqual([GUEST]);
    // The relay applies the revoke; the barred account comes back by the same link.
    socket.deliver({ t: 'roster', attachments: [attachment('alice', 'driver')] });
    await redeem(h, socket, redemption(h.clock, minted, { requestId: 'back' }));
    expect(decisions(socket).at(-1)).toMatchObject({ requestId: 'back', allow: false });
    await redeem(
      h,
      socket,
      redemption(h.clock, minted, {
        requestId: 'someone-else',
        user: { userId: OTHER_GUEST, displayName: 'other@example.com' },
      }),
    );
    expect(decisions(socket).at(-1)).toMatchObject({ requestId: 'someone-else', allow: true });
  });

  it('keeps a link open only for an explicit false, whatever else a script passes', async () => {
    for (const options of [null, 'no', { closeInvite: 'no' }, { closeInvite: 0 }]) {
      const { h, socket, minted } = await guestIn(3);
      expect(h.dock.revoke(GUEST, options as never)).toBe(true);
      expect(socket.framesOf('invite_cancel'), JSON.stringify(options)).toEqual([
        { t: 'invite_cancel', inviteId: minted.inviteId },
      ]);
    }
  });

  it('leaves a single-use link alone by default, as joining spent it', async () => {
    const { h, socket } = await guestIn(1);
    expect(h.dock.revoke(GUEST)).toBe(true);
    expect(socket.framesOf('invite_cancel')).toEqual([]);
  });

  it('never lets a redemption clear a revoke the relay has not applied yet', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mint(h, socket, { label: 'Friends', role: 'observer', uses: 3 }, listed);
    // Bob was approved by code, then revoked; the relay still lists him.
    socket.deliver({
      ...attachRequest(h.clock, 'bob-code'),
      user: { userId: 'bob', displayName: 'Bob' },
    });
    h.dock.approve('bob-code', 'driver');
    socket.deliver({
      t: 'roster',
      attachments: [attachment('alice', 'driver'), attachment('bob', 'driver')],
    });
    expect(h.dock.revoke('bob')).toBe(true);
    socket.deliver({ t: 'roster', attachments: [attachment('alice', 'driver')] });
    socket.deliver({
      t: 'roster',
      attachments: [attachment('alice', 'driver'), attachment('bob', 'driver')],
    });
    h.dock.revoke('bob');
    await redeem(
      h,
      socket,
      redemption(h.clock, minted, {
        requestId: 'bob-invite',
        user: { userId: 'bob', displayName: 'Bob' },
        account: { kind: 'member', verified: true },
      }),
    );
    expect(decisions(socket).at(-1)).toMatchObject({ requestId: 'bob-invite', allow: false });
    expect(h.dock.state.pageRoles.find((role) => role.userId === 'bob')).toMatchObject({
      role: null,
      revoked: true,
    });
  });

  it('bars a revoked account from the invite the roster names, though its own grant names none', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mint(h, socket, { label: 'Friends', role: 'observer', uses: 3 }, listed);
    // Bob was approved by code; the relay says he came by the invite.
    socket.deliver({
      ...attachRequest(h.clock, 'bob-code'),
      user: { userId: 'bob', displayName: 'Bob' },
    });
    expect(h.dock.approve('bob-code', 'observer')).toBe(true);
    socket.deliver({
      t: 'roster',
      attachments: [
        attachment('alice', 'driver'),
        invitedAttachment('bob', 'observer', minted.inviteId, h.clock.now + HOUR, 'Bob'),
      ],
    });
    expect(h.dock.revoke('bob', { closeInvite: false })).toBe(true);
    expect(storedInvites(h.storage)?.invites[0]?.barred).toEqual(['bob']);
    // The relay applies the revoke, and Bob comes back by the link.
    socket.deliver({ t: 'roster', attachments: [attachment('alice', 'driver')] });
    await redeem(
      h,
      socket,
      redemption(h.clock, minted, {
        requestId: 'bob-back',
        user: { userId: 'bob', displayName: 'Bob' },
        account: { kind: 'member', verified: true },
      }),
    );
    expect(decisions(socket).at(-1)).toMatchObject({ requestId: 'bob-back', allow: false });
  });

  it('closes an invite once the relay names more accounts revoked from it than it has uses', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mint(
      h,
      socket,
      { label: 'Everyone', role: 'observer', uses: MAX_INVITE_USES },
      listed,
    );
    const claimed = Array.from({ length: MAX_INVITE_USES + 1 }, (_, n) => `member${n}`);
    socket.deliver({
      t: 'roster',
      attachments: [
        attachment('alice', 'driver'),
        ...claimed.map((userId) =>
          invitedAttachment(userId, 'observer', minted.inviteId, h.clock.now + HOUR, userId),
        ),
      ],
    });
    for (const userId of claimed.slice(0, MAX_INVITE_USES)) {
      expect(h.dock.revoke(userId, { closeInvite: false })).toBe(true);
    }
    expect(socket.framesOf('invite_cancel')).toEqual([]);
    expect(storedInvites(h.storage)?.invites[0]?.barred).toHaveLength(MAX_INVITE_USES);
    // One more than it could ever have let in: the relay is making them up.
    expect(h.dock.revoke(claimed[MAX_INVITE_USES] ?? '', { closeInvite: false })).toBe(true);
    expect(socket.framesOf('invite_cancel')).toEqual([
      { t: 'invite_cancel', inviteId: minted.inviteId },
    ]);
    expect(h.dock.state.invites).toEqual([]);
    expect(h.storage.getItem(INVITES_KEY)).toBeNull();
  });

  it('Revoke all forgets every invite, settles a mint in flight as cancelled, and closes any a lying relay lists again', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mint(h, socket, { label: 'Friends', role: 'observer', uses: 3 }, listed);
    const pending = h.dock.invite({ label: 'Late', role: 'observer' });
    await until(() => socket.framesOf('invite_create').length === 2);
    expect(h.dock.revoke('*')).toBe(true);
    expect(await pending).toEqual({ ok: false, reason: 'cancelled' });
    expect(socket.framesOf('revoke')).toEqual([{ t: 'revoke', userId: '*' }]);
    // The relay's revoke '*' cancels them itself.
    expect(socket.framesOf('invite_cancel')).toEqual([]);
    expect(h.storage.getItem(INVITES_KEY)).toBeNull();
    socket.deliver(invitesFrame([listingOf(minted.create)]));
    expect(socket.framesOf('invite_cancel')).toEqual([
      { t: 'invite_cancel', inviteId: minted.inviteId },
    ]);
    await redeem(h, socket, redemption(h.clock, minted));
    expect(decisions(socket).at(-1)).toMatchObject({ allow: false });
  });

  it('Revoke all acts on live invites when nobody is attached', async () => {
    const h = setup({ core: { policy: { invites: 'all' } } });
    const socket = await link(h, {}, {});
    socket.deliver(invitesFrame([]));
    await mint(h, socket, { label: 'Friends', role: 'observer' });
    expect(h.dock.revoke('*')).toBe(true);
    expect(h.dock.state.invites).toEqual([]);
  });
});

describe("the page's invite records in storage (ADRs 0011 and 0017)", () => {
  it('survive a reload into a resumed session, and still honour the link', async () => {
    const storage = new MapStorage();
    const first = await offering({}, storage);
    const minted = await mint(
      first.h,
      first.socket,
      { label: 'Friends', role: 'observer', uses: 3 },
      first.listed,
    );
    first.h.core.close('unload');

    const h = setup({ storage, core: { policy: { invites: 'all' } } });
    const socket = await link(h, { resumed: true });
    socket.deliver(invitesFrame([listingOf(minted.create)]));
    expect(h.dock.state.invites.map((view) => view.inviteId)).toEqual([minted.inviteId]);
    await redeem(h, socket, redemption(h.clock, minted));
    expect(decisions(socket).at(-1)).toMatchObject({ allow: true, role: 'observer' });
  });

  it("honour no Can control link after a reload narrows the page's policy", async () => {
    const storage = new MapStorage();
    const first = await offering({}, storage);
    const minted = await mint(
      first.h,
      first.socket,
      { label: 'Help', role: 'driver' },
      first.listed,
    );
    first.h.core.close('unload');

    const h = setup({ storage, core: { policy: { invites: 'watch' } } });
    const socket = await link(h, { resumed: true });
    socket.deliver(invitesFrame([listingOf(minted.create)]));
    await redeem(h, socket, redemption(h.clock, minted));
    expect(h.dock.state.pendingRequests).toEqual([]);
    expect(decisions(socket).at(-1)).toMatchObject({ allow: false });
  });

  it('go with the grants when the relay does not resume the session', async () => {
    const storage = new MapStorage();
    const first = await offering({}, storage);
    const minted = await mint(
      first.h,
      first.socket,
      { label: 'Friends', role: 'observer' },
      first.listed,
    );
    first.h.core.close('unload');

    const h = setup({ storage, core: { policy: { invites: 'all' } } });
    const socket = await link(h, { resumed: false });
    expect(storage.getItem(INVITES_KEY)).toBeNull();
    socket.deliver(invitesFrame([]));
    await redeem(h, socket, redemption(h.clock, minted));
    expect(decisions(socket).at(-1)).toMatchObject({ allow: false });
  });

  it('read as none when malformed, when they hold a secret, or when they belong to another session', async () => {
    const good = {
      inviteId: 'inv_1',
      secretHash: 'a'.repeat(64),
      role: 'observer',
      label: 'Friends',
      uses: 1,
      usesLeft: 1,
      createdAt: 0,
      expiresAt: null,
      refusals: 0,
      barred: [],
    };
    for (const [stored, warns] of [
      [{ pageId: 'page-1', invites: [{ ...good, secret: 'A'.repeat(22) }] }, true],
      [{ pageId: 'page-1', invites: [{ ...good, secretHash: 'not hex' }] }, true],
      [{ pageId: 'page-1', invites: [{ ...good, role: 'driver', uses: 2, usesLeft: 2 }] }, true],
      [{ pageId: 'page-other', invites: [good] }, false],
    ] as const) {
      const storage = new MapStorage();
      storage.setItem(
        GRANTS_KEY,
        JSON.stringify({ pageId: 'page-1', grants: { alice: 'driver' } }),
      );
      storage.setItem(INVITES_KEY, JSON.stringify(stored));
      const h = setup({ storage, core: { policy: { invites: 'all' } } });
      const socket = await link(h, { resumed: true }, {});
      socket.deliver(
        invitesFrame([
          {
            ...good,
            usesLeft: 1,
            sponsor: { userId: 'alice', displayName: 'Alice' },
            pending: false,
            role: 'observer',
            uses: 1,
          },
        ]),
      );
      expect(h.dock.state.invites, JSON.stringify(stored)).toEqual([]);
      expect(h.logs.includes('warn ignored stored invites that did not parse')).toBe(warns);
    }
  });

  it('are dropped by a deliberate detach, with the grants', async () => {
    const { h, socket, listed } = await offering();
    await mint(h, socket, { label: 'Friends', role: 'observer' }, listed);
    h.dock.close();
    expect(h.storage.getItem(INVITES_KEY)).toBeNull();
    expect(h.storage.getItem(GRANTS_KEY)).toBeNull();
  });
});

describe('the real WebCrypto', () => {
  it("hashes exactly as the relay's digestHex does", async () => {
    const { h, socket } = await offering();
    const minted = await mint(h, socket, { label: 'Friends', role: 'observer' });
    expect(minted.create.secretHash).toBe(await sha256Hex(minted.secret));
    expect(minted.create.secretHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('a UI port answer counts only for the request it was asked about (S14)', () => {
  /**
   * A host dialog that resolves on a click and ignores its abort signal, as
   * a UI port may: it keeps every answer it was asked for, to give later.
   */
  function lateDialog(requestId: string) {
    const answers: ((answer: AttachAnswer) => void)[] = [];
    const ui: UiPort = {
      askAttach: (request) =>
        request.requestId === requestId
          ? new Promise<AttachAnswer>((resolve) => {
              answers.push(resolve);
            })
          : undefined,
    };
    return { ui, answers };
  }

  it('drops an answer given after its prompt expired, when the relay reused its id for a forged redemption', async () => {
    const dialog = lateDialog('R');
    const h = setup({ core: { policy: { invites: 'all' }, ui: dialog.ui } });
    const socket = await link(h);
    socket.deliver(invitesFrame([]));
    const minted = await mint(h, socket, { label: 'Help', role: 'driver' });
    // A code request that expires at once: the dialog is asked, and silence denies it.
    socket.deliver({ ...attachRequest(h.clock, 'R'), expiresAt: h.clock.now });
    await h.clock.advance(1);
    expect(dialog.answers).toHaveLength(1);
    expect(decisions(socket).at(-1)).toEqual({
      t: 'attach_decision',
      requestId: 'R',
      allow: false,
    });
    // The relay reuses R for a Can control redemption whose secret it never saw,
    // and the old dialog answers while that secret is still being hashed.
    socket.deliver(
      redemption(h.clock, minted, {
        requestId: 'R',
        invite: { inviteId: minted.inviteId, secret: 'Z'.repeat(22), label: 'Help' },
      }),
    );
    dialog.answers[0]?.('driver');
    await until(() => decisions(socket).length === 3, 'an answer to the forged redemption');
    await flush();
    expect(decisions(socket).slice(1)).toEqual([
      { t: 'attach_decision', requestId: 'R', allow: false },
      { t: 'attach_decision', requestId: 'R', allow: false },
    ]);
    expect(h.storage.getItem(GRANTS_KEY)).not.toContain(GUEST);
    expect(storedInvites(h.storage)?.invites[0]).toMatchObject({ usesLeft: 1, refusals: 0 });
    expect(h.logs).toContain(
      'warn ignored a UI port answer to an attach request that was already settled',
    );
    // And the guest a relay attached anyway runs nothing here.
    socket.deliver({
      t: 'roster',
      attachments: [
        attachment('alice', 'driver'),
        invitedAttachment(GUEST, 'driver', minted.inviteId, h.clock.now + HOUR),
      ],
    });
    socket.deliver(invoke('set_value', { callId: 'forged-write', caller: guestCaller() }));
    await flush();
    expect(codes(socket)).toEqual(['role_denied']);
  });

  it('never lets a stale answer decide a later request that reuses its id', async () => {
    const dialog = lateDialog('R');
    const h = setup({ core: { ui: dialog.ui } });
    const socket = await link(h);
    socket.deliver({ ...attachRequest(h.clock, 'R'), expiresAt: h.clock.now });
    await h.clock.advance(1);
    socket.deliver({
      ...attachRequest(h.clock, 'R'),
      user: { userId: 'carol', displayName: 'Carol' },
    });
    await flush();
    expect(dialog.answers).toHaveLength(2);
    // The answer about Bob, given late, is not an answer about Carol.
    dialog.answers[0]?.('driver');
    await flush();
    expect(decisions(socket).filter((frame) => frame.requestId === 'R')).toEqual([
      { t: 'attach_decision', requestId: 'R', allow: false },
    ]);
    expect(h.dock.state.pendingRequests.map((request) => request.user.userId)).toEqual(['carol']);
    // Carol's own answer still counts.
    dialog.answers[1]?.('observer');
    await flush();
    expect(decisions(socket).at(-1)).toEqual({
      t: 'attach_decision',
      requestId: 'R',
      allow: true,
      role: 'observer',
    });
  });
});

describe("the joins this page honoured, which the widget's notice reads (ADR 0016)", () => {
  it('records a join only for a redemption it honoured, with the label from its own record', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mint(h, socket, { label: 'Friends', role: 'observer', uses: 3 }, listed);
    await redeem(
      h,
      socket,
      redemption(h.clock, minted, {
        requestId: 'forged',
        invite: { inviteId: minted.inviteId, secret: 'F'.repeat(22), label: 'Friends' },
      }),
    );
    // A lying relay lists someone the page never let in, as a driver by the invite.
    socket.deliver({
      t: 'roster',
      attachments: [
        attachment('alice', 'driver'),
        invitedAttachment(OTHER_GUEST, 'driver', minted.inviteId, h.clock.now + HOUR),
      ],
    });
    expect(h.dock.state.joins).toEqual([]);
    expect(h.dock.state.pageRoles[1]).toMatchObject({ userId: OTHER_GUEST, role: null });

    await redeem(h, socket, redemption(h.clock, minted));
    expect(h.dock.state.joins).toEqual([
      {
        seq: 1,
        user: { userId: GUEST, displayName: 'guest@example.com' },
        account: { kind: 'invitee', verified: true },
        inviteId: minted.inviteId,
        label: 'Friends',
        time: h.clock.now,
      },
    ]);
  });

  it('forgets a join with its grant: on revoke, and when the relay drops them', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mint(h, socket, { label: 'Friends', role: 'observer', uses: 3 }, listed);
    await redeem(h, socket, redemption(h.clock, minted));
    await redeem(
      h,
      socket,
      redemption(h.clock, minted, {
        requestId: 'other',
        user: { userId: OTHER_GUEST, displayName: 'other@example.com' },
      }),
    );
    expect(h.dock.state.joins.map((join) => [join.seq, join.user.userId])).toEqual([
      [2, OTHER_GUEST],
      [1, GUEST],
    ]);
    socket.deliver({
      t: 'roster',
      attachments: [
        attachment('alice', 'driver'),
        invitedAttachment(GUEST, 'observer', minted.inviteId, h.clock.now + HOUR),
        invitedAttachment(OTHER_GUEST, 'observer', minted.inviteId, h.clock.now + HOUR),
      ],
    });
    h.dock.revoke(GUEST, { closeInvite: false });
    expect(h.dock.state.joins.map((join) => join.user.userId)).toEqual([OTHER_GUEST]);
    socket.deliver({ t: 'roster', attachments: [attachment('alice', 'driver')] });
    expect(h.dock.state.joins).toEqual([]);
  });
});

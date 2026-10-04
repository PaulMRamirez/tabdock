// The adapter's M4 interfaces (ADR 0017): stored grants as { role, inviteId?,
// endsAt?, inviteRole? } with the bare role an older adapter stored still
// read; an attach request's account and invite, never its presented secret;
// the invites frame; the live list and Cancel, empty and refusing until a
// relay offers invites; Revoke's closeInvite option; and dock.invite()'s
// checks of its options and the page's policy, and its answer when no relay
// offers invites. invite-records.test.ts covers minting and honouring.

import { describe, expect, it } from 'vitest';
import { INVITE_LIFETIMES, type InviteOptions } from '../src/core.ts';
import {
  attachment,
  attachRequest,
  flush,
  GRANTS_KEY,
  GUEST,
  invitesFrame,
  invoke,
  link,
  LINK_BASE,
  MapStorage,
  mint,
  redemption,
  results,
  setup,
  SPONSOR,
  until,
} from './harness.ts';

const caller = (userId: string, role: 'driver' | 'observer' = 'driver') => ({
  userId,
  displayName: userId,
  client: null,
  role,
});

const codes = (socket: Awaited<ReturnType<typeof link>>) =>
  results(socket).map((frame) => frame.error?.code ?? 'ok');

function storedGrants(storage: MapStorage): unknown {
  return JSON.parse(storage.getItem(GRANTS_KEY) ?? 'null') as unknown;
}

describe('stored grants from M4 (ADRs 0011 and 0017)', () => {
  it('reads the bare role an older adapter stored, and stores { role } from then on', async () => {
    const storage = new MapStorage();
    storage.setItem(GRANTS_KEY, JSON.stringify({ pageId: 'page-1', grants: { bob: 'driver' } }));
    const h = setup({ storage });
    const socket = await link(h, { resumed: true, roster: [attachment('bob', 'driver')] }, {});
    socket.deliver(invoke('set_value', { caller: caller('bob') }));
    await flush();
    expect(codes(socket)).toEqual(['ok']);
    expect(storedGrants(storage)).toEqual({
      pageId: 'page-1',
      grants: { bob: { role: 'driver' } },
    });
  });

  it("keeps an invite-made grant's invite, end and cap across a reload and a role change", async () => {
    const storage = new MapStorage();
    // An invite-made grant ends 24 hours after redemption; this one has 12 to go.
    const invited = {
      role: 'observer',
      inviteId: 'inv_1',
      endsAt: Date.UTC(2026, 9, 3),
      inviteRole: 'observer',
    };
    storage.setItem(GRANTS_KEY, JSON.stringify({ pageId: 'page-1', grants: { bob: invited } }));
    const h = setup({ storage });
    const socket = await link(h, { resumed: true, roster: [attachment('bob', 'observer')] }, {});
    expect(storedGrants(storage)).toEqual({ pageId: 'page-1', grants: { bob: invited } });
    socket.deliver(invoke('get_value', { caller: caller('bob', 'observer') }));
    await flush();
    expect(codes(socket)).toEqual(['ok']);
    expect(h.dock.setRole('bob', 'observer')).toBe(true);
    expect(storedGrants(storage)).toEqual({ pageId: 'page-1', grants: { bob: invited } });
  });

  it('reads a malformed grant of either shape as no grants at all', async () => {
    for (const bad of [
      { role: 'driver', extra: 1 },
      { role: 'admin' },
      { inviteId: 'inv_1' },
      // An invite-made grant without its cap, or above it, is no grant (ADR 0017).
      { role: 'observer', inviteId: 'inv_1', endsAt: 1 },
      { role: 'driver', inviteId: 'inv_1', endsAt: 1, inviteRole: 'observer' },
    ]) {
      const storage = new MapStorage();
      storage.setItem(
        GRANTS_KEY,
        JSON.stringify({ pageId: 'page-1', grants: { bob: bad, carol: 'observer' } }),
      );
      const h = setup({ storage });
      const socket = await link(
        h,
        { resumed: true, roster: [attachment('bob', 'driver'), attachment('carol', 'observer')] },
        {},
      );
      socket.deliver(invoke('get_value', { caller: caller('carol', 'observer') }));
      await flush();
      expect(codes(socket), JSON.stringify(bad)).toEqual(['role_denied']);
      expect(h.logs).toContain('warn ignored stored grants that did not parse');
    }
  });
});

describe('attach requests from M4', () => {
  it('show the account and the invite of a Can control redemption, and never its secret', async () => {
    const h = setup({ core: { policy: { invites: 'all' } } });
    const socket = await link(h);
    socket.deliver(invitesFrame([]));
    const minted = await mint(h, socket, { label: 'Friends', role: 'driver' });
    socket.deliver({
      ...redemption(h.clock, minted),
      user: { userId: GUEST, displayName: 'guest@example.com' },
      account: { kind: 'invitee', verified: true },
    });
    await until(() => h.dock.state.pendingRequests.length === 1, 'the prompt');
    expect(h.dock.state.pendingRequests).toMatchObject([
      {
        user: { userId: GUEST },
        account: { kind: 'invitee', verified: true },
        via: 'invite',
        invite: { inviteId: minted.inviteId, label: 'Friends' },
      },
    ]);
    expect(JSON.stringify(h.dock.state)).not.toContain(minted.secret);
    expect(h.logs.join('\n')).not.toContain(minted.secret);
    // Nor the email, which belongs on the operator's screen and in no log (ADR 0020).
    expect(h.logs.join('\n')).not.toContain('guest@example.com');
  });

  it('show a code request as from a verified member with no invite', async () => {
    const h = setup();
    const socket = await link(h);
    socket.deliver(attachRequest(h.clock));
    expect(h.dock.state.pendingRequests).toMatchObject([
      { account: { kind: 'member', verified: true }, via: 'code', invite: null },
    ]);
  });
});

describe('an invites frame', () => {
  it('offers invites at its link base, lists only what the page minted, and leaves the link up', async () => {
    const h = setup();
    const socket = await link(h);
    socket.deliver(
      invitesFrame(
        [
          {
            inviteId: 'inv_1',
            role: 'observer',
            label: 'Not ours',
            uses: 1,
            usesLeft: 1,
            expiresAt: null,
            sponsor: SPONSOR,
            pending: false,
            refusals: 0,
          },
        ],
        { refused: { inviteId: 'inv_2', reason: 'no_sponsor' } },
      ),
    );
    await flush();
    expect(h.dock.state).toMatchObject({
      link: 'linked',
      invites: [],
      invitesOffered: { linkBase: LINK_BASE },
    });
    // An invite this page holds no record of can never be honoured here, so it is closed.
    expect(socket.framesOf('invite_cancel')).toEqual([{ t: 'invite_cancel', inviteId: 'inv_1' }]);
    expect(socket.closedWith).toBeNull();
  });
});

describe('the live list, Cancel and Revoke from M4 (ADR 0017)', () => {
  it('start empty, with no invites offered until a relay with invites on says so', async () => {
    const h = setup();
    expect(h.dock.state).toMatchObject({ invites: [], invitesOffered: null });
    await link(h);
    expect(h.dock.state).toMatchObject({ invites: [], invitesOffered: null });
  });

  it('cancel nothing the page does not list, and send nothing', async () => {
    const h = setup({ core: { policy: { invites: 'all' } } });
    const socket = await link(h);
    expect(h.dock.cancelInvite('inv_1')).toBe(false);
    expect(socket.framesOf('invite_cancel')).toEqual([]);
  });

  it('revoke as before with closeInvite, which has no link to close before invites exist', async () => {
    const h = setup();
    const socket = await link(h, { roster: [attachment('bob', 'driver')] }, {});
    expect(h.dock.revoke('bob', { closeInvite: true })).toBe(true);
    expect(socket.framesOf('revoke')).toEqual([{ t: 'revoke', userId: 'bob' }]);
    expect(socket.framesOf('invite_cancel')).toEqual([]);
  });
});

describe('dock.invite() (ADR 0017)', () => {
  const watch: InviteOptions = { label: 'Friends', role: 'observer' };

  it.each([
    ['an empty label', { ...watch, label: '' }],
    ['a label over 60 characters', { ...watch, label: 'x'.repeat(61) }],
    ['a role that is not one', { ...watch, role: 'admin' }],
    ['a lifetime that is not one', { ...watch, lifetime: 'week' }],
    ['no uses', { ...watch, uses: 0 }],
    ['more than 20 uses', { ...watch, uses: 21 }],
    ['a fraction of a use', { ...watch, uses: 1.5 }],
    ['uses as text', { ...watch, uses: '2' }],
    ['a control invite with two uses', { label: 'Help', role: 'driver', uses: 2 }],
  ])('refuses %s as invalid', async (_name, options) => {
    const h = setup({ core: { policy: { invites: 'all' } } });
    await link(h);
    expect(await h.dock.invite(options as InviteOptions)).toEqual({ ok: false, reason: 'invalid' });
  });

  it("refuses what the page's policy forbids: control unless 'all', anything under 'off'", async () => {
    const byDefault = setup();
    await link(byDefault);
    expect(await byDefault.dock.invite({ label: 'Help', role: 'driver' })).toEqual({
      ok: false,
      reason: 'policy',
    });
    const off = setup({ core: { policy: { invites: 'off' } } });
    await link(off);
    expect(await off.dock.invite(watch)).toEqual({ ok: false, reason: 'policy' });
  });

  it('refuses while the link is down', async () => {
    const h = setup();
    expect(await h.dock.invite(watch)).toEqual({ ok: false, reason: 'link_down' });
  });

  it('answers unavailable from a relay that offers no invites, and sends it nothing', async () => {
    const h = setup({ core: { policy: { invites: 'all' } } });
    const socket = await link(h);
    for (const lifetime of INVITE_LIFETIMES) {
      expect(await h.dock.invite({ ...watch, lifetime, uses: 20 })).toEqual({
        ok: false,
        reason: 'unavailable',
      });
    }
    expect(await h.dock.invite({ label: 'Help', role: 'driver', uses: 1 })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(socket.framesOf('invite_create')).toEqual([]);
    expect(Object.isFrozen(await h.dock.invite(watch))).toBe(true);
  });
});

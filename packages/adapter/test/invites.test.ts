// The adapter's M4 interfaces (ADR 0017) before workstream B builds on them:
// stored grants as { role, inviteId?, endsAt?, inviteRole? } with the bare
// role an older adapter stored still read; an attach request's account and
// invite, never its presented secret; the invites frame, which nothing acts on
// yet; the live list and Cancel, empty and refusing until a relay offers
// invites; Revoke's closeInvite option; and dock.invite(), which checks its
// options and the page's policy and then, with no relay offering invites,
// answers unavailable.

import { describe, expect, it } from 'vitest';
import { INVITE_LIFETIMES, type InviteOptions } from '../src/core.ts';
import {
  attachment,
  attachRequest,
  flush,
  GRANTS_KEY,
  invoke,
  link,
  MapStorage,
  results,
  setup,
} from './harness.ts';

const SECRET = 'AbCdEfGhIjKlMnOpQrStU_';
const GUEST = `g_${'0'.repeat(32)}`;

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
    const invited = {
      role: 'observer',
      inviteId: 'inv_1',
      endsAt: 86_400_000,
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
  it('show the account and the invite, and never the secret the relay presented', async () => {
    const h = setup();
    const socket = await link(h);
    socket.deliver({
      ...attachRequest(h.clock),
      user: { userId: GUEST, displayName: 'guest@example.com' },
      account: { kind: 'invitee', verified: true },
      via: 'invite',
      invite: { inviteId: 'inv_1', secret: SECRET, label: 'Friends' },
    });
    expect(h.dock.state.pendingRequests).toMatchObject([
      {
        user: { userId: GUEST },
        account: { kind: 'invitee', verified: true },
        via: 'invite',
        invite: { inviteId: 'inv_1', label: 'Friends' },
      },
    ]);
    expect(JSON.stringify(h.dock.state)).not.toContain(SECRET);
    expect(h.logs.join('\n')).not.toContain(SECRET);
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
  it('changes nothing yet, and leaves the link up', async () => {
    const h = setup();
    const socket = await link(h);
    const before = h.dock.state;
    socket.deliver({
      t: 'invites',
      linkBase: 'https://relay.example/i',
      invites: [],
      refused: { inviteId: 'inv_1', reason: 'no_sponsor' },
    });
    await flush();
    expect(h.dock.state).toBe(before);
    expect(h.dock.state).toMatchObject({ link: 'linked', invites: [], invitesOffered: null });
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

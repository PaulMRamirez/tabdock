// What the M6 foundation builds in full on the page's side (plan section
// 2.6), before any wave fills a seam: the handle's state starts with every M6
// field at rest, the page's own policy fields are shown as a copy, the seat
// numbers come from each welcome within the protocol's ceilings and go with
// the link, the relay's new frames never cost the page its link, and a detach
// leaves no stored session or agent token record behind.

import { MAX_OBSERVERS_PER_PAGE, MAX_USERS_PER_PAGE } from '@tabdock/protocol';
import { describe, expect, it } from 'vitest';
import { flush, link, setup, welcome } from './harness.ts';

// Written out, as harness.ts writes the M4 keys, so a change to how records are keyed shows here.
const SESSION_KEY = 'tabdock:session:["ws://relay.test/page","http://127.0.0.1:5173/board"]';
const AGENTS_KEY = 'tabdock:agents:["ws://relay.test/page","http://127.0.0.1:5173/board"]';

describe('the M6 state fields', () => {
  it('start at rest', () => {
    const h = setup();
    expect(h.dock.state).toMatchObject({
      published: 'none',
      maxImageBytes: null,
      proposals: [],
      proposalLog: [],
      session: null,
      sessionsOffered: false,
      sessionEnded: null,
      agents: [],
      agentsOffered: null,
      seatLimits: null,
      records: [],
    });
  });

  it("show the page's image tools and proposal policy as a copy, which changes nothing it sends", async () => {
    const h = setup({ core: { policy: { imageTools: ['get_value'], proposals: 'members' } } });
    const shown = h.dock.state.policy;
    expect(shown).toMatchObject({ imageTools: ['get_value'], proposals: 'members' });
    // A page script that edits what the handle shows must not widen what the relay is told.
    shown.imageTools.push('wipe');
    await link(h, {}, {});
    expect(h.socket().framesOf('hello')[0]?.policy).toMatchObject({
      imageTools: ['get_value'],
      proposals: 'members',
    });
  });
});

describe('the seat numbers (ADR 0044)', () => {
  async function seatsAfter(extra: Record<string, number>) {
    const h = setup();
    const limits = { ...welcome(h.clock).limits, ...extra };
    await link(h, { limits }, {});
    expect(h.dock.state.link).toBe('linked');
    return h.dock.state.seatLimits;
  }

  it("come from the welcome's people limit and watching seats", async () => {
    expect(await seatsAfter({ usersPerPage: 10, observersPerPage: 40 })).toEqual({
      usersPerPage: 10,
      observersPerPage: 40,
    });
    expect(await seatsAfter({ usersPerPage: 10 })).toEqual({
      usersPerPage: 10,
      observersPerPage: 0,
    });
  });

  it('are none from a relay that sends no people limit, as a 0.1.0 relay does', async () => {
    expect(await seatsAfter({})).toBeNull();
    expect(await seatsAfter({ observersPerPage: 40 })).toBeNull();
  });

  it("keep a relay's numbers within the protocol's ceilings rather than dropping the link", async () => {
    expect(await seatsAfter({ usersPerPage: 1_000_000, observersPerPage: 1_000_000 })).toEqual({
      usersPerPage: MAX_USERS_PER_PAGE,
      observersPerPage: MAX_OBSERVERS_PER_PAGE,
    });
  });

  it('go with the link, until the next welcome says again', async () => {
    const h = setup();
    const limits = { ...welcome(h.clock).limits, usersPerPage: 10, observersPerPage: 40 };
    await link(h, { limits }, {});
    h.socket().drop();
    expect(h.dock.state.link).toBe('reconnecting');
    expect(h.dock.state.seatLimits).toBeNull();
  });
});

describe("the relay's M6 frames", () => {
  it('never cost the page its link', async () => {
    const h = setup();
    const socket = await link(h, {}, {});
    socket.deliver({
      t: 'proposal',
      proposalId: 'prop-1',
      tool: 'set_value',
      arguments: { value: 1 },
      proposer: { userId: 'bob', displayName: 'Bob', role: 'observer', client: null },
      expiresAt: h.clock.now + 600_000,
    });
    socket.deliver({ t: 'proposal_end', proposalId: 'prop-1', reason: 'withdrawn' });
    socket.deliver({ t: 'session', session: null });
    socket.deliver({ t: 'agents', endpoint: null, agents: [] });
    await flush();
    expect(h.dock.state.link).toBe('linked');
    expect(socket.closedWith).toBeNull();
  });
});

describe('a detach', () => {
  it('leaves no stored session or agent token record', async () => {
    const h = setup();
    h.storage.setItem(SESSION_KEY, '{}');
    h.storage.setItem(AGENTS_KEY, '{}');
    await link(h);
    h.dock.close();
    expect(h.storage.getItem(SESSION_KEY)).toBeNull();
    expect(h.storage.getItem(AGENTS_KEY)).toBeNull();
  });
});

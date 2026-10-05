// The invitee tier (ADRs 0016 and 0017) with dev-token invitees, which the ADR
// allows outside public mode so these need no provider: with invites on an
// account off the allowlist is admitted, sees only the pages it holds, pairs
// only by invite, holds one session until it holds an attachment and shares a
// small pool evicted first; every user has a request budget before the access
// check (S9, ADR 0018), never per address; and the refusal budget keeps
// strangers from flooding the audit log while a call that reaches a page is
// always written (S7, ADR 0019).

import type { Client } from '@modelcontextprotocol/client';
import { AuditEventSchema } from '@tabdock/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AttachmentRecord,
  AuditRefusalBudget,
  callRecords,
  createDevTokenAuth,
  createMemoryStore,
  type DevTokenUser,
  MAX_STRANGERS_COUNTED,
  type RelayStore,
} from '../src/index.ts';
import { connectPage, type TestPage, TOOLS } from './helpers/page-client.ts';
import {
  initializeBody,
  openSession,
  openStream,
  type OpenStream,
  rawCall,
  rawPost,
} from './helpers/raw-mcp.ts';
import {
  ALICE,
  BOB,
  callTool,
  connectClient,
  pairAndApprove,
  startRelay,
  type TestRelay,
} from './helpers/relay.ts';

function guest(n: number): DevTokenUser {
  const hex = n.toString(16).padStart(32, '0');
  return {
    userId: `g_${hex}`,
    displayName: 'ignored',
    token: `guest-${String(n)}-dev-token-5a8c1e7f2b9d4063`,
    kind: 'invitee',
  };
}
const G1 = guest(1);
const G2 = guest(2);
const G3 = guest(3);
const G4 = guest(4);
const G5 = guest(5);

let current: TestRelay | undefined;
const pages: TestPage[] = [];
const clients: Client[] = [];
const streams: OpenStream[] = [];

afterEach(async () => {
  for (const opened of streams.splice(0)) opened.close();
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const opened of pages.splice(0)) opened.ws.terminate();
  await current?.close();
  current = undefined;
});

async function setup(
  options: Parameters<typeof startRelay>[0] = {},
  users: DevTokenUser[] = [ALICE, BOB, G1, G2, G3, G4, G5],
): Promise<TestRelay> {
  current = await startRelay({ auth: createDevTokenAuth(users), invites: true, ...options });
  return current;
}

async function client(user: DevTokenUser): Promise<Client> {
  if (!current) throw new Error('no relay');
  const connected = await connectClient(current.relay, user);
  clients.push(connected);
  return connected;
}

async function page(): Promise<TestPage> {
  if (!current) throw new Error('no relay');
  const opened = await connectPage(current.relay.pageUrl, {
    tools: TOOLS,
    onInvoke: () => ({ ok: true, content: '{}' }),
  });
  pages.push(opened);
  return opened;
}

/** An attachment as an invite would have made it, put straight into the store. */
function heldBy(store: RelayStore, user: DevTokenUser, pageId: string): void {
  const attachment: AttachmentRecord = {
    pageId,
    userId: user.userId,
    displayName: 'unverified account',
    kind: 'invitee',
    role: 'observer',
    grantedAt: Date.now(),
    lastUsedAt: null,
    expiresAt: null,
    clients: [],
    inviteId: 'inv_held',
    endsAt: Date.now() + 60 * 60_000,
    inviteRole: 'observer',
    sponsorId: 'alice',
    emailHash: null,
  };
  store.attachments.put(attachment);
}

describe('an invitee with invites on (ADR 0016)', () => {
  it('is admitted, named as unverified, and sees only the pages it holds (S13)', async () => {
    await setup();
    const opened = await page();
    const alice = await client(ALICE);
    await pairAndApprove(alice, opened);
    const g1 = await client(G1);
    expect((await callTool(g1, 'list_pages')).structured).toEqual({ pages: [] });
    for (const [tool, args] of [
      ['list_page_tools', { page: opened.pageId }],
      ['call_page_tool', { page: opened.pageId, tool: 'get_view' }],
      ['detach_page', { page: opened.pageId }],
    ] as const) {
      expect((await callTool(g1, tool, args)).text, tool).toMatch(/^not_attached: /);
    }
    await opened.sync();
    expect(opened.all('invoke')).toEqual([]);
  });

  it('answers its pairing code with invite_required, so the code is neither spent nor rotated', async () => {
    const { relay } = await setup();
    const opened = await page();
    const code = opened.code;
    const g1 = await client(G1);
    expect((await callTool(g1, 'pair_page', { code })).text).toMatch(/^invite_required: /);
    await opened.sync();
    expect(opened.all('pairing')).toEqual([]);
    expect(opened.all('attach_request')).toEqual([]);
    // A member's pairing still uses the very same code.
    await pairAndApprove(await client(ALICE), opened);
    expect(relay.audit.events()).toContainEqual(
      expect.objectContaining({
        type: 'attach_refused',
        userId: G1.userId,
        kind: 'invitee',
        via: 'code',
        outcome: 'invite_required',
        pageId: null,
      }),
    );
  });

  it('gets the five fixed tools and never the spike marker', async () => {
    const { relay } = await setup({ spike: true });
    relay.spike?.addMarker();
    const names = async (who: Client) =>
      (await who.listTools()).tools.map((tool) => tool.name).sort();
    expect(await names(await client(G1))).toEqual([
      'call_page_tool',
      'detach_page',
      'list_page_tools',
      'list_pages',
      'pair_page',
    ]);
    expect((await names(await client(ALICE))).length).toBe(6);
  });

  it('gets 403 with invites off, as in M3', async () => {
    await setup({ invites: false }, [ALICE, G1]);
    const answer = await fetch(current?.relay.mcpUrl ?? '', {
      method: 'POST',
      headers: { Authorization: `Bearer ${G1.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(answer.status).toBe(403);
    expect(await answer.text()).toBe('This account is not allowed on this relay');
  });
});

describe("the invitee tier's sessions (ADR 0016)", () => {
  it('holds one session until it holds an attachment, then sessionsPerInvitee', async () => {
    const store = createMemoryStore();
    const { relay } = await setup({ store, timings: { sseKeepAliveMs: 50 } });
    const first = await openSession(relay, G1);
    const busy = await openStream(relay, G1, first);
    streams.push(busy);
    // The one session is busy, so a second is refused rather than evicting it.
    const refused = await fetch(relay.mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${G1.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'second', version: '1' },
        },
      }),
    });
    expect(refused.status).toBe(429);
    await refused.body?.cancel();
    // Once it holds an attachment, a second fits beside the first.
    heldBy(store, G1, 'pg_HELD000000');
    const second = await openSession(relay, G1);
    expect((await rawCall(relay, G1, first, 'list_pages')).status).toBe(200);
    expect((await rawCall(relay, G1, second, 'list_pages')).status).toBe(200);
  });

  it('shares a pool of its own, whose idlest session makes room first', async () => {
    const { relay } = await setup({ limits: { inviteeSessions: 2 } });
    const one = await openSession(relay, G1);
    const two = await openSession(relay, G2);
    const three = await openSession(relay, G3);
    expect((await rawCall(relay, G1, one, 'list_pages')).status).toBe(404);
    expect((await rawCall(relay, G2, two, 'list_pages')).status).toBe(200);
    expect((await rawCall(relay, G3, three, 'list_pages')).status).toBe(200);
    // Members are not in the invitee pool at all.
    for (let i = 0; i < 3; i += 1) await openSession(relay, ALICE);
  });

  it('goes first when the relay is full, so members are not refused for strangers', async () => {
    const { relay } = await setup({ limits: { sessions: 3 } });
    const strangers = [await openSession(relay, G1), await openSession(relay, G2)];
    const alice = await openSession(relay, ALICE);
    const bob = await openSession(relay, BOB);
    expect((await rawCall(relay, ALICE, alice, 'list_pages')).status).toBe(200);
    expect((await rawCall(relay, BOB, bob, 'list_pages')).status).toBe(200);
    const left = await Promise.all(
      strangers.map(
        async (id, index) => (await rawCall(relay, [G1, G2][index] ?? G1, id, 'list_pages')).status,
      ),
    );
    expect(left.filter((status) => status === 200)).toHaveLength(1);
  });

  // A4.3: a 2025-era session whose listening GET stream stays open is never
  // idle, so strangers holding such streams used to fill the pool and keep
  // out the guests the operator let in, who share it.
  it('lets in a guest when busy strangers fill the pool, closing the session of the stranger idle longest', async () => {
    const store = createMemoryStore();
    const { relay } = await setup({
      store,
      limits: { inviteeSessions: 3 },
      timings: { sseKeepAliveMs: 50 },
    });
    const strangers = [G1, G2, G3];
    const ids: string[] = [];
    const held: OpenStream[] = [];
    for (const stranger of strangers) {
      const id = await openSession(relay, stranger);
      const stream = await openStream(relay, stranger, id);
      streams.push(stream);
      held.push(stream);
      ids.push(id);
    }
    heldBy(store, G4, 'pg_HELD000000');
    const guestSession = await openSession(relay, G4);
    expect((await rawCall(relay, G4, guestSession, 'list_pages')).status).toBe(200);
    // G1's session was the one active longest ago: closed, its stream ended.
    await held[0]?.ended;
    expect((await rawCall(relay, G1, ids[0] ?? '', 'list_pages')).status).toBe(404);
    expect((await rawCall(relay, G2, ids[1] ?? '', 'list_pages')).status).toBe(200);
    expect((await rawCall(relay, G3, ids[2] ?? '', 'list_pages')).status).toBe(200);

    // A stranger pushes out neither a guest nor a stranger's busy session.
    const refused = await rawPost(relay, G5, initializeBody());
    expect(refused.status).toBe(503);
    await refused.body?.cancel();
    expect((await rawCall(relay, G4, guestSession, 'list_pages')).status).toBe(200);
    // Members are not in the pool at all.
    await openSession(relay, ALICE);
  });

  it('never closes a guest session for a stranger when the relay is full, and a guest takes a stranger place', async () => {
    const store = createMemoryStore();
    const { relay } = await setup({
      store,
      limits: { sessions: 3 },
      timings: { sseKeepAliveMs: 50 },
    });
    heldBy(store, G4, 'pg_HELD000000');
    // The guest's session is the one active longest ago, and busy.
    const guestSession = await openSession(relay, G4);
    streams.push(await openStream(relay, G4, guestSession));
    const strangerSession = await openSession(relay, G1);
    streams.push(await openStream(relay, G1, strangerSession));
    const aliceSession = await openSession(relay, ALICE);

    const refused = await rawPost(relay, G2, initializeBody());
    expect(refused.status).toBe(503);
    await refused.body?.cancel();
    expect((await rawCall(relay, G4, guestSession, 'list_pages')).status).toBe(200);
    expect((await rawCall(relay, G1, strangerSession, 'list_pages')).status).toBe(200);

    // A second guest takes the stranger's place, busy or not, and never the first guest's.
    heldBy(store, G5, 'pg_HELD000000');
    const second = await openSession(relay, G5);
    expect((await rawCall(relay, G5, second, 'list_pages')).status).toBe(200);
    expect((await rawCall(relay, G1, strangerSession, 'list_pages')).status).toBe(404);
    expect((await rawCall(relay, G4, guestSession, 'list_pages')).status).toBe(200);
    expect((await rawCall(relay, ALICE, aliceSession, 'list_pages')).status).toBe(200);
  });
});

describe('the request budget (S9, ADR 0018)', () => {
  it('refuses past it before the access check, per user and never per address', async () => {
    const { relay } = await setup({ rateLimits: { requestsPerUser: 4, requestsPerInvitee: 2 } });
    const g1 = await client(G1);
    const g2 = await client(G2);
    const alice = await client(ALICE);
    for (let i = 0; i < 2; i += 1) {
      expect((await callTool(g1, 'list_pages')).isError).toBe(false);
    }
    // Past the budget even a request for a page it does not hold is rate_limited, not not_attached.
    expect((await callTool(g1, 'list_page_tools', { page: 'pg_NOPE000000' })).text).toBe(
      'rate_limited: more than 2 requests to this relay in 1 minute; wait and try again',
    );
    expect(
      (await callTool(g1, 'call_page_tool', { page: 'pg_NOPE000000', tool: 'x' })).text,
    ).toMatch(/^rate_limited: /);
    expect((await callTool(g1, 'pair_page', { code: 'ABCDE-12345' })).text).toMatch(
      /^rate_limited: /,
    );
    expect((await callTool(g1, 'detach_page', { page: 'pg_NOPE000000' })).text).toMatch(
      /^rate_limited: /,
    );
    expect((await callTool(g1, 'list_pages')).text).toMatch(/^rate_limited: /);
    // Another invitee on the same address, and a member, have budgets of their own.
    expect((await callTool(g2, 'list_pages')).isError).toBe(false);
    for (let i = 0; i < 4; i += 1)
      expect((await callTool(alice, 'list_pages')).isError).toBe(false);
    expect((await callTool(alice, 'list_pages')).text).toBe(
      'rate_limited: more than 4 requests to this relay in 1 minute; wait and try again',
    );
    const refused = relay.audit
      .events()
      .filter((event) => 'userId' in event && event.userId === G1.userId);
    for (const event of refused) expect(AuditEventSchema.parse(event)).toEqual(event);
    expect(refused.map((event) => event.type)).toEqual([
      'request_refused',
      'call',
      'attach_refused',
      'request_refused',
      'request_refused',
    ]);
    expect(refused).toContainEqual(
      expect.objectContaining({ type: 'request_refused', tool: 'list_pages', pageId: null }),
    );
    expect(refused).toContainEqual(
      expect.objectContaining({ type: 'call', outcome: 'rate_limited', tool: 'x' }),
    );
    expect(refused).toContainEqual(
      expect.objectContaining({ type: 'attach_refused', via: 'code', outcome: 'rate_limited' }),
    );
  });

  it('counts a call whose arguments fail the tool schema, which the SDK would otherwise answer for free', async () => {
    const { relay } = await setup({ rateLimits: { requestsPerUser: 3, requestsPerInvitee: 2 } });
    const g1 = await client(G1);
    // Each fails the schema clients are shown, and is still answered as a tool error.
    expect((await callTool(g1, 'list_page_tools', { page: 'p'.repeat(101) })).text).toMatch(
      /^invalid_arguments: /,
    );
    expect((await callTool(g1, 'pair_page', { code: 'C'.repeat(65) })).text).toMatch(
      /^invalid_arguments: /,
    );
    // Both counted, so the budget of 2 is spent.
    expect((await callTool(g1, 'list_pages')).text).toMatch(/^rate_limited: /);
    // Past it, a call with bad arguments is refused like any other, with its own record.
    expect((await callTool(g1, 'call_page_tool', { page: 7, tool: 'x' })).text).toMatch(
      /^rate_limited: /,
    );
    expect((await callTool(g1, 'pair_page', { invite: 'i'.repeat(301) })).text).toMatch(
      /^rate_limited: /,
    );
    const alice = await client(ALICE);
    for (let i = 0; i < 2; i += 1) {
      expect((await callTool(alice, 'detach_page', { page: '' })).text).toMatch(
        /^invalid_arguments: /,
      );
    }
    // A malformed call is still a call refused before any page, with a line of its own (S7).
    const long = { page: 'p'.repeat(101), tool: 'get_view' };
    expect((await callTool(alice, 'call_page_tool', long)).text).toMatch(/^invalid_arguments: /);
    expect((await callTool(alice, 'list_pages')).text).toMatch(/^rate_limited: /);
    const recordsOf = (user: DevTokenUser) =>
      relay.audit.events().filter((event) => 'userId' in event && event.userId === user.userId);
    for (const event of relay.audit.events()) expect(AuditEventSchema.parse(event)).toEqual(event);
    expect(recordsOf(G1)).toEqual([
      expect.objectContaining({ type: 'request_refused', tool: 'list_pages' }),
      expect.objectContaining({
        type: 'call',
        pageId: '(invalid, 0 chars)',
        tool: 'x',
        outcome: 'rate_limited',
      }),
      expect.objectContaining({ type: 'attach_refused', via: 'invite', outcome: 'rate_limited' }),
    ]);
    expect(recordsOf(ALICE)).toEqual([
      expect.objectContaining({
        type: 'call',
        pageId: '(invalid, 101 chars)',
        tool: 'get_view',
        outcome: 'invalid_arguments',
      }),
      expect.objectContaining({ type: 'request_refused', tool: 'list_pages' }),
    ]);
  });
});

describe('the refusal budget in front of the audit log (S7, ADR 0019)', () => {
  it('writes strangers a line each within 10 a user and 30 among them, then one relay-wide summary', async () => {
    const { relay } = await setup();
    const strangers = [G1, G2, G3, G4];
    for (const stranger of strangers) {
      const who = await client(stranger);
      for (let i = 0; i < 12; i += 1) {
        await callTool(who, 'call_page_tool', { page: 'pg_NOPE000000', tool: 'get_view' });
      }
    }
    await relay.close();
    const events = relay.audit.events();
    for (const event of events) expect(AuditEventSchema.parse(event)).toEqual(event);
    const lines = (user: DevTokenUser) =>
      callRecords(events).filter((record) => record.userId === user.userId).length;
    expect(strangers.map(lines)).toEqual([10, 10, 10, 0]);
    const summaries = events.filter((event) => event.type === 'refused_summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      scope: {
        kind: 'relay',
        busiest: [
          { userId: G4.userId, counts: { not_attached: 12 } },
          { userId: G1.userId, counts: { not_attached: 2 } },
          { userId: G2.userId, counts: { not_attached: 2 } },
          { userId: G3.userId, counts: { not_attached: 2 } },
        ],
        others: { accounts: 0, counts: {} },
      },
    });
  });

  it('gives a member, or an invitee holding an attachment, 10 lines and then a summary of its own', async () => {
    const store = createMemoryStore();
    const { relay } = await setup({ store });
    heldBy(store, G5, 'pg_HELD000000');
    for (const user of [ALICE, G5]) {
      const who = await client(user);
      for (let i = 0; i < 12; i += 1) {
        await callTool(who, 'call_page_tool', { page: 'pg_NOPE000000', tool: 'get_view' });
      }
    }
    await relay.close();
    const events = relay.audit.events();
    for (const user of [ALICE, G5]) {
      expect(callRecords(events).filter((record) => record.userId === user.userId)).toHaveLength(
        10,
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'refused_summary',
          scope: { kind: 'user', userId: user.userId, counts: { not_attached: 2 } },
        }),
      );
    }
    expect(events.filter((event) => event.type === 'refused_summary')).toHaveLength(2);
  });

  it('writes its summaries every window while the relay runs, not only as it closes', async () => {
    const { relay } = await setup({ rateLimits: { windowMs: 400, auditRefusalsPerUser: 1 } });
    const alice = await client(ALICE);
    for (let i = 0; i < 5; i += 1) {
      await callTool(alice, 'call_page_tool', { page: 'pg_NOPE000000', tool: 'get_view' });
    }
    // No close() here: a relay that runs for days, or dies, must still have counted them.
    await vi.waitFor(
      () => {
        const summaries = relay.audit
          .events()
          .flatMap((event) => (event.type === 'refused_summary' ? [event.scope] : []));
        expect(summaries).toContainEqual(
          expect.objectContaining({ kind: 'user', userId: ALICE.userId }),
        );
      },
      { timeout: 3000 },
    );
  });

  it('always writes a call that reached its page in full', async () => {
    const { relay } = await setup();
    const opened = await page();
    const alice = await client(ALICE);
    await pairAndApprove(alice, opened);
    for (let i = 0; i < 25; i += 1) {
      expect(
        (await callTool(alice, 'call_page_tool', { page: opened.pageId, tool: 'get_view' }))
          .isError,
      ).toBe(false);
    }
    expect(relay.audit.records().filter((record) => record.outcome === 'ok')).toHaveLength(25);
  });

  it('counts accounts past the strangers it names', () => {
    const written: unknown[] = [];
    const budget = new AuditRefusalBudget({
      perUser: 1,
      strangers: 1,
      windowMs: 60_000,
      holds: () => false,
      write: (event) => written.push(event),
    });
    for (let n = 1; n <= 25; n += 1) {
      for (let i = 0; i < n; i += 1) {
        budget.refused({
          v: 1,
          type: 'request_refused',
          at: 0,
          userId: guest(n).userId,
          kind: 'invitee',
          client: null,
          tool: 'list_pages',
          pageId: null,
          outcome: 'rate_limited',
        });
      }
    }
    budget.close();
    const summary = written.at(-1) as {
      scope: { busiest: { userId: string }[]; others: { accounts: number; counts: object } };
    };
    expect(written).toHaveLength(2);
    expect(summary.scope.busiest).toHaveLength(20);
    expect(summary.scope.busiest[0]?.userId).toBe(guest(25).userId);
    // Guest 1 wrote its one line; guests 2 to 5, the quietest, are counted together.
    expect(summary.scope.others).toEqual({ accounts: 4, counts: { rate_limited: 2 + 3 + 4 + 5 } });
  });

  it(`holds at most ${String(MAX_STRANGERS_COUNTED)} strangers by name a window, counting the rest as they come`, () => {
    const written: unknown[] = [];
    const budget = new AuditRefusalBudget({
      perUser: 1,
      strangers: 1,
      windowMs: 60_000,
      holds: () => false,
      write: (event) => written.push(event),
    });
    const refuse = (n: number) => {
      budget.refused({
        v: 1,
        type: 'request_refused',
        at: 0,
        userId: guest(n).userId,
        kind: 'invitee',
        client: null,
        tool: 'list_pages',
        pageId: null,
        outcome: 'rate_limited',
      });
    };
    // The first writes its line; the next fill the pool exactly.
    for (let n = 1; n <= MAX_STRANGERS_COUNTED + 1; n += 1) refuse(n);
    // Past the pool, each refusal counts as an account of its own, so one stranger twice is two.
    refuse(MAX_STRANGERS_COUNTED + 2);
    refuse(MAX_STRANGERS_COUNTED + 2);
    budget.close();
    expect(written).toHaveLength(2);
    const summary = written.at(-1) as {
      scope: { busiest: { userId: string }[]; others: { accounts: number; counts: object } };
    };
    expect(summary.scope.busiest).toHaveLength(20);
    const past = MAX_STRANGERS_COUNTED - 20 + 2;
    expect(summary.scope.others).toEqual({ accounts: past, counts: { rate_limited: past } });
  });
});

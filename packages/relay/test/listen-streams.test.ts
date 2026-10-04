// The 2026-07-28 leg's subscriptions/listen streams (A4.3). The SDK serves
// them from one relay-wide set, so the relay bounds them as it bounds
// 2025-era sessions, in a count of their own: a stranger (an invitee holding
// no attachment) holds one, a guest perInvitee and a member perUser, a newer
// stream of the same user ending its oldest; invitees share their own pool;
// a stream gives way only to someone ranked above its holder, so strangers
// never shut out a guest or a member; and each listen counts against the
// request budget like a tool call (S9, ADR 0018).

import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AttachmentRecord,
  createDevTokenAuth,
  createMemoryStore,
  type DevTokenUser,
  type RelayStore,
} from '../src/index.ts';
import { openListen, type OpenListen } from './helpers/raw-mcp.ts';
import {
  ALICE,
  BOB,
  CAROL,
  callTool,
  connectClient,
  delay,
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
const listens: OpenListen[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const opened of listens.splice(0)) opened.close();
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  await current?.close();
  current = undefined;
});

async function setup(options: Parameters<typeof startRelay>[0] = {}): Promise<TestRelay> {
  current = await startRelay({
    auth: createDevTokenAuth([ALICE, BOB, CAROL, G1, G2, G3, G4, G5]),
    invites: true,
    ...options,
  });
  return current;
}

async function listen(user: DevTokenUser): Promise<OpenListen> {
  if (!current) throw new Error('no relay');
  const opened = await openListen(current.relay, user);
  listens.push(opened);
  return opened;
}

/** Whether the stream ended within a short wait; an open one keeps sending keep-alives only. */
async function ended(opened: OpenListen | undefined): Promise<boolean> {
  if (!opened) throw new Error('no stream');
  return Promise.race([opened.ended.then(() => true), delay(300).then(() => false)]);
}

function refusalOf(opened: OpenListen): {
  error?: { code: number; message: string };
  id?: unknown;
} {
  expect(opened.streaming).toBe(false);
  return JSON.parse(opened.text) as { error?: { code: number; message: string }; id?: unknown };
}

/** An attachment as an invite would have made it, put straight into the store. */
function heldBy(store: RelayStore, user: DevTokenUser): void {
  const attachment: AttachmentRecord = {
    pageId: 'pg_HELD000000',
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

const FULL = { code: -32603, message: 'Subscription limit reached' };

describe('listen streams on the 2026-07-28 leg (A4.3)', () => {
  it('holds one per stranger, a newer one ending the older, however many it opens', async () => {
    // The relay-wide total is two, so streams the SDK failed to end would soon fill it.
    await setup({ limits: { sessions: 2 } });
    const opened: OpenListen[] = [];
    for (let i = 0; i < 6; i += 1) opened.push(await listen(G1));
    expect(opened.map((stream) => stream.streaming)).toEqual(Array(6).fill(true));
    for (const stream of opened.slice(0, 5)) expect(await ended(stream)).toBe(true);
    expect(await ended(opened[5])).toBe(false);
    // The member's stream fits beside the stranger's one.
    const alice = await listen(ALICE);
    expect(alice.streaming).toBe(true);
    expect(await ended(opened[5])).toBe(false);
  });

  it('holds sessionsPerInvitee for a guest and sessionsPerUser for a member', async () => {
    const store = createMemoryStore();
    await setup({ store, limits: { sessionsPerUser: 3, sessionsPerInvitee: 2 } });
    heldBy(store, G1);
    const guests = [await listen(G1), await listen(G1), await listen(G1)];
    expect(await ended(guests[0])).toBe(true);
    expect(await ended(guests[1])).toBe(false);
    expect(await ended(guests[2])).toBe(false);
    const members = [await listen(ALICE), await listen(ALICE), await listen(ALICE)];
    members.push(await listen(ALICE));
    expect(await ended(members[0])).toBe(true);
    for (const stream of members.slice(1)) expect(await ended(stream)).toBe(false);
  });

  it('keeps strangers to their pool, past which a stranger is refused while a guest and a member still listen', async () => {
    const store = createMemoryStore();
    await setup({ store, limits: { inviteeSessions: 3 } });
    const strangers = [await listen(G1), await listen(G2), await listen(G3)];
    const refused = refusalOf(await listen(G5));
    expect(refused.error).toEqual(FULL);
    // The listen's own id, as the SDK echoes it at its cap.
    expect(String(refused.id)).toMatch(/^listen:\d+$/);
    // A guest takes the place of the stranger who opened first.
    heldBy(store, G4);
    expect((await listen(G4)).streaming).toBe(true);
    expect(await ended(strangers[0])).toBe(true);
    expect(await ended(strangers[1])).toBe(false);
    expect(await ended(strangers[2])).toBe(false);
    // Members are not in the pool at all.
    expect((await listen(ALICE)).streaming).toBe(true);
  });

  it('gives way at the relay total only to someone ranked above, and never closes a member stream', async () => {
    const store = createMemoryStore();
    await setup({ store, limits: { sessions: 3 } });
    const alice = [await listen(ALICE), await listen(ALICE)];
    const stranger = await listen(G1);
    expect(refusalOf(await listen(G2))).toMatchObject({ error: FULL });
    expect(await ended(stranger)).toBe(false);
    // A member takes the stranger's place.
    expect((await listen(BOB)).streaming).toBe(true);
    expect(await ended(stranger)).toBe(true);
    // Now only members hold streams, and nobody else's gives way to anyone.
    heldBy(store, G3);
    expect(refusalOf(await listen(G3))).toMatchObject({ error: FULL });
    expect(refusalOf(await listen(CAROL))).toMatchObject({ error: FULL });
    for (const stream of alice) expect(await ended(stream)).toBe(false);
  });

  it('counts each listen against the request budget, refused past it before any room is made', async () => {
    await setup({ rateLimits: { requestsPerUser: 3, requestsPerInvitee: 1 } });
    if (!current) throw new Error('no relay');
    const alice = await connectClient(current.relay, ALICE);
    clients.push(alice);
    const first = await listen(ALICE);
    const second = await listen(ALICE);
    expect((await callTool(alice, 'list_pages')).isError).toBe(false);
    expect((await callTool(alice, 'list_pages')).text).toMatch(/^rate_limited: /);
    expect(refusalOf(await listen(ALICE))).toMatchObject({
      error: {
        code: -32000,
        message: 'more than 3 requests to this relay in 1 minute; wait and try again',
      },
    });
    expect(await ended(first)).toBe(false);
    expect(await ended(second)).toBe(false);
    // A stranger's second listen is refused by the budget, so its first is not replaced.
    const stranger = await listen(G1);
    expect(refusalOf(await listen(G1)).error?.message).toBe(
      'more than 1 requests to this relay in 1 minute; wait and try again',
    );
    expect(await ended(stranger)).toBe(false);
  });
});

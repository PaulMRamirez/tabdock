// ADR 0044, A6.21: the invitees watching a page by invite share a part of its
// calls, so a room of them cannot make the operator's tab stutter. Past a
// watcher's own rate or the watchers' rate on the page a call answers
// rate_limited, and past the watchers' calls already running page_busy, each
// with its call record within the refusal budget (S7). Members, in any role,
// are never held to it. The rates are options only, lowered here.

import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { attachMember, call, type InviteRelay, startInviteRelay } from './helpers/invites.ts';
import type { InvokeFrame, InvokeReply, TestPage } from './helpers/page-client.ts';
import { fillRoom, type Guest, roomLimits } from './helpers/room.ts';

let current: InviteRelay | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

interface Room {
  relay: InviteRelay;
  page: TestPage;
  alice: Client;
  guests: Guest[];
  /** Each guest's Claude, in the same order. */
  watchers: Client[];
}

async function room(
  watchers: number,
  options: Parameters<typeof startInviteRelay>[0] = {},
  onInvoke?: (frame: InvokeFrame) => Promise<InvokeReply>,
): Promise<Room> {
  const relay = await startInviteRelay({
    ...options,
    rateLimits: { ...roomLimits, ...options.rateLimits },
  });
  current = relay;
  const page = await relay.page({
    policy: { invites: 'all' },
    ...(onInvoke === undefined ? {} : { onInvoke }),
  });
  const alice = await relay.claude('sub-alice');
  await attachMember(alice, page);
  const { guests } = await fillRoom(relay, page, watchers);
  const clients: Client[] = [];
  for (const guest of guests) clients.push(await relay.claude(guest.sub, guest.email));
  return { relay, page, alice, guests, watchers: clients };
}

function getView(client: Client, page: TestPage) {
  return call(client, 'call_page_tool', { page: page.pageId, tool: 'get_view' });
}

/** The call records the relay wrote for a user, by outcome, in order. */
function outcomes(relay: InviteRelay, userId: string): string[] {
  return relay.relay.audit
    .events()
    .filter((event) => event.type === 'call' && event.userId === userId)
    .map((event) => (event.type === 'call' ? event.outcome : ''));
}

describe("the watchers' share of a page's calls (ADR 0044, A6.21)", () => {
  it("refuses a watcher's call past their own share as rate_limited, with its call record, and never a member's", async () => {
    const { relay, page, alice, guests, watchers } = await room(1, {
      rateLimits: { watchingCallsPerUserPerPage: 2 },
    });
    const [watcher] = watchers;
    if (watcher === undefined) throw new Error('no watcher');
    expect((await getView(watcher, page)).isError).toBe(false);
    expect((await getView(watcher, page)).isError).toBe(false);
    const refused = await getView(watcher, page);
    expect(refused.text).toMatch(/^rate_limited: a watcher may make 2 calls to this page in /);
    expect(refused.text).toContain('get_page_state');
    expect(outcomes(relay, guests[0]?.userId ?? '')).toEqual(['ok', 'ok', 'rate_limited']);
    // The page heard two of them.
    await page.sync();
    expect(page.all('invoke')).toHaveLength(2);
    // A member, whatever their role, is not a watcher.
    page.send({ t: 'set_role', userId: 'alice', role: 'observer' });
    await page.sync();
    for (let i = 0; i < 5; i += 1) expect((await getView(alice, page)).isError).toBe(false);
  });

  it("shares the page's rate among its watchers", async () => {
    const { relay, page, guests, watchers } = await room(3, {
      rateLimits: { watchingCallsPerPage: 4, watchingCallsPerUserPerPage: 2 },
    });
    const [first, second, third] = watchers;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('three watchers expected');
    }
    for (const watcher of [first, first, second, second]) {
      expect((await getView(watcher, page)).isError).toBe(false);
    }
    const refused = await getView(third, page);
    expect(refused.text).toMatch(/^rate_limited: this page's watchers have made the 4 calls/);
    expect(outcomes(relay, guests[2]?.userId ?? '')).toEqual(['rate_limited']);
  });

  it("answers page_busy past the watchers' calls already running, and gives each place back as its call ends", async () => {
    const held: (() => void)[] = [];
    const { relay, page, alice, guests, watchers } = await room(
      5,
      {},
      (frame) =>
        new Promise<InvokeReply>((resolve) => {
          held.push(() => {
            resolve({ ok: true, content: JSON.stringify({ tool: frame.tool }) });
          });
        }),
    );
    const running = watchers.slice(0, 4).map((watcher) => getView(watcher, page));
    await expect.poll(() => held.length).toBe(4);
    const fifth = watchers[4];
    if (fifth === undefined) throw new Error('five watchers expected');
    const refused = await getView(fifth, page);
    expect(refused.text).toMatch(
      /^page_busy: 4 calls from this page's watchers are already running/,
    );
    expect(outcomes(relay, guests[4]?.userId ?? '')).toEqual(['page_busy']);
    // A member's call goes to the page meanwhile.
    const members = getView(alice, page);
    await expect.poll(() => held.length).toBe(5);
    for (const release of held.splice(0)) release();
    for (const outcome of [...(await Promise.all(running)), await members]) {
      expect(outcome.isError, outcome.text).toBe(false);
    }
    // Their places are given back.
    const again = getView(fifth, page);
    await expect.poll(() => held.length).toBe(1);
    held.shift()?.();
    expect((await again).isError).toBe(false);
  });
});

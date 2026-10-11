// wait_for_page_state (ADR 0040, A6.6): a wait answers as soon as the page's
// version passes the one given, at once when it already has or the one
// given is ahead, or at its timeout, never past MAX_WAIT_MS or the call
// deadline, with the whole body and `changed`. A user holds two waits at
// once and a page one for each of its seats, its invitees two fewer, each
// holding its request's charge; past any, rate_limited with a
// request_refused record (S7, S9, waits.ts). Whatever ends an attachment,
// a sleep, a reload, the page's end and the relay's own end answer a
// waiting wait at once (S8, S14), and a client that gives up frees its
// slot and its charge.

import type { Client, FetchLike } from '@modelcontextprotocol/client';
import {
  CLOSE_DETACH,
  MAX_WAIT_MS,
  MAX_WAITS_PER_USER,
  MEMBER_RESERVED_SEATS,
  pageStateHeader,
} from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { MIN_REQUEST_BYTES } from '../src/config.ts';
import { createDevTokenAuth, createMemoryStore } from '../src/index.ts';
import {
  connectPage,
  PAGE_ORIGIN,
  type PageOptions,
  type TestPage,
  TOOLS,
} from './helpers/page-client.ts';
import {
  ALICE,
  BOB,
  callTool,
  connectClient,
  type ClientOptions,
  delay,
  pairAndApprove,
  startRelay,
  TestFence,
  type TestRelay,
} from './helpers/relay.ts';
import { guest, invitedBy, publish, readState, waitState } from './helpers/state.ts';

let current: TestRelay | undefined;
const pages: TestPage[] = [];
const clients: Client[] = [];
const fence = new TestFence();
const G1 = guest(1);
const G2 = guest(2);

afterEach(async () => {
  fence.end();
  const ending = current;
  current = undefined;
  try {
    for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  } finally {
    for (const page of pages.splice(0)) page.ws.terminate();
    await ending?.close();
  }
});

async function setup(options: Parameters<typeof startRelay>[0] = {}): Promise<TestRelay> {
  current = await fence.keep(startRelay(options), (late) => late.close());
  return current;
}

async function page(options: PageOptions = {}): Promise<TestPage> {
  if (!current) throw new Error('no relay');
  const opened = await fence.keep(
    connectPage(current.relay.pageUrl, {
      tools: TOOLS,
      onInvoke: () => ({ ok: true, content: '{}' }),
      ...options,
    }),
    (late) => {
      late.ws.terminate();
    },
  );
  pages.push(opened);
  return opened;
}

async function client(user = ALICE, options: ClientOptions = {}): Promise<Client> {
  if (!current) throw new Error('no relay');
  const connected = await fence.keep(connectClient(current.relay, user, options), (late) =>
    late.close(),
  );
  clients.push(connected);
  return connected;
}

/** Resolves once the relay has started `count` waits in all, so a test can act while they wait. */
async function started(relay: TestRelay, count: number): Promise<void> {
  const seen = (): number =>
    relay.lines.filter((line) => line.includes('"msg":"page state wait started"')).length;
  for (let tries = 0; seen() < count && tries < 500; tries += 1) await delay(10);
  if (seen() < count) throw new Error('the wait never started');
}

function refusals(relay: TestRelay, tool = 'wait_for_page_state') {
  return relay.relay.audit
    .events()
    .filter((event) => event.type === 'request_refused' && event.tool === tool);
}

const LEGS = [
  ['2025-era', false],
  ['2026-07-28', true],
] as const;

describe('when a wait answers (ADR 0040)', () => {
  it.each(LEGS)(
    'answers within a second of a change on the %s leg, with the whole body and changed',
    async (_, modern) => {
      const relay = await setup();
      const opened = await page();
      const alice = await client(ALICE, { modern });
      await pairAndApprove(alice, opened);
      const pending = waitState(alice, opened.pageId, 0, 2500);
      await started(relay, 1);
      await delay(100);
      const publishedAt = Date.now();
      await publish(opened, { stop: 1 });
      const answer = await pending;
      const tookMs = Date.now() - publishedAt;
      expect(answer.isError, answer.text).toBe(false);
      expect(answer.types).toEqual(['text']);
      expect(answer.structuredContent).toBeUndefined();
      expect(answer.body).toMatchObject({ version: 1, value: { stop: 1 }, changed: true });
      expect(tookMs).toBeLessThan(1000);
    },
  );

  it.each(LEGS)(
    'answers an invitee on the %s leg behind its label, with no structured copy (S14)',
    async (_, modern) => {
      const store = createMemoryStore();
      const relay = await setup({ auth: createDevTokenAuth([ALICE, G1]), invites: true, store });
      const opened = await page();
      await pairAndApprove(await client(), opened);
      invitedBy(store, G1, opened.pageId);
      const g1 = await client(G1, { modern });
      const pending = waitState(g1, opened.pageId, 0, 2500);
      await started(relay, 1);
      await publish(opened, { stop: 1 });
      const answer = await pending;
      expect(answer.isError, answer.text).toBe(false);
      expect(answer.label).toBe(pageStateHeader(PAGE_ORIGIN));
      expect(answer.types).toEqual(['text']);
      expect(answer.structuredContent).toBeUndefined();
      expect(answer.body).toMatchObject({ version: 1, value: { stop: 1 }, changed: true });
    },
  );

  it('answers at its timeout with changed false and the same version', async () => {
    await setup();
    const opened = await page();
    const alice = await client();
    await pairAndApprove(alice, opened);
    await publish(opened, { stop: 1 });
    const started = Date.now();
    const answer = await waitState(alice, opened.pageId, 1, 300);
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    expect(answer.body).toMatchObject({ version: 1, value: { stop: 1 }, changed: false });
  });

  it('answers at once when the version already passed after, when after is ahead, and for a timeout of 0', async () => {
    const relay = await setup();
    const opened = await page();
    const alice = await client();
    await pairAndApprove(alice, opened);
    await publish(opened, { stop: 1 });
    await publish(opened, { stop: 2 });
    const started = Date.now();
    expect((await waitState(alice, opened.pageId, 1, 30_000)).body).toMatchObject({
      version: 2,
      changed: true,
    });
    expect((await waitState(alice, opened.pageId, 7, 30_000)).body).toMatchObject({
      version: 2,
      changed: true,
    });
    expect((await waitState(alice, opened.pageId, 2, 0)).body).toMatchObject({
      version: 2,
      changed: false,
    });
    expect(Date.now() - started).toBeLessThan(2000);
    // None of them waited, so none took a slot.
    expect(relay.lines.some((line) => line.includes('"msg":"page state wait started"'))).toBe(
      false,
    );
  });

  it('never waits past the call deadline, whatever timeoutMs asks', async () => {
    await setup({ timings: { callDeadlineMs: 600 } });
    const opened = await page();
    const alice = await client();
    await pairAndApprove(alice, opened);
    const started = Date.now();
    const answer = await waitState(alice, opened.pageId, 0, MAX_WAIT_MS);
    const tookMs = Date.now() - started;
    expect(answer.body).toMatchObject({ version: 0, changed: false });
    expect(tookMs).toBeGreaterThanOrEqual(590);
    expect(tookMs).toBeLessThan(3000);
  });

  it(`refuses a timeoutMs past ${String(MAX_WAIT_MS)} or an after that is not a whole number as invalid_arguments`, async () => {
    await setup();
    const opened = await page();
    const alice = await client();
    await pairAndApprove(alice, opened);
    for (const args of [
      { after: 0, timeoutMs: MAX_WAIT_MS + 1 },
      { after: -1 },
      { after: 1.5 },
      { after: 0, timeoutMs: -1 },
    ]) {
      const answer = await callTool(alice, 'wait_for_page_state', { page: opened.pageId, ...args });
      expect(answer.text, JSON.stringify(args)).toMatch(/^invalid_arguments: /);
    }
  });
});

describe('how many may wait, and what each holds (S9, waits.ts)', () => {
  it(`refuses a user's wait past ${String(MAX_WAITS_PER_USER)} across pages with rate_limited and a request_refused record`, async () => {
    const relay = await setup();
    const [one, two] = [await page(), await page()];
    const alice = await client();
    await pairAndApprove(alice, one);
    await pairAndApprove(alice, two);
    const first = waitState(alice, one.pageId, 0, 2500);
    await started(relay, 1);
    const second = waitState(alice, two.pageId, 0, 2500);
    await started(relay, 2);
    const third = await waitState(alice, one.pageId, 0, 2500);
    expect(third.text).toMatch(/^rate_limited: you already hold 2 waits/);
    expect(refusals(relay)).toEqual([
      expect.objectContaining({
        userId: 'alice',
        kind: 'member',
        pageId: one.pageId,
        outcome: 'rate_limited',
      }),
    ]);
    // A read is never a wait, so it is not refused.
    expect((await readState(alice, one.pageId)).isError).toBe(false);
    await publish(one, { stop: 1 });
    await publish(two, { stop: 1 });
    for (const answer of await Promise.all([first, second])) {
      expect(answer.body).toMatchObject({ changed: true });
    }
    // Both slots are back.
    const again = [waitState(alice, one.pageId, 1, 300), waitState(alice, two.pageId, 1, 300)];
    for (const answer of await Promise.all(again)) expect(answer.isError, answer.text).toBe(false);
  });

  it("refuses a page's wait past its people limit, with invites off", async () => {
    const relay = await setup({ limits: { usersPerPage: 2 } });
    const opened = await page();
    const alice = await client();
    const bob = await client(BOB);
    await pairAndApprove(alice, opened);
    await pairAndApprove(bob, opened, 'observer');
    const held = [waitState(alice, opened.pageId, 0, 2500)];
    await started(relay, 1);
    held.push(waitState(alice, opened.pageId, 0, 2500));
    await started(relay, 2);
    const refused = await waitState(bob, opened.pageId, 0, 2500);
    expect(refused.text).toMatch(/^rate_limited: this page already has as many waits as it allows/);
    expect(refusals(relay)).toEqual([
      expect.objectContaining({ userId: 'bob', pageId: opened.pageId }),
    ]);
    await publish(opened, { stop: 1 });
    await Promise.all(held);
  });

  it(`keeps ${String(MEMBER_RESERVED_SEATS)} of a page's waits from invitees, so members can always wait`, async () => {
    const store = createMemoryStore();
    const relay = await setup({
      auth: createDevTokenAuth([ALICE, BOB, G1, G2]),
      invites: true,
      store,
      limits: { usersPerPage: 3, observersPerPage: 0 },
    });
    const opened = await page();
    const alice = await client();
    await pairAndApprove(alice, opened);
    invitedBy(store, G1, opened.pageId);
    invitedBy(store, G2, opened.pageId);
    const g1 = await client(G1);
    const g2 = await client(G2);
    // Three waits on the page, invitees one of them.
    const held = [waitState(g1, opened.pageId, 0, 2500)];
    await started(relay, 1);
    const refused = await waitState(g2, opened.pageId, 0, 2500);
    expect(refused.text).toMatch(/^rate_limited: invited accounts already hold as many waits/);
    expect(refusals(relay)).toEqual([
      expect.objectContaining({ userId: G2.userId, kind: 'invitee', pageId: opened.pageId }),
    ]);
    // A member still waits beside them.
    held.push(waitState(alice, opened.pageId, 0, 2500));
    await started(relay, 2);
    held.push(waitState(alice, opened.pageId, 0, 2500));
    await started(relay, 3);
    await publish(opened, { stop: 1 });
    for (const answer of await Promise.all(held)) expect(answer.body?.changed).toBe(true);
  });

  it.each(LEGS)(
    "charges a %s wait its request, refusing one past its user's share with rate_limited",
    async (_, modern) => {
      const relay = await setup({
        limits: { requestBytesPerUser: MIN_REQUEST_BYTES, requestBytes: 4 * MIN_REQUEST_BYTES },
        timings: { callDeadlineMs: 20_000 },
      });
      const opened = await page();
      // Each wait's body padded to about 1.9 MiB: charged with its fixed quarter MiB, one fits
      // in the 4 MiB share and a second does not.
      const alice = await client(ALICE, { modern, fetch: padding(1.9 * 1024 * 1024) });
      await pairAndApprove(alice, opened);
      const first = waitState(alice, opened.pageId, 0, 15_000);
      await started(relay, 1);
      const second = await waitState(alice, opened.pageId, 0, 15_000);
      expect(second.text).toMatch(/^rate_limited: your requests waiting on pages already hold/);
      expect(refusals(relay)).toHaveLength(1);
      await publish(opened, { stop: 1 });
      expect((await first).body?.changed).toBe(true);
      // The charge is back once the wait answered.
      const third = waitState(alice, opened.pageId, 1, 15_000);
      await started(relay, 2);
      await publish(opened, { stop: 2 });
      expect((await third).body?.changed).toBe(true);
    },
    30_000,
  );

  it('frees the slot when the client gives up', async () => {
    const relay = await setup();
    const opened = await page();
    const alice = await client();
    await pairAndApprove(alice, opened);
    const controllers = [new AbortController(), new AbortController()];
    const given = controllers.map((controller) =>
      waitState(alice, opened.pageId, 0, 2500, controller.signal).catch((error: unknown) => error),
    );
    await started(relay, 2);
    for (const controller of controllers) controller.abort();
    await Promise.all(given);
    // Both slots are free again: two more waits are taken.
    const held = [waitState(alice, opened.pageId, 0, 2500)];
    await started(relay, 3);
    held.push(waitState(alice, opened.pageId, 0, 2500));
    await started(relay, 4);
    await publish(opened, { stop: 1 });
    for (const answer of await Promise.all(held)) expect(answer.isError, answer.text).toBe(false);
  });
});

describe('past the request budget (ADR 0018, S7)', () => {
  it.each(LEGS)(
    'both state tools answer rate_limited in their own words with a request_refused record on the %s leg',
    async (_, modern) => {
      const relay = await setup({ rateLimits: { requestsPerUser: 4 } });
      const opened = await page();
      const alice = await client(ALICE, { modern });
      await pairAndApprove(alice, opened);
      let read = await readState(alice, opened.pageId);
      for (let n = 0; n < 10 && !read.isError; n += 1) read = await readState(alice, opened.pageId);
      expect(read.text).toMatch(/^rate_limited: more than 4 requests/);
      const waited = await waitState(alice, opened.pageId, 0, 2000);
      expect(waited.text).toMatch(/^rate_limited: more than 4 requests/);
      const refused = relay.relay.audit
        .events()
        .filter((event) => event.type === 'request_refused');
      for (const tool of ['get_page_state', 'wait_for_page_state']) {
        expect(refused, tool).toContainEqual(
          expect.objectContaining({ tool, pageId: opened.pageId, outcome: 'rate_limited' }),
        );
      }
    },
  );
});

/** A fetch that pads every wait_for_page_state body with this many spaces, which the SDK never would. */
function padding(spaces: number, base: FetchLike = fetch): FetchLike {
  return (input, init) => {
    const body = init?.body;
    if (typeof body !== 'string' || !body.includes('"wait_for_page_state"'))
      return base(input, init);
    return base(input, { ...init, body: `${body.slice(0, -1)}${' '.repeat(spaces)}}` });
  };
}

describe('what ends a waiting wait at once (S8, S14)', () => {
  /** Each case ends Bob's or a guest's attachment while their wait waits, well before its 2.5 s timeout. */
  const ENDINGS: [string, (world: World) => Promise<void> | void][] = [
    [
      'a revoke',
      ({ opened }) => {
        opened.send({ t: 'revoke', userId: 'bob' });
      },
    ],
    [
      'detach_page',
      async ({ bob, opened }) => {
        expect((await callTool(bob, 'detach_page', { page: opened.pageId })).isError).toBe(false);
      },
    ],
    // Idle expiry and an invite's end are their timers, set for 700 ms below.
    ['idle expiry', () => undefined],
    ['an invite-made attachment at its end', () => undefined],
    [
      'its sponsor ending',
      ({ opened }) => {
        opened.send({ t: 'revoke', userId: 'alice' });
      },
    ],
  ];

  interface World {
    relay: TestRelay;
    opened: TestPage;
    bob: Client;
  }

  it.each(ENDINGS)('ends it with not_attached on %s', async (what, end) => {
    const store = createMemoryStore();
    const relay = await setup({
      auth: createDevTokenAuth([ALICE, BOB, G1]),
      invites: true,
      store,
      timings: { attachmentIdleMs: what === 'idle expiry' ? 700 : 60_000 },
    });
    const opened = await page();
    const alice = await client();
    await pairAndApprove(alice, opened);
    let who: Client;
    if (what === 'an invite-made attachment at its end' || what === 'its sponsor ending') {
      invitedBy(
        store,
        G1,
        opened.pageId,
        Date.now() + (what === 'its sponsor ending' ? 60_000 : 700),
      );
      who = await client(G1);
      // A call arms the attachment's timer at its end, as a redemption does.
      expect(
        (await callTool(who, 'call_page_tool', { page: opened.pageId, tool: 'get_view' })).isError,
      ).toBe(false);
    } else {
      who = await client(BOB);
      await pairAndApprove(who, opened, 'observer');
    }
    const startedAt = Date.now();
    const pending = waitState(who, opened.pageId, 0, 2500);
    await started(relay, 1);
    await end({ relay, opened, bob: who });
    const answer = await pending;
    expect(answer.text, what).toMatch(/^not_attached: /);
    expect(Date.now() - startedAt, what).toBeLessThan(1500);
  });

  it('ends it with page_asleep when the page sleeps, and when it reloads', async () => {
    const relay = await setup();
    const opened = await page();
    const alice = await client();
    await pairAndApprove(alice, opened);
    const asleep = waitState(alice, opened.pageId, 0, 2500);
    await started(relay, 1);
    const token = opened.welcome?.resumeToken ?? '';
    let startedAt = Date.now();
    opened.ws.terminate();
    expect((await asleep).text).toMatch(/^page_asleep: the page disconnected while you waited/);
    expect(Date.now() - startedAt).toBeLessThan(1500);
    const back = await page({ resumeToken: token });
    const reloaded = waitState(alice, back.pageId, 0, 2500);
    await started(relay, 2);
    startedAt = Date.now();
    // A reload that replaces the live socket.
    await page({ resumeToken: back.welcome?.resumeToken ?? '' });
    expect((await reloaded).text).toMatch(/^page_asleep: the page reloaded while you waited/);
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  it('ends it with page_gone when the page detaches, as it does the calls in flight', async () => {
    const relay = await setup();
    const opened = await page();
    const alice = await client();
    await pairAndApprove(alice, opened);
    await publish(opened, { stop: 1 });
    const pending = waitState(alice, opened.pageId, 1, 2500);
    await started(relay, 1);
    const startedAt = Date.now();
    // A deliberate detach will not come back, so nothing may tell the waiter it might.
    opened.ws.close(CLOSE_DETACH, 'detach');
    expect((await pending).text).toMatch(/^page_gone: /);
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  it('ends it with page_asleep when the relay shuts down', async () => {
    const relay = await setup();
    const opened = await page();
    const alice = await client();
    await pairAndApprove(alice, opened);
    const pending = waitState(alice, opened.pageId, 0, 2500);
    await started(relay, 1);
    const closing = relay.close();
    const answer = await pending.catch((error: unknown) => ({ text: String(error) }));
    await closing;
    current = undefined;
    expect(answer.text).toMatch(/^page_asleep: the relay is shutting down$/);
  });
});

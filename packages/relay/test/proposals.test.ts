// Proposals from observers, the relay's half (ADR 0042, A6.10 to A6.12). On
// a page whose policy takes proposals from the caller, an observer's write
// answers proposed and the page gets a proposal frame, never an invoke;
// 'off', the default, answers role_denied as before; invitees propose only
// under 'all', and agents never (C13). The operator's Accept puts the call
// into the write queue in acceptance order, and its invoke names the
// proposal; Dismiss, expiry, withdrawal, sleep and a revoke each end it with
// the status and the line ADR 0042 names, and the caps refuse as stated.

import type { Client } from '@modelcontextprotocol/client';
import {
  CLOSE_DETACH,
  MAX_PENDING_PROPOSALS_PER_PAGE,
  MAX_PENDING_PROPOSALS_PER_USER,
  type PageTool,
  type PolicyInput,
  untrustedHeader,
} from '@tabdock/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthPlugin } from '../src/auth.ts';
import { createDevTokenAuth, createMemoryStore, type DevTokenUser } from '../src/index.ts';
import {
  connectPage,
  type InvokeFrame,
  type InvokeReply,
  PAGE_ORIGIN,
  type PageOptions,
  READ_TOOL,
  type TestPage,
  TOOLS,
  WRITE_TOOL,
} from './helpers/page-client.ts';
import {
  agentAttached,
  ARGS,
  closedLines,
  decide,
  getProposal,
  holdCheck,
  member,
  nextProposal,
  propose,
  proposalCalls,
  proposalIdOf,
  withdrawProposal,
} from './helpers/proposals.ts';
import {
  ALICE,
  BOB,
  CAROL,
  callTool,
  connectClient,
  type ClientOptions,
  delay,
  eventually,
  pairAndApprove,
  startRelay,
  TestFence,
  type TestRelay,
} from './helpers/relay.ts';
import { guest, invitedBy } from './helpers/state.ts';

let current: TestRelay | undefined;
const pages: TestPage[] = [];
const clients: Client[] = [];
const fence = new TestFence();

afterEach(async () => {
  vi.restoreAllMocks();
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

const MEMBERS: PolicyInput = { proposals: 'members' };

/** About 127 KiB charged: a thousand values, at the node cap. */
const DENSE = { label: 'x', n: Array.from({ length: 995 }, () => 0) };

async function page(policy: PolicyInput = MEMBERS, options: PageOptions = {}): Promise<TestPage> {
  if (!current) throw new Error('no relay');
  const opened = await fence.keep(
    connectPage(current.relay.pageUrl, {
      tools: TOOLS,
      policy,
      onInvoke: () => ({ ok: true, content: '{"added":true}' }),
      ...options,
    }),
    (late) => {
      late.ws.terminate();
    },
  );
  pages.push(opened);
  return opened;
}

async function client(user: DevTokenUser = ALICE, options: ClientOptions = {}): Promise<Client> {
  if (!current) throw new Error('no relay');
  const connected = await fence.keep(connectClient(current.relay, user, options), (late) =>
    late.close(),
  );
  clients.push(connected);
  return connected;
}

/** Bob, attached as an observer to the page. */
async function observer(
  opened: TestPage,
  user: DevTokenUser = BOB,
  modern = false,
): Promise<Client> {
  const joined = await client(user, { modern });
  await pairAndApprove(joined, opened, 'observer');
  return joined;
}

function events(relay: TestRelay) {
  return relay.relay.audit.events();
}

const LEGS = [
  ['2025-era', false],
  ['2026-07-28', true],
] as const;

describe('an observer proposes (A6.10)', () => {
  it.each(LEGS)(
    'on the %s leg: answers proposed, and the page gets a proposal frame and no invoke',
    async (_, modern) => {
      const relay = await setup();
      const opened = await page();
      const bob = await observer(opened, BOB, modern);
      const outcome = await propose(bob, opened.pageId);
      expect(outcome.isError, outcome.text).toBe(false);
      expect(outcome.text).toMatch(/^proposed: /);
      const proposalId = proposalIdOf(outcome);
      expect(outcome.structuredContent).toEqual({
        page: opened.pageId,
        proposal: proposalId,
        status: 'pending',
        expiresAt: expect.any(Number) as number,
      });
      const frame = await nextProposal(opened);
      expect(frame).toEqual({
        t: 'proposal',
        proposalId,
        tool: 'add_item',
        arguments: ARGS,
        proposer: {
          userId: 'bob',
          displayName: 'Bob',
          client: { name: 'relay-test', version: '1.0.0' },
          role: 'observer',
        },
        expiresAt: (outcome.structuredContent as { expiresAt: number }).expiresAt,
      });
      await opened.sync();
      expect(opened.all('invoke')).toEqual([]);
      expect(opened.all('proposal')).toHaveLength(1);
      // The line that made it is written in full, naming the proposal and no call.
      const [made] = proposalCalls(events(relay), proposalId);
      expect(made).toMatchObject({ userId: 'bob', tool: 'add_item', outcome: 'proposed' });
      expect(made).not.toHaveProperty('callId');
      expect(made).not.toHaveProperty('acceptedOnPage');
    },
  );

  it('by a first-class name too, which reaches the same path', async () => {
    await setup({ firstClassTools: true });
    const opened = await page();
    const bob = await observer(opened);
    const outcome = await callTool(bob, `${opened.pageId}__add_item`, ARGS);
    expect(outcome.isError, outcome.text).toBe(false);
    expect(outcome.text).toMatch(/^proposed: /);
    await nextProposal(opened);
    expect(opened.all('invoke')).toEqual([]);
  });

  it("answers role_denied word for word as before under 'off', the default, and sends nothing", async () => {
    await setup();
    const opened = await page({});
    const bob = await observer(opened);
    const outcome = await propose(bob, opened.pageId);
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toBe(
      'role_denied: you are an observer on this page, and add_item is not marked read-only',
    );
    await opened.sync();
    expect(opened.all('proposal')).toEqual([]);
    expect(opened.all('invoke')).toEqual([]);
  });

  it("takes an invitee's proposal only under 'all'", async () => {
    const store = createMemoryStore();
    const G1 = guest(1);
    await setup({ auth: createDevTokenAuth([ALICE, G1]), invites: true, store });
    for (const proposals of ['members', 'all'] as const) {
      const opened = await page({ proposals });
      // The sponsor's own attachment, which an invite-made one hangs from (S14).
      await pairAndApprove(await client(), opened);
      invitedBy(store, G1, opened.pageId);
      const g1 = await client(G1);
      const outcome = await propose(g1, opened.pageId);
      if (proposals === 'members') {
        expect(outcome.text).toMatch(/^role_denied: /);
        await opened.sync();
        expect(opened.all('proposal')).toEqual([]);
      } else {
        expect(outcome.text, outcome.text).toMatch(/^proposed: /);
        expect((await nextProposal(opened)).proposer.userId).toBe(G1.userId);
      }
    }
  });

  it("never takes an agent token's, even under 'all' (C13)", async () => {
    const store = createMemoryStore();
    const G1 = guest(1);
    // The agent's id is drawn from the page's, so its dev token is listed once the page is there.
    let auth = createDevTokenAuth([ALICE, G1]);
    const late: AuthPlugin = {
      name: 'dev-token',
      authenticate: (request) => auth.authenticate(request),
    };
    await setup({ auth: late, invites: true, store });
    const opened = await page({ proposals: 'all' });
    await pairAndApprove(await client(), opened);
    const agent = agentAttached(store, opened.pageId, 'agt_0123456789');
    auth = createDevTokenAuth([ALICE, G1, agent]);
    const caller = await client(agent);
    const outcome = await propose(caller, opened.pageId);
    expect(outcome.text).toBe(
      'role_denied: you are an observer on this page, and add_item is not marked read-only',
    );
    const listed = await callTool(caller, 'list_page_tools', { page: opened.pageId });
    expect(listed.text).not.toContain('proposable');
    // An invitee holding the same kind of attachment, made by an invite, may.
    invitedBy(store, G1, opened.pageId);
    const g1 = await client(G1);
    expect((await propose(g1, opened.pageId)).text).toMatch(/^proposed: /);
    await opened.sync();
    expect(opened.all('proposal').map((frame) => frame.proposer.userId)).toEqual([G1.userId]);
  });

  it('refuses a consequential tool at once under deny, with no frame', async () => {
    await setup();
    const marked: PageTool[] = [READ_TOOL, { ...WRITE_TOOL, consequential: true }];
    const opened = await page({ proposals: 'members', consequential: 'deny' }, { tools: marked });
    const bob = await observer(opened);
    const outcome = await propose(bob, opened.pageId);
    expect(outcome.text).toBe(
      'denied_by_operator: this page runs no consequential tools, so it takes no proposal for add_item',
    );
    await opened.sync();
    expect(opened.all('proposal')).toEqual([]);
  });

  it('runs nothing under deny for a tool the page re-lists as consequential after the proposal', async () => {
    const relay = await setup();
    const opened = await page({ proposals: 'members', consequential: 'deny' });
    const bob = await observer(opened);
    const proposalId = proposalIdOf(await propose(bob, opened.pageId));
    await nextProposal(opened);
    opened.send({ t: 'tools', tools: [READ_TOOL, { ...WRITE_TOOL, consequential: true }] });
    await opened.sync();
    await decide(opened, proposalId, true);
    expect(await opened.next('proposal_end')).toEqual({
      t: 'proposal_end',
      proposalId,
      reason: 'not_run',
    });
    expect(opened.all('invoke')).toEqual([]);
    await eventually(() => proposalCalls(events(relay), proposalId).length === 2);
    expect(proposalCalls(events(relay), proposalId)[1]).toMatchObject({
      acceptedOnPage: true,
      outcome: 'denied_by_operator',
    });
  });
});

describe('the operator decides (A6.11)', () => {
  it.each(LEGS)(
    'on the %s leg: Accept runs it with an invoke naming the proposal, and get_proposal answers the labelled result',
    async (_, modern) => {
      const relay = await setup();
      const opened = await page();
      const bob = await observer(opened, BOB, modern);
      const proposalId = proposalIdOf(await propose(bob, opened.pageId));
      await nextProposal(opened);
      await decide(opened, proposalId, true);
      const invoke = await opened.next('invoke');
      expect(invoke.proposal).toEqual({ proposalId });
      expect(invoke.confirmation).toBeUndefined();
      expect(invoke.caller).toMatchObject({ userId: 'bob', role: 'observer' });
      expect(invoke.tool).toBe('add_item');
      expect(invoke.arguments).toEqual(ARGS);
      const read = await getProposal(bob, opened.pageId, proposalId, 2000);
      expect(read.isError, read.text).toBe(false);
      expect(read.head).toBe('accepted');
      const lines = read.text.split('\n');
      expect(lines[1]).toBe(untrustedHeader(PAGE_ORIGIN, 'add_item'));
      expect(lines[2]).toBe('{"added":true}');
      // Page text never travels as structuredContent (S10).
      expect(read.structuredContent).toBeUndefined();
      // The run's line names the proposer, accepted on the page, with the invoke's id (S7).
      await eventually(() => proposalCalls(events(relay), proposalId).length === 2);
      const run = proposalCalls(events(relay), proposalId)[1];
      expect(run).toMatchObject({
        userId: 'bob',
        tool: 'add_item',
        outcome: 'ok',
        acceptedOnPage: true,
        callId: invoke.callId,
      });
      expect(run).not.toHaveProperty('confirmedBy');
      expect(closedLines(events(relay))).toEqual([]);
    },
  );

  it('queues accepted proposals in the order the operator accepts them, behind a running write', async () => {
    await setup();
    let release: ((reply: InvokeReply) => void) | undefined;
    const opened = await page(MEMBERS, {
      onInvoke: (frame: InvokeFrame) => {
        if (frame.caller.userId === 'alice') {
          return new Promise<InvokeReply>((resolve) => {
            release = resolve;
          });
        }
        return { ok: true, content: frame.caller.userId };
      },
    });
    const alice = await client(ALICE);
    await pairAndApprove(alice, opened, 'driver');
    const bob = await observer(opened, BOB);
    const carol = await observer(opened, CAROL);
    const driving = callTool(alice, 'call_page_tool', {
      page: opened.pageId,
      tool: 'add_item',
      arguments: { label: 'first' },
    });
    await opened.next('invoke');
    const first = proposalIdOf(await propose(bob, opened.pageId));
    const second = proposalIdOf(await propose(carol, opened.pageId));
    // Made first and second, accepted second then first.
    await decide(opened, second, true);
    await decide(opened, first, true);
    await delay(50);
    expect(opened.all('invoke')).toHaveLength(1);
    release?.({ ok: true, content: 'alice' });
    expect((await driving).isError).toBe(false);
    const a = await opened.next('invoke');
    const b = await opened.next('invoke');
    expect([a.proposal?.proposalId, b.proposal?.proposalId]).toEqual([second, first]);
    expect([a.caller.userId, b.caller.userId]).toEqual(['carol', 'bob']);
  });

  it('ends a proposal on Dismiss, with no frame back and a dismissed line', async () => {
    const relay = await setup();
    const opened = await page();
    const bob = await observer(opened);
    const proposalId = proposalIdOf(await propose(bob, opened.pageId));
    await nextProposal(opened);
    await decide(opened, proposalId, false);
    const read = await getProposal(bob, opened.pageId, proposalId);
    expect(read.head).toBe('dismissed');
    expect(read.structuredContent).toEqual({
      page: opened.pageId,
      proposal: proposalId,
      status: 'dismissed',
    });
    expect(opened.all('proposal_end')).toEqual([]);
    expect(closedLines(events(relay))).toEqual([
      expect.objectContaining({ proposalId, userId: 'bob', tool: 'add_item', reason: 'dismissed' }),
    ]);
  });

  it("ends it as refused on the page's own refusal", async () => {
    const relay = await setup();
    const opened = await page();
    const bob = await observer(opened);
    const proposalId = proposalIdOf(await propose(bob, opened.pageId));
    await decide(opened, proposalId, false, 'limit');
    expect((await getProposal(bob, opened.pageId, proposalId)).head).toBe('refused');
    expect(closedLines(events(relay)).map((line) => line.reason)).toEqual(['refused']);
  });

  it('ends it at its expiry, telling the page', async () => {
    const relay = await setup({ timings: { proposalTtlMs: 200 } });
    const opened = await page();
    const bob = await observer(opened);
    const proposalId = proposalIdOf(await propose(bob, opened.pageId));
    const ended = await opened.next('proposal_end');
    expect(ended).toEqual({ t: 'proposal_end', proposalId, reason: 'expired' });
    expect((await getProposal(bob, opened.pageId, proposalId)).head).toBe('expired');
    expect(closedLines(events(relay)).map((line) => line.reason)).toEqual(['expired']);
  });

  it('ends it when its proposer withdraws it, and a second withdrawal answers it as it stands', async () => {
    const relay = await setup();
    const opened = await page();
    const bob = await observer(opened);
    const proposalId = proposalIdOf(await propose(bob, opened.pageId));
    const withdrawn = await withdrawProposal(bob, opened.pageId, proposalId);
    expect(withdrawn.head).toBe('withdrawn');
    expect(await opened.next('proposal_end')).toEqual({
      t: 'proposal_end',
      proposalId,
      reason: 'withdrawn',
    });
    expect((await withdrawProposal(bob, opened.pageId, proposalId)).head).toBe('withdrawn');
    expect(closedLines(events(relay)).map((line) => line.reason)).toEqual(['withdrawn']);
  });

  it('answers accepted to a withdrawal after the Accept', async () => {
    await setup();
    const opened = await page();
    const bob = await observer(opened);
    const proposalId = proposalIdOf(await propose(bob, opened.pageId));
    await decide(opened, proposalId, true);
    await opened.next('invoke');
    expect((await withdrawProposal(bob, opened.pageId, proposalId)).head).toBe('accepted');
  });

  it('cancels it when the page sleeps, with nothing sent and a cancelled line', async () => {
    const relay = await setup();
    const opened = await page();
    const bob = await observer(opened);
    const proposalId = proposalIdOf(await propose(bob, opened.pageId));
    opened.ws.terminate();
    await eventually(() => closedLines(events(relay)).length === 1);
    expect(closedLines(events(relay))[0]).toMatchObject({ proposalId, reason: 'cancelled' });
    // The page is asleep, not gone: its proposer still reads the outcome.
    expect((await getProposal(bob, opened.pageId, proposalId)).head).toBe('cancelled');
  });

  it('answers page_gone once the page is gone', async () => {
    await setup();
    const opened = await page();
    const bob = await observer(opened);
    const proposalId = proposalIdOf(await propose(bob, opened.pageId));
    opened.ws.close(CLOSE_DETACH);
    await opened.closed;
    await eventually(
      async () => (await getProposal(bob, opened.pageId, proposalId)).head === 'page_gone',
    );
  });

  it("drops the proposer's proposals on a revoke, ends an accepted run in flight and wakes a wait at once (S8)", async () => {
    const relay = await setup();
    const opened = await page(MEMBERS, { onInvoke: () => undefined });
    const bob = await observer(opened);
    const running = proposalIdOf(await propose(bob, opened.pageId));
    const waiting = proposalIdOf(await propose(bob, opened.pageId));
    await decide(opened, running, true);
    const invoke = await opened.next('invoke');
    expect(invoke.proposal).toEqual({ proposalId: running });
    const started = Date.now();
    const wait = getProposal(bob, opened.pageId, waiting, 2500);
    await delay(100);
    opened.send({ t: 'revoke', userId: 'bob' });
    const woken = await wait;
    expect(woken.head).toBe('not_attached');
    expect(Date.now() - started).toBeLessThan(1500);
    const ends = [await opened.next('proposal_end'), await opened.next('cancel')];
    expect(ends).toEqual([
      { t: 'proposal_end', proposalId: waiting, reason: 'attachment_ended' },
      { t: 'cancel', callId: invoke.callId, reason: 'revoked' },
    ]);
    expect(closedLines(events(relay))).toEqual([
      expect.objectContaining({ proposalId: waiting, reason: 'cancelled' }),
    ]);
    await eventually(() => proposalCalls(events(relay), running).length === 2);
    expect(proposalCalls(events(relay), running)[1]).toMatchObject({
      acceptedOnPage: true,
      outcome: 'not_attached',
    });
  });

  it('takes one decision crossing its end as expected, and counts every replay after it as a frame that changes nothing', async () => {
    const relay = await setup({
      rateLimits: { ignoredFramesPerSocket: 2, ignoredFramesPerAddress: 10_000 },
    });
    const opened = await page();
    const bob = await observer(opened);
    const proposalId = proposalIdOf(await propose(bob, opened.pageId));
    await nextProposal(opened);
    await decide(opened, proposalId, false);
    const replays = 30;
    for (let i = 0; i < replays; i += 1) {
      opened.send({ t: 'proposal_decision', proposalId, accept: true });
    }
    await opened.sync();
    expect(opened.ws.readyState).toBe(opened.ws.OPEN);
    expect(opened.all('invoke')).toEqual([]);
    const written = relay.lines.filter((line) =>
      line.includes('decision for a proposal that already ended'),
    ).length;
    await relay.close();
    const held = relay.lines
      .map((line) => JSON.parse(line) as { msg: string; frames?: Record<string, number> })
      .filter((entry) => entry.msg === 'page frames that changed nothing went unlogged')
      .reduce((sum, entry) => sum + (entry.frames?.proposal_decision ?? 0), 0);
    // One crossing its end, then the socket's budget of 2 (twice should a
    // window turn mid-flood); every other replay is counted, unlogged.
    expect(written).toBeLessThanOrEqual(5);
    expect(written + held).toBe(replays);
  });

  it('ignores a decision from another page for the proposal, as a frame that changes nothing', async () => {
    const relay = await setup();
    const opened = await page();
    const other = await page();
    const bob = await observer(opened);
    const proposalId = proposalIdOf(await propose(bob, opened.pageId));
    await decide(other, proposalId, true);
    await delay(50);
    expect(opened.all('invoke')).toEqual([]);
    expect(other.all('invoke')).toEqual([]);
    expect(relay.lines.some((line) => line.includes("decision for another page's proposal"))).toBe(
      true,
    );
    expect((await getProposal(bob, opened.pageId, proposalId)).head).toBe('pending');
  });

  it('runs nothing a fresh attachment did not propose, and keeps the old one from its new self (S8)', async () => {
    const relay = await setup();
    const opened = await page();
    const bob = await observer(opened);
    const proposalId = proposalIdOf(await propose(bob, opened.pageId));
    // Bob detaches and pairs again before the operator clicks: a new attachment.
    await callTool(bob, 'detach_page', { page: opened.pageId });
    expect(await opened.next('proposal_end')).toEqual({
      t: 'proposal_end',
      proposalId,
      reason: 'attachment_ended',
    });
    await pairAndApprove(bob, opened, 'observer');
    await decide(opened, proposalId, true);
    // The detach ended it first: the page heard so, and the decision found it ended.
    expect((await getProposal(bob, opened.pageId, proposalId)).head).toBe('proposal_not_found');
    expect(opened.all('invoke')).toEqual([]);
    expect(closedLines(events(relay))).toEqual([
      expect.objectContaining({ proposalId, reason: 'cancelled' }),
    ]);
  });
  it('makes no proposal when its observer is revoked and approved afresh while its arguments are checked (S8)', async () => {
    const relay = await setup();
    const opened = await page();
    const bob = await observer(opened);
    // A reservation is no proposal yet, so the revoke's attachmentsEnded
    // cannot reach it: only the look at the attachment after the check can.
    const hold = holdCheck('add_item');
    const before = events(relay).length;
    const pending = propose(bob, opened.pageId);
    await hold.started;
    opened.send({ t: 'revoke', userId: 'bob' });
    await opened.sync();
    await pairAndApprove(await client(BOB), opened, 'observer');
    hold.release();
    const outcome = await pending;
    expect(outcome.text).toBe('not_attached: the attachment you proposed under has ended');
    await opened.sync();
    expect(opened.all('proposal')).toEqual([]);
    const after = events(relay).slice(before);
    expect(closedLines(after)).toEqual([]);
    expect(after.filter((event) => event.type === 'call' && event.tool === 'add_item')).toEqual([
      expect.objectContaining({ userId: 'bob', outcome: 'not_attached' }),
    ]);
    expect(after.some((event) => event.type === 'call' && event.proposalId !== undefined)).toBe(
      false,
    );
  });
});

describe('proposal limits (A6.12)', () => {
  it(`refuses a fourth pending proposal by one user, and a ${String(MAX_PENDING_PROPOSALS_PER_PAGE + 1)}st on a page`, async () => {
    const users = Array.from({ length: 7 }, (_, n) => member(n + 1));
    await setup({ auth: createDevTokenAuth([ALICE, ...users]) });
    const opened = await page();
    const joined: Client[] = [];
    for (const user of users) joined.push(await observer(opened, user));
    const [first, ...rest] = joined;
    if (first === undefined) throw new Error('no member');
    for (let n = 0; n < MAX_PENDING_PROPOSALS_PER_USER; n += 1) {
      expect((await propose(first, opened.pageId)).text).toMatch(/^proposed: /);
    }
    expect((await propose(first, opened.pageId)).text).toBe(
      'rate_limited: you already have 3 proposals waiting on this page; wait for the operator, or withdraw one with withdraw_proposal',
    );
    let made = MAX_PENDING_PROPOSALS_PER_USER;
    for (const other of rest) {
      for (
        let n = 0;
        n < MAX_PENDING_PROPOSALS_PER_USER && made < MAX_PENDING_PROPOSALS_PER_PAGE;
        n += 1
      ) {
        expect((await propose(other, opened.pageId)).text).toMatch(/^proposed: /);
        made += 1;
      }
    }
    const last = rest.at(-1);
    if (last === undefined) throw new Error('no member');
    expect((await propose(last, opened.pageId)).text).toBe(
      'rate_limited: this page already has 20 proposals waiting for its operator; try again later',
    );
    await opened.sync();
    expect(opened.all('proposal')).toHaveLength(MAX_PENDING_PROPOSALS_PER_PAGE);
  });

  it("keeps a withdrawn proposal's place a minute, so proposing and withdrawing cannot reset the cap", async () => {
    await setup();
    const opened = await page();
    const bob = await observer(opened);
    for (let n = 0; n < MAX_PENDING_PROPOSALS_PER_USER; n += 1) {
      const proposalId = proposalIdOf(await propose(bob, opened.pageId));
      expect((await withdrawProposal(bob, opened.pageId, proposalId)).head).toBe('withdrawn');
    }
    expect((await propose(bob, opened.pageId)).text).toBe(
      'rate_limited: proposals withdrawn, left by a detach or refused on this page keep their places for 1 minute, so the page is not asked too often; try again shortly',
    );
    await opened.sync();
    expect(opened.all('proposal')).toHaveLength(MAX_PENDING_PROPOSALS_PER_USER);
  });

  it('keeps the places a detach dropped a minute, so detaching and pairing again unasked cannot pass 20 new proposals a minute', async () => {
    await setup();
    // Members pair again with no operator click, so only the places bound the loop.
    const opened = await page({ proposals: 'members', autoApprove: 'observer' });
    const members: Client[] = [];
    for (const user of [ALICE, BOB, CAROL]) members.push(await client(user));
    const refusals: string[] = [];
    for (let cycle = 0; cycle < 4; cycle += 1) {
      for (const member of members) {
        await opened.sync();
        const paired = await callTool(member, 'pair_page', { code: opened.code });
        expect(paired.isError, paired.text).toBe(false);
        for (let n = 0; n < MAX_PENDING_PROPOSALS_PER_USER; n += 1) {
          const made = await propose(member, opened.pageId);
          if (made.isError) {
            refusals.push(made.text);
            break;
          }
        }
        const detached = await callTool(member, 'detach_page', { page: opened.pageId });
        expect(detached.isError, detached.text).toBe(false);
      }
    }
    await opened.sync();
    // Each member's first three, and from the next pairing on, a refusal.
    expect(opened.all('proposal')).toHaveLength(3 * MAX_PENDING_PROPOSALS_PER_USER);
    expect(opened.all('proposal').length).toBeLessThanOrEqual(MAX_PENDING_PROPOSALS_PER_PAGE);
    expect(refusals).toHaveLength(3 * 3);
    expect(new Set(refusals)).toEqual(
      new Set([
        'rate_limited: proposals withdrawn, left by a detach or refused on this page keep their places for 1 minute, so the page is not asked too often; try again shortly',
      ]),
    );
    expect(opened.all('proposal_end').map((frame) => frame.reason)).toEqual(
      Array<string>(3 * MAX_PENDING_PROPOSALS_PER_USER).fill('attachment_ended'),
    );
  });

  it('refuses arguments past 16 KiB or 1,000 values, and arguments its schema refuses, with no frame', async () => {
    await setup();
    const opened = await page();
    const bob = await observer(opened);
    const tooLarge = `a proposal's arguments may hold at most 16384 bytes and 1000 values`;
    // {"label":"…"} is 12 bytes around its text.
    const bytes = await propose(bob, opened.pageId, { label: 'x'.repeat(16_385 - 12) });
    expect(bytes.text).toBe(`invalid_arguments: ${tooLarge}`);
    const nodes = await propose(bob, opened.pageId, {
      label: 'x',
      n: Array.from({ length: 996 }, () => 0),
    });
    expect(nodes.text).toBe(`invalid_arguments: ${tooLarge}`);
    const fits = await propose(bob, opened.pageId, {
      label: 'x',
      n: Array.from({ length: 995 }, () => 0),
    });
    expect(fits.text).toMatch(/^proposed: /);
    const schema = await propose(bob, opened.pageId, { other: 1 });
    expect(schema.text).toMatch(/^invalid_arguments: /);
    await opened.sync();
    expect(opened.all('proposal')).toHaveLength(1);
  });

  it('refuses a proposal once what the relay holds for proposals is full', async () => {
    // At 1 MiB one user's share is one proposal at the caps, so nine users propose once each.
    const users = Array.from({ length: 9 }, (_, n) => member(n + 1));
    await setup({
      auth: createDevTokenAuth([ALICE, ...users]),
      limits: { proposalBytes: 1024 * 1024 },
    });
    const opened = await page();
    // About 127 KiB charged each, so eight fit in 1 MiB and the ninth does not.
    const answers: string[] = [];
    for (const user of users) {
      const joined = await observer(opened, user);
      answers.push((await propose(joined, opened.pageId, DENSE)).text);
    }
    expect(answers.slice(0, 8).every((text) => text.startsWith('proposed: '))).toBe(true);
    expect(answers[8]).toBe(
      'rate_limited: the relay holds as many proposals as it can; try again later',
    );
  });

  it("holds one user's proposals across pages to their share of what the relay holds (S9)", async () => {
    // At 2 MiB a user's share is 256 KiB: two proposals of about 127 KiB, on any pages.
    await setup({ limits: { proposalBytes: 2 * 1024 * 1024 } });
    const own = [await page(), await page(), await page()];
    // One member on pages of their own, as /page lets anyone open one.
    const bob = await client(BOB);
    for (const opened of own) await pairAndApprove(bob, opened, 'observer');
    const [first, second, third] = own;
    if (first === undefined || second === undefined || third === undefined)
      throw new Error('pages');
    const made = proposalIdOf(await propose(bob, first.pageId, DENSE));
    expect((await propose(bob, second.pageId, DENSE)).text).toMatch(/^proposed: /);
    expect((await propose(bob, third.pageId, DENSE)).text).toBe(
      "rate_limited: your proposals waiting across pages already hold as much of the relay's memory as one user's may; wait for their operators, or withdraw one with withdraw_proposal",
    );
    await third.sync();
    expect(third.all('proposal')).toEqual([]);
    // Far below the relay's budget, so anyone else still proposes there.
    expect((await propose(await observer(third, CAROL), third.pageId, DENSE)).text).toMatch(
      /^proposed: /,
    );
    // A settled proposal holds no arguments, so its share is free again.
    await withdrawProposal(bob, first.pageId, made);
    expect((await propose(bob, third.pageId, DENSE)).text).toMatch(/^proposed: /);
  });
});

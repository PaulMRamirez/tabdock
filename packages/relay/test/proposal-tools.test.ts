// get_proposal and withdraw_proposal (ADR 0042, A6.11 and A6.12) as clients
// meet them: a proposal id is a name, never a capability, so an unknown id
// and another user's answer proposal_not_found in the same words (S13); a
// wait shares the user's two wait slots with wait_for_page_state, wakes when
// the operator decides and again when an accepted run settles, and answers
// page_asleep when the page sleeps (SPEC section 7); both tools spend the
// request budget and are
// refused past it with a request_refused record; list_page_tools marks what
// an observer may propose; and an accepted run's result reaches its
// proposer as cut, labelled text only, never an image (S10, decision 15).

import type { Client } from '@modelcontextprotocol/client';
import { MAX_PROPOSAL_RESULT_CHARS, untrustedHeader } from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectPage,
  type InvokeReply,
  PAGE_ORIGIN,
  type PageOptions,
  type TestPage,
  TOOLS,
} from './helpers/page-client.ts';
import { answerWithImage, base64, pngHeader } from './helpers/images.ts';
import {
  decide,
  getProposal,
  propose,
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
import { waitState } from './helpers/state.ts';
import type { DevTokenUser } from '../src/index.ts';
import type { PolicyInput } from '@tabdock/protocol';

let current: TestRelay | undefined;
const pages: TestPage[] = [];
const clients: Client[] = [];
const fence = new TestFence();

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

async function page(
  policy: PolicyInput = { proposals: 'members' },
  options: PageOptions = {},
): Promise<TestPage> {
  if (!current) throw new Error('no relay');
  const opened = await fence.keep(
    connectPage(current.relay.pageUrl, {
      tools: TOOLS,
      policy,
      onInvoke: () => ({ ok: true, content: 'done' }),
      ...options,
    }),
    (late) => {
      late.ws.terminate();
    },
  );
  pages.push(opened);
  return opened;
}

async function client(user: DevTokenUser, options: ClientOptions = {}): Promise<Client> {
  if (!current) throw new Error('no relay');
  const connected = await fence.keep(connectClient(current.relay, user, options), (late) =>
    late.close(),
  );
  clients.push(connected);
  return connected;
}

async function attached(opened: TestPage, user: DevTokenUser, role: 'driver' | 'observer') {
  const joined = await client(user);
  await pairAndApprove(joined, opened, role);
  return joined;
}

describe('a proposal id is a name (S13, A6.12)', () => {
  it("answers an unknown id and another user's word for word the same, to both tools", async () => {
    await setup();
    const opened = await page();
    const bob = await attached(opened, BOB, 'observer');
    const alice = await attached(opened, ALICE, 'driver');
    const carol = await attached(opened, CAROL, 'observer');
    const proposalId = proposalIdOf(await propose(bob, opened.pageId));
    const answers: string[] = [];
    for (const asker of [alice, carol]) {
      for (const id of [proposalId, 'pr_UNKNOWN0000']) {
        const read = await getProposal(asker, opened.pageId, id);
        const withdrawn = await withdrawProposal(asker, opened.pageId, id);
        expect(read.isError).toBe(true);
        expect(withdrawn.isError).toBe(true);
        answers.push(read.text, withdrawn.text);
      }
    }
    expect(new Set(answers)).toEqual(
      new Set([
        'proposal_not_found: you have no proposal by that id on this page: it never existed, is not yours, or ended more than 10 minutes ago',
      ]),
    );
    // None of that touched it.
    expect((await getProposal(bob, opened.pageId, proposalId)).head).toBe('pending');
  });

  it('answers not_attached first to someone not attached, and never names the proposal', async () => {
    await setup();
    const opened = await page();
    const bob = await attached(opened, BOB, 'observer');
    const proposalId = proposalIdOf(await propose(bob, opened.pageId));
    const carol = await client(CAROL);
    const read = await getProposal(carol, opened.pageId, proposalId);
    expect(read.text).toBe(`not_attached: you are not attached to page ${opened.pageId}`);
  });
});

describe('waiting on a proposal (ADR 0042, decision 4)', () => {
  it('answers as the operator accepts, a change, and a second wait once the run settles', async () => {
    const relay = await setup();
    let finish: ((reply: InvokeReply) => void) | undefined;
    const opened = await page(undefined, {
      onInvoke: () =>
        new Promise<InvokeReply>((resolve) => {
          finish = resolve;
        }),
    });
    const bob = await attached(opened, BOB, 'observer');
    const proposalId = proposalIdOf(await propose(bob, opened.pageId));
    const started = Date.now();
    const waiting = getProposal(bob, opened.pageId, proposalId, 2800);
    await eventually(() => relay.lines.some((line) => line.includes('proposal wait started')));
    await decide(opened, proposalId, true);
    // Leaving pending is the change SPEC section 7's waitMs waits for.
    const accepted = await waiting;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(accepted.text).toBe(
      `accepted: the operator accepted proposal ${proposalId} for tool add_item, and the page is running it; call get_proposal again for its result.`,
    );
    expect(accepted.structuredContent).toMatchObject({ status: 'accepted', outcome: 'running' });
    await opened.next('invoke');
    const again = getProposal(bob, opened.pageId, proposalId, 2800);
    await eventually(
      () => relay.lines.filter((line) => line.includes('proposal wait started')).length === 2,
    );
    finish?.({ ok: true, content: 'done' });
    const read = await again;
    expect(read.text.split('\n')).toEqual([
      `accepted: the operator accepted proposal ${proposalId} for tool add_item, and the page ran it.`,
      untrustedHeader(PAGE_ORIGIN, 'add_item'),
      'done',
    ]);
  });

  it('answers page_asleep at once when the page sleeps, and the proposal then reads cancelled', async () => {
    const relay = await setup();
    const opened = await page();
    const bob = await attached(opened, BOB, 'observer');
    const proposalId = proposalIdOf(await propose(bob, opened.pageId));
    const started = Date.now();
    const waiting = getProposal(bob, opened.pageId, proposalId, 2800);
    await eventually(() => relay.lines.some((line) => line.includes('proposal wait started')));
    opened.ws.terminate();
    const woken = await waiting;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(woken.text).toBe(
      'page_asleep: the page disconnected while you waited; its proposals end with the link, so read this one again for how it ended',
    );
    expect((await getProposal(bob, opened.pageId, proposalId)).head).toBe('cancelled');
  });

  it('answers it as it stands once its time is up', async () => {
    await setup();
    const opened = await page();
    const bob = await attached(opened, BOB, 'observer');
    const proposalId = proposalIdOf(await propose(bob, opened.pageId));
    const read = await getProposal(bob, opened.pageId, proposalId, 300);
    expect(read.head).toBe('pending');
    expect(read.structuredContent).toMatchObject({ status: 'pending', proposal: proposalId });
  });

  it('shares the two wait slots with wait_for_page_state, refusing a third with a request_refused line', async () => {
    const relay = await setup();
    const opened = await page();
    const bob = await attached(opened, BOB, 'observer');
    const proposalId = proposalIdOf(await propose(bob, opened.pageId));
    const stop = new AbortController();
    const first = getProposal(bob, opened.pageId, proposalId, 2800, stop.signal).catch(
      () => undefined,
    );
    const second = waitState(bob, opened.pageId, 0, 2800, stop.signal).catch(() => undefined);
    await eventually(
      () =>
        relay.lines.some((line) => line.includes('proposal wait started')) &&
        relay.lines.some((line) => line.includes('page state wait started')),
    );
    const third = await getProposal(bob, opened.pageId, proposalId, 2800);
    expect(third.text).toBe(
      'rate_limited: you already hold 2 waits, the most one user may hold at once across pages; let one end first',
    );
    stop.abort();
    await Promise.all([first, second]);
    expect(
      relay.relay.audit
        .events()
        .filter((event) => event.type === 'request_refused' && event.tool === 'get_proposal'),
    ).toEqual([
      expect.objectContaining({ userId: 'bob', pageId: opened.pageId, outcome: 'rate_limited' }),
    ]);
  });
});

describe('the request budget (ADR 0018)', () => {
  it('refuses both tools past it, each with a request_refused record in its own name', async () => {
    const relay = await setup({ rateLimits: { requestsPerUser: 5 } });
    const opened = await page();
    const bob = await attached(opened, BOB, 'observer');
    const proposalId = proposalIdOf(await propose(bob, opened.pageId));
    let read = await getProposal(bob, opened.pageId, proposalId);
    for (let n = 0; n < 10 && !read.isError; n += 1) {
      read = await getProposal(bob, opened.pageId, proposalId);
    }
    expect(read.text).toMatch(/^rate_limited: more than 5 requests/);
    const withdrawn = await withdrawProposal(bob, opened.pageId, proposalId);
    expect(withdrawn.text).toMatch(/^rate_limited: more than 5 requests/);
    const refused = relay.relay.audit.events().filter((event) => event.type === 'request_refused');
    for (const tool of ['get_proposal', 'withdraw_proposal']) {
      expect(refused, tool).toContainEqual(
        expect.objectContaining({ tool, pageId: opened.pageId, outcome: 'rate_limited' }),
      );
    }
  });
});

describe('list_page_tools (decision 14)', () => {
  /** Each tool's name with its allowed and proposable flags. */
  async function flags(asker: Client, pageId: string) {
    const listed = await callTool(asker, 'list_page_tools', { page: pageId });
    const body = listed.structured as {
      tools: { name: string; allowed: boolean; proposable?: boolean }[];
    };
    return body.tools.map(({ name, allowed, proposable }) => ({ name, allowed, proposable }));
  }

  it('marks what an observer the page takes proposals from may propose, and nothing for anyone else', async () => {
    await setup();
    const members = await page();
    const bob = await attached(members, BOB, 'observer');
    const alice = await attached(members, ALICE, 'driver');
    expect(await flags(bob, members.pageId)).toEqual([
      { name: 'get_view', allowed: true, proposable: undefined },
      { name: 'add_item', allowed: false, proposable: true },
      { name: 'clear_board', allowed: false, proposable: true },
    ]);
    for (const tool of await flags(alice, members.pageId)) expect(tool.proposable).toBeUndefined();
    const off = await page({});
    const carol = await attached(off, CAROL, 'observer');
    for (const tool of await flags(carol, off.pageId)) expect(tool.proposable).toBeUndefined();
  });
});

describe('what an accepted run leaves its proposer (S10)', () => {
  it('keeps the text cut to 20,000 characters and no structured copy', async () => {
    await setup();
    const long = 'x'.repeat(MAX_PROPOSAL_RESULT_CHARS + 500);
    const opened = await page(undefined, { onInvoke: () => ({ ok: true, content: long }) });
    const bob = await attached(opened, BOB, 'observer');
    const proposalId = proposalIdOf(await propose(bob, opened.pageId));
    await decide(opened, proposalId, true);
    const read = await getProposal(bob, opened.pageId, proposalId, 2000);
    const [, label, text = ''] = read.text.split('\n');
    expect(label).toBe(untrustedHeader(PAGE_ORIGIN, 'add_item'));
    expect(text).toBe('x'.repeat(MAX_PROPOSAL_RESULT_CHARS));
    expect(read.text).toContain('[tabdock: truncated, 500 of 20500 characters removed]');
    expect(read.structuredContent).toBeUndefined();
  });

  it('never keeps an image, and says so ahead of the label', async () => {
    await setup();
    const opened = await page({ proposals: 'members', imageTools: ['add_item'] });
    answerWithImage(opened, { mimeType: 'image/png', data: base64(pngHeader(4, 4)) }, 'pictured');
    const bob = await attached(opened, BOB, 'observer');
    const proposalId = proposalIdOf(await propose(bob, opened.pageId));
    await decide(opened, proposalId, true);
    await delay(50);
    const result = await bob.callTool(
      {
        name: 'get_proposal',
        arguments: { page: opened.pageId, proposal: proposalId, waitMs: 2000 },
      },
      { timeout: 10_000 },
    );
    expect(result.content.map((block) => block.type)).toEqual(['text']);
    const [block] = result.content;
    expect(block?.type === 'text' ? block.text.split('\n') : []).toEqual([
      `accepted: the operator accepted proposal ${proposalId} for tool add_item, and the page ran it.`,
      '[tabdock: the page also returned an image, which proposals never keep]',
      untrustedHeader(PAGE_ORIGIN, 'add_item'),
      'pictured',
    ]);
  });
});

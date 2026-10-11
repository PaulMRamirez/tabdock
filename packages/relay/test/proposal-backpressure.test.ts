// What observers' proposals cost a page that reads slowly or not at all
// (ADR 0042 beside ADR 0024), on PageHub behind a bare WebSocketServer with
// the relay's side of the page socket made to look unread. A proposal frame
// carries up to 16 KiB of arguments and went out among the relay's own small
// frames, counted toward closing the page, while withdraw_proposal freed its
// place at once: observers proposing and withdrawing at their call rate sent
// a page frames past ADR 0024's bound, and a page on a phone's link was
// closed as not reading, ending every pending proposal with it. Now a
// proposal goes out only with room, is never counted toward the close, and
// a withdrawn one keeps its place a minute.

import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { MAX_PENDING_PROPOSALS_PER_USER } from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { createDevTokenAuth } from '../src/auth.ts';
import { resolveConfig } from '../src/config.ts';
import {
  type CallerIdentity,
  type CallOutcome,
  INVOKE_ROOM,
  MAX_UNREAD_FRAMES,
  PageHub,
  PROPOSAL_ROOM,
} from '../src/hub.ts';
import { createLogger } from '../src/log.ts';
import { createMemoryStore } from '../src/store.ts';
import { connectPage, PAGE_ORIGIN, type TestPage, TOOLS } from './helpers/page-client.ts';
import { ARGS } from './helpers/proposals.ts';
import { ALICE, BOB } from './helpers/relay.ts';
import { stall } from './helpers/stall.ts';

interface Bench {
  hub: PageHub;
  page: TestPage;
  /** The relay's side of the page's socket. */
  served: WebSocket;
  /** Every line the hub wrote, debug included. */
  lines: string[];
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function caller(user: { userId: string; displayName: string }): CallerIdentity {
  return {
    userId: user.userId,
    displayName: user.displayName,
    account: { kind: 'member', email: null },
    oauthClientId: null,
    client: null,
    agentPageId: null,
  };
}

const alice = caller(ALICE);
const bob = caller(BOB);

/** A page that takes proposals from members, with Bob attached as an observer. */
async function bench(): Promise<Bench> {
  const config = resolveConfig({
    auth: createDevTokenAuth([ALICE, BOB]),
    timings: { pairWaitMs: 10_000, attachRequestTtlMs: 20_000 },
  });
  const lines: string[] = [];
  const hub = new PageHub(
    config,
    createMemoryStore(),
    createLogger({ sink: (line) => lines.push(line), level: 'debug' }),
  );
  // As relay.ts sets it: the hub answers WebSocket pings itself.
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong: false });
  let served: WebSocket | undefined;
  server.on('connection', (ws, request) => {
    served = ws;
    hub.acceptSocket(ws, request.headers.origin ?? PAGE_ORIGIN, '127.0.0.1');
  });
  await once(server, 'listening');
  cleanups.push(async () => {
    await hub.shutdown();
    await new Promise((resolve) => {
      server.close(resolve);
    });
  });
  const { port } = server.address() as AddressInfo;
  const page = await connectPage(`ws://127.0.0.1:${String(port)}/page`, {
    tools: TOOLS,
    policy: { proposals: 'members' },
  });
  cleanups.push(() => {
    page.ws.terminate();
    return Promise.resolve();
  });
  if (served === undefined) throw new Error('the page socket never reached the hub');
  // As relay.ts waits before it listens, so arguments are checked as on a live relay.
  await hub.ready();
  await attach(hub, page, bob, 'observer');
  return { hub, page, served, lines };
}

async function attach(
  hub: PageHub,
  page: TestPage,
  who: CallerIdentity,
  role: 'driver' | 'observer',
): Promise<void> {
  // The newest code, once the last approval's fresh one has arrived.
  await page.sync();
  const pairing = hub.pairPage(who, page.code, new AbortController().signal);
  const request = await page.next('attach_request');
  page.send({ t: 'attach_decision', requestId: request.requestId, allow: true, role });
  expect(await pairing).toMatchObject({ kind: 'attached', role });
  await page.sync();
}

function propose(hub: PageHub, page: TestPage): Promise<CallOutcome> {
  return hub.callPageTool(bob, page.pageId, 'add_item', ARGS, new AbortController().signal);
}

describe("proposals and a page that is slow to read (ADR 0042, ADR 0024's bound)", () => {
  it('refuses a proposal page_busy while the page has PROPOSAL_ROOM unread, sending nothing, and takes one once it reads', async () => {
    const { hub, page, served } = await bench();
    const queue = stall(served);
    // As if a member's large invoke were still on its way over a slow link.
    queue.add(PROPOSAL_ROOM);
    expect(await propose(hub, page)).toEqual({
      kind: 'error',
      code: 'page_busy',
      message:
        'the page has not yet taken in what it was sent, so it takes no proposal now; try again shortly',
    });
    await page.sync();
    expect(page.all('proposal')).toEqual([]);
    expect(page.ws.readyState).toBe(page.ws.OPEN);
    queue.drain();
    // The refusal kept no place: all three of Bob's are still his to make.
    for (let n = 0; n < MAX_PENDING_PROPOSALS_PER_USER; n += 1) {
      expect(await propose(hub, page)).toMatchObject({ kind: 'proposed', tool: 'add_item' });
    }
    await page.sync();
    expect(page.all('proposal')).toHaveLength(MAX_PENDING_PROPOSALS_PER_USER);
  });

  it('never counts a proposal or its end toward closing the page', async () => {
    const { hub, page, served } = await bench();
    const queue = stall(served);
    const made = await propose(hub, page);
    if (made.kind !== 'proposed') throw new Error(`not proposed: ${JSON.stringify(made)}`);
    expect(hub.withdrawProposal(bob, page.pageId, made.proposalId)).toMatchObject({
      status: 'withdrawn',
    });
    await page.sync();
    expect(page.all('proposal')).toHaveLength(1);
    expect(page.all('proposal_end')).toHaveLength(1);
    // Everything queued since the stall but those two counts toward the close.
    const counted = queue.frames - 2;
    for (let n = counted + 1; n < MAX_UNREAD_FRAMES; n += 1) page.send({ t: 'ping' });
    // Its pong makes MAX_UNREAD_FRAMES counted, the most a page may leave
    // unread; had the two counted, the last pongs would have closed it.
    expect(await Promise.race([page.sync().then(() => null), page.closed])).toBeNull();
    expect(page.ws.readyState).toBe(page.ws.OPEN);
  });

  it('keeps a page that reads nothing open while an observer churns propose and withdraw, and refuses the excess', async () => {
    const { hub, page, served } = await bench();
    stall(served);
    const answers: string[] = [];
    for (let n = 0; n < 50; n += 1) {
      const outcome = await propose(hub, page);
      answers.push(outcome.kind === 'error' ? outcome.code : outcome.kind);
      if (outcome.kind === 'proposed') hub.withdrawProposal(bob, page.pageId, outcome.proposalId);
    }
    // Each withdrawn proposal keeps its place a minute, so three reach the page, not fifty.
    expect(answers.slice(0, MAX_PENDING_PROPOSALS_PER_USER)).toEqual(
      Array.from({ length: MAX_PENDING_PROPOSALS_PER_USER }, () => 'proposed'),
    );
    expect(new Set(answers.slice(MAX_PENDING_PROPOSALS_PER_USER))).toEqual(
      new Set(['rate_limited']),
    );
    await page.sync();
    expect(page.all('proposal')).toHaveLength(MAX_PENDING_PROPOSALS_PER_USER);
    expect(page.ws.readyState).toBe(page.ws.OPEN);
  });

  it("lets no proposal overtake a member's call waiting for room on the link", async () => {
    const { hub, page, served, lines } = await bench();
    await attach(hub, page, alice, 'driver');
    page.onInvoke = () => ({ ok: true, content: 'done' });
    const queue = stall(served);
    queue.add(4000);
    // Its invoke and what is queued pass INVOKE_ROOM together, so it waits for room.
    const large = hub.callPageTool(
      alice,
      page.pageId,
      'add_item',
      { label: 'x'.repeat(INVOKE_ROOM - 2000) },
      new AbortController().signal,
    );
    const deadline = Date.now() + 5000;
    while (
      !lines.some((line) => line.includes('call waits for room on the page link')) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // The queue holds far less than PROPOSAL_ROOM, but the member's call comes first.
    expect(queue.bytes).toBeLessThan(PROPOSAL_ROOM);
    expect(await propose(hub, page)).toMatchObject({ kind: 'error', code: 'page_busy' });
    // A frame of the page's own, whose leaving the queue makes the relay look at held calls again.
    await page.sync();
    queue.drain();
    expect(await large).toMatchObject({ kind: 'ok', content: 'done' });
    await page.sync();
    expect(page.all('proposal')).toEqual([]);
  });
});

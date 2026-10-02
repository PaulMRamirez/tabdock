// The section 9 limits with ADR 0009's defaults, each shrunk here to a few:
// users per page, calls per user per page per window, page sockets per address
// and page sessions in total.

import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, DEFAULT_RATE_LIMITS } from '../src/index.ts';
import {
  connectPage,
  type InvokeFrame,
  type InvokeReply,
  openSocket,
  type PageOptions,
  TestPage,
  TOOLS,
  UpgradeRefused,
} from './helpers/page-client.ts';
import {
  ALICE,
  BOB,
  callTool,
  connectClient,
  delay,
  eventually,
  pairAndApprove,
  startRelay,
  type TestRelay,
} from './helpers/relay.ts';

let current: TestRelay | undefined;
const pages: TestPage[] = [];
const clients: Client[] = [];

async function setup(options: Parameters<typeof startRelay>[0] = {}): Promise<TestRelay> {
  current = await startRelay(options);
  return current;
}

async function page(options: PageOptions = {}): Promise<TestPage> {
  if (!current) throw new Error('no relay');
  const opened = await connectPage(current.relay.pageUrl, { tools: TOOLS, ...options });
  pages.push(opened);
  return opened;
}

async function client(user = ALICE): Promise<Client> {
  if (!current) throw new Error('no relay');
  const connected = await connectClient(current.relay, user);
  clients.push(connected);
  return connected;
}

afterEach(async () => {
  for (const connected of clients.splice(0)) await connected.close();
  for (const opened of pages.splice(0)) opened.ws.terminate();
  await current?.close();
  current = undefined;
});

function echo(frame: InvokeFrame): InvokeReply {
  return { ok: true, content: JSON.stringify(frame.arguments) };
}

async function refusal(url: string): Promise<number> {
  try {
    pages.push(new TestPage(await openSocket(url)));
    return 101;
  } catch (error) {
    if (error instanceof UpgradeRefused) return error.status;
    throw error;
  }
}

describe('ADR 0009 defaults', () => {
  it('are the numbers the ADR gives', () => {
    expect(DEFAULT_LIMITS).toEqual({
      sessionsPerUser: 20,
      sessions: 1000,
      usersPerPage: 10,
      queueDepth: 32,
      pageSocketsPerAddress: 20,
      pageSessions: 1000,
    });
    expect(DEFAULT_RATE_LIMITS.callsPerUserPerPage).toBe(120);
    expect(DEFAULT_RATE_LIMITS.windowMs).toBe(60_000);
  });
});

describe('users per page (S9)', () => {
  const FULL =
    'page_busy: the page already has 1 users attached, the most it allows; its operator can revoke someone to make room';

  it('a full page refuses pair_page before its operator is asked', async () => {
    const { lines } = await setup({ limits: { usersPerPage: 1 } });
    const opened = await page();
    await pairAndApprove(await client(), opened);
    const bob = await client(BOB);
    expect(await callTool(bob, 'pair_page', { code: opened.code })).toMatchObject({
      isError: true,
      text: FULL,
    });
    await opened.sync();
    expect(opened.all('attach_request')).toHaveLength(1);
    expect(lines.some((line) => line.includes('the page holds the most users allowed'))).toBe(true);
    // Someone already attached pairing again is not a new user.
    expect((await callTool(await client(), 'pair_page', { code: opened.code })).isError).toBe(
      false,
    );
  });

  it('autoApprove observer is refused the same way', async () => {
    await setup({ limits: { usersPerPage: 1 } });
    const opened = await page({ policy: { autoApprove: 'observer' } });
    expect((await callTool(await client(), 'pair_page', { code: opened.code })).isError).toBe(
      false,
    );
    expect((await callTool(await client(BOB), 'pair_page', { code: opened.code })).text).toBe(FULL);
  });

  it('a page that fills up while the operator decides ends the request with page_busy', async () => {
    await setup({ limits: { usersPerPage: 1 } });
    const opened = await page();
    const alice = await client();
    const bob = await client(BOB);
    const alicePairs = callTool(alice, 'pair_page', { code: opened.code });
    const aliceRequest = await opened.next('attach_request');
    const bobPairs = callTool(bob, 'pair_page', { code: (await opened.next('pairing')).code });
    const bobRequest = await opened.next('attach_request');
    opened.send({ t: 'attach_decision', requestId: aliceRequest.requestId, allow: true });
    expect((await alicePairs).isError).toBe(false);
    opened.send({ t: 'attach_decision', requestId: bobRequest.requestId, allow: true });
    expect(await bobPairs).toMatchObject({
      isError: true,
      text: 'page_busy: the page filled up meanwhile and has 1 users attached, the most it allows; its operator can revoke someone to make room',
    });
    await opened.sync();
    expect(
      opened
        .all('roster')
        .at(-1)
        ?.attachments.map((entry) => entry.userId),
    ).toEqual(['alice']);
    expect((await callTool(bob, 'list_pages')).structured).toEqual({ pages: [] });
  });

  it('a revoke makes room again', async () => {
    await setup({ limits: { usersPerPage: 1 } });
    const opened = await page();
    await pairAndApprove(await client(), opened);
    opened.send({ t: 'revoke', userId: 'alice' });
    await opened.sync();
    await pairAndApprove(await client(BOB), opened);
  });
});

describe('calls per user per page (S9)', () => {
  it('refuses calls past the limit with rate_limited, counting invalid ones, until the window passes', async () => {
    const { relay } = await setup({ rateLimits: { callsPerUserPerPage: 3, windowMs: 1000 } });
    const opened = await page({ onInvoke: echo });
    const other = await page({ onInvoke: echo });
    const alice = await client();
    const bob = await client(BOB);
    await pairAndApprove(alice, opened);
    await pairAndApprove(alice, other);
    await pairAndApprove(bob, opened);
    const call = (who: Client, pageId: string, args: Record<string, unknown> = {}) =>
      callTool(who, 'call_page_tool', { page: pageId, tool: 'get_view', arguments: args });

    expect((await call(alice, opened.pageId)).isError).toBe(false);
    // A call the relay refuses still counts, so nobody spins on invalid calls for free.
    expect((await call(alice, opened.pageId, { unexpected: true })).text).toMatch(
      /^invalid_arguments: /,
    );
    expect((await call(alice, opened.pageId)).isError).toBe(false);
    expect((await call(alice, opened.pageId)).text).toBe(
      'rate_limited: more than 3 calls to this page in 1 second; wait and try again',
    );
    // The limit is per user and per page.
    expect((await call(bob, opened.pageId)).isError).toBe(false);
    expect((await call(alice, other.pageId)).isError).toBe(false);
    await delay(1050);
    expect((await call(alice, opened.pageId)).isError).toBe(false);
    expect(relay.audit.records().map((record) => record.outcome)).toEqual([
      'ok',
      'invalid_arguments',
      'ok',
      'rate_limited',
      'ok',
      'ok',
      'ok',
    ]);
    expect(opened.all('invoke')).toHaveLength(4);
  });
});

describe('page sockets (S9)', () => {
  it('refuses a socket past the per-address limit with 429, before upgrading', async () => {
    const { relay, lines } = await setup({ limits: { pageSocketsPerAddress: 2 } });
    await page();
    await page();
    expect(await refusal(relay.pageUrl)).toBe(429);
    expect(lines.some((line) => line.includes('too many from one address'))).toBe(true);
    // A closed socket frees its place.
    const first = pages.shift();
    await first?.close();
    await eventually(async () => (await refusal(relay.pageUrl)) === 101);
  });

  it('makes room past the page session limit by ending the page asleep longest, and refuses with 503 when none sleeps', async () => {
    const { relay } = await setup({ limits: { pageSessions: 2 } });
    const sleeper = await page();
    const awake = await page();
    const alice = await client();
    await pairAndApprove(alice, sleeper);
    expect(await refusal(relay.pageUrl)).toBe(503);

    const token = sleeper.welcome?.resumeToken ?? '';
    await sleeper.close();
    await eventually(async () => {
      const listed = await callTool(alice, 'list_pages');
      return JSON.stringify(listed.structured).includes('"asleep"');
    });
    const newcomer = await page();
    expect(newcomer.welcome?.resumed).toBe(false);
    // The sleeper is gone, as at the end of its resume window: attachments deleted, no resume.
    expect((await callTool(alice, 'list_pages')).structured).toEqual({
      pages: [expect.objectContaining({ page: sleeper.pageId, state: 'gone' })],
    });
    expect(
      (await callTool(alice, 'call_page_tool', { page: sleeper.pageId, tool: 'get_view' })).text,
    ).toMatch(/^page_gone: /);
    await newcomer.close();
    const back = await page({ resumeToken: token });
    expect(back.welcome?.resumed).toBe(false);
    expect(awake.ws.readyState).toBe(awake.ws.OPEN);
  });
});

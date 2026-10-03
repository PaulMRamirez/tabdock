// The section 9 limits with ADR 0009's defaults, each shrunk here to a few:
// users per page, calls per user per page per window, tools frames per socket
// and per address, schema nodes walked per tools frame and per tool, page
// sockets and page sessions per address, and page sessions in total.

import type { Client } from '@modelcontextprotocol/client';
import { CLOSE_DETACH, type PageTool } from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_FRAME_SCHEMA_NODES, MAX_TOOL_SCHEMA_NODES } from '../src/hub.ts';
import { createMemoryStore, DEFAULT_LIMITS, DEFAULT_RATE_LIMITS } from '../src/index.ts';
import {
  connectPage,
  type InvokeFrame,
  type InvokeReply,
  openSocket,
  PAGE_ORIGIN,
  type PageOptions,
  READ_TOOL,
  TestPage,
  TOOLS,
  UpgradeRefused,
  WRITE_TOOL,
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
      pageSessionsPerAddress: 20,
      pageSessions: 1000,
      pairSessions: 200,
    });
    expect(DEFAULT_RATE_LIMITS.callsPerUserPerPage).toBe(120);
    // Pairing counts per user and per page, never per address (S3, ADR 0016).
    expect(DEFAULT_RATE_LIMITS.pairAttemptsPerUser).toBe(10);
    expect(DEFAULT_RATE_LIMITS.pairAttemptsPerPage).toBe(30);
    expect(Object.keys(DEFAULT_RATE_LIMITS).filter((key) => key.startsWith('pair'))).toEqual([
      'pairAttemptsPerUser',
      'pairAttemptsPerPage',
      'pairPreviewsPerNonce',
    ]);
    expect(DEFAULT_RATE_LIMITS.windowMs).toBe(60_000);
    expect(DEFAULT_RATE_LIMITS.toolsFramesPerSocket).toBe(10);
    expect(DEFAULT_RATE_LIMITS.toolsFramesPerAddress).toBe(30);
    expect(DEFAULT_RATE_LIMITS.toolsFramesWindowMs).toBe(10_000);
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
    // A generous check budget, so the invalid call is refused by its check
    // however loaded the test run is; the limit, not the budget, is under test.
    const { relay } = await setup({
      rateLimits: { callsPerUserPerPage: 3, windowMs: 1000 },
      timings: { argumentCheckMs: 2000 },
    });
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

describe('tools frames per socket (S9)', () => {
  it('closes a socket that sends more tools frames than its budget, leaving the page asleep', async () => {
    const { lines } = await setup({
      rateLimits: { toolsFramesPerSocket: 3, toolsFramesWindowMs: 1000 },
    });
    // connectPage sends the first tools frame itself.
    const opened = await page();
    const alice = await client();
    await pairAndApprove(alice, opened);
    opened.send({ t: 'tools', tools: TOOLS });
    opened.send({ t: 'tools', tools: TOOLS });
    await opened.sync();
    expect(opened.ws.readyState).toBe(opened.ws.OPEN);
    opened.send({ t: 'tools', tools: TOOLS });
    expect(await opened.closed).toEqual({ code: 1008, reason: 'too many tools frames' });
    expect(lines.some((line) => line.includes('too many tools frames'))).toBe(true);
    // A policy close is not a detach: the page sleeps and can resume with its attachments.
    const back = await page({ resumeToken: opened.welcome?.resumeToken ?? '' });
    expect(back.welcome?.resumed).toBe(true);
    expect(back.welcome?.roster).toMatchObject([{ userId: 'alice' }]);
  });

  it('counts over a sliding window, so a page that spaces its changes out is never closed', async () => {
    await setup({ rateLimits: { toolsFramesPerSocket: 2, toolsFramesWindowMs: 300 } });
    const opened = await page();
    for (let i = 0; i < 4; i += 1) {
      await delay(200);
      opened.send({ t: 'tools', tools: TOOLS });
      await opened.sync();
    }
    expect(opened.ws.readyState).toBe(opened.ws.OPEN);
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

/** A second remote address on the loopback, for per-address limits. */
const OTHER_ADDRESS = '127.0.0.2';

async function stateFor(who: Client, pageId: string): Promise<string | undefined> {
  const listed = (await callTool(who, 'list_pages')).structured as {
    pages: { page: string; state: string }[];
  };
  return listed.pages.find((entry) => entry.page === pageId)?.state;
}

/** Closes a page's socket and waits until the relay has seen it go. */
async function drop(who: Client, opened: TestPage): Promise<void> {
  await opened.close();
  await eventually(async () => (await stateFor(who, opened.pageId)) === 'asleep');
}

describe('page sessions (S9)', () => {
  it('lets one address churning page sockets end only its own pages, with page records bounded', async () => {
    const store = createMemoryStore();
    const { relay } = await setup({
      store,
      limits: { pageSessionsPerAddress: 3, pageSessions: 10 },
      timings: { resumeWindowMs: 60_000, goneTombstoneMs: 60_000 },
    });
    const bobsPage = await page({ localAddress: OTHER_ADDRESS });
    const bob = await client(BOB);
    await pairAndApprove(bob, bobsPage);
    const token = bobsPage.welcome?.resumeToken ?? '';
    await drop(bob, bobsPage);

    // Long title and url, as a hostile page would send; half detach, which skips the resume window.
    for (let i = 0; i < 40; i += 1) {
      const churned = await connectPage(relay.pageUrl, {
        title: 'T'.repeat(300),
        url: `${PAGE_ORIGIN}/${'u'.repeat(2000)}`,
      });
      churned.ws.close(i % 2 === 0 ? 1000 : CLOSE_DETACH);
      await churned.closed;
      await eventually(() => store.pages.get(churned.pageId)?.state !== 'awake');
    }

    const records = store.pages.all();
    const sessions = records.filter((record) => record.state !== 'gone');
    const gone = records.filter((record) => record.state === 'gone');
    // The churner's own three, plus Bob's page; gone records at most one per page session.
    expect(sessions.length).toBeLessThanOrEqual(4);
    expect(gone.length).toBeLessThanOrEqual(10);
    // A gone record keeps only what page_gone, list_pages and detach_page read.
    for (const record of gone) {
      expect(record.url).toBe('');
      expect(record.tools).toEqual([]);
      expect(record.policy.consequentialTools).toEqual([]);
    }
    expect(await stateFor(bob, bobsPage.pageId)).toBe('asleep');
    const back = await page({ resumeToken: token, localAddress: OTHER_ADDRESS });
    expect(back.welcome?.resumed).toBe(true);
    expect(back.pageId).toBe(bobsPage.pageId);
    expect(back.welcome?.roster).toMatchObject([{ userId: 'bob' }]);
  });

  it('ends its own page asleep longest for an address at its cap, and refuses with 1013 when none sleeps', async () => {
    const { relay } = await setup({ limits: { pageSessionsPerAddress: 2 } });
    const elsewhere = await page({ localAddress: OTHER_ADDRESS });
    const first = await page();
    await page();
    const alice = await client();
    const bob = await client(BOB);
    await pairAndApprove(bob, elsewhere);
    await pairAndApprove(alice, first);

    // Both of this address's sessions are awake, so a third has nothing to make way.
    const refused = new TestPage(await openSocket(relay.pageUrl));
    pages.push(refused);
    refused.send({
      t: 'hello',
      v: 1,
      title: 't',
      url: `${PAGE_ORIGIN}/`,
      adapterVersion: 'test',
      policy: {},
    });
    expect(await refused.closed).toEqual({
      code: 1013,
      reason: 'too many pages from this address; try again later',
    });
    expect(refused.all('welcome')).toEqual([]);

    // The other address's page has slept longer, but only this address's own sleeper makes way.
    await drop(bob, elsewhere);
    await delay(20);
    await drop(alice, first);
    const newcomer = await page();
    expect(newcomer.welcome?.resumed).toBe(false);
    expect(await stateFor(alice, first.pageId)).toBe('gone');
    expect(await stateFor(bob, elsewhere.pageId)).toBe('asleep');
  });

  it('still holds an address to its cap after one of its pages slept and resumed', async () => {
    const { relay } = await setup({ limits: { pageSessionsPerAddress: 2 } });
    const first = await page();
    const alice = await client();
    await pairAndApprove(alice, first);
    await drop(alice, first);
    const back = await page({ resumeToken: first.welcome?.resumeToken ?? '' });
    expect(back.welcome?.resumed).toBe(true);
    await page();

    // Both of this address's sessions are awake again, so the resumed one must not make way.
    const refused = new TestPage(await openSocket(relay.pageUrl));
    pages.push(refused);
    refused.send({
      t: 'hello',
      v: 1,
      title: 't',
      url: `${PAGE_ORIGIN}/`,
      adapterVersion: 'test',
      policy: {},
    });
    expect(await refused.closed).toEqual({
      code: 1013,
      reason: 'too many pages from this address; try again later',
    });
    expect(refused.all('welcome')).toEqual([]);
    expect(await stateFor(alice, first.pageId)).toBe('awake');
  });

  it('lets a sleeper resume at the total cap without ending itself or any other sleeper', async () => {
    await setup({ limits: { pageSessions: 3 } });
    const older = await page();
    const younger = await page();
    await page();
    const alice = await client();
    const bob = await client(BOB);
    await pairAndApprove(alice, older);
    await pairAndApprove(bob, younger);
    await drop(alice, older);
    await delay(20);
    await drop(bob, younger);

    // Two asleep and one awake: the relay is at its cap, and a resume needs no room.
    const youngerBack = await page({ resumeToken: younger.welcome?.resumeToken ?? '' });
    expect(youngerBack.welcome?.resumed).toBe(true);
    expect(youngerBack.pageId).toBe(younger.pageId);
    expect(youngerBack.welcome?.roster).toMatchObject([{ userId: 'bob' }]);
    expect(await stateFor(alice, older.pageId)).toBe('asleep');

    // Now the only sleeper, which would once have ended itself on the way back.
    const olderBack = await page({ resumeToken: older.welcome?.resumeToken ?? '' });
    expect(olderBack.welcome?.resumed).toBe(true);
    expect(olderBack.pageId).toBe(older.pageId);
    expect(olderBack.welcome?.roster).toMatchObject([{ userId: 'alice' }]);
    expect(await stateFor(bob, younger.pageId)).toBe('awake');
  });

  it('makes room for a new page at the total cap by ending the older of two sleepers', async () => {
    await setup({ limits: { pageSessions: 3 } });
    const older = await page({ localAddress: OTHER_ADDRESS });
    const younger = await page({ localAddress: OTHER_ADDRESS });
    await page({ localAddress: OTHER_ADDRESS });
    const alice = await client();
    const bob = await client(BOB);
    await pairAndApprove(alice, older);
    await pairAndApprove(bob, younger);
    await drop(alice, older);
    await delay(20);
    await drop(bob, younger);

    const newcomer = await page();
    expect(newcomer.welcome?.resumed).toBe(false);
    expect(await stateFor(alice, older.pageId)).toBe('gone');
    expect(await stateFor(bob, younger.pageId)).toBe('asleep');
    await newcomer.close();
    const back = await page({
      resumeToken: younger.welcome?.resumeToken ?? '',
      localAddress: OTHER_ADDRESS,
    });
    expect(back.welcome?.resumed).toBe(true);
    expect(back.pageId).toBe(younger.pageId);
  });

  it("ends the new page's own address's sleeper at the total cap before an older one from elsewhere", async () => {
    await setup({ limits: { pageSessions: 3 } });
    const elsewhere = await page({ localAddress: OTHER_ADDRESS });
    const own = await page();
    await page();
    const alice = await client();
    const bob = await client(BOB);
    await pairAndApprove(bob, elsewhere);
    await pairAndApprove(alice, own);
    await drop(bob, elsewhere);
    await delay(20);
    await drop(alice, own);

    const newcomer = await page();
    expect(newcomer.welcome?.resumed).toBe(false);
    expect(await stateFor(alice, own.pageId)).toBe('gone');
    expect(await stateFor(bob, elsewhere.pageId)).toBe('asleep');
  });
});

describe('tools frames per address (S9)', () => {
  it('shares one budget across every socket from an address and across reconnects, closing past it with 1008', async () => {
    const { relay, lines } = await setup({
      rateLimits: {
        toolsFramesPerSocket: 10,
        toolsFramesPerAddress: 4,
        toolsFramesWindowMs: 10_000,
      },
    });
    // connectPage sends one tools frame each: two of this address's four.
    const first = await page();
    const second = await page();
    const elsewhere = await page({ localAddress: OTHER_ADDRESS });
    first.send({ t: 'tools', tools: TOOLS });
    second.send({ t: 'tools', tools: TOOLS });
    await first.sync();
    await second.sync();
    expect(first.ws.readyState).toBe(first.ws.OPEN);
    expect(second.ws.readyState).toBe(second.ws.OPEN);

    // Each socket is far inside its own budget, but the address has spent its own.
    first.send({ t: 'tools', tools: TOOLS });
    expect(await first.closed).toEqual({
      code: 1008,
      reason: 'too many tools frames from this address',
    });
    second.send({ t: 'tools', tools: TOOLS });
    expect(await second.closed).toEqual({
      code: 1008,
      reason: 'too many tools frames from this address',
    });
    expect(lines.some((line) => line.includes('too many tools frames from its address'))).toBe(
      true,
    );

    // Another address keeps a budget of its own.
    for (let i = 0; i < 3; i += 1) elsewhere.send({ t: 'tools', tools: TOOLS });
    await elsewhere.sync();
    expect(elsewhere.ws.readyState).toBe(elsewhere.ws.OPEN);

    // A page that reconnects from the address does not start over: it sleeps
    // after the policy close and resumes, but its tools wait for the window.
    const back = await connectPage(relay.pageUrl, {
      resumeToken: first.welcome?.resumeToken ?? '',
    });
    pages.push(back);
    expect(back.welcome?.resumed).toBe(true);
    back.send({ t: 'tools', tools: TOOLS });
    expect(await back.closed).toEqual({
      code: 1008,
      reason: 'too many tools frames from this address',
    });
  });
});

describe('schema nodes per tools frame and per tool (S9, ADR 0010)', () => {
  /**
   * A read-only tool requiring a string x beside `width` empty properties:
   * width + 7 schema nodes, and far too long to show, so clients see a stub
   * either way and only the argument check tells a walked tool from one that
   * was not.
   */
  function wide(name: string, width: number, description = `${name}.`): PageTool {
    const properties: Record<string, unknown> = { x: { type: 'string' } };
    for (let i = 0; i < width; i += 1) properties[`p${String(i)}`] = {};
    return {
      name,
      description,
      inputSchema: { type: 'object', required: ['x'], properties },
      annotations: { readOnlyHint: true },
    };
  }
  /** Within the per-tool limit and over a fifth of the frame's cap, so four fit in one frame and five do not. */
  const WIDTH = Math.floor(MAX_FRAME_SCHEMA_NODES / 4.5);
  const CAPPED = `[tabdock: schema removed, the page's tools hold more than ${String(MAX_FRAME_SCHEMA_NODES)} schema nodes in all]`;
  const OVER_TOOL = `[tabdock: schema removed, more than ${String(MAX_TOOL_SCHEMA_NODES)} schema nodes]`;

  it('sizes the tools these tests list against both limits', () => {
    expect(WIDTH + 7).toBeLessThanOrEqual(MAX_TOOL_SCHEMA_NODES);
    expect(4 * (WIDTH + 7)).toBeLessThanOrEqual(MAX_FRAME_SCHEMA_NODES);
    expect(5 * (WIDTH + 7)).toBeGreaterThan(MAX_FRAME_SCHEMA_NODES);
    expect(MAX_TOOL_SCHEMA_NODES).toBeLessThan(MAX_FRAME_SCHEMA_NODES);
  });

  /**
   * Whether a call is refused by the argument check is what these tests read,
   * so the check gets a generous budget: a large schema's first check must
   * never overrun under a loaded test run and pass for a tool left unchecked.
   */
  async function attached(): Promise<{ opened: TestPage; alice: Client; lines: string[] }> {
    const { lines } = await setup({ timings: { argumentCheckMs: 2000 } });
    const opened = await page({ tools: [], onInvoke: echo });
    const alice = await client();
    await pairAndApprove(alice, opened);
    return { opened, alice, lines };
  }

  async function relist(opened: TestPage, tools: PageTool[]): Promise<void> {
    opened.send({ t: 'tools', tools });
    await opened.sync();
  }

  async function schemaOf(alice: Client, pageId: string, tool: string): Promise<unknown> {
    const listed = (await callTool(alice, 'list_page_tools', { page: pageId })).structured as {
      tools: { name: string; description: string; inputSchema: unknown }[];
    };
    return listed.tools.find((entry) => entry.name === tool)?.inputSchema;
  }

  /** Whether a call with these arguments is refused by the relay's check. */
  async function refused(
    alice: Client,
    pageId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    const outcome = await callTool(alice, 'call_page_tool', {
      page: pageId,
      tool,
      arguments: args,
    });
    if (outcome.isError) expect(outcome.text).toMatch(/^invalid_arguments: /);
    return outcome.isError;
  }

  /** Whether a call without the required x is refused by the relay's check. */
  function checked(alice: Client, pageId: string, tool: string): Promise<boolean> {
    return refused(alice, pageId, tool, {});
  }

  function warnings(lines: string[], phrase: string): string[] {
    return lines.filter((line) => line.includes(phrase));
  }

  it('lists tools past the frame cap with a stub and lets their calls through unchecked, while those before it are checked', async () => {
    const { opened, alice, lines } = await attached();
    const fitting = ['w1', 'w2', 'w3', 'w4'].map((name) => wide(name, WIDTH));
    await relist(opened, [...fitting, wide('w5', WIDTH), READ_TOOL]);

    expect(await checked(alice, opened.pageId, 'w1')).toBe(true);
    expect(await checked(alice, opened.pageId, 'w4')).toBe(true);
    expect(await schemaOf(alice, opened.pageId, 'w5')).toEqual({
      type: 'object',
      description: CAPPED,
    });
    expect(await checked(alice, opened.pageId, 'w5')).toBe(false);
    // The tool that crossed the cap used up what was left of it, so every tool
    // after it is past the cap too, however small.
    expect(await schemaOf(alice, opened.pageId, 'get_view')).toEqual({
      type: 'object',
      description: CAPPED,
    });
    expect(await refused(alice, opened.pageId, 'get_view', { unexpected: true })).toBe(false);
    expect(warnings(lines, 'more schema than the relay walks per frame')).toHaveLength(1);
    expect(warnings(lines, 'more schema than the relay walks per tool')).toHaveLength(0);
  });

  it('stubs a tool over the per-tool limit alone, so the tools after it keep their schemas and checks, also after a re-list', async () => {
    const { opened, alice, lines } = await attached();
    // More nodes than the whole frame's cap: counted no further than the
    // per-tool limit, it must not use up the frame for the tools after it.
    const big = wide('big', MAX_FRAME_SCHEMA_NODES);
    const frames = [
      [big, READ_TOOL, WRITE_TOOL],
      // The same tools again: all three are reused, big included, with no walk.
      [big, READ_TOOL, WRITE_TOOL],
      // get_view changed, so it is walked again, still behind big.
      [big, { ...READ_TOOL, description: 'The viewport, again.' }, WRITE_TOOL],
    ];
    for (const tools of frames) {
      await relist(opened, tools);
      expect(await schemaOf(alice, opened.pageId, 'big')).toEqual({
        type: 'object',
        description: OVER_TOOL,
      });
      expect(await checked(alice, opened.pageId, 'big')).toBe(false);
      expect(await schemaOf(alice, opened.pageId, 'get_view')).toEqual(READ_TOOL.inputSchema);
      expect(await refused(alice, opened.pageId, 'get_view', { unexpected: true })).toBe(true);
      expect(await schemaOf(alice, opened.pageId, 'add_item')).toEqual(WRITE_TOOL.inputSchema);
      expect(await refused(alice, opened.pageId, 'add_item', { label: 5 })).toBe(true);
    }
    // Walked once: an unchanged big tool is reused like any other, so only the first frame warns.
    expect(warnings(lines, 'more schema than the relay walks per tool')).toHaveLength(1);
    expect(warnings(lines, 'more schema than the relay walks per frame')).toHaveLength(0);
  });

  it('reuses unchanged over-limit tools on a re-list, so tools stubbed behind four of them recover', async () => {
    const { opened, alice } = await attached();
    // Three over-limit tools use most of the frame and a fourth the rest, so
    // get_view behind them is past the frame cap on the first frame.
    const bigs = ['b1', 'b2', 'b3', 'b4'].map((name) => wide(name, 2 * MAX_TOOL_SCHEMA_NODES));
    await relist(opened, [...bigs, READ_TOOL]);
    expect(await schemaOf(alice, opened.pageId, 'get_view')).toEqual({
      type: 'object',
      description: CAPPED,
    });
    // Sent again unchanged, the three walked bigs cost nothing, so the fourth
    // is walked on its own limit and get_view fits behind it.
    await relist(opened, [...bigs, READ_TOOL]);
    expect(await schemaOf(alice, opened.pageId, 'get_view')).toEqual(READ_TOOL.inputSchema);
    expect(await refused(alice, opened.pageId, 'get_view', { unexpected: true })).toBe(true);
    for (const name of ['b1', 'b4']) {
      expect(await schemaOf(alice, opened.pageId, name)).toEqual({
        type: 'object',
        description: OVER_TOOL,
      });
    }
  });

  it('charges a tool over the per-tool limit no more than the limit, while the frame cap still holds', async () => {
    const { opened, alice } = await attached();
    // Each costs the frame at most the limit plus one node, so this many leave room for get_view.
    const count = Math.floor(MAX_FRAME_SCHEMA_NODES / (MAX_TOOL_SCHEMA_NODES + 1));
    const bigs = Array.from({ length: count }, (_, i) =>
      wide(`big${String(i)}`, 2 * MAX_TOOL_SCHEMA_NODES),
    );
    await relist(opened, [...bigs, READ_TOOL]);
    expect(await schemaOf(alice, opened.pageId, 'get_view')).toEqual(READ_TOOL.inputSchema);
    expect(await refused(alice, opened.pageId, 'get_view', { unexpected: true })).toBe(true);

    // Changed, so walked again, and one more uses up the rest of the frame, so
    // a changed get_view after them is past the cap: no number of large tools
    // makes one frame walk more.
    await relist(opened, [
      ...bigs.map((big) => ({ ...big, description: `${big.description} Changed.` })),
      wide('one_more', 2 * MAX_TOOL_SCHEMA_NODES),
      { ...READ_TOOL, description: 'The viewport, again.' },
    ]);
    expect(await schemaOf(alice, opened.pageId, 'get_view')).toEqual({
      type: 'object',
      description: CAPPED,
    });
    expect(await refused(alice, opened.pageId, 'get_view', { unexpected: true })).toBe(false);
  });

  it('walks only tools that changed, so one sent again unchanged costs nothing against the cap', async () => {
    const { opened, alice } = await attached();
    const four = (description?: string) =>
      ['w1', 'w2', 'w3', 'w4'].map((name) => wide(name, WIDTH, description ?? `${name}.`));
    await relist(opened, four());
    // The four are the same as before, so only second is walked, and it fits.
    await relist(opened, [...four(), wide('second', WIDTH)]);
    expect(await checked(alice, opened.pageId, 'w1')).toBe(true);
    expect(await checked(alice, opened.pageId, 'second')).toBe(true);

    // Changed tools are walked again: the four fit, and second, unchanged, is kept as it was.
    await relist(opened, [...four('Changed.'), wide('second', WIDTH)]);
    let listed = (await callTool(alice, 'list_page_tools', { page: opened.pageId })).structured as {
      tools: { name: string; description: string }[];
    };
    expect(listed.tools.map((tool) => tool.description)).toEqual([
      'Changed.',
      'Changed.',
      'Changed.',
      'Changed.',
      'second.',
    ]);
    expect(await checked(alice, opened.pageId, 'second')).toBe(true);

    // All changed: the cap applies, and second goes unchecked.
    await relist(opened, [...four('Again.'), wide('second', WIDTH, 'Two.')]);
    expect(await checked(alice, opened.pageId, 'w4')).toBe(true);
    expect(await checked(alice, opened.pageId, 'second')).toBe(false);

    // Once the four are unchanged again, second fits and is walked and checked once more.
    await relist(opened, [...four('Again.'), wide('second', WIDTH, 'Two.')]);
    expect(await checked(alice, opened.pageId, 'second')).toBe(true);
    listed = (await callTool(alice, 'list_page_tools', { page: opened.pageId })).structured as {
      tools: { name: string; description: string }[];
    };
    expect(listed.tools.map((tool) => tool.description)).toEqual([
      'Again.',
      'Again.',
      'Again.',
      'Again.',
      'Two.',
    ]);
  });
});

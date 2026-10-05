// How a member hears that their first-class list changed (ADRs 0025 and
// 0032, A5.1). The list never waits: a tools/list answered after a revoke or
// a downgrade no longer shows what the change took away, on either revision.
// Only the notification waits: one goes at once when none went to that user
// in the last 10 s, otherwise one at the interval's end if the list's digest
// still differs from the last one sent, and none when it does not, so a page
// that drops and returns within the interval sends nothing more. Each user
// hears of their own list only: on their 2025-era sessions' GET streams and
// on their 2026-07-28 listen streams, which a handler of their own serves,
// never another user's (S13). A 2026-07-28 list says it may be kept 10 s,
// privately. And a page that changes its tools every second cannot make a
// member's four clients spend the member's request budget by listing again.

import type { McpHttpHandler } from '@modelcontextprotocol/server';
import {
  FIRST_CLASS_LIST_TTL_MS,
  FIRST_CLASS_NOTIFY_INTERVAL_MS,
  type PageTool,
} from '@tabdock/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, type DevTokenUser } from '../src/index.ts';
import { ListenStreams } from '../src/listen-streams.ts';
import type { RequestBudget } from '../src/mcp.ts';
import { PageToolNotifier } from '../src/page-tool-notifier.ts';
import { createRepeatedLog } from '../src/repeated-lines.ts';
import { connectPage, type TestPage, TOOLS, WRITE_TOOL } from './helpers/page-client.ts';
import { openSession } from './helpers/raw-mcp.ts';
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
import { legacyExchange, modernExchange } from './helpers/wire.ts';
import type { Client } from '@modelcontextprotocol/client';

let current: TestRelay | undefined;
const pages: TestPage[] = [];
const clients: Client[] = [];
const streams: Heard[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const stream of streams.splice(0)) stream.close();
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const page of pages.splice(0)) page.ws.terminate();
  await current?.close();
  current = undefined;
});

/** A stream a client holds open, counting the tool list changes it hears. */
interface Heard {
  status: number;
  heard(): number;
  close(): void;
}

function hear(response: Response, abort: AbortController): Heard {
  let count = 0;
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  void (async () => {
    if (!reader) return;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffered += decoder.decode(chunk.value, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const message = JSON.parse(line.slice(6)) as { method?: string };
          if (message.method === 'notifications/tools/list_changed') count += 1;
        }
      }
    } catch {
      // Ended by close().
    }
  })();
  const heard: Heard = {
    status: response.status,
    heard: () => count,
    close: () => {
      abort.abort();
    },
  };
  streams.push(heard);
  return heard;
}

/** A 2026-07-28 subscriptions/listen for tool list changes, held open. */
async function listen(user: DevTokenUser): Promise<Heard> {
  if (!current) throw new Error('no relay');
  const abort = new AbortController();
  const response = await fetch(current.relay.mcpUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Method': 'subscriptions/listen',
      'Mcp-Protocol-Version': '2026-07-28',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `listen-${user.userId}-${String(streams.length)}`,
      method: 'subscriptions/listen',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'notify-test', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
        notifications: { toolsListChanged: true },
      },
    }),
    signal: abort.signal,
  });
  expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
  return hear(response, abort);
}

/** A 2025-era session and its listening GET stream, held open. */
async function session(user: DevTokenUser): Promise<{ id: string; stream: Heard }> {
  if (!current) throw new Error('no relay');
  const id = await openSession(current.relay, user);
  const abort = new AbortController();
  const response = await fetch(current.relay.mcpUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${user.token}`,
      Accept: 'text/event-stream',
      'Mcp-Session-Id': id,
      'Mcp-Protocol-Version': '2025-11-25',
    },
    signal: abort.signal,
  });
  expect(response.status).toBe(200);
  return { id, stream: hear(response, abort) };
}

async function setup(options: Parameters<typeof startRelay>[0] = {}): Promise<TestRelay> {
  // A GET stream's headers go out with its first bytes, a keep-alive at the
  // latest, so a short interval opens the 2025-era streams quickly.
  current = await startRelay({
    firstClassTools: true,
    ...options,
    timings: { sseKeepAliveMs: 100, ...options.timings },
  });
  return current;
}

async function page(tools: PageTool[] = TOOLS): Promise<TestPage> {
  if (!current) throw new Error('no relay');
  const opened = await connectPage(current.relay.pageUrl, { tools });
  pages.push(opened);
  return opened;
}

async function client(user: DevTokenUser = ALICE): Promise<Client> {
  if (!current) throw new Error('no relay');
  const connected = await connectClient(current.relay, user);
  clients.push(connected);
  return connected;
}

/** The first-class names a user's tools/list holds now, on either leg. */
async function listed(user: DevTokenUser, sessionId?: string): Promise<string[]> {
  if (!current) throw new Error('no relay');
  const answer =
    sessionId === undefined
      ? await modernExchange(current.relay, user, 'tools/list')
      : await legacyExchange(current.relay, user, sessionId, 'tools/list');
  const tools = (answer.message?.result as { tools?: { name: string }[] } | undefined)?.tools;
  if (tools === undefined) throw new Error(answer.body);
  return tools.map((tool) => tool.name).filter((name) => name.includes('__'));
}

function relist(opened: TestPage, tools: PageTool[]): Promise<void> {
  opened.send({ t: 'tools', tools });
  return opened.sync();
}

describe('the notifier (page-tool-notifier.ts)', () => {
  function notifier(digests: Map<string, string>, sent: string[]): PageToolNotifier {
    return new PageToolNotifier({
      digestOf: (userId) => digests.get(userId) ?? 'empty',
      emptyDigest: 'empty',
      send: (userId) => sent.push(userId),
    });
  }

  it('tells a user at once, then at most once an interval and only when the digest moved', async () => {
    vi.useFakeTimers();
    const digests = new Map([['alice', 'one']]);
    const sent: string[] = [];
    const notify = notifier(digests, sent);
    notify.changed('alice');
    // At once means once the change is over: the end of the turn.
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(['alice']);
    // A burst within the interval: nothing until its end, then one.
    for (const digest of ['two', 'three', 'four']) {
      digests.set('alice', digest);
      notify.changed('alice');
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(sent).toEqual(['alice']);
    await vi.advanceTimersByTimeAsync(FIRST_CLASS_NOTIFY_INTERVAL_MS - 3000);
    expect(sent).toEqual(['alice', 'alice']);
    // A drop and a return within the interval: the digest is the one last sent, so nothing.
    digests.set('alice', 'gone');
    notify.changed('alice');
    await vi.advanceTimersByTimeAsync(2000);
    digests.set('alice', 'four');
    notify.changed('alice');
    await vi.advanceTimersByTimeAsync(FIRST_CLASS_NOTIFY_INTERVAL_MS);
    expect(sent).toEqual(['alice', 'alice']);
    // Quiet for an interval, the next change goes at once again.
    digests.set('alice', 'five');
    notify.changed('alice');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(['alice', 'alice', 'alice']);
    notify.close();
  });

  it('keeps users apart and forgets one whose clients last heard of an empty list', async () => {
    vi.useFakeTimers();
    const digests = new Map([['alice', 'a1']]);
    const sent: string[] = [];
    const notify = notifier(digests, sent);
    notify.changed('alice');
    notify.changed('bob');
    await vi.advanceTimersByTimeAsync(0);
    // Bob's list is as empty as it was: he hears nothing, and nothing is kept for him.
    expect(sent).toEqual(['alice']);
    expect(notify.size).toBe(1);
    digests.delete('alice');
    notify.changed('alice');
    await vi.advanceTimersByTimeAsync(FIRST_CLASS_NOTIFY_INTERVAL_MS);
    expect(sent).toEqual(['alice', 'alice']);
    await vi.advanceTimersByTimeAsync(FIRST_CLASS_NOTIFY_INTERVAL_MS);
    expect(notify.size).toBe(0);
    notify.close();
  });

  it('takes a mark the read itself causes as part of that read', async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    let reads = 0;
    const notify: PageToolNotifier = new PageToolNotifier({
      digestOf: () => {
        reads += 1;
        // The hub ends an attachment past its time while it builds the list.
        notify.changed('alice');
        return `d${String(reads)}`;
      },
      emptyDigest: 'empty',
      send: (userId) => sent.push(userId),
    });
    notify.changed('alice');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(['alice']);
    expect(reads).toBe(1);
    notify.close();
  });
});

describe("each user's own listen handler (listen-streams.ts)", () => {
  function stubHandler(): McpHttpHandler & { told: number; closed: boolean } {
    const handler = {
      told: 0,
      closed: false,
      fetch: () =>
        Promise.resolve(
          new Response(new ReadableStream({ start: () => undefined }), {
            headers: { 'content-type': 'text/event-stream' },
          }),
        ),
      notify: {
        toolsChanged: () => {
          handler.told += 1;
        },
        promptsChanged: () => undefined,
        resourcesChanged: () => undefined,
        resourceUpdated: () => undefined,
      },
      bus: {} as McpHttpHandler['bus'],
      close: () => {
        handler.closed = true;
        return Promise.resolve();
      },
    };
    return handler;
  }

  it("is made with a user's first stream, told only of that user's changes, and closed with their last", async () => {
    const made: ReturnType<typeof stubHandler>[] = [];
    const budget: RequestBudget = { spend: () => true, refusal: () => 'no' };
    const log = createLogger({ sink: () => undefined });
    const listens = new ListenStreams({
      perUser: 5,
      total: 20,
      budget,
      log,
      lines: createRepeatedLog(log, 60_000),
      createHandler: () => {
        const handler = stubHandler();
        made.push(handler);
        return handler;
      },
    });
    const open = async (userId: string): Promise<AbortController> => {
      const abort = new AbortController();
      const response = await listens.open({ userId, kind: 'member' }, 1, abort.signal, (own) =>
        own.fetch(new Request('http://relay.invalid/mcp')),
      );
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      return abort;
    };
    const aliceOne = await open('alice');
    const aliceTwo = await open('alice');
    const bob = await open('bob');
    expect(made).toHaveLength(2);
    expect(listens.handlers).toBe(2);
    listens.notifyUser('alice');
    expect(made.map((handler) => handler.told)).toEqual([1, 0]);
    listens.notifyAll();
    expect(made.map((handler) => handler.told)).toEqual([2, 1]);
    aliceOne.abort();
    expect(made[0]?.closed).toBe(false);
    aliceTwo.abort();
    expect(made[0]?.closed).toBe(true);
    expect(listens.handlers).toBe(1);
    // Alice's next stream gets a handler of its own again.
    const again = await open('alice');
    expect(made).toHaveLength(3);
    again.abort();
    bob.abort();
    expect(listens.handlers).toBe(0);
  });
});

describe("a change to a member's first-class list", () => {
  it("reaches that member's sessions and listen streams, and nobody else's", async () => {
    await setup();
    const alicesPage = await page();
    const bobsPage = await page();
    const alice = await client(ALICE);
    const bob = await client(BOB);
    const aliceListen = await listen(ALICE);
    const aliceSession = await session(ALICE);
    const bobListen = await listen(BOB);
    const bobSession = await session(BOB);
    // Alice's attachment gives her list three tools: she hears it at once, on both channels.
    await pairAndApprove(alice, alicesPage);
    await eventually(() => aliceListen.heard() === 1 && aliceSession.stream.heard() === 1);
    expect(await listed(ALICE)).toHaveLength(3);
    await delay(300);
    expect(bobListen.heard()).toBe(0);
    expect(bobSession.stream.heard()).toBe(0);
    // And Bob's gives his, which Alice never hears of.
    await pairAndApprove(bob, bobsPage);
    await eventually(() => bobListen.heard() === 1 && bobSession.stream.heard() === 1);
    await delay(300);
    expect(aliceListen.heard()).toBe(1);
    expect(aliceSession.stream.heard()).toBe(1);
  });

  it('holds for every tools/list answered after it, on both revisions, before any notification', async () => {
    await setup();
    const opened = await page();
    const alice = await client(ALICE);
    await pairAndApprove(alice, opened);
    const { id } = await session(ALICE);
    for (const sessionId of [undefined, id]) {
      expect(await listed(ALICE, sessionId)).toHaveLength(3);
    }
    // A downgrade to observer: the mutating tools are gone from the very next list.
    opened.send({ t: 'set_role', userId: 'alice', role: 'observer' });
    await opened.sync();
    for (const sessionId of [undefined, id]) {
      expect(await listed(ALICE, sessionId)).toEqual([`${opened.pageId}__get_view`]);
    }
    // A revoke: the page's tools are gone at once.
    opened.send({ t: 'revoke', userId: 'alice' });
    await opened.sync();
    for (const sessionId of [undefined, id]) {
      expect(await listed(ALICE, sessionId)).toEqual([]);
    }
  });

  it('comes with a 2026-07-28 list a client may keep 10 s, privately', async () => {
    const relay = await setup();
    const answer = await modernExchange(relay.relay, ALICE, 'tools/list');
    expect(answer.message?.result).toMatchObject({
      ttlMs: FIRST_CLASS_LIST_TTL_MS,
      cacheScope: 'private',
    });
  });

  it('from a page that changes its tools every second leaves a member with four clients the budget for a call (ADR 0032)', async () => {
    // A budget a member with four clients would spend in eleven seconds if
    // every second's change made each of them list again.
    await setup({
      rateLimits: { requestsPerUser: 30, toolsFramesPerSocket: 100, toolsFramesPerAddress: 100 },
    });
    const busy = await page();
    const quiet = await page();
    quiet.onInvoke = () => ({ ok: true, content: 'served' });
    const alice = await client(ALICE);
    await pairAndApprove(alice, busy);
    await pairAndApprove(alice, quiet);
    // Four 2026-07-28 clients, each listing again whenever it hears of a change.
    const four = await Promise.all([1, 2, 3, 4].map(() => listen(ALICE)));
    const lists = [0, 0, 0, 0];
    let stop = false;
    const relisting = four.map(async (stream, index) => {
      let seen = 0;
      while (!stop) {
        if (stream.heard() > seen) {
          seen = stream.heard();
          await listed(ALICE);
          lists[index] = (lists[index] ?? 0) + 1;
        }
        await delay(20);
      }
    });
    const started = Date.now();
    for (let second = 0; second <= 11; second += 1) {
      const extra: PageTool = { ...WRITE_TOOL, name: `tick_${String(second)}` };
      await relist(busy, [...TOOLS, extra]);
      await delay(Math.max(0, started + (second + 1) * 1000 - Date.now()));
    }
    stop = true;
    await Promise.all(relisting);
    // At once, then once at each interval's end: two or three in eleven seconds, never twelve.
    for (const stream of four) expect(stream.heard()).toBeLessThanOrEqual(3);
    expect(lists.reduce((sum, each) => sum + each, 0)).toBeLessThanOrEqual(12);
    const served = await callTool(alice, 'call_page_tool', {
      page: quiet.pageId,
      tool: 'get_view',
    });
    expect(served.isError, served.text).toBe(false);
    expect(served.text).toContain('served');
  }, 30_000);
});

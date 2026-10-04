// PageHub on its own, behind a bare WebSocketServer, driving the pair_page
// waiter sets with AbortSignals directly: exact control over which joiner stops
// waiting when. cancel.test.ts covers a real client's abort through /mcp. The
// relay's side of the page socket is at hand too, so a test can make it see
// what it sent as still queued, which page-backpressure.test.ts reaches for real.

import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { PageTool } from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { createDevTokenAuth } from '../src/auth.ts';
import { resolveConfig } from '../src/config.ts';
import {
  type CallerIdentity,
  INVOKE_ROOM,
  MAX_UNREAD_BYTES,
  MAX_UNREAD_FRAMES,
  PageHub,
} from '../src/hub.ts';
import { createLogger } from '../src/log.ts';
import { createMemoryStore } from '../src/store.ts';
import {
  connectPage,
  PAGE_ORIGIN,
  type TestPage,
  TOOLS,
  WRITE_TOOL,
} from './helpers/page-client.ts';
import { ALICE } from './helpers/relay.ts';

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

async function bench(
  options: { tools?: PageTool[]; callDeadlineMs?: number } = {},
): Promise<Bench> {
  const config = resolveConfig({
    auth: createDevTokenAuth([ALICE]),
    timings: {
      pairWaitMs: 10_000,
      attachRequestTtlMs: 20_000,
      ...(options.callDeadlineMs === undefined ? {} : { callDeadlineMs: options.callDeadlineMs }),
    },
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
    tools: options.tools ?? TOOLS,
  });
  cleanups.push(() => {
    page.ws.terminate();
    return Promise.resolve();
  });
  if (served === undefined) throw new Error('the page socket never reached the hub');
  return { hub, page, served, lines };
}

/** Alice; each pairPage call stands for one more of her devices joining the same request. */
const alice: CallerIdentity = {
  userId: ALICE.userId,
  displayName: ALICE.displayName,
  account: { kind: 'member', email: null },
  oauthClientId: null,
  client: null,
};

describe('pair_page waiters on one attach request', () => {
  it('a joiner that stops waiting leaves the others waiting, and they still attach', async () => {
    const { hub, page } = await bench();
    const first = hub.pairPage(alice, page.code, new AbortController().signal);
    const request = await page.next('attach_request');
    const leaving = new AbortController();
    const joined = hub.pairPage(alice, (await page.next('pairing')).code, leaving.signal);
    const staying = hub.pairPage(
      alice,
      (await page.next('pairing')).code,
      new AbortController().signal,
    );
    await page.next('pairing');
    leaving.abort();
    expect(await joined).toMatchObject({ kind: 'error', code: 'timeout' });

    page.send({ t: 'attach_decision', requestId: request.requestId, allow: true, role: 'driver' });
    for (const outcome of await Promise.all([first, staying])) {
      expect(outcome).toMatchObject({ kind: 'attached', role: 'driver' });
    }
    await page.sync();
    expect(page.all('attach_request')).toHaveLength(1);
  });

  it('shutdown answers every waiter on a request, joiners included', async () => {
    const { hub, page } = await bench();
    const waiting = [hub.pairPage(alice, page.code, new AbortController().signal)];
    await page.next('attach_request');
    for (let n = 2; n <= 4; n += 1) {
      const code = (await page.next('pairing')).code;
      waiting.push(hub.pairPage(alice, code, new AbortController().signal));
    }
    await page.next('pairing');
    await page.sync();
    expect(page.all('attach_request')).toHaveLength(1);

    await hub.shutdown();
    for (const outcome of await Promise.all(waiting)) {
      expect(outcome).toEqual({
        kind: 'error',
        code: 'timeout',
        message: 'the relay is shutting down',
      });
    }
  });
});

/** What stall() leaves a test: the queue the relay sees, and a way to let it go. */
interface Stall {
  /** Frames the relay handed ws that it still sees queued. */
  readonly frames: number;
  /** Those frames' bytes, plus any added. */
  readonly bytes: number;
  /** Bytes the relay sees queued that it did not send itself, as if another frame were stuck. */
  add(bytes: number): void;
  /** Lets the oldest `count` frames leave, as if the page read them; every one, and the added bytes, by default. */
  drain(count?: number): void;
}

/**
 * Makes the relay's side of the socket behave as if the page read nothing.
 * Every frame still reaches the test page, so it can look and answer, but
 * the relay sees each one queued (bufferedAmount) and never hears that it
 * left (its send callback) until drain() lets it go.
 */
function stall(served: WebSocket): Stall {
  const withheld: { bytes: number; written: (() => void) | undefined }[] = [];
  let added = 0;
  const socket = served as unknown as {
    send: (data: string, written?: () => void) => void;
    pong: (data: Buffer, mask?: boolean, written?: () => void) => void;
  };
  const send = socket.send.bind(served);
  const pong = socket.pong.bind(served);
  // A frame's header is at least two bytes, so even an empty pong is queued as something.
  socket.send = (data, written) => {
    withheld.push({ bytes: 2 + Buffer.byteLength(data), written });
    send(data);
  };
  socket.pong = (data, mask, written) => {
    withheld.push({ bytes: 2 + data.length, written });
    pong(data, mask);
  };
  const bytes = (): number => withheld.reduce((sum, frame) => sum + frame.bytes, added);
  Object.defineProperty(served, 'bufferedAmount', { get: bytes, configurable: true });
  return {
    get frames() {
      return withheld.length;
    },
    get bytes() {
      return bytes();
    },
    add(more) {
      added += more;
    },
    drain(count = withheld.length) {
      if (count >= withheld.length) added = 0;
      for (const frame of withheld.splice(0, count)) frame.written?.();
    },
  };
}

/** The close, or null if none came within a moment. */
async function closeOf(page: TestPage): Promise<{ code: number; reason: string } | null> {
  return Promise.race([
    page.closed,
    new Promise<null>((resolve) => {
      setTimeout(() => {
        resolve(null);
      }, 2000);
    }),
  ]);
}

describe('what the relay queues for a page that is not reading (ADR 0024)', () => {
  it('closes a page once MAX_UNREAD_FRAMES frames it was sent stay queued', async () => {
    const { page, served } = await bench();
    stall(served);
    // The sync's own ping makes MAX_UNREAD_FRAMES, every one answered.
    for (let i = 1; i < MAX_UNREAD_FRAMES; i += 1) page.send({ t: 'ping' });
    await page.sync();
    expect(page.ws.readyState).toBe(page.ws.OPEN);
    page.send({ t: 'ping' });
    expect(await closeOf(page)).toEqual({ code: 1008, reason: 'page is not reading' });
  });

  it('counts only what is still queued, so a page that takes some may be sent as many more', async () => {
    const { page, served } = await bench();
    const queue = stall(served);
    for (let i = 1; i < MAX_UNREAD_FRAMES; i += 1) page.send({ t: 'ping' });
    await page.sync();
    expect(queue.frames).toBe(MAX_UNREAD_FRAMES);
    // The page takes two and its queue never empties, as on a slow link.
    queue.drain(2);
    page.send({ t: 'ping' });
    await page.sync();
    expect(page.ws.readyState).toBe(page.ws.OPEN);
    page.send({ t: 'ping' });
    expect(await closeOf(page)).toEqual({ code: 1008, reason: 'page is not reading' });
  });

  it('starts the count over each time the queue empties', async () => {
    const { page, served } = await bench();
    const queue = stall(served);
    const half = Math.ceil(MAX_UNREAD_FRAMES / 2);
    for (let i = 0; i < half; i += 1) page.send({ t: 'ping' });
    await page.sync();
    queue.drain();
    for (let i = 0; i < half; i += 1) page.send({ t: 'ping' });
    await page.sync();
    expect(page.ws.readyState).toBe(page.ws.OPEN);
  });

  it('closes a page whose queue a frame would take past MAX_UNREAD_BYTES', async () => {
    const { page, served } = await bench();
    stall(served).add(MAX_UNREAD_BYTES - 32);
    // A pong fits in what is left; a pairing frame does not.
    await page.sync();
    expect(page.ws.readyState).toBe(page.ws.OPEN);
    page.send({ t: 'rotate_pairing' });
    expect(await closeOf(page)).toEqual({ code: 1008, reason: 'page is not reading' });
  });

  it("answers the page's WebSocket pings within the same bound", async () => {
    const { page, served } = await bench();
    stall(served);
    let pongs = 0;
    page.ws.on('pong', () => {
      pongs += 1;
    });
    for (let i = 1; i < MAX_UNREAD_FRAMES; i += 1) page.ws.ping();
    await page.sync();
    expect(pongs).toBe(MAX_UNREAD_FRAMES - 1);
    page.ws.ping();
    expect(await closeOf(page)).toEqual({ code: 1008, reason: 'page is not reading' });
  });
});

describe('calls on a page whose queue is full (ADR 0024 notes)', () => {
  const SEARCH: PageTool = {
    name: 'search',
    description: 'Search the given text.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  };

  /** Alice, attached as a driver through the bench's own hub. */
  async function attach(hub: PageHub, page: TestPage): Promise<void> {
    const pairing = hub.pairPage(alice, page.code, new AbortController().signal);
    const request = await page.next('attach_request');
    page.send({ t: 'attach_decision', requestId: request.requestId, allow: true, role: 'driver' });
    expect(await pairing).toMatchObject({ kind: 'attached' });
  }

  /** Waits until the hub has held `count` calls for want of room, as its debug lines say. */
  async function heldCalls(lines: string[], count: number): Promise<void> {
    const deadline = Date.now() + 5000;
    const held = (): number =>
      lines.filter((line) => line.includes('call waits for room on the page link')).length;
    while (held() < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(held()).toBe(count);
  }

  function search(
    hub: PageHub,
    page: TestPage,
    chars: number,
    signal = new AbortController().signal,
  ): ReturnType<PageHub['callPageTool']> {
    return hub.callPageTool(alice, page.pageId, SEARCH.name, { text: 'a'.repeat(chars) }, signal);
  }

  it('holds an invoke that would take the queue past INVOKE_ROOM until the page takes what it holds, and never closes the page', async () => {
    const { hub, page, served, lines } = await bench({ tools: [SEARCH] });
    await attach(hub, page);
    page.onInvoke = () => ({ ok: true, content: 'found' });
    const queue = stall(served);
    // As if a large invoke were still on its way to a page on a slow link.
    queue.add(INVOKE_ROOM - 1000);
    const call = search(hub, page, 2000);
    await heldCalls(lines, 1);
    await page.sync();
    expect(page.all('invoke')).toHaveLength(0);
    // What the page itself asks for still fits beside it.
    for (let i = 0; i < 10; i += 1) page.send({ t: 'ping' });
    await page.sync();
    expect(page.ws.readyState).toBe(page.ws.OPEN);
    // Once the page takes what was queued, the call goes out and is answered.
    queue.drain();
    expect(await call).toMatchObject({ kind: 'ok', content: 'found' });
    expect(page.all('invoke')).toHaveLength(1);
  });

  it('keeps what a burst of large invokes queues within INVOKE_ROOM, and sends the rest in order as the page reads', async () => {
    const { hub, page, served, lines } = await bench({ tools: [SEARCH] });
    await attach(hub, page);
    page.onInvoke = (frame) => ({ ok: true, content: String(String(frame.arguments.text).length) });
    const queue = stall(served);
    const sizes = Array.from({ length: 12 }, (_, n) => 300_000 + n);
    const calls = sizes.map((size) => search(hub, page, size));
    // Three fit in INVOKE_ROOM; the other nine wait.
    await heldCalls(lines, sizes.length - 3);
    await page.sync();
    // Before, every invoke went out at once: about 3.6 MB queued for a page that may never read it.
    expect(page.all('invoke')).toHaveLength(3);
    expect(queue.bytes).toBeLessThanOrEqual(INVOKE_ROOM);
    expect(page.ws.readyState).toBe(page.ws.OPEN);
    // The page reads a frame at a time, as on a slow link, and each frame it takes makes room.
    while (queue.frames > 0) {
      queue.drain(1);
      await new Promise((resolve) => setImmediate(resolve));
      expect(queue.bytes).toBeLessThanOrEqual(INVOKE_ROOM);
    }
    const outcomes = await Promise.all(calls);
    expect(outcomes.map((outcome) => (outcome.kind === 'ok' ? outcome.content : outcome))).toEqual(
      sizes.map(String),
    );
    // In arrival order.
    expect(page.all('invoke').map((frame) => String(frame.arguments.text).length)).toEqual(sizes);
    expect(page.ws.readyState).toBe(page.ws.OPEN);
  });

  it('ends a held call on cancel without telling the page, times out the rest, and never closes a page for cancels', async () => {
    const { hub, page, served, lines } = await bench({ tools: [SEARCH], callDeadlineMs: 1500 });
    await attach(hub, page);
    // The page takes its invokes but never answers them.
    page.onInvoke = () => undefined;
    const queue = stall(served);
    queue.add(INVOKE_ROOM);
    const leaving = new AbortController();
    const held = search(hub, page, 100, leaving.signal);
    const waiting = search(hub, page, 100);
    await heldCalls(lines, 2);
    await page.sync();
    expect(page.all('invoke')).toHaveLength(0);
    leaving.abort();
    expect(await held).toEqual({ kind: 'cancelled' });
    // The page never saw it, so nothing tells it to stop.
    await page.sync();
    expect(page.all('cancel')).toHaveLength(0);
    expect(await waiting).toMatchObject({
      kind: 'error',
      code: 'timeout',
      message: expect.stringContaining('never reached it') as unknown,
    });
    // With the frames the page asked for one short of the cap, a burst of
    // cancels for calls it holds still closes nothing: they are bounded by
    // the invokes that went out, not by what the page reads.
    queue.drain();
    const aborts = Array.from({ length: 40 }, () => new AbortController());
    const sent = aborts.map((abort) => search(hub, page, 10, abort.signal));
    while (page.all('invoke').length < aborts.length) await page.next('invoke');
    for (let i = 3; i < MAX_UNREAD_FRAMES; i += 1) page.send({ t: 'ping' });
    await page.sync();
    for (const abort of aborts) abort.abort();
    await Promise.all(sent);
    expect(page.ws.readyState).toBe(page.ws.OPEN);
    // The page sees every cancel, so the relay sent them rather than closing.
    const deadline = Date.now() + 2000;
    while (page.all('cancel').length < aborts.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(page.all('cancel')).toHaveLength(aborts.length);
    expect(await closeOf(page)).toBeNull();
  });

  it('ends a held call at once when its caller is revoked, and the page never hears of it (S8)', async () => {
    const { hub, page, served, lines } = await bench({ tools: [SEARCH] });
    await attach(hub, page);
    page.onInvoke = () => ({ ok: true, content: 'found' });
    const queue = stall(served);
    queue.add(INVOKE_ROOM);
    const held = search(hub, page, 100);
    await heldCalls(lines, 1);
    page.send({ t: 'revoke', userId: alice.userId });
    expect(await held).toMatchObject({ kind: 'error', code: 'not_attached' });
    // Room comes later; nothing of the revoked call goes out.
    queue.drain();
    await page.sync();
    expect(page.all('invoke')).toHaveLength(0);
    expect(page.all('cancel')).toHaveLength(0);
  });

  it('looks at a held write again when room comes, so a caller demoted meanwhile never reaches the page (S5)', async () => {
    const { hub, page, served, lines } = await bench({ tools: [SEARCH, WRITE_TOOL] });
    await attach(hub, page);
    page.onInvoke = () => ({ ok: true, content: 'done' });
    const queue = stall(served);
    queue.add(INVOKE_ROOM);
    const write = hub.callPageTool(
      alice,
      page.pageId,
      WRITE_TOOL.name,
      { label: 'x' },
      new AbortController().signal,
    );
    await heldCalls(lines, 1);
    page.send({ t: 'set_role', userId: alice.userId, role: 'observer' });
    await page.sync();
    queue.drain();
    expect(await write).toMatchObject({ kind: 'error', code: 'role_denied' });
    await page.sync();
    expect(page.all('invoke')).toHaveLength(0);
  });
});

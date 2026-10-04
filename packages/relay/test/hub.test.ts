// PageHub on its own, behind a bare WebSocketServer, driving the pair_page
// waiter sets with AbortSignals directly: exact control over which joiner stops
// waiting when. cancel.test.ts covers a real client's abort through /mcp. The
// relay's side of the page socket is at hand too, so a test can make it report
// what it holds unread, which page-backpressure.test.ts reaches for real.

import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { createDevTokenAuth } from '../src/auth.ts';
import { resolveConfig } from '../src/config.ts';
import { type CallerIdentity, MAX_UNREAD_BYTES, MAX_UNREAD_FRAMES, PageHub } from '../src/hub.ts';
import { createLogger } from '../src/log.ts';
import { createMemoryStore } from '../src/store.ts';
import { connectPage, PAGE_ORIGIN, type TestPage, TOOLS } from './helpers/page-client.ts';
import { ALICE } from './helpers/relay.ts';

interface Bench {
  hub: PageHub;
  page: TestPage;
  /** The relay's side of the page's socket. */
  served: WebSocket;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function bench(): Promise<Bench> {
  const config = resolveConfig({
    auth: createDevTokenAuth([ALICE]),
    timings: { pairWaitMs: 10_000, attachRequestTtlMs: 20_000 },
  });
  const hub = new PageHub(config, createMemoryStore(), createLogger({ sink: () => undefined }));
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
  const page = await connectPage(`ws://127.0.0.1:${String(port)}/page`, { tools: TOOLS });
  cleanups.push(() => {
    page.ws.terminate();
    return Promise.resolve();
  });
  if (served === undefined) throw new Error('the page socket never reached the hub');
  return { hub, page, served };
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

describe('what the relay queues for a page that is not reading (ADR 0024)', () => {
  /** Makes the relay's side of the socket report this many bytes still queued past the kernel. */
  function queued(served: WebSocket, bytes: () => number): void {
    Object.defineProperty(served, 'bufferedAmount', { get: bytes, configurable: true });
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

  it('closes a page once it is sent MAX_UNREAD_FRAMES frames while its queue never empties', async () => {
    const { page, served } = await bench();
    queued(served, () => 1);
    // The sync's own ping makes MAX_UNREAD_FRAMES, every one answered.
    for (let i = 1; i < MAX_UNREAD_FRAMES; i += 1) page.send({ t: 'ping' });
    await page.sync();
    expect(page.ws.readyState).toBe(page.ws.OPEN);
    page.send({ t: 'ping' });
    expect(await closeOf(page)).toEqual({ code: 1008, reason: 'page is not reading' });
  });

  it('starts the count over each time the queue empties', async () => {
    const { page, served } = await bench();
    let bytes = 1;
    queued(served, () => bytes);
    const half = Math.ceil(MAX_UNREAD_FRAMES / 2);
    for (let i = 0; i < half; i += 1) page.send({ t: 'ping' });
    await page.sync();
    bytes = 0;
    await page.sync();
    bytes = 1;
    for (let i = 0; i < half; i += 1) page.send({ t: 'ping' });
    await page.sync();
    expect(page.ws.readyState).toBe(page.ws.OPEN);
  });

  it('closes a page whose queue a frame would take past MAX_UNREAD_BYTES', async () => {
    const { page, served } = await bench();
    queued(served, () => MAX_UNREAD_BYTES - 32);
    // A pong fits in what is left; a pairing frame does not.
    await page.sync();
    expect(page.ws.readyState).toBe(page.ws.OPEN);
    page.send({ t: 'rotate_pairing' });
    expect(await closeOf(page)).toEqual({ code: 1008, reason: 'page is not reading' });
  });

  it("answers the page's WebSocket pings within the same bound", async () => {
    const { page, served } = await bench();
    queued(served, () => 1);
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

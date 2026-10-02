// PageHub on its own, behind a bare WebSocketServer, for paths the MCP route
// cannot reach yet: the stateless /mcp route does not pass a client's abort
// on to pair_page (M2's sessionful route will), so the waiter sets are driven
// here with AbortSignals directly.

import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { createDevTokenAuth } from '../src/auth.ts';
import { resolveConfig } from '../src/config.ts';
import { type CallerIdentity, PageHub } from '../src/hub.ts';
import { createLogger } from '../src/log.ts';
import { createMemoryStore } from '../src/store.ts';
import { connectPage, PAGE_ORIGIN, type TestPage, TOOLS } from './helpers/page-client.ts';
import { ALICE } from './helpers/relay.ts';

interface Bench {
  hub: PageHub;
  page: TestPage;
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
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (ws, request) => {
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
  return { hub, page };
}

const alice = (address: string): CallerIdentity => ({
  userId: ALICE.userId,
  displayName: ALICE.displayName,
  client: null,
  address,
});

describe('pair_page waiters on one attach request', () => {
  it('a joiner that stops waiting leaves the others waiting, and they still attach', async () => {
    const { hub, page } = await bench();
    const first = hub.pairPage(alice('10.0.0.1'), page.code, new AbortController().signal);
    const request = await page.next('attach_request');
    const leaving = new AbortController();
    const joined = hub.pairPage(
      alice('10.0.0.2'),
      (await page.next('pairing')).code,
      leaving.signal,
    );
    const staying = hub.pairPage(
      alice('10.0.0.3'),
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
    const waiting = [hub.pairPage(alice('10.0.0.1'), page.code, new AbortController().signal)];
    await page.next('attach_request');
    for (let n = 2; n <= 4; n += 1) {
      const code = (await page.next('pairing')).code;
      waiting.push(hub.pairPage(alice(`10.0.0.${String(n)}`), code, new AbortController().signal));
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

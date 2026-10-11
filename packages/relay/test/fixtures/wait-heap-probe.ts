// node --expose-gc wait-heap-probe.ts: a relay with no bound on what waiting
// requests may hold, nine members (wait-heap-probe-<n>-token-5d1e8b3a7c2f,
// n from 0 to 8, so each holds one wait well within the two a user may) and
// one page that approves every attach request and publishes nothing, so
// every wait_for_page_state waits. It prints the relay's /mcp URL and the
// page's id as its first line, then answers each IPC message: 'code' with the
// page's newest pairing code, and anything else with its heap after
// collecting garbage and the waits the relay had started before the first
// collection, so call-heap.test.ts can measure what a waiting wait holds
// from another process, whose own copies of the bodies it sends are not
// counted (ADR 0040).

import { encodeFrame, SUBPROTOCOL } from '@tabdock/protocol';
import WebSocket from 'ws';
import { createDevTokenAuth, createRelay } from '../../src/index.ts';
import { PAGE_ORIGIN } from '../helpers/page-client.ts';

const collect = (globalThis as { gc?: (options?: Record<string, string>) => void }).gc;
if (collect === undefined) throw new Error('run with --expose-gc');
const send = process.send?.bind(process);
if (send === undefined) throw new Error('run with an IPC channel');

let started = 0;
const relay = await createRelay({
  auth: createDevTokenAuth(
    Array.from({ length: 9 }, (_, n) => ({
      token: `wait-heap-probe-${String(n)}-token-5d1e8b3a7c2f`,
      userId: `probe${String(n)}`,
      displayName: 'P',
    })),
  ),
  port: 0,
  // Room for every wait; what they hold is what is being measured.
  limits: { requestBytes: 2 ** 40, requestBytesPerUser: 2 ** 40 },
  // Waits last their whole 40 s, and the page link outlasts any stall a body's parse can cause.
  timings: { callDeadlineMs: 300_000, idleTimeoutMs: 300_000 },
  logLevel: 'debug',
  logSink: (line) => {
    if (line.includes('"msg":"page state wait started"')) started += 1;
  },
});

// A page of its own rather than the test helper's, which keeps every frame it receives.
const ws = new WebSocket(relay.pageUrl, [SUBPROTOCOL], { origin: PAGE_ORIGIN });
let code = '';
const welcomed = new Promise<string>((resolveWelcome) => {
  ws.on('message', (data: Buffer) => {
    const frame = JSON.parse(data.toString('utf8')) as {
      t: string;
      pageId?: string;
      code?: string;
      requestId?: string;
      pairing?: { code: string };
    };
    if (frame.t === 'welcome' && frame.pageId !== undefined && frame.pairing !== undefined) {
      code = frame.pairing.code;
      resolveWelcome(frame.pageId);
    }
    if (frame.t === 'pairing' && frame.code !== undefined) code = frame.code;
    if (frame.t === 'ping') ws.send(encodeFrame({ t: 'pong' }));
    if (frame.t === 'attach_request' && frame.requestId !== undefined) {
      ws.send(
        encodeFrame({
          t: 'attach_decision',
          requestId: frame.requestId,
          allow: true,
          role: 'observer',
        }),
      );
    }
  });
});
await new Promise<void>((resolveOpen) => {
  ws.once('open', () => {
    resolveOpen();
  });
});
ws.send(
  encodeFrame({
    t: 'hello',
    v: 1,
    title: 'Wait heap probe',
    url: `${PAGE_ORIGIN}/`,
    adapterVersion: 'test',
    policy: {},
  }),
);
const pageId = await welcomed;
ws.send(encodeFrame({ t: 'tools', tools: [] }));
process.stdout.write(`${relay.mcpUrl} ${pageId}\n`);

/** The least heap over a few full collections, as call-heap-probe.ts measures it. */
async function settledHeap(): Promise<number> {
  let least = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 4; round += 1) {
    collect?.({ type: 'major', execution: 'sync', flavor: 'last-resort' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    least = Math.min(least, process.memoryUsage().heapUsed);
  }
  return least;
}

process.on('message', (message) => {
  if (message === 'code') {
    send({ code });
    return;
  }
  const waits = started;
  void settledHeap().then((heapUsed) => send({ heapUsed, waits }));
});

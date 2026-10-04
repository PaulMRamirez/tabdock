// node --expose-gc call-heap-probe.ts: a relay with no bound on what waiting
// requests may hold, one member (call-heap-probe-token-5d1e8b3a7c2f4096) and
// one page offering helpers/call-shapes.ts's SEARCH that approves every
// attach request, reads every invoke, keeps none and answers none, so each
// call waits. It prints the relay's /mcp URL, the page's id and its pairing
// code, space apart, as its first line, then answers each IPC message with
// its heap after collecting garbage and the invokes its page has received, so
// call-heap.test.ts can measure what waiting calls hold from another
// process, whose own copies of the bodies it sends are not counted.

import { encodeFrame, SUBPROTOCOL } from '@tabdock/protocol';
import WebSocket from 'ws';
import { createDevTokenAuth, createRelay } from '../../src/index.ts';
import { SEARCH } from '../helpers/call-shapes.ts';
import { PAGE_ORIGIN } from '../helpers/page-client.ts';

const collect = (globalThis as { gc?: (options?: Record<string, string>) => void }).gc;
if (collect === undefined) throw new Error('run with --expose-gc');
const send = process.send?.bind(process);
if (send === undefined) throw new Error('run with an IPC channel');

const relay = await createRelay({
  auth: createDevTokenAuth([
    { token: 'call-heap-probe-token-5d1e8b3a7c2f4096', userId: 'probe', displayName: 'P' },
  ]),
  port: 0,
  // Room for every call; what they hold is what is being measured.
  limits: { requestBytes: 2 ** 40, requestBytesPerUser: 2 ** 40 },
  timings: { callDeadlineMs: 300_000 },
  logSink: () => undefined,
});

// A page of its own rather than the test helper's, which keeps every frame it receives.
const ws = new WebSocket(relay.pageUrl, [SUBPROTOCOL], { origin: PAGE_ORIGIN });
let invokes = 0;
const welcomed = new Promise<{ pageId: string; code: string }>((resolveWelcome) => {
  ws.on('message', (data: Buffer) => {
    const text = data.toString('utf8');
    if (text.startsWith('{"t":"invoke"')) {
      invokes += 1;
      return;
    }
    const frame = JSON.parse(text) as {
      t: string;
      pageId?: string;
      requestId?: string;
      pairing?: { code: string };
    };
    if (frame.t === 'welcome' && frame.pageId !== undefined && frame.pairing !== undefined) {
      resolveWelcome({ pageId: frame.pageId, code: frame.pairing.code });
    }
    if (frame.t === 'ping') ws.send(encodeFrame({ t: 'pong' }));
    if (frame.t === 'attach_request' && frame.requestId !== undefined) {
      ws.send(
        encodeFrame({
          t: 'attach_decision',
          requestId: frame.requestId,
          allow: true,
          role: 'driver',
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
    title: 'Call heap probe',
    url: `${PAGE_ORIGIN}/`,
    adapterVersion: 'test',
    policy: {},
  }),
);
const { pageId, code } = await welcomed;
ws.send(encodeFrame({ t: 'tools', tools: [SEARCH] }));
process.stdout.write(`${relay.mcpUrl} ${pageId} ${code}\n`);
/**
 * The heap after full, compacting collections, the least of a few: garbage a
 * sweep has not reached yet only ever adds to it, and a test of an upper
 * bound must not count that against the bound.
 */
async function settledHeap(): Promise<number> {
  let least = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 4; round += 1) {
    collect?.({ type: 'major', execution: 'sync', flavor: 'last-resort' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    least = Math.min(least, process.memoryUsage().heapUsed);
  }
  return least;
}

process.on('message', () => {
  void settledHeap().then((heapUsed) => send({ heapUsed, invokes }));
});

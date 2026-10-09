// node --expose-gc call-heap-probe.ts: a relay with no bound on what waiting
// requests may hold, one member (call-heap-probe-token-5d1e8b3a7c2f4096) and
// one page offering helpers/call-shapes.ts's SEARCH that approves every
// attach request, reads every invoke, keeps none and answers none, so each
// call waits. It prints the relay's /mcp URL, the page's id and its pairing
// code, space apart, as its first line, then answers each IPC message with
// its heap after collecting garbage, the invokes its page had received before
// the first collection and the calls the relay had ended by the last reading, so
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
  // Calls wait for good: neither the call deadline nor the page link's
  // heartbeat (SPEC section 6: silent for idleTimeoutMs, the page is closed
  // and its calls end page_asleep) may end one within a case. The heartbeat
  // runs on this loop, which, with no bound on what waits, may read several
  // bodies in one poll phase and parse each in turn: beside two other suites,
  // six or seven bodies of about 2 MB of distinct or digit keys in _meta
  // took one pass of 30 to 49 s, in which the relay sent no ping and read no
  // pong, and the overdue idle timer then closed the page before the next
  // poll. Both outlast the case's own 120 s timeout, so no stall a case can
  // hold reaches them. What a stall still meets first is Node's own
  // headersTimeout, 60 s, which answers 408 to a request whose headers wait
  // unread that long; the test sees that call settle, and fails on it.
  timings: { callDeadlineMs: 300_000, idleTimeoutMs: 300_000 },
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
  // Counted before the first collection, not after the last reading: a call
  // that reaches the page while the heap is measured was not held at the
  // earlier readings, and the least of them leaves it out, so a measure begun
  // as calls arrive can count none of them. Calls ended are read after the
  // last reading, so a call released before or during any reading counts.
  const invoked = invokes;
  void settledHeap().then((heapUsed) =>
    send({ heapUsed, invokes: invoked, ended: relay.audit.records().length }),
  );
});

// node --expose-gc page-flood-relay.ts: a relay with invites on, two members
// for calls (page-flood-alice-token-5e2b7c9d1a4f8036 and
// page-flood-bob-token-0c6f3a8e2d7b5149), the timings and limits a test passes
// as JSON in PAGE_FLOOD_OPTIONS, and every other setting at its default, its
// log at the production level. It prints its /page and /mcp URLs, space
// apart, as its first line, sends `{ closing }` over IPC each time it closes a
// page socket, and answers each IPC message with its memory after two
// collections, the reasons it gave for closing page sockets, and the most any
// page socket had queued past what the kernel took right after the relay
// handed it a frame, both since the last answer, so page-backpressure.test.ts
// can measure what a page that stops reading costs it from another process.

import WebSocket from 'ws';
import { createDevTokenAuth, createRelay, type RelayOptions } from '../../src/index.ts';

const collect = (globalThis as { gc?: () => void }).gc;
if (collect === undefined) throw new Error('run with --expose-gc');
const send = process.send?.bind(process);
if (send === undefined) throw new Error('run with an IPC channel');

// Every socket in this process is a page socket the relay serves, so the
// largest queue any of them reaches after a frame is the relay's to answer for.
let maxQueued = 0;
const sockets = WebSocket.prototype as unknown as Record<
  'send' | 'pong',
  (this: WebSocket, ...args: unknown[]) => void
>;
for (const method of ['send', 'pong'] as const) {
  const original = sockets[method];
  sockets[method] = function (this: WebSocket, ...args: unknown[]): void {
    original.apply(this, args);
    maxQueued = Math.max(maxQueued, this.bufferedAmount);
  };
}

const options = JSON.parse(process.env.PAGE_FLOOD_OPTIONS ?? '{}') as Pick<
  RelayOptions,
  'timings' | 'limits'
>;
let closes: string[] = [];
let lines = 0;
const relay = await createRelay({
  auth: createDevTokenAuth([
    { token: 'tabdock-page-flood-token-not-a-secret', userId: 'flood', displayName: 'F' },
    { token: 'page-flood-alice-token-5e2b7c9d1a4f8036', userId: 'alice', displayName: 'Alice' },
    { token: 'page-flood-bob-token-0c6f3a8e2d7b5149', userId: 'bob', displayName: 'Bob' },
  ]),
  port: 0,
  invites: true,
  logLevel: 'info',
  ...options,
  logSink: (line) => {
    lines += 1;
    const entry = JSON.parse(line) as { msg?: unknown };
    if (typeof entry.msg === 'string' && entry.msg.startsWith('closing page socket')) {
      closes.push(entry.msg);
      send({ closing: entry.msg });
    }
  },
});
process.stdout.write(`${relay.pageUrl} ${relay.mcpUrl}\n`);
process.on('message', () => {
  collect();
  collect();
  const { heapUsed, arrayBuffers, rss } = process.memoryUsage();
  send({ heapUsed, arrayBuffers, rss, closes, lines, maxQueued });
  closes = [];
  maxQueued = 0;
});

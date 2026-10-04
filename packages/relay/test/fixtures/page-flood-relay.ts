// node --expose-gc page-flood-relay.ts: a relay with invites on and every
// other setting at its default, its log at the production level. It prints
// its /page URL as its first line, sends `{ closing }` over IPC each time it
// closes a page socket, and answers each IPC message with its memory after
// two collections and the reasons it gave for closing page sockets since the
// last answer, so page-backpressure.test.ts can measure what a page that
// stops reading costs it from another process.

import { createDevTokenAuth, createRelay } from '../../src/index.ts';

const collect = (globalThis as { gc?: () => void }).gc;
if (collect === undefined) throw new Error('run with --expose-gc');
const send = process.send?.bind(process);
if (send === undefined) throw new Error('run with an IPC channel');

let closes: string[] = [];
let lines = 0;
const relay = await createRelay({
  auth: createDevTokenAuth([
    { token: 'tabdock-page-flood-token-not-a-secret', userId: 'flood', displayName: 'F' },
  ]),
  port: 0,
  invites: true,
  logLevel: 'info',
  logSink: (line) => {
    lines += 1;
    const entry = JSON.parse(line) as { msg?: unknown };
    if (typeof entry.msg === 'string' && entry.msg.startsWith('closing page socket')) {
      closes.push(entry.msg);
      send({ closing: entry.msg });
    }
  },
});
process.stdout.write(`${relay.pageUrl}\n`);
process.on('message', () => {
  collect();
  collect();
  const { heapUsed, arrayBuffers, rss } = process.memoryUsage();
  send({ heapUsed, arrayBuffers, rss, closes, lines });
  closes = [];
});

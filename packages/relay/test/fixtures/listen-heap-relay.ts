// node --expose-gc listen-heap-relay.ts: a relay with invites on and sixty
// invitee accounts (invitee-<n>-dev-token-5a8c1e7f2b9d4063, n from 0), every
// other setting at its default. It prints its /mcp URL as its first line,
// then answers each IPC message with its memory after two collections, so
// listen-heap.test.ts can measure what the listen streams it opens hold.

import { createDevTokenAuth, createRelay, type DevTokenUser } from '../../src/index.ts';

const collect = (globalThis as { gc?: () => void }).gc;
if (collect === undefined) throw new Error('run with --expose-gc');
const send = process.send?.bind(process);
if (send === undefined) throw new Error('run with an IPC channel');

const users: DevTokenUser[] = Array.from({ length: 60 }, (_, n) => ({
  userId: `g_${(n + 1).toString(16).padStart(32, '0')}`,
  displayName: 'ignored',
  token: `invitee-${String(n)}-dev-token-5a8c1e7f2b9d4063`,
  kind: 'invitee',
}));
const relay = await createRelay({
  auth: createDevTokenAuth(users),
  port: 0,
  invites: true,
  logSink: () => undefined,
});
process.stdout.write(`${relay.mcpUrl}\n`);
process.on('message', () => {
  collect();
  collect();
  const { heapUsed, arrayBuffers, rss } = process.memoryUsage();
  send({ heapUsed, arrayBuffers, rss });
});

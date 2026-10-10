// node --expose-gc listen-heap-relay.ts: a relay with invites on, ten more
// invitee accounts than the invitee pool holds by default
// (invitee-<n>-dev-token-5a8c1e7f2b9d4063, n from 0) and one
// member (member-heap-dev-token-7c2e9a4b1d6f8035), room for that member's
// waiting calls to hold all their bodies, and every other setting at its
// default. It prints its /mcp and /page URLs, space apart, as its first line,
// then answers each IPC message with its memory after two collections, so
// listen-heap.test.ts can measure what the listen streams it opens, and the
// calls it leaves waiting on a page, hold.

import { DEFAULT_LIMITS } from '../../src/config.ts';
import { createDevTokenAuth, createRelay, type DevTokenUser } from '../../src/index.ts';

const collect = (globalThis as { gc?: () => void }).gc;
if (collect === undefined) throw new Error('run with --expose-gc');
const send = process.send?.bind(process);
if (send === undefined) throw new Error('run with an IPC channel');

// The test fills the whole pool, which ADR 0044 sized for a class.
const users: DevTokenUser[] = Array.from(
  { length: DEFAULT_LIMITS.inviteeSessions + 10 },
  (_, n) => ({
    userId: `g_${(n + 1).toString(16).padStart(32, '0')}`,
    displayName: 'ignored',
    token: `invitee-${String(n)}-dev-token-5a8c1e7f2b9d4063`,
    kind: 'invitee',
  }),
);
users.push({
  userId: 'member',
  displayName: 'Member',
  token: 'member-heap-dev-token-7c2e9a4b1d6f8035',
});
const relay = await createRelay({
  auth: createDevTokenAuth(users),
  port: 0,
  invites: true,
  // The test counts copies of each body, not what the relay lets them hold.
  limits: { requestBytesPerUser: 64 * 1024 * 1024 },
  logSink: () => undefined,
});
process.stdout.write(`${relay.mcpUrl} ${relay.pageUrl}\n`);
process.on('message', () => {
  collect();
  collect();
  const { heapUsed, arrayBuffers, rss } = process.memoryUsage();
  send({ heapUsed, arrayBuffers, rss });
});

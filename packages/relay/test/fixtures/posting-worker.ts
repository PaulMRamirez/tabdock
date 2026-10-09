// The real check worker, which also counts every message it posts (its ready
// and each reply) in memory it shares with the test's thread through
// worker_threads environment data. A test that holds the main thread cannot
// read the port meanwhile, but it can read this count, and so knows when a
// reply already waits unread.

import { getEnvironmentData, parentPort } from 'node:worker_threads';

const shared = getEnvironmentData('tabdock-test-worker-posted');
const port = parentPort;
if (!(shared instanceof SharedArrayBuffer) || !port) {
  throw new Error('posting-worker.ts runs as a worker thread beside a shared count');
}
const posted = new Int32Array(shared);
const post = port.postMessage.bind(port);
port.postMessage = (...message: Parameters<typeof post>): void => {
  post(...message);
  // Counted once the message is in the port, never before.
  Atomics.add(posted, 0, 1);
};
// Loaded only now, so the worker's own postMessage calls go through the count.
await import('../../src/argument-worker.ts');

// A check worker that starts, then dies on its first check, as one that ran
// out of memory would. process.exit in a worker ends only that thread.

import { parentPort } from 'node:worker_threads';

parentPort?.once('message', () => {
  process.exit(3);
});
parentPort?.postMessage({ t: 'ready' });

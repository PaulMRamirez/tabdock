// A check worker that is alive but never says it is ready, as one starved of
// CPU past the start limit would look: its port listener keeps the thread up.

import { parentPort } from 'node:worker_threads';

parentPort?.on('message', () => undefined);

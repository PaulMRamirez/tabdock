// A check worker that answers every check with a message of the wrong shape.

import { parentPort } from 'node:worker_threads';

parentPort?.on('message', () => {
  parentPort?.postMessage({ t: 'result', id: 'not a number', outcome: { kind: 'valid' } });
});
parentPort?.postMessage({ t: 'ready' });

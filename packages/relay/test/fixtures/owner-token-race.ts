// One racer in the owner token race test: it checks in, waits on a shared
// gate until every racer has, then starts local mode's token load at once
// with the others and reports what it got.

import { parentPort, workerData } from 'node:worker_threads';
import { loadOwnerToken } from '../../src/local-token.ts';

const { home, gate } = workerData as { home: string; gate: SharedArrayBuffer };
const slots = new Int32Array(gate);
Atomics.add(slots, 0, 1);
Atomics.wait(slots, 1, 0);
try {
  const owner = loadOwnerToken({ TABDOCK_HOME: home });
  parentPort?.postMessage({ ok: true, token: owner.token, created: owner.created });
} catch (error) {
  parentPort?.postMessage({ ok: false, message: error instanceof Error ? error.message : '' });
}

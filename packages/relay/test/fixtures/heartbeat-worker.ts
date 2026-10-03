// The real check worker, plus a heartbeat on a broadcast channel every 10 ms,
// so a test can tell from outside whether the thread is still running.

import '../../src/argument-worker.ts';

const channel = new BroadcastChannel('tabdock-test-worker-heartbeat');
let beats = 0;
setInterval(() => {
  beats += 1;
  channel.postMessage(beats);
}, 10);

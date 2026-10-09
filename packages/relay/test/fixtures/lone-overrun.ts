// A checker alone in a thread of its own, timing how soon it judges one
// overrun, for the test that a judgement never waits for other I/O to end a
// poll (ADR 0010's notes of 9 October 2026). In the test's own thread,
// vitest's timers and messages and the workers earlier tests left ending all
// end polls early, so a judgement that waits for them can still look prompt
// there. Here, while the check runs, the only handles are the checker's own
// (unreferenced) and a rescue timer that wakes the thread rescueMs after the
// check starts, so such a judgement measures about that instead of never.

import { parentPort, workerData } from 'node:worker_threads';
import { ArgumentChecker, type PreparedSchema } from '../../src/argument-checker.ts';
import { createLogger } from '../../src/log.ts';

interface LoneOverrunData {
  budgetMs: number;
  rescueMs: number;
  /** A schema whose check runs for minutes, and a small one that checks at once. */
  slow: PreparedSchema;
  form: PreparedSchema;
}

const port = parentPort;
if (!port) throw new Error('lone-overrun.ts runs as a worker thread');
const { budgetMs, rescueMs, slow, form } = workerData as LoneOverrunData;

// Nothing else of the checker's keeps a thread alive, so this does until the measure.
const setup = setTimeout(() => undefined, 60_000);
const checker = new ArgumentChecker({ budgetMs, log: createLogger({ sink: () => undefined }) });
const until = performance.now() + 10_000;
// A first check that runs out of time under load replaces the worker; try again.
while (
  !(await checker.ready()) ||
  (await checker.check('form', form, { name: 'Ada' })).kind !== 'valid'
) {
  if (performance.now() > until) throw new Error('no worker finished a check within 10 s');
  await new Promise((resolve) => setTimeout(resolve, 10));
}
clearTimeout(setup);
const rescue = setTimeout(() => undefined, rescueMs);
const started = performance.now();
const outcome = await checker.check('slow', slow, {});
const took = performance.now() - started;
clearTimeout(rescue);
await checker.close();
port.postMessage({ outcome, took });

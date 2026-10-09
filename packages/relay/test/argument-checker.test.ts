// The worker that runs argument checks (ADR 0010), on its own: a time budget
// per check, a busy worker that never makes other checks wait past it, an
// overrunning or crashing worker replaced (with backoff when it keeps failing),
// a reply that reached the port in time read before any timer judges its
// check, however long other work held the main thread, a bounded cache of
// compiled schemas, and shutdown that stops the thread. Misbehaving and
// counting workers, and a checker alone in a thread, come from test/fixtures;
// they load as plain node would load them, with type stripping.

import { setEnvironmentData, Worker } from 'node:worker_threads';
import type { JsonObject } from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ArgumentChecker,
  type ArgumentCheckerOptions,
  type CheckOutcome,
  prepareForCheck,
  type PreparedSchema,
} from '../src/argument-checker.ts';
import { CompiledChecks } from '../src/cfworker.ts';
import { createLogger } from '../src/log.ts';
import { delay } from './helpers/relay.ts';

const BUDGET_MS = 50;
/**
 * For tests that read what a check decides rather than how long it may take: a
 * first compile under a loaded test run can pass 50 ms, and the check would
 * then go unchecked for want of time instead of giving the answer under test.
 */
const GENEROUS_MS = 2000;
/**
 * Rounds of a timed measure, of which the least counts. Beside two full
 * suites a lone measure here once ran past its limit by a stall of about
 * half a second with the checker as it should be; load only ever lengthens a
 * measure, so a checker that is fine fails only if such a stall lands on the
 * measure in every round, while one that held the main loop for a check, or
 * waited on a crashed worker, does so in every round.
 */
const ROUNDS = 5;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture(name: string): URL {
  return new URL(`./fixtures/${name}`, import.meta.url);
}

function start(options: Partial<ArgumentCheckerOptions> = {}): {
  checker: ArgumentChecker;
  lines: string[];
} {
  const lines: string[] = [];
  const checker = new ArgumentChecker({
    budgetMs: BUDGET_MS,
    log: createLogger({ sink: (line) => lines.push(line), level: 'debug' }),
    ...options,
  });
  cleanups.push(() => checker.close());
  return { checker, lines };
}

function prepared(schema: JsonObject): PreparedSchema {
  const result = prepareForCheck(schema);
  if (!result) throw new Error('could not prepare');
  return result;
}

function fanOut(levels: number): JsonObject {
  const $defs: Record<string, unknown> = {};
  for (let level = 0; level < levels; level += 1) {
    const next = { $ref: `#/$defs/d${String(level + 1)}` };
    $defs[`d${String(level)}`] = { anyOf: [next, next] };
  }
  $defs[`d${String(levels)}`] = { type: 'object' };
  return { type: 'object', $defs, $ref: '#/$defs/d0' };
}

/** 2^30 steps: about 17 minutes on the main thread before ADR 0010. */
const FAN_OUT = prepared(fanOut(30));
const FORM = prepared({
  type: 'object',
  properties: { name: { type: 'string', maxLength: 5 } },
  required: ['name'],
});

function watchLoop(): { stop: () => number } {
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 5);
  return {
    stop: () => {
      clearInterval(timer);
      return Math.max(worst, performance.now() - last);
    },
  };
}

/**
 * The answer, or 'late' when a timer of twice the budget, set now, fires
 * first and one more turn of the loop passes: the most a check may take, the
 * budget to start and the budget again to run (ADR 0010's notes). The checker
 * gives up on a check from a timer of its own, set as the check is made, in
 * an immediate that timer queues, so a reply already in the port is read
 * first (the notes of 9 October 2026). Node runs timers in the order they
 * fall due, however late a loaded machine runs the loop, and immediates in
 * the order they were queued, so this bounds such an answer in the loop's
 * own time, which a stall cannot shift.
 */
function inTime<T>(answer: Promise<T>): Promise<T | 'late'> {
  return Promise.race([
    answer,
    delay(2 * BUDGET_MS)
      .then(() => new Promise((resolve) => setImmediate(resolve)))
      .then(() => 'late' as const),
  ]);
}

/**
 * Waits for a ready worker that has finished a check, through a replacement
 * starting and any restart backoff, so that the next overrun replaces it at
 * once (ADR 0010's notes).
 */
async function settled(checker: ArgumentChecker): Promise<void> {
  const until = performance.now() + 10_000;
  while (performance.now() < until) {
    // A first check that runs out of time under load replaces the worker; try again.
    if (
      (await checker.ready()) &&
      (await checker.check('form', FORM, { name: 'Ada' })).kind === 'valid'
    ) {
      return;
    }
    await delay(10);
  }
  throw new Error('no worker finished a check within 10 s');
}

describe('ArgumentChecker', () => {
  it('checks in the worker and describes a failure in the relay words', async () => {
    const { checker } = start({ budgetMs: GENEROUS_MS });
    expect(await checker.ready()).toBe(true);
    expect(await checker.check('form', FORM, { name: 'Ada' })).toEqual({ kind: 'valid' });
    expect(await checker.check('form', FORM, { name: 'far too long' })).toEqual({
      kind: 'invalid',
      message:
        'the arguments for tool form do not match its inputSchema: arguments/name is too long (rule "maxLength")',
    });
  });

  it('gives up on a 2^30 fan-out schema within the budget, and the main loop never waits on it', async () => {
    const { checker } = start();
    const idle: number[] = [];
    const checking: number[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      await settled(checker);
      // The yardstick: how long the loop goes without a turn over an idle wait as long as the budget.
      let loop = watchLoop();
      await delay(BUDGET_MS);
      idle.push(loop.stop());
      loop = watchLoop();
      const started = performance.now();
      expect(await inTime(checker.check('fan_out', FAN_OUT, {}))).toEqual({
        kind: 'unchecked',
        reason: 'timeout',
      });
      expect(performance.now() - started).toBeGreaterThanOrEqual(BUDGET_MS - 5);
      checking.push(loop.stop());
    }
    // Replacing the worker costs the loop a few milliseconds; holding it for the check costs the budget.
    expect(Math.min(...checking)).toBeLessThan(Math.min(...idle) + BUDGET_MS);
  }, 30_000);

  it('never makes a check wait behind a slow one for longer than the budget', async () => {
    const { checker } = start();
    expect(await checker.ready()).toBe(true);
    const slow = checker.check('fan_out', FAN_OUT, {});
    const queued = await inTime(checker.check('form', FORM, { name: 'Ada' }));
    expect(queued).toEqual({ kind: 'unchecked', reason: 'busy' });
    expect(await slow).toEqual({ kind: 'unchecked', reason: 'timeout' });
  });

  it('replaces an overrunning worker, and the replacement checks later calls as before', async () => {
    // 2^30 steps overrun any budget; the generous one keeps the replacement's checks in time.
    const { checker, lines } = start({ budgetMs: GENEROUS_MS });
    expect(await checker.ready()).toBe(true);
    const before = checker.generation;
    expect(await checker.check('fan_out', FAN_OUT, {})).toMatchObject({ kind: 'unchecked' });
    expect(checker.generation).toBe(before + 1);
    expect(await checker.ready()).toBe(true);
    expect(await checker.check('form', FORM, { name: 7 })).toEqual({
      kind: 'invalid',
      message:
        'the arguments for tool form do not match its inputSchema: arguments/name has the wrong type (rule "type")',
    });
    expect(await checker.check('form', FORM, { name: 'Ada' })).toEqual({ kind: 'valid' });
    expect(lines.join('\n')).not.toContain('d0');
  }, 15_000);

  it('reports a schema CfWorker cannot compile, and a check that throws, without page text', async () => {
    const { checker } = start({ budgetMs: GENEROUS_MS });
    expect(await checker.ready()).toBe(true);
    const old = prepared({ $schema: 'http://json-schema.org/draft-04/schema#', type: 'object' });
    expect(await checker.check('old', old, {})).toEqual({ kind: 'uncompilable' });
    const broken = prepared({ type: 'object', properties: { a: { $ref: '#/$defs/missing' } } });
    expect(await checker.check('broken', broken, { a: 1 })).toEqual({
      kind: 'unchecked',
      reason: 'failed',
    });
    // Neither failure costs the worker.
    expect(await checker.check('form', FORM, { name: 'Ada' })).toEqual({ kind: 'valid' });
  });

  it('lets checks through unchecked while a worker that fails to start is restarted with backoff', async () => {
    const { checker, lines } = start({ entry: fixture('broken-worker.ts') });
    expect(await checker.ready()).toBe(false);
    const outcome = await checker.check('form', FORM, { name: 'Ada' });
    expect(outcome).toMatchObject({ kind: 'unchecked' });
    await delay(1500);
    // Without backoff a worker that dies while loading is replaced every 50 to 100 ms.
    expect(checker.generation).toBeGreaterThanOrEqual(2);
    expect(checker.generation).toBeLessThanOrEqual(5);
    // At once while the next restart waits, or within the budget while one starts.
    expect(await inTime(checker.check('form', FORM, { name: 'Ada' }))).toMatchObject({
      kind: 'unchecked',
    });
    const stopped = lines.filter((line) => line.includes('argument check worker stopped'));
    expect(stopped.length).toBeGreaterThanOrEqual(2);
    expect(lines.join('\n')).not.toContain('broken on purpose');
  });

  it('lets a check through unchecked at once when its worker crashes, and starts another', async () => {
    // With a generous budget, a crash cannot be mistaken for an overrun, and
    // answering in far less than the budget shows the check did not wait for
    // it. Beside two full suites a crash was answered in 3 to 5 ms; a lone
    // answer once took over 500 ms, so the least of a few crashes counts.
    const took: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      const { checker } = start({ entry: fixture('crash-worker.ts'), budgetMs: GENEROUS_MS });
      expect(await checker.ready()).toBe(true);
      const before = checker.generation;
      const started = performance.now();
      expect(await checker.check('form', FORM, { name: 'Ada' })).toEqual({
        kind: 'unchecked',
        reason: 'failed',
      });
      took.push(performance.now() - started);
      expect(checker.generation).toBe(before + 1);
    }
    expect(Math.min(...took)).toBeLessThan(GENEROUS_MS / 4);
  }, 15_000);

  it('treats a reply that fails validation as a failed worker', async () => {
    const { checker } = start({ entry: fixture('garbage-worker.ts'), budgetMs: GENEROUS_MS });
    expect(await checker.ready()).toBe(true);
    const before = checker.generation;
    expect(await checker.check('form', FORM, { name: 'Ada' })).toEqual({
      kind: 'unchecked',
      reason: 'failed',
    });
    expect(checker.generation).toBe(before + 1);
  });

  it('terminates the worker on close and answers every later check unchecked', async () => {
    const heard: number[] = [];
    const channel = new BroadcastChannel('tabdock-test-worker-heartbeat');
    channel.onmessage = (event: MessageEvent) => {
      const beat: unknown = event.data;
      if (typeof beat === 'number') heard.push(beat);
    };
    cleanups.push(() => {
      channel.close();
      return Promise.resolve();
    });
    const { checker } = start({ entry: fixture('heartbeat-worker.ts'), budgetMs: GENEROUS_MS });
    expect(await checker.ready()).toBe(true);
    expect(await checker.check('form', FORM, { name: 'Ada' })).toEqual({ kind: 'valid' });
    await delay(50);
    expect(heard.length).toBeGreaterThan(0);

    await checker.close();
    const afterClose = heard.length;
    await delay(100);
    expect(heard.length).toBe(afterClose);
    expect(await checker.check('form', FORM, { name: 'Ada' })).toEqual({
      kind: 'unchecked',
      reason: 'unavailable',
    });
  });
});

/** The environment data key posting-worker.ts reads its shared count from. */
const POSTED_KEY = 'tabdock-test-worker-posted';

/**
 * A checker on posting-worker.ts, the real worker counting what it posts, and
 * a reader of that count that works while the main thread is held.
 */
function startCounting(): ReturnType<typeof start> & { posted: () => number } {
  const count = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  // Each worker reads it as it starts, replacements too, so one count covers them all.
  setEnvironmentData(POSTED_KEY, count.buffer);
  cleanups.push(() => {
    setEnvironmentData(POSTED_KEY, undefined);
    return Promise.resolve();
  });
  return {
    ...start({ entry: fixture('posting-worker.ts') }),
    posted: () => Atomics.load(count, 0),
  };
}

/**
 * Runs `work` from a setImmediate callback. After that phase Node runs the
 * timers that fell due before it next polls for messages, so whatever
 * reaches the port while `work` holds the thread waits unread behind them,
 * as it does behind a socket callback that parses a large body. Held in a
 * timer callback, or after a worker message, the thread would read the port
 * first (docs/notes/verified.md, 9 October 2026).
 */
function fromCheckPhase<T>(work: () => T): Promise<{ value: T }> {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        resolve({ value: work() });
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

/** Holds the main thread, as a long synchronous callback would, until `done`. */
function hold(done: () => boolean): void {
  const giveUp = performance.now() + 10_000;
  while (!done()) {
    if (performance.now() > giveUp) throw new Error('held the main thread for 10 s');
  }
}

/** Whether `answer` has settled, as seen from a later turn of the loop. */
function watch(answer: Promise<unknown>): () => boolean {
  let answered = false;
  void answer.then(() => {
    answered = true;
  });
  return () => answered;
}

/**
 * Resolves once every judgement already queued has run. Made after a timer
 * of the checker fell due, so after its judgement was queued, this resolves
 * after that judgement too, since immediates run in the order they were
 * queued; a test that no overrun was judged must wait for it, or it reads
 * the log before the judgement could write to it.
 */
function afterJudging(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** When fixtures/lone-overrun.ts wakes its thread, far past any prompt judgement. */
const RESCUE_MS = 3000;

/**
 * One overrun judged by a checker alone in a thread of its own, and how long
 * it took from the check to its answer.
 */
function loneOverrun(): Promise<{ outcome: unknown; took: number }> {
  return new Promise((resolve, reject) => {
    const thread = new Worker(fixture('lone-overrun.ts'), {
      workerData: { budgetMs: BUDGET_MS, rescueMs: RESCUE_MS, slow: FAN_OUT, form: FORM },
    });
    cleanups.push(() => thread.terminate().then(() => undefined));
    thread.once('message', (message: { outcome: unknown; took: number }) => {
      resolve(message);
    });
    thread.once('error', reject);
    thread.once('exit', () => {
      reject(new Error('lone-overrun.ts ended before it measured'));
    });
  });
}

const TOO_LONG: CheckOutcome = {
  kind: 'invalid',
  message:
    'the arguments for tool form do not match its inputSchema: arguments/name is too long (rule "maxLength")',
};

function overruns(lines: string[]): number {
  return lines.filter((line) =>
    line.includes('replacing the argument check worker after an overrun'),
  ).length;
}

describe('ArgumentChecker reads what the worker sent before a timer judges a check (ADR 0010, 9 October 2026)', () => {
  it('reads a reply that already waits in the port before it judges an overrun', async () => {
    const { checker, lines, posted } = startCounting();
    await settled(checker);
    const generation = checker.generation;
    const seen = posted();
    const { value: answer } = await fromCheckPhase(() => {
      const since = performance.now();
      const outcome = checker.check('form', FORM, { name: 'far too long' });
      // A compiled schema answers in well under a millisecond; the thread stays
      // held for twice the budget, so the check's timer is due before the loop
      // can read the reply.
      hold(() => posted() > seen && performance.now() - since >= 2 * BUDGET_MS);
      return outcome;
    });
    expect(await answer).toEqual(TOO_LONG);
    await afterJudging();
    expect(overruns(lines)).toBe(0);
    expect(checker.generation).toBe(generation);
  });

  it('reads a ready that already waits in the port before it gives up on a check that could not start', async () => {
    const { value: started } = await fromCheckPhase(() => {
      const counting = startCounting();
      const since = performance.now();
      const answer = counting.checker.check('form', FORM, { name: 'far too long' });
      hold(() => counting.posted() > 0 && performance.now() - since >= 2 * BUDGET_MS);
      return { ...counting, answer };
    });
    const { checker, lines, posted, answer } = started;
    const answered = watch(answer);
    // Once the ready is read the check starts, and its first compile could
    // overrun a loaded run's budget; hold again until its reply is in the
    // port too. A checker that gave up on it already has nothing to wait for.
    await fromCheckPhase(() => {
      if (!answered()) hold(() => posted() > 1);
    });
    expect(await answer).toEqual(TOO_LONG);
    await afterJudging();
    expect(overruns(lines)).toBe(0);
    expect(checker.generation).toBe(1);
  });

  it('starts a queued check once a reply that already waits in the port frees the worker', async () => {
    const { checker, lines, posted } = startCounting();
    await settled(checker);
    const generation = checker.generation;
    const seen = posted();
    const { value: answers } = await fromCheckPhase(() => {
      const since = performance.now();
      const first = checker.check('form', FORM, { name: 'Ada' });
      const queued = checker.check('form', FORM, { name: 'far too long' });
      hold(() => posted() > seen && performance.now() - since >= 2 * BUDGET_MS);
      return { first, queued };
    });
    const answered = watch(answers.queued);
    // As above: the queued check, started late, gets the whole of its own budget.
    await fromCheckPhase(() => {
      if (!answered()) hold(() => posted() > seen + 1);
    });
    expect(await answers.first).toEqual({ kind: 'valid' });
    expect(await answers.queued).toEqual(TOO_LONG);
    await afterJudging();
    expect(overruns(lines)).toBe(0);
    expect(checker.generation).toBe(generation);
  });

  it('still judges a check that overran while the thread was held, at most one turn of the loop later', async () => {
    const { checker, lines } = startCounting();
    await settled(checker);
    const generation = checker.generation;
    /** Turns of the loop since the hold ended. */
    let turn = 0;
    const inTurn = (answer: Promise<CheckOutcome>) => answer.then((outcome) => ({ outcome, turn }));
    const { value: answers } = await fromCheckPhase(() => {
      const since = performance.now();
      const slow = inTurn(checker.check('fan_out', FAN_OUT, {}));
      const queued = inTurn(checker.check('form', FORM, { name: 'Ada' }));
      // The fan-out runs for minutes, so no reply comes however long this holds.
      hold(() => performance.now() - since >= 2 * BUDGET_MS);
      // Queued now, this runs in the next check phase ahead of anything the
      // due timers queue on the way there.
      setImmediate(() => {
        turn = 1;
        setImmediate(() => {
          turn = 2;
        });
      });
      return { slow, queued };
    });
    const slow = await answers.slow;
    const queued = await answers.queued;
    expect(slow.outcome).toEqual({ kind: 'unchecked', reason: 'timeout' });
    expect(queued.outcome).toEqual({ kind: 'unchecked', reason: 'busy' });
    expect(slow.turn).toBeLessThanOrEqual(1);
    expect(queued.turn).toBeLessThanOrEqual(1);
    expect(overruns(lines)).toBe(1);
    expect(checker.generation).toBe(generation + 1);
  });

  it('judges an overrun promptly when nothing else wakes the loop', async () => {
    // The fan-out answers nothing for minutes, and in the round's own thread
    // no other timer or socket is due before RESCUE_MS, so a judgement that
    // waited for other I/O to end the poll before it would take that long.
    const took: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      const { outcome, took: roundTook } = await loneOverrun();
      expect(outcome).toEqual({ kind: 'unchecked', reason: 'timeout' });
      took.push(roundTook);
    }
    // Least of three, as for a crash above: a stall can lengthen one round, not every one.
    expect(Math.min(...took)).toBeLessThan(10 * BUDGET_MS);
  }, 30_000);
});

describe('prepareForCheck', () => {
  it('names a prepared schema by a hash of its text, so the same schema is compiled once', () => {
    const first = prepared({ type: 'object', properties: { a: { type: 'string', pattern: 'x' } } });
    const again = prepared({ type: 'object', properties: { a: { type: 'string', pattern: 'y' } } });
    expect(first.text).toBe('{"type":"object","properties":{"a":{"type":"string"}}}');
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(again).toEqual(first);
    expect(prepared({ type: 'object' }).hash).not.toBe(first.hash);
  });

  it('gives null for a schema too deep to check', () => {
    let schema: JsonObject = { type: 'string' };
    for (let level = 0; level < 100; level += 1) schema = { not: schema };
    expect(prepareForCheck(schema)).toBeNull();
  });
});

describe('CompiledChecks', () => {
  const a = prepared({ type: 'object', properties: { a: { type: 'string' } } });
  const b = prepared({ type: 'object', properties: { b: { type: 'string' } } });
  const c = prepared({ type: 'object', properties: { c: { type: 'string' } } });

  it('compiles each schema once while it stays cached, evicting the least recently used past its count', () => {
    const cache = new CompiledChecks({ maxEntries: 2, maxChars: 1_000_000 });
    const first = cache.get(a.hash, a.text);
    expect(first).not.toBeNull();
    expect(cache.get(a.hash, a.text)).toBe(first);
    cache.get(b.hash, b.text);
    // a was used more recently than b, so c evicts b.
    cache.get(a.hash, a.text);
    cache.get(c.hash, c.text);
    expect(cache.size).toBe(2);
    expect(cache.get(a.hash, a.text)).toBe(first);
    const bAgain = cache.get(b.hash, b.text);
    expect(cache.get(b.hash, b.text)).toBe(bAgain);
  });

  it('bounds the schema text it holds as well as the count', () => {
    const cache = new CompiledChecks({ maxEntries: 100, maxChars: a.text.length + b.text.length });
    cache.get(a.hash, a.text);
    cache.get(b.hash, b.text);
    expect(cache.size).toBe(2);
    cache.get(c.hash, c.text);
    expect(cache.size).toBe(2);
  });

  it('remembers a schema it cannot compile, so it is not tried again', () => {
    const cache = new CompiledChecks({ maxEntries: 2, maxChars: 1_000_000 });
    const old = prepared({ $schema: 'http://json-schema.org/draft-04/schema#' });
    expect(cache.get(old.hash, old.text)).toBeNull();
    expect(cache.size).toBe(1);
  });
});

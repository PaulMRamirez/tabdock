// ADR 0010: the argument check (ADR 0008) runs in one worker thread, never on
// the relay's main thread, because a 1.5 KB schema whose references fan out, a
// wide anyOf or a long client array can cost the validator seconds or minutes.
// The main thread keeps only each tool's prepared schema (text and hash) and
// hands the worker one check at a time. A check gets the budget to start and
// the budget again to run: one that cannot start in time because another is
// running goes unchecked at once, and one that runs past its budget goes
// unchecked while the worker is terminated and replaced. Both are judged from
// an immediate their timer queues, once the loop has read what the worker
// already sent, so other work holding the main thread cannot make a prompt
// reply lose to a timer. A worker that fails to start or crashes is restarted
// with backoff, and calls meanwhile go unchecked. Under attack, checks are
// skipped, never waited on; the check stays advisory.

import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { JsonObject } from '@tabdock/protocol';
import { type CheckRequest, type CheckResult, WorkerMessageSchema } from './check-messages.ts';
import type { Logger } from './log.ts';
import { PACKAGED } from './packaged.ts';
import { prepareSchema } from './validate.ts';

/** A tool's schema as the worker compiles it, named by a hash of its text. */
export interface PreparedSchema {
  hash: string;
  text: string;
}

/** Why a call went to its page without a check. */
export type UncheckedReason =
  /** The validator threw on these arguments, or the worker died running the check. */
  | 'failed'
  /** The check ran past its budget; its worker was replaced. */
  | 'timeout'
  /** Another check held the worker for the whole budget. */
  | 'busy'
  /** No worker was ready: starting, restarting after a failure, or shut down. */
  | 'unavailable';

export type CheckOutcome =
  | { kind: 'valid' }
  | { kind: 'invalid'; message: string }
  /** CfWorker refused the schema, so calls to the tool cannot be checked at all. */
  | { kind: 'uncompilable' }
  | { kind: 'unchecked'; reason: UncheckedReason };

export interface ArgumentCheckerOptions {
  /** RelayTimings.argumentCheckMs. */
  budgetMs: number;
  log: Logger;
  /** The worker module; tests swap in ones that misbehave. */
  entry?: URL;
}

/**
 * The worker module beside this code: the source in a checkout, and in the
 * package the bundle's own worker file, which scripts/build.ts writes next to
 * cli.js, the file this code is bundled into (ADR 0028).
 */
export function workerEntry(packaged: boolean, base: string = import.meta.url): URL {
  return new URL(packaged ? './argument-worker.js' : './argument-worker.ts', base);
}

const WORKER_ENTRY = workerEntry(PACKAGED);
/** A worker that has not said it is ready by then is treated as one that failed to start. */
const START_LIMIT_MS = 10_000;
/** Restarts after the second failure in a row wait this long, doubling up to RESTART_MAX_MS. */
const RESTART_FIRST_MS = 250;
const RESTART_MAX_MS = 30_000;
/**
 * The worker's own heap, so a schema or argument that makes the validator
 * allocate without end ends that thread rather than the relay process.
 */
const WORKER_HEAP_MB = 256;

/**
 * The page's schema as the worker will compile it, or null when it cannot be
 * checked (nested too deep). Runs on the main thread when a tools frame
 * arrives: a walk and a hash, linear in the schema, never a compile.
 */
export function prepareForCheck(schema: JsonObject): PreparedSchema | null {
  let text: string;
  try {
    text = JSON.stringify(prepareSchema(schema));
  } catch {
    return null;
  }
  return { hash: createHash('sha256').update(text).digest('hex'), text };
}

interface Job {
  request: CheckRequest;
  resolve: (outcome: CheckOutcome) => void;
  /** Ends the wait of a job that could not start within the budget. */
  startTimer: NodeJS.Timeout | null;
  /** Whether another check held the worker while this one waited, for the reason it gives up with. */
  queuedBehind: boolean;
}

interface Running {
  job: Job;
  timer: NodeJS.Timeout;
}

function unchecked(reason: UncheckedReason): CheckOutcome {
  return { kind: 'unchecked', reason };
}

/**
 * Runs a timer's judgement about the worker after the loop next reads it.
 * When another callback holds the main thread past the budget, Node runs the
 * timers that fell due before it polls the port, so a reply or ready that
 * arrived in time would lose to them; an immediate runs after that poll
 * (ADR 0010's notes, 9 October 2026). Left referenced, because an
 * unreferenced one lets that poll sleep until other I/O comes, which would
 * leave the judgement without a bound.
 */
function afterReading(judge: () => void): void {
  setImmediate(judge);
}

function fromWorker(result: CheckResult): CheckOutcome {
  return result.kind === 'failed' ? unchecked('failed') : result;
}

export class ArgumentChecker {
  readonly #budgetMs: number;
  readonly #log: Logger;
  readonly #entry: URL;
  #worker: Worker | null = null;
  #ready = false;
  #closed = false;
  #generation = 0;
  /** Failures since a check last completed, for the restart backoff. */
  #failures = 0;
  #startLimit: NodeJS.Timeout | null = null;
  #restartTimer: NodeJS.Timeout | null = null;
  /** Checks waiting for the worker, oldest first. */
  readonly #waiting = new Set<Job>();
  #running: Running | null = null;
  #nextId = 0;
  /** ready() callers waiting on the current worker's first ready or failure. */
  #readyWaiters: ((ready: boolean) => void)[] = [];

  constructor(options: ArgumentCheckerOptions) {
    this.#budgetMs = options.budgetMs;
    this.#log = options.log;
    this.#entry = options.entry ?? WORKER_ENTRY;
    this.#spawn();
  }

  /** How many workers have been started, the current one included. */
  get generation(): number {
    return this.#generation;
  }

  /**
   * Resolves true once the current worker is ready, false if it fails first or
   * the checker is closed. The relay waits on this before it listens, so its
   * first calls are checked.
   */
  ready(): Promise<boolean> {
    if (this.#ready) return Promise.resolve(true);
    if (this.#closed || this.#worker === null) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.#readyWaiters.push(resolve);
    });
  }

  /** Checks one call's arguments. Never throws and never takes much more than twice the budget. */
  check(tool: string, schema: PreparedSchema, args: JsonObject): Promise<CheckOutcome> {
    // Nothing is coming soon to run it, so the call need not wait at all.
    if (this.#closed || this.#worker === null) return Promise.resolve(unchecked('unavailable'));
    let argsText: string;
    try {
      argsText = JSON.stringify(args);
    } catch {
      // The invoke frame was encoded already, so this does not happen; still never throw.
      return Promise.resolve(unchecked('failed'));
    }
    return new Promise((resolve) => {
      this.#nextId += 1;
      const job: Job = {
        request: {
          t: 'check',
          id: this.#nextId,
          tool,
          hash: schema.hash,
          schema: schema.text,
          args: argsText,
        },
        resolve,
        startTimer: null,
        queuedBehind: this.#running !== null,
      };
      job.startTimer = setTimeout(() => {
        afterReading(() => {
          // Started once a ready or a reply was read, or settled by a failure or close.
          if (!this.#waiting.delete(job)) return;
          // Behind a check that overran, the wait ends while its replacement starts: still busy.
          job.resolve(unchecked(job.queuedBehind || this.#running ? 'busy' : 'unavailable'));
        });
      }, this.#budgetMs);
      job.startTimer.unref();
      this.#waiting.add(job);
      this.#pump();
    });
  }

  /** Terminates the worker and answers every waiting check unchecked. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    this.#settleAll(unchecked('unavailable'));
    this.#answerReady(false);
    const worker = this.#retire();
    if (worker) await worker.terminate();
  }

  #spawn(): void {
    this.#restartTimer = null;
    if (this.#closed) return;
    this.#generation += 1;
    let worker: Worker;
    try {
      worker = new Worker(this.#entry, {
        resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
      });
    } catch {
      this.#failed(null, 'the argument check worker could not be created');
      return;
    }
    // The relay's own servers keep the process alive; a stray worker must not.
    worker.unref();
    this.#worker = worker;
    this.#ready = false;
    this.#startLimit = setTimeout(() => {
      this.#failed(worker, 'the argument check worker did not start in time');
    }, START_LIMIT_MS);
    this.#startLimit.unref();
    worker.on('message', (message: unknown) => {
      this.#onMessage(worker, message);
    });
    worker.on('messageerror', () => {
      this.#failed(worker, 'the argument check worker sent a message that could not be read');
    });
    // Never the error itself: its message could quote whatever the worker was given.
    worker.on('error', () => {
      this.#failed(worker, 'the argument check worker stopped');
    });
    worker.on('exit', () => {
      this.#failed(worker, 'the argument check worker stopped');
    });
  }

  #onMessage(worker: Worker, raw: unknown): void {
    if (worker !== this.#worker) return;
    const parsed = WorkerMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.#failed(worker, 'the argument check worker sent a message of the wrong shape');
      return;
    }
    const message = parsed.data;
    if (message.t === 'ready') {
      if (this.#startLimit) clearTimeout(this.#startLimit);
      this.#startLimit = null;
      this.#ready = true;
      this.#answerReady(true);
      this.#pump();
      return;
    }
    const running = this.#running;
    // A reply to a check that already timed out cannot arrive from this worker,
    // since an overrun replaces it; an unknown id is ignored all the same.
    if (running?.job.request.id !== message.id) return;
    clearTimeout(running.timer);
    this.#running = null;
    this.#failures = 0;
    running.job.resolve(fromWorker(message.result));
    this.#pump();
  }

  /** Hands the oldest waiting check to the worker when it is ready and idle. */
  #pump(): void {
    const worker = this.#worker;
    if (!worker || !this.#ready || this.#running) return;
    const job = this.#waiting.values().next().value;
    if (!job) return;
    this.#waiting.delete(job);
    if (job.startTimer) clearTimeout(job.startTimer);
    const running: Running = {
      job,
      timer: setTimeout(() => {
        afterReading(() => {
          this.#overrun(worker, running);
        });
      }, this.#budgetMs),
    };
    running.timer.unref();
    this.#running = running;
    try {
      worker.postMessage(job.request);
    } catch {
      this.#failed(worker, 'the argument check worker could not be sent a check');
    }
  }

  #overrun(worker: Worker, running: Running): void {
    // Its reply was read first, or a failure or close settled it; the worker
    // may already be running the next check, which this must not judge.
    if (worker !== this.#worker || this.#running !== running) return;
    this.#running = null;
    running.job.resolve(unchecked('timeout'));
    this.#log.debug('replacing the argument check worker after an overrun');
    this.#replace();
  }

  /** A worker that died, never started or misbehaved: its check goes unchecked and another starts. */
  #failed(worker: Worker | null, message: string): void {
    if (worker !== this.#worker) return;
    if (this.#running) {
      clearTimeout(this.#running.timer);
      this.#running.job.resolve(unchecked('failed'));
      this.#running = null;
    }
    const delay = this.#replace();
    if (!this.#closed) {
      this.#log.warn(`${message}; calls go to the page unchecked until another starts`, {
        restartInMs: delay,
      });
    }
  }

  /**
   * Retires the current worker and starts the next: at once after a first
   * failure, with doubling waits after more in a row. Returns the wait.
   */
  #replace(): number {
    const old = this.#retire();
    if (old) {
      old.terminate().catch(() => {
        // It is gone either way.
      });
    }
    this.#answerReady(false);
    if (this.#closed) return 0;
    this.#failures += 1;
    const delay =
      this.#failures <= 1
        ? 0
        : Math.min(RESTART_MAX_MS, RESTART_FIRST_MS * 2 ** (this.#failures - 2));
    if (delay === 0) {
      this.#spawn();
    } else {
      // Nothing will run for a while, so nobody waits for it.
      this.#settleAll(unchecked('unavailable'));
      this.#restartTimer = setTimeout(() => {
        this.#spawn();
      }, delay);
      this.#restartTimer.unref();
    }
    return delay;
  }

  /** Forgets the current worker so none of its events count any more; returns it. */
  #retire(): Worker | null {
    const worker = this.#worker;
    this.#worker = null;
    this.#ready = false;
    if (this.#startLimit) clearTimeout(this.#startLimit);
    this.#startLimit = null;
    worker?.removeAllListeners();
    // A worker that is terminated may still emit; swallow what it says.
    worker?.on('error', () => undefined);
    return worker;
  }

  #settleAll(outcome: CheckOutcome): void {
    if (this.#running) {
      clearTimeout(this.#running.timer);
      this.#running.job.resolve(outcome);
      this.#running = null;
    }
    for (const job of this.#waiting) {
      if (job.startTimer) clearTimeout(job.startTimer);
      job.resolve(outcome);
    }
    this.#waiting.clear();
  }

  #answerReady(ready: boolean): void {
    const waiters = this.#readyWaiters;
    this.#readyWaiters = [];
    for (const waiter of waiters) waiter(ready);
  }
}

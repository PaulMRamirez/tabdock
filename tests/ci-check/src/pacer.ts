// Pacing a walk under the relay's default rates (ADR 0041, decision 3). The
// relay allows a user 120 page calls a minute on a page and 240 requests a
// minute in all; the walk takes at most 100 and 200 in any 60 s window, so a
// check never teaches anyone to raise a limit. A walk that would take more
// than 10 minutes this way splits into one test per walkthrough, sharded
// across runners, each with its own relay and budgets.

export const PAGE_CALLS_PER_MINUTE = 100;
export const REQUESTS_PER_MINUTE = 200;
const WINDOW_MS = 60_000;

export interface Pacer {
  /** Resolves once one more use fits in the window, and counts it. */
  take(): Promise<void>;
}

export interface PacerOptions {
  readonly perMinute: number;
  /** The clock; Date.now unless a test gives its own. */
  readonly now?: () => number;
  /** How to wait; a timer unless a test gives its own. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** A sliding 60 s window of at most `perMinute` uses, taken one at a time in the order asked. */
export function createPacer(options: PacerOptions): Pacer {
  const { perMinute } = options;
  if (!Number.isInteger(perMinute) || perMinute < 1) {
    throw new TypeError('perMinute must be a whole number, 1 or more');
  }
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const taken: number[] = [];
  // One take at a time, so two callers never both see room for one.
  let queue: Promise<void> = Promise.resolve();
  const takeOne = async (): Promise<void> => {
    for (;;) {
      const at = now();
      while (taken.length > 0 && (taken[0] ?? 0) <= at - WINDOW_MS) taken.shift();
      if (taken.length < perMinute) {
        taken.push(at);
        return;
      }
      await sleep((taken[0] ?? at) + WINDOW_MS - at);
    }
  };
  return {
    take() {
      const next = queue.then(takeOne);
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

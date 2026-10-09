// The least time each of two works takes, for the S9 checks that some work
// stays linear in what a page or client sends. Such a check compares two
// measures taken in the same run, never one measure against a ceiling in
// milliseconds: load from other test files and processes slows both alike
// but leaves a ceiling where it is, and on a fast enough machine
// super-linear work comes in under one. The tests that time this way say
// what each pair is, what it measured and what bound it holds. Where the two
// works of a pair can each run past a scheduler's slice, they are made to
// take about as long as each other: on a core shared with busy processes a
// work waits out their slices each time its own runs out, so load stretches
// a long work's least time by more than a short one's.

/**
 * Rounds of each pair of measures. Load only ever lengthens a measure, so a
 * work's least measure is its own cost unless all of them were stalled: to
 * put one work past its bound, a stall longer than the work would have to
 * land on every measure of it while some measure of the other escaped. That
 * is unlikely only while stalls land on rounds independently, and rounds
 * taken back to back in a fixed order are not independent: on a core shared
 * fairly with busy processes, rounds of one length fall in step with the
 * scheduler's slices and the same measure is cut off in every round. Taken
 * so, the linear defusing in page-tools.test.ts read 3.05 against its bound
 * of 3 once beside two full suites, and past 3 in 4 checks of 300, up to 10,
 * pinned to one core beside four or seven busy loops. So each round takes
 * the two in a random order, each after a random wait.
 */
export const ROUNDS = 15;
/**
 * The longest wait before a measure: about a scheduler slice on a busy core,
 * a few milliseconds, so that each measure starts at a random point of one.
 */
const STAGGER_MS = 3;
/**
 * No round starts once the rounds have taken this long, so super-linear work
 * fails in seconds rather than minutes. The linear work in page-tools.test.ts
 * takes each measure's ROUNDS in under 0.3 s idle, so it takes fewer only on
 * a machine slowed about sevenfold. A test whose measures take milliseconds
 * or more allows 30 s: on a machine that slow, three measures and their
 * untimed checks could pass vitest's default 5 s and fail a test whose
 * measures compare as they should.
 */
const ROUNDS_MS = 2000;

/** Waits busily for a random time up to STAGGER_MS. */
function stagger(): void {
  const until = performance.now() + Math.random() * STAGGER_MS;
  while (performance.now() < until) continue;
}

/** The least time each of two works took, over rounds that take both in a random order. */
export function leastTimes(first: () => unknown, second: () => unknown): [number, number] {
  const least: [number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const measure = (slot: 0 | 1, work: () => unknown): void => {
    stagger();
    const before = performance.now();
    work();
    least[slot] = Math.min(least[slot], performance.now() - before);
  };
  const started = performance.now();
  for (let round = 0; round < ROUNDS; round += 1) {
    if (round > 0 && performance.now() - started > ROUNDS_MS) break;
    if (Math.random() < 0.5) {
      measure(0, first);
      measure(1, second);
    } else {
      measure(1, second);
      measure(0, first);
    }
  }
  return least;
}

/**
 * leastTimes for works that end when their promise does, such as a frame
 * sent to a relay and its ping answered, over at most `rounds` rounds.
 */
export async function leastTimesAsync(
  first: () => Promise<unknown>,
  second: () => Promise<unknown>,
  rounds = ROUNDS,
): Promise<[number, number]> {
  const least: [number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const measure = async (slot: 0 | 1, work: () => Promise<unknown>): Promise<void> => {
    stagger();
    const before = performance.now();
    await work();
    least[slot] = Math.min(least[slot], performance.now() - before);
  };
  const started = performance.now();
  for (let round = 0; round < rounds; round += 1) {
    if (round > 0 && performance.now() - started > ROUNDS_MS) break;
    if (Math.random() < 0.5) {
      await measure(0, first);
      await measure(1, second);
    } else {
      await measure(1, second);
      await measure(0, first);
    }
  }
  return least;
}

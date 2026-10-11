// Each page's latest published state (ADR 0040): its canonical text, a
// version counted per page session, and the readers waiting on a change,
// kept out of hub.ts as confirm.ts keeps the questions in clients. It never
// logs a value.
//
// Only the canonical text is kept, never the object parsed from the frame,
// which ADR 0018 measured at up to twenty times its size, and only the
// latest: a page's past views stay with the page (ADR 0040's decision 5).
// What every page holds is charged against limits.stateBytes; a value that
// would pass it is withheld (the version rises and the value reads null)
// rather than the page closed, which would take its tools away too. Equal
// versions always mean equal values: a sleep, or a resume that replaces a
// socket, drops a held value and raises the version, so no number ever names
// two values, and a client that misses changes sees the version jump.
//
// A wait is woken by any change of version. What it answers is decided by
// the hub, which runs its access check again after the wait (S8), so this
// module only says why a wait ended.

import type { HubError } from './hub.ts';
import type { PagePart } from './page-parts.ts';

/**
 * What one stored value costs beside its text: the entry, its map slot, its
 * set of waiters and the bookkeeping. state-heap.test.ts measured about 1.2
 * KiB a page beside the text, which ADR 0040's design had put at 1 KiB, so
 * this is twice that and the charge never falls below the heap it stands for.
 */
export const STATE_HEAP_BYTES = 2048;

/** A held text's charge: V8 keeps a string at up to two bytes a UTF-16 unit. */
export function stateCharge(text: string | null): number {
  return text === null ? 0 : STATE_HEAP_BYTES + 2 * text.length;
}

/** A page's state as the fixed tools read it. */
export interface StateView {
  version: number;
  /** The value's canonical JSON text, never parsed again; null when the page shares nothing. */
  text: string | null;
  /** When the page published this version's value; null for none, as when the relay dropped it. */
  publishedAt: number | null;
}

/** What a state frame did: nothing, a new version, or a new version withheld past the budget. */
export type PublishOutcome = 'unchanged' | 'changed' | 'withheld';

/** Why a wait ended: the version moved, its time ran out, its request was cancelled, or the hub ended it. */
export type WaitEnd = { kind: 'changed' } | { kind: 'timeout' } | { kind: 'cancelled' } | HubError;

interface Waiter {
  userId: string;
  end: (why: WaitEnd) => void;
}

interface Entry extends StateView {
  charge: number;
  waiters: Set<Waiter>;
}

const NOTHING: StateView = Object.freeze({ version: 0, text: null, publishedAt: null });

function stateError(code: HubError['code'], message: string): HubError {
  return { kind: 'error', code, message };
}

const ASLEEP = stateError(
  'page_asleep',
  'the page disconnected while you waited; it keeps your attachment if it comes back within the resume window',
);
const RELOADED = stateError(
  'page_asleep',
  'the page reloaded while you waited; wait again once it is back',
);
const GONE = stateError(
  'page_gone',
  'the page closed and did not come back; its attachments are gone',
);
const SHUTTING_DOWN = stateError('page_asleep', 'the relay is shutting down');

export class PageStates implements PagePart {
  /** limits.stateBytes: what every page's held state may cost together. */
  readonly #budget: number;
  readonly #entries = new Map<string, Entry>();
  #held = 0;

  constructor(budget: number) {
    this.#budget = budget;
  }

  /** What every page's held state is charged together, for the hub's debug line. */
  get held(): number {
    return this.#held;
  }

  /** The page's state now: version 0 and nothing before it ever published. */
  read(pageId: string): StateView {
    const entry = this.#entries.get(pageId);
    return entry
      ? { version: entry.version, text: entry.text, publishedAt: entry.publishedAt }
      : NOTHING;
  }

  #entry(pageId: string): Entry {
    let entry = this.#entries.get(pageId);
    if (!entry) {
      entry = { version: 0, text: null, publishedAt: null, charge: 0, waiters: new Set() };
      this.#entries.set(pageId, entry);
    }
    return entry;
  }

  /**
   * Keeps the page's new value, as canonical JSON text (null for none). An
   * equal one changes nothing. One that would take what every page holds
   * past the budget is withheld: the version still rises, so readers learn
   * the page moved on, but the value reads null rather than a stale one.
   */
  publish(pageId: string, text: string | null, now: number): PublishOutcome {
    const existing = this.#entries.get(pageId);
    if ((existing?.text ?? null) === text) return 'unchanged';
    const entry = existing ?? this.#entry(pageId);
    const charge = stateCharge(text);
    const fits = this.#held - entry.charge + charge <= this.#budget;
    this.#held -= entry.charge;
    entry.text = fits ? text : null;
    entry.charge = fits ? charge : 0;
    this.#held += entry.charge;
    entry.version += 1;
    entry.publishedAt = now;
    this.#wake(entry, { kind: 'changed' });
    return fits ? 'changed' : 'withheld';
  }

  /**
   * Waits for the page's version to move, at most `timeoutMs`; a cancelled
   * request ends it at once. The caller has already found the version where
   * it was asked to wait from, holds a wait slot (waits.ts) and its request
   * charge, and checks access again once this resolves.
   */
  wait(pageId: string, userId: string, timeoutMs: number, signal: AbortSignal): Promise<WaitEnd> {
    if (signal.aborted) return Promise.resolve({ kind: 'cancelled' });
    const entry = this.#entry(pageId);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        userId,
        end: (why) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          entry.waiters.delete(waiter);
          this.#prune(pageId, entry);
          resolve(why);
        },
      };
      const onAbort = (): void => {
        waiter.end({ kind: 'cancelled' });
      };
      const timer = setTimeout(() => {
        waiter.end({ kind: 'timeout' });
      }, timeoutMs);
      timer.unref();
      signal.addEventListener('abort', onAbort, { once: true });
      entry.waiters.add(waiter);
    });
  }

  /** An entry that holds nothing and has nobody waiting is only a version: dropped if it is still 0. */
  #prune(pageId: string, entry: Entry): void {
    if (entry.version !== 0 || entry.waiters.size > 0) return;
    if (this.#entries.get(pageId) === entry) this.#entries.delete(pageId);
  }

  #wake(entry: Entry, why: WaitEnd, only?: ReadonlySet<string>): void {
    for (const waiter of [...entry.waiters]) {
      if (only === undefined || only.has(waiter.userId)) waiter.end(why);
    }
  }

  /** The value goes, and the version rises if one was held, so no number names two values. */
  #drop(pageId: string, why: HubError): void {
    const entry = this.#entries.get(pageId);
    if (!entry) return;
    if (entry.text !== null) {
      this.#held -= entry.charge;
      entry.text = null;
      entry.charge = 0;
      entry.version += 1;
      entry.publishedAt = null;
    }
    this.#wake(entry, why);
  }

  sleep(pageId: string): void {
    this.#drop(pageId, ASLEEP);
  }

  resumed(pageId: string): void {
    this.#drop(pageId, RELOADED);
  }

  gone(pageId: string): void {
    const entry = this.#entries.get(pageId);
    if (!entry) return;
    this.#held -= entry.charge;
    this.#entries.delete(pageId);
    this.#wake(entry, GONE);
  }

  attachmentsEnded(pageId: string, users: ReadonlySet<string>, outcome: HubError): void {
    const entry = this.#entries.get(pageId);
    if (entry) this.#wake(entry, outcome, users);
  }

  policyChanged(): void {
    // Every attached role may read state (ADR 0040), so no policy narrows who waits.
  }

  close(): void {
    for (const entry of [...this.#entries.values()]) this.#wake(entry, SHUTTING_DOWN);
  }
}

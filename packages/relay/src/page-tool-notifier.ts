// When a member hears that their first-class tool list changed (ADRs 0025
// and 0032). The list itself never waits: hub.ts serves every tools/list from
// what holds at that moment. Only the notification waits, so a page that
// keeps changing its tools cannot make each of a member's clients list again
// on every change: every 2026-07-28 tools/list spends the request budget
// (ADR 0030), and at one notification a second four clients spent all of a
// member's 240 a minute. So a change goes at once when none went to that
// user in the last interval (FIRST_CLASS_NOTIFY_INTERVAL_MS, the list's own
// ttlMs), and otherwise one goes at the interval's end if the list's digest
// still differs from the last one sent; none goes when the digest is
// unchanged, so a page that drops and returns within the interval sends
// nothing more. "At once" is the end of the current turn: the hub marks a
// user in the middle of its own changes, and the digest is read only once
// they are done, so a revoke and a fresh grant in one turn send nothing.
//
// Each user is told on their own channels only (relay.ts): their 2025-era
// sessions' GET streams and their own listen handler, never another user's
// (S13). State is kept only for a user whose list is not empty or who has a
// notification pending, and members are an allowlist, so it stays small.

import { FIRST_CLASS_NOTIFY_INTERVAL_MS } from '@tabdock/protocol';

export interface PageToolNotifierOptions {
  /** The digest of the user's list as tools/list would serve it now. */
  digestOf: (userId: string) => string;
  /** The digest of an empty list, where every user starts. */
  emptyDigest: string;
  /** Tells the user's own sessions and listen streams that their list changed. */
  send: (userId: string) => void;
  /** FIRST_CLASS_NOTIFY_INTERVAL_MS unless a test shortens it. */
  intervalMs?: number;
}

interface UserState {
  /** The digest of the list the user was last told of (or started with). */
  sentDigest: string;
  /**
   * A look pending: at the end of the turn for a first change, or, after
   * the user was told, at the end of the interval since.
   */
  timer: NodeJS.Timeout | null;
}

export class PageToolNotifier {
  readonly #options: PageToolNotifierOptions;
  readonly #intervalMs: number;
  readonly #users = new Map<string, UserState>();
  /** The user whose list is being read, so a mark the read itself causes is that read. */
  #looking: string | null = null;
  #closed = false;

  constructor(options: PageToolNotifierOptions) {
    this.#options = options;
    this.#intervalMs = options.intervalMs ?? FIRST_CLASS_NOTIFY_INTERVAL_MS;
  }

  /** Users with state: a list not empty, or a notification pending. */
  get size(): number {
    return this.#users.size;
  }

  /** The user's list may have changed; it is looked at once the change is over. */
  changed(userId: string): void {
    if (this.#closed || this.#looking === userId) return;
    let state = this.#users.get(userId);
    if (state === undefined) {
      state = { sentDigest: this.#options.emptyDigest, timer: null };
      this.#users.set(userId, state);
    }
    // Within the interval after a notification its timer is still pending,
    // and that look takes this change; otherwise this one goes at once.
    if (state.timer !== null) return;
    state.timer = setTimeout(() => {
      this.#flush(userId);
    }, 0);
    state.timer.unref();
  }

  /**
   * Tells the user if their list's digest moved since they were last told,
   * and then looks again at the interval's end, so whatever changes in
   * between goes out as one notification then, or none.
   */
  #flush(userId: string): void {
    const state = this.#users.get(userId);
    if (state === undefined || this.#closed) return;
    state.timer = null;
    // The hub may mark this user again while it builds the list (an
    // attachment found past its time ends there); the digest is read after
    // that end, so this look covers the mark.
    this.#looking = userId;
    let digest: string;
    try {
      digest = this.#options.digestOf(userId);
    } finally {
      this.#looking = null;
    }
    if (digest !== state.sentDigest) {
      state.sentDigest = digest;
      this.#options.send(userId);
      state.timer = setTimeout(() => {
        this.#flush(userId);
      }, this.#intervalMs);
      state.timer.unref();
      return;
    }
    // Nothing left to remember once the user's clients last heard of an
    // empty list: no notification is pending, so a later change may go at once.
    if (state.sentDigest === this.#options.emptyDigest) this.#users.delete(userId);
  }

  close(): void {
    this.#closed = true;
    for (const state of this.#users.values()) {
      if (state.timer !== null) clearTimeout(state.timer);
    }
    this.#users.clear();
  }
}

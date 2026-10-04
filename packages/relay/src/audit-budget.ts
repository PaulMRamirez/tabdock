// The refusal budget in front of the audit log (S7, ADR 0019). A call that
// reaches a page, and every record an attachment or the operator causes, is
// written in full; the hub hands those to the log directly. A refusal that
// never reached a page (a call refused before it went out, a code or a
// redemption turned away, a request past ADR 0018's budget) comes here
// instead. A member, or any account holding an attachment, writes up to
// auditRefusalsPerUser such lines a window, then one refused_summary a window
// with its counts by outcome. An account holding no attachment, which with
// invites on is anyone who signed up at the provider, also shares the
// relay-wide auditRefusalsForStrangers, and past either budget its refusals
// go into one relay-wide refused_summary a window naming the
// REFUSED_SUMMARY_BUSIEST busiest and counting the rest together. However
// many accounts strangers open, they then add about 31 lines a minute to the
// log, so they cannot push the records that matter out of its cap.

import {
  type AuditEvent,
  type AuditEventOf,
  type AuditOutcome,
  InviteeIdSchema,
  REFUSED_SUMMARY_BUSIEST,
} from '@tabdock/protocol';
import { SlidingWindowLimiter } from './rate-limit.ts';

/** The records a refusal that reached no page is written as. */
export type RefusalEvent =
  AuditEventOf<'call'> | AuditEventOf<'attach_refused'> | AuditEventOf<'request_refused'>;

type Counts = Partial<Record<AuditOutcome, number>>;

/**
 * Strangers counted by name in one window. Past it, behind open sign-up, the
 * rest go into the summary's others with their counts, each refusal counted
 * as an account of its own, so the summary still counts every refusal while
 * the map stays bounded.
 */
export const MAX_STRANGERS_COUNTED = 10_000;

export interface AuditBudgetOptions {
  /** Lines one account may write a window (RelayRateLimits.auditRefusalsPerUser). */
  perUser: number;
  /** Lines all accounts holding no attachment may write together a window (auditRefusalsForStrangers). */
  strangers: number;
  windowMs: number;
  /** Whether a user holds an attachment to any page (PageHub.holds). */
  holds(userId: string): boolean;
  /** Writes one record to the audit log and its stderr copy (recordAudit). */
  write(event: AuditEvent): void;
}

function add(counts: Counts, outcome: AuditOutcome): void {
  counts[outcome] = (counts[outcome] ?? 0) + 1;
}

function total(counts: Counts): number {
  let sum = 0;
  for (const count of Object.values(counts)) sum += count;
  return sum;
}

export class AuditRefusalBudget {
  readonly #options: AuditBudgetOptions;
  readonly #perUser: SlidingWindowLimiter;
  /** Keyed by user too, but over strangers, whose keys anyone can mint: capped lower. */
  readonly #perStranger: SlidingWindowLimiter;
  readonly #strangers: SlidingWindowLimiter;
  /** Members' and holders' refusals past their budget this window, by user. */
  #users = new Map<string, Counts>();
  /** Strangers' refusals past either budget this window, by user. */
  #pool = new Map<string, Counts>();
  #others: { accounts: number; counts: Counts } = { accounts: 0, counts: {} };
  #since: number;
  readonly #timer: NodeJS.Timeout;
  #closed = false;

  constructor(options: AuditBudgetOptions) {
    this.#options = options;
    this.#perUser = new SlidingWindowLimiter(options.perUser, options.windowMs);
    this.#perStranger = new SlidingWindowLimiter(
      options.perUser,
      options.windowMs,
      MAX_STRANGERS_COUNTED,
    );
    this.#strangers = new SlidingWindowLimiter(options.strangers, options.windowMs);
    this.#since = Date.now();
    this.#timer = setInterval(() => {
      this.flush();
    }, options.windowMs);
    // The summaries must never keep a closing relay alive.
    this.#timer.unref();
  }

  /** Writes the refusal's own line within budget, or counts it for the window's summary. */
  refused(event: RefusalEvent): void {
    // Past close only what the shutdown itself fails is left, a bounded few,
    // and no summary would follow to count them.
    if (this.#closed) {
      this.#options.write(event);
      return;
    }
    const now = Date.now();
    const { userId, outcome } = event;
    const stranger = InviteeIdSchema.safeParse(userId).success && !this.#options.holds(userId);
    if (!stranger) {
      if (this.#perUser.allows(userId, now)) {
        this.#perUser.record(userId, now);
        this.#options.write(event);
        return;
      }
      let counts = this.#users.get(userId);
      if (counts === undefined) {
        counts = {};
        this.#users.set(userId, counts);
      }
      add(counts, outcome);
      return;
    }
    if (this.#perStranger.allows(userId, now) && this.#strangers.allows('relay', now)) {
      this.#perStranger.record(userId, now);
      this.#strangers.record('relay', now);
      this.#options.write(event);
      return;
    }
    let counts = this.#pool.get(userId);
    if (counts === undefined) {
      if (this.#pool.size >= MAX_STRANGERS_COUNTED) {
        this.#others.accounts += 1;
        add(this.#others.counts, outcome);
        return;
      }
      counts = {};
      this.#pool.set(userId, counts);
    }
    add(counts, outcome);
  }

  /** The window's summaries, one per account over its own budget and one for the strangers' pool. */
  flush(): void {
    const now = Date.now();
    const since = this.#since;
    this.#since = now;
    for (const [userId, counts] of this.#users) {
      this.#options.write({
        v: 1,
        type: 'refused_summary',
        at: now,
        since,
        scope: { kind: 'user', userId, counts },
      });
    }
    this.#users = new Map();
    if (this.#pool.size === 0 && this.#others.accounts === 0) return;
    const ranked = [...this.#pool].sort((a, b) => total(b[1]) - total(a[1]));
    const others = this.#others;
    for (const [, counts] of ranked.slice(REFUSED_SUMMARY_BUSIEST)) {
      others.accounts += 1;
      for (const [outcome, count] of Object.entries(counts) as [AuditOutcome, number][]) {
        others.counts[outcome] = (others.counts[outcome] ?? 0) + count;
      }
    }
    this.#options.write({
      v: 1,
      type: 'refused_summary',
      at: now,
      since,
      scope: {
        kind: 'relay',
        busiest: ranked
          .slice(0, REFUSED_SUMMARY_BUSIEST)
          .map(([userId, counts]) => ({ userId, counts })),
        others,
      },
    });
    this.#pool = new Map();
    this.#others = { accounts: 0, counts: {} };
  }

  /** The last summaries, written before the log closes after the hub (ADR 0019). */
  close(): void {
    if (this.#closed) return;
    clearInterval(this.#timer);
    this.flush();
    this.#closed = true;
  }
}

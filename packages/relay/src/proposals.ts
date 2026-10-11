// Each page's proposals from observers (ADR 0042): pending ones waiting for
// the operator, the outcomes kept for their proposers, and the relay-wide
// charge limits.proposalBytes bounds, kept out of hub.ts as confirm.ts keeps
// the questions in clients. It holds no socket: whatever a page or the audit
// log must hear of an end goes through the hub's `ended` hook. It never logs
// arguments or results.
//
// A proposal outlives the request that made it, by up to ten minutes, so
// what it holds is charged here rather than to any request: its arguments
// while it may still run, then its run's text, cut, for its proposer to read
// (S9). A new proposal or a new result makes room by dropping the oldest
// results the relay holds, never a pending proposal's arguments; past that a
// new proposal is refused, and a result that still does not fit is dropped,
// its outcome kept. Settled proposals stay readable for
// PROPOSAL_OUTCOME_KEEP_MS, at most MAX_SETTLED_PROPOSALS_PER_PAGE a page,
// and every one ends with its page (decision 12).

import { createHash } from 'node:crypto';
import {
  agentKeyInput,
  type AuditEventOf,
  type ErrorCode,
  INVITEE_ID_PREFIX,
  type JsonObject,
  MAX_PENDING_PROPOSALS_PER_PAGE,
  MAX_PENDING_PROPOSALS_PER_USER,
  MAX_PROPOSAL_RESULT_CHARS,
  MAX_SETTLED_PROPOSALS_PER_PAGE,
  PROPOSAL_OUTCOME_KEEP_MS,
  type ProposalEndReason,
  truncate,
} from '@tabdock/protocol';
import { type HeldTally, holdValue } from './held-tally.ts';
import type { CallerIdentity, HubError, ProposalStatus } from './hub.ts';
import type { PagePart } from './page-parts.ts';

/**
 * What one proposal costs beside its values: the record, its map and set
 * slots, its timer, its waiters and its proposer's identity.
 * proposal-heap.test.ts measured about 1.5 KiB, past the design's 1 KiB, so
 * this is 2 KiB, as page-state.ts rounds its own up, and no charge falls
 * below the heap it stands for.
 */
export const PROPOSAL_HEAP_BYTES = 2048;

/** Each value and key of a kept argument object, as a listed tool's cut copy costs (hub.ts). */
const PROPOSAL_NODE_HEAP_BYTES = 128;

/** What a proposal's arguments are charged while it may still run: V8 keeps a string at two bytes a unit at most. */
export function proposalCharge(args: JsonObject): number {
  const tally: HeldTally = { nodes: 0, chars: 0 };
  holdValue(args, tally);
  return PROPOSAL_HEAP_BYTES + tally.nodes * PROPOSAL_NODE_HEAP_BYTES + 2 * tally.chars;
}

/** What a kept result is charged. */
function resultCharge(text: string): number {
  return PROPOSAL_HEAP_BYTES + 2 * text.length;
}

/** How an accepted proposal stands: running, or how its run ended. */
export type ProposalOutcome = 'running' | 'ok' | 'tool_error' | 'relay_error' | ErrorCode;

/**
 * Whether an agent token made this attachment (ADR 0044): an agent's id is
 * an invitee's, drawn from the page and the token's id, so the attachment
 * says so itself whatever route its caller came by. An agent never proposes
 * (conflict C13), and 'all' would otherwise take it as any invitee.
 */
export function madeByAgentToken(attachment: {
  readonly pageId: string;
  readonly userId: string;
  readonly inviteId: string | null;
}): boolean {
  if (attachment.inviteId === null || !attachment.userId.startsWith(INVITEE_ID_PREFIX))
    return false;
  const hash = createHash('sha256')
    .update(agentKeyInput(attachment.pageId, attachment.inviteId), 'utf8')
    .digest('hex');
  return attachment.userId === `${INVITEE_ID_PREFIX}${hash.slice(0, 32)}`;
}

/** Why a proposal ended unaccepted, as its proposal_closed record names it. */
export type ProposalCloseReason = AuditEventOf<'proposal_closed'>['reason'];

export interface ProposalRecord {
  readonly proposalId: string;
  readonly pageId: string;
  readonly origin: string;
  /** Who proposed it, as the call that made it named them; an accepted run calls as them. */
  readonly proposer: CallerIdentity;
  /** The proposer's attachment it was made under: it holds only while that is still theirs. */
  readonly grantedAt: number;
  readonly tool: string;
  /** The arguments while it may still run; null once it has settled. */
  readonly args: JsonObject | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly status: ProposalStatus;
  /** For an accepted proposal; null for every other. */
  readonly outcome: ProposalOutcome | null;
  /** An accepted run's text, cut to MAX_PROPOSAL_RESULT_CHARS: page text, shown only behind its label. */
  readonly result: { readonly text: string; readonly cut: boolean } | null;
  /** The run returned an image, which is never kept (ADR 0039, decision 15). */
  readonly image: boolean;
  /** A result was held and later dropped to make room. */
  readonly dropped: boolean;
  readonly settledAt: number | null;
}

/** Why a wait on a proposal ended: it settled, its time ran out, its request was cancelled, or the hub ended it. */
export type ProposalWaitEnd =
  { kind: 'settled' } | { kind: 'timeout' } | { kind: 'cancelled' } | HubError;

/** A record as this module changes it; everyone else reads it as ProposalRecord. */
type Held = { -readonly [K in keyof ProposalRecord]: ProposalRecord[K] };

interface Entry {
  record: Held;
  /** What it is charged against the budget now. */
  charge: number;
  timer: NodeJS.Timeout | null;
  waiters: Set<(why: ProposalWaitEnd) => void>;
}

/** A proposal's place while its arguments are checked, holding its counts and its charge. */
export interface ProposalReservation {
  readonly pageId: string;
  readonly userId: string;
  readonly charge: number;
}

export interface ProposalHooks {
  /** timings.proposalTtlMs: how long a proposal waits for the operator. */
  ttlMs: number;
  /** limits.proposalBytes: what every proposal and kept result may cost together. */
  budgetBytes: number;
  /**
   * A pending proposal ended unaccepted: the hub tells the page `frame` when
   * it is not null and the page is live, and writes the proposal_closed line.
   */
  ended: (
    record: ProposalRecord,
    reason: ProposalCloseReason,
    frame: ProposalEndReason | null,
  ) => void;
  /** Whether the page's policy in force still takes this proposal's proposer. */
  admitted: (record: ProposalRecord) => boolean;
}

function error(code: ErrorCode, message: string): HubError {
  return { kind: 'error', code, message };
}

const GONE = error('page_gone', 'the page closed and did not come back; its attachments are gone');
const SHUTTING_DOWN = error('page_asleep', 'the relay is shutting down');

export class PageProposals implements PagePart {
  readonly #hooks: ProposalHooks;
  readonly #byId = new Map<string, Entry>();
  readonly #pages = new Map<string, Set<Entry>>();
  readonly #reserved = new Set<ProposalReservation>();
  /** Settled entries holding a result, oldest first: what makes room first. */
  readonly #results = new Set<Entry>();
  #held = 0;

  constructor(hooks: ProposalHooks) {
    this.#hooks = hooks;
  }

  /** What every proposal and kept result is charged together. */
  get held(): number {
    return this.#held;
  }

  /**
   * A place for a new proposal by this user on this page, or which limit
   * refuses it: theirs (MAX_PENDING_PROPOSALS_PER_USER), the page's
   * (MAX_PENDING_PROPOSALS_PER_PAGE), or the relay's budget. Reserved places
   * count as pending, so proposals checked at the same time cannot pass a cap
   * together. It holds until committed or released.
   */
  reserve(
    pageId: string,
    userId: string,
    charge: number,
    now: number,
  ): ProposalReservation | 'user' | 'page' | 'relay' {
    this.#prune(pageId, now);
    let mine = 0;
    let page = 0;
    const count = (owner: string): void => {
      page += 1;
      if (owner === userId) mine += 1;
    };
    for (const entry of this.#pages.get(pageId) ?? []) {
      if (entry.record.status === 'pending') count(entry.record.proposer.userId);
    }
    for (const held of this.#reserved) if (held.pageId === pageId) count(held.userId);
    if (mine >= MAX_PENDING_PROPOSALS_PER_USER) return 'user';
    if (page >= MAX_PENDING_PROPOSALS_PER_PAGE) return 'page';
    if (!this.#room(charge)) return 'relay';
    const reservation: ProposalReservation = { pageId, userId, charge };
    this.#reserved.add(reservation);
    this.#held += charge;
    return reservation;
  }

  release(reservation: ProposalReservation): void {
    if (this.#reserved.delete(reservation)) this.#held -= reservation.charge;
  }

  /** The reserved place becomes a pending proposal, expiring at `expiresAt` on the relay's clock. */
  commit(
    reservation: ProposalReservation,
    fields: Pick<
      ProposalRecord,
      'proposalId' | 'origin' | 'proposer' | 'grantedAt' | 'tool' | 'args' | 'createdAt'
    >,
  ): ProposalRecord {
    if (!this.#reserved.delete(reservation)) throw new Error('a proposal committed twice');
    const record: Held = {
      ...fields,
      pageId: reservation.pageId,
      expiresAt: fields.createdAt + this.#hooks.ttlMs,
      status: 'pending',
      outcome: null,
      result: null,
      image: false,
      dropped: false,
      settledAt: null,
    };
    const entry: Entry = { record, charge: reservation.charge, timer: null, waiters: new Set() };
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.#end(entry, 'expired', 'expired');
    }, this.#hooks.ttlMs);
    entry.timer.unref();
    this.#byId.set(record.proposalId, entry);
    let page = this.#pages.get(record.pageId);
    if (!page) {
      page = new Set();
      this.#pages.set(record.pageId, page);
    }
    page.add(entry);
    return record;
  }

  /** A proposal on this page by its id, pending or kept; undefined once forgotten. */
  find(pageId: string, proposalId: string, now: number): ProposalRecord | undefined {
    this.#prune(pageId, now);
    const entry = this.#byId.get(proposalId);
    return entry?.record.pageId === pageId ? entry.record : undefined;
  }

  /** Any page's proposal by its id, for a decision a page names; undefined once forgotten. */
  byId(proposalId: string): ProposalRecord | undefined {
    return this.#byId.get(proposalId)?.record;
  }

  /**
   * Ends a pending proposal unaccepted: the operator's Dismiss, the page's
   * refusal or the proposer's withdrawal. False when it was not pending.
   */
  end(
    record: ProposalRecord,
    reason: ProposalCloseReason,
    frame: ProposalEndReason | null,
  ): boolean {
    const entry = this.#entryOf(record);
    return entry !== undefined && this.#end(entry, reason, frame);
  }

  /** The operator accepted it: it runs now, its arguments held until the run settles. False when it was not pending. */
  accept(record: ProposalRecord): boolean {
    const entry = this.#entryOf(record);
    if (entry?.record.status !== 'pending') return false;
    this.#clearTimer(entry);
    entry.record.status = 'accepted';
    entry.record.outcome = 'running';
    return true;
  }

  /**
   * An accepted proposal's run settled: its arguments go, and its text is
   * kept cut, if it fits, for its proposer to read. An image is never kept.
   */
  settleRun(
    record: ProposalRecord,
    outcome: Exclude<ProposalOutcome, 'running'>,
    result: { text: string; image: boolean } | null,
  ): void {
    const entry = this.#entryOf(record);
    // Forgotten with its page meanwhile: nothing is kept, and nobody waits.
    if (entry?.record.status !== 'accepted' || entry.record.outcome !== 'running') return;
    const held = entry.record;
    this.#free(entry);
    held.outcome = outcome;
    held.settledAt = Date.now();
    held.image = result?.image ?? false;
    if (result !== null) {
      const cut = truncate(result.text, MAX_PROPOSAL_RESULT_CHARS);
      const charge = resultCharge(cut.text);
      if (this.#room(charge)) {
        held.result = { text: cut.text, cut: cut.truncated };
        entry.charge = charge;
        this.#held += charge;
        this.#results.add(entry);
      } else {
        held.dropped = true;
      }
    }
    this.#settled(entry);
  }

  /**
   * Waits for a proposal to settle, at most `timeoutMs`; a cancelled request
   * ends it at once. The caller holds a wait slot (waits.ts) and its
   * request's charge, and checks access again once this resolves.
   */
  wait(record: ProposalRecord, timeoutMs: number, signal: AbortSignal): Promise<ProposalWaitEnd> {
    const entry = this.#entryOf(record);
    if (entry === undefined) return Promise.resolve({ kind: 'settled' });
    if (signal.aborted) return Promise.resolve({ kind: 'cancelled' });
    return new Promise((resolve) => {
      const end = (why: ProposalWaitEnd): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        entry.waiters.delete(end);
        resolve(why);
      };
      const onAbort = (): void => {
        end({ kind: 'cancelled' });
      };
      const timer = setTimeout(() => {
        end({ kind: 'timeout' });
      }, timeoutMs);
      timer.unref();
      signal.addEventListener('abort', onAbort, { once: true });
      entry.waiters.add(end);
    });
  }

  #entryOf(record: ProposalRecord): Entry | undefined {
    const entry = this.#byId.get(record.proposalId);
    return entry?.record === record ? entry : undefined;
  }

  /** Makes room for `charge` by dropping the oldest kept results; false when it still does not fit. */
  #room(charge: number): boolean {
    for (const entry of this.#results) {
      if (this.#held + charge <= this.#hooks.budgetBytes) break;
      this.#free(entry);
      entry.record.result = null;
      entry.record.dropped = true;
    }
    return this.#held + charge <= this.#hooks.budgetBytes;
  }

  /** Whatever the entry holds stops being charged: its arguments, or its kept result. */
  #free(entry: Entry): void {
    this.#held -= entry.charge;
    entry.charge = 0;
    entry.record.args = null;
    this.#results.delete(entry);
  }

  #clearTimer(entry: Entry): void {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
  }

  #end(entry: Entry, reason: ProposalCloseReason, frame: ProposalEndReason | null): boolean {
    const held = entry.record;
    if (held.status !== 'pending') return false;
    this.#clearTimer(entry);
    this.#free(entry);
    held.status = reason;
    held.settledAt = Date.now();
    this.#hooks.ended(held, reason, frame);
    this.#settled(entry);
    return true;
  }

  /** It settled: whoever waits on it hears so, and the page keeps no more than its share of outcomes. */
  #settled(entry: Entry): void {
    this.#wake(entry, { kind: 'settled' });
    const page = this.#pages.get(entry.record.pageId);
    if (!page) return;
    const settled = [...page].filter((each) => each.record.settledAt !== null);
    settled.sort((a, b) => (a.record.settledAt ?? 0) - (b.record.settledAt ?? 0));
    for (const old of settled.slice(
      0,
      Math.max(0, settled.length - MAX_SETTLED_PROPOSALS_PER_PAGE),
    )) {
      this.#forget(old);
    }
  }

  #wake(entry: Entry, why: ProposalWaitEnd): void {
    for (const waiter of [...entry.waiters]) waiter(why);
  }

  #forget(entry: Entry): void {
    this.#clearTimer(entry);
    this.#free(entry);
    this.#byId.delete(entry.record.proposalId);
    const page = this.#pages.get(entry.record.pageId);
    page?.delete(entry);
    if (page?.size === 0) this.#pages.delete(entry.record.pageId);
  }

  /** Outcomes past PROPOSAL_OUTCOME_KEEP_MS go when the page is next looked at. */
  #prune(pageId: string, now: number): void {
    for (const entry of [...(this.#pages.get(pageId) ?? [])]) {
      const { settledAt } = entry.record;
      if (
        settledAt !== null &&
        now - settledAt > PROPOSAL_OUTCOME_KEEP_MS &&
        entry.waiters.size === 0
      ) {
        this.#forget(entry);
      }
    }
  }

  #pending(pageId: string, users?: ReadonlySet<string>): Entry[] {
    return [...(this.#pages.get(pageId) ?? [])].filter(
      (entry) =>
        entry.record.status === 'pending' &&
        (users === undefined || users.has(entry.record.proposer.userId)),
    );
  }

  // The page's life (page-parts.ts). Proposals end with the link: a page
  // that sleeps, reloads or goes held them in memory only, and one shown on
  // one page load must never be accepted on another (decision 12).

  sleep(pageId: string): void {
    for (const entry of this.#pending(pageId)) this.#end(entry, 'cancelled', null);
  }

  resumed(pageId: string): void {
    this.sleep(pageId);
  }

  gone(pageId: string): void {
    // A detach reaches here with no sleep first.
    this.sleep(pageId);
    for (const entry of [...(this.#pages.get(pageId) ?? [])]) {
      this.#wake(entry, GONE);
      this.#forget(entry);
    }
  }

  attachmentsEnded(pageId: string, users: ReadonlySet<string>, outcome: HubError): void {
    for (const entry of this.#pages.get(pageId) ?? []) {
      if (users.has(entry.record.proposer.userId)) this.#wake(entry, outcome);
    }
    for (const entry of this.#pending(pageId, users)) {
      this.#end(entry, 'cancelled', 'attachment_ended');
    }
  }

  policyChanged(pageId: string): void {
    for (const entry of this.#pending(pageId)) {
      if (!this.#hooks.admitted(entry.record)) this.#end(entry, 'cancelled', 'policy');
    }
  }

  close(): void {
    for (const entry of this.#byId.values()) {
      this.#clearTimer(entry);
      this.#wake(entry, SHUTTING_DOWN);
    }
  }
}

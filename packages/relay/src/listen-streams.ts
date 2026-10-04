// Bounds on the 2026-07-28 leg's subscriptions/listen streams (A4.3). The SDK
// serves them from one relay-wide set capped at maxSubscriptions, with
// nothing per user, and keeps each open with keep-alives until the client
// leaves, so one account could hold every slot and leave members' listens
// refused. The relay counts them as it counts 2025-era sessions (sessions.ts),
// with the same numbers and in a count of their own: a user holds perUser
// streams, an invitee one until it holds an attachment and perInvitee after,
// invitees together hold at most pool and everyone at most total. A newer
// stream of the same user ends that user's oldest. Past the pool or the
// total, a stream ends only when its holder ranks below the newcomer
// (rankOf): a stranger's for a guest or a member and a guest's for a member,
// the lowest ranked first and then the oldest, and a member's never; anyone
// else is refused as the SDK refuses at its own cap. Each listen also spends
// one request of the user's budget, first of all, so streams opened in a loop
// are bounded like calls (ADR 0018). A refusal writes at most one line per
// reason a window, so a loop of them cannot flood the logs.

import type { UserKind } from '@tabdock/protocol';
import type { Logger } from './log.ts';
import type { RequestBudget } from './mcp.ts';
import { SlidingWindowLimiter } from './rate-limit.ts';
import {
  closableBody,
  type InviteeSessionOptions,
  MEMBER,
  RANKS,
  rankOf,
  type TierRank,
} from './sessions.ts';

export interface ListenStreamOptions {
  /** Streams one user may hold (RelayLimits.sessionsPerUser). */
  perUser: number;
  /** Streams the relay holds in all (RelayLimits.sessions); the SDK's own cap is set to it. */
  total: number;
  /** The invitee tier, shared with the 2025-era sessions; without it, every user's streams count alike. */
  invitees?: InviteeSessionOptions | undefined;
  budget: RequestBudget;
  /** The window a refusal's line is written once in. */
  windowMs: number;
  log: Logger;
}

/** Who opens a stream, as the HTTP layer established it. */
export interface ListenCaller {
  userId: string;
  kind: UserKind;
}

interface Held {
  userId: string;
  /** Ends the stream; null while the SDK is still answering, when it cannot yet give way. */
  close: (() => void) | null;
}

/** As the SDK answers a listen it refuses: HTTP 200 carrying a JSON-RPC error for that request. */
function listenError(id: unknown, code: number, message: string): Response {
  const echoed = typeof id === 'string' || typeof id === 'number' ? id : null;
  return Response.json({ jsonrpc: '2.0', error: { code, message }, id: echoed }, { status: 200 });
}

/** The SDK's own words at its cap, so a client meets one refusal whichever cap it reached. */
const FULL_CODE = -32603;
const FULL_MESSAGE = 'Subscription limit reached';
/** The SDK's server-error code for a request it will not serve now. */
const BUDGET_CODE = -32000;

/** Whether the SDK served a stream; anything else (a refusal, a bad request) holds nothing. */
function isStream(response: Response): boolean {
  return (
    response.ok &&
    response.body !== null &&
    (response.headers.get('content-type') ?? '').startsWith('text/event-stream')
  );
}

export class ListenStreams {
  readonly #options: ListenStreamOptions;
  /** Every stream held or being answered, oldest first. */
  readonly #held = new Set<Held>();
  readonly #warnings: SlidingWindowLimiter;

  constructor(options: ListenStreamOptions) {
    this.#options = options;
    this.#warnings = new SlidingWindowLimiter(1, options.windowMs);
  }

  /** Streams held or being answered. */
  get size(): number {
    return this.#held.size;
  }

  /**
   * Serves one subscriptions/listen through `serve` (the SDK) if the caller
   * has budget and there is room, ending whichever stream must give way;
   * `id` is the request's JSON-RPC id, echoed in a refusal.
   */
  async open(
    caller: ListenCaller,
    id: unknown,
    signal: AbortSignal,
    serve: () => Promise<Response>,
  ): Promise<Response> {
    const { budget } = this.#options;
    if (!budget.spend(caller.userId, caller.kind)) {
      this.#warn('budget', 'listen stream refused: past the request budget', caller.userId);
      return listenError(id, BUDGET_CODE, budget.refusal(caller.kind));
    }
    if (!this.#makeRoom(caller.userId)) return listenError(id, FULL_CODE, FULL_MESSAGE);
    // Counted from now, so listens that overlap cannot overshoot a cap together.
    const held: Held = { userId: caller.userId, close: null };
    this.#held.add(held);
    let response: Response;
    try {
      response = await serve();
    } catch (error) {
      this.#held.delete(held);
      throw error;
    }
    if (!isStream(response)) {
      this.#held.delete(held);
      return response;
    }
    const body = closableBody(response, signal, () => {
      this.#held.delete(held);
    });
    // Unless the client already left, in which case it is gone from the set.
    if (this.#held.has(held)) held.close = body.close;
    return body.response;
  }

  /**
   * The stream to end for a newcomer of this rank: the oldest open one whose
   * holder ranks lowest, so long as that is below the newcomer; a stream
   * still being answered cannot give way yet.
   */
  #below(rank: TierRank, among: (held: Held) => boolean): Held | undefined {
    const { invitees } = this.#options;
    const open = [...this.#held].filter((held) => held.close !== null && among(held));
    for (const lower of RANKS.filter((each) => each < rank)) {
      const found = open.find((held) => rankOf(held.userId, invitees) === lower);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** Whether one more stream of this user now fits, ending what must give way. */
  #makeRoom(userId: string): boolean {
    const { invitees, total } = this.#options;
    const rank = rankOf(userId, invitees);
    const tier = rank === MEMBER ? null : (invitees ?? null);
    const perUser =
      tier === null
        ? this.#options.perUser
        : Math.min(this.#options.perUser, tier.holds(userId) ? tier.perInvitee : 1);
    const mine = [...this.#held].filter((held) => held.userId === userId);
    if (mine.length >= perUser) {
      // A client that reconnects before its old stream is noticed gone keeps listening.
      const oldest = mine.find((held) => held.close !== null);
      if (oldest === undefined) {
        this.#warn(
          'user',
          'listen stream refused: the user holds the most streams allowed',
          userId,
        );
        return false;
      }
      oldest.close?.();
      this.#options.log.debug('listen stream ended for a newer one of the same user', { userId });
    }
    const isInvitee = (held: Held): boolean => invitees?.isInvitee(held.userId) === true;
    if (tier !== null) {
      const pool = [...this.#held].filter(isInvitee);
      if (pool.length >= tier.pool) {
        const evicted = this.#below(rank, isInvitee);
        if (evicted === undefined) {
          this.#warn(
            'pool',
            'listen stream refused: invitees hold the most streams allowed',
            userId,
          );
          return false;
        }
        evicted.close?.();
        this.#options.log.debug('listen stream ended for a newer invitee stream', { userId });
      }
    }
    if (this.#held.size >= total) {
      const evicted = this.#below(rank, isInvitee);
      if (evicted === undefined) {
        this.#warn(
          'total',
          'listen stream refused: the relay holds the most streams allowed',
          userId,
        );
        return false;
      }
      evicted.close?.();
      this.#options.log.debug('listen stream ended for a newer stream: the relay is full', {
        userId,
      });
    }
    return true;
  }

  /** One line per reason a window, naming the first user refused in it. */
  #warn(reason: string, message: string, userId: string): void {
    const now = Date.now();
    if (!this.#warnings.allows(reason, now)) return;
    this.#warnings.record(reason, now);
    this.#options.log.warn(message, { userId });
  }
}

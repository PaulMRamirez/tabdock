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
// reason a window, the rest counted, so a loop of them cannot flood the logs.
//
// Whose stream gives way is settled when the listen arrives, but the stream
// ends only once the SDK has answered that listen with an event stream: the
// SDK still checks the request's headers, envelope and filter after this
// gate, and a listen it refuses, or answers without a stream, must cost
// nobody theirs, its own sender included (the second A4.3 pass). Until then
// the stream marked to give way counts for nothing and cannot be marked
// again, and the listen being answered counts in its place, so listens that
// overlap still never overshoot a cap. The SDK's own cap therefore needs
// room for those marked streams beside the total (relay.ts).
//
// From M5 each user's streams are served by an SDK handler of that user's
// own (ADR 0025), made with their first stream and closed with their last,
// so a change to one user's tool list signals only that user's streams
// (notifyUser) and never another's (S13); the spike's marker, which every
// member lists, signals them all (notifyAll). This gate still decides who
// may hold a stream; each handler's own cap sits above anything the gate
// lets one user hold, so the SDK's cap never binds first.

import type { McpHttpHandler } from '@modelcontextprotocol/server';
import type { UserKind } from '@tabdock/protocol';
import type { Logger } from './log.ts';
import type { RequestBudget } from './mcp.ts';
import type { RepeatedLog } from './repeated-lines.ts';
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
  /** Streams the relay holds in all (RelayLimits.sessions). */
  total: number;
  /** The invitee tier, shared with the 2025-era sessions; without it, every user's streams count alike. */
  invitees?: InviteeSessionOptions | undefined;
  budget: RequestBudget;
  log: Logger;
  /** Where refusals go, one line per reason a window and the rest counted (repeated-lines.ts). */
  lines: RepeatedLog;
  /**
   * Makes the SDK handler that serves one user's streams; relay.ts gives it
   * the relay's factory and a cap above anything the gate allows one user.
   */
  createHandler: () => McpHttpHandler;
}

/** One user's handler, and how many of their streams it holds or is answering. */
interface UserHandler {
  handler: McpHttpHandler;
  streams: number;
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
  /**
   * The listen being answered that this stream gives way to if the SDK
   * serves it; while set, this stream counts for nothing and cannot be
   * marked again.
   */
  givingWayTo: Held | null;
}

/** One stream that gives way to a newcomer, and why, for the debug line once it ends. */
interface GivingWay {
  held: Held;
  why: string;
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
  /** Each user's own handler while they hold or are opening a stream. */
  readonly #handlers = new Map<string, UserHandler>();

  constructor(options: ListenStreamOptions) {
    this.#options = options;
  }

  /** Streams held or being answered, those marked to give way included. */
  get size(): number {
    return this.#held.size;
  }

  /** Users with a handler of their own, which is every user holding or opening a stream. */
  get handlers(): number {
    return this.#handlers.size;
  }

  /** Tells the user's own streams that their tool list changed; no other user's hear it. */
  notifyUser(userId: string): void {
    this.#handlers.get(userId)?.handler.notify.toolsChanged();
  }

  /** Tells every stream; the spike's marker concerns every member. */
  notifyAll(): void {
    for (const { handler } of this.#handlers.values()) handler.notify.toolsChanged();
  }

  /** Closes every user's handler, ending their streams, as the relay closes. */
  async closeAll(): Promise<void> {
    const closing = [...this.#handlers.values()].map(({ handler }) => handler.close());
    this.#handlers.clear();
    await Promise.all(closing);
  }

  /**
   * Serves one subscriptions/listen through `serve` (the SDK) on the
   * caller's own handler if the caller has budget and there is room, ending
   * whichever stream gives way once the SDK has answered with a stream; `id`
   * is the request's JSON-RPC id, echoed in a refusal.
   */
  async open(
    caller: ListenCaller,
    id: unknown,
    signal: AbortSignal,
    serve: (handler: McpHttpHandler) => Promise<Response>,
  ): Promise<Response> {
    const { budget } = this.#options;
    if (!budget.spend(caller.userId, caller.kind)) {
      this.#warn('listen stream refused: past the request budget', caller.userId);
      return listenError(id, BUDGET_CODE, budget.refusal(caller.kind));
    }
    const held: Held = { userId: caller.userId, close: null, givingWayTo: null };
    const givingWay = this.#makeRoom(held);
    if (givingWay === null) return listenError(id, FULL_CODE, FULL_MESSAGE);
    // Counted from now, so listens that overlap cannot overshoot a cap together.
    this.#hold(held);
    let response: Response;
    try {
      response = await serve(this.#handlerOf(caller.userId));
    } catch (error) {
      this.#release(held, givingWay);
      throw error;
    }
    // A refusal, a listen sent as a notification, or a client already gone: nobody gives way.
    if (!isStream(response) || signal.aborted) {
      this.#release(held, givingWay);
      if (isStream(response)) await response.body?.cancel().catch(() => undefined);
      return response;
    }
    for (const { held: ending, why } of givingWay) {
      ending.close?.();
      this.#options.log.debug(why, { userId: caller.userId });
    }
    const body = closableBody(response, signal, () => {
      this.#forget(held);
    });
    // Unless the client already left, in which case it is gone from the set.
    if (this.#held.has(held)) held.close = body.close;
    return body.response;
  }

  /** Puts back what a listen the SDK did not serve had marked, and forgets the listen. */
  #release(held: Held, givingWay: readonly GivingWay[]): void {
    for (const { held: marked } of givingWay) {
      if (marked.givingWayTo === held) marked.givingWayTo = null;
    }
    this.#forget(held);
  }

  /** Counts a stream in, making its user's handler with their first. */
  #hold(held: Held): void {
    this.#held.add(held);
    let own = this.#handlers.get(held.userId);
    if (own === undefined) {
      own = { handler: this.#options.createHandler(), streams: 0 };
      this.#handlers.set(held.userId, own);
    }
    own.streams += 1;
  }

  /** The handler #hold made for this user; there is one while any of their streams is held. */
  #handlerOf(userId: string): McpHttpHandler {
    const own = this.#handlers.get(userId);
    if (own === undefined)
      throw new Error('a listen stream is being served with no handler for its user');
    return own.handler;
  }

  /** Counts a stream out, once; the user's handler closes with their last. */
  #forget(held: Held): void {
    if (!this.#held.delete(held)) return;
    const own = this.#handlers.get(held.userId);
    if (own === undefined) return;
    own.streams -= 1;
    if (own.streams > 0) return;
    this.#handlers.delete(held.userId);
    own.handler.close().catch((error: unknown) => {
      this.#options.log.warn('listen handler did not close cleanly', { error });
    });
  }

  /** Streams that count against the caps: every one but those marked to give way. */
  #counted(among: (held: Held) => boolean = () => true): Held[] {
    return [...this.#held].filter((held) => held.givingWayTo === null && among(held));
  }

  /**
   * The stream to end for a newcomer of this rank: the oldest open one whose
   * holder ranks lowest, so long as that is below the newcomer; a stream
   * still being answered cannot give way yet.
   */
  #below(rank: TierRank, among: (held: Held) => boolean): Held | undefined {
    const { invitees } = this.#options;
    const open = this.#counted(among).filter((held) => held.close !== null);
    for (const lower of RANKS.filter((each) => each < rank)) {
      const found = open.find((held) => rankOf(held.userId, invitees) === lower);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /**
   * Room for one more stream of the newcomer's user: the streams marked to
   * give way to it if the SDK serves it, none when there is room already, or
   * null, with nothing marked, when there is none.
   */
  #makeRoom(newcomer: Held): GivingWay[] | null {
    const { invitees, total } = this.#options;
    const { userId } = newcomer;
    const rank = rankOf(userId, invitees);
    const tier = rank === MEMBER ? null : (invitees ?? null);
    const perUser =
      tier === null
        ? this.#options.perUser
        : Math.min(this.#options.perUser, tier.holds(userId) ? tier.perInvitee : 1);
    const givingWay: GivingWay[] = [];
    const giveWay = (held: Held, why: string): void => {
      held.givingWayTo = newcomer;
      givingWay.push({ held, why });
    };
    const refuse = (message: string): null => {
      for (const { held } of givingWay) held.givingWayTo = null;
      this.#warn(message, userId);
      return null;
    };
    const mine = this.#counted((held) => held.userId === userId);
    if (mine.length >= perUser) {
      // A client that reconnects before its old stream is noticed gone keeps listening.
      const oldest = mine.find((held) => held.close !== null);
      if (oldest === undefined) {
        return refuse('listen stream refused: the user holds the most streams allowed');
      }
      giveWay(oldest, 'listen stream ended for a newer one of the same user');
    }
    const isInvitee = (held: Held): boolean => invitees?.isInvitee(held.userId) === true;
    if (tier !== null && this.#counted(isInvitee).length >= tier.pool) {
      const evicted = this.#below(rank, isInvitee);
      if (evicted === undefined) {
        return refuse('listen stream refused: invitees hold the most streams allowed');
      }
      giveWay(evicted, 'listen stream ended for a newer invitee stream');
    }
    if (this.#counted().length >= total) {
      const evicted = this.#below(rank, isInvitee);
      if (evicted === undefined) {
        return refuse('listen stream refused: the relay holds the most streams allowed');
      }
      giveWay(evicted, 'listen stream ended for a newer stream: the relay is full');
    }
    return givingWay;
  }

  /** One line per reason a window, naming the first user refused in it; the rest are counted. */
  #warn(message: string, userId: string): void {
    this.#options.lines.write('warn', message, { userId });
  }
}

// The budget for browser sign-ins at /pair and /i (S9, ADRs 0013 and 0018).
// Each sign-in that comes back from the provider costs one code exchange: a
// request to the provider carrying the /pair client's secret, which anyone can
// set off with a callback of their own making. So the whole relay makes only
// pairSignIns a window and pairSignInsInFlight at once, and past either the
// sign-in fails without the provider hearing of it. /i signs in through
// /pair/login and /pair/callback too, so this one gate covers both routes.
// Workstream C adds ADR 0018's per-address share here, checked first in hosted
// mode (signInsPerAddress a window, signInsInFlightPerAddress at once), so
// one address cannot spend the relay-wide budget; pair.ts asks only enter().

import type { ResolvedConfig } from './config.ts';
import type { Logger } from './log.ts';
import { SlidingWindowLimiter } from './rate-limit.ts';

/** One admitted code exchange; leave() once its answer is in, whatever it was. */
export interface SignInPass {
  leave(): void;
}

export interface SignInGate {
  /**
   * Admits one code exchange for a client address (its limit key, from
   * client-address.ts) now, or refuses it with null after logging why. A
   * refusal costs nothing; an admission counts against the window at once.
   */
  enter(address: string, now: number): SignInPass | null;
}

/** The one key the relay-wide window counts under. */
const RELAY = 'relay';

export function createSignInGate(config: ResolvedConfig, log: Logger): SignInGate {
  const { windowMs, pairSignIns } = config.rateLimits;
  const window = new SlidingWindowLimiter(pairSignIns, windowMs);
  /** Code exchanges waiting on the provider now. */
  let inFlight = 0;
  return {
    enter(_address, now) {
      if (inFlight >= config.limits.pairSignInsInFlight) {
        log.warn('pair sign-in refused: too many sign-ins waiting on the provider');
        return null;
      }
      if (!window.allows(RELAY, now)) {
        log.warn('pair sign-in refused: too many sign-ins in this window');
        return null;
      }
      window.record(RELAY, now);
      inFlight += 1;
      let left = false;
      return {
        leave() {
          // Once per pass, so a second call cannot free a slot someone else holds.
          if (left) return;
          left = true;
          inFlight -= 1;
        },
      };
    },
  };
}

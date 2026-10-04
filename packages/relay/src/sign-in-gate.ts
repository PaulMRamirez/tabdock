// The budget for browser sign-ins at /pair and /i (S9, ADRs 0013 and 0018).
// Each sign-in that comes back from the provider costs one code exchange: a
// request to the provider carrying the /pair client's secret, which anyone can
// set off with a callback of their own making. So the whole relay makes only
// pairSignIns a window and pairSignInsInFlight at once, and past either the
// sign-in fails without the provider hearing of it. /i signs in through
// /pair/login and /pair/callback too, so this one gate covers both routes.
// In hosted mode, where the edge names each client, one address also gets
// only its share, signInsPerAddress a window and signInsInFlightPerAddress at
// once, checked first, so a single address cannot spend the relay-wide budget
// and keep QR sign-in failing for everyone (ADR 0018). Outside hosted mode
// every client behind a tunnel arrives from one loopback address, so a share
// would only be the whole budget again, and none is kept.

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
   * refusal costs nothing; an admission counts against the windows at once.
   */
  enter(address: string, now: number): SignInPass | null;
}

/** The one key the relay-wide window counts under. */
const RELAY = 'relay';

export function createSignInGate(config: ResolvedConfig, log: Logger): SignInGate {
  const { windowMs, pairSignIns, signInsPerAddress } = config.rateLimits;
  const { pairSignInsInFlight, signInsInFlightPerAddress } = config.limits;
  const window = new SlidingWindowLimiter(pairSignIns, windowMs);
  // Keyed by addresses the edge named: not a set the relay chooses, but the
  // limiter's own key bound caps its memory, and the relay-wide window above
  // still holds whatever an early turn of it forgets.
  const perAddress = config.hosted ? new SlidingWindowLimiter(signInsPerAddress, windowMs) : null;
  /** Code exchanges waiting on the provider now. */
  let inFlight = 0;
  /** The same per address in hosted mode; an entry goes when its count does, so at most pairSignInsInFlight live. */
  const inFlightByAddress = new Map<string, number>();
  return {
    enter(address, now) {
      if (perAddress !== null) {
        // Logged with the address: an operator sees who is spending the budget, and it is no secret.
        if ((inFlightByAddress.get(address) ?? 0) >= signInsInFlightPerAddress) {
          log.warn(
            'pair sign-in refused: too many sign-ins from one address waiting on the provider',
            { address },
          );
          return null;
        }
        if (!perAddress.allows(address, now)) {
          log.warn('pair sign-in refused: too many sign-ins from one address in this window', {
            address,
          });
          return null;
        }
      }
      if (inFlight >= pairSignInsInFlight) {
        log.warn('pair sign-in refused: too many sign-ins waiting on the provider');
        return null;
      }
      if (!window.allows(RELAY, now)) {
        log.warn('pair sign-in refused: too many sign-ins in this window');
        return null;
      }
      window.record(RELAY, now);
      perAddress?.record(address, now);
      inFlight += 1;
      if (perAddress !== null) {
        inFlightByAddress.set(address, (inFlightByAddress.get(address) ?? 0) + 1);
      }
      let left = false;
      return {
        leave() {
          // Once per pass, so a second call cannot free a slot someone else holds.
          if (left) return;
          left = true;
          inFlight -= 1;
          if (perAddress === null) return;
          const held = (inFlightByAddress.get(address) ?? 1) - 1;
          if (held > 0) inFlightByAddress.set(address, held);
          else inFlightByAddress.delete(address);
        },
      };
    },
  };
}

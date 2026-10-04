// The log line for every /mcp request the relay turns away at sign-in (ADR
// 0020): the plugin's refusals and the relay's own 403 for an invitee it does
// not admit. One place writes it, so the line's shape and its bounds live
// together: the reason is a fixed phrase, never token text; the client address
// is the one client-address.ts resolved, never a header as sent; the account
// kind and the token's client_id are named when the plugin knew them, never
// the account itself. A 401 costs a caller nothing to provoke, so repeated
// ones collapse: the first from each client address in a minute is written
// in full, and the rest are counted, by reason, into one line when the minute
// ends. The minute is the clock's own, so the bound holds however the
// requests arrive, and the addresses tracked at once are capped, past which
// the rest share one count. The factory gives that state one home per relay.

import type { AuthRefusal } from './auth.ts';
import { type ClientAddress, loggedAddress } from './client-address.ts';
import type { Logger } from './log.ts';

/** How long a run of repeated 401 lines collapses into one count. */
export const REPEATED_REFUSAL_WINDOW_MS = 60_000;
/**
 * Client addresses tracked in one window. Past it, behind a host edge where
 * every IPv6 /56 is a key of its own, the rest share one count rather than
 * grow the map.
 */
export const MAX_TRACKED_REFUSALS = 10_000;

export interface AuthRefusalLog {
  refused(refusal: AuthRefusal, client: ClientAddress): void;
  /** Writes the counts still held and stops the timer; the relay calls it as it closes. */
  close(): void;
}

function eventOf(status: AuthRefusal['status']): string {
  switch (status) {
    case 401:
      return 'mcp request refused: not authenticated';
    case 403:
      return 'mcp request refused: not allowed';
    case 503:
      return 'mcp request refused: sign-in unavailable';
  }
}

/** One address in the current window: its first line was written, and these 401s followed. */
interface Repeats {
  address: string;
  repeated: number;
  /** By reason, each a fixed phrase, so the count says what kept failing. */
  reasons: Record<string, number>;
}

export function createAuthRefusalLog(log: Logger): AuthRefusalLog {
  let window = Number.NEGATIVE_INFINITY;
  let tracked = new Map<string, Repeats>();
  /** 401s from addresses past MAX_TRACKED_REFUSALS in this window, all counted together. */
  let untracked = 0;
  let timer: NodeJS.Timeout | null = null;

  const line = (refusal: AuthRefusal, client: ClientAddress): void => {
    log.info(eventOf(refusal.status), {
      reason: refusal.reason,
      address: loggedAddress(client),
      accountKind: refusal.accountKind,
      oauthClientId: refusal.oauthClientId,
    });
  };

  /** One line per address that repeated, then a fresh window. */
  const flush = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    for (const repeats of tracked.values()) {
      if (repeats.repeated === 0) continue;
      log.info('mcp request refused: not authenticated, repeated', {
        address: repeats.address,
        repeated: repeats.repeated,
        reasons: repeats.reasons,
      });
    }
    if (untracked > 0) {
      log.info('mcp request refused: not authenticated, from more addresses than tracked', {
        repeated: untracked,
      });
    }
    tracked = new Map();
    untracked = 0;
  };

  /** The counts go out when their window ends, even if no 401 comes after them. */
  const flushAtWindowEnd = (now: number): void => {
    if (timer !== null) return;
    const ends = (window + 1) * REPEATED_REFUSAL_WINDOW_MS;
    timer = setTimeout(flush, Math.max(0, ends - now));
    timer.unref();
  };

  return {
    refused(refusal, client) {
      if (refusal.status !== 401) {
        line(refusal, client);
        return;
      }
      const now = Date.now();
      const current = Math.floor(now / REPEATED_REFUSAL_WINDOW_MS);
      if (current !== window) {
        flush();
        window = current;
      }
      // By the limit key, so an IPv6 /56 behind a host edge is one sender.
      const key = client.ok ? client.key : `(${client.problem})`;
      const repeats = tracked.get(key);
      if (repeats !== undefined) {
        repeats.repeated += 1;
        repeats.reasons[refusal.reason] = (repeats.reasons[refusal.reason] ?? 0) + 1;
        flushAtWindowEnd(now);
        return;
      }
      if (tracked.size >= MAX_TRACKED_REFUSALS) {
        untracked += 1;
        flushAtWindowEnd(now);
        return;
      }
      tracked.set(key, { address: loggedAddress(client), repeated: 0, reasons: {} });
      line(refusal, client);
    },
    close() {
      flush();
    },
  };
}

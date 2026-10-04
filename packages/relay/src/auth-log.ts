// The log line for every /mcp request the relay turns away at sign-in (ADR
// 0020): the plugin's refusals and the relay's own 403 for an invitee it does
// not admit. One place writes it, so the line's shape and its bounds live
// together: the reason is a fixed phrase, never token text; the client address
// is the one client-address.ts resolved, never a header as sent. Workstream A
// owns this module and adds ADR 0020's account kind and client_id to the line,
// which every AuthRefusal already carries, and collapses repeated 401s to one
// line per client address a minute, with a count, keyed by the address's
// limit key; the factory exists so that state has one home per relay.

import type { AuthRefusal } from './auth.ts';
import { type ClientAddress, loggedAddress } from './client-address.ts';
import type { Logger } from './log.ts';

export interface AuthRefusalLog {
  refused(refusal: AuthRefusal, client: ClientAddress): void;
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

export function createAuthRefusalLog(log: Logger): AuthRefusalLog {
  return {
    refused(refusal, client) {
      log.info(eventOf(refusal.status), {
        reason: refusal.reason,
        address: loggedAddress(client),
      });
    },
  };
}

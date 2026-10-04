// The address a request counts against for per-address limits (S9, ADR 0018).
// /page, /pair and /i count by it; /mcp never does (ADR 0016), since all of
// hosted Claude arrives from one range, though its refusal log names it.
// Without a host edge the client is the TCP peer, which is all this returns
// today. Workstream C fills in hosted mode behind the same shape: the client
// is named by the one header the edge sets (TABDOCK_CLIENT_ADDRESS_HEADER),
// believed only from a peer inside TABDOCK_TRUSTED_PROXY_CIDR; a header that is
// missing, repeated or not an IP address makes the request a 400 on every route
// that counts by address; IPv4 counts whole and IPv6 by its /56; and a peer
// outside the trusted ranges counts as itself, its header ignored and its
// address logged (ADR 0018's notes). The factory holds one relay's state, such
// as which proxy addresses it has already logged.

import type { IncomingMessage } from 'node:http';
import type { ResolvedConfig } from './config.ts';
import type { Logger } from './log.ts';

/** What a request is counted as when its socket has already lost its peer's address. */
export const UNKNOWN_ADDRESS = 'unknown';

/** Why no address could be read from the edge's header: each is a 400 where requests count by address. */
export type ClientAddressProblem = 'missing' | 'repeated' | 'malformed';

/**
 * The client behind a request: its address, for log lines, and the key its
 * per-address limits count under, which groups an IPv6 /56 in hosted mode and
 * is the address itself otherwise. Never in an audit record (ADR 0019).
 */
export type ClientAddress =
  { ok: true; address: string; key: string } | { ok: false; problem: ClientAddressProblem };

export interface ClientAddresses {
  of(request: IncomingMessage): ClientAddress;
}

/** The TCP peer, the client itself wherever no edge stands in front of the relay. */
function peerOf(request: IncomingMessage): ClientAddress {
  const address = request.socket.remoteAddress ?? UNKNOWN_ADDRESS;
  return { ok: true, address, key: address };
}

/** One per relay, built in createRelay and shared by /page, /pair, /i and /mcp's refusal log. */
export function createClientAddresses(config: ResolvedConfig, log: Logger): ClientAddresses {
  if (config.hosted) {
    // Until workstream C reads the edge's header here (ADR 0018), the peer
    // stands in, which behind the edge is its proxy: every client then shares
    // one count, and an operator should hear that once.
    log.warn(
      'hosted mode counts every client by its proxy address until the client address header is read (ADR 0018)',
    );
  }
  return { of: peerOf };
}

/** A client address as a log line names it: the address, or why the edge's header gave none. */
export function loggedAddress(client: ClientAddress): string {
  return client.ok ? client.address : `(${client.problem} client address header)`;
}

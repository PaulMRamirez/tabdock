// The address a request counts against for per-address limits (S9, ADR 0018).
// Only page sockets count by address today; /mcp never does (ADR 0016), since
// all of hosted Claude arrives from one range. Without a host edge the client
// is the TCP peer, which is what this returns. Workstream C replaces it for
// hosted mode, where the client is named by the one header the edge sets
// (TABDOCK_CLIENT_ADDRESS_HEADER), trusted only from a peer inside
// TABDOCK_TRUSTED_PROXY_CIDR, and where /pair and /i count by it too.

import type { IncomingMessage } from 'node:http';

/** What a request is counted as when its socket has already lost its peer's address. */
export const UNKNOWN_ADDRESS = 'unknown';

export function clientAddress(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? UNKNOWN_ADDRESS;
}

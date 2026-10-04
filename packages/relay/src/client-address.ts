// The address a request counts against for per-address limits (S9, ADR 0018).
// /page, /pair and /i count by it; /mcp never does (ADR 0016), since all of
// hosted Claude arrives from one range, though its refusal log names it.
// Without a host edge the client is the TCP peer, and that is all M3's rules
// and local mode's ever read. In hosted mode the client is named by the one
// header the edge sets (TABDOCK_CLIENT_ADDRESS_HEADER), believed only from a
// peer inside TABDOCK_TRUSTED_PROXY_CIDR: a header that is missing, repeated or
// not an IP address makes the request a 400 on every route that counts by
// address, while a peer outside the trusted ranges counts as itself, its header
// ignored and its address logged, so a range set too narrow degrades to limits
// shared behind the proxy rather than refusing everyone (ADR 0018's notes).
// IPv4-mapped and IPv4-compatible forms count as their IPv4 address, IPv4
// counts whole, and native IPv6 counts by its /56, the block a home connection
// is commonly delegated, so one household cannot dodge a limit by walking its
// own prefix. The factory holds one relay's state: whether it has logged the
// first proxy address yet, which a first deploy needs to narrow the range, and
// which untrusted peers it has already named.

import type { IncomingMessage } from 'node:http';
import { BlockList, isIP, isIPv4, isIPv6 } from 'node:net';
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

/** The bits of a native IPv6 address its limit key keeps (ADR 0018). */
export const IPV6_KEY_PREFIX = 56;

/**
 * Untrusted peers named in the log, at most this many: a qualifying host lets
 * none reach the port, so even a handful means the range is wrong, and the
 * bound keeps a misconfigured relay's log from naming every client forever.
 */
const MAX_LOGGED_UNTRUSTED = 256;

/** The TCP peer, the client itself wherever no edge stands in front of the relay. */
function peerOf(request: IncomingMessage): ClientAddress {
  const address = request.socket.remoteAddress ?? UNKNOWN_ADDRESS;
  return { ok: true, address, key: address };
}

/** The 16 bytes of an IPv6 address in any spelling Node accepts, or null. */
function ipv6Bytes(address: string): Uint8Array | null {
  if (!isIPv6(address)) return null;
  let text = address;
  // An embedded dotted quad (::ffff:192.0.2.1) becomes its two hex groups.
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted !== null) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    const hex = `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    text = `${text.slice(0, dotted.index)}${hex}`;
  }
  const [head, tail] = text.split('::') as [string, string | undefined];
  const groupsOf = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const left = groupsOf(head);
  const right = tail === undefined ? [] : groupsOf(tail);
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  });
  return bytes;
}

/**
 * An address as the limits read it: IPv4 as itself, an IPv4-mapped
 * (::ffff:a.b.c.d) or IPv4-compatible (::a.b.c.d) IPv6 address as the IPv4
 * address inside it, and any other IPv6 address in Node's canonical form.
 */
export function normalizeAddress(address: string): { family: 4 | 6; address: string } | null {
  if (isIPv4(address)) return { family: 4, address };
  const bytes = ipv6Bytes(address);
  if (bytes === null) return null;
  const mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  // ::a.b.c.d, though never :: or ::1, whose last bytes are no IPv4 unicast address.
  const compatible = bytes.slice(0, 12).every((byte) => byte === 0) && bytes[12] !== 0;
  if (mapped || compatible) {
    return { family: 4, address: [...bytes.slice(12)].join('.') };
  }
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push((((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0)).toString(16));
  }
  return { family: 6, address: compressIpv6(groups) };
}

/** RFC 5952's text form: the longest run of two or more zero groups becomes ::. */
function compressIpv6(groups: readonly string[]): string {
  let best = { start: -1, length: 0 };
  let run = { start: -1, length: 0 };
  groups.forEach((group, index) => {
    if (group === '0') {
      run =
        run.start === -1
          ? { start: index, length: 1 }
          : { start: run.start, length: run.length + 1 };
      if (run.length > best.length) best = run;
    } else {
      run = { start: -1, length: 0 };
    }
  });
  if (best.length < 2) return groups.join(':');
  const head = groups.slice(0, best.start).join(':');
  const tail = groups.slice(best.start + best.length).join(':');
  return `${head}::${tail}`;
}

/**
 * The key an address's limits count under: an IPv4 address whole, a native
 * IPv6 address by its /56, written as that network (2001:db8:0:1200::/56).
 */
export function limitKeyOf(address: { family: 4 | 6; address: string }): string {
  if (address.family === 4) return address.address;
  const bytes = ipv6Bytes(address.address) ?? new Uint8Array(16);
  const kept = IPV6_KEY_PREFIX / 8;
  bytes.fill(0, kept);
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push((((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0)).toString(16));
  }
  return `${compressIpv6(groups)}/${String(IPV6_KEY_PREFIX)}`;
}

/** What one header line may hold: a bare address, no port, zone, brackets or list. */
const ADDRESS_TEXT = /^[0-9A-Fa-f:.]{2,45}$/;

/** How many lines of one header a request carries, counted on the raw lines. */
function headerLines(request: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      values.push(request.rawHeaders[index + 1] ?? '');
    }
  }
  return values;
}

/** One per relay, built in createRelay and shared by /page, /pair, /i and /mcp's refusal log. */
export function createClientAddresses(config: ResolvedConfig, log: Logger): ClientAddresses {
  const header = config.clientAddressHeader;
  if (!config.hosted || header === null) return { of: peerOf };

  const trusted = new BlockList();
  for (const range of config.trustedProxies) {
    trusted.addSubnet(range.address, range.prefix, range.family);
  }
  let proxyLogged = false;
  const untrustedLogged = new Set<string>();

  /** Whether a peer is the edge's proxy: inside a trusted range, in either of its spellings. */
  const isProxy = (raw: string, peer: { family: 4 | 6; address: string } | null): boolean => {
    if (peer === null) return false;
    if (trusted.check(peer.address, peer.family === 4 ? 'ipv4' : 'ipv6')) return true;
    // A range written for IPv4-mapped space (::ffff:10.0.0.0/104) still matches the raw form.
    return isIPv6(raw) && trusted.check(raw, 'ipv6');
  };

  return {
    of(request) {
      const raw = request.socket.remoteAddress ?? UNKNOWN_ADDRESS;
      const peer = normalizeAddress(raw);
      if (!isProxy(raw, peer)) {
        // Counted as itself, its header unread: nothing it says about a client is believed.
        const address = peer?.address ?? raw;
        if (!untrustedLogged.has(address) && untrustedLogged.size < MAX_LOGGED_UNTRUSTED) {
          untrustedLogged.add(address);
          log.warn(
            'request from a peer outside TABDOCK_TRUSTED_PROXY_CIDR: counted as itself, its client address header ignored (ADR 0018)',
            { peer: address },
          );
        }
        return { ok: true, address, key: peer === null ? address : limitKeyOf(peer) };
      }
      if (!proxyLogged && peer !== null) {
        proxyLogged = true;
        // A first deploy reads this line to narrow TABDOCK_TRUSTED_PROXY_CIDR to the proxy's range.
        log.info('first request through the host edge: its proxy connects from this address', {
          proxy: peer.address,
        });
      }
      const lines = headerLines(request, header);
      if (lines.length === 0) return { ok: false, problem: 'missing' };
      if (lines.length > 1) return { ok: false, problem: 'repeated' };
      const text = (lines[0] ?? '').trim();
      const client = ADDRESS_TEXT.test(text) && isIP(text) !== 0 ? normalizeAddress(text) : null;
      if (client === null) return { ok: false, problem: 'malformed' };
      return { ok: true, address: client.address, key: limitKeyOf(client) };
    },
  };
}

/** A client address as a log line names it: the address, or why the edge's header gave none. */
export function loggedAddress(client: ClientAddress): string {
  return client.ok ? client.address : `(${client.problem} client address header)`;
}

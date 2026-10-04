// M1: `?relay=ws://127.0.0.1:8787/page` links the board to a Tabdock relay
// through the adapter. The query only names the relay to dial; the operator
// still approves every client on the page itself. From M4 the board is also
// published as a static site (ADR 0021), which visitors point at their own
// relay this way, so an https copy asks for a wss: relay.

export type RelayParam =
  { kind: 'absent' } | { kind: 'ok'; url: string } | { kind: 'invalid'; message: string };

/** Loopback hosts, which a browser lets an https page reach over plain ws:. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Reads ?relay, accepting only ws: and wss: URLs; anything else is reported,
 * never dialled. On an https page (pageProtocol) a ws: URL must name this
 * machine: the browser refuses any other as mixed content, and the adapter
 * would only retry it forever.
 */
export function relayFromQuery(params: URLSearchParams, pageProtocol = 'http:'): RelayParam {
  const raw = params.get('relay');
  if (raw === null) return { kind: 'absent' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: 'invalid', message: '?relay is not a URL' };
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return { kind: 'invalid', message: '?relay must be a ws: or wss: URL' };
  }
  // A relay is addressed by host and path; credentials in the URL would leak into history and logs.
  if (url.username !== '' || url.password !== '') {
    return { kind: 'invalid', message: '?relay must not carry a user name or password' };
  }
  if (pageProtocol === 'https:' && url.protocol === 'ws:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    return { kind: 'invalid', message: '?relay must be a wss: URL on an https page' };
  }
  return { kind: 'ok', url: url.href };
}

// M1: `?relay=ws://127.0.0.1:8787/page` links the board to a Tabdock relay
// through the adapter. The query only names the relay to dial; the operator
// still approves every client on the page itself. From M4 the board is also
// published as a static site (ADR 0021), which visitors point at their own
// relay this way, so an https copy asks for a wss: relay. From M5 the query
// no longer makes the board dial: a person clicks to connect first (ADR 0029,
// connect.ts), and the Connect form checks what is typed with these same rules.

export type RelayParam =
  | { kind: 'absent' }
  | { kind: 'ok'; url: string; host: string }
  | { kind: 'invalid'; message: string };

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
  return checkRelayUrl(raw, pageProtocol, '?relay');
}

/**
 * One relay URL checked, from the query or from the Connect form; `label`
 * names where it came from in the message. `host` is `URL.host`, so an
 * internationalised name shows as punycode, with its port, on the Connect bar.
 */
export function checkRelayUrl(
  raw: string,
  pageProtocol: string,
  label: string,
): Exclude<RelayParam, { kind: 'absent' }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: 'invalid', message: `${label} is not a URL` };
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return { kind: 'invalid', message: `${label} must be a ws: or wss: URL` };
  }
  // A relay is addressed by host and path; credentials in the URL would leak into history and logs.
  if (url.username !== '' || url.password !== '') {
    return { kind: 'invalid', message: `${label} must not carry a user name or password` };
  }
  // A query would leave in the page socket's request line, which a tunnel, a
  // host edge or another relay may log whole, so nothing may ride there (S11);
  // the WebSocket constructor refuses a fragment outright. URL.search and
  // URL.hash read an empty query or fragment as none, so the parsed href,
  // where a bare ? or # survives and neither can appear otherwise, decides.
  if (url.href.includes('?') || url.href.includes('#')) {
    return { kind: 'invalid', message: `${label} must not carry a query or a fragment` };
  }
  if (pageProtocol === 'https:' && url.protocol === 'ws:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    return { kind: 'invalid', message: `${label} must be a wss: URL on an https page` };
  }
  return { kind: 'ok', url: url.href, host: url.host };
}

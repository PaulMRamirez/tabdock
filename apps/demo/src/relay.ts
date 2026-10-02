// M1: `?relay=ws://127.0.0.1:8787/page` links the board to a Tabdock relay
// through the adapter. The query only names the relay to dial; the operator
// still approves every client on the page itself.

export type RelayParam =
  { kind: 'absent' } | { kind: 'ok'; url: string } | { kind: 'invalid'; message: string };

/** Reads ?relay, accepting only ws: and wss: URLs; anything else is reported, never dialled. */
export function relayFromQuery(params: URLSearchParams): RelayParam {
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
  return { kind: 'ok', url: url.href };
}

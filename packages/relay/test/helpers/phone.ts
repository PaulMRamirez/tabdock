// A phone's browser at /pair, played over HTTP: it reaches the relay through
// the stand-in tunnel (the public Host), keeps a cookie jar the way a browser
// does for https://relay.test, sends the Origin a same-origin fetch sends, and
// signs in by following the redirects to the test provider and back. Every
// URL it requests is kept, so a test can show the nonce was never in one.

import { PUBLIC_ORIGIN, type RawAnswer, rawRequest } from './tunnel.ts';

const PUBLIC_HOST = new URL(PUBLIC_ORIGIN).host;

export interface PhoneRequest {
  method?: string;
  /** Sent as JSON with Content-Type application/json unless contentType says otherwise. */
  json?: unknown;
  body?: string;
  contentType?: string;
  /** The Origin header: the public origin by default on a POST, null for none. */
  origin?: string | null;
  /** Leave the cookie jar out of this one request. */
  withoutCookies?: boolean;
}

export interface JsonAnswer {
  status: number;
  headers: Headers;
  data: Record<string, unknown>;
}

/** One Set-Cookie line, with its attributes as a browser would read them. */
export interface SetCookie {
  name: string;
  value: string;
  attributes: Map<string, string>;
}

export function parseSetCookie(line: string): SetCookie {
  const [pair = '', ...rest] = line.split(';');
  const split = pair.indexOf('=');
  const attributes = new Map<string, string>();
  for (const part of rest) {
    const at = part.indexOf('=');
    const key = (at === -1 ? part : part.slice(0, at)).trim().toLowerCase();
    attributes.set(key, at === -1 ? '' : part.slice(at + 1).trim());
  }
  return { name: pair.slice(0, split).trim(), value: pair.slice(split + 1).trim(), attributes };
}

export class Phone {
  readonly relayUrl: string;
  readonly cookies = new Map<string, string>();
  /** Every URL this phone requested, at the relay and at the provider, in order. */
  readonly requested: string[] = [];
  /** Every Set-Cookie the relay sent it. */
  readonly setCookies: SetCookie[] = [];

  constructor(relayUrl: string) {
    this.relayUrl = relayUrl;
  }

  async request(path: string, options: PhoneRequest = {}): Promise<RawAnswer> {
    const method = options.method ?? (options.json === undefined ? 'GET' : 'POST');
    const headers: Record<string, string> = {};
    const origin =
      options.origin === undefined && method === 'POST' ? PUBLIC_ORIGIN : options.origin;
    if (origin !== undefined && origin !== null) headers.Origin = origin;
    if (!options.withoutCookies && this.cookies.size > 0) {
      headers.Cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    let body = options.body;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      headers['Content-Type'] = options.contentType ?? 'application/json';
    } else if (options.contentType !== undefined) {
      headers['Content-Type'] = options.contentType;
    }
    this.requested.push(`${PUBLIC_ORIGIN}${path}`);
    const answer = await rawRequest(this.relayUrl, path, {
      method,
      host: PUBLIC_HOST,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    for (const line of answer.headers.getSetCookie()) {
      const cookie = parseSetCookie(line);
      this.setCookies.push(cookie);
      if (cookie.attributes.get('max-age') === '0') this.cookies.delete(cookie.name);
      else this.cookies.set(cookie.name, cookie.value);
    }
    return answer;
  }

  async post(path: string, json: unknown, options: PhoneRequest = {}): Promise<JsonAnswer> {
    const answer = await this.request(path, { ...options, method: 'POST', json });
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(answer.body) as Record<string, unknown>;
    } catch {
      // Not JSON: the status says enough.
    }
    return { status: answer.status, headers: answer.headers, data };
  }

  preview(nonce: string): Promise<JsonAnswer> {
    return this.post('/pair/preview', { nonce });
  }

  claim(nonce: string, options: PhoneRequest = {}): Promise<JsonAnswer> {
    return this.post('/pair/claim', { nonce }, options);
  }

  status(claim: string, options: PhoneRequest = {}): Promise<JsonAnswer> {
    return this.post('/pair/status', { claim }, options);
  }

  /**
   * Taps "Sign in": /pair/login, the provider's /authorize (the mock signs
   * whoever it is told to in at once), and /pair/callback with the code.
   * Returns each hop's answer for tests that look at them. /i's link to sign
   * in is `/pair/login?to=i`.
   */
  async signIn(
    loginPath = '/pair/login',
  ): Promise<{ login: RawAnswer; authorize: URL; callback: RawAnswer }> {
    const login = await this.request(loginPath);
    const authorize = new URL(login.headers.get('location') ?? '');
    this.requested.push(authorize.href);
    const atProvider = await fetch(authorize, { redirect: 'manual' });
    await atProvider.body?.cancel();
    const back = new URL(atProvider.headers.get('location') ?? '');
    if (back.origin !== PUBLIC_ORIGIN) throw new Error('the provider sent the phone elsewhere');
    const callback = await this.request(`${back.pathname}${back.search}`);
    return { login, authorize, callback };
  }
}

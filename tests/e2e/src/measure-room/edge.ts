// The host edge in front of the measured relay (ADR 0018), played on this
// machine: every request reaches the relay on loopback naming the public
// host, with the one client address header the relay is told to believe
// (Fly-Client-IP), set by the edge alone. The page's socket goes through a
// small proxy, since a WebSocket client cannot set Host; MCP clients and the
// students' browsers at /i set both headers themselves, which is what the
// edge would hand on. Every answer's status is counted for the phase that
// asked, so a refusal anywhere shows in the figures.

import { request as httpRequest, type IncomingMessage } from 'node:http';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { Readable } from 'node:stream';
import type { FetchLike } from '@modelcontextprotocol/client';
import type { Tally } from './stats.ts';

export const PUBLIC_ORIGIN = 'https://relay.test';
export const PUBLIC_HOST = 'relay.test';
export const PUBLIC_MCP_URL = `${PUBLIC_ORIGIN}/mcp`;
export const ADDRESS_HEADER = 'fly-client-ip';

/** Where answers are counted: by status, for the phase running when each arrived. */
export interface StatusSink {
  current(): Tally;
}

export interface PageEdge {
  /** ws://127.0.0.1:<port>/page, for the page to dial. */
  readonly pageUrl: string;
  close(): Promise<void>;
}

/**
 * Proxies whole connections to the relay's port, rewriting the first request
 * of each: Host becomes the public host, and any client address or
 * forwarding header is replaced by the edge's own Fly-Client-IP. Only the
 * page's WebSocket goes through it, one request on one connection.
 */
export async function startPageEdge(relayPort: number, address: string): Promise<PageEdge> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) {
        if (head.length > 65_536) client.destroy();
        return;
      }
      client.off('data', onData);
      client.pause();
      const [requestLine = '', ...lines] = head.subarray(0, end).toString('latin1').split('\r\n');
      const kept = lines.filter((line) => {
        const name = line.slice(0, line.indexOf(':')).trim().toLowerCase();
        return (
          name !== 'host' &&
          name !== ADDRESS_HEADER &&
          name !== 'forwarded' &&
          !name.startsWith('x-forwarded-')
        );
      });
      const rewritten = [
        requestLine,
        `Host: ${PUBLIC_HOST}`,
        `Fly-Client-IP: ${address}`,
        ...kept,
        '',
        '',
      ].join('\r\n');
      const upstream = connect(relayPort, '127.0.0.1', () => {
        upstream.write(Buffer.concat([Buffer.from(rewritten, 'latin1'), head.subarray(end + 4)]));
        upstream.pipe(client);
        client.pipe(upstream);
        client.resume();
      });
      sockets.add(upstream);
      upstream.on('close', () => {
        sockets.delete(upstream);
        client.destroy();
      });
      upstream.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
    };
    client.on('data', onData);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const where = server.address();
  const port = typeof where === 'object' && where !== null ? where.port : 0;
  return {
    pageUrl: `ws://127.0.0.1:${String(port)}/page`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

function headersOf(raw: IncomingMessage['headers']): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

function bodyText(body: RequestInit['body']): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error('the stand-in edge carries only text bodies');
}

/**
 * A fetch for an MCP client on one student's device: requests for the
 * public origin reach the relay on loopback as the edge would hand them on,
 * naming `address`; anything else (the provider) goes out as it is.
 */
export function edgeFetch(relayUrl: string, address: string, statuses: StatusSink): FetchLike {
  return (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== PUBLIC_ORIGIN) return fetch(input, init);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    return new Promise<Response>((resolve, reject) => {
      const req = httpRequest(
        new URL(`${url.pathname}${url.search}`, relayUrl),
        {
          method: init?.method ?? 'GET',
          headers: { ...headers, host: PUBLIC_HOST, [ADDRESS_HEADER]: address },
          ...(init?.signal ? { signal: init.signal } : {}),
        },
        (res) => {
          const status = res.statusCode ?? 0;
          statuses.current().add(`http ${String(status)}`);
          const empty = status === 204 || status === 304 || init?.method === 'HEAD';
          if (empty) res.resume();
          resolve(
            new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
              status,
              headers: headersOf(res.headers),
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(bodyText(init?.body));
    });
  };
}

/** The relay answers each hop of a sign-in with a 303, as a browser follows any 3xx. */
function redirected(status: number): boolean {
  return status >= 300 && status < 400;
}

export interface RawAnswer {
  status: number;
  headers: Headers;
  body: string;
}

/** One whole request through the edge for `address`. */
export function edgeRequest(
  relayUrl: string,
  address: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawAnswer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      new URL(path, relayUrl),
      {
        method: options.method ?? 'GET',
        headers: { ...options.headers, host: PUBLIC_HOST, [ADDRESS_HEADER]: address },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: headersOf(res.headers),
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

/**
 * A student's browser at /i, on its own address: a cookie jar for the
 * public origin, the Origin a same-origin fetch sends, and sign-in by
 * following the redirects to the stand-in provider and back.
 */
export class StudentBrowser {
  readonly #cookies = new Map<string, string>();
  readonly relayUrl: string;
  readonly address: string;
  readonly statuses: StatusSink;

  constructor(relayUrl: string, address: string, statuses: StatusSink) {
    this.relayUrl = relayUrl;
    this.address = address;
    this.statuses = statuses;
  }

  async request(
    path: string,
    options: { method?: string; json?: unknown } = {},
  ): Promise<RawAnswer> {
    const method = options.method ?? (options.json === undefined ? 'GET' : 'POST');
    const headers: Record<string, string> = {};
    if (method === 'POST') headers.Origin = PUBLIC_ORIGIN;
    if (this.#cookies.size > 0) {
      headers.Cookie = [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    let body: string | undefined;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      headers['Content-Type'] = 'application/json';
    }
    const answer = await edgeRequest(this.relayUrl, this.address, path, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    this.statuses.current().add(`http ${String(answer.status)}`);
    for (const line of answer.headers.getSetCookie()) {
      const [pair = ''] = line.split(';');
      const split = pair.indexOf('=');
      const name = pair.slice(0, split).trim();
      if (/max-age=0/i.test(line)) this.#cookies.delete(name);
      else this.#cookies.set(name, pair.slice(split + 1).trim());
    }
    return answer;
  }

  async post(
    path: string,
    json: unknown,
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    const answer = await this.request(path, { method: 'POST', json });
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(answer.body) as Record<string, unknown>;
    } catch {
      // Not JSON: the status says enough.
    }
    return { status: answer.status, data };
  }

  /**
   * "Sign in" on /i: /pair/login?to=i, the provider's /authorize, and the
   * callback with its code. True when the relay sent the browser back to /i
   * signed in; false when it refused the sign-in, such as past a sign-in limit.
   */
  async signIn(): Promise<boolean> {
    const login = await this.request('/pair/login?to=i');
    const authorize = login.headers.get('location');
    if (!redirected(login.status) || authorize === null) return false;
    const atProvider = await fetch(authorize, { redirect: 'manual' });
    await atProvider.body?.cancel();
    const back = new URL(atProvider.headers.get('location') ?? '', PUBLIC_ORIGIN);
    if (back.origin !== PUBLIC_ORIGIN) return false;
    const callback = await this.request(`${back.pathname}${back.search}`);
    return redirected(callback.status) && callback.headers.get('location') === '/i';
  }
}

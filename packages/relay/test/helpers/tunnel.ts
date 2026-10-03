// Plays the tunnel in front of a public relay: a request for the public origin
// reaches the relay on loopback with the public Host header, as ngrok forwards
// it. fetch cannot set Host, so these go through node:http. Everything else,
// such as calls to the test identity provider, goes out through plain fetch.

import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import type { FetchLike } from '@modelcontextprotocol/client';

export const PUBLIC_ORIGIN = 'https://relay.test';
export const PUBLIC_MCP_URL = `${PUBLIC_ORIGIN}/mcp`;
export const PUBLIC_METADATA_URL = `${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp`;

export interface RawAnswer {
  status: number;
  headers: Headers;
  body: string;
}

function bodyText(body: RequestInit['body']): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error('the test tunnel carries only text bodies');
}

function headersOf(raw: NodeJS.Dict<string | string[]>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

/** One request to the relay with whatever Host and headers a test asks for, answered whole. */
export function rawRequest(
  relayUrl: string,
  path: string,
  options: { method?: string; host?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawAnswer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      new URL(path, relayUrl),
      {
        method: options.method ?? 'GET',
        headers: {
          ...(options.host === undefined ? {} : { Host: options.host }),
          ...options.headers,
        },
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

/** A fetch for MCP clients that reach the relay at PUBLIC_ORIGIN through the stand-in tunnel. */
export function tunnelFetch(relayUrl: string): FetchLike {
  const host = new URL(PUBLIC_ORIGIN).host;
  return (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== PUBLIC_ORIGIN) return fetch(input, init);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    return new Promise<Response>((resolve, reject) => {
      const req = httpRequest(
        new URL(`${url.pathname}${url.search}`, relayUrl),
        {
          method: init?.method ?? 'GET',
          headers: { ...headers, host },
          ...(init?.signal ? { signal: init.signal } : {}),
        },
        (res) => {
          const status = res.statusCode ?? 0;
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

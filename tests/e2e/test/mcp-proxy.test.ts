// The loopback proxy the conformance run and the revision checks stand
// behind (src/mcp-proxy.ts, ADR 0027). It must pass every header line up as
// the client wrote it, Host and Origin included and two Origin lines as two,
// so the suite's rebinding scenario tests the relay's own checks; replace the
// client's Authorization with the run's bearer when it has one; record each
// request as it arrives, before any answer, since the relay holds back a GET
// stream's head, with the tool a tools/call names, the names a tools/list
// answer gives and what each answer said, so a check can tell which route a
// client took; keep no token, session id or argument in a record; leave one
// rebinding guard alone to refuse a probe when asked (soleGuard); and log
// nothing at all.

import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type McpProxy, startMcpProxy } from '../src/mcp-proxy.ts';

let upstream: Server | undefined;
let proxy: McpProxy | undefined;
/** Releases the upstream's held GET answer. */
let release: (() => void) | undefined;

afterEach(async () => {
  release?.();
  release = undefined;
  await proxy?.close();
  proxy = undefined;
  upstream?.closeAllConnections();
  await new Promise<void>((resolve) => {
    if (upstream === undefined) resolve();
    else
      upstream.close(() => {
        resolve();
      });
  });
  upstream = undefined;
  vi.restoreAllMocks();
});

/** Each answer the upstream gives to a POST whose body holds the key, in place of initialize's. */
const ANSWERS: Record<string, string> = {
  'tools/list':
    '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"list_pages","inputSchema":{}},{"name":"pg_1__set_value","inputSchema":{}}]}}',
  'tool-error': '{"jsonrpc":"2.0","id":1,"result":{"content":[],"isError":true}}',
  'rpc-error': '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"nope"}}',
};

/** An upstream that keeps each request's raw header lines, holds GETs until released, and answers JSON-RPC. */
async function startUpstream(): Promise<{ origin: string; seen: IncomingMessage['rawHeaders'][] }> {
  const seen: string[][] = [];
  upstream = createServer((request, response) => {
    seen.push([...request.rawHeaders]);
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    if (request.method === 'GET') {
      release = () => {
        if (response.headersSent) return;
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Mcp-Session-Id': 'sess-secret-123',
        });
        response.write('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
      };
      return;
    }
    request.on('end', () => {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Mcp-Session-Id': 'sess-secret-123',
      });
      const key = Object.keys(ANSWERS).find((one) => body.includes(one));
      response.end(
        key === undefined
          ? '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25"}}'
          : ANSWERS[key],
      );
    });
  });
  await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${String(port)}`, seen };
}

/** One request to the proxy with raw header lines, answered or abandoned once its head is back. */
function send(
  url: string,
  method: string,
  headers: string[],
  body?: string,
): Promise<{ status: number; text: string }> {
  // Raw header lines make Node send no Host of its own, so a loopback one goes first unless the test gives one.
  const lines = headers.some((name, index) => index % 2 === 0 && name.toLowerCase() === 'host')
    ? headers
    : ['Host', new URL(url).host, ...headers];
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers: lines }, (response) => {
      let text = '';
      response.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8');
        if (method === 'GET') {
          response.destroy();
          resolve({ status: response.statusCode ?? 0, text });
        }
      });
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, text });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function pairs(raw: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    out.push([(raw[index] ?? '').toLowerCase(), raw[index + 1] ?? '']);
  }
  return out;
}

describe('the loopback proxy', () => {
  it("passes Host and every Origin line through untouched and puts its bearer in place of the client's", async () => {
    const { origin, seen } = await startUpstream();
    proxy = await startMcpProxy({ upstream: origin, bearer: 'run-token-0123456789abcdef' });
    const answer = await send(
      proxy.url,
      'POST',
      [
        'Host',
        'evil.example:8080',
        'Origin',
        'https://a.example',
        'Origin',
        'https://b.example',
        'Authorization',
        'Bearer client-token',
        'Content-Type',
        'application/json',
      ],
      '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    );
    expect(answer.status).toBe(200);
    const headers = pairs(seen[0] ?? []);
    expect(headers.filter(([name]) => name === 'host')).toEqual([['host', 'evil.example:8080']]);
    expect(headers.filter(([name]) => name === 'origin')).toEqual([
      ['origin', 'https://a.example'],
      ['origin', 'https://b.example'],
    ]);
    expect(headers.filter(([name]) => name === 'authorization')).toEqual([
      ['authorization', 'Bearer run-token-0123456789abcdef'],
    ]);
  });

  it("leaves the client's Authorization alone when it has no bearer of its own", async () => {
    const { origin, seen } = await startUpstream();
    proxy = await startMcpProxy({ upstream: origin, record: true });
    await send(proxy.url, 'POST', ['Authorization', 'Bearer client-token'], '{}');
    expect(pairs(seen[0] ?? []).filter(([name]) => name === 'authorization')).toEqual([
      ['authorization', 'Bearer client-token'],
    ]);
  });

  it('records a request as it arrives, before its answer, and keeps no token, session id or argument', async () => {
    const { origin } = await startUpstream();
    proxy = await startMcpProxy({
      upstream: origin,
      bearer: 'run-token-0123456789abcdef',
      record: true,
    });
    await send(
      proxy.url,
      'POST',
      ['Content-Type', 'application/json', 'Mcp-Session-Id', 'sess-secret-123'],
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'set_value', arguments: { value: 'argument-secret-456' } },
      }),
    );
    const stream = send(proxy.url, 'GET', [
      'Accept',
      'text/event-stream',
      'Mcp-Session-Id',
      'sess-secret-123',
    ]);
    // The upstream holds the GET's head; the record has it already.
    await vi.waitFor(() => {
      expect(proxy?.requests().map((r) => [r.method, r.status])).toEqual([
        ['POST', 200],
        ['GET', null],
      ]);
    });
    release?.();
    expect((await stream).status).toBe(200);
    await vi.waitFor(() => {
      expect(proxy?.requests()[1]?.heard).toEqual(['notifications/tools/list_changed']);
    });
    const records = proxy.requests();
    // The tool a call names is kept, as the relay's own audit keeps it, so a
    // check can tell which route a client took; its arguments never are.
    expect(records[0]).toMatchObject({
      session: 's1',
      negotiated: '2025-11-25',
      messages: [
        { method: 'tools/call', request: true, version: null, client: null, tool: 'set_value' },
      ],
      outcomes: ['result'],
    });
    const text = JSON.stringify(records);
    for (const secret of ['run-token', 'sess-secret-123', 'argument-secret-456', '"value"']) {
      expect(text).not.toContain(secret);
    }
  });

  it('records the names a tools/list answer gives and what each answer said, and no tool name for any other method', async () => {
    const { origin } = await startUpstream();
    proxy = await startMcpProxy({ upstream: origin, record: true });
    const post = (message: Record<string, unknown>): Promise<{ status: number }> =>
      send(
        proxy?.url ?? '',
        'POST',
        ['Content-Type', 'application/json'],
        JSON.stringify({ jsonrpc: '2.0', id: 1, ...message }),
      );
    await post({ method: 'tools/list', params: {} });
    await post({ method: 'tools/call', params: { name: 'tool-error', arguments: {} } });
    await post({ method: 'tools/call', params: { name: 'rpc-error', arguments: {} } });
    // A name in any other method's params is not a tool's.
    await post({ method: 'prompts/get', params: { name: 'a-prompt' } });
    await vi.waitFor(() => {
      expect(proxy?.requests().map((r) => r.outcomes)).toEqual([
        ['result'],
        ['tool-error'],
        ['error'],
        ['result'],
      ]);
    });
    const records = proxy.requests();
    expect(records[0]?.listed).toEqual(['list_pages', 'pg_1__set_value']);
    expect(records.slice(1).map((r) => r.listed)).toEqual([[], [], []]);
    expect(records.map((r) => r.messages[0]?.tool)).toEqual([
      null,
      'tool-error',
      'rpc-error',
      null,
    ]);
  });

  it("leaves the Origin check alone to refuse a rebinding probe: the relay's own Host in place of any other", async () => {
    const { origin, seen } = await startUpstream();
    proxy = await startMcpProxy({ upstream: origin, bearer: 'run-token', soleGuard: 'origin' });
    await send(
      proxy.url,
      'POST',
      ['Host', 'evil.example.com', 'Origin', 'http://evil.example.com'],
      '{}',
    );
    const headers = pairs(seen[0] ?? []);
    expect(headers.filter(([name]) => name === 'host')).toEqual([['host', new URL(origin).host]]);
    expect(headers.filter(([name]) => name === 'origin')).toEqual([
      ['origin', 'http://evil.example.com'],
    ]);
  });

  it('leaves the Host checks alone to refuse a rebinding probe: every Origin line dropped', async () => {
    const { origin, seen } = await startUpstream();
    proxy = await startMcpProxy({ upstream: origin, bearer: 'run-token', soleGuard: 'host' });
    await send(
      proxy.url,
      'POST',
      ['Host', 'evil.example.com', 'Origin', 'http://evil.example.com', 'Origin', 'http://b.test'],
      '{}',
    );
    const headers = pairs(seen[0] ?? []);
    expect(headers.filter(([name]) => name === 'host')).toEqual([['host', 'evil.example.com']]);
    expect(headers.filter(([name]) => name === 'origin')).toEqual([]);
  });

  it('logs nothing, on any channel', async () => {
    const writes = [
      vi.spyOn(process.stdout, 'write'),
      vi.spyOn(process.stderr, 'write'),
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'debug'),
    ];
    const { origin } = await startUpstream();
    proxy = await startMcpProxy({
      upstream: origin,
      bearer: 'run-token-0123456789abcdef',
      record: true,
    });
    await send(
      proxy.url,
      'POST',
      ['Content-Type', 'application/json'],
      '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    );
    // An upstream that is gone is answered 502, still without a word.
    upstream?.closeAllConnections();
    await new Promise<void>((resolve) => {
      upstream?.close(() => {
        resolve();
      });
    });
    upstream = undefined;
    expect((await send(proxy.url, 'POST', [], '{}')).status).toBe(502);
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });
});

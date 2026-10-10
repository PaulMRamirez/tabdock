// The canvas map page's server: it answers only its own loopback names, so a
// site whose name is rebound to 127.0.0.1 cannot read the page (S2); it
// serves the bundle from memory under a policy that admits its own script
// and its one inline style; and its port comes from --port, MAP_PAGE_PORT or
// 5174, with a refusal that never repeats what it was given.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_MAP_PAGE_PORT,
  mapPagePolicy,
  mapPagePort,
  type MapPageServer,
  startMapPageServer,
} from '../scripts/server.ts';

let server: MapPageServer;
let port: number;

beforeAll(async () => {
  server = await startMapPageServer();
  port = Number(new URL(server.url).port);
}, 60_000);

afterAll(async () => {
  await server.close();
});

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A request with any Host header, which fetch() will not send. */
function get(path: string, options: { host?: string; method?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const sent = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { host: options.host ?? `127.0.0.1:${String(port)}` },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    sent.on('error', reject);
    sent.end();
  });
}

describe('the map page server', () => {
  it('serves the page and its bundle from memory to its own loopback names', async () => {
    for (const host of [`127.0.0.1:${String(port)}`, `localhost:${String(port)}`]) {
      const page = await get('/', { host });
      expect(page.status).toBe(200);
      expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(page.body).toContain('<canvas id="map"');
    }
    const script = await get('/main.js');
    expect(script.status).toBe(200);
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(script.body).toContain('__tabdockMapPage');
    expect((await get('/main.js.map')).status).toBe(200);
  });

  it('answers 421 to a foreign Host, as a rebound name would send', async () => {
    for (const host of ['evil.example', `evil.example:${String(port)}`, '127.0.0.1:1']) {
      const answer = await get('/', { host });
      expect(answer.status, host).toBe(421);
      expect(answer.body).not.toContain('<canvas');
    }
    expect((await get('/main.js', { host: 'evil.example' })).status).toBe(421);
  });

  it('answers 404 to any other path and 405 to any other method', async () => {
    expect((await get('/x')).status).toBe(404);
    expect((await get('/src/main.ts')).status).toBe(404);
    expect((await get('/', { method: 'POST' })).status).toBe(405);
    expect((await get('//evil.example/')).status).toBe(400);
  });

  it('sends a policy that admits its own script and its one inline style, and nothing framed', async () => {
    const answer = await get('/');
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
    const hash = createHash('sha256').update(style, 'utf8').digest('base64');
    expect(answer.headers['content-security-policy']).toBe(mapPagePolicy(html));
    expect(answer.headers['content-security-policy']).toContain(`style-src 'sha256-${hash}'`);
    expect(answer.headers['content-security-policy']).toContain("script-src 'self'");
    expect(answer.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(answer.headers['content-security-policy']).toContain("default-src 'none'");
    expect(answer.headers['x-content-type-options']).toBe('nosniff');
    expect(answer.headers['referrer-policy']).toBe('no-referrer');
    // Even a refusal carries the headers.
    expect((await get('/', { host: 'evil.example' })).headers['x-content-type-options']).toBe(
      'nosniff',
    );
    // The page loads its script by a relative path, with no inline script.
    expect(html).toContain('<script type="module" src="./main.js"></script>');
    expect(html.match(/<script\b/g)).toHaveLength(1);
  });
});

describe('the port the CLI serves on', () => {
  it('is --port, else MAP_PAGE_PORT, else 5174', () => {
    expect(mapPagePort(['--port', '5180'], { MAP_PAGE_PORT: '6000' })).toEqual({
      kind: 'ok',
      port: 5180,
    });
    expect(mapPagePort([], { MAP_PAGE_PORT: '6000' })).toEqual({ kind: 'ok', port: 6000 });
    expect(mapPagePort([], { MAP_PAGE_PORT: '' })).toEqual({ kind: 'ok', port: 5174 });
    expect(mapPagePort([], {})).toEqual({ kind: 'ok', port: DEFAULT_MAP_PAGE_PORT });
    expect(DEFAULT_MAP_PAGE_PORT).toBe(5174);
  });

  it('refuses anything but a port from 1 to 65535, never quoting it', () => {
    for (const value of ['0', '65536', 'Zq7Mark9Wq', '80 ', '-1', '1e3']) {
      const fromEnv = mapPagePort([], { MAP_PAGE_PORT: `${value}x` });
      expect(fromEnv).toEqual({
        kind: 'refused',
        message: 'MAP_PAGE_PORT must be a port number from 1 to 65535',
      });
      const fromFlag = mapPagePort(['--port', value], {});
      expect(fromFlag).toEqual({
        kind: 'refused',
        message: '--port must be a port number from 1 to 65535',
      });
    }
    expect(mapPagePort(['--port'], {})).toMatchObject({ kind: 'refused' });
  });
});

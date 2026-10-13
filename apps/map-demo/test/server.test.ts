// The map demo's static build and dev server (ADR 0050): the build holds
// exactly index.html, main.js and main.js.map within the size budget, under
// the board's meta policy without worker-src, loading its one script by a
// relative path with no inline script and no outside URL; the dev server
// serves that same page, answers only its own loopback names, and takes its
// port from --port or MAP_DEMO_PORT without echoing a bad value.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { staticPolicy } from '@tabdock/demo/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildMapDemo,
  DEFAULT_MAP_DEMO_PORT,
  mapDemoPolicy,
  mapDemoPort,
  type MapDemoServer,
  startMapDemoServer,
} from '../scripts/server.ts';

/** ADR 0050's budget for the static build; the source map, which only developer tools fetch, is outside it. */
const BUDGET = { mainJs: 800_000, mainJsGzip: 200_000, indexHtml: 16_000 };

let outDir = '';
let server: MapDemoServer | undefined;

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'tabdock-map-demo-'));
  await buildMapDemo({ outDir });
  server = await startMapDemoServer();
}, 60_000);

afterAll(async () => {
  await server?.close();
  rmSync(outDir, { recursive: true, force: true });
});

function getAs(url: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sent = request(url, { headers: { host } }, (response) => {
      let body = '';
      response.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, body });
      });
    });
    sent.on('error', reject);
    sent.end();
  });
}

describe("the map demo's static build", () => {
  it('holds exactly its page, script and source map, within the budget', () => {
    expect(readdirSync(outDir).sort()).toEqual(['index.html', 'main.js', 'main.js.map']);
    const main = readFileSync(join(outDir, 'main.js'));
    expect(main.length).toBeLessThanOrEqual(BUDGET.mainJs);
    expect(gzipSync(main).length).toBeLessThanOrEqual(BUDGET.mainJsGzip);
    expect(readFileSync(join(outDir, 'index.html')).length).toBeLessThanOrEqual(BUDGET.indexHtml);
  });

  it("carries the board's policy without worker-src, first in its head, and loads one relative script", () => {
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)" \/>/.exec(
      html,
    )?.[1];
    const hash = /'sha256-([^']+)'/.exec(policy ?? '')?.[1] ?? '';
    expect(policy).toBe(mapDemoPolicy(hash));
    expect(policy).toBe(staticPolicy(hash).replace('; worker-src blob:', ''));
    expect(policy).not.toContain('worker-src');
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<style>'));
    expect(html).toContain('<meta name="referrer" content="no-referrer" />');
    expect([...html.matchAll(/<script\b[^>]*>/g)].map(([tag]) => tag)).toEqual([
      '<script type="module" src="./main.js">',
    ]);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    // Nothing on the page comes from, or sends a reader to, another origin.
    expect(html).not.toMatch(/(?:src|href)="(?:https?:)?\/\//);
  });

  it('holds no test hook in its script', () => {
    const main = readFileSync(join(outDir, 'main.js'), 'utf8');
    expect(main).not.toMatch(/__tabdock(?:Dock|MapPage)/);
    expect(main).not.toMatch(/\.(?:has|get)\(\s*["']e2e["']\s*\)/);
    expect(main).toContain('isTrusted');
  });
});

describe("the map demo's dev server", () => {
  it("serves the static build's own page and script, and answers only its own loopback names", async () => {
    const url = server?.url ?? '';
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain('<meta http-equiv="Content-Security-Policy"');
    expect((await fetch(new URL('main.js', url))).status).toBe(200);
    expect((await fetch(new URL('other.js', url))).status).toBe(404);
    const port = new URL(url).port;
    expect((await getAs(url, `localhost:${port}`)).status).toBe(200);
    expect((await getAs(url, `evil.example:${port}`)).status).toBe(421);
  });

  it('takes its port from --port, then MAP_DEMO_PORT, then 5175, naming the setting at fault', () => {
    expect(mapDemoPort([], {})).toEqual({ kind: 'ok', port: DEFAULT_MAP_DEMO_PORT });
    expect(mapDemoPort([], { MAP_DEMO_PORT: '6100' })).toEqual({ kind: 'ok', port: 6100 });
    expect(mapDemoPort(['--port', '6200'], { MAP_DEMO_PORT: '6100' })).toEqual({
      kind: 'ok',
      port: 6200,
    });
    const refused = mapDemoPort([], { MAP_DEMO_PORT: 'secret-ish' });
    expect(refused).toEqual({
      kind: 'refused',
      message: 'MAP_DEMO_PORT must be a port number from 1 to 65535',
    });
    expect(mapDemoPort(['--port', '70000'], {}).kind).toBe('refused');
  });
});

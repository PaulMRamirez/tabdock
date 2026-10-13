// The map demo's static build and dev server (ADR 0050): the build holds
// exactly index.html, main.js, main.js.map and the recording's three files
// in media/, which the page plays, within the size budget, under the board's
// meta policy with media-src 'self' and worker-src 'none', loading its one
// script by a relative path with no inline script and no outside URL; the
// dev server serves that same page and the recording, answers only its own
// loopback names, and takes its port from --port or MAP_DEMO_PORT without
// echoing a bad value.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { staticPolicy } from '@tabdock/demo/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildMapDemo,
  DEFAULT_MAP_DEMO_PORT,
  MAP_DEMO_MEDIA,
  mapDemoPolicy,
  mapDemoPort,
  type MapDemoServer,
  startMapDemoServer,
} from '../scripts/server.ts';

/** ADR 0050's budget for the static build; the source map, which only developer tools fetch, is outside it. */
const BUDGET = { mainJs: 800_000, mainJsGzip: 200_000, indexHtml: 16_000 };
/**
 * What the script measured once zod's other languages were left out (13
 * October 2026: 447,415 bytes, 148,280 gzipped), with room to grow. A
 * bundle past this has most likely taken the locales back, about 260 KB.
 */
const MEASURED = { mainJs: 520_000, mainJsGzip: 165_000 };

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
  it('holds exactly its page, script, source map and recording, within the budget', () => {
    expect(readdirSync(outDir).sort()).toEqual(['index.html', 'main.js', 'main.js.map', 'media']);
    expect(readdirSync(join(outDir, 'media')).sort()).toEqual(Object.values(MAP_DEMO_MEDIA).sort());
    // Copied byte for byte from the source tree, where pnpm record:map-demo keeps them.
    for (const name of Object.values(MAP_DEMO_MEDIA)) {
      expect(
        readFileSync(join(outDir, 'media', name)).equals(
          readFileSync(new URL(`../media/${name}`, import.meta.url)),
        ),
        name,
      ).toBe(true);
    }
    const main = readFileSync(join(outDir, 'main.js'));
    expect(main.length).toBeLessThanOrEqual(BUDGET.mainJs);
    expect(gzipSync(main).length).toBeLessThanOrEqual(BUDGET.mainJsGzip);
    expect(readFileSync(join(outDir, 'index.html')).length).toBeLessThanOrEqual(BUDGET.indexHtml);
  });

  it('plays the recording from its poster, as an MP4 and a WebM, and leaves the README loop out', () => {
    expect(MAP_DEMO_MEDIA).toEqual({
      video: 'map-demo.mp4',
      webm: 'map-demo.webm',
      poster: 'poster.png',
    });
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    const video = /<video\b[^>]*>[\s\S]*?<\/video>/.exec(html)?.[0] ?? '';
    expect(video).toContain('poster="media/poster.png"');
    expect(video).toContain('preload="none"');
    expect(video).not.toMatch(/\sautoplay\b/);
    expect(
      [...video.matchAll(/<source src="([^"]+)" type="([^"]+)"/g)].map((m) => [m[1], m[2]]),
    ).toEqual([
      ['media/map-demo.mp4', 'video/mp4'],
      ['media/map-demo.webm', 'video/webm'],
    ]);
    expect(html).toContain('<a href="media/map-demo.mp4">');
    expect(existsSync(join(outDir, 'media', 'map-demo-loop.gif'))).toBe(false);
  });

  it('leaves the recording out only when asked, for the recorder', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'tabdock-map-demo-bare-'));
    try {
      await buildMapDemo({ outDir: bare, media: false });
      expect(readdirSync(bare).sort()).toEqual(['index.html', 'main.js', 'main.js.map']);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  }, 60_000);

  it("carries zod's English messages alone, and stays near its measured size", () => {
    const main = readFileSync(join(outDir, 'main.js'));
    const text = main.toString('utf8');
    // Dutch and Indonesian stand for the rest: each appears only in its own locale.
    expect(text).not.toContain('Ongeldige invoer');
    expect(text).not.toContain('Input tidak valid');
    expect(text).toContain('Invalid input: expected');
    expect(main.length).toBeLessThanOrEqual(MEASURED.mainJs);
    expect(gzipSync(main).length).toBeLessThanOrEqual(MEASURED.mainJsGzip);
  });

  it("carries the board's policy with worker-src 'none', first in its head, and loads one relative script", () => {
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)" \/>/.exec(
      html,
    )?.[1];
    const hash = /'sha256-([^']+)'/.exec(policy ?? '')?.[1] ?? '';
    expect(policy).toBe(mapDemoPolicy(hash));
    // The board's blob: worker closed, not dropped: without worker-src a worker
    // would fall back to script-src 'self'. Media from this origin alone, for the recording.
    expect(policy).toBe(
      staticPolicy(hash)
        .replace('worker-src blob:', "worker-src 'none'")
        .replace("img-src 'self'", "img-src 'self'; media-src 'self'"),
    );
    expect(policy).toContain("; worker-src 'none'; ");
    expect(policy).toContain("; media-src 'self'; ");
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
    // The recording by its three names alone, each with its type.
    const poster = await fetch(new URL(`media/${MAP_DEMO_MEDIA.poster}`, url));
    expect(poster.status).toBe(200);
    expect(poster.headers.get('content-type')).toBe('image/png');
    for (const [name, type] of [
      [MAP_DEMO_MEDIA.video, 'video/mp4'],
      [MAP_DEMO_MEDIA.webm, 'video/webm'],
    ] as const) {
      const video = await fetch(new URL(`media/${name}`, url), { method: 'HEAD' });
      expect(video.status, name).toBe(200);
      expect(video.headers.get('content-type'), name).toBe(type);
    }
    for (const other of [
      'media/',
      'media/other.png',
      'media/POSTER.PNG',
      'media/poster.png/',
      'media/map-demo-loop.gif',
    ]) {
      expect((await fetch(new URL(other, url))).status, other).toBe(404);
    }
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

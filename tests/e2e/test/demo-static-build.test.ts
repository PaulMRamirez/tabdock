// The demo's static build, as GitHub Pages serves it (ADR 0029): its bundle
// holds no ?e2e bypass of the Connect click, and its index.html carries the
// meta policy with the hash of its one inline style and loads its script by
// a relative path. The dev and test bundle is built beside it as the
// yardstick, so a probe that could never match fails here instead of passing.

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDemo, type DemoServer, staticIndexHtml, startDemoServer } from '@tabdock/demo/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let outDir = '';
let staticBundle = '';
let staticHtml = '';
let devBundle = '';
let demo: DemoServer | undefined;

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'tabdock-demo-static-'));
  await buildDemo({ outDir });
  staticBundle = readFileSync(join(outDir, 'main.js'), 'utf8');
  staticHtml = readFileSync(join(outDir, 'index.html'), 'utf8');
  demo = await startDemoServer();
  devBundle = await (await fetch(new URL('main.js', demo.url))).text();
}, 60_000);

afterAll(async () => {
  await demo?.close();
  rmSync(outDir, { recursive: true, force: true });
});

/** The bundle as it runs: sourcemap comment and comments left out by esbuild already. */
function hasE2eBypass(bundle: string): boolean {
  // The hook's handle and its query parameter, as main.ts names them.
  return bundle.includes('__tabdockDock') || /\.has\(\s*["']e2e["']\s*\)/.test(bundle);
}

/** main.ts's ?mcpb loader: the embed's path, or the test of its query parameter. */
function hasMcpbLoader(bundle: string): boolean {
  return bundle.includes('webmcp-local-relay') || /\.has\(\s*["']mcpb["']\s*\)/.test(bundle);
}

describe("the demo's static build (ADR 0029)", () => {
  it('holds no ?e2e bypass of the Connect click, where the dev and test bundle does', () => {
    expect(hasE2eBypass(devBundle), 'the yardstick: the dev bundle has the hook').toBe(true);
    expect(hasE2eBypass(staticBundle)).toBe(false);
    // The click itself is in both.
    for (const bundle of [staticBundle, devBundle]) expect(bundle).toContain('isTrusted');
  });

  it("holds no ?mcpb loader for MCP-B's embed, where the dev and test bundle does", () => {
    // The loader names a path at the origin's root, which under a
    // <user>.github.io/<repository>/ fallback is another site's, and script-src
    // 'self' would run whatever that site serves there.
    expect(hasMcpbLoader(devBundle), 'the yardstick: the dev bundle has the loader').toBe(true);
    expect(hasMcpbLoader(staticBundle)).toBe(false);
  });

  it('carries the meta policy, with the hash of its one inline style, before anything it governs', () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(staticHtml)?.[1] ?? '';
    expect(style).toContain('.connect');
    const hash = createHash('sha256').update(style, 'utf8').digest('base64');
    const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)" \/>/.exec(
      staticHtml,
    );
    expect(policy?.[1]).toBe(
      [
        "default-src 'none'",
        "script-src 'self'",
        `style-src 'self' 'sha256-${hash}'`,
        "img-src 'self'",
        'connect-src wss: ws:',
        'worker-src blob:',
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
    );
    const at = staticHtml.indexOf('http-equiv="Content-Security-Policy"');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(staticHtml.indexOf('<style>'));
    expect(at).toBeLessThan(staticHtml.indexOf('<title>'));
    expect(staticHtml).toContain('<meta name="referrer" content="no-referrer" />');
  });

  it('loads its script by a relative path, so a copy under a subpath works too', () => {
    expect([...staticHtml.matchAll(/<script\b[^>]*>/g)].map((match) => match[0])).toEqual([
      '<script type="module" src="./main.js">',
    ]);
  });

  it("serves the dev and test server's page with no meta policy, under its headers instead", async () => {
    const response = await fetch(demo?.url ?? '');
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
    expect(await response.text()).not.toContain('http-equiv="Content-Security-Policy"');
  });
});

describe('staticIndexHtml refuses a page its policy would break', () => {
  const page = (head: string, body = '<script type="module" src="./main.js"></script>') =>
    `<!doctype html><html><head>\n    <meta charset="utf-8" />\n${head}</head><body>${body}</body></html>`;

  it('takes a page with one style block and a relative module script', () => {
    expect(staticIndexHtml(page('<style>a{}</style>'))).toContain(
      `'sha256-${createHash('sha256').update('a{}').digest('base64')}'`,
    );
  });

  it('refuses a second style block, a style attribute, or none', () => {
    expect(() => staticIndexHtml(page('<style>a{}</style><style>b{}</style>'))).toThrow(
      /exactly one inline <style>/,
    );
    expect(() => staticIndexHtml(page(''))).toThrow(/exactly one inline <style>/);
    expect(() =>
      staticIndexHtml(
        page('<style>a{}</style>', '<p style="color:red"></p><script src="./m.js"></script>'),
      ),
    ).toThrow(/no style attribute/);
  });

  it('refuses an inline script, an absolute script path, or another origin', () => {
    for (const body of [
      '<script>alert(1)</script>',
      '<script type="module" src="/main.js"></script>',
      '<script src="https://cdn.example/x.js"></script>',
      '<script src="./main.js">alert(1)</script>',
      '',
    ]) {
      expect(() => staticIndexHtml(page('<style>a{}</style>', body)), body).toThrow();
    }
  });
});

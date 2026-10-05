// Builds the demo page with esbuild and serves it on localhost.
//   node scripts/server.ts           watch and serve (pnpm dev)
//   node scripts/server.ts --build   one-off static build into dist/
// The e2e harness imports startDemoServer() to serve the page on a free port,
// and apps/site imports buildDemo() to put the static build at the site's root.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const appDir = resolve(import.meta.dirname, '..');
const distDir = join(appDir, 'dist');

// The embed fetches widget.html from beside itself, so both are served from one directory.
const relayBrowserDir = join(
  dirname(fileURLToPath(import.meta.resolve('@mcp-b/webmcp-local-relay'))),
  'browser',
);

/** Every path the server answers, mapped to where its bytes come from. Anything else is a 404. */
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: join(appDir, 'index.html'), type: 'text/html; charset=utf-8' },
  '/index.html': { file: join(appDir, 'index.html'), type: 'text/html; charset=utf-8' },
  '/vendor/webmcp-local-relay/embed.js': {
    file: join(relayBrowserDir, 'embed.js'),
    type: 'text/javascript; charset=utf-8',
  },
  '/vendor/webmcp-local-relay/widget.html': {
    file: join(relayBrowserDir, 'widget.html'),
    type: 'text/html; charset=utf-8',
  },
};

const BUNDLE_TYPES: Record<string, string> = {
  '/main.js': 'text/javascript; charset=utf-8',
  '/main.js.map': 'application/json; charset=utf-8',
};

const SECURITY_HEADERS = {
  // No other site may frame these pages. Without this, any site could frame the
  // vendored widget.html, which runs with this origin, and slip its own tools past
  // MCP-B's --widget-origin check; Tabdock's on-page prompts will need it too.
  'Content-Security-Policy': "frame-ancestors 'self'",
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

const buildOptions = {
  entryPoints: [join(appDir, 'src/main.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: join(distDir, 'main.js'),
  sourcemap: true,
  logLevel: 'warning',
  define: { __TABDOCK_E2E_HOOK__: 'false' },
} satisfies esbuild.BuildOptions;

/**
 * Static build for hosting elsewhere (GitHub Pages, ADRs 0021 and 0029), into
 * dist/ or `outDir`, which it empties first. It leaves out MCP-B's vendored
 * files: a static host cannot send frame-ancestors, and a frameable
 * widget.html is exactly the injection the dev server's headers prevent. For
 * the same reason the board itself refuses to link to a relay inside a frame
 * (src/main.ts), in this build and every other. Its index.html carries the
 * policy staticIndexHtml writes, since a static host sends no headers of ours.
 */
export async function buildDemo(options: { outDir?: string } = {}): Promise<void> {
  const outDir = options.outDir ?? distDir;
  await rm(outDir, { recursive: true, force: true });
  // minifySyntax drops the code behind the false ?e2e hook outright, so not
  // even dead code for it reaches a published copy (ADR 0029).
  await esbuild.build({ ...buildOptions, minifySyntax: true, outfile: join(outDir, 'main.js') });
  const html = await readFile(join(appDir, 'index.html'), 'utf8');
  await writeFile(join(outDir, 'index.html'), staticIndexHtml(html));
}

/**
 * The static build's policy (ADR 0029). Scripts come from this origin only
 * and styles from the one inline block named by its hash; `connect-src` names
 * ws: as a scheme because CSP's host grammar cannot name [::1], which costs
 * nothing, since a browser refuses ws: from an https page to anything but
 * loopback. `worker-src blob:` is ?busy's worker. A policy in <meta> cannot
 * carry frame-ancestors, so the board's own refusal to link in a frame stays
 * its framing defence.
 */
export function staticPolicy(styleHash: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'self' 'sha256-${styleHash}'`,
    "img-src 'self'",
    'connect-src wss: ws:',
    'worker-src blob:',
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * index.html as the static build serves it: the policy and a no-referrer
 * meta first in <head>, so they govern everything after them, with the hash
 * of the page's one inline <style> computed here, so a style edit can never
 * leave a stale hash behind. It refuses a page the policy would break: a
 * second style block, a style attribute, or a script that is inline or not
 * loaded by a relative path.
 */
export function staticIndexHtml(html: string): string {
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  if (styles.length !== 1 || (html.match(/<style\b/g) ?? []).length !== 1) {
    throw new Error('index.html must hold exactly one inline <style> block');
  }
  if (/\sstyle\s*=/i.test(html)) throw new Error('index.html must hold no style attribute');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  if ((html.match(/<script\b/g) ?? []).length !== scripts.length || scripts.length === 0) {
    throw new Error('index.html must load its script with one plain <script> element');
  }
  for (const [, attributes = '', body = ''] of scripts) {
    if (body.trim() !== '' || !/\ssrc="\.\/[^"/:]+"/.test(attributes)) {
      throw new Error('index.html may load scripts only by relative paths, with no inline script');
    }
  }
  const style = styles[0]?.[1] ?? '';
  const hash = createHash('sha256').update(style, 'utf8').digest('base64');
  const charset = '<meta charset="utf-8" />';
  if (html.split(charset).length !== 2) {
    throw new Error(`index.html must open its <head> with ${charset} exactly once`);
  }
  return html.replace(
    charset,
    [
      charset,
      `    <meta http-equiv="Content-Security-Policy" content="${staticPolicy(hash)}" />`,
      '    <meta name="referrer" content="no-referrer" />',
    ].join('\n'),
  );
}

export interface DemoServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * Serves the demo on 127.0.0.1 only; port 0 picks a free port. The bundle lives
 * in memory, so several servers (parallel test workers, pnpm dev) never share files.
 */
export async function startDemoServer(
  options: { port?: number; watch?: boolean } = {},
): Promise<DemoServer> {
  let bundle = new Map<string, Uint8Array>();
  const ctx = await esbuild.context({
    ...buildOptions,
    // Only the local dev and test server may offer the ?e2e hook; see src/main.ts.
    define: { __TABDOCK_E2E_HOOK__: 'true' },
    write: false,
    plugins: [
      {
        name: 'keep-in-memory',
        setup(build) {
          build.onEnd((result) => {
            // A failed watch rebuild keeps serving the last good bundle.
            if (result.errors.length > 0 || !result.outputFiles) return;
            const next = new Map<string, Uint8Array>();
            for (const out of result.outputFiles) {
              next.set(`/${out.path.slice(distDir.length + 1)}`, out.contents);
            }
            bundle = next;
          });
        },
      },
    ],
  });
  await ctx.rebuild();
  if (options.watch) await ctx.watch();

  const server = createServer((request, response) => {
    // Any page can make the browser send odd request targets here (an <img src>
    // is enough), so parse defensively: a throw in this handler would kill pnpm dev.
    const raw = request.url ?? '/';
    const parsed =
      raw.startsWith('/') && !raw.startsWith('//') ? URL.parse(raw, 'http://localhost') : null;
    if (!parsed) {
      send(response, 400, 'text/plain; charset=utf-8', 'Bad request');
      return;
    }
    const path = parsed.pathname;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, 'text/plain; charset=utf-8', 'Method not allowed');
      return;
    }
    const bundled = bundle.get(path);
    const bundleType = BUNDLE_TYPES[path];
    if (bundled && bundleType) {
      send(response, 200, bundleType, bundled);
      return;
    }
    const entry = STATIC_FILES[path];
    if (!entry) {
      // The board links to the tour beside it, which only the Pages site holds.
      const body = path.startsWith('/tour/')
        ? 'The tour is part of the published site (pnpm site:build); in a clone, read docs/tour.'
        : 'Not found';
      send(response, 404, 'text/plain; charset=utf-8', body);
      return;
    }
    readFile(entry.file).then(
      (body) => {
        send(response, 200, entry.type, body);
      },
      () => {
        send(response, 500, 'text/plain; charset=utf-8', 'Could not read file');
      },
    );
  });

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(options.port ?? 0, '127.0.0.1', resolveListen);
    });
  } catch (error) {
    await ctx.dispose();
    throw error;
  }
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : options.port;

  return {
    url: `http://127.0.0.1:${String(port)}/`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => {
        server.close(() => {
          resolveClose();
        });
      });
      await ctx.dispose();
    },
  };
}

function send(
  response: ServerResponse,
  status: number,
  type: string,
  body: string | Uint8Array,
): void {
  response.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS });
  response.end(response.req.method === 'HEAD' ? undefined : body);
}

function loadDotEnv(): void {
  const envFile = resolve(appDir, '../../.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--build')) {
    await buildDemo();
    console.log(`Built demo into ${distDir}`);
  } else {
    loadDotEnv();
    const port = Number(process.env.DEMO_PORT ?? 5173);
    const server = await startDemoServer({ port, watch: true });
    console.log(`Demo board: ${server.url}`);
    console.log(`With MCP-B's local relay embed: ${server.url}?mcpb`);
  }
}

// Builds the map demo with esbuild and serves it on loopback (ADR 0050).
//   node scripts/server.ts               watch and serve on MAP_DEMO_PORT, 5175 unless set
//   node scripts/server.ts --port 5180   the same on another port
//   node scripts/server.ts --build       one-off static build into dist/
// apps/site imports buildMapDemo() to put the static build at /map/. The
// page has no test hook in any build, so the dev server and the static
// build run the same code, and the dev server serves the static build's own
// index.html, policy and all, so what works here works on the site.

import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { englishOnlyZod, staticIndexHtml, staticPolicy } from '@tabdock/demo/server';
import * as esbuild from 'esbuild';

const appDir = resolve(import.meta.dirname, '..');
const distDir = join(appDir, 'dist');

/** The port the CLI serves on unless --port or MAP_DEMO_PORT says. */
export const DEFAULT_MAP_DEMO_PORT = 5175;

/**
 * The static build's policy: the board's (staticPolicy, ADR 0029) with
 * worker-src 'none' in place of its blob: worker, since the map starts no
 * worker. Leaving worker-src out would not do: a worker then falls back to
 * script-src 'self', so a script already on the page could start any of the
 * site's scripts as a worker or register one as a service worker. Scripts
 * from this origin only, the one inline style by its hash, sockets to any
 * relay the visitor names, no workers, no base URL changes and no form posts.
 */
export function mapDemoPolicy(styleHash: string): string {
  const directives = staticPolicy(styleHash)
    .split('; ')
    .filter((directive) => !directive.startsWith('worker-src '));
  // Where the board names its worker, after connect-src, so the two read alike.
  const after = directives.findIndex((directive) => directive.startsWith('connect-src '));
  directives.splice(after === -1 ? directives.length : after + 1, 0, "worker-src 'none'");
  return directives.join('; ');
}

const BUNDLE_TYPES: Record<string, string> = {
  '/main.js': 'text/javascript; charset=utf-8',
  '/main.js.map': 'application/json; charset=utf-8',
};

const baseOptions = {
  entryPoints: [join(appDir, 'src/main.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'warning',
  // zod's English messages alone, which keeps the bundle well inside ADR 0050's budget.
  plugins: [englishOnlyZod],
} satisfies esbuild.BuildOptions;

/** index.html with the map's policy and the no-referrer meta first in its head. */
export async function mapDemoIndexHtml(): Promise<string> {
  return staticIndexHtml(await readFile(join(appDir, 'index.html'), 'utf8'), mapDemoPolicy);
}

/**
 * The static build for the Pages site, into dist/ or `outDir`, which it
 * empties first: exactly index.html, main.js (minified) and main.js.map. A
 * static host sends no headers of ours, so the policy rides in a meta
 * element, and a meta policy cannot carry frame-ancestors, so the page's own
 * refusal to link inside a frame (src/main.ts) stays its framing defence.
 */
export async function buildMapDemo(options: { outDir?: string } = {}): Promise<void> {
  const outDir = options.outDir ?? distDir;
  await rm(outDir, { recursive: true, force: true });
  await esbuild.build({ ...baseOptions, minify: true, outfile: join(outDir, 'main.js') });
  await writeFile(join(outDir, 'index.html'), await mapDemoIndexHtml());
}

export interface MapDemoServerOptions {
  /** 0, a free port, unless set. */
  port?: number;
  /** Rebuild when a source file changes, for pnpm dev:map-demo. */
  watch?: boolean;
}

export interface MapDemoServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * Serves the page on 127.0.0.1. The bundle lives in memory, so parallel
 * test workers never share files. It answers only its own loopback names at
 * its own port, so a site whose name someone rebinds to 127.0.0.1 cannot
 * read the page (S2), and it sends the policy as a header too, with
 * frame-ancestors, which no meta policy can carry.
 */
export async function startMapDemoServer(
  options: MapDemoServerOptions = {},
): Promise<MapDemoServer> {
  const indexHtml = await mapDemoIndexHtml();
  const hash = /'sha256-([^']+)'/.exec(indexHtml)?.[1] ?? '';
  const headers = {
    'Content-Security-Policy': `${mapDemoPolicy(hash)}; frame-ancestors 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
  const send = (
    response: ServerResponse,
    status: number,
    type: string,
    body: string | Uint8Array,
  ): void => {
    response.writeHead(status, { 'Content-Type': type, ...headers });
    response.end(response.req.method === 'HEAD' ? undefined : body);
  };

  let bundle = new Map<string, Uint8Array>();
  const ctx = await esbuild.context({
    ...baseOptions,
    outfile: join(distDir, 'main.js'),
    write: false,
    plugins: [
      ...baseOptions.plugins,
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

  const ownHost = (host: string | undefined): boolean => {
    const address = server.address();
    if (host === undefined || address === null || typeof address === 'string') return false;
    const port = String(address.port);
    return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase());
  };

  const server = createServer((request, response) => {
    if (!ownHost(request.headers.host)) {
      send(response, 421, 'text/plain; charset=utf-8', 'Misdirected request');
      return;
    }
    // Any page can make a browser send odd targets here, so parse defensively.
    const raw = request.url ?? '/';
    const parsed =
      raw.startsWith('/') && !raw.startsWith('//') ? URL.parse(raw, 'http://localhost') : null;
    if (!parsed) {
      send(response, 400, 'text/plain; charset=utf-8', 'Bad request');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, 'text/plain; charset=utf-8', 'Method not allowed');
      return;
    }
    const path = parsed.pathname;
    if (path === '/' || path === '/index.html') {
      send(response, 200, 'text/html; charset=utf-8', indexHtml);
      return;
    }
    const bundled = bundle.get(path);
    const type = BUNDLE_TYPES[path];
    if (bundled && type) {
      send(response, 200, type, bundled);
      return;
    }
    // The page links to the board, the tour and the guide beside it, which only the site holds.
    const body =
      path.startsWith('/tour/') || path.startsWith('/guide/')
        ? 'The tour and the guide are part of the published site (pnpm site:build); in a clone, read docs/.'
        : 'Not found';
    send(response, 404, 'text/plain; charset=utf-8', body);
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

export type PortChoice = { kind: 'ok'; port: number } | { kind: 'refused'; message: string };

function portNumber(text: string): number | null {
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

/** The CLI's port: --port, else MAP_DEMO_PORT, else 5175. A refusal names the setting, never its value. */
export function mapDemoPort(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): PortChoice {
  const at = args.indexOf('--port');
  if (at >= 0) {
    const port = portNumber(args[at + 1] ?? '');
    return port === null
      ? { kind: 'refused', message: '--port must be a port number from 1 to 65535' }
      : { kind: 'ok', port };
  }
  const fromEnv = env.MAP_DEMO_PORT?.trim() ?? '';
  if (fromEnv === '') return { kind: 'ok', port: DEFAULT_MAP_DEMO_PORT };
  const port = portNumber(fromEnv);
  return port === null
    ? { kind: 'refused', message: 'MAP_DEMO_PORT must be a port number from 1 to 65535' }
    : { kind: 'ok', port };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--build')) {
    await buildMapDemo();
    console.log(`Built the map demo into ${distDir}`);
  } else {
    const envFile = resolve(appDir, '../../.env');
    if (existsSync(envFile)) process.loadEnvFile(envFile);
    const choice = mapDemoPort(process.argv.slice(2), process.env);
    if (choice.kind === 'refused') {
      console.error(choice.message);
      process.exit(1);
    }
    const server = await startMapDemoServer({ port: choice.port, watch: true });
    const relayPort = portNumber(process.env.TABDOCK_PORT?.trim() ?? '') ?? 8787;
    console.log(`Map demo: ${server.url}`);
    console.log(
      `With pnpm relay running: ${server.url}?relay=ws://127.0.0.1:${String(relayPort)}/page`,
    );
    console.log('It dials only once you click its Connect bar.');
  }
}

// Builds the canvas map page with esbuild in memory and serves it on loopback.
//   node scripts/server.ts                watch and serve on MAP_PAGE_PORT, 5174 unless set
//   node scripts/server.ts --port 5180    the same on another port (scripts/ci-check.ts)
// Specs import startMapPageServer() to serve it on a free port. The page
// reads nothing from its URL, so unlike the demo it needs no test hook key.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const pageDir = resolve(import.meta.dirname, '..');
const outDir = join(pageDir, 'dist');
const indexHtml = readFileSync(join(pageDir, 'index.html'));

/** The port the CLI serves on unless --port or MAP_PAGE_PORT says. */
export const DEFAULT_MAP_PAGE_PORT = 5174;

const BUNDLE_TYPES: Record<string, string> = {
  '/main.js': 'text/javascript; charset=utf-8',
  '/main.js.map': 'application/json; charset=utf-8',
};

/** The hash of the page's one inline <style>, so the policy admits it and nothing else. */
function styleHash(html: string): string {
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  if (styles.length !== 1) throw new Error('index.html must hold exactly one inline <style> block');
  return createHash('sha256')
    .update(styles[0]?.[1] ?? '', 'utf8')
    .digest('base64');
}

/**
 * Scripts from this origin only, the one inline style by its hash, sockets
 * to any relay (the person or the test names it), and no framing, form
 * posts or base URL changes.
 */
export function mapPagePolicy(html: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'sha256-${styleHash(html)}'`,
    "img-src 'self' data:",
    'connect-src ws: wss:',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': mapPagePolicy(indexHtml.toString('utf8')),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

export interface MapPageServerOptions {
  /** 0, a free port, unless set. */
  port?: number;
  /** Rebuild when a source file changes, for pnpm dev:map. */
  watch?: boolean;
}

export interface MapPageServer {
  url: string;
  close: () => Promise<void>;
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

/**
 * Serves the page on 127.0.0.1. The bundle lives in memory, so parallel
 * test workers never share files. It answers only its own loopback names at
 * its own port, so a site whose name someone rebinds to 127.0.0.1 cannot
 * read the page (S2).
 */
export async function startMapPageServer(
  options: MapPageServerOptions = {},
): Promise<MapPageServer> {
  let bundle = new Map<string, Uint8Array>();
  const ctx = await esbuild.context({
    entryPoints: [join(pageDir, 'src/main.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: join(outDir, 'main.js'),
    sourcemap: true,
    logLevel: 'warning',
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
              next.set(`/${out.path.slice(outDir.length + 1)}`, out.contents);
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
    send(response, 404, 'text/plain; charset=utf-8', 'Not found');
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

/**
 * The CLI's port: --port, else MAP_PAGE_PORT, else 5174 (conflict C5). A
 * refusal names the setting, never the value it was given.
 */
export function mapPagePort(
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
  const fromEnv = env.MAP_PAGE_PORT?.trim() ?? '';
  if (fromEnv === '') return { kind: 'ok', port: DEFAULT_MAP_PAGE_PORT };
  const port = portNumber(fromEnv);
  return port === null
    ? { kind: 'refused', message: 'MAP_PAGE_PORT must be a port number from 1 to 65535' }
    : { kind: 'ok', port };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const envFile = resolve(pageDir, '../../.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const choice = mapPagePort(process.argv.slice(2), process.env);
  if (choice.kind === 'refused') {
    console.error(choice.message);
    process.exit(1);
  }
  const server = await startMapPageServer({ port: choice.port, watch: true });
  console.log(`Map page: ${server.url}`);
  console.log('Connect it to a relay with its Connect button; it dials nothing from its URL.');
}

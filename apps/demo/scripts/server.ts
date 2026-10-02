// Builds the demo page with esbuild and serves it on localhost.
//   node scripts/server.ts           watch and serve (pnpm dev)
//   node scripts/server.ts --build   one-off static build into dist/
// The e2e harness imports startDemoServer() to serve the page on a free port.

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
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
} satisfies esbuild.BuildOptions;

/** Static build for hosting elsewhere (GitHub Pages in M5). */
export async function buildDemo(): Promise<void> {
  await rm(distDir, { recursive: true, force: true });
  await esbuild.build(buildOptions);
  await mkdir(join(distDir, 'vendor/webmcp-local-relay'), { recursive: true });
  for (const [path, { file }] of Object.entries(STATIC_FILES)) {
    if (path !== '/') await copyFile(file, join(distDir, path));
  }
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
    write: false,
    plugins: [
      {
        name: 'keep-in-memory',
        setup(build) {
          build.onEnd((result) => {
            if (!result.outputFiles) return;
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
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
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
      send(response, 404, 'text/plain; charset=utf-8', 'Not found');
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

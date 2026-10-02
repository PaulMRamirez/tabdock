// Builds the demo page with esbuild and serves it on localhost.
//   node scripts/server.ts           watch and serve (pnpm dev)
//   node scripts/server.ts --build   one-off build into dist/
// The e2e harness imports startDemoServer() to serve the page on a free port.

import { copyFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const appDir = resolve(import.meta.dirname, '..');
const distDir = join(appDir, 'dist');

const buildOptions: esbuild.BuildOptions = {
  entryPoints: [join(appDir, 'src/main.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: join(distDir, 'main.js'),
  sourcemap: true,
  logLevel: 'warning',
};

/** Copies the static files esbuild does not produce: the HTML shell and MCP-B's relay embed. */
async function copyStatic(): Promise<void> {
  await mkdir(join(distDir, 'vendor/webmcp-local-relay'), { recursive: true });
  await copyFile(join(appDir, 'index.html'), join(distDir, 'index.html'));
  // The embed fetches widget.html from beside itself, so both must be served together.
  const relayDist = dirname(fileURLToPath(import.meta.resolve('@mcp-b/webmcp-local-relay')));
  for (const file of ['embed.js', 'widget.html']) {
    await copyFile(
      join(relayDist, 'browser', file),
      join(distDir, 'vendor/webmcp-local-relay', file),
    );
  }
}

export async function buildDemo(): Promise<void> {
  await rm(distDir, { recursive: true, force: true });
  await esbuild.build(buildOptions);
  await copyStatic();
}

export interface DemoServer {
  url: string;
  close: () => Promise<void>;
}

/** Serves the demo on 127.0.0.1 only; port 0 picks a free port. */
export async function startDemoServer(
  options: { port?: number; watch?: boolean } = {},
): Promise<DemoServer> {
  await rm(distDir, { recursive: true, force: true });
  await copyStatic();
  const ctx = await esbuild.context(buildOptions);
  if (options.watch) await ctx.watch();
  else await ctx.rebuild();
  const { hosts, port } = await ctx.serve({
    servedir: distDir,
    host: '127.0.0.1',
    port: options.port ?? 0,
  });
  return {
    url: `http://${hosts[0] ?? '127.0.0.1'}:${port}/`,
    close: () => ctx.dispose(),
  };
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

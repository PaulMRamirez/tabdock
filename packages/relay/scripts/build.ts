// Builds the published relay (ADR 0028): esbuild bundles the relay's own
// source into ESM files under dist/, every npm dependency left external,
// @tabdock/protocol included, so an install gets the dependency tree that
// npm-shrinkwrap.json pins.
//   pnpm --filter @tabdock/relay build
//
// dist/cli.js is the one bin, tabdock-relay; dist/argument-worker.js is the
// argument check's worker, which argument-checker.ts names beside cli.js in
// the bundle; dist/pair-page/ holds the /pair page's files, which pair.ts
// reads beside the code. No code splitting, so every module the bin runs sits
// in cli.js and every relative URL it builds from import.meta.url names dist/.
// TABDOCK_PACKAGED is defined true here and nowhere else (src/packaged.ts).

import { cpSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as esbuild from 'esbuild';

export const RELAY_DIR = resolve(import.meta.dirname, '..');
export const DIST_DIR = join(RELAY_DIR, 'dist');

/** The files the bundle is made of, as the package ships them under dist/. */
export const BUNDLE_FILES = ['cli.js', 'argument-worker.js'] as const;

export async function buildRelay(): Promise<esbuild.Metafile> {
  rmSync(DIST_DIR, { recursive: true, force: true });
  const result = await esbuild.build({
    entryPoints: {
      cli: join(RELAY_DIR, 'src/cli.ts'),
      'argument-worker': join(RELAY_DIR, 'src/argument-worker.ts'),
    },
    outdir: DIST_DIR,
    bundle: true,
    splitting: false,
    format: 'esm',
    platform: 'node',
    target: 'node22.18',
    packages: 'external',
    define: { TABDOCK_PACKAGED: 'true' },
    metafile: true,
    logLevel: 'warning',
  });
  cpSync(join(RELAY_DIR, 'src/pair-page'), join(DIST_DIR, 'pair-page'), { recursive: true });
  // The marker must have reached the bundle; a regression here would ship a
  // command that reads .env files and compares with a checkout it lacks.
  const cli = readFileSync(join(DIST_DIR, 'cli.js'), 'utf8');
  if (cli.includes('TABDOCK_PACKAGED')) {
    throw new Error('the relay bundle still names TABDOCK_PACKAGED; the define did not apply');
  }
  if (!cli.startsWith('#!/usr/bin/env node\n')) {
    throw new Error('the relay bundle lost its #!/usr/bin/env node line');
  }
  return result.metafile;
}

if (import.meta.main) {
  const metafile = await buildRelay();
  for (const [file, output] of Object.entries(metafile.outputs)) {
    console.log(`${file}: ${String(output.bytes)} bytes`);
  }
}

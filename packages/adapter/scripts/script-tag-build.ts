// The script-tag build's esbuild options, shared by scripts/build.ts, which
// writes dist/tabdock-adapter.js, and by the size test
// (tests/e2e/test/adapter-size.test.ts), which builds the same file in memory
// and holds it under 150,000 bytes (ADR 0028), so the size measured is the
// size shipped.

import { join, resolve, sep } from 'node:path';
import * as esbuild from 'esbuild';

export const PACKAGE_DIR = resolve(import.meta.dirname, '..');

/** Where the script-tag file goes, inside the published package's dist/. */
export const SCRIPT_TAG_FILE = join(PACKAGE_DIR, 'dist/tabdock-adapter.js');

/**
 * zod's namespace export names every message locale. On `zod/mini` (ADR 0028)
 * esbuild already drops the locales nobody reads, but keeps the index that
 * names them, about 170 bytes; under classic zod it kept them all, more than
 * half the bundle. The adapter only shows English (zod-config.ts sets it
 * where no locale is set), so the index is replaced by one exporting `en` alone.
 */
const englishOnlyZod: esbuild.Plugin = {
  name: 'zod-english-only',
  setup(build) {
    build.onResolve({ filter: /^\.\.\/locales\/index\.js$/ }, (args) =>
      args.importer.includes(`${sep}zod${sep}v4${sep}`)
        ? { path: join(args.resolveDir, '../locales/index.js'), namespace: 'zod-locales' }
        : undefined,
    );
    build.onLoad({ filter: /.*/, namespace: 'zod-locales' }, (args) => ({
      contents: "export { default as en } from './en.js';",
      resolveDir: join(args.path, '..'),
      loader: 'js',
    }));
  },
};

/** One self-contained IIFE that reads its options from data attributes and defines no globals. */
export function scriptTagOptions(): esbuild.BuildOptions & { metafile: true } {
  return {
    entryPoints: [join(PACKAGE_DIR, 'src/script-tag.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outfile: SCRIPT_TAG_FILE,
    minify: true,
    sourcemap: true,
    metafile: true,
    plugins: [englishOnlyZod],
    logLevel: 'warning',
  };
}

/** The minified script-tag file as the build writes it, built in memory; its bytes. */
export async function scriptTagBytes(): Promise<number> {
  const result = await esbuild.build({ ...scriptTagOptions(), write: false });
  const file = result.outputFiles.find((output) => output.path === SCRIPT_TAG_FILE);
  if (file === undefined) throw new Error('the script-tag build wrote no tabdock-adapter.js');
  return file.contents.byteLength;
}

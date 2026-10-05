// Builds the script-tag adapter: one self-contained IIFE at
// dist/tabdock-adapter.js that reads its options from data attributes
// (src/script-tag.ts) and defines no globals.
//   pnpm --filter @tabdock/adapter build

import { join, resolve, sep } from 'node:path';
import * as esbuild from 'esbuild';

const packageDir = resolve(import.meta.dirname, '..');

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

const result = await esbuild.build({
  entryPoints: [join(packageDir, 'src/script-tag.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: join(packageDir, 'dist/tabdock-adapter.js'),
  minify: true,
  sourcemap: true,
  metafile: true,
  plugins: [englishOnlyZod],
  logLevel: 'warning',
});

for (const [file, output] of Object.entries(result.metafile.outputs)) {
  if (file.endsWith('.js')) console.log(`${file}: ${Math.round(output.bytes / 1024)} KiB`);
}

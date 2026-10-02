// Builds the script-tag adapter: one self-contained IIFE at
// dist/tabdock-adapter.js that reads its options from data attributes
// (src/script-tag.ts) and defines no globals.
//   pnpm --filter @tabdock/adapter build

import { join, resolve, sep } from 'node:path';
import * as esbuild from 'esbuild';

const packageDir = resolve(import.meta.dirname, '..');

/**
 * zod's namespace export pulls in every message locale, more than half the
 * bundle. The adapter only shows English (zod registers it as the default on
 * its own), so the locale index is replaced by one that exports `en` alone.
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

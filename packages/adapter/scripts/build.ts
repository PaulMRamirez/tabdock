// Builds the script-tag adapter: one self-contained IIFE at
// dist/tabdock-adapter.js that reads its options from data attributes
// (src/script-tag.ts) and defines no globals. The published package ships it
// with its source map beside the library build (ADR 0028).
//   pnpm --filter @tabdock/adapter build

import * as esbuild from 'esbuild';
import { scriptTagOptions } from './script-tag-build.ts';

const result = await esbuild.build(scriptTagOptions());

for (const [file, output] of Object.entries(result.metafile.outputs)) {
  if (file.endsWith('.js')) console.log(`${file}: ${String(output.bytes)} bytes`);
}

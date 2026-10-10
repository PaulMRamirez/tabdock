// MCP-B 6.0.0 for the test leg (ADR 0047, which moved it from the beta that
// M5 decision D4 and ADR 0032 set up). The demo and the baseline stay on
// 5.1.0, while a test leg runs the adapter on 6. Both versions of
// @mcp-b/webmcp-local-relay declare the same bin, and in one package pnpm
// linked the 6 one, so `pnpm exec webmcp-local-relay` in tests/e2e, as
// MCP-B's docs write it, ran 6 without a word. Here 6 has a package of its
// own, and a test reaches it by these paths alone.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

/** The local relay's CLI, beside its main entry; its package exports do not expose it. */
export const MCPB6_LOCAL_RELAY_CLI = fileURLToPath(
  new URL('./cli.mjs', import.meta.resolve('webmcp-local-relay-6')),
);

/**
 * The polyfill's ESM entry, the file a page's `import { installWebMCP } from
 * '@mcp-b/webmcp-polyfill'` loads. From 6.0.0 importing it installs nothing:
 * the page must call installWebMCP() (ADR 0047).
 */
export const MCPB6_POLYFILL_MODULE = fileURLToPath(import.meta.resolve('webmcp-polyfill-6'));

/**
 * The polyfill's script-tag build, which still installs itself as it loads.
 * The leg never runs it, since an npm page takes the ESM entry; the leg's
 * tests use it to show which build they did not inject.
 */
export const MCPB6_POLYFILL_SCRIPT = fileURLToPath(
  new URL('./index.iife.js', import.meta.resolve('webmcp-polyfill-6')),
);

/** The ESM entry as a classic script, and the files esbuild read to make it. */
export interface Mcpb6ModuleScript {
  /** Declares `var <binding>` holding the module's exports and runs nothing else. */
  script: string;
  /** Absolute paths of every file bundled, so a test can show it is 6.0.0's entry alone. */
  inputs: string[];
}

/**
 * Wraps the ESM entry in a classic script, as a page's own bundler would,
 * because an init script that must run before the page's scripts cannot be a
 * module. esbuild keeps the code as it is (no minifying, no lowering); the
 * caller's script then calls `<binding>.installWebMCP()` itself.
 */
export function mcpb6ModuleScript(binding: string): Mcpb6ModuleScript {
  const root = dirname(MCPB6_POLYFILL_MODULE);
  const built = buildSync({
    entryPoints: [MCPB6_POLYFILL_MODULE],
    absWorkingDir: root,
    bundle: true,
    format: 'iife',
    globalName: binding,
    platform: 'browser',
    target: 'esnext',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const [output] = built.outputFiles;
  if (!output) throw new Error('esbuild wrote nothing for the MCP-B 6 polyfill');
  return {
    script: output.text,
    inputs: Object.keys(built.metafile.inputs).map((input) => resolve(root, input)),
  };
}

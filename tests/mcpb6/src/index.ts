// The MCP-B 6.0 beta (M5 decision D4, ADR 0032). The demo and the baseline
// stay on 5.1.0 until 6.x is npm's latest, while a test leg runs the adapter
// on the beta. Both versions of @mcp-b/webmcp-local-relay declare the same
// bin, and in one package pnpm linked the beta's, so `pnpm exec
// webmcp-local-relay` in tests/e2e, as MCP-B's docs write it, ran the beta
// without a word. Here the beta has a package of its own, and a test reaches
// it by these paths alone.

import { fileURLToPath } from 'node:url';

/** The beta local relay's CLI, beside its main entry; its package exports do not expose it. */
export const MCPB6_LOCAL_RELAY_CLI = fileURLToPath(
  new URL('./cli.mjs', import.meta.resolve('webmcp-local-relay-6-beta')),
);

/** The beta polyfill's script-tag build, for a page that loads it with installWebMCP(). */
export const MCPB6_POLYFILL_SCRIPT = fileURLToPath(
  new URL('./index.iife.js', import.meta.resolve('webmcp-polyfill-6-beta')),
);

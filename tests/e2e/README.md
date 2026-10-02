# @tabdock/e2e

End-to-end tests and milestone demos. `src/harness.ts` starts the demo page in Chromium, MCP-B's local relay as a stdio MCP server, and an MCP client from the official SDK.

`pnpm test:e2e` (from the root) runs the Playwright specs in `specs/`. `pnpm demo:m0` narrates one session; add `-- --headed` to watch it or `-- --screenshot` to refresh `docs/tour/img/m0-board.png`. `pnpm --filter @tabdock/e2e baseline` re-measures the WebMCP runtime into `docs/notes/baseline.raw*.json`, and `check:claude-code` runs acceptance check A0.2 with the real Claude Code CLI (it must be installed and signed in, and it spends a few model calls).

Browsers: on a laptop or in CI run `pnpm --filter @tabdock/e2e exec playwright install chromium` once. Set `CHROMIUM_EXECUTABLE` to use another Chrome, for example one with native WebMCP; the harness always passes `--enable-features=WebMCPTesting`.

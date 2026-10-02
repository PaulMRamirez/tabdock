# Tabdock

Tabdock lets MCP clients attach to a live web page. The page keeps its own tools, registered through WebMCP (`document.modelContext`); a small adapter on the page dials out to a relay; the relay is an ordinary remote MCP server with one stable URL, so Claude on any device, Claude Code or any other MCP client adds it once. Several clients and several people can attach to one page, and the person at the tab approves each of them.

Status: **M0, scaffold and baseline.** The demo page and the measurements of today's runtimes exist; the relay and adapter arrive in M1. `SPEC.md` is the source of truth and `CLAUDE.md` describes how the project is built.

## Quick start

Node 22.18 or later (it runs TypeScript files directly) and pnpm 10.

```sh
pnpm install
pnpm test        # unit tests, no browser needed
pnpm lint
pnpm typecheck
pnpm dev         # relay and demo board together; needs TABDOCK_DEV_TOKENS in .env (see .env.example)
pnpm dev:demo    # the demo board alone at http://127.0.0.1:5173/
pnpm test:e2e    # browser tests (fetches Chromium on first run)
pnpm demo:m0     # the M0 baseline through MCP-B's local relay, narrated
pnpm demo:m1     # an MCP client pairs with the demo board through the Tabdock relay, narrated
```

## Layout

`packages/protocol` (shared message schemas), `packages/relay`, `packages/adapter` and `packages/sim-page` (from M1), `apps/demo` (the demo board), `tests/e2e` (browser tests and milestone demos), and `docs/`: `tour/` explains each milestone in a few minutes of reading, `notes/` holds verified facts and measurements, `adr/` records decisions, `plans/` and `checklists/` track milestones.

## Licence

Apache-2.0; see `LICENSE` and `NOTICE`.

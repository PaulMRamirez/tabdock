# Tabdock

Tabdock lets MCP clients attach to a live web page. The page keeps its own tools, registered through WebMCP (`document.modelContext`); a small adapter on the page dials out to a relay; the relay is an ordinary remote MCP server with one stable URL, so Claude on any device, Claude Code or any other MCP client adds it once. Several clients and several people can attach to one page, and the person at the tab approves each of them.

Status: **M3, the phone.** The relay can sit behind a public https address as an OAuth resource server, so Claude on a phone signs in and attaches to a page on the laptop, by pairing code or by scanning the widget's QR code; several people with several clients still share one page, and its operator approves, switches roles, revokes and pauses from the widget. A spike flag measures latency, tool list changes and tab survival. `SPEC.md` is the source of truth and `CLAUDE.md` describes how the project is built.

## Quick start

Node 22.18 or later (it runs TypeScript files directly) and pnpm 10.

```sh
pnpm install
pnpm test        # unit tests, no browser needed
pnpm lint
pnpm typecheck
pnpm relay       # the relay alone, in local mode with no settings; prints a claude mcp add line for Claude Code
pnpm dev         # relay and demo board together, also local mode unless .env says otherwise
pnpm dev:public  # the same in public URL mode for Claude on a phone; prints the connector URL and provider settings
pnpm dev:demo    # the demo board alone at http://127.0.0.1:5173/
pnpm test:e2e    # browser tests (fetches Chromium on first run)
pnpm demo:m0     # the M0 baseline through MCP-B's local relay, narrated
pnpm demo:m1     # an MCP client pairs with the demo board through the Tabdock relay, narrated
pnpm demo:m2     # two users and three clients share the board: roles, the write queue, revoke
pnpm demo:m3     # sign-in, pairing by code and by the widget's QR code from a phone-sized browser, all local
```

Every setting is optional. With no `.env`, `pnpm relay` and `pnpm dev` run in local mode (ADR 0022): the relay binds loopback and serves MCP clients on this computer only, such as Claude Code; on first start it draws an owner token for one user, `you`, into a private `owner-token` file outside the repo (in `~/.config/tabdock` on Linux, `~/Library/Application Support/Tabdock` on macOS, `%LOCALAPPDATA%\Tabdock` on Windows, or `TABDOCK_HOME`), and it prints a `claude mcp add --scope user ... tabdock-local` line that reads the token from that file, so the token never appears on screen. Paste the line, check it with `claude mcp list` (never `claude mcp get`, which prints the token), ask Claude to pair with the code in the page's widget, and approve it on the page. Local mode trusts every account on the computer; on a shared machine, run the relay on a host with sign-in instead. To rotate the token, stop the relay, delete the file, start again and replace the Claude Code entry (`claude mcp remove --scope user tabdock-local`, then the printed line). Claude on the web, desktop or phone connects from the cloud, so it needs public URL mode, through a tunnel (`pnpm dev:public`) or on a host; `.env.example` describes every setting, and settings in `.env` win over local mode.

## Layout

`packages/protocol` (shared message schemas), `packages/relay`, `packages/adapter` and `packages/sim-page` (from M1), `apps/demo` (the demo board), `tests/e2e` (browser tests and milestone demos), and `docs/`: `tour/` explains each milestone in a few minutes of reading, `notes/` holds verified facts and measurements, `adr/` records decisions, `plans/` and `checklists/` track milestones.

## Licence

Apache-2.0; see `LICENSE` and `NOTICE`.

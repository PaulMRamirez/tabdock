# Tabdock

Tabdock lets MCP clients attach to a live web page. The page keeps its own tools, registered through WebMCP (`document.modelContext`); a small adapter on the page dials out to a relay; the relay is an ordinary remote MCP server with one stable URL, so Claude on any device, Claude Code or any other MCP client adds it once. Several clients and several people can attach to one page, and the person at the tab approves each of them.

Status: **M4, local mode, real sign-in and invites.** With no settings the relay runs in local mode for MCP clients on its own machine, such as Claude Code. With settings it runs in public URL mode behind a tunnel, or in hosted mode on any host that terminates TLS and names the client's address, from a container image and a deploy guide whose worked example is the project's reference deployment; production and local mode keep a persistent audit log that `pnpm audit:log` reads and checks. Members share a page with other signed-in accounts by watch and control invites minted in its widget, which the page honours only against its own record. `docs/threat-model.md` maps the trust boundaries, `SPEC.md` is the source of truth and `CLAUDE.md` describes how the project is built.

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
pnpm demo:m4     # local mode, then a page shared by watch and control invites, Revoke all and the audit log, all local
pnpm audit:log   # read the persistent audit log, or --verify its chain (TABDOCK_AUDIT_DIR, or audit/ beside the owner token)
```

Every setting is optional. With no `.env`, `pnpm relay` and `pnpm dev` run in local mode (ADR 0022): the relay binds loopback and serves MCP clients on this computer only, such as Claude Code; on first start it draws an owner token for one user, `you`, into a private `owner-token` file outside the repo (in `~/.config/tabdock` on Linux, `~/Library/Application Support/Tabdock` on macOS, `%LOCALAPPDATA%\Tabdock` on Windows, or `TABDOCK_HOME`), and it prints a `claude mcp add --scope user ... tabdock-local` line that reads the token from that file, so the token never appears on screen. Paste the line, check it with `claude mcp list` (never `claude mcp get`, which prints the token), ask Claude to pair with the code in the page's widget, and approve it on the page. Local mode trusts every account on the computer; on a shared machine, run the relay on a host with sign-in instead. To rotate the token, stop the relay, delete the file, start again and replace the Claude Code entry (`claude mcp remove --scope user tabdock-local`, then the printed line). Claude on the web, desktop or phone connects from the cloud, so it needs public URL mode, through a tunnel (`pnpm dev:public`) or on a host, as `docs/deploy.md` describes; `.env.example` describes every setting, and settings in `.env` win over local mode.

Invites need a public URL and `TABDOCK_INVITES=1` (ADRs 0016 and 0017). An operator then mints a link `<public URL>/i#<secret>` in the widget, shown once; whoever opens it signs in at the provider and joins by watch, or by control after the operator's approval. A guest shows by verified email when the provider puts `email` and `email_verified` in its ID token or UserInfo, for `/i`, and the namespaced claims `urn:tabdock:email` and `urn:tabdock:email_verified` in its access tokens, for `/mcp`; otherwise as an unverified account with a short id (ADR 0020).

## Layout

`packages/protocol` (shared message schemas), `packages/relay`, `packages/adapter` and `packages/sim-page` (from M1), `apps/demo` (the demo board), `tests/e2e` (browser tests and milestone demos), the relay's container image (`Dockerfile`), `deploy/fly` (the reference deployment's Fly.io settings) and `.github/workflows` (CI, the image, deploys), and `docs/`: `deploy.md` runs the relay on a host, `threat-model.md` maps its trust boundaries, `tour/` explains each milestone in a few minutes of reading, `notes/` holds verified facts and measurements, `adr/` records decisions, `plans/` and `checklists/` track milestones.

## Licence

Apache-2.0; see `LICENSE` and `NOTICE`.

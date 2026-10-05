# Developing Tabdock

Node 22.18 or later (it runs TypeScript files directly, with no build step for the relay) and pnpm 10, which Corepack installs from the root `packageManager` field (`corepack enable pnpm`). The repository is a pnpm workspace: `packages/protocol`, `packages/relay`, `packages/adapter` and `packages/sim-page`, `apps/demo`, and `tests/*`. `apps/site`, which builds the GitHub Pages site, stays outside it with its own lockfile (ADR 0029), so a clean clone's `pnpm install` never fetches mermaid and its hundred-odd packages.

## Every command

```sh
pnpm install       # the workspace, from pnpm-lock.yaml
pnpm test          # unit and integration tests (vitest), no browser needed
pnpm lint          # eslint and prettier --check
pnpm format        # prettier --write
pnpm typecheck     # tsc over the root scripts and every workspace package
pnpm build         # each package's build, where it has one
pnpm test:e2e      # browser tests (Playwright; fetches Chromium on first run)

pnpm relay         # the relay alone; local mode with no settings, printing the command for Claude Code
pnpm relay --new-token  # the same, after replacing local mode's owner token in one rename
pnpm dev           # relay and demo board together, local mode unless .env says otherwise
pnpm dev:public    # the same in public URL mode, for Claude on a phone through a tunnel
pnpm dev:demo      # the demo board alone at http://127.0.0.1:5173/
pnpm audit:log     # read the persistent audit log, or --verify its chain

pnpm demo:m0       # the M0 baseline through MCP-B's local relay, narrated
pnpm demo:m1       # an MCP client pairs with the demo board through the Tabdock relay
pnpm demo:m2       # two users and three clients share the board: roles, the write queue, revoke
pnpm demo:m3       # sign-in, pairing by code and by the widget's QR code from a phone-sized browser
pnpm demo:m4       # local mode, then a page shared by watch and control invites, and the audit log
pnpm demo:m5       # first-class page tools on both MCP revisions, and a call confirmed in the client

pnpm site:build    # the Pages site into apps/site/dist: the demo at / and docs/tour at /tour/

pnpm release:pack  # build and pack the three npm packages into dist/packages, publishing nothing
pnpm release:check # check those tarballs file by file (add --tag v0.1.0 to match a tag)
pnpm pack:install  # install those tarballs in a scratch directory and run tabdock-relay as A5.5 asks
pnpm spike:latency # the M3 spike's call timings against a running relay
pnpm spike:soak    # the M3 spike's long run with a busy page
```

The three release commands are what CI's `pack-install` job and `publish.yml` run; `docs/release.md` says how a release is made. `pnpm --filter @tabdock/e2e <script>` runs the end-to-end package's own scripts: `baseline` re-measures the M0 baseline, and the `check:claude-code` scripts drive a real Claude Code against a relay in the sandbox. One Playwright spec runs alone with `pnpm --filter @tabdock/e2e exec playwright test specs/<name>.spec.ts`; specs take free ports, so several can run at once.

## Settings

Every setting is optional and comes from a `.env` at the root, which git ignores; `.env.example` describes each one. With no `.env`, `pnpm relay` and `pnpm dev` run local mode (ADR 0022): loopback only, one user, `you`, and an owner token drawn into a private file outside the repository (`TABDOCK_HOME`, or the platform's config directory). The relay prints a command for Claude Code that reads the token from that file, so the token never reaches the screen; check the result with `claude mcp list`, never `claude mcp get`. Settings in `.env` win over local mode. `DEMO_PORT` moves the demo board.

## The demo board

The board dials only a relay its visitor chose (ADR 0029): `pnpm dev` prints a link with `?relay=` set, and the board then waits behind a `Connect to <host>` bar until you click it; without `?relay` it offers a Connect form. The bar's button takes a click only once it has held still for half a second, and names any page policy the link sets; the choice is remembered for that tab, relay URL and policy, so a reload reconnects. The Playwright specs and demo scripts open it with `?e2e`, a hook only the dev and test bundle has, which skips the click and hands the script the adapter's control handle. `apps/demo/README.md` lists the board's other parameters.

## The site

`pnpm site:build` installs `apps/site` from its own lockfile (`pnpm install --frozen-lockfile --ignore-workspace` there), typechecks it, runs its tests with `node --test`, and builds: the demo's static build at the root, with its meta policy, and each `docs/tour/*.md` rendered by `marked` as a page under `/tour/`, each Mermaid block drawn to an SVG in Playwright's Chromium with the network blocked. It needs the workspace installed (for the demo's build) and that Chromium, which `pnpm --filter @tabdock/e2e exec playwright install chromium` fetches; `CHROMIUM_EXECUTABLE` points it at another build of Chromium. The build stops if a tour page holds a script or an event handler attribute or lacks its policy, or if a diagram holds a script or names anything outside the site. Serve `apps/site/dist` with any static server to read it as Pages will. Root lint, typecheck and unit tests leave `apps/site` out, since a clean clone cannot resolve its packages; CI runs `pnpm site:build` after it installs Chromium, and `.github/workflows/pages.yml` publishes the result (`docs/deploy.md`, "The workflows").

## Conventions

TypeScript strict mode and ESM throughout; every message that crosses a boundary is checked by the zod schemas in `packages/protocol`. Comments say why, not what. `CLAUDE.md` has the rest, and `SPEC.md` is the source of truth: a change to it goes through an ADR in `docs/adr/`.

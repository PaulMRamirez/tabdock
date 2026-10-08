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
pnpm conformance   # the official MCP conformance suite's 2025-11-25 and 2026-07-28 sets against a local relay

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

pnpm site:build    # the Pages site into apps/site/dist: the demo at /, docs/tour at /tour/, docs/guide at /guide/

pnpm release:pack  # build and pack the three npm packages into dist/packages, publishing nothing
pnpm release:check # check those tarballs file by file (add --tag v0.1.0 to match a tag)
pnpm pack:install  # install those tarballs in a scratch directory and run tabdock-relay as A5.5 asks
pnpm spike:latency # the M3 spike's call timings against a running relay
pnpm spike:soak    # the M3 spike's long run with a busy page
```

`pnpm conformance` is what CI runs after the tests: it starts a relay of its own behind a loopback proxy that adds a token drawn for the run, and holds each requirement set to its checked-in baseline in `tests/e2e/conformance`. The three release commands are what CI's `pack-install` job and `publish.yml` run; `docs/release.md` says how a release is made. `pnpm --filter @tabdock/e2e <script>` runs the end-to-end package's own scripts: `baseline` re-measures the M0 baseline, and the `check:claude-code` scripts drive a real Claude Code against a relay in the sandbox. One Playwright spec runs alone with `pnpm --filter @tabdock/e2e exec playwright test specs/<name>.spec.ts`; specs take free ports, so several can run at once.

## Settings

Every setting is optional and comes from the process environment or a `.env` at the root, which git ignores; a variable already set in the environment wins over `.env`, so `TABDOCK_FIRST_CLASS_TOOLS=1 pnpm dev` works whatever `.env` says. `.env.example` describes each setting, and `docs/guide/08-relay-settings.md` lists them as tables with their modes, defaults and bounds. With neither, `pnpm relay` and `pnpm dev` run local mode (ADR 0022): loopback only, one user, `you`, and an owner token drawn into a private file outside the repository (`TABDOCK_HOME`, or the platform's config directory). The relay prints a command for Claude Code that reads the token from that file, so the token never reaches the screen; check the result with `claude mcp list`, never `claude mcp get`. Settings in `.env` win over local mode. `DEMO_PORT` moves the demo board.

## The demo board

The board dials only a relay its visitor chose (ADR 0029): `pnpm dev` prints a link with `?relay=` set, and the board then waits behind a `Connect to <host>` bar until you click it; without `?relay` it offers a Connect form. The bar's button takes a click only once it has held still for half a second, and names any page policy the link sets; the choice is remembered for that tab, relay URL and policy, so a reload reconnects. The Playwright specs and demo scripts open it with `?e2e=<key>`, a hook only a dev or test server asked for it has, under a random key of that server's own, which skips the click and hands the script the adapter's control handle; `pnpm dev` has no hook unless a script names a key in `DEMO_E2E_KEY`, so no link from another site can skip the click (ADR 0029's notes). `apps/demo/README.md` lists the board's other parameters.

## The site

`pnpm site:build` installs `apps/site` from its own lockfile (`pnpm install --frozen-lockfile --ignore-workspace` there), typechecks it, runs its tests with `node --test`, and builds: the demo's static build at the root, with its meta policy, each `docs/tour/*.md` rendered by `marked` as a page under `/tour/`, and each `docs/guide/*.md` as a page under `/guide/` (its `README.md` as the guide's index), each Mermaid block drawn to an SVG in Playwright's Chromium with the network blocked. It needs the workspace installed (for the demo's build) and that Chromium, which `pnpm --filter @tabdock/e2e exec playwright install chromium` fetches; `CHROMIUM_EXECUTABLE` points it at another build of Chromium. The build stops if a tour or guide page holds a script or an event handler attribute or lacks its policy, if a link names a tour or guide page that does not exist, or if a diagram holds a script or names anything outside the site. Serve `apps/site/dist` with any static server to read it as Pages will. Root lint, typecheck and unit tests leave `apps/site` out, since a clean clone cannot resolve its packages; CI runs `pnpm site:build` after it installs Chromium, and `.github/workflows/pages.yml` publishes the result (`docs/deploy.md`, "The workflows").

## Dependency updates

Dependabot proposes updates weekly (`.github/dependabot.yml`), and three kinds are left to a person on purpose. Node's major version is a recorded decision, not a bump: the runtime stays on Node 22 until the move to Node 24 before 30 April 2027 (`docs/plans/backlog.md`), so the image takes digest and patch updates only, and `@types/node` follows the runtime's major, never a newer one. TypeScript, `@types/node` and Playwright are shared by the workspace and the Pages site, which must hold the same versions (`tests/e2e/test/site-files.test.ts`), and no single Dependabot pull request can move both lockfiles, so Dependabot leaves them alone. Bump them in one change: `pnpm add -D --save-exact -w typescript@<version>` (or `@types/node`) and `pnpm --filter @tabdock/e2e add -D --save-exact @playwright/test@<version>` in the workspace, then `pnpm --dir apps/site add -D --save-exact` with the same package at the same version for the site (`playwright-core` for Playwright), and run `pnpm install --frozen-lockfile`, `pnpm test` and `pnpm site:build`. A TypeScript major also waits for `typescript-eslint` to support it; TypeScript 7 failed lint on 5 October 2026 because it does not yet. The site's own packages, `marked` and `mermaid`, still come from Dependabot, which updates the site's lockfile now that `apps/site/pnpm-workspace.yaml` makes the site a pnpm project of its own.

## Conventions

TypeScript strict mode and ESM throughout; every message that crosses a boundary is checked by the zod schemas in `packages/protocol`. Comments say why, not what. `CLAUDE.md` has the rest, and `SPEC.md` is the source of truth: a change to it goes through an ADR in `docs/adr/`.

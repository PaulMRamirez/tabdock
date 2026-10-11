# @tabdock/ci-check

A check you can copy into another repository: Playwright starts a Tabdock relay in local mode and the page under test, `@tabdock/adapter/testing` reads the widget's pairing code and clicks Allow as driver through the DevTools protocol as a person would, and an MCP client walks every stop of every walkthrough and every observation of a page that follows the map profile (`docs/guide/16-map-pages.md`), checking each view, clock, published state and `capture_view` picture. Guide page 17, `docs/guide/17-check-from-ci.md`, explains it; ADR 0041 decided it. It is private and never published.

In this repository `pnpm ci-check` runs it against the canvas map page in `tests/map-page`, as CI's `ci-check` job does. That runner, `scripts/ci-check.ts`, gives it a fresh `TABDOCK_HOME`, withholds output that holds the owner token or an unmasked pairing code, and then verifies the audit chain and holds its call records to the walk's page calls. `pnpm test` runs the walker's own tests, in `test/`, against a scripted page.

## Copying it

Copy this directory and change four things.

1. `connectPage()` in `src/tabdock.ts`: how your page links to a relay when its own script asks. Never give a page a way to link from its URL.
2. `CI_CHECK_PAGE_COMMAND` and `CI_CHECK_PAGE_URL`: the command that serves your page, and its address on 127.0.0.1 or localhost.
3. `CI_CHECK_RELAY_COMMAND`, which is `npx --no-install tabdock-relay` unless set, once `@tabdock/relay` is installed beside it.
4. `REQUIRE_TOOLS` in `specs/walk.spec.ts`: the clock, capture and observation tools your page registers. The walk checks those groups only where the page lists them, so naming them makes a page that stops registering one fail rather than skip its checks.

`TABDOCK_HOME` must be set to a fresh absolute directory outside every repository, which the relay keeps its owner token and audit log in; on a hosted runner, `$RUNNER_TEMP/tabdock-ci-check`, written to `$GITHUB_ENV` by a step and deleted by a last step that always runs. `TABDOCK_PORT` is 8787 unless set. Set no other relay setting: local mode's defaults are what make the check safe to run with no secret. The files import only `@playwright/test`, `@modelcontextprotocol/client`, `@tabdock/adapter/testing`, `zod` and `node:` modules; `src/profile.ts` copies the profile's result schemas, which this repository holds equal to the originals.

The walk paces itself under the relay's default rates, at most 100 page calls and 200 requests a minute. A page whose walk passes 10 minutes splits into one test per walkthrough, sharded across runners.

## The advisory walk

`pnpm ci-check --advisory` runs `specs/advisory.spec.ts` instead: headless Claude Code, given the four Tabdock tools a walk needs and nothing else, looks at each stop's picture and gives a verdict. `src/advisory.ts` holds it there: no built-in tool (`--tools ""`), no other server, none of your settings files (`--setting-sources project`) and no prompt, and the run stops the moment Claude Code's init event lists any other tool. It gates nothing, skips when `claude` is not on the PATH, and never runs in this repository's CI.

# 0041: Checking a page from CI

Status: Accepted, 10 October 2026, under the owner's standing instruction. Option B. Changes SPEC sections 4 (`tests/ci-check`, and the published `./testing` and `./devtools` entries), 8 (the helper reaches the widget only as a person does), 10 (A6.8 and A6.9) and 11 (a CI runner as a local-mode machine), though it was proposed as changing none, and adds a note to ADR 0028. Priority 4 in `docs/plans/backlog.md`; built in M6.

## Context

A walkthrough is content, and content breaks: a stop's view moves, a photo's viewpoint drifts, a layer is renamed. The developer in the target scenario wants every stop checked on every change. `docs/guide/09-use-cases.md` lists unattended agents against a public relay under "Not yet", since a public relay needs an interactive sign-in. Local mode does not: its owner token works for clients on the relay's own machine (ADR 0022), and a CI runner is one machine. The remaining steps a person takes are reading the pairing code the widget shows and answering its attach prompt, and both sit in the widget's closed shadow root, which page script and Playwright's selectors cannot reach, by design.

## Options

A. No recipe; each developer works it out.

B. A documented recipe, a published helper and an example spec. A CI job starts `tabdock-relay` in local mode, serves the page with the adapter in headless Chromium (with the WebMCP polyfill where native WebMCP is off), reads the pairing code and pairs a test client with it, then clicks Allow as driver on the widget's attach prompt as a person would, both through the DevTools protocol, as `widgetText` and `clickInWidget` in `tests/e2e/src/tabdock-harness.ts` already do; the recipe publishes them as a helper. A page under test may instead attach with `ui: false` and answer through its own handle (SPEC section 8). Then a deterministic MCP client built on the official SDK walks every walkthrough stop and asserts each result, and that the page's published state (ADR 0040) matches each stop. An optional second job runs headless Claude Code against the same relay for checks that need judgement, such as whether an overlay lines up (ADR 0039), with its API key as a CI secret.

C. A test-only setting that approves a driver without a click. Rejected: S4's approval on the page is the trust rule, and a setting that skips it would one day ship turned on.

## Decision

B. The deterministic job is the check; the model job is advisory and never the only gate. Nothing about local mode changes: it binds loopback and refuses production and a public URL. It keeps the token, and the audit log beside it, in a private per-user directory outside the workspace by design; an ephemeral hosted runner discards it with the machine, and a self-hosted runner sets `TABDOCK_HOME` to a fresh absolute directory outside every repository's work tree whose ancestors only the runner account or root can write, such as one under `RUNNER_TEMP` or the runner account's home but never under `/tmp`, which local mode refuses (ADR 0022's notes), and deletes it after the job. The example spec runs against the browser test page of ADR 0038 in this repository's own CI, so the recipe cannot rot unseen; a page in another repository copies the spec and the helper.

## Consequences

ADR 0038's map profile becomes testable: the example walks the profile's walkthrough tools, so a page that adopts the profile gets a ready check. The guide's "Not yet" entry gains a pointer: unattended checks work in local mode on one machine, still not against a public relay.

## Open questions, as proposed

Whether this repository's CI should run the Claude Code job at all, given its cost and its need for a key; the proposal is to keep only the deterministic job here. Windows runners wait on the `headersHelper` row in the backlog. How long a full walk may take before the job should split it across stops.

## Decisions

Accepted with these settings on 10 October 2026, copied from section 1 of the M6 plan. Every recommendation of the record's design not listed here was accepted as written.

1. **No Claude Code job in this repository's CI.** The advisory walk is a hand-run Playwright project.
2. **Windows:** the guide covers Linux and macOS runners. The deterministic job waits on the owner's Windows local-mode run, and only the advisory job waits on the headersHelper row.
3. **Pacing:** at most 100 page calls and 200 requests a minute. Split a walk into one test per walkthrough, sharded, once it passes 10 minutes.
4. **The helper** is `@tabdock/adapter/testing`, shipped in the adapter tarball.
5. **DevTools session type:** a structural `DevToolsSession`, so Playwright is not a dependency.
6. **Reply schemas:** DevTools replies are checked with `@tabdock/protocol/devtools` (zod/mini), a subpath export only.
7. **allowAttach:** matches by client name or request id against a new `data-client-name` attribute, and throws when more than one prompt matches.
8. **Where it reads:** only the closed shadow root of the single `tabdock-dock` host.
9. **Arming:** it clicks only an armed button that a hit test confirms, so the 500 ms wait is never skipped.
10. **Secrets:** it never prints or quotes a code. maskCode ships with it.
11. **The example** lives in the private package tests/ci-check under an import allowlist, and `scripts/ci-check.ts` runs it for this repository.
12. **webServer:** two entries, relay readiness on `/healthz`, SIGINT to stop.
13. **TABDOCK_HOME:** required and absolute, set from `$RUNNER_TEMP` through `$GITHUB_ENV`, and deleted in an `if: always()` step.
14. **Walk assertions:** angles within 1e-6 degrees and metres within a relative 1e-6, with state fields as in MapPageState (conflict C4).
15. **Unit tests** make the walker catch five kinds of drift.
16. **The e2e harness** delegates its widget clicks to the helper.
17. **The `ui: false` alternative** gets one guide paragraph and a warning.
18. **Client identity** is `tabdock-ci-check`.
19. **After the run,** the audit chain is verified and its call records counted.
20. **Release:** `./testing` and `./devtools` ship in the first release cut after M6.
21. **Guide page** 17 (conflict C9).
22. **Advisory job design:** as written.
23. **Making ci-check a required status check** is the owner's branch protection choice.
24. **How the page is connected:** through one replaceable `connectPage()` in the fixture that calls the page's connect hook, never through the URL (conflict C3).

Conflicts between the M6 records, settled by the plan, that touch this one:

- **C3, how the canvas page dials.** 0041 wanted it to attach from its URL. ADR 0038's rule wins: the page never dials from its URL. tests/ci-check's fixture connects through `page.evaluate` of the connect hook inside one exported function, `connectPage()`, which the README names as the one place a copier changes.
- **C4, one walker.** It lives in `tests/ci-check/src/walk.ts`. ADR 0038's `tests/e2e/src/map-walk.ts` is dropped. tests/e2e takes `@tabdock/ci-check` as a workspace devDependency. A test holds the copyable schemas in `tests/ci-check/src/profile.ts` equal, as JSON Schema, to `@tabdock/sim-page/map`'s.
- **C5, ports.** `tests/map-page/scripts/server.ts` takes `--port`, else MAP_PAGE_PORT, else 5174. scripts/ci-check.ts passes `--port 5180`.
- **C9, guide numbering.** The new pages are:
  - 13: The control handle (moved from page 04)
  - 14: Settings for rooms, images and state
  - 15: Limits for rooms, images and state
  - 16: Map and globe pages
  - 17: Check a page from CI
  - 18: Images and page state
  - 19: Lessons, proposals and records
  - 20: Larger rooms, members and agents

## Notes from the other M6 records (10 October 2026)

**From ADR 0038.** The page under test is `tests/map-page`, served by its own dev server, which dials only through `window.__tabdockMapPage.connect()` or a trusted click on its Connect form, never from its URL (C3).

**From ADR 0040.** The walker checks the published state at every stop and observation against `MapPageState`.

**From ADR 0044.** The use-cases page's "Not yet" paragraph is rewritten once for both records: local mode serves a CI check, and agent tokens serve an observer agent against a public relay.

**From ADR 0028.** The adapter also publishes `./testing` and the protocol `./devtools` in the first release cut after M6, while `./core` and `./qr` stay workspace-only; ADR 0028 gains a note.

**Open questions.** Settled under Decisions: no Claude Code job in this repository's CI (1), Linux and macOS runners until the owner's Windows run (2), and the pacing and split (3).

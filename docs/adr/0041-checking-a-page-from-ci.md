# 0041: Checking a page from CI

Status: Proposed, 9 October 2026. Priority 4 in `docs/plans/backlog.md`, for the target scenario in `docs/plans/map-classroom.md`. Changes nothing in SPEC as proposed: it documents a use of local mode and adds a guide page, a helper and an example spec.

## Context

A walkthrough is content, and content breaks: a stop's view moves, a photo's viewpoint drifts, a layer is renamed. The developer in the target scenario wants every stop checked on every change. `docs/guide/09-use-cases.md` lists unattended agents against a public relay under "Not yet", since a public relay needs an interactive sign-in. Local mode does not: its owner token works for clients on the relay's own machine (ADR 0022), and a CI runner is one machine. The remaining step a person takes is answering the widget's attach prompt, and the widget sits in a closed shadow root that page script and Playwright's selectors cannot reach, by design.

## Options

A. No recipe; each developer works it out.

B. A documented recipe, a published helper and an example spec. A CI job starts `tabdock-relay` in local mode, serves the page with the adapter in headless Chromium (with the WebMCP polyfill where native WebMCP is off), pairs a test client, and clicks Allow as driver on the widget's attach prompt as a person would, through the DevTools protocol, as `clickInWidget` in `tests/e2e/src/tabdock-harness.ts` already does; the recipe publishes that as a helper. A page under test may instead attach with `ui: false` and answer through its own handle (SPEC section 8). Then a deterministic MCP client built on the official SDK walks every walkthrough stop and asserts each result. An optional second job runs headless Claude Code against the same relay for checks that need judgement, such as whether an overlay lines up (ADR 0039), with its API key as a CI secret.

C. A test-only setting that approves a driver without a click. Rejected: S4's approval on the page is the trust rule, and a setting that skips it would one day ship turned on.

## Decision

B. The deterministic job is the check; the model job is advisory and never the only gate. Nothing about local mode changes: it binds loopback and refuses production and a public URL. It keeps the token, and the audit log beside it, in a private per-user directory outside the workspace by design; an ephemeral hosted runner discards it with the machine, and a self-hosted runner sets `TABDOCK_HOME` to a temporary directory outside the workspace and deletes it after the job. The example spec runs against the browser test page of ADR 0038 in this repository's own CI, so the recipe cannot rot unseen; a page in another repository copies the spec and the helper.

## Consequences

ADR 0038's map profile becomes testable: the example walks the profile's walkthrough tools, so a page that adopts the profile gets a ready check. The guide's "Not yet" entry gains a pointer: unattended checks work in local mode on one machine, still not against a public relay.

## Open questions

Whether this repository's CI should run the Claude Code job at all, given its cost and its need for a key; the proposal is to keep only the deterministic job here. Windows runners wait on the `headersHelper` row in the backlog. How long a full walk may take before the job should split it across stops.

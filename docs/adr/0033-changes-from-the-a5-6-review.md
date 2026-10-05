# 0033: Changes from the A5.6 review

Status: Accepted, 5 October 2026, under the owner's standing instruction of 4 October to take the recommended option. Changes SPEC section 4 (the demo's test hook), section 7 (page results and structured content; the first-class prefix), S9 (how many unread responses a user may have) and S10 (page text only behind its label). The detail is in the notes of the A5.6 review appended to ADRs 0025, 0026, 0028, 0029, 0030 and 0032; this record names the SPEC changes in one place, as CLAUDE.md asks.

## Context

A5.6 is M5's section 9 review by a separate agent. Six lenses, one per group of S-rules plus the supply chain, reviewed all of M5 (70e4017 to dc9a3c2); a skeptic tried to refute each finding and upheld all ten; a fixer per lens fixed each with a test that fails without it. One was high: Claude Code 2.1.289 hands its model a result's `structuredContent` in place of its text blocks, so a page result that was a JSON object, `list_page_tools` and `list_pages` reached the model with no `[tabdock: ...]` line, by `call_page_tool` and by first-class name, on both revisions. That broke S10's promise that page results are always labelled untrusted. Four of the ten fixes change SPEC wording.

## Decision

**Section 7 and S10.** Page text reaches a client only in one labelled text block, never as structured content, since a client may show its model the structured copy in place of the text. Results that hold no page text (`pair_page`, `detach_page` and an empty `list_pages`) keep their structured copy. The first-class description prefix calls a tool's results untrusted as well as its name, title, description and schema. SPEC section 7's sentence "JSON results also pass through as structured content" is replaced, and S10 gains "and page text reaches a client only behind its label, never as structured content". Defusing now treats every opening bracket and opening quote (Unicode Ps and Pi) and `<` before the word, whatever accents its letters carry, in one linear pass (ADR 0025's notes). `pnpm --filter @tabdock/e2e check:claude-code:labels` runs Claude Code against a stand-in for the Messages API on loopback and reads what its model is handed.

**S9.** A user may have at most eight `/mcp` responses with bytes waiting, an invitee two; past that the oldest is cut off and logged, and a response queued on a connection that closes ends with it (ADR 0030's notes). The 30 s stall rule stands.

**Section 4.** The demo's `?e2e` hook, which skips the Connect click for tests, is off unless a dev or test server asks for it, and then answers only `?e2e=<key>` under a random 128-bit key; such a server answers only its own loopback names. `pnpm dev` has no hook unless a script names a key in `DEMO_E2E_KEY` (ADR 0029's notes).

The other six fixes change no SPEC text: the audit reader never repeats a directory it was given (S11, ADR 0028's notes); an operator's answer counts only for the prompt it was asked about, and the adapter takes no call under the id of one of its last 1,000 prompts (S6, ADR 0026's notes); a revoke that lands while a 2025-era question is asked is seen when the answer returns (S8, ADR 0026's notes); and release-check checks what the packages pull in, `publish.yml` ties a release to a reviewed commit on `main`, and Dependabot watches the relay's pinned tree (supply chain, ADR 0028's notes).

## Consequences

S10 is stronger: no client can show its model page text without the relay's label, whatever it does with structured content. Clients that read `structuredContent` from a page result now parse the labelled text instead, as the repo's test helpers do (`packages/relay/test/helpers/results.ts`). S9 bounds what unread answers hold to about 6.5 MB a member and 2.2 MB an invitee. No section 9 requirement is weakened.

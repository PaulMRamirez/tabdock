# 0048: Script-tag ceiling for M6

Status: Accepted, 10 October 2026, under the owner's standing instruction. Changes SPEC section 8 (the script-tag build's size) and adds A6.26's size clause to section 10; A5.5 keeps the ceiling M5 was held to. Amends ADR 0028's 150,000-byte ceiling.

## Context

ADR 0028 holds the script-tag build, `dist/tabdock-adapter.js`, under 150,000 bytes, so a page that loads one file pays a known cost; `tests/e2e/test/adapter-size.test.ts` and `scripts/release-check.ts` enforce it. It measured 134,155 bytes on 6 October, leaving 15,845. Six of M6's eight ADRs add adapter code: image envelopes and their gate (0039), page state (0040), proposals and their queue (0042), sessions and their form (0043), the larger roster and agent tokens (0044) and the session record with its Markdown and download (0045). Their designs together ask for about 40,000 bytes. Squeezing one ADR late to fit the old ceiling would cost the widget's checks or its words, and moving logic to the relay is ruled out, since the adapter's checks must not come from the relay they check (ADR 0028).

## Decision

The ceiling rises from 150,000 to 200,000 bytes, minified, measured as ADR 0028 measures it. Each wave's merge records the size in `docs/plans/M6.md` against a checkpoint: at most 145,000 bytes after Wave 1, 180,000 after Wave 2 and 195,000 after Wave 3. A missed checkpoint is met by trimming CSS and strings first, never by moving a check to the relay. The session record's modules (ADR 0045) keep their own budget of 7,000 bytes, held by an esbuild metafile test, so one feature cannot spend another's share unseen. The constant in `scripts/release-check.ts` (`SCRIPT_TAG_LIMIT_BYTES`) and the size test move to 200,000 within M6, before any wave's build passes the old ceiling.

## Consequences

A page loading the script tag pays up to a third more than in 0.1.0, in exchange for M6's features with every check still on the page. The checkpoints keep growth visible wave by wave, and the remaining 5,000 bytes leave room for M6's fixes. A later milestone that needs more must raise the ceiling again by its own record.

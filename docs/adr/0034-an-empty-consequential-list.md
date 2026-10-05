# 0034: An empty consequential list

Status: Accepted, 5 October 2026, under the owner's standing instruction of 4 October to take the recommended option. Refines ADR 0002's option C. Changes SPEC section 5 (the rule stated plainly) and section 8 (the `attach()` example and a note under it).

## Context

ADR 0002 makes a tool consequential when its `consequentialHint` is true or the page names it in `policy.consequentialTools`; where the runtime drops the hint and the page names none, every tool that is not read-only counts, so S6 fails safe. The adapter read "names none" as "passed no `consequentialTools` key": `createAdapterCore` set its flag on `options.policy?.consequentialTools !== undefined`, so an explicitly empty list switched the fallback off, and the script-tag build turned `data-consequential-tools=""` into that same empty list.

README.md and SPEC section 8 both showed `consequentialTools: []` in their `attach()` example, as if it were the default. MCP-B 5.1.0, the polyfill the README names and npm's `latest`, drops the hint, as Chrome 153 does. A page set up exactly as documented therefore ran its consequential tools with no prompt on the page; its tools frame carried no `consequential` mark, so a relay never asked a client either under `confirmVia: 'client'` (ADR 0026); and the widget's notice, which tells the operator how to fix this, was suppressed. A blind reviewer and a skeptic each reproduced it in Chromium on MCP-B 5.1.0 with the real relay and adapter: a consequential tool ran unprompted.

## Options

A. Keep the empty list authoritative and only fix the docs. Every page that already copied the example stays open, silently.

B. An empty list names none: the fallback and the notice apply whenever the runtime drops the hint and the list is empty or missing. A page that really wants no prompts says so with `consequential: 'allow'`, or names the tools that are consequential, both of which state intent.

## Decision

B. `isConsequential` and `needsHintNotice` (`packages/adapter/src/tools.ts`) read the policy itself: the page names tools only when its list holds at least one, so `attach()` and the script-tag build, whose empty or comma-only `data-consequential-tools` reads as an empty list, behave alike. No flag beside the policy remains for a caller to get wrong. The README and SPEC section 8 examples name a tool (`consequentialTools: ['clear_board']`) with a note that on MCP-B 5.x and Chrome 153 the list, or else the fallback, is what marks a tool consequential. Section 5 now says "the page names none (no list, or an empty one)".

Tests: `core.test.ts` marks, prompts for and shows the notice for every write given `consequentialTools: []`, `data-consequential-tools=""` and `" , "`; `runtimes.test.ts` runs the empty list through the real relay on the polyfill 5.1 profile; and `widget.spec.ts` loads the shipped script-tag file beside the demo board on MCP-B 5.1.0 with an empty `data-consequential-tools` and checks the marks, the notice and the prompt for `clear_board`. Each fails without the fix. `many-clients.test.ts`, which used an empty list to mean "these writes are not consequential", now names the sim page's one consequential tool instead.

## Consequences

S6 fails safe for every page that names no tool, however it says so. A page that passed `[]` on a runtime that drops the hint now prompts for each write and shows the notice until it names its consequential tools or chooses `consequential: 'allow'`; on runtimes that report the hint nothing changes, since the hint still decides there. The `consequential` mark in the tools frame follows the same rule, so the relay asks a client for those writes on a page that opted in. No section 9 requirement is weakened.

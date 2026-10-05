# 0012: Contract clarifications from the M2 review

Status: Accepted by the owner with option A, 3 October 2026. Changes SPEC sections 5 and 6.

## Context

Fixing the M2 review findings (ADR 0009's and ADR 0001's notes) left two places where the code does something SPEC does not say. Section 6 lists the close codes the relay uses (ADR 0007), and the new page limits need two more cases. Section 5 says mutating calls run one at a time per page, and on the MCP-B polyfill there is one case where the page cannot know when a write has really ended.

## Decision

**Close codes (section 6).** The relay closes a new page's socket with 1013 (Try Again Later, the standard code for a temporary lack of capacity) when it cannot make room for the session; the adapter treats it like any other recoverable close and reconnects with backoff. A page that sends more than 10 `tools` frames in 10 s, or whose address sends more than 30 across its sockets, is closed with 1008, the policy-violation code section 6 already uses for malformed frames, and sleeps for its resume window like any other non-detach close.

**One write at a time (section 5).** The page holds its write slot until a write's handler ends, also when the call was already answered (a cancel, its deadline, a revoke). The one exception: on the MCP-B polyfill, if the page unregisters a tool while that tool's write is running, the polyfill stops reporting on the handler, which may still run. The page then holds later writes until that call's deadline plus 2 s and lets the next one go, possibly beside the old handler, logging that it did. Two options:

A. Accept that bounded hold and add the exception to section 5. Recommended, and chosen: a single-page app that swaps its tools per view would otherwise lock every later write until a reload, and the case needs both the polyfill and a page that removes a tool its own write is using.

B. Hold until the operator reloads the page, so writes never overlap, at the cost of a stuck page in that case.

## Consequences

With A, section 6 gains 1013 and the second use of 1008, and section 5 gains one sentence naming the polyfill exception. Nothing changes for a page within its limits or on native WebMCP.

## Notes after the M5 research (5 October 2026)

On MCP-B 6 this hold cannot arise: 6 sets no marker and no longer rejects a call whose tool the page unregisters mid-run, so the adapter treats it as native (ADR 0001's notes, ADR 0031). The exception stays for 5.x pages.

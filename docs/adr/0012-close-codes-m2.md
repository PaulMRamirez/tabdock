# 0012: Two more close codes from the M2 limits

Status: Proposed, 3 October 2026. Changes SPEC section 6 if accepted.

## Context

SPEC section 6 lists the close codes the relay uses (ADR 0007): 4001 for a superseded socket, and 1001, 1008 and 1009 for idle or shutdown, malformed frames and oversized frames. The page-session limits fixed after the M2 review (ADR 0009's notes) need two more cases: a new page arriving when there is no room for it and no asleep page that may make way, and a page that sends `tools` frames faster than its budget.

## Decision

The relay closes a new page's socket with 1013 (Try Again Later, the standard code for a temporary lack of capacity) when it cannot make room for the session; the adapter treats it like any other recoverable close and reconnects with its usual backoff. A page that sends more than 10 `tools` frames in 10 s, or whose address sends more than 30 across its sockets, is closed with 1008, the policy-violation code section 6 already uses for malformed frames, and sleeps for its resume window like any other non-detach close.

## Consequences

Section 6's close-code sentence gains 1013 and the second use of 1008. Nothing changes for a page within its limits.

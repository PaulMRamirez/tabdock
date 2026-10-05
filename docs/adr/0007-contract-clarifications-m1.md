# 0007: Contract clarifications from M1

Status: Accepted by the owner with option A, 2 October 2026. Changes SPEC sections 5, 6 and 7.

## Context

Building and reviewing M1 turned up five places where the spec is silent or loose and the code had to choose. None changes a design decision; each needs to be written down so the spec stays the source of truth.

## Decision

**Close codes and two optional fields (section 6).** Only a deliberate detach ends a session at once: a page that calls `dock.close()` closes with 4000 (`CLOSE_DETACH`), the page becomes gone without the resume window, and its in-flight calls fail with `page_gone`, except calls still waiting on an operator prompt, which the page denies first (`denied_by_operator`, as S6 says). Every other close leaves the page asleep for the resume window, including 4002 (`CLOSE_SILENT`, the page heard nothing from the relay and is reconnecting) and 4008 (the page's stand-in for 1008, since page code cannot send 1008). The relay closes a superseded socket with 4001 (`CLOSE_REPLACED`), which the page must not reconnect from, and uses 1001, 1008 and 1009 for idle or shutdown, malformed frames and oversized frames. The `welcome` frame carries `resumed` (whether the resume token was honoured) and `cancel` may carry `reason` (`timeout`, `revoked`, `client` or `shutdown`).

**Silence on an attach request (section 5).** An unanswered request is a denial, as section 5 says; `pair_page` reports it as `timeout` rather than `denied_by_operator`, because the operator never decided. An unanswered consequential-call prompt is reported as `denied_by_operator`, as S6 says.

**One attach request per user (section 5).** A user has at most one pending attach request per page: a second `pair_page` from the same user while one is pending (a retry after the 50 s wait, or a second device) waits on the first instead of prompting the operator again. The first approval sets the user's role; later approvals and denials for an attached user change nothing, because role changes and withdrawals go through `set_role` and `revoke` (M2's roster controls). The adapter keeps its own record of these grants and runs a call only under the least privileged of that record, the relay's roster and the role the invoke claims; a user missing from the roster has no role.

**Pages that declare no hints (section 5, ADR 0002).** ADR 0002's fail-safe applies when the runtime drops `consequentialHint`, which shows as tools that carry annotations but never that key. When no tool carries annotations at all, the page declared no hints, so none were lost: only `policy.consequentialTools` applies.

**Argument errors (section 7).** Arguments the relay will not forward (too large for the 1 MB frame now, failing the tool's `inputSchema` from M2) need an error the client can recognise. Two options:

A. Add `invalid_arguments` to the section 7 codes, so these errors read `invalid_arguments: ...` like every other Tabdock error. Recommended, and chosen: clients and tests match on the leading code, and the audit already records the outcome under that name.

B. Use the MCP SDK's own `Input validation error: ...` wording, which is what a client gets when it calls a fixed tool with bad parameters, and keep the section 7 list unchanged.

## Consequences

The spec matches the wire and the error texts clients actually see. Section 7 gains `invalid_arguments`, which the relay already returns for arguments too large for one frame, and M2's argument validation reuses it.

## Notes from ADR 0026 (5 October 2026)

A consequential call whose confirmation in the caller's client is declined, dismissed, expired, reused or mismatched answers `not_confirmed`, not `denied_by_operator`, since the operator never saw it; an unanswered on-page prompt still answers `denied_by_operator`.

# 0040: Page state clients can follow

Status: Proposed, 9 October 2026. Priority 3 in `docs/plans/backlog.md`, for the target scenario in `docs/plans/map-classroom.md`. Would change SPEC sections 2 (the tool surface), 6 (a state frame), 7 (two fixed tools), 8 (an adapter call), 9 (S9) and 10 (A5.1's "only the five fixed tools"), and ADR 0016's wording on the five fixed tools.

## Context

Clients only ask; nothing tells them when a page changes. The one push the relay sends is `list_changed`, for tool lists (ADR 0032), and it declares no resources capability (ADR 0027's notes). In the target scenario a room follows the teacher's tab. Today a client learns the stop, the clock and the photo on screen only by calling page tools, which runs the page's handlers and spends its call budget (by default 120 calls a minute per user per page, `TABDOCK_MAX_CALLS_PER_MINUTE`, and for an invitee 60 requests a minute in all), and it still never knows when to look.

## Options

A. Status quo: clients call a read-only tool such as `get_view`.

B. Published state. The adapter gains a call, provisionally `publishState(value)`, with which the page sets a small JSON snapshot of what matters now (for a map page: view, clock, walkthrough stop, open observation). The adapter sends it in a new `state` frame, coalesced to at most two a second. The relay enforces the size cap and the rate itself, with a budget per socket and per address like the `tools` frame budget, closing with 1008 past it, and the values it holds count against a relay-wide byte budget (S9). It keeps the latest value per page with a version number. Two new fixed tools read it: `get_page_state(page)` returns the version and the value, and `wait_for_page_state(page, after, timeoutMs)` returns as soon as the version passes `after`, or at the timeout, which stays under the call deadline. Every attached role may read it, invitees included, since it is read-only.

C. MCP resources. The state is a resource that clients subscribe to. This is the protocol's own answer, but it needs the resources capability and new conformance baselines, and hosted Claude supports no resource subscriptions (SPEC section 3), so C serves only other clients.

## Decision

B now; C as a follow-up for clients that act on resource updates. The value is page text: it reaches clients only behind the untrusted label (S10) and never holds an image (`capture_view` does that, ADR 0039). A state frame equal to the last one is a frame that changes nothing and spends that budget (ADR 0023). A waiting `wait_for_page_state` is a waiting call and holds its request charge (ADR 0018); a user may hold at most two at once and a page a bounded number, so a room cannot pin the relay with idle waits.

Aligned backlog row: whether the adapter's Web Lock keeps a background tab from being frozen (2 October, for M3, still unmeasured). A room following a tab stalls if that tab is frozen, so measure it before a class relies on this.

## Consequences

The fixed tools go from five to seven, eight with ADR 0042, which changes SPEC section 2's tool surface row, A5.1's "only the five fixed tools", ADR 0016's wording, ADR 0025's first-class listing, the fixed tools' golden test on both eras and the guide. A chat client reads state only within a turn: when someone asks, one `get_page_state` answers "what are we looking at" without touching the page. `wait_for_page_state` serves agents that loop, such as CI or Claude Code. ADR 0038's profile names the fields a map page should publish, so every map page publishes the same shape.

## Open questions

The tool names, and whether `wait_for_page_state` should return the value or only the new version. The size cap (perhaps 16 KiB) and the per-page and per-user wait limits. Whether a short history of recent states is worth keeping, or only the latest.

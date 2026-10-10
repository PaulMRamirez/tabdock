# 0040: Page state clients can follow

Status: Accepted, 10 October 2026, under the owner's standing instruction. Option B now; option C, MCP resources, is a later backlog row. Changes SPEC sections 2 (the tool surface), 4 (the demo publishes its view), 5 (the page session's published state), 6 (the `state` frame, the welcome's `maxStateBytes` and two close codes), 7 (two fixed tools), 8 (`publishState` and the `tabdock:state` event), 9 (S8, S9 and S10) and 10 (A5.1's "only the fixed tools", and A6.6 and A6.7), and adds notes to ADRs 0016 and 0025. Priority 3 in `docs/plans/backlog.md`; built in M6.

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

## Open questions, as proposed

The tool names, and whether `wait_for_page_state` should return the value or only the new version. The size cap (perhaps 16 KiB) and the per-page and per-user wait limits. Whether a short history of recent states is worth keeping, or only the latest.

## Decisions

Accepted with these settings on 10 October 2026, copied from section 1 of the M6 plan. Every recommendation of the record's design not listed here was accepted as written.

1. **Tool names:** get_page_state and wait_for_page_state. The snapshot field is named `value`, never `state`.
2. **Wait result:** a wait returns the whole body plus `changed`.
3. **Size:** MAX_STATE_BYTES is 16,384 bytes of canonical JSON, and MAX_STATE_FRAME_BYTES is 16,448.
4. **Shape:** the value is a JSON object or null.
5. **History:** only the latest value is kept.
6. **Per-user waits:** MAX_WAITS_PER_USER is 2, counted across every page and across both wait_for_page_state and get_proposal (conflict C2).
7. **Per-page waits:** usersPerPage + observersPerPage, with invitees together holding at most that less MEMBER_RESERVED_SEATS (conflict C2). There is no STATE_WAITS_PER_PAGE setting.
8. **timeoutMs:** a whole number from 0 to MAX_WAIT_MS (40,000), default DEFAULT_STATE_WAIT_MS (25,000), and also clamped to callDeadlineMs. An `after` ahead of the version answers at once.
9. **Coalescing:** leading plus trailing at STATE_MIN_INTERVAL_MS (500). An equal value is never resent.
10. **Frame budgets:** 40 state frames per socket and 200 per address in a 10 s window, closing with 1008.
11. **Equal frames:** they spend the state budget and are then counted by ADR 0023's frames that change nothing.
12. **Over the cap:** the relay closes with 1009, first on the raw frame and then on the canonical text. A shape failure or a re-encode that throws closes with 1008.
13. **Relay-wide budget:** separate, TABDOCK_MAX_STATE_BYTES, default 4 MiB, at least 1 MiB. Past it the relay withholds the value and leaves the socket open.
14. **Versions:** counted per page session. Sleep, or a resume that replaces a socket, drops a held value and raises the version.
15. **Reads while asleep or resuming** answer page_asleep. The adapter sends state before its tools frame.
16. **Waits** hold their request charge through `#holdBytes`, refusing with rate_limited.
17. **Audit:** request_refused only.
18. **Reads never move idle expiry.**
19. **Pause holds state:** the adapter publishes null while paused.
20. **Script-tag pages** publish with a `tabdock:state` CustomEvent on document.
21. **publishState** never throws and returns `{ ok }` or a reason.
22. **The welcome's maxStateBytes** gates whether the adapter sends state.
23. **Never structuredContent.**
24. **heardAt** is the time of the last frame of any kind from the page's socket.
25. **Golden fixtures:** no frozen M4 fixture (conflict C1).
26. **Fixed tool order:** M4's five, get_page_state, wait_for_page_state, get_proposal, withdraw_proposal.
27. **State reads** stay out of the activity log and out of the session record.
28. **MCP resources** are deferred, and the backlog gets a row.
29. **A5.1** reads "only the fixed tools of section 7".
30. **Frozen tab:** recovery is tested in the sandbox, and Energy Saver behaviour is the owner's run.

Conflicts between the M6 records, settled by the plan, that touch this one:

- **C1, the fixed tool list.** There are nine fixed tools, in the order above. The frozen `fixed-tools-m4.golden.json` idea is dropped, because ADRs 0042 and 0043 must change three M4 descriptions; detach_page's current text is wrong under ADR 0017. Instead, fixed-tools-golden.test.ts also asserts structurally that the first five names, positions, input schemas and annotations are M4's. The description changes are recorded in the fixture's `_comment`. INSTRUCTIONS are unchanged, so the initialize and server/discover captures keep their answers.
- **C2, wait limits.** There is one module, `packages/relay/src/waits.ts`:
  - **Per user:** MAX_WAITS_PER_USER = 2, shared by both waiting tools.
  - **Per page:** usersPerPage + observersPerPage.
  - **Invitees on a page:** that number less MEMBER_RESERVED_SEATS.
  - **Charge:** each wait still holds its request charge.
- **C25:** ADR 0040's stateWaitsPerPage setting is removed (see C2).
- **C28:** agents may hold waits.

## Notes from the other M6 records (10 October 2026)

**From ADR 0038.** A map page publishes `MapPageState` (ADR 0038's notes).

**From ADR 0041.** A wait returns the version and the value, the whole body plus `changed` (decision 2), which is what a walker checks at each stop.

**From ADR 0042.** The Consequences' "seven, eight with ADR 0042" now reads nine: ADR 0042 adds `get_proposal` and `withdraw_proposal`, and a user's two waits are shared with `get_proposal` (C2).

**From ADR 0044.** A page's waits are bounded by `usersPerPage` plus `observersPerPage`, invitees by that less two, and agents may hold waits (C2, C28).

**Open questions.** Settled under Decisions: the names (1), the wait's answer (2), the size (3), the limits (6, 7) and latest value only (5).

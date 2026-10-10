# 0042: Proposals from observers

Status: Accepted, 10 October 2026, under the owner's standing instruction. Option B, with acceptance on the page only. Changes SPEC sections 2 (the tool surface), 5 (what an observer may do, the queue and the consequential rule), 6 (proposal frames and the invoke's `proposal`), 7 (two fixed tools, `proposed` and `proposal_not_found`), 8 (the widget's queue and the adapter's acceptance record), 9 (S5, S6, S7, S9 and S13), 10 (A5.1, and A6.10 to A6.13) and 12 (fairness), and ADR 0016's wording on the fixed tools. Priority 5 in `docs/plans/backlog.md`; built in M6.

## Context

An observer who calls a write tool gets `role_denied` (section 5). That is right for safety and wrong for a room. A student wants the next photo, a reviewer wants a caption fixed, and today each must either ask out loud or be made a driver. Driver seats count people and default to one (`maxDrivers`), so handing them out is the operator giving up control of their own tab. What the room needs is a way to suggest a write that runs only when the operator says so.

## Options

A. Status quo: promote people to driver when they need to act.

B. Proposals. A page opts in with `policy.proposals`: `off` (the default), `members` or `all` (invitees too). On such a page an observer's call to a write tool does not run. The relay sends the adapter a proposal, never an invoke, and answers the caller at once with a new answer, `proposed`, carrying a proposal id. The widget lists pending proposals: who, which tool, the arguments cut and marked as written by the caller. The operator accepts or dismisses each on the page, and an accepted proposal enters the page's write queue. The caller learns the outcome through a new fixed tool, `get_proposal(page, id)`, which returns pending, accepted with the result, dismissed or expired, and can withdraw a pending one.

C. As B, but drivers may also accept from their own clients. Deferred: an agent accepting another agent's proposal takes the person out of the loop this record exists to keep.

## Decision

B, with acceptance on the page only. S5 gains one clause: an observer's write runs only as a proposal the operator accepted on the page, and the adapter runs it only against its own record of that acceptance, never on a relay frame alone. Under `consequential: 'deny'` a proposal for a consequential tool is refused at once; otherwise the acceptance, which arms after 500 ms like every widget control that grants access (prompts, roster rows, the pause control and the Invite form; SPEC section 8), is that call's S6 confirmation. The operator is whoever is at the tab and has no identity in Tabdock, so S7's audit record names the proposer and marks the call accepted on the page (`acceptedOnPage: true`, with the proposal id). `get_proposal` answers only the proposer: a proposal id is a name, never a capability (S13), which is how 2026-07-28's tools page describes such handles.

A proposal lives at most 10 minutes; a user may hold at most 3 pending per page and a page at most 20, and a proposal past either limit answers `rate_limited`. Proposals are shown to the operator only, never to other attached people. Holding the call open until the operator decides was rejected: calls end at the 45 s deadline, and the relay offers no task-augmented calls (ADR 0027).

Aligned open item: SPEC section 12's per-user fairness rule for the write queue. Accepted proposals enter the queue in the order the operator accepts them, so the operator is the fairness rule here; the open item still matters once several drivers share a session (ADR 0043).

## Consequences

The classroom loop works without driver seats: people suggest, the teacher picks. The fixed tools grow by one beside ADR 0040's two, with the same effects on SPEC section 2, A5.1, ADR 0016's wording, first-class listings, the golden test and the guide. The widget gains a queue, which on a phone-sized operator screen needs care. Invitees can propose only where the page chose `all`.

## Open questions, as proposed

Whether a dismissal may carry a short reason back to the proposer. Whether the operator may accept several at once. Whether `get_proposal` should also wait, as ADR 0040's `wait_for_page_state` does, so a looping agent need not poll.

## Decisions

Accepted with these settings on 10 October 2026, copied from section 1 of the M6 plan. Every recommendation of the record's design not listed here was accepted as written.

1. **Two tools:** get_proposal (read-only) and withdraw_proposal (not read-only, idempotent).
2. **No dismissal reason** in M6.
3. **No bulk accept.** Dismiss all is unarmed.
4. **get_proposal waitMs** runs from 0 to MAX_WAIT_MS with a default of 0, and shares MAX_WAITS_PER_USER.
5. **Who runs an accepted proposal:** the relay puts it in the write queue in acceptance order. The adapter runs it only against its own single-use record matching caller, tool and canonical arguments, within ACCEPTED_PROPOSAL_RUN_MS (60,000).
6. **Seven statuses:** pending, accepted, dismissed, refused, expired, withdrawn and cancelled.
7. **New error code `proposal_not_found`,** worded the same for an unknown id and for another user's.
8. **'members'** means the account kind.
9. **Argument caps:** 16,384 bytes and 1,000 nodes.
10. **Outcomes:** kept 10 minutes, at most 40 per page, with results cut to 20,000 characters.
11. **No relay switch** for proposals.
12. **Proposals end with the link.**
13. **No accept while paused.**
14. **`proposable: true`** in list_page_tools.
15. **Images of accepted runs** are not kept.
16. **Audit:** a call line with outcome 'proposed', a run line with acceptedOnPage, and proposal_closed.
17. **Dock methods** rather than a UiPort hook.
18. **No invoke carries both** a confirmation and a proposal.
19. **PROPOSAL_TTL_MS** is a protocol constant, with a test-only timing knob.
20. **Fairness** is acceptance order.
21. **Nine fixed tools.**
22. **The session form** offers off, members and all within the ceiling.
23. **CallShape** changes once, in the foundation.
24. **Agent tokens never propose** (conflict C13).
25. **INSTRUCTIONS stay unchanged.** call_page_tool's description carries the proposal sentence (conflict C1).

Conflicts between the M6 records, settled by the plan, that touch this one:

- **C1, the fixed tool list.** There are nine fixed tools, in the order above. The frozen `fixed-tools-m4.golden.json` idea is dropped, because ADRs 0042 and 0043 must change three M4 descriptions; detach_page's current text is wrong under ADR 0017. Instead, fixed-tools-golden.test.ts also asserts structurally that the first five names, positions, input schemas and annotations are M4's. The description changes are recorded in the fixture's `_comment`. INSTRUCTIONS are unchanged, so the initialize and server/discover captures keep their answers.
- **C2, wait limits.** There is one module, `packages/relay/src/waits.ts`:
  - **Per user:** MAX_WAITS_PER_USER = 2, shared by both waiting tools.
  - **Per page:** usersPerPage + observersPerPage.
  - **Invitees on a page:** that number less MEMBER_RESERVED_SEATS.
  - **Charge:** each wait still holds its request charge.
- **C13:** ADR 0042's `#propose` and the adapter's `onProposal` refuse agent callers with role_denied.
- **C18:** every M6 change to CallShape and callRule lands in one foundation commit.
- **C21, Revoke on a sponsor's row.** It asks first whenever anyone that member's invites let in is still attached, not only during a session, and so does Revoke all. The roster workstream owns this.
- **C22, the panel order:**
  1. error line, notice line, joins
  2. prompts, then the record offer
  3. proposals, pairing
  4. roster (People, then Watching by invite), session block
  5. invites (with the agent kind and list)
  6. activity, record block, state line, pause box
- **C27:** detach_page's description now says that attachments your invites let in end with yours.

## Notes from the other M6 records (10 October 2026)

**From ADR 0040.** The fixed tools are nine, in this order: M4's five, `get_page_state`, `wait_for_page_state`, `get_proposal` and `withdraw_proposal` (C1).

**From ADR 0043.** A session may narrow `proposals` within the ceiling `attach()` sets: off, members or all, never wider.

**From ADR 0044.** Agents never propose: the relay's `#propose` and the adapter refuse an agent caller with `role_denied` (C13).

**From ADR 0045.** The arguments a proposal shows in the widget's queue never enter the session record; the record copies only the proposal's id, proposer, tool, times, outcome and `callId`.

**From ADR 0039.** An accepted run's image is not kept, and `get_proposal` returns its text only.

**Open questions.** Settled under Decisions: no dismissal reason (2), no bulk accept (3), and `get_proposal` waits with `waitMs` (4).

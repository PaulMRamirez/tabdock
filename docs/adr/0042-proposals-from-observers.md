# 0042: Proposals from observers

Status: Proposed, 9 October 2026. Priority 5 in `docs/plans/backlog.md`, for the target scenario in `docs/plans/map-classroom.md`. Would change SPEC sections 2 (the tool surface), 5 (what an observer may do), 6 (proposal frames), 7 (a fixed tool and an answer), 8 (the widget), 9 (S5, S6, S7 and S9) and 10 (A5.1's "only the five fixed tools").

## Context

An observer who calls a write tool gets `role_denied` (section 5). That is right for safety and wrong for a room. A student wants the next photo, a reviewer wants a caption fixed, and today each must either ask out loud or be made a driver. Driver seats count people and default to one (`maxDrivers`), so handing them out is the operator giving up control of their own tab. What the room needs is a way to suggest a write that runs only when the operator says so.

## Options

A. Status quo: promote people to driver when they need to act.

B. Proposals. A page opts in with `policy.proposals`: `off` (the default), `members` or `all` (invitees too). On such a page an observer's call to a write tool does not run. The relay sends the adapter a proposal, never an invoke, and answers the caller at once with a new answer, `proposed`, carrying a proposal id. The widget lists pending proposals: who, which tool, the arguments cut and marked as written by the caller. The operator accepts or dismisses each on the page, and an accepted proposal enters the page's write queue. The caller learns the outcome through a new fixed tool, `get_proposal(page, id)`, which returns pending, accepted with the result, dismissed or expired, and can withdraw a pending one.

C. As B, but drivers may also accept from their own clients. Deferred: an agent accepting another agent's proposal takes the person out of the loop this record exists to keep.

## Decision

B, with acceptance on the page only. S5 gains one clause: an observer's write runs only as a proposal the operator accepted on the page, and the adapter runs it only against its own record of that acceptance, never on a relay frame alone. Under `consequential: 'deny'` a proposal for a consequential tool is refused at once; otherwise the acceptance, which arms after 500 ms like every click in the widget, is that call's S6 confirmation. The operator is whoever is at the tab and has no identity in Tabdock, so S7's audit record names the proposer and marks the call accepted on the page (`acceptedOnPage: true`, with the proposal id). `get_proposal` answers only the proposer: a proposal id is a name, never a capability (S13), which is how 2026-07-28's tools page describes such handles.

A proposal lives at most 10 minutes; a user may hold at most 3 pending per page and a page at most 20, and a proposal past either limit answers `rate_limited`. Proposals are shown to the operator only, never to other attached people. Holding the call open until the operator decides was rejected: calls end at the 45 s deadline, and the relay offers no task-augmented calls (ADR 0027).

Aligned open item: SPEC section 12's per-user fairness rule for the write queue. Accepted proposals enter the queue in the order the operator accepts them, so the operator is the fairness rule here; the open item still matters once several drivers share a session (ADR 0043).

## Consequences

The classroom loop works without driver seats: people suggest, the teacher picks. The fixed tools grow by one beside ADR 0040's two, with the same effects on SPEC section 2, A5.1, first-class listings and the golden test. The widget gains a queue, which on a phone-sized operator screen needs care. Invitees can propose only where the page chose `all`.

## Open questions

Whether a dismissal may carry a short reason back to the proposer. Whether the operator may accept several at once. Whether `get_proposal` should also wait, as ADR 0040's `wait_for_page_state` does, so a looping agent need not poll.

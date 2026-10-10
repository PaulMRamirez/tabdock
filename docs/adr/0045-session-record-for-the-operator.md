# 0045: A session record for the operator

Status: Accepted, 10 October 2026, under the owner's standing instruction. Option B. Changes SPEC sections 8 (the record and its save), 9 (S7's `callId`) and 10 (A6.25); no relay server change beyond the audit `call` record's `callId`, while the audit reader in the relay package gains `--call` and `--match`. Adds a note to ADR 0019. Priority 8 in `docs/plans/backlog.md`; built in M6.

## Context

After a review or a lesson the operator wants one record of what happened on their page: who joined and as what, what was called, what was proposed and accepted (ADR 0042), what was confirmed and where. The relay's audit log (ADR 0019) holds most of it, hash-chained, but is read on the host with `tabdock-relay audit`. The backlog's HTTP route for reading it (3 October row) shows each member only their own calls, because a page-wide view would show other users' activity after their attachments end (S13). The adapter, meanwhile, already sees every call its page runs; its activity list records who called which tool and how it ended, never the arguments or the result, and keeps the last 50.

## Options

A. A relay route that returns a page's whole session. It runs into S13, and puts other people's records behind a URL.

B. An export from the widget. The adapter builds the record from its own activity for the current page session, or for one session (ADR 0043), and the operator downloads it as JSON with a short Markdown summary. It holds attachments (name as the widget shows it, member or invitee, role, joined, left) and calls (time, caller, tool, outcome, `confirmedBy`, proposal ids, `callId`); never arguments, results or images, as the activity list keeps none. It stays in the operator's browser until they save it.

C. Both A and B.

## Decision

B, keeping the backlog's per-user route as it is for members' own calls. Each call in the export carries its `callId`, which the audit `call` record gains, so the export can be checked against the hash-chained log on the host when it matters.

## Consequences

A review ends with a file someone can attach to a ticket, and a lesson with a list the teacher can keep or delete. The adapter keeps more than today: every call and attachment of the session rather than the last 50, in memory only, capped, and dropped when the session ends or the tab closes. The export holds other people's names and, for invitees, account emails; the widget says so before the download, and the threat model gains a row for a record leaving the page.

## Open questions, as proposed

The in-memory cap for a long session. Whether a session should offer the export automatically at its end. Whether the Markdown summary should group calls by person or by time.

## Decisions

Accepted with these settings on 10 October 2026, copied from section 1 of the M6 plan. Every recommendation of the record's design not listed here was accepted as written.

1. **Caps:** 5,000 calls, 500 spans, 1,000 proposals, 16 page ids and 16 role changes per span. Dropped calls are counted.
2. **Slots:** at most three records, named current, previous and ended.
3. **Session end:** the widget offers the record and never saves it unasked. The sealed record is kept until replaced.
4. **The Markdown summary** groups by person, with two capped lists in time order.
5. **Page-scope records** follow page sessions. A session record spans page sessions.
6. **Starting a session** seals the page record.
7. **Saving:** two files from two buttons, with built-ins taken at mount.
8. **People** are named with short ids: `g_` plus 8 hex characters.
9. **callId** is present only when the invoke went out to the page.
10. **AUDIT_VERSION** stays 1 while 0.1.0 is unpublished, and becomes 2 with a reader for both if 0.1.0 publishes first.
11. **Matching:** `audit --match` in audit-match.ts, plus `--call`.
12. **The adapter API** is as designed.
13. **Memory only.**
14. **No off switch.**
15. **No signature.**
16. **Which calls:** those the adapter accepted, never the fixed tools.
17. **`confirmedBy`** is 'page', 'client' or null.
18. **Times** are on the page's clock.
19. **Schema-checked** before it is saved.
20. **The guide advises** telling the room that a record is kept.
21. **Page details** are recorded.
22. **A recorder fault** stops the record and never changes a call.
23. **Budget:** at most 7,000 bytes, checked by an esbuild metafile test.
24. **"No relay change"** is reworded to "no relay server change beyond callId".
25. **Proposal arguments** are explicitly excluded.
26. **endedBy** uses the four adapter reasons, and the scope field names follow ADR 0043 (conflict C26).

Conflicts between the M6 records, settled by the plan, that touch this one:

- **C14:** the session record holds no image type or size.
- **C18:** every M6 change to CallShape and callRule lands in one foundation commit.
- **C26, record scope names.** RecordScopeSchema uses `endsAt` (was plannedEndAt), `maxDrivers` (was drivers), `observers` and `invites`. endedBy is 'operator', 'time', 'page_gone' or 'relay'. The foundation's review (10 October) widened the same schemas once more, since the design predates ADRs 0042 and 0044 settling: a proposal's status takes ADR 0042's seven (pending, accepted, dismissed, refused, expired, withdrawn and cancelled) and `not_run` for an acceptance that never ran, as the adapter's ProposalOutcome names them, and only `accepted` names a call; an attachment's `how` gains `agent`, which names its token in `inviteId` and is always an invitee's, as the audit's attach record does.

## Notes from the other M6 records (10 October 2026)

**From ADR 0042.** Proposal arguments shown in the queue never enter the record (decision 25).

**From ADR 0043.** The record of a time-boxed session spans page sessions, and at the session's end it is sealed and offered rather than dropped: the Consequences' "dropped when the session ends" reads "sealed when it ends and dropped when replaced, discarded, detached or the tab closes" (decision 3).

**From ADR 0044.** Agents appear by their label, with how they came in as `agent`.

**From ADR 0019.** The `call` record's optional `callId`, the reader's `--call` and `--match`, and the version rule (decision 10) are noted in ADR 0019.

**Open questions.** Settled under Decisions: the caps (1), the offer at a session's end (3) and a summary grouped by person (4).

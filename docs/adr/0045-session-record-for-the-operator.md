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

## Notes from the review of the recorder and matcher (10 October 2026)

**Budget (decision 23).** Built in full, the record's modules measure 12,375 bytes of the script-tag build in an esbuild metafile with the script-tag options: `session-record.ts` 2,840, once its reader's list of field names is built on first use so the adapter drops it; `record.ts` 6,247, of which `NOOP_RECORDER` is 303 and goes once the recorder is the default; and `record-markdown.ts` 3,288. The strict schema a record is checked by before it is saved (decision 19) and the logic decisions 1 to 5, 8, 17 and 26 ask for make up nearly all of it, so meeting 7,000 would mean dropping one of them. The build therefore proposes a budget of 13,000 bytes for those three modules, held by the same metafile test, leaving about 600 for wiring them in. Raising a number this record decided is not an open question the standing instruction settles, so decision 23's 7,000 stays in force, and SPEC A6.26 and ADR 0048 say 7,000, until the owner confirms 13,000 or chooses which decision gives way; W3-A's metafile check waits on that answer, and whoever records it amends decision 23, A6.26 and ADR 0048 together (`adapter-size.test.ts` holds the three to one number). The widget's record block lives in `widget.ts` and counts toward the Wave 3 checkpoint, not this budget. ADR 0048's 200,000 ceiling and its checkpoints are unchanged either way.

**Matching (decision 11).** `audit --match` holds a record to the log only within the span the record claims, so it first holds the record to itself: each callId and proposal id appears once; every call, join, leave, role change, decision and dropped time lies within `from` and `to` (a proposal still pending when the record began may predate it); and a sealed record ends no later than its export, a kept one exactly at it. Between the earliest and latest lines the record holds, the relay's own order decides: a call line on one of its pages whose invoke went out after one the page got and before another must be in the record, whatever times the record gives. The dropped span explains a missing line only for a record holding SESSION_RECORD_MAX_CALLS calls whose drops are older than its first, and only within its counts by user and outcome. A record with no call or proposal the log can place fails rather than passes; a running call with no line fails once the log runs past the relay's deadline and grace from it; and a proposal agrees with how the log ran or closed it, where a race between the relay's own ends (expired, cancelled, withdrawn) and the page's is a note. This replaces the design's window widened by the median skew and 120 s. The recorder keeps every record within these rules: a span ends no earlier than it began, a record is sealed no earlier than it began or than a proposal in it was decided, only the cap's oldest-first drops set the dropped span, and a session told of its end while the link is down closes everyone as the page session ended, so `sessionEnded` and `pageSession` may come in either order on a relay restart.

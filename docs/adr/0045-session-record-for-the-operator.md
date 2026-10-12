# 0045: A session record for the operator

Status: Accepted, 10 October 2026, under the owner's standing instruction. Option B. Changes SPEC sections 8 (the record and its save), 9 (S7's `callId`) and 10 (A6.25); no relay server change beyond the audit `call` record's `callId`, while the audit reader in the relay package gains `--call` and `--match`. Adds a note to ADR 0019. Priority 8 in `docs/plans/backlog.md`; built in M6. Its notes and SPEC's M6 edits also change S9 (the calls, attachments and proposals a record holds) and S11 (the record holds no secret).

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
23. **Budget:** at most 13,000 bytes, checked by an esbuild metafile test (raised from 7,000 on 11 October 2026 under the owner's standing instruction; see the notes).
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

## Notes from the review of the recorder and matcher (10 and 11 October 2026)

**Budget (decision 23).** Built in full, the record's modules measure 12,375 bytes of the script-tag build in an esbuild metafile with the script-tag options: `session-record.ts` 2,840, once its reader's list of field names is built on first use so the adapter drops it; `record.ts` 6,247, of which `NOOP_RECORDER` is 303 and goes once the recorder is the default; and `record-markdown.ts` 3,288. The strict schema a record is checked by before it is saved (decision 19) and the logic decisions 1 to 5, 8, 17 and 26 ask for make up nearly all of it, so meeting 7,000 would mean dropping one of them. On 11 October 2026, under the owner's standing instruction to take the recommendation, decision 23 was raised to 13,000 bytes for those three modules, held by the same metafile test and leaving about 600 for wiring them in; SPEC A6.26 and ADR 0048 say the same, and `adapter-size.test.ts` holds the three to one number. The owner may still choose a decision to give way instead, which would lower the budget again by a note here. The widget's record block lives in `widget.ts` and counts toward the Wave 3 checkpoint, not this budget. ADR 0048's 200,000 ceiling and its checkpoints are unchanged either way.

**Matching (decision 11).** `audit --match` holds a record to the log only within the span the record claims, so it first holds the record to itself: each callId and proposal id appears once; every call, join, leave, role change, decision and dropped time lies within `from` and `to` (a proposal still pending when the record began may predate it); and a sealed record ends no later than its export, a kept one exactly at it. Between the earliest and latest lines the record holds, the relay's own order decides: a call line on one of its pages whose invoke went out after one the page got and before another must be in the record, whatever times the record gives. The dropped span explains a missing line only for a record holding SESSION_RECORD_MAX_CALLS calls whose drops are older than its first, and only within its counts by user and outcome. A record with no call or proposal the log can place fails rather than passes; a running call with no line fails once the log runs past the relay's deadline and grace from it; and a proposal agrees with how the log ran or closed it, where a race between the relay's own ends (expired, cancelled, withdrawn) and the page's is a note. This replaces the design's window widened by the median skew and 120 s. The recorder keeps every record within these rules: a span ends no earlier than it began, a record is sealed no earlier than it began or than a proposal in it was decided, only the cap's oldest-first drops set the dropped span, and a session told of its end while the link is down closes everyone as the page session ended, so `sessionEnded` and `pageSession` may come in either order on a relay restart.

## Notes from the wiring and its review (11 October 2026)

**`NOOP_RECORDER` stays.** The note above expected it to go once `createRecorder()` became the default. It stays as the list of hooks the core's guard wraps (decision 22) and as the recorder the core falls back to once a fault stops the record. Wired in, the three modules measure 12,602 bytes in the script-tag build's metafile (`session-record.ts` 2,840, `record.ts` 6,469, `record-markdown.ts` 3,293), under decision 23's 13,000.

**Rules the wiring's review settled**, owed to SPEC section 8 and guide page 13 with the rest of this record. The core tells the recorder of a time-boxed session (ADR 0043) only once the relay has listed it: a start the relay refused or never answered, across a link drop or a reload, leaves the page record as it was, so the stored session carries a `listed` flag that the relay's session frame sets. A session's end seals its record into `ended` only when it holds something, so a session nobody joined never replaces a lesson's record the operator has not saved, and the widget offers only a record that holds something. The record box waits again whenever the record in its chosen slot changes, not only when the operator chooses another, since a session's start or a page script's `discardRecord` replaces a slot's record in place. The warning before a save counts the people the record names by an email address, by the `@` in their recorded name, not every invitee: an agent, an unverified invitee and one renamed `invitee <short id>` carry none.

## Notes from Wave 3's merge (11 October 2026)

**A session's end while the link is down.** The review of the recorder had a session told of its end while the link is down close everyone as the page session ended, since a relay restart then always ended it (ADR 0019). ADR 0046 changes that: a restart with the snapshot on resumes the page session, as a dropped link always could, and the old rule split a member's span with an end that never happened. Such an end is now recorded as on a live link: those an invite or agent token let in leave as `session_ended` and everyone else stays on into the page record the end begins. Only if the next welcome starts a new page session does the recorder close everyone in that session's record as `page_session_ended` at the time the link went, before the session's end, leaving the page record the end began with no one in it, so the page record the session sealed at its start stays the one kept. A resumed relay lists the guests until it hears of the end, so the page record holds each of them as `unapproved` from the welcome until the relay lets go, as the relay listed them. The three modules then measure 12,743 bytes (`record.ts` 6,610), under decision 23's 13,000. `packages/adapter/test/record.test.ts` and `tests/e2e/test/record-restart.test.ts` hold both outcomes, the latter against a real relay restarted with and without the snapshot, with `audit --match` passing through the stop and the start. This is owed to SPEC section 8 and guide page 13 with the rest of this record.

## Note from Wave 3's cross review (12 October 2026)

**What the warning says.** The Context says the widget tells the operator, before a download, that the export holds other people's names and invitees' emails, and the wiring's notes settled that the warning counts them: "This record names 3 people, 2 of them by email address, and every call they made on this page". SPEC's letter had drifted from both: section 8 said the box "says whom the file names" and A6.25 asked for "a warning naming everyone in it", which read as a list of names the widget never shows, while guide pages 13 and 19 described the counts. The code is right, since listing names in the box would cost script-tag bytes and show nothing the file's own People section does not; SPEC section 8 now says the box "says how many people the file names, and how many of them by email address", A6.25 reads "after a warning saying how many people the file names, and how many by email address", and the plan's D8, the CHANGELOG, the acceptance audit's row and the comments in `widget.ts`, `session-record.spec.ts` and the demo's record leg say the same. Section 9 is unchanged, since no S rule sets the warning's words; S11 asks only that the record hold no secret.

## Notes from the docs pass (12 October 2026)

**What was owed is paid.** The notes of the wiring's review and of Wave 3's merge each say their rules are "owed to SPEC section 8 and guide page 13". Both now say them: SPEC section 8 has the record reach a session only once the relay lists it, seal only a record that holds something, re-arm the save box when its slot's record is replaced, count people by an email address and record an end given while the link is down as on a live link, and guide page 13's "Session records" section says the same.

## Note from the pull request (12 October 2026)

The owner's checklist asked whether decision 23's 13,000 bytes should stand or a decided part of the record give way. Under the owner's standing instruction the recommendation is taken: the budget stays at 13,000, with the modules at 12,743 bytes when M6 merged.

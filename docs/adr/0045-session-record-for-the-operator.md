# 0045: A session record for the operator

Status: Proposed, 9 October 2026. Priority 8 in `docs/plans/backlog.md`, for the target scenario in `docs/plans/map-classroom.md`. Would change SPEC section 8 (the widget) and add a threat model row; no relay change beyond adding the invoke's `callId` to the audit `call` record, so the export can be matched to the log.

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

## Open questions

The in-memory cap for a long session. Whether a session should offer the export automatically at its end. Whether the Markdown summary should group calls by person or by time.

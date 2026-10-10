# 0043: Time-boxed sessions

Status: Accepted, 10 October 2026, under the owner's standing instruction. Option B, with the relay also holding a session's end on its own clock. Changes SPEC sections 4 (the members file the relay reads), 5 (the session and the attachment's end), 6 (session frames), 7 (the members file in the auth paragraph), 8 (the session form and handle), 9 (S5, S8, S9, S11 and S14), 10 (A6.14 to A6.17) and 11 (the one list that may live in a file), and brings in the restart snapshot as ADR 0046. Priority 6 in `docs/plans/backlog.md`; built in M6.

## Context

A lesson and a review are both sessions: they start, they have a cast, and they end. Tabdock has no such thing. Setting one up means a public URL, sign-in, invites on and every member listed in `TABDOCK_OAUTH_USERS`, and adding a member takes a relay restart that ends every page session, pairing and invite link (`docs/guide/06-sharing.md`). The page's policy, `maxDrivers` included, is set by the page's code at `attach()` and stays for the page's life. At the end of a class someone has to remember to revoke the room.

## Options

A. Status quo, with a guide page on running a lesson.

B. Two changes. First, the relay reloads its member list without a restart, from a members file it watches or on a signal; a member removed from the list loses every attachment at once, as on revoke (S8). Second, a session in the widget: the operator starts one with a label, a length (30 minutes to 4 hours), a number of driver seats, observers by watch invite and proposals on or off (ADR 0042). The adapter mints the watch invites for the session's length, applies the session's settings, shows a countdown, and at the end revokes every invite-made attachment and live invite (as `revoke('*')` does for invites) and restores the page's own policy.

C. Sessions held by the relay, with schedules and a session API. More surface, and the operator is at the page anyway. Deferred.

## Decision

B. A session can only narrow or equal what the page's code allows: `attach()` sets the ceiling (most drivers, whether proposals and invites are possible at all), and the widget chooses within it, so nothing at the tab can grant more than the developer wrote. The policy update travels in a new frame the relay applies only within that ceiling. An invite minted for a session ends with it even if its own lifetime is longer; S14 caps lifetimes rather than fixing them, so it is unchanged.

Aligned backlog row: the restart snapshot (3 October), since a deploy in the middle of a lesson detaches the whole room. Aligned open item: SPEC section 12's per-user fairness rule for the write queue, which matters once a session has several drivers.

## Consequences

Starting a lesson is one form and ending it is automatic. Adding a teacher or a reviewer as a member no longer costs everyone their pairing. A session mints its invites only while a member is attached as sponsor (S14), normally the teacher's own Claude; if that attachment ends, every invite-made attachment ends with it, so the widget warns before the sponsor detaches. The members file is a new place a secret could leak; it holds subjects and names only, never tokens, and the threat model gains a row. ADR 0044's larger rooms and ADR 0045's record both hang off a session's start and end.

## Open questions, as proposed

The members file's format and whether a signal or a file watch reloads it. Whether presets belong in page code (`attach()` naming a few sessions) or only in the widget. Whether a session may extend itself, and by whose approval. Whether a session makes sense in local mode, where nobody else can attach.

## Decisions

Accepted with these settings on 10 October 2026, copied from section 1 of the M6 plan. Every recommendation of the record's design not listed here was accepted as written.

1. **Members file format:** one `sub=userId:Display Name` per line, with # comments, CRLF and BOM accepted. At most 500 entries and 262,144 bytes. Refusals name a line number, never its text.
2. **Reload mechanism:** stat polling every MEMBERS_POLL_MS (2,000) with one stable poll to settle, plus `relay.reloadMembers()`. No fs.watch and no SIGHUP (conflict C8).
3. **Windows:** the same polling, with POSIX mode checks skipped.
4. **Sources:** exactly one of TABDOCK_OAUTH_USERS and TABDOCK_MEMBERS_FILE, in public URL mode only, never with dev tokens.
5. **A bad file at reload** keeps the last list. At start it refuses to start.
6. **An account whose user id changes** loses everything held under the old id, including formerAttachments.
7. **Presets:** the widget form plus `dock.startSession()`. There is no attach() option.
8. **Extending:** only the operator, in steps of SESSION_EXTEND_MS, up to 4 h from the start, counted against OPERATOR_GRANTS_PER_PAGE.
9. **Local mode:** a session is a time box only.
10. **Enforcing the end:** both the relay's clock (a timer plus `#endSessionIfDue`) and the adapter's own end.
11. **What the end covers:** every invite-made attachment, every live invite and every live agent token on the page (conflict C11).
12. **Policy fields a session sets:** only maxDrivers and proposals.
13. **Lowered seats:** drivers beyond the count are demoted, newest grant first, in both layers.
14. **The QR** is held in memory only, with renewSessionLink after a reload.
15. **Session invites:** ceil(observers / 20) watch invites, with expiry capped at the session's end, shown one QR at a time (conflict C12).
16. **Sponsor warnings,** plus detach_page's new description sentence.
17. **Naming:** "time-boxed session" in prose, and session_start, session_extend, session_end and session on the wire.
18. **The restart snapshot** becomes ADR 0046: opt-in and bound to the audit chain (conflict C15).
19. **deploy.yml** takes either the secret or `vars.TABDOCK_MEMBERS_FILE`.
20. **The session frame** follows every welcome and carries remainingMs. The adapter adopts only its own session ids.
21. **A smaller ceiling on reload** narrows the session field by field.
22. **Length:** whole minutes from 30 to 240.
23. **Fairness** is ADR 0042's.
24. **SessionEndReason** is 'operator', 'time' or 'page_gone', and the adapter adds 'relay' (conflict C19).

Conflicts between the M6 records, settled by the plan, that touch this one:

- **C8:** the members file is polled with stat, not watched with fs.watch.
- **C11:** a session's end closes every live agent token on the page, and AgentCloseReason gains 'session_ended'.
- **C12, the session form's observers field.** It runs from 0 to observersPerPage, or to usersPerPage less 2 when the allowance is 0, and mints ceil(n / 20) watch invites within MAX_LIVE_INVITES_PER_PAGE.
- **C15:** the restart snapshot is opt-in, not on by default. docs/deploy.md's rotation procedure relies on a restart ending everything (deploy.md:103 and :220).
- **C19:** the session end reason 'ended' is renamed 'operator'.
- **C22, the panel order:**
  1. error line, notice line, joins
  2. prompts, then the record offer
  3. proposals, pairing
  4. roster (People, then Watching by invite), session block
  5. invites (with the agent kind and list)
  6. activity, record block, state line, pause box
- **C26, record scope names.** RecordScopeSchema uses `endsAt` (was plannedEndAt), `maxDrivers` (was drivers), `observers` and `invites`. endedBy is 'operator', 'time', 'page_gone' or 'relay'.

## Notes from the other M6 records (10 October 2026)

**From ADR 0042.** The session form's proposals field offers off, members and all, within the ceiling `attach()` sets; the decision text's "proposals on or off" reads that way.

**From ADR 0044.** A session's end also closes every live agent token on the page, and its observers field is sized by the watching seats (C11, C12).

**From ADR 0045.** A session's record spans page sessions, and at the session's end it is sealed and offered, kept until saved, discarded or replaced.

**From ADR 0046.** The restart snapshot is its own record, off by default and bound to the audit chain (C15), so a deploy during a lesson keeps the room only where the operator chose it.

**Open questions.** Settled under Decisions: the file's format (1) and stat polling (2), presets in the widget and `dock.startSession()` only (7), extension by the operator alone (8), and a time box only in local mode (9).

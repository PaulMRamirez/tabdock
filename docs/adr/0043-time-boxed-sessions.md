# 0043: Time-boxed sessions

Status: Accepted, 10 October 2026, under the owner's standing instruction. Option B, with the relay also holding a session's end on its own clock. Changes SPEC sections 4 (the members file the relay reads), 5 (the session and the attachment's end), 6 (session frames), 7 (the members file in the auth paragraph), 8 (the session form and handle), 9 (S5, S8, S9, S11 and S14), 10 (A6.14 to A6.17) and 11 (the one list that may live in a file), and brings in the restart snapshot as ADR 0046. Priority 6 in `docs/plans/backlog.md`; built in M6. Its notes and SPEC's M6 edits also change section 12 (fairness once a session has several drivers), S7 (a session's end recorded as `time` or the operator's) and S13 (a reused user id reads none of its former holder's claims).

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
- **C15:** the restart snapshot is opt-in, not on by default. docs/deploy.md's rotation procedure relies on a restart ending everything (the rotation steps under each secret in its "Each secret" section, and its "Key rotation runbook").
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

## Notes from the build (10 October 2026)

**At once, for an MCP session.** A member list change ends every 2025-era MCP session held under a user id it ended at the moment it applies: from then on the session answers every request 404, as an unknown one does. A session with nothing open closes then; one still writing an answer, such as the `not_attached` the change gave a call in flight, closes when its last response is done, and after `MEMBER_SESSIONS_CLOSE_MS` (1 s) at the latest, since a client's listening GET stream never ends on its own. Listen streams close at once, since they carry no answers. Only the sessions and streams held when the change applies end, so a member the change adds, or the new holder of an id it moved, keeps one opened a moment later. This is how S8's "at once" and A6.14 hold for sessions.

## Notes from the build (11 October 2026)

**At once, for a request still arriving.** A /mcp request is signed in from its headers, and its body may follow minutes later, so a change can apply while a request holds nothing yet that the change could end. Each request therefore keeps the member list's generation it signed in under (`MemberList.generation`, taken before the plugin maps the subject), and the list remembers which ids each change ended (`endedSince`, the latest 2,000 at most, refusing anything older). Once the body is read, a request whose id a change since then ended gets the plugin's 401 challenge, so its client signs in again and its retry maps as the list now says; the dispatcher asks again as a tool handler starts, since the SDK's own awaits lie between the two. /pair and /i read the browser's sign-in again after the body for the same reason. A member the change adds may, at worst, be asked to sign in once more if their first request was signing in as it applied. Wave 1's cross-workstream review found the gap with a held body that paired and redeemed an invite under a removed member's id; `members-file.test.ts` holds both and a call under an id the file gave someone else.

**A session the page holds no record of.** The adapter still adopts only a session it started (decision 20), and now asks the relay, once per link, to end any session it lists while the page holds none, as it closes an invite it holds no record of. A page that ended its session while the relay could not hear, and then reloaded, otherwise lost that end: the relay kept the narrowed seats and proposals and refused every start as 'active' until its own clock ended the session. An end only takes access away, so asking for one imposes nothing, and an end this page made on its own clock still waits out SESSION_END_GRACE_MS so the relay's own end wins a tie. The design's "ignored" for such a session reads "ended"; W2-B's review found the gap, and `session.test.ts` holds both cases.

## Note from Wave 3's cross review (12 October 2026)

**Who ended a session, in the audit log.** The page's `session_end` carried only the session's id, so the relay recorded every end the page told it as the operator's, while the page's own record said `time` for an end its clock made, and the demo narrated the mismatch as expected. The frame now carries an optional `reason: 'time'`, additive within page link v1, which the adapter sends when its own clock ended the session and leaves out for the operator's End and for a session it holds no record of. The relay records `time` only where its own end is at most a minute away (`SESSION_CLOCK_SLACK_MS`, covering the link's latency, a late timer and the page's 5 s grace), and the operator's otherwise, since an earlier end is the page asking, as an End is: the page's word is believed only where the relay's clock can bear it out. `audit --match` notes, without failing, a session whose record and log name different reasons, since either clock may end it first. SPEC's S7 and threat model B4 say so; `page-link.test.ts`, `session.test.ts`, `time-boxed.test.ts` and `audit-match.test.ts` hold each part and fail without it, and the demo's session leg, whose tab clock jumps 30 minutes alone, now shows the relay recording the operator's.

## Notes from the section 9 review (A6.28, 12 October 2026)

**A revoke bar follows the account.** The relay barred a revoked person from an invite by the user id they held, and a member's id is the one the file gives them. A change that removed them, moved their id or made a barred invitee a member therefore gave them an id the bar did not name, and with a watch link kept open (the widget's "and close this link" box left unticked) they redeemed it again as an observer with no prompt, while the bar stayed on an id the file might give someone else. A bar now holds the id the account's subject signs in under as an invitee, `g_` and its digest (`MemberList.accountIdOf`), which is what ADR 0017 meant by a bar holding the digest of the account's `sub`, and every check maps the caller's id the same way through the list in force, so neither a change nor a restart clears it, and the next holder of a moved id is not barred for its former holder. The relay refuses such a claim before the page hears of it, so the adapter, which bars by id, is never asked. S14 says so; `members-file.test.ts` holds a revoked member removed, a revoked member moved (and the old id's new holder admitted) and a revoked invitee added, and `restart-snapshot.test.ts` a move made while the relay was down; each fails without the change.

**A claim follows its id out.** A change signed out the `/pair` browsers under an id it ended but kept their `/pair` and `/i` claim records until two minutes after they settled, and `/pair/status` and `/i/status` tell claimants apart by user id alone, so the new holder of a moved id, given a claim id, read the former holder's outcome and role. Only the outcome leaked, and the claim id is about 50 random bits that reach only the former holder's tab, but S13 says a reused id sees nothing of its former holder's. The change now forgets every claim made under an id it ended, settled or pending, and a settle still on its way writes only to the record dropped. `members-file.test.ts` holds both kinds at both paths and fails without the change; threat model B12 and guide page 20 name claims beside sign-ins.

## Notes from the docs pass (12 October 2026)

**Extending by whole minutes.** Decision 8's "in steps of SESSION_EXTEND_MS" holds for the widget alone: its Extend button adds `SESSION_EXTEND_MS`, 15 minutes, and is disabled once that would pass 4 hours from the start. `dock.extendSession(minutes)` takes any whole number of minutes that keeps the session within 240 from its start (`SessionLengthSchema`, in `packages/adapter/src/core.ts`), and the relay checks the length, never a step, so SPEC section 5, guide page 13 and the CHANGELOG, which say whole minutes, stand. Each extension still counts against `OPERATOR_GRANTS_PER_PAGE`.

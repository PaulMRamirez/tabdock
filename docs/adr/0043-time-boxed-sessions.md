# 0043: Time-boxed sessions

Status: Proposed, 9 October 2026. Priority 6 in `docs/plans/backlog.md`, for the target scenario in `docs/plans/map-classroom.md`. Would change SPEC sections 5 (an attachment's end), 6 (a policy update frame), 7 (the allowlist), 8 (the widget) and 11 (every setting is an environment variable, which a members file is not).

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

## Open questions

The members file's format and whether a signal or a file watch reloads it. Whether presets belong in page code (`attach()` naming a few sessions) or only in the widget. Whether a session may extend itself, and by whose approval. Whether a session makes sense in local mode, where nobody else can attach.

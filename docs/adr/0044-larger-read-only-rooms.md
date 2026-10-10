# 0044: Larger read-only rooms

Status: Proposed, 9 October 2026. Priority 7 in `docs/plans/backlog.md`, for the target scenario in `docs/plans/map-classroom.md`. Would change SPEC section 9 (S9, and S14's "leave members two seats", the seat rule ADR 0017 wrote into it) and ADR 0016's "user limit minus two seats" wording, and brings in three backlog rows.

## Context

A university class or a seminar is 20 to 35 people; a page holds 10 by default (`TABDOCK_MAX_USERS_PER_PAGE`). With invites on, invite-made attachments may use the page's limit less the 2 seats kept for members (ADR 0017), and each watch invite allows at most 20 uses, with 10 live per page (S14). Claude accounts require users to be 18 or older (`docs/notes/verified.md`), so a room of students on their own Claude is an adult room. Students who join by invite are invitees: the relay holds at most 50 invitee sessions in all, two each once attached (ADR 0016's pool, `inviteeSessions`, not yet a setting), and each invitee makes at most 60 requests a minute (`TABDOCK_MAX_REQUESTS_PER_INVITEE`). ADR 0030 caps what each user's responses may hold, and the backlog notes that some 40 members or 110 invitees leaving answers unread at once would fill the reference host. The connector facts in ADR 0016 and SPEC section 3 (OAuth, no auth or, in a beta, fixed headers; one custom connector on the Free plan; no per-user identity in hosted traffic) are re-checked before acceptance.

## Options

A. Raise `TABDOCK_MAX_USERS_PER_PAGE`. Simple, but it raises drivers' and members' room along with observers', and the number was never measured for a class.

B. A separate allowance for observers, provisionally `TABDOCK_MAX_OBSERVERS_PER_PAGE`, counted apart from the people limit and sized by measurement on the reference host, together with the invitee pool and rate. A session (ADR 0043) mints as many watch invites as the allowance needs, each at most 20 uses, within S14's 10 live per page and 20 uses each, so S14's invite limits are unchanged. Brought in with it: the relay-wide ceiling on responses with bytes waiting (5 October row), so a room of idle clients cannot crowd out members; for the reference deployment only, "Sign in with Google" (3 October row), since a school's own relay picks its own provider; and the no-account agent tokens on `/g/mcp` (3 October row), for a lab computer running Claude Code, never for hosted Claude, whose no-sign-in connector URLs ADR 0016 rejects.

C. A broadcast mode in which the relay serves page state (ADR 0040) to anyone with a link, without an attachment. Rejected: anonymous means no account, never no identity (ADR 0016).

## Decision

B, measurement first. The allowance applies to observers only: a driver seat and member standing still count against the people limit. A proposal right (ADR 0042) does not, since a proposal runs only when the operator accepts it, and ADR 0042's 20 pending per page bounds the operator's load. Observers stay on read-only tools and, for invitees, on the fixed tools (ADR 0016), so a larger room adds readers, never writers.

## Consequences

A class can join one page. The roster, the activity log and the audit log then name each student by account email, as they name invitees today, so the guide should recommend a short `TABDOCK_AUDIT_RETENTION_DAYS` for a relay used in class. The widget's roster needs a compact view for 30 names on a teacher's screen.

## Open questions

The numbers, after measuring sessions, listen streams, the invitee pool and held responses for a full room of observers each reading page state (ADR 0040). Whether `/g/mcp` tokens should also be mintable per session for a lab of shared computers. Whether the 2 member seats ADR 0017 reserves are still the right reserve once observers have their own allowance.

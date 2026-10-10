# 0044: Larger read-only rooms

Status: Accepted, 10 October 2026, under the owner's standing instruction. Option B, measurement first. Changes SPEC sections 3 (Google, WorkOS and Fly), 5 (agent users and tokens), 6 (seat limits, the roster's client cap and agent frames), 7 (`/g/mcp` and Google through the identity provider), 8 (the Watching section and the agent kind), 9 (S4, S9, S11 and S14), 10 (A6.19 to A6.24) and 11 (class sizing), adds notes to ADRs 0016, 0017 and 0030, and brings in three backlog rows. The connector facts it names were re-checked on 10 October (`docs/notes/verified.md`). Priority 7 in `docs/plans/backlog.md`; built in M6.

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

## Open questions, as proposed

The numbers, after measuring sessions, listen streams, the invitee pool and held responses for a full room of observers each reading page state (ADR 0040). Whether `/g/mcp` tokens should also be mintable per session for a lab of shared computers. Whether the 2 member seats ADR 0017 reserves are still the right reserve once observers have their own allowance.

## Decisions

Accepted with these settings on 10 October 2026, copied from section 1 of the M6 plan. Every recommendation of the record's design not listed here was accepted as written.

1. **Provisional defaults:** 40 observers per page, an invitee pool of 100, 60 requests a minute per invitee, and a response ceiling of 96 MiB. Measurement may lower them before merge, and raising one needs an ADR note.
2. **Agent tokens and sessions:** a session's end closes agent tokens, and there is no bulk mint.
3. **The reserve of 2 member seats** applies to the people limit only.
4. **The watching seat** holds exactly invitees in the observer role.
5. **TABDOCK_MAX_OBSERVERS_PER_PAGE** runs from 0 to 100, and 0 restores M5's rule.
6. **Promotion** is refused when the people limit is full. **Demotion** is always allowed.
7. **Response ceiling:** counted in bytes, using an eager slicer.
8. **Who gives way:** strangers' responses first, then guests', oldest first. Never a member's.
9. **TABDOCK_MAX_RESPONSE_BYTES** applies in every mode and is at least 4 MiB.
10. **TABDOCK_MAX_INVITEE_SESSIONS** becomes a setting.
11. **Requests per invitee** stay at 60 a minute.
12. **Watching share of a page's calls:** 120 a minute per page, 30 per user and 4 in flight, as option-only settings.
13. **Roster rows:** an invitee's row lists its 2 newest clients. usersPerPage gets a ceiling of 50, and a test holds the worst-case welcome under 768 KiB.
14. **Google sign-in** goes in only as an upstream of WorkOS on the reference deployment.
15. **Google's consent screen:** openid, email and profile, External, published In production, no logo.
16. **Agent tokens** get their own record and their own frames.
17. **An agent's user id** is `g_` plus 32 hex characters of SHA-256 over agentKeyInput, and the relay names it `agent <8 hex>`. A newline in the hashed text keeps it from colliding with an identity provider's printable subject.
18. **Approval** is never in advance: the first request raises a prompt. A deny burns the token, and three timeouts burn it.
19. **Where tokens work:** only with TABDOCK_AGENT_TOKENS and invites on, a sponsor attached and a public URL.
20. **Token format:** `tda_` plus 43 base64url characters. Lifetimes are 1 h (default), 4 h or 8 h, with at most 10 live per page.
21. **pair_page on /g/mcp** waits on the token's own request and never redeems a code or an invite.
22. **Agents never propose.**
23. **The widget shows the `claude mcp add` command once.**
24. **No address block** for hosted Claude's range.
25. **Every token miss is a 404,** answered before the body is read.
26. **When a token closes,** its sessions and listen streams close.
27. **Audit retention:** the guide advises 7 days for a class.
28. **Compact roster:** the Watching section collapses past 8 rows.
29. **The welcome carries** usersPerPage and observersPerPage.
30. **The connector facts** are re-checked and recorded.
31. **Measurement environment:** cgroup v1 groups, falling back to taskset.
32. **Per-page waits:** C2. **Sessions:** C11 and C12.

Conflicts between the M6 records, settled by the plan, that touch this one:

- **C2, wait limits.** There is one module, `packages/relay/src/waits.ts`:
  - **Per user:** MAX_WAITS_PER_USER = 2, shared by both waiting tools.
  - **Per page:** usersPerPage + observersPerPage.
  - **Invitees on a page:** that number less MEMBER_RESERVED_SEATS.
  - **Charge:** each wait still holds its request charge.
- **C10, threat model rows.** B11 Page images to clients (0039), B12 Operator to the members file (0043), B13 Agents to /g/mcp (0044), B14 The operator's tab to a saved session record (0045). The snapshot goes under B7.
- **C11:** a session's end closes every live agent token on the page, and AgentCloseReason gains 'session_ended'.
- **C12, the session form's observers field.** It runs from 0 to observersPerPage, or to usersPerPage less 2 when the allowance is 0, and mints ceil(n / 20) watch invites within MAX_LIVE_INVITES_PER_PAGE.
- **C13:** ADR 0042's `#propose` and the adapter's `onProposal` refuse agent callers with role_denied.
- **C21, Revoke on a sponsor's row.** It asks first whenever anyone that member's invites let in is still attached, not only during a session, and so does Revoke all. The roster workstream owns this.
- **C22, the panel order:**
  1. error line, notice line, joins
  2. prompts, then the record offer
  3. proposals, pairing
  4. roster (People, then Watching by invite), session block
  5. invites (with the agent kind and list)
  6. activity, record block, state line, pause box
- **C23:** imageBytes and observersPerPage both live in RelayLimits. They are validated through a new `wholeNumbers` helper and read through a new `parseWhole`, both of which accept 0.
- **C28:** agents may hold waits.

## Notes from the other M6 records (10 October 2026)

**From ADR 0016.** Its "user limit minus two seats" now holds for the people limit only; agent tokens are built here, named `agent <short id>` by the relay, with the label the widget shows. ADR 0016 gains a note.

**From ADR 0017.** S14's "leave members two seats" is reworded for the watching seats (SPEC S14); ADR 0017 gains a note.

**From ADR 0030.** The relay-wide `TABDOCK_MAX_RESPONSE_BYTES` joins ADR 0030's per-user cap on answers waiting; ADR 0030 gains a note.

**From ADR 0040.** A page's waits are sized by `usersPerPage` plus `observersPerPage` (C2).

**From ADR 0043.** A session's end closes the page's agent tokens, and its invites are sized by the watching seats (C11, C12).

**From ADR 0045.** The session record lists agents by their label, with how they came in as `agent`.

**Open questions.** Settled under Decisions: the numbers are provisional until the room measurement (1), there is no bulk mint per session (2), and the two member seats stay for the people limit only (3).

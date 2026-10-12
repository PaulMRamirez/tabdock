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

## Notes from the build (11 October 2026)

**One watcher's share of the running calls.** Decision 12's four watching calls in flight are a page's; a watcher whose read-only tool runs slowly could hold all four for the call deadline and refill them within their 30 a minute, keeping every other watcher out. Each watcher may therefore hold at most 2 of them (`watchingCallsInFlightPerUser`, an option like the other three, not a setting); past it their call answers `rate_limited` with its call record, as a watcher's own rate does, while the page's four stay `page_busy`. Members are never held to either (`watching-calls.test.ts`).

**A class joining at once.** S14's page pairing limit, 30 a minute (`pairAttemptsPerPage`), counts every redemption that lands on the page, the members' own pairings included, and stays as it is. A class of 40 joining within one minute therefore sees about the 30th and later answered `rate_limited` at `/i` until the minute turns, and then joins, as `observer-seats.test.ts` shows on the shipped limits. The class guidance and the room measurement (A6.22) must say so; a teacher can hand out the link a few minutes before class.

**A prompt the page drops itself.** The relay reads an attach_decision deny for a token as the operator's own, closing the token as denied, and one for a control invite's redemption as a refusal that counts toward burning it. So a prompt the page drops because it sends its own end with it (End, a session's end on the page's clock, Cancel on an invite or a token) is answered with no frame: the relay ends it as it applies session_end, invite_cancel or agent_cancel, or its own session's end, so the token closes as session_ended or cancelled, the session_end record counts it, and the waiting agent hears why. The operator's Deny goes before the agent_cancel that follows a burned token, which the relay then has nothing to close for, so the token closes as denied (`agent-page-ends.test.ts`). A token whose agent detaches, or whose attachment ends unused, keeps closing as revoked: agent_closed's `revoked` says the token's access went with its attachment, and the detach or idle expire record beside it says how, so no reason was added to the audit schema.

**Where an agent token travels, and what guards `/g/mcp`.** A client sends its token only in an `Authorization` header. The relay sends it once more, to the page that minted it, inside the first request's `attach_request` (`agent.secret`), as it sends an invite's secret in `invite.secret` (ADR 0017): the adapter hashes it against its own record, so a relay that never saw the token cannot raise a prompt for it (S4), and keeps it nowhere. `/g/mcp` refuses a `Host` that is not the public host and answers a foreign `Origin` 403 before any token is read, as `/mcp` does. SPEC section 6's `attach_request` row, S11 and S12 now say so (from Wave 2's cross-workstream review); threat model row B13 (W3-D) says the page link carries the token once.

**Three rules from the agent token build.** A token live when a request's headers arrive but closed while its body arrives (a revoke, a Cancel, a burn or its time) gets the same 404 once the body is in: `/g/mcp` asks about the very token presented again after the body, as `/mcp` reads its sign-in again (ADR 0043's notes), so decision 25's 404 before the body holds for every token not live at the headers, and comes after the body only for one that closes during it. Only a token still waiting for its first approval has its body parsed to name its client for the prompt, and only a body of at most 16 KiB (`MAX_AGENT_NAMING_BYTES`); a larger one, or any an attached agent sends, is never parsed for it, and the prompt then names no client. And when the page's clock runs ahead of the relay's, the page counts a token's third silence first and its agent_cancel closes the token as cancelled rather than burned: the token dies at the third silence either way (decision 18), and only agent_closed's reason differs. `agent-tokens.test.ts` in the relay and the adapter holds all three.

## Notes from the room measurement (11 October 2026)

**The defaults stand.** `pnpm measure:room` ran `main.ts` as the image runs it, in a 512 MiB cgroup v1 group held to one CPU (decision 31) and a network namespace of its own, with a class of 40 on the shipped defaults, one of 80 given 80 seats and a pool of 200, and two classes of 40 on two pages with a pool of 200 (`docs/notes/m6/room-measure.md`, every figure in its raw file with the commit). All three passed every bar at the burst quota: peak RSS 248.0, 280.3 and 293.9 MiB of 400 MB, the heap after a collection taken under load at most 43.6 MiB, the event loop's p99 past its sampling interval at most 11.7 ms, the teacher's p95 at most 98.7 ms, and no guest 503. So decision 1's four defaults stand: 40 watching seats, an invitee pool of 100, 60 requests a minute per invitee (decision 11) and a ceiling of 96 MiB. None is raised.

**No member cut, and the ceiling acting.** Each teacher kept two answers waiting through the unread phase, read a little every 5 s, and every one of them (6, 8 and 12) ended whole, the client's own finding rather than a log line, which names its user only once a minute. One page's class left at most 60.5 or 84.7 MiB waiting as the ceiling counts it, its asks spaced by the watchers' share; two classes at once reached 96 MiB and the ceiling cut 28 guests' answers while both teachers' held, RSS peaking at 293.9 MiB. So the ceiling is what bounds several rooms at once, and members' answers are kept by it as decision 8 says (A6.20's tests hold the same).

**The watchers' share is 60 calls a minute per page.** Decision 12's 120 was the design's guess, which the measurement was to check against the projected tab's frames. In five runs of the canvas map page in headless Chromium, one `capture_view` a second left 0.3 to 0.6% of frames late and the 99th percentile at one frame (16.8 ms); two a second left 1.3 to 2.0% late and it at two frames every time. The run before them saw 1.0% late at one a second, so one a second is near that edge, not far below it. So `DEFAULT_RATE_LIMITS.watchingCallsPerPage` is 60, still an option and not a setting. Each watcher's own share falls with it from 30 to 15 a minute (`watchingCallsPerUserPerPage`), keeping decision 12's four to one: at 30, two students' agents looping `capture_view` would spend the page's whole share and leave every other watcher `rate_limited` for the window, the case the per-watcher share exists for, so no fewer than four watchers can spend it now (`watching-calls.test.ts`). 4 running and 2 per watcher are unchanged. At the measured mix about a fifth of a class of 40's page calls answer `rate_limited`, each pointing to `get_page_state`, which never touches the tab. A lower bound loosens nothing (S9).

**The CPU baseline.** At Fly's 6.25% baseline a chat class of 40 used 5.3% of one CPU, the teacher's `set_view` taking 0.57 s at the median and 3.4 s at p95; a chat class of 80 or two of 40 used all of it, the loop's p99 near 4 s and 58 to 88 state reads past the client's 60 s; an agent room fell further behind, the loop's p99 5.1 to 5.7 s. At the burst quota a chat class took 4.6 to 7.5% of a CPU and an agent room 17.7 to 30.7%. Decision 11 keeps 60 requests a minute; the answer is the machine, which the owner chooses from the figures on the M6 checklist, and a shared-cpu-1x's baseline is not enough for more than a slow chat class of 40.

**A class joining at once.** A class of 40 on addresses of its own was all in after 85 s, 29 in the first minute, the teacher's own pairing the page's 30th. A Join the page refuses still spends its invite's 30 redemptions a minute (ADR 0017), so students tapping again every 10 s met the invite's limit more than the page's: 39 of a class of 40's 60 refused Joins, and 225 of a class of 80's 311. A class behind one address took 190 s at 10 sign-ins a minute, ADR 0018's per-address share of `/i` binding before S14's page limit; two classes on two pages took 69 s. No limit changes: each keeps one page, invite or address from spending the relay's sign-ins and pairings. The answer is the class's own, which page 15 gives and the class guidance (page 20) should repeat: hand the link out a few minutes before class, and wait a minute after a refused Join rather than tap again.

**The pool for several rooms.** The default pool of 100 fits one class of 40 at a time, 80 sessions and a fifth more; a relay that hosts several classes at once sets `TABDOCK_MAX_INVITEE_SESSIONS` to about 96 for each class of 40, as the two classes ran on 200 (page 14).

**Unread answers in the measurement.** On the sandbox's loopback the kernel took a whole unread answer, so the relay held none and neither the stall rule nor the ceiling acted; the unread phases cap TCP buffers at 64 KiB a direction inside the run's own network namespace, as an edge that buffers little would, and nothing outside it changes (`docs/notes/verified.md`).

## Notes from the response ceiling's build (11 October 2026)

`TABDOCK_MAX_RESPONSE_BYTES` (decisions 7 to 9) counts bytes as `inSlices` reads each answer, a chunk whole until its last slice goes, so an unread answer of the largest size counts about 786 KB and the 96 MiB default covers about 13% fewer answers than a count by text. A response gives way only while it waits to be read: past `RESPONSE_IN_TRANSIT_BYTES` (96 KiB, what a response being written holds) or once a check finds its client took none of it, so a stream read as fast as it comes is never cut. When members' answers alone pass the ceiling, nothing is cut, since no cut could bring the total under, and a line says so once a window. `ResponseStalls.heldBytes` reads the total for the room measurement and changes nothing. The relay README, guide page 14 and threat model row B1 say the same.

## Notes from the A6.28 review (12 October 2026)

**Where an agent token travels, as built.** The build note above says the relay sends the token "once more", inside the first request's `attach_request`, and threat model row B13 said the page link carries it once. Both overstated what the code does, and the code is right. The adapter checks the presented token against its own record on every prompt (`checkAgent` in `packages/adapter/src/core.ts`), which is what lets S4 hold, so the relay puts the token in each `attach_request` it raises for it: its first request's, then the first after a prompt timed out (decision 18 allows three), the first after the page dropped one on a sleep or reload (which counts toward no burn), and the first after a restart snapshot brought the token back waiting (ADR 0046). Every copy goes only to the page that minted it, which hashes it and keeps it nowhere; no other page, log line or audit record holds it (`packages/relay/test/agent-token-travel.test.ts`). The code is unchanged. S11, SPEC section 6's `attach_request` row, B13, guide page 10 and the relay README now say so, and `doc-client-surface.test.ts` holds the wording so "once" does not come back.

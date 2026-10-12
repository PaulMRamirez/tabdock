# Lessons and reviews

Three things let one tab hold a lesson or a review: observers propose writes that run only when the operator accepts them, a time-boxed session narrows the page's policy for a set length and ends what it let in, and the widget keeps a record of who did what, which the operator may save and hold to the audit log. None widens the page's own policy. [Larger rooms](20-larger-rooms.md) covers the watching seats, the members file and agent tokens a class also uses.

## Proposals

A page whose policy sets `proposals` to `'members'` or `'all'` (`data-proposals`; `'off'` by default) turns an observer's write into a proposal instead of a `role_denied`. Under `'members'` only member accounts propose, and under `'all'` invitees too; an agent token's caller never does. `list_page_tools` marks each tool the caller may propose `proposable: true`, and a call to it, by `call_page_tool` or a first-class name, answers `proposed` with a proposal id and when it expires.

The widget lists proposals above the pairing code, newest on top, each with the proposer, their client, the tool and the arguments as their client wrote them, cut until Show all. Accept, armed like Allow once its row has held still, is that call's confirmation, so a consequential tool runs without a second prompt, as the row warns; under `consequential: 'deny'` such a proposal is refused at once, and a paused page's Accept waits for Resume. Dismiss and Dismiss all clear rows. Accepted proposals run through the write queue in the order accepted, and the page runs one only against its own record of that Accept, for the same caller, tool and arguments, within 60 s.

The proposer follows it with `get_proposal`. Its `waitMs`, up to 40 s, waits for a change: a wait answers `accepted` as the operator accepts, while the page runs the call, and a second wait answers with the run's result behind its label, its text only. Other answers are `pending`, `dismissed`, `refused`, `expired` (after 10 minutes), `withdrawn` and `cancelled`, and an outcome stays readable for 10 minutes. `withdraw_proposal` takes a pending one back. An id that is unknown, forgotten or someone else's answers `proposal_not_found`, worded alike, so ids grant nothing. To rehearse, open the demo board from `pnpm dev` with `&proposals=all` added to its URL and play two dev-token users, as [Sharing](06-sharing.md#try-sharing-on-one-computer) does.

A user holds 3 pending proposals on a page and a page 20, and arguments past 16,384 bytes or 1,000 values answer `invalid_arguments`. One withdrawn, dropped by its proposer's detach or refused by the page keeps its place for a minute, and each user's proposals across the relay hold at most an eighth of `TABDOCK_MAX_PROPOSAL_BYTES`, or one at the caps. Past the counts, the held places or that share, and for a watcher by invite past the watchers' share of the page's calls, which a proposal spends too, it answers `rate_limited`; while the page's link is busy, `page_busy`. Proposals live in memory: a reload or a closed tab cancels the pending ones.

## Time-boxed sessions

Start a session in the widget, or with `dock.startSession()`: a label, a length from 30 to 240 minutes, driver seats up to the policy's `maxDrivers`, seats by watch invite and who may propose, none wider than the policy. Before Start the form names the member whose invites the session shares, whose leaving ends the guests' access, how many guests leave and links close at its end, and anyone Start makes an observer: drivers past the seats step down, the newest first.

While it runs the block counts down and the badge shows the minutes left, with a notice at 5 minutes and at 1. The observers' links come one watch invite for every 20 observers, and Show QR shows one at a time, the first with uses left, so a projected QR always works.

Links show once and a reload keeps none, so when the widget holds no link with uses left it offers New link, which closes the session's earlier links, as it says, and mints one of at most 20 uses for the seats still open. Extend adds 15 minutes, up to 4 hours from the start, and End session asks first, saying how many guests leave. The sponsor's line warns when their attachment may time out before the session ends, taking their guests with it.

A session ends on the relay's clock and on the page's own, whichever comes first; the page drops its guests at once and tells the relay 5 s later if the relay has not ended it. Its end closes every attachment an invite or agent token made on the page, every live invite and every agent token, those from before it included, and the page's own policy returns. In local mode a session is a time box only, with no invites.

## The session record

The widget keeps, in memory only, a record of the current page session, or of the session while one runs: everyone who attached (as the widget names them, member or invitee, how they came in, each role, joined and left), every call that reached the page (time, person, client, tool, outcome, duration, where it was confirmed, its proposal and its call id) and every proposal, never arguments, results, images or page state. It holds 5,000 calls, 500 attachments and 1,000 proposals, dropping and counting the oldest, and `dock.sessionRecord()` returns it to the page's own code.

When a session ends the widget offers its record, Save JSON or Save summary, and never saves it unasked; a session nobody used offers nothing and replaces no earlier record. Save record opens the same choice for the current, previous or ended record. Each box first says how many people the file names, and how many by email address, and takes a click only once it has held still, starting over whenever the record in its slot changes. A record goes when another replaces it, on Discard, on `dock.close()` and with the tab. Tell the room a record is kept.

`pnpm audit:log --match <file> --verify` holds a saved JSON record to the relay's audit log, call by call, by call id: a call added, removed or changed, or a record whose own ids and times disagree, fails with exit 1, while races a genuine record meets are notes. Its last line reads `match: agrees with the log` or `match: FAILED`, with counts. A record with no call or proposal the log can place fails as unplaced. A match shows the file agrees with the log over the span it claims, not that the log is complete; run it on files copied off the host as well as on the host, passing `--dir` with every audit file the lesson spans.

## A lesson on one tab

A whole lesson, from the relay's settings to a matched record, is on [Run a class](21-run-a-class.md). `pnpm demo:m6` rehearses its every step on one machine against a stand-in provider.

## When it goes wrong

**A write answers `role_denied`, not `proposed`.** The policy's `proposals` is `'off'`, the session narrowed it, the caller is an invitee under `'members'`, or an agent. **Accept stays grey.** The page is paused; resume it.

**Start is refused**, saying why. `active`: the relay held an earlier one, which the page ends; Start again; `policy`: wider than `attach()` allows; `invalid`: more observers than the relay's watching seats, no driver seat, or a bad label or length; `unavailable`: no relay answer within 10 s, or observers with no member to sponsor them, or no public URL; `limit`: 10 grants a minute (promotions, invites, agent tokens, session starts and extensions) are spent, or 10 live invites cannot hold one more per 20 observers. **A record will not save.** Nothing is recorded yet, or the record stopped after an error; the audit log still has every call.

Next: [Larger rooms](20-larger-rooms.md).

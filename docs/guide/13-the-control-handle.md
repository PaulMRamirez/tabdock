# The control handle

`attach()` returns a frozen `Dock`, the only control handle, and the widget does everything through it. This page lists its members, its state and the options its minting methods take, as [core.ts](../../packages/adapter/src/core.ts) declares them; [Adapter reference](04-adapter-reference.md) has `attach()` and the policy. The script-tag build keeps the handle to itself, so there the widget is the only way in.

## Members

Methods that return a boolean return `false` when there was nothing to act on, such as a request that already ended or a link that is down.

| Member                | Call                                   | Returns                      | What it does                                                                                                                                                |
| --------------------- | -------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`               | `dock.state`                           | `DockState`                  | The current state, a frozen snapshot                                                                                                                        |
| `on`                  | `dock.on('state', listener)`           | a function that unsubscribes | Calls the listener after every change; `'state'` is the only event, and any other name throws                                                               |
| `approve`             | `dock.approve(requestId, role)`        | boolean                      | Allows a pending attach request as `'driver'` or `'observer'`                                                                                               |
| `deny`                | `dock.deny(requestId)`                 | boolean                      | Denies it                                                                                                                                                   |
| `confirm`             | `dock.confirm(callId, allow)`          | boolean                      | Answers a consequential prompt; only `true` allows                                                                                                          |
| `rotatePairing`       | `dock.rotatePairing()`                 | boolean                      | Asks the relay for a fresh pairing code; `false` while not linked                                                                                           |
| `setRole`             | `dock.setRole(userId, role)`           | boolean                      | Switches the role of someone approved here or let in by `autoApprove`; at `maxDrivers` the relay keeps a new driver an observer, though this returns `true` |
| `revoke`              | `dock.revoke(userId, { closeInvite })` | boolean                      | Ends one user's attachment, or everyone's with `'*'`, cancelling their calls, prompts, waits and proposals; `closeInvite` also closes the invite            |
| `cancelInvite`        | `dock.cancelInvite(inviteId)`          | boolean                      | Closes one invite link; attachments it made stay until revoked                                                                                              |
| `invite`              | `dock.invite(options)`                 | `Promise<InviteResult>`      | Mints an invite, below                                                                                                                                      |
| `pause`               | `dock.pause(paused)`                   | nothing                      | `true` answers `page_busy` to every call not yet running, queued and prompted ones included; only `false` resumes; it survives a reload                     |
| `close`               | `dock.close()`                         | nothing                      | Detaches for good: denies open prompts, ends the page session at once, forgets the resume token and grants, and removes the widget                          |
| `publishState`        | `dock.publishState(value)`             | `{ ok }` or `{ ok, reason }` | Shares a JSON object, or null, as the page's state for every attached client to read (ADR 0040); never throws                                               |
| `acceptProposal`      | `dock.acceptProposal(proposalId)`      | boolean                      | Accepts a waiting proposal, which is that call's confirmation; the relay then runs it in turn (ADR 0042)                                                    |
| `dismissProposal`     | `dock.dismissProposal(proposalId)`     | boolean                      | Dismisses one                                                                                                                                               |
| `dismissAllProposals` | `dock.dismissAllProposals()`           | number                       | Dismisses every waiting proposal and says how many                                                                                                          |
| `startSession`        | `dock.startSession(options)`           | `Promise<SessionResult>`     | Starts a time-boxed session, never wider than the policy (ADR 0043), below                                                                                  |
| `extendSession`       | `dock.extendSession(minutes)`          | boolean                      | Lengthens it by whole minutes, up to 4 h from its start                                                                                                     |
| `endSession`          | `dock.endSession()`                    | boolean                      | Ends it now, and every attachment, invite and agent token it let in                                                                                         |
| `renewSessionLink`    | `dock.renewSessionLink()`              | `Promise<InviteResult>`      | A new observers' link for the running session, since a reload keeps none                                                                                    |
| `agentToken`          | `dock.agentToken(options)`             | `Promise<AgentTokenResult>`  | Mints an agent token whose first request asks the operator (ADR 0044), below                                                                                |
| `cancelAgent`         | `dock.cancelAgent(tokenId)`            | boolean                      | Closes one agent token and ends what it let in                                                                                                              |
| `sessionRecord`       | `dock.sessionRecord(which)`            | `SessionRecord` or null      | A schema-checked copy of the `'current'` record, or the sealed `'previous'` or `'ended'` one (ADR 0045)                                                     |
| `discardRecord`       | `dock.discardRecord(which)`            | boolean                      | Drops a sealed record, or restarts the current one from now                                                                                                 |

Calls run under the least of the operator's grant here, the relay's roster and the role the call claims. Revoking someone an invite let in bars them from that invite; for a multi-use link, Revoke closes it unless `closeInvite` is `false`, and `revoke('*')` closes every link and agent token.

`publishState` sends at most two values a second, the latest of a burst last, and returns `{ ok: false, reason }` for a value over 16,384 bytes or one that is not an object, clearing what the relay holds. A script-tag page publishes by dispatching a `tabdock:state` CustomEvent on `document` with the value as its `detail`.

## Invites

`dock.invite(options)` mints an invite on the page, as far as `policy.invites` allows, on a relay with invites on (`TABDOCK_INVITES=1` and a public URL; [Sharing](06-sharing.md)). The secret is 128 bits from WebCrypto, which needs a secure context; only its SHA-256 leaves the page.

| `InviteOptions` field | Type                                                 | Default  | Meaning                                                                   |
| --------------------- | ---------------------------------------------------- | -------- | ------------------------------------------------------------------------- |
| `label`               | 1 to 60 characters                                   | required | Shown wherever the invite appears, as the page's own words                |
| `role`                | `'observer'` (Can watch) or `'driver'` (Can control) | required | Can control needs `invites: 'all'` and prompts the operator on redemption |
| `lifetime`            | `'15m'`, `'1h'` or `'open'`                          | `'1h'`   | `'open'` lasts while the page is open; no invite outlives 24 hours        |
| `uses`                | 1 to 20                                              | `1`      | Can watch only; Can control always has one                                |

The promise resolves once, with `{ ok: true, inviteId, link, expiresAt }`, the link being `<public URL>/i#<secret>`, or with `{ ok: false, reason }`. The reasons: `invalid` (bad options), `policy` (`policy.invites` forbids that role), `link_down`, `unavailable` (no invites on the relay, no WebCrypto, or no answer in 10 s), `no_public_url`, `limit` (10 live per page), `no_sponsor` (no member attached to sponsor it), `duplicate`, `expired` (the page's clock runs behind the relay's) and `cancelled` (closed before the relay answered). The link exists only in that result; the page stores the hash.

## Sessions and agent tokens

`dock.startSession({ label, lengthMinutes, drivers, observers, proposals })` takes whole minutes from 30 to 240, driver seats up to `maxDrivers`, seats by watch invite and who may propose, each no wider than the policy. It resolves with the session's id, its end and the observers' link, shown once, or with a reason: `invalid`, `policy`, `active`, `link_down`, `unavailable`, `unknown`, `length` or `limit`.

`dock.agentToken({ label, lifetime })` takes a lifetime of `'1h'` (the default), `'4h'` or `'8h'` and resolves with the token, its endpoint and a ready `claude mcp add` command, shown once and never stored, or with an invite's reasons. Agent tokens need `TABDOCK_AGENT_TOKENS` on the relay ([Settings for rooms, images and state](14-settings-for-rooms.md)).

## The state

| `DockState` field | Type                                                                            | What it holds                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `link`            | `'idle'`, `'connecting'`, `'linked'`, `'reconnecting'` or `'closed'`            | The page link                                                                                                            |
| `pageId`          | string or null                                                                  | The relay's id for this page session, such as `pg_0123456789`                                                            |
| `pairing`         | `{ code, url?, expiresAt }` or null                                             | The current code, and the QR link when the relay has a public URL                                                        |
| `roster`          | attachments                                                                     | Everyone attached, as the relay lists them: user, kind, role, clients, times, and the invite that made it                |
| `pageRoles`       | one per roster entry                                                            | The role the page itself runs that user's calls under (null for none), and whether a revoke is pending                   |
| `pendingRequests` | attach requests                                                                 | `requestId`, `user`, `account`, `via` (`code`, `qr`, `invite` or `agent`), `invite`, `client`, `expiresAt`               |
| `pendingConfirms` | consequential prompts                                                           | `callId`, `tool`, `caller`, and `expiresAt`, the call's deadline                                                         |
| `notice`          | string or null                                                                  | Advice for the page author, such as the `consequentialHint` fallback                                                     |
| `error`           | string or null                                                                  | Why the link is not working, such as a missing `document.modelContext`                                                   |
| `paused`          | boolean                                                                         | The pause switch                                                                                                         |
| `activity`        | the last 50 calls, newest first                                                 | user, client, tool, outcome, `confirmedBy`, duration, an image's type and size, and the proposal it ran; never arguments |
| `invites`         | live invites                                                                    | Those this page minted and its own record still holds                                                                    |
| `invitesOffered`  | `{ linkBase }` or null                                                          | Null until a relay with invites on says so                                                                               |
| `joins`           | people let in by invite                                                         | Newest first, while their grant lasts                                                                                    |
| `observerSeats`   | people the driver limit held back                                               | Newest first: each `seq`, `user`, `account`, `asked` (`'allow'` or `'promote'`) and `time`, while they stay observers    |
| `policy`          | `Policy`                                                                        | The policy `attach()` was given, with defaults filled in; a copy                                                         |
| `published`       | `'none'`, `'shared'`, `'paused'`, `'too_large'`, `'invalid'` or `'unsupported'` | Whether the page's state reaches the relay: nothing yet, shared, held while paused, refused, or a relay that takes none  |
| `maxImageBytes`   | number or null                                                                  | The largest image this link's relay takes, 0 for none; null until a welcome says                                         |
| `proposals`       | proposals waiting, oldest first                                                 | `proposalId`, `tool`, `proposer`, the arguments as text to read, whether it is consequential, and `expiresAt`            |
| `proposalLog`     | the last 50 proposals decided                                                   | How each left the queue, newest first; never arguments                                                                   |
| `session`         | session or null                                                                 | The running time-boxed session: label, times, the policy it narrows to, observers, its invites and sponsor               |
| `sessionsOffered` | boolean                                                                         | Whether this link's relay takes sessions                                                                                 |
| `sessionEnded`    | `{ sessionId, label, reason, time }` or null                                    | How the last session ended: `'operator'`, `'time'`, `'page_gone'` or `'relay'`                                           |
| `agents`          | live agent tokens                                                               | Label, expiry, state (`dormant`, `asking` or `attached`), timeouts and sponsor; never the token                          |
| `agentsOffered`   | `{ endpoint }` or null                                                          | Null until a relay with agent tokens on says so                                                                          |
| `seatLimits`      | `{ usersPerPage, observersPerPage }` or null                                    | The relay's people limit and watching seats, from its welcome                                                            |
| `records`         | session records held                                                            | Counts and times of the `'current'`, `'previous'` and `'ended'` records, never a name                                    |

Next: [Settings for rooms, images and state](14-settings-for-rooms.md).

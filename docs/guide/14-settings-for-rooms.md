# Settings for rooms, images and state

A page can return images, publish its state and take proposals, and one relay can serve a class: a room of watchers beside the people who drive, a member list that changes without a restart, agent tokens for programs that cannot sign in, and a snapshot that carries pages across a graceful restart. This page lists the settings for those, as [`packages/relay/src/config.ts`](../../packages/relay/src/config.ts) reads them, under the same [value rules](08-relay-settings.md#value-rules) as every other setting: a refusal names the variable and the rule, never the value. [Relay settings](08-relay-settings.md) lists the rest.

## Budgets the whole relay shares

Each applies in every mode, and past each the relay refuses or withholds rather than grows. Hosted mode keeps the same defaults.

| Setting                      | Default   | Hosted default | Unit  | Least             | What it limits                                                                                                                                  |
| ---------------------------- | --------- | -------------- | ----- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `TABDOCK_MAX_IMAGE_BYTES`    | 65536     | 65536          | bytes | 0, at most 524288 | The largest image, decoded, a page may return to a client (ADR 0039); 0 refuses every image                                                     |
| `TABDOCK_MAX_STATE_BYTES`    | 4194304   | 4194304        | bytes | 1048576           | Heap the state every page published may hold together (ADR 0040); past it a new value is withheld, never the page closed                        |
| `TABDOCK_MAX_PROPOSAL_BYTES` | 16777216  | 16777216       | bytes | 1048576           | Heap pending proposals' arguments and kept outcomes may hold together (ADR 0042); past it a proposal is refused `rate_limited`                  |
| `TABDOCK_MAX_RESPONSE_BYTES` | 100663296 | 100663296      | bytes | 4194304           | Bytes `/mcp` answers waiting to be read may hold (ADR 0044); past it strangers' are cut first, then guests', never members': theirs may pass it |

An image travels as base64, a third larger than its bytes. [Which clients show images](18-images-and-state.md#which-clients-show-images) says what Claude Code does with a large one; check with your own client before going past the default.

## Seats on a page

| Setting                          | Default | Hosted default | Unit     | Least                                                      | What it limits                                                                                                                           |
| -------------------------------- | ------- | -------------- | -------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `TABDOCK_MAX_USERS_PER_PAGE`     | 10      | 10             | people   | 1, or 3 with invites; at most 50                           | People attached to one page: members, drivers, and invitees who are not watching by invite                                               |
| `TABDOCK_MAX_OBSERVERS_PER_PAGE` | 40      | 40             | invitees | 0, at most 100; refused without invites                    | The watching seats: invitees watching one page by invite, counted apart from its people (ADR 0044); 0 seats them among people, as before |
| `TABDOCK_MAX_INVITEE_SESSIONS`   | 100     | 100            | sessions | 2, at most `TABDOCK_MAX_SESSIONS`; refused without invites | 2025-era MCP sessions and listen streams all invitees hold together, a pool evicted strangers first                                      |

The two page limits together fit one roster frame, which is why each has a ceiling. With the watching seats on, invitees watching by invite take no people seat at all; any other invite-made attachment, and every one with the seats at 0, leaves members two seats of the people limit. Promoting a watcher to driver leaves them watching while the people limit is full, or while invite-made people fill all but its two member seats, and demoting is always allowed. A relay with invites off sends no watching seats, whatever this says.

The invitee pool's 100 fits one class of 40 at a time, each student holding two sessions and opening a stranger's first as they join. Size it at about 2.4 sessions a student: a relay hosting several classes at once sets `TABDOCK_MAX_INVITEE_SESSIONS` to about 96 for each class of 40, and a class over 40 also raises `TABDOCK_MAX_OBSERVERS_PER_PAGE` (at most 100); the class of 80 was measured with 80 watching seats and a pool of 200 ([room-measure.md](../notes/m6/room-measure.md)).

## Members, agents and restarts

| Setting                    | Modes                                   | Default | Bounds                                                                       | What it does                                                                                                                     |
| -------------------------- | --------------------------------------- | ------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `TABDOCK_MEMBERS_FILE`     | public URL, hosted                      | none    | an absolute path; never beside `TABDOCK_OAUTH_USERS` or `TABDOCK_DEV_TOKENS` | Lists the members in a file the relay reads again within a few seconds of a change, in place of `TABDOCK_OAUTH_USERS` (ADR 0043) |
| `TABDOCK_AGENT_TOKENS`     | dev tokens, public URL, hosted          | 0       | a flag; needs `TABDOCK_INVITES`, and minting needs a public URL              | Serves `/g/mcp`, where a page's agent token reads that page as an observer once the operator allows its first request (ADR 0044) |
| `TABDOCK_RESTART_SNAPSHOT` | with a directory, local mode's included | 0       | a flag; refused without an audit directory                                   | Writes a snapshot at a graceful stop and loads it once at the next start within 10 minutes, so pages resume (ADR 0046)           |

**The members file** holds one `sub=userId:Display Name` per line, written as in `TABDOCK_OAUTH_USERS`, with `#` comments and blank lines allowed, at most 500 entries and 262,144 bytes, and holds no token. The relay looks at it every 2 s and reads a change once the file has held still for one more look, so a change applies within about 4 s and a save in progress is never read. Save a change by writing a new file and renaming it over the old one. A bad file at start stops the relay; a bad, missing or unreadable one later keeps the list it had, and either way the log names line numbers, never their text.

On macOS and Linux the relay refuses the file unless it, every directory above it and the directory of any symbolic link on the way are writable by neither group nor others and owned by the relay's account or root. On Windows it checks no modes, so keep the file in a folder only the relay's account can change.

Removing a member, or giving their subject another user id, ends what is held under the old id as the change applies: every attachment, pending request and `/pair` sign-in at once, with the invites and agent tokens they sponsored and whoever those let in, and an MCP session once its answers are out, within a second at most. A request signed in before the change is refused once its body is read, and its client asked to sign in again ([Larger rooms](20-larger-rooms.md#the-members-file)).

**Agent tokens** let a program that cannot sign in watch one page as an observer for 1, 4 or 8 hours once the operator allows its first request; [Larger rooms](20-larger-rooms.md#agent-tokens) covers minting, approval and what closes one.

**The restart snapshot** is `relay-snapshot.json`, written into the audit directory at mode 0600 when the relay stops gracefully, holding digests and never a token, secret or code; its digest goes into the audit log. It carries pages under their same ids, attachments, live invites, agent tokens and time-boxed sessions, and never pairing codes, pending requests, proposals, sign-ins in progress or published state, which each page sends again as it reconnects. At the next start it loads only if it is under 10 minutes old and the log's last records are that digest followed by the stop. Each page it carries returns asleep with a fresh 10 minute window, however long it had slept.

Every start with an audit directory takes the file and deletes it before deciding anything, whatever the setting, with any temporary file a stop cut short left, so it loads at most once: one found with the setting off goes unread, and a retired relay's file goes at that directory's next start of any kind. A start that cannot delete it warns. When you retire a host for good, delete the file yourself.

Anyone the member list no longer gives the same account comes back with nothing, and what they sponsored goes too, while everyone else takes the name the list gives them now; dev tokens and local mode keep no list, so their members return as they were. A crash, a stale file, a log that does not match or a file from another mode ends everything. So does a deploy that also lowers `TABDOCK_MAX_PAGE_SESSIONS`, `TABDOCK_MAX_USERS_PER_PAGE` or `TABDOCK_MAX_OBSERVERS_PER_PAGE` below what the room holds, drops a page's origin from `TABDOCK_ALLOWED_ORIGINS`, or turns invites or agent tokens off: the start refuses the snapshot whole rather than cut it.

A start also refuses a snapshot written under another `/pair` client secret, so rotating that secret ends everything; leave the setting off while rotating anything else, a dev token included, since that relies on a restart ending every attachment ([deploy.md](../deploy.md#key-rotation-runbook)).

## What each mode refuses

The relay refuses `TABDOCK_MAX_OBSERVERS_PER_PAGE`, `TABDOCK_MAX_INVITEE_SESSIONS` and `TABDOCK_AGENT_TOKENS` without `TABDOCK_INVITES`, and so in local mode; `TABDOCK_MEMBERS_FILE` without a public URL or beside another member list; and `TABDOCK_RESTART_SNAPSHOT` with no audit directory. A people limit over 50, watching seats over 100 or an image cap over 524288 stops the relay at start.

Next: [Limits for rooms, images and state](15-limits-for-rooms.md).

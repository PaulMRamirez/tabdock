# Settings for rooms, images and state

M6 lets a page return images, publish its state and take proposals, and lets one relay serve a class: a room of watchers beside the people who drive, a member list that changes without a restart, agent tokens for programs that cannot sign in, and a snapshot that carries pages across a graceful restart. This page lists the settings for those, as [`packages/relay/src/config.ts`](../../packages/relay/src/config.ts) reads them, under the same [value rules](08-relay-settings.md#value-rules) as every other setting: a refusal names the variable and the rule, never the value. [Relay settings](08-relay-settings.md) lists the rest.

## Budgets the whole relay shares

Each applies in every mode, and past each the relay refuses or withholds rather than grows. Hosted mode keeps the same defaults.

| Setting                      | Default   | Hosted default | Unit  | Least             | What it limits                                                                                                                                  |
| ---------------------------- | --------- | -------------- | ----- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `TABDOCK_MAX_IMAGE_BYTES`    | 65536     | 65536          | bytes | 0, at most 524288 | The largest image, decoded, a page may return to a client (ADR 0039); 0 refuses every image                                                     |
| `TABDOCK_MAX_STATE_BYTES`    | 4194304   | 4194304        | bytes | 1048576           | Heap the state every page published may hold together (ADR 0040); past it a new value is withheld, never the page closed                        |
| `TABDOCK_MAX_PROPOSAL_BYTES` | 16777216  | 16777216       | bytes | 1048576           | Heap pending proposals' arguments and kept outcomes may hold together (ADR 0042); past it a proposal is refused `rate_limited`                  |
| `TABDOCK_MAX_RESPONSE_BYTES` | 100663296 | 100663296      | bytes | 4194304           | Bytes all `/mcp` answers still waiting to be read may hold (ADR 0044); past it strangers' answers are cut first, then guests', never a member's |

An image travels as base64, a third larger than its bytes, and Claude Code caps a tool result at 25,000 tokens unless `MAX_MCP_OUTPUT_TOKENS` raises it, while its docs do not say how an image counts against that; raise the two together, and check with your own client before going past the default.

## Seats on a page

| Setting                          | Default | Hosted default | Unit     | Least                                                      | What it limits                                                                                                                           |
| -------------------------------- | ------- | -------------- | -------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `TABDOCK_MAX_USERS_PER_PAGE`     | 10      | 10             | people   | 1, or 3 with invites; at most 50                           | People attached to one page: members, drivers, and invitees who are not watching by invite                                               |
| `TABDOCK_MAX_OBSERVERS_PER_PAGE` | 40      | 40             | invitees | 0, at most 100; refused without invites                    | The watching seats: invitees watching one page by invite, counted apart from its people (ADR 0044); 0 seats them among people, as before |
| `TABDOCK_MAX_INVITEE_SESSIONS`   | 100     | 100            | sessions | 2, at most `TABDOCK_MAX_SESSIONS`; refused without invites | 2025-era MCP sessions and listen streams all invitees hold together, a pool evicted strangers first                                      |

The two page limits together fit one roster frame, which is why each has a ceiling. With the watching seats on, invited guests never take a member's seat at all; with them at 0, guests leave members two seats of the people limit, as in M5. Promoting a watcher to driver is refused while the people limit is full, and demoting is always allowed. A relay with invites off sends no watching seats, whatever this says.

## Members, agents and restarts

| Setting                    | Modes                                   | Default | Bounds                                                                       | What it does                                                                                                                     |
| -------------------------- | --------------------------------------- | ------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `TABDOCK_MEMBERS_FILE`     | public URL, hosted                      | none    | an absolute path; never beside `TABDOCK_OAUTH_USERS` or `TABDOCK_DEV_TOKENS` | Lists the members in a file the relay reads again within a few seconds of a change, in place of `TABDOCK_OAUTH_USERS` (ADR 0043) |
| `TABDOCK_AGENT_TOKENS`     | dev tokens, public URL, hosted          | 0       | a flag; needs `TABDOCK_INVITES`, and minting needs a public URL              | Serves `/g/mcp`, where a page's agent token reads that page as an observer once the operator allows its first request (ADR 0044) |
| `TABDOCK_RESTART_SNAPSHOT` | with a directory, local mode's included | 0       | a flag; refused without an audit directory                                   | Writes a snapshot at a graceful stop and loads it once at the next start within 10 minutes, so pages resume (ADR 0046)           |

**The members file** holds one `sub=userId:Display Name` per line, written as in `TABDOCK_OAUTH_USERS`, with `#` comments and blank lines allowed, at most 500 entries and 262,144 bytes, and holds no token. On macOS and Linux the relay refuses a file that other accounts may write, or one in a directory they may. Save a change by writing a new file and renaming it over the old one. A bad file at start stops the relay; a bad one later keeps the list it had, and either way the log names line numbers, never their text. Removing a member, or giving their subject another user id, ends every attachment, request, `/pair` sign-in and MCP session held under the old id at once.

**Agent tokens** are minted in the widget, observer only, for one page, for 1, 4 or 8 hours, at most 10 live per page, and shown once with a ready `claude mcp add` command. A token is never approved in advance: its first request raises an ordinary prompt, a deny burns it, and so do three prompts left to time out. Every miss on `/g/mcp`, an unknown token included, is a 404. Use them for Claude Code and scripts, never as a hosted connector.

**The restart snapshot** is written into the audit directory at mode 0600 when the relay stops gracefully, and its digest goes into the audit log. At the next start it loads only if it is under 10 minutes old and the log's last records are that digest followed by the stop; it is deleted before it is applied, and attachments of anyone no longer on the member list are dropped. A crash, a stale file or a log that does not match ends everything, as before. Leave it off while rotating credentials, since that procedure relies on a restart ending every attachment ([deploy.md](../deploy.md)).

## What each mode refuses

The relay refuses `TABDOCK_MAX_OBSERVERS_PER_PAGE`, `TABDOCK_MAX_INVITEE_SESSIONS` and `TABDOCK_AGENT_TOKENS` without `TABDOCK_INVITES`, and so in local mode; `TABDOCK_MEMBERS_FILE` without a public URL or beside another member list; and `TABDOCK_RESTART_SNAPSHOT` with no audit directory. A people limit over 50, watching seats over 100 or an image cap over 524288 stops the relay at start.

Next: [Limits for rooms, images and state](15-limits-for-rooms.md).

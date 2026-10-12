# Larger rooms

A class of 40 can watch one projected tab while the teacher and a few members drive it. This page covers the watching seats and the roster that holds them, how a class joins, the members file that changes without a restart, agent tokens for programs that cannot sign in, and how to size a relay for a class. The settings are on [Settings for rooms, images and state](14-settings-for-rooms.md), and [Lessons and reviews](19-lessons-and-reviews.md) covers sessions and proposals.

## Watching seats

With invites on, invitees watching a page by invite take a watching seat, 40 a page by default (`TABDOCK_MAX_OBSERVERS_PER_PAGE`, at most 100), counted apart from the page's people limit (`TABDOCK_MAX_USERS_PER_PAGE`, 10 by default, at most 50). Members, drivers and any other invite-made attachment are people, and invite-made people always leave members two of those seats. Making a watcher a driver needs a people seat, so on a full page the widget says "The page has no seat left among its 10 people, so Ann is still an observer"; making someone an observer always works. Setting the watching seats to 0 seats watchers among the people, as before M6.

The roster lists People first, then Watching by invite: one compact line each, closed past 8 rows with a count of seats in use, and with a filter by name or short id. An invitee's row lists their two newest clients. Join notices come one per invite: from the third person a link lets in, one line counts them and names the newest. In the Watching section one "Revoke closes their link" box covers every row, and it is ticked again after each Revoke and whenever the section reappears. Revoke on a member's row, and Revoke all, ask first while anyone that member's invites let in is still attached.

Watchers share the projected tab's attention: together 60 calls a minute to a page, 15 for one watcher, and 4 running at once, 2 of them one watcher's. Past the rates or a watcher's 2 a call answers `rate_limited`, pointing to `get_page_state`, which never touches the tab, and while the page's 4 run it answers `page_busy`. These are the room measurement's numbers and options of the relay's code, not settings. Members are held to none of them.

## A class joining

A page takes 30 pairings and redemptions a minute however many invites it holds, so a class of 40 arriving together sees the last ten or so answered `rate_limited` at `/i` until the minute turns. Behind one address, as on a campus network, a hosted relay signs in 10 a minute from it. A Join the page refuses still spends its invite's 30 a minute. Measured, 40 students on their own addresses were all in after 85 s, and 40 behind one address after 190 s ([room-measure.md](../notes/m6/room-measure.md)). Hand the link out a few minutes before class, and ask anyone refused to wait a minute before tapping Join again.

## The members file

In public URL mode, `TABDOCK_MEMBERS_FILE` names a file listing the members, in place of `TABDOCK_OAUTH_USERS`: one `sub=userId:Display Name` a line, `#` comments and blank lines allowed, at most 500 entries and 262,144 bytes, and never a token. The relay looks at it every 2 s and applies a change once the file has held still for one more look, so a save in progress is never read; a file that does not parse keeps the list it had, and the log names line numbers, never their text.

Save a change by writing a new file beside the old one and renaming it over it, which every editor's atomic save does. On macOS and Linux the relay refuses a file that the file itself, any directory above it, or the directory of any symbolic link on the way to it lets group or others write, or that an account other than the relay's or root owns. On Windows it checks no modes, so keep the file in a folder only the relay's account can change.

Adding someone takes effect within about 4 s. Removing someone, or giving their subject another user id, ends at that moment every attachment, pending request, `/pair` sign-in and MCP session held under the old id, with what they sponsored: a request still in flight is refused, and a session still sending answers closes within a second. With `TABDOCK_RESTART_SNAPSHOT` on, a graceful restart within 10 minutes resumes pages, attachments and invites, and anyone the list no longer gives the same account comes back with nothing ([Settings for rooms](14-settings-for-rooms.md#members-agents-and-restarts)).

## Agent tokens

An agent token lets a program that cannot sign in, Claude Code in a script or a CI job, watch one page. The relay needs `TABDOCK_AGENT_TOKENS=1`, invites on and a public URL, and a member attached to sponsor the token. In the widget choose Invite someone, then Agent (Claude Code, no sign-in), a label and a lifetime of 1, 4 or 8 hours, and Create command. The widget shows a ready command once, with Copy and Done, each taking a click only once the box has held still; nothing keeps the token but the program you give it to.

```sh
claude mcp add --transport http --scope local tabdock-1a2b3c4d https://relay.example/g/mcp --header "Authorization: Bearer <token>"
```

That command leaves the token in `claude`'s argument list while it runs, readable by other local accounts, in your shell's history and in `~/.claude.json`, which `claude mcp get` prints in full. To avoid all three, put an entry like this in the project's .mcp.json file and set `AGENT_TOKEN`, not typed at a prompt, where Claude Code runs; Claude Code expands it at each connection:

```json
{
  "mcpServers": {
    "tabdock-agent": {
      "type": "http",
      "url": "https://relay.example/g/mcp",
      "headers": { "Authorization": "Bearer ${AGENT_TOKEN}" }
    }
  }
}
```

A token is never approved in advance: its first request raises an ordinary prompt naming the label and the client, and the operator may allow it only as an observer. A deny burns the token, and so do three prompts left to time out, never one. Once in, it reads and waits like any watcher, held to the watching share, and never proposes.

The agent list's Cancel, Revoke on its row, Revoke all, a session's end, the sponsor leaving and the token's own end each close it. A Cancel or a session's end while its first prompt waits drops the prompt as the page's own act, so the token closes as cancelled or with the session, never as denied; a page whose clock runs ahead closes a token at its third silence as cancelled rather than burned.

Every miss on `/g/mcp`, a closed or unknown token included, is a 404, which Claude Code reports as no MCP endpoint found; a token that closes while a request's body arrives gets it once the body is read. Only a token waiting for its first approval has its body read to name its client, at most 16 KiB of it. Use agent tokens for Claude Code and scripts, never as a hosted connector, which signs in at `/mcp` instead.

## Sizing a class relay

`pnpm measure:room` ran the relay as its image does, in 512 MiB and one CPU. With the whole CPU, a shared-cpu-1x Machine's burst, a chat class of 40 used 4.6% of it and a room of 40 agents about 18%, while a class of 80, or two classes of 40 at once, took up to 7.5% and 31%. At Fly's sustained baseline of 6.25% only a slow chat class of 40 kept up, the teacher's `set_view` taking 3.4 s at the 95th percentile, and nothing larger did, so choose a Machine whose sustained CPU covers the room you expect.

The default invitee pool of 100 sessions fits one class of 40 at a time; a relay hosting several at once sets `TABDOCK_MAX_INVITEE_SESSIONS` to about 96 for each class. Keep the audit log 7 days for a class (`TABDOCK_AUDIT_RETENTION_DAYS=7`), long enough to check a lesson's record and short enough not to keep students' emails for a month.

Next: [the guide's index](README.md).

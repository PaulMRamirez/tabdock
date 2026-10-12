# Larger rooms

A class of 40 can watch one projected tab while the teacher and a few members drive it. The settings are on [Settings for rooms, images and state](14-settings-for-rooms.md), [Lessons and reviews](19-lessons-and-reviews.md) covers sessions and proposals, and [Run a class](21-run-a-class.md) puts it all in order.

## Watching seats

With invites on, invitees watching a page by invite, agent tokens included, take a watching seat, 40 a page by default (`TABDOCK_MAX_OBSERVERS_PER_PAGE`, at most 100), counted apart from the page's people limit (`TABDOCK_MAX_USERS_PER_PAGE`, 10 by default, at most 50). Members, drivers and any other invite-made attachment are people, and invite-made people always leave members two of those seats. Making a watcher a driver needs a people seat, so on a full page the widget says "The page has no seat left among its 10 people, so Ann is still an observer"; making someone an observer always works.

The roster lists People first, then Watching by invite: one compact line each, closed past 8 rows with a count of seats in use, and with a filter by name or short id. An invitee's row lists their two newest clients. Join notices come one per invite: from the third person a link lets in, one line counts them and names the three newest. In the Watching section one "Revoke closes their link" box covers every row, and it is ticked again after each Revoke and whenever the section reappears. Revoke on a member's row, and Revoke all, ask first while anyone that member's invites let in is still attached.

Watchers share the projected tab's attention: together 60 calls a minute to a page, 15 for one watcher, and 4 running at once, 2 of them one watcher's. Past the rates or a watcher's 2 a call answers `rate_limited`, pointing to `get_page_state`, which never touches the tab, and while the page's 4 run it answers `page_busy`. They are fixed in the relay's code, not settings. Members are held to none of them. With `TABDOCK_MAX_OBSERVERS_PER_PAGE=0`, invitees who watch count among the people, as on a relay without watching seats, and no share applies.

## A class joining

A page takes 30 pairings and redemptions a minute however many invites it holds, so a class of 40 arriving together sees the last ten or so answered `rate_limited` at `/i` until the minute turns. `/i` signs in 60 people a minute for the whole relay (`TABDOCK_MAX_PAIR_SIGNINS_PER_MINUTE`), and a hosted relay 10 a minute from one address, as on a campus network. A Join the page refuses still spends its invite's 30 a minute, and a sign-in at `/i` lasts 15 minutes.

Measured, 40 students on their own addresses were all in after 85 s, and 40 behind one address after 190 s ([room-measure.md](../notes/m6/room-measure.md)). Hand the link out a few minutes early, and ask anyone refused to tap Join again a minute later.

## The members file

In public URL mode, `TABDOCK_MEMBERS_FILE` names a file of members in place of `TABDOCK_OAUTH_USERS`, which the relay rereads within about 4 s of a save, with no restart; its format and the rules a save must meet are on [Settings for rooms](14-settings-for-rooms.md#members-agents-and-restarts). List those who pair by code and sponsor guests: the teacher, co-teachers and assistants. Students join by link and are never listed. Each line starts with the member's `sub`, the id their provider gives their account; on WorkOS it is the user ID (`user_...`) under Users once they have signed up ([deploy.md](../deploy.md#workos-authkit-production-workos)).

Removing someone ends at once everything held under their id, with the invites and agent tokens they sponsored and whoever those let in, so a co-teacher removed mid-lesson takes their guests along. With `TABDOCK_RESTART_SNAPSHOT` on, a graceful restart within 10 minutes resumes pages, attachments, invites, agent tokens and the session, and anyone the list no longer gives the same account comes back with nothing ([the snapshot's rules](14-settings-for-rooms.md#members-agents-and-restarts)). A revoke's bar on an invite link stays with the account whatever the file later says, never passing to a freed id's next holder.

## Agent tokens

An agent token lets a program that cannot sign in, such as Claude Code on a lab computer, watch one page. The relay needs `TABDOCK_AGENT_TOKENS=1`, invites on and a public URL, and a member attached to sponsor the token. In the widget choose Invite someone, then Agent (Claude Code, no sign-in), a label and a lifetime of 1, 4 or 8 hours, and Create command. The widget shows a ready command once, with Copy and Done, each taking a click only once the box has held still; nothing keeps the token but the program you give it to.

The command holds the token in full, so mint it before you project the tab, or with the projector off, and click Done at once; the form opens again at Can watch, never at Agent.

The page's `policy.invites` must not be `'off'`: there the widget hides the form, `dock.agentToken()` refuses with `policy`, and the relay denies the token's request with "the page takes no invited guests now".

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

A token is never approved in advance: its first request raises an ordinary prompt naming the label and the client, and the operator may allow it only as an observer, so a job can watch only while someone is at the tab to allow that request. A deny burns the token, and so do three prompts left to time out, never one. Once in, it reads and waits like any watcher, held to the watching share, and never proposes. [Join a shared page](22-join-a-shared-page.md#with-an-agent-token) gives the client's side.

The agent list's Cancel, Revoke on its row, Revoke all, a session's end, the sponsor leaving, the agent's own `detach_page`, its attachment idling out and the token's own end each close it. A Cancel or a session's end while its first prompt waits drops the prompt as the page's own act, so the token closes as cancelled or with the session, never as denied; a page whose clock runs ahead closes a token at its third silence as cancelled rather than burned.

Every miss on `/g/mcp`, a closed or unknown token included, is a 404, which Claude Code reports as no MCP endpoint found. Only a token waiting for its first approval has its body read to name its client, at most 16 KiB of it. Use agent tokens for Claude Code and scripts, never as a hosted connector, which signs in at `/mcp` instead.

## Sizing a class relay

`pnpm measure:room` ran the relay as its image does, in 512 MiB and one CPU. With the whole CPU, a shared-cpu-1x Machine's burst, a chat class of 40 used 4.6% of it and a room of 40 agents about 18%, while a class of 80, or two classes of 40 at once, took up to 7.5% and 31%. At Fly's sustained baseline of 6.25% only a slow chat class of 40 kept up, the teacher's `set_view` taking 3.4 s at the 95th percentile. A class Machine stays at 512 MB, so anything larger leans on its burst balance ([deploy.md](../deploy.md#sizing-for-a-class)).

A class over 40 raises `TABDOCK_MAX_OBSERVERS_PER_PAGE`: the class of 80 ran with 80 watching seats and an invitee pool of 200, and a relay hosting several classes sizes its pool as [Settings for rooms](14-settings-for-rooms.md#seats-on-a-page) says. Keep the audit log 7 days for a class (`TABDOCK_AUDIT_RETENTION_DAYS=7`), long enough to check a lesson's record, short enough not to keep students' emails for a month.

Next: [Run a class](21-run-a-class.md).

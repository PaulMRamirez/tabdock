# Run a class

This page walks one lesson on one projected tab in order, from the relay's settings to a saved record matched against the audit log. Each step links the page that holds its rules and numbers; this one restates none of them.

**Status: not yet run live with a class.** `pnpm demo:m6` rehearses a lesson on one machine against a stand-in provider and tunnel, with the join limits raised so forty students join in seconds: a members file changed with no restart, a session ending on the page's clock, forty watchers on two watch links minted in the Invite form, a student's proposal accepted in the widget, a restart from the snapshot and the record held to the log. It never meets the `rate_limited` of a real class arriving, nor projects a session's QR.

`pnpm measure:room` sized a 512 MiB relay for classes of 40 and 80 ([Larger rooms](20-larger-rooms.md#sizing-a-class-relay)). Whether hosted Claude's model reads a page's pictures, and how long a stop takes on the reference host, wait on the owner's run.

```mermaid
flowchart LR
  relay["Relay and members"] --> page["Page policy"]
  page --> pair["Pair your own Claude"]
  pair --> session["Start the session, project the QR"]
  session --> join["Students join at /i"]
  join --> lesson["Read, wait, propose, accept"]
  lesson --> record["Save the record, match it"]
```

## Rehearse on one computer

Invite links, a session's observers and agent tokens exist only on a relay with a public URL; dev tokens can turn invites on for testing but mint none of them ([Run a relay](07-run-a-relay.md#choose-a-mode)). So even a rehearsal by hand needs a tunnel with a fixed https name and an identity provider, set up as [Run a relay](07-run-a-relay.md#public-url-through-a-tunnel) says; the project ships no stand-in for them outside its tests. Without them, only `pnpm demo:m6` rehearses a class, on the stand-in provider and tunnel in `packages/relay/test/helpers/`.

With them, rehearse on the demo board: open the board link `pnpm dev:public` prints with `&proposals=all` added, so everyone watching may propose. Its image tool is `capture_board` and its consequential one `clear_board`, where the example below has a map page's `capture_view` and `reset_edits`. The canvas map page from `pnpm dev:map` also works once `TABDOCK_ALLOWED_ORIGINS` lists `http://127.0.0.1:5174`, but its Connect button always attaches with proposals off ([Map and globe pages](16-map-pages.md#worked-examples)). Without a public URL, [Sharing](06-sharing.md#try-sharing-on-one-computer) still rehearses proposals with two dev-token users, and in local mode a session is a time box alone.

## Before term

Run a relay at a public URL, through a tunnel or on a host ([Run a relay](07-run-a-relay.md), [deploy.md](../deploy.md)), with `TABDOCK_INVITES=1`, an audit directory in `TABDOCK_AUDIT_DIR` and `TABDOCK_AUDIT_RETENTION_DAYS=7`. Add `TABDOCK_RESTART_SNAPSHOT=1` if you may deploy during a lesson, and for a class over 40 raise the watching seats and the invitee pool as [Settings for rooms](14-settings-for-rooms.md#seats-on-a-page) says. Through a tunnel, `pnpm dev:public` prints whether invites, agent tokens and the restart snapshot are on; elsewhere the relay's `relay_start` audit record says.

List yourself, co-teachers and assistants in the members file: members pair by code and sponsor guests, while students join by link and are never listed ([Larger rooms](20-larger-rooms.md#the-members-file)).

## The page

Give the page a policy that takes watch invites and proposals from everyone, declares its image tool, and names its irreversible tools, here `reset_edits`, since MCP-B 5.1 drops `consequentialHint` and a page naming none prompts for every write; a page with none sets `consequential: 'allow'` instead ([Adapter reference](04-adapter-reference.md#the-policy)).

```ts
import { attach } from '@tabdock/adapter';

attach({
  relay: 'wss://relay.example/page',
  policy: {
    invites: 'watch',
    proposals: 'all',
    imageTools: ['capture_view'],
    consequentialTools: ['reset_edits'],
  },
});
```

That page dials a hosted relay. With a tunnel, the projected tab runs on the relay's computer and dials `ws://127.0.0.1:8787/page`, since `/page` refuses whatever came through the tunnel.

## Before class

Add the relay's connector to your own Claude and pair it with the widget's code as a member, before anyone else ([Connect clients](05-connect-clients.md), [Sharing](06-sharing.md#approve-and-choose-a-role)). Your attachment sponsors the session's watch links, so it must not end or idle out before the lesson does, or every student leaves with it; the session block warns when it may.

A few minutes early, choose Start a session: a label, the length, one driver seat, the observers you expect and proposals from all ([Lessons and reviews](19-lessons-and-reviews.md#time-boxed-sessions)). The form names you as the sponsor before Start, and says why if Start is refused: for more observers than the relay's watching seats, it names `TABDOCK_MAX_OBSERVERS_PER_PAGE`. After Start the widget shows the first watch link with uses left as a QR code; project it (Hide QR hides it, Show QR brings it back), and tell the room the widget keeps a record of who joined and every call.

Links show once, so after a reload the widget offers New link, which closes the earlier links: anyone holding an old one needs the new one. Mint any agent tokens before you project the tab, or with the projector off, and click Done at once, since the widget shows each command with its token ([Larger rooms](20-larger-rooms.md#agent-tokens)).

## Students join

Students open the link in their phone's browser, never in Claude, sign in at `/i` and tap Join, then add the connector `/i` shows in Claude on the web or the desktop app with the same account ([Join a shared page](22-join-a-shared-page.md)). Near the start some meet `rate_limited`, since a page takes pairings at a fixed rate and a hosted relay limits sign-ins from one address; they tap Join again a minute later ([Larger rooms](20-larger-rooms.md#a-class-joining)).

## During class

Each student's Claude reads the view with `get_page_state`, follows it with `wait_for_page_state`, looks with `capture_view` and proposes stops. You accept the good ones in the widget; Accept is that call's confirmation, so no second prompt follows ([Lessons and reviews](19-lessons-and-reviews.md#proposals)). Watchers share a few calls a minute to the projected tab, and state reads spend none of them, so steer the room to state ([Limits for rooms](15-limits-for-rooms.md)). Extend adds time; End session asks first.

## A deploy mid-lesson

With the snapshot on, a graceful deploy that starts again within 10 minutes keeps pages, attachments, invites, the session and agent tokens. It drops pending proposals and their waits, attach requests, pairing codes and sign-ins in progress, and students see `page_asleep` until the tab reconnects. A deploy that also lowers the seats or drops the page's origin refuses the snapshot whole, and everyone pairs again ([Settings for rooms](14-settings-for-rooms.md#members-agents-and-restarts)).

## After class

When the session ends the widget offers its record; choose Save JSON. From a host, copy the audit files for the lesson's days off it ([deploy.md](../deploy.md#reading-the-audit-log)) and run, on your own computer:

```sh
pnpm audit:log --dir <dir> --match <file> --verify
```

Its last line reads `match: agrees with the log` when the record and the log agree call by call; give `--dir` every file the lesson spans ([Lessons and reviews](19-lessons-and-reviews.md#the-session-record)). With a tunnel the files are on this computer already: run it in the clone, where `--dir` is optional, since `pnpm audit:log` reads `TABDOCK_AUDIT_DIR` from `.env`.

Next: [Join a shared page](22-join-a-shared-page.md).

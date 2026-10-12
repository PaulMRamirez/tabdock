# Use cases

Most MCP servers wrap a server's API. Tabdock wraps the page: its tools are functions the app already runs in the browser, with the user's session and unsaved state, so an agent works through the code a person clicks through, your back end gains nothing new, and the person at the tab decides who attaches and confirms what matters ([Concepts](01-concepts.md)).

Each pattern gives the app and how people use it, then its status. **Works today** means from a clone, checked in the sandbox; **needs settings**, a public URL with an identity provider, or a host ([Run a relay](07-run-a-relay.md)); **not yet run live**, tested only against stand-ins. Installing from npm waits for 0.1.0, and the features for rooms, images and state for the release after it; until then, use a clone.

## Drive the app you are building

A React admin dashboard at `http://localhost:5173` registers `get_state` and `list_rows` as read-only, `apply_filter` and `fill_form` as writes, and `submit_order` as consequential, by its hint and in `policy.consequentialTools`. Claude Code on the same laptop pairs with the widget's code; the developer clicks Allow as driver once and answers a prompt for each `submit_order`, or sets `confirmVia: 'client'` to answer it in Claude Code.

**Works today.** Confirmation in the client is tested with SDK clients; Claude Code's dialog with a person at it awaits the owner's run.

## An agent interface for an app with no API

A front end over a legacy back end, whose only authorised client is the signed-in browser, wraps `read_table` (read-only), `fill_form` (a write) and `submit_form` (consequential) under `consequential: 'confirm'`. No credential leaves the browser, and results reach the model labelled untrusted.

**Works today** from Claude Code on the same machine; another origin goes in `TABDOCK_ALLOWED_ORIGINS`, and an https page dialling a loopback relay meets Chrome's Local Network Access prompt. Claude on the web **needs settings**; not yet run live.

## Your phone as a remote for a tab on your laptop

A review queue on the laptop offers `get_progress` (read-only), `next_item` and `mark_item` (writes). Its owner scans the widget's QR code with the phone, signs in at `/pair`, taps Join and clicks Allow on the laptop; every Claude on that account then shares the attachment.

**Needs settings; not yet run live.** Public URL mode (`pnpm dev:public` names its six settings); `pnpm demo:m3` covers it with a stand-in provider. Background-tab survival is unmeasured.

## A shared team surface

Teammates, each with their own Claude, work an incident console: `list_cards` (read-only), `add_card` and `move_card` (writes), `archive_sprint` (consequential), with `maxDrivers: 3`. Writes run in arrival order, Pause stops new calls, and the audit log records who did what.

**Works today** in code (A2.1 to A2.5). Teammates elsewhere **need settings**: each a member of a public or hosted relay, whose members file adds or removes someone without a restart.

## A watch-only guest

During an incident the operator mints a Can watch invite. The guest opens the link at `/i`, signs in with any account and joins as an observer with no prompt; the tab shows the guest's verified email or "unverified account", an invited badge and Revoke.

**Needs settings; not yet run live.** Public URL mode, `TABDOCK_INVITES=1` and a member attached as sponsor; Playwright runs it against a stand-in provider. [Join a shared page](22-join-a-shared-page.md) is the guest's side.

## Hand control to a guest under supervision

For pair debugging the page sets `invites: 'all'` and `maxDrivers: 2`. A one-use Can control link prompts the operator at redemption, and the guest drives beside the operator's client; consequential calls still prompt on the page.

**Needs settings; not yet run live.** `pnpm demo:m4` runs it with a stand-in provider; the link burns after three refusals or timeouts.

## An unattended read-only status wall

A wall-screen dashboard registers only read-only tools and sets `autoApprove: 'observer'` and `invites: 'off'`, so members who pair become observers with no click.

**Works today** on the screen's machine; other machines **need settings**. Whether the tab stays awake is unmeasured. With the restart snapshot on, a graceful restart within 10 minutes keeps the wall's attachments; only a crash, or a restart without it, means pairing again.

## A class following one map

A teacher projects a page that follows the [map profile](16-map-pages.md), starts a time-boxed session and hands out its watch link; each student's Claude reads and captures the view, waits on its state and proposes stops, which the teacher accepts.

**Needs settings; not yet run live with a class.** Public URL mode with invites. `pnpm demo:m6` runs every leg on one machine in about 45 s against a stand-in provider, and `pnpm measure:room` sized a 512 MiB relay for classes of 40 and 80; a session with 40 observers mints two watch links. [Run a class](21-run-a-class.md) gives the steps.

## Check a walkthrough on every change

A CI job starts a local-mode relay and a map page, clicks Allow in the widget as a person would, and walks every stop, checking each view, clock, picture and published state ([Check a page from CI](17-check-from-ci.md)).

**Works today** from a clone with `pnpm ci-check`, which this repository's CI runs; copying it elsewhere waits for the release after 0.1.0. The advisory walk has run only against a stand-in model, and Windows runners are not covered.

## An agent that watches a page

Claude Code on a lab computer follows one page with no sign-in: the operator mints an agent token in the widget and hands over the command it shows ([Larger rooms](20-larger-rooms.md#agent-tokens)).

**Needs settings:** a public URL, `TABDOCK_INVITES`, `TABDOCK_AGENT_TOKENS` and a page whose invites are not off. Claude Code 2.1.296 connected with the printed command, headless against a stand-in (`docs/notes/verified.md`, 11 October). A person must allow its first request, so it is no unattended job.

## A time-boxed review with a record

A review runs for 45 minutes: a session narrows who drives, reviewers propose changes, and at its end the widget offers a record of who attached and every call, which `audit --match` holds to the log ([Lessons and reviews](19-lessons-and-reviews.md)).

**Works today** in local mode as a time box with a record and `audit --match`; reviewers by invite **need settings**.

## Keep the room through a deploy

With `TABDOCK_RESTART_SNAPSHOT` on, a relay deployed mid-lesson puts back pages, attachments, invites, sessions and agent tokens at a start within 10 minutes, so tabs resume and nobody pairs again ([Settings for rooms](14-settings-for-rooms.md#members-agents-and-restarts)).

**Needs settings.** `restart-snapshot.test.ts` and `record-restart.test.ts` hold it; how long a stop takes on Fly is the owner's to measure.

## One connector, many tabs

An issue tracker, a docs page and a design tool each load the adapter and are approved separately; Claude moves information between them under one connector, and with `TABDOCK_FIRST_CLASS_TOOLS=1` lists their tools by name beside its own, such as `pg_0123456789__add_item` ([Connect clients](05-connect-clients.md#first-class-tools)). **Works today** for tabs on the relay's machine (first-class tools with Claude Code 2.1.289); others **need settings**. Never hard-code those names, which carry the page id.

## When MCP-B's local relay fits better

MCP-B's local relay suits one person on one machine with a stdio client: each page tool becomes an MCP tool with no approval, roles or prompts. Choose Tabdock for hosted Claude, several people or clients on one page, approval and roles, consequential prompts or an audit trail ([the comparison](../mcp-b-comparison.md)).

## Not yet

No agent drives a page with nobody present on a public relay: an agent token only reads, once a person allows its first request (ADR 0044), and only local mode's owner token or dev tokens drive unattended, on the relay's machine, as [a CI check](17-check-from-ci.md) does (ADR 0041). A crash still ends every page session, attachment and invite: the restart snapshot, off by default and needing an audit directory, carries pages, attachments, invites, sessions and agent tokens only across a graceful stop of under 10 minutes, never pairing codes. Stock connectors allow no end-to-end encryption, so the relay always sees calls in plain text.

Next: [Security](10-security.md).

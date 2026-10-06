# Use cases

Most MCP servers wrap a server's API. Tabdock wraps the page: its tools are functions the app already runs in the browser, with the user's session and unsaved state, so an agent works through the code a person clicks through, your back end gains nothing new, and the person at the tab decides who attaches and confirms what matters ([Concepts](01-concepts.md)).

Each pattern gives the app, how its tools are marked, the policy, who attaches from where and what the operator sees, then its status. **Works today** means from a clone, checked in the sandbox; **needs settings**, a public URL with an identity provider, or a host ([Run a relay](07-run-a-relay.md)); **not yet run live**, tested only against stand-ins. `npm install @tabdock/adapter` and `npx @tabdock/relay` work once 0.1.0 is on npm; until then, use a clone.

## Drive the app you are building

A developer's React admin dashboard at `http://localhost:5173` registers `get_state` and `list_rows` with `readOnlyHint: true`, `apply_filter` and `fill_form` as writes, and `submit_order` with `consequentialHint: true`, also named in `policy.consequentialTools`. Claude Code on the same laptop adds the local-mode connector and pairs with the widget's code; the developer clicks Allow as driver once, watches the activity log, and answers a prompt for each `submit_order`, or sets `confirmVia: 'client'` to answer it in Claude Code.

**Works today.** Confirmation in the client is tested with SDK clients on both MCP revisions; Claude Code's dialog with a person at it awaits the owner's run (`docs/checklists/M5.md`).

## An agent interface for an app with no API

A front end over a legacy back end, or an internal tool whose only authorised client is the signed-in browser, wraps `read_table` (read-only), `fill_form` (a write) and `submit_form` (consequential) under `consequential: 'confirm'`, so every submit asks the person at the tab. No credential leaves the browser, the origin comes from the browser's own header, and results reach the model labelled untrusted.

**Works today** from Claude Code on the same machine. Another origin goes in `TABDOCK_ALLOWED_ORIGINS`, an https page dialling a loopback relay meets Chrome's Local Network Access prompt, and the WebMCP polyfill loads before the adapter. Claude on the web **needs settings**; not yet run live.

## Your phone as a remote for a tab on your laptop

A review queue on the laptop offers `get_progress` (read-only) and `next_item` and `mark_item` (writes). Its owner scans the widget's QR code with the phone, signs in at `/pair`, taps Join and clicks Allow on the laptop; Claude on the phone, Claude desktop and Claude Code then share that attachment, since it belongs to the account.

**Needs settings; not yet run live.** Public URL mode: a tunnel with a fixed https name, a provider meeting `SPEC.md` section 7, a confidential client for `/pair`, the six settings `pnpm dev:public` names, and the page on the relay's machine. `pnpm demo:m3` covers it with a stand-in provider and a phone-sized browser; background-tab survival is unmeasured.

## A shared team surface

Teammates, each with their own Claude, work an incident console: `list_cards` (read-only), `add_card` and `move_card` (writes), `archive_sprint` (consequential). The page sets `maxDrivers: 3`, since with the default of 1 later approvals are seated as observers. The roster shows each person and their clients with a role switch and Revoke; writes run in arrival order, `archive_sprint` asks first, Pause stops new calls, and the audit log records who did what.

**Works today** in code (acceptance tests A2.1 to A2.5). Teammates on other machines **need settings**: public URL mode with each in `TABDOCK_OAUTH_USERS` and the tab on the relay's machine, or hosted mode. Adding a member means a restart, which ends every pairing. A page holds 10 people by default.

## A watch-only guest

During an incident the operator mints a Can watch invite for 15 minutes, an hour or while the page is open. The guest opens the link at `/i`, signs in with any account at the provider and joins as an observer with no prompt. The tab shows a join notice with the guest's verified email or "unverified account", an invited badge and Revoke.

**Needs settings; not yet run live.** Public URL mode, `TABDOCK_INVITES=1`, the default `invites: 'watch'`, and a member attached as sponsor. Playwright runs it against a stand-in provider. A multi-use link works only at `/i` in a browser, since `pair_page` takes one-use links; invites last at most 24 hours and 20 uses.

## Hand control to a guest under supervision

For a demo or pair debugging, the page sets `invites: 'all'` and `maxDrivers: 2` and keeps `consequential: 'confirm'`. A one-use Can control link prompts the operator at redemption, naming the account and the invite's label, and the guest then drives beside the operator's client. Consequential calls still prompt on the page: invitees never confirm in their own client or see first-class tools.

**Needs settings; not yet run live.** Without a free driver seat the guest is seated as an observer, and the link burns after three refusals or timeouts. `pnpm demo:m4` runs it with a stand-in provider.

## An unattended read-only status wall

A wall-screen dashboard registers only read-only tools and sets `autoApprove: 'observer'` and `invites: 'off'`. Members type its code or scan its QR code from their own Claude and become observers with no click; nobody drives unless someone at the screen promotes them.

**Works today** for clients on the screen's machine; the QR code and other machines **need settings**. The tab must stay awake, which is unmeasured, and a relay restart means pairing again.

## Page tools as the client's own tools

With `TABDOCK_FIRST_CLASS_TOOLS=1`, Claude Code lists a page's tools by name, such as `pg_0123456789__add_item`, beside its own and calls them through the same checks, queue and prompts as `call_page_tool`. Observers see the read-only ones, invitees none.

**Works today** (A5.1; Claude Code 2.1.289 listed and called one on both revisions). Names embed the page id, which changes with a new tab or a restart, so never hard-code them; a tool name over 49 characters stays reachable only through `call_page_tool`. Hosted Claude is not yet run live.

## One connector, many tabs

An issue tracker, a docs page and a design tool each load the adapter and are approved separately. Claude finds them with `list_pages` and moves information between them under one connector; each operator sees only their own roster and activity.

**Works today** for tabs on the relay's machine, with each origin on the allowlist; tabs on other people's machines **need settings** (hosted mode).

## When MCP-B's local relay fits better

MCP-B's local relay suits one person on one machine with a stdio client: the client starts it, the page finds it on loopback, and each page tool becomes an MCP tool with no approval, roles or prompts. Choose Tabdock for Claude on the web or phone, several people or clients on one page, approval and roles, consequential prompts or an audit trail. [The comparison](../mcp-b-comparison.md) goes axis by axis.

## Not yet

Unattended agents and CI against a public relay, such as a nightly job reading a dashboard with nobody to sign in, are not supported: a public relay needs an interactive sign-in, and page-scoped observer tokens on `/g/mcp` (ADR 0016) are a backlog item for after M5. Only local mode's owner token or dev tokens work without a person, on the relay's machine. Nor do pairings survive a restart: a restart or deploy ends every page session, pairing and invite, and a snapshot to carry them across a planned restart is a later item (`docs/plans/backlog.md`). Stock connectors allow no end-to-end encryption, so the relay always sees calls in plain text.

Next: [Security](10-security.md).

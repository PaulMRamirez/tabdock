# Troubleshooting

What a failed call means and what to do, in the words of [Concepts](01-concepts.md). Your client's tool error starts with a code, the widget shows what the adapter decided, and the relay's log names each refusal. [Setup problems and limits](12-setup-and-limits.md) covers what fails before any call, and the When it goes wrong sections of [Images and page state](18-images-and-state.md#when-it-goes-wrong), [Lessons and reviews](19-lessons-and-reviews.md#when-it-goes-wrong) and [Join a shared page](22-join-a-shared-page.md#when-it-goes-wrong) cover their own features.

## Error codes

A refusal reaches the client as a tool error, `<code>: <reason>` in the relay's words, so match on the code ([errors.ts](../../packages/protocol/src/errors.ts)). The adapter's own page codes ([page-link.ts](../../packages/protocol/src/page-link.ts)) map onto these (`PAGE_ERRORS` in [hub.ts](../../packages/relay/src/hub.ts)); the last two are page codes.

### `not_attached`

You hold no attachment to that page: you never paired, the operator revoked you, it went unused for 8 hours, an invite-made attachment reached its end, a time-boxed session ended, your sponsor left, your agent token closed, the member list dropped you, or the page id is stale, as in a first-class name from before a new tab or a restart. A stranger and an unknown page get the same answer (S13). **What to do:** run `list_pages` and list tools again. Pair again with the page's current code, or ask the operator for a new invite link or token.

### `role_denied`

You are an observer and the tool is not marked `readOnlyHint: true`, by the relay's check or the page's own. The page also answers it for a caller its operator never approved. **What to do:** ask the operator to make you a driver; a page that takes proposals from you proposes the write instead ([proposals](19-lessons-and-reviews.md#proposals)). A page author whose read tool is refused marks it `readOnlyHint: true`.

### `tool_not_found`

The page lists no tool by that name now, or you used a first-class name on an attachment an invite made. **What to do:** run `list_page_tools` again, since tools come and go with the page, and use `call_page_tool` with the tool's own name.

### `page_asleep`

The tab disconnected (reload, close, freeze, network) or is reconnecting and has not listed its tools yet, a pairing or a wait on it ended, the relay is shutting down, or your agent token's page is not connected. Attachments are kept for 10 minutes. **What to do:** retry in a moment, pairing with the page's new code if a pairing was waiting.

### `page_gone`

The page stayed away past 10 minutes, or detached while your call ran. It shows as gone in `list_pages` for 10 more minutes. **What to do:** its attachments are over; pair again by its new code.

### `denied_by_operator`

The operator denied your attach request or a consequential call, a consequential prompt went unanswered until the deadline, the page's policy denies consequential tools (a proposal for one included), or the operator revoked you, closed your invite or its sponsor left while you waited. An agent token hears "this agent token is no longer live", or "the page takes no invited guests now, agents included". **What to do:** ask the operator; nothing retries on its own.

### `timeout`

The page did not answer within 45 seconds, the call waited 45 seconds behind other writes and never ran, your client or the page cancelled it or a wait, `pair_page` stopped waiting after 50 seconds, an attach request went unanswered for 60 seconds, or the operator has not been asked about your agent token yet. **What to do:** retry a call. After a `pair_page` timeout the request stays open for its 60 seconds, so look in `list_pages` before pairing again; an agent calls `pair_page` again.

### `page_busy`

The operator paused the page, 32 writes already wait at the relay or on the page, the page holds its people already, the seats invites may use are full, another redemption of the same invite is waiting, the relay holds all the waiting requests it allows, the page's link has no room for a proposal, 8 image calls already wait on the page, or 4 of its watchers' calls are running. **What to do:** retry shortly; the operator can resume, or revoke someone to make room.

### `pairing_expired`

The code or QR link is wrong, used or older than 120 seconds; the invite link is unknown, used up, cancelled, expired, or minted for several uses, which `pair_page` never takes; an agent token closed while its request waited; or a member list change ended your user id meanwhile. **What to do:** pair with the widget's current code within two minutes, open a multi-use invite link at `/i` in a browser, or ask for a new link.

### `rate_limited`

Past a budget: requests to the relay (240 a minute for a member, 60 for an invitee), 120 calls a minute to one page, 10 pairing attempts a minute per account or 30 per page, 30 redemptions of one invite a minute, four confirmations already waiting in your clients, or the memory your waiting requests may hold. **What to do:** wait a minute and retry. A relay's operator can raise some of these ([Relay settings](08-relay-settings.md)).

It also answers a third wait of yours, or one past the page's waits (its people plus watching seats, invitees two fewer); a fourth pending proposal of yours on a page or a twenty-first on it, a place a withdrawn proposal holds for its minute, your share of the relay's proposals, or the relay holding all `TABDOCK_MAX_PROPOSAL_BYTES` allows; and, while watching seats are on, a watcher past the page's share: 60 calls a minute for all its watchers, 15 for one and 2 running. A watcher's refusal points to `get_page_state`, which never touches the page.

### `invalid_arguments`

The arguments failed the tool's `inputSchema` at the relay, would not fit one 1 MiB page link frame, held a proposal over 16,384 bytes or 1,000 values, or a fixed tool's own input was wrong, such as `pair_page` with both or neither of `code` and `invite`. The schema check is advisory: one that cannot finish within 50 ms lets the call through (ADR 0010). **What to do:** read the schema with `list_page_tools` and call again.

### `invite_required`

Your account, signed in but not on the member list, is an invitee, and offered a pairing code or QR link, which only members use (ADR 0017). **What to do:** ask the operator for an invite link: a single-use one for `pair_page`, or any live one opened in a browser.

### `not_confirmed`

On a page with `confirmVia: 'client'`, your client did not confirm the call: declined, dismissed, expired after 120 seconds, already used, given for other arguments, another tool or page, or held from before a relay restart. The page never heard of the call (ADR 0026). **What to do:** call again and accept the question your client shows. A client with no person at it, such as headless `claude -p`, may decline at once.

### `proposal_not_found`

No proposal of yours has that id on that page: unknown, forgotten 10 minutes after it ended, or someone else's, which reads the same (ADR 0042). **What to do:** use the id `call_page_tool` returned.

### `tool_error`

A page code: the page's handler threw. The client gets the page's error text under the untrusted label, flagged `isError`, with no code; [Writing handlers](03-add-to-your-app.md#writing-handlers) shows each runtime's text. The relay answers the same way when it refuses a page's image, the text after the label reading `tabdock refused this tool's image: <reason>`: the tool is not declared, images are off, not PNG, JPEG or WebP, base64 not canonical, over the cap, wrong first bytes, bad dimensions, or animated ([Images and page state](18-images-and-state.md)). **What to do:** read it as page data; the fix is in the page or the arguments.

### `cancelled`

A page code: the page ended a call it had started, or a client's cancellation reached it. The client sees `timeout`. **What to do:** as for `timeout`.

## Failures without a code

| Answer                                                                         | What it means, and what to do                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON-RPC error -32602, `Tool <name> not found`                                 | The relay serves no such name: neither a fixed tool nor shaped `<page id>__<tool>`, or any first-class name while `TABDOCK_FIRST_CLASS_TOOLS` is off. A stale first-class name gets `not_attached`, or `page_gone` just after its page went. |
| JSON-RPC error -32000, `more than 240 requests to this relay in 1 minute; ...` | Past the request budget on a request no tool answers, such as `tools/list`; on 2026-07-28 it comes with HTTP 429. Wait a minute.                                                                                                             |
| HTTP 401 with `WWW-Authenticate`                                               | No token or a wrong one, or a request signed in before a member list change ended its user id. Sign in again; for local mode, see [Setup problems](12-setup-and-limits.md#setup-problems).                                                   |
| HTTP 404, `Session not found`                                                  | A 2025-era session idle for 30 minutes, or another user's. The client opens a new one.                                                                                                                                                       |
| HTTP 413                                                                       | One request would hold more of the relay's memory than one user's requests may. Send less.                                                                                                                                                   |
| HTTP 404 on `/g/mcp`                                                           | The agent token is unknown, cancelled, burned, revoked or past its end; Claude Code says no MCP endpoint was found. Ask the operator for a new one.                                                                                          |

Next: [Setup problems and limits](12-setup-and-limits.md).

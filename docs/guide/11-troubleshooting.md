# Troubleshooting

What a failed call means and what to do, in the words [Concepts](01-concepts.md) defines. Three places say what happened: the tool error in your client, which starts with a code; the widget, whose roster, activity list and notice line show what the adapter decided; and the relay's log, JSON lines that name each refusal but never a token, code or argument. This page covers what a client sees; [Setup problems and limits](12-setup-and-limits.md) covers a relay or page that misbehaves before any call, and the fixed limits.

## Error codes

A refusal reaches the client as a tool error whose text is `<code>: <reason>`, the reason in the relay's own words, so match on the code ([errors.ts](../../packages/protocol/src/errors.ts)). The adapter refuses calls with page codes of its own ([page-link.ts](../../packages/protocol/src/page-link.ts)), which the relay maps onto these (`PAGE_ERRORS` in [hub.ts](../../packages/relay/src/hub.ts)); the last two are page codes a client never sees by name.

### `not_attached`

You hold no attachment to that page: you never paired, the operator revoked you, it went unused for 8 hours, an invite-made attachment reached its end, or the page id is wrong or stale, as in a first-class name from before a new tab, a gone page or a relay restart. A stranger and an unknown page get the same answer (S13). **What to do:** run `list_pages`, and list tools again rather than reuse a first-class name. Pair again with the code the page shows now or, if your account joins by invite, ask the operator for a new invite link.

### `role_denied`

You are an observer and the tool is not marked `readOnlyHint: true`, by the relay's check or the page's own. The page also answers it for a caller its operator never approved. **What to do:** ask the operator to make you a driver in the widget. A page author whose read tool is refused marks it `readOnlyHint: true`.

### `tool_not_found`

The page lists no tool by that name now, or you used a first-class name on an attachment an invite made. **What to do:** run `list_page_tools` again, since tools come and go with the page, and use `call_page_tool` with the tool's own name.

### `page_asleep`

The tab disconnected (reload, close, freeze, network) or is reconnecting and has not listed its tools yet, a pairing waiting on it ended, or the relay is shutting down. Attachments are kept for 10 minutes. **What to do:** retry in a moment. The operator brings the tab back within 10 minutes; a pairing that was waiting starts again with the code the page shows when it is back.

### `page_gone`

The page stayed away past 10 minutes, or detached while your call ran. It shows as gone in `list_pages` for 10 more minutes. **What to do:** its attachments are over, so pair with the page again by its new code.

### `denied_by_operator`

The operator denied your attach request or a consequential call, a consequential prompt went unanswered until the deadline, the page's policy denies consequential tools, or the operator revoked you, closed the invite you used or its sponsoring member left while you waited. **What to do:** ask the operator; nothing retries on its own.

### `timeout`

The page did not answer within 45 seconds, the call waited 45 seconds behind other writes and never ran, your client or the page cancelled it, `pair_page` stopped waiting after 50 seconds, or an attach request went unanswered for 60 seconds and was denied. **What to do:** retry a call. After a `pair_page` timeout the request stays open on the page until its 60 seconds end, and an approval shows up in `list_pages`, so look there before pairing again.

### `page_busy`

The operator paused the page, 32 writes already wait at the relay or on the page, the page holds its 10 users already, the seats invites may use are full, another redemption of the same invite is waiting, or the relay holds all the waiting requests it allows. **What to do:** retry shortly. The operator can resume, or revoke someone to make room.

### `pairing_expired`

The code is wrong, used or older than 120 seconds (the page shows a new one after every pairing); the same for a QR link; or the invite link is unknown, used up, cancelled, expired, or minted for several uses, which `pair_page` never takes. **What to do:** copy the code the widget shows now and pair within two minutes. Open a multi-use invite link in a browser at `/i` instead, or ask for a new link.

### `rate_limited`

Past a budget: requests to the relay (240 a minute for a member, 60 for an invitee), 120 calls a minute to one page, 10 pairing attempts a minute per account or 30 per page, 30 redemptions of one invite a minute, four confirmations already waiting in your clients, or the memory your waiting requests may hold. **What to do:** wait a minute and retry. A relay's operator can raise some of these ([Relay settings](08-relay-settings.md)).

### `invalid_arguments`

The arguments failed the tool's `inputSchema` at the relay, would not fit one 1 MiB page link frame, or a fixed tool's own input was wrong, such as `pair_page` with both or neither of `code` and `invite`. The schema check is advisory (ADR 0010): one that cannot start within 50 ms, or runs past 50 ms, lets the call through unchecked, so only a check that finishes and fails answers this. **What to do:** read the schema with `list_page_tools` and call again.

### `invite_required`

Your account is an invitee, signed in at the provider without being on the relay's member list, and it offered a pairing code or QR link, which only members use (ADR 0017). **What to do:** ask the operator for an invite link: a single-use one for `pair_page`, or any live one opened in a browser.

### `not_confirmed`

On a page with `confirmVia: 'client'`, your client did not confirm the call: declined, dismissed, expired after 120 seconds, already used, given for other arguments, another tool or page, or held from before a relay restart. The page never heard of the call (ADR 0026). **What to do:** call again and accept the question your client shows. A client with no person at it, such as headless `claude -p`, may decline at once.

### `proposal_not_found`

No proposal of yours has that id on that page: unknown, forgotten 10 minutes after it ended, or someone else's, which reads the same (ADR 0042). **What to do:** use the id `call_page_tool` returned.

### `tool_error`

A page code: the page's handler threw. The client gets the page's error text under the untrusted label, flagged `isError`, with no code; [Writing handlers](03-add-to-your-app.md#writing-handlers) shows the text each runtime gives. **What to do:** read it as page data; the fix is in the page or the arguments.

### `cancelled`

A page code: the page ended a call it had started, or a client's cancellation reached it. The client sees `timeout`. **What to do:** as for `timeout`.

## Failures without a code

| Answer                                                                         | What it means, and what to do                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON-RPC error -32602, `Tool <name> not found`                                 | The relay serves no such name: neither a fixed tool nor shaped `<page id>__<tool>`, or any first-class name while `TABDOCK_FIRST_CLASS_TOOLS` is off. A stale first-class name gets `not_attached`, or `page_gone` just after its page went. |
| JSON-RPC error -32000, `more than 240 requests to this relay in 1 minute; ...` | Past the request budget on a request no tool answers, such as `tools/list`; on 2026-07-28 it comes with HTTP 429. Wait a minute.                                                                                                             |
| HTTP 401 with `WWW-Authenticate`                                               | No token or a wrong one. Sign in again; for local mode, see [Setup problems](12-setup-and-limits.md#setup-problems).                                                                                                                         |
| HTTP 404, `Session not found`                                                  | A 2025-era session idle for 30 minutes, or another user's. The client opens a new one.                                                                                                                                                       |
| HTTP 413                                                                       | One request would hold more of the relay's memory than one user's requests may. Send less.                                                                                                                                                   |

Next: [Setup problems and limits](12-setup-and-limits.md).

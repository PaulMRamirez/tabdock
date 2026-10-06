# Security

What Tabdock protects, and what it relies on you for, whether you write the page or run the relay. [The threat model](../threat-model.md) maps every boundary to its threats, controls and tests, and [SPEC](../../SPEC.md) section 9 states the rules S1 to S14 that this page puts in plain words.

## The trust model

The operator at the tab is the root of trust. Nobody attaches without the operator's approval, except as an observer under the page's own `autoApprove: 'observer'` or through a Can watch invite minted on that page. Every call is checked twice, by the relay and again by the adapter, which runs it only under the least of the operator's grant, the relay's roster and the role the call claims, so even a relay that lies cannot run a write for an observer or skip a prompt the page owns. Prompts default to deny: silence for 60 s on an attach request, or until the call's deadline on a consequential prompt, is a no. The page's origin comes only from the browser's `Origin` header. The relay never runs a tool, but it sees every call, argument and result in plain text, as does any tunnel or edge that ends TLS in front of it, so you run your own.

## What Tabdock guarantees

| Rule | In plain words                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1   | A page's origin is read from the WebSocket `Origin` header, never from anything the page says; a socket without one is refused outside a development flag                                        |
| S2   | Only allowlisted origins attach; development allows localhost, and production refuses to start without a list                                                                                    |
| S3   | Pairing codes carry at least 40 bits, work once, die after 120 s, are compared in constant time and rate limited                                                                                 |
| S4   | No attachment without the operator's approval, except `autoApprove: 'observer'` or a live Can watch invite from that page                                                                        |
| S5   | Roles are enforced by the relay and again on the page; no crafted request lets an observer run a write                                                                                           |
| S6   | Consequential tools prompt on the page and a timeout denies; only a page that opts in lets its member drivers confirm in their own client, and anything but a clear yes there is `not_confirmed` |
| S7   | Every call that reaches a page is in the page's activity log and the relay's audit log (user, client, tool, time, outcome), without its arguments                                                |
| S8   | Revoke is immediate: calls in flight are cancelled and later ones fail with `not_attached`                                                                                                       |
| S9   | Limits bound users per page, requests and calls per minute, queues, frames, results, tool lists and memory, so one user or page cannot starve the rest                                           |
| S10  | Page results are always labelled untrusted and reach clients only as labelled text; page descriptions, titles and labels are capped and never merged into the relay's own tool text              |
| S11  | Tokens, codes and invite secrets never appear in logs; a QR nonce is single use and worthless without a signed-in user and an approval                                                           |
| S12  | The relay listens on loopback unless it runs hosted behind a TLS edge, and refuses a `Host`, or an `Origin` on `/mcp`, that is not its own                                                       |
| S13  | A user can list and call only pages they are attached to; nothing depends on a page id being hard to guess                                                                                       |
| S14  | Invites are bounded: at most 10 live per page, 24 hours and 20 uses each, never more than their role, and a revoke sticks                                                                        |

## What it relies on you for

**Run your own relay.** It reads everything in plain text and decides who is who, so run it yourself, or trust whoever does as you trust your page's server. Nothing is encrypted end to end between client and page.

**Treat your tools as an API.** Each one is an endpoint that an agent, and whoever steers it, can call with any arguments the role allows. Keep tools narrow, mark every consequential one with `consequentialHint` and in `policy.consequentialTools`, since some runtimes drop the hint, and validate input in the handler: the relay's argument check is advisory. Make writes safe to repeat.

**Never return what the agent should not see.** A result goes through the relay in plain text into a model's context and a client's history. Leave out tokens, cookies, API keys and other people's data, even when the page can read them.

**Treat both directions as untrusted.** Results carry a `[tabdock: untrusted content from <origin>, tool <name>]` label because page text may hold instructions aimed at the model, such as an item name another user wrote; keep that text as data in your results. Arguments arrive from agents that read untrusted text elsewhere, so handle them as you would any client's input, and never render them as HTML.

**List exact origins.** `TABDOCK_ALLOWED_ORIGINS` names each page origin that may attach, scheme, host and port as the browser sends them. Every origin you list can bring pages to your relay, and anything outside a browser can claim one, so list only your own.

**Keep tokens and codes out of logs.** Never log or send on the pairing code, `state.pairing.url` (its fragment is a single-use nonce), invite links or the resume token in `sessionStorage`. In local mode the owner token lives in a private file outside the checkout, and on macOS and Linux Claude Code reads it through the header helper the relay writes, so its settings hold no token; avoid `claude mcp get`, which prints a stored header in full ([Quick start](02-quick-start.md)).

**Look after your page.** Allow only the relay in `connect-src`, keep the handle `attach()` returns inside your own code, and refuse framing by other sites. Load the adapter before scripts you trust less: it takes the WebSocket, crypto and DOM built-ins it relies on when it loads and when `attach()` runs, so a script that runs later cannot sit inside the page link or predict a secret. Such a script can still read some frames and invite secrets through the page's other built-ins, and do anything your page can do, so Tabdock assumes the page is trusted (the threat model's row B5; [Add to your app](03-add-to-your-app.md#csp-trusted-types-and-frames)).

**Operate the relay with care.** In hosted mode name the client address in one header, `TABDOCK_CLIENT_ADDRESS_HEADER`, believed only from `TABDOCK_TRUSTED_PROXY_CIDR`. Keep the audit log, which chains every line to the one before, and check it with `pnpm audit:log --verify`. A restart forgets every page, attachment, code and invite, so everyone pairs again; only the audit log and local mode's token survive. [Run a relay](07-run-a-relay.md) and [Relay settings](08-relay-settings.md) cover the rest.

## What is out of scope

A compromised page, or a hostile script in it, acts with the operator's own power. A hostile relay operator can read every call, refuse service, and act as any person the operator approved within that person's role, but cannot attach someone the operator never approved (beyond what `autoApprove` admits), raise a role or skip the page's prompt, because the adapter keeps its own grants and prompts; the exception is a page that chose `confirmVia: 'client'`, which takes the relay's word that a member's client confirmed. Client names are self-declared and only label the activity log, and a yes from a client proves only that the account's client said yes, perhaps with no person present.

Next: [Troubleshooting](11-troubleshooting.md).

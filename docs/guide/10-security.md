# Security

What Tabdock protects, and what it relies on you for, whether you write the page or run the relay. [The threat model](../threat-model.md) maps every boundary to its threats, controls and tests, and [SPEC](../../SPEC.md) section 9 states the rules S1 to S14 that this page puts in plain words.

## The trust model

The operator at the tab is the root of trust. Nobody attaches without the operator's approval, except as an observer the page's `autoApprove: 'observer'` or a Can watch invite from that page admits. Every call is checked twice, by the relay and again by the adapter under the least of the operator's grant, the relay's roster and the role the call claims, so even a relay that lies cannot run a write for an observer or skip the page's prompt. Prompts default to deny: silence for 60 s on an attach request, or until the call's deadline on a consequential prompt, is a no.

The page's origin comes only from the browser's `Origin` header. The relay never runs a tool, but it, and any tunnel or edge that ends TLS in front of it, sees every call, argument and result in plain text.

## What Tabdock guarantees

| Rule | In plain words                                                                                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1   | A page's origin comes only from the WebSocket `Origin` header; a socket without one is refused outside a development flag                                                                                                      |
| S2   | Only allowlisted origins attach; development allows localhost, and production will not start without a list                                                                                                                    |
| S3   | Pairing codes hold at least 40 bits, work once, die after 120 s, are compared in constant time and rate limited                                                                                                                |
| S4   | No attachment without the operator's approval, except `autoApprove: 'observer'` or a live Can watch invite from that page; an agent token's first request always raises a prompt                                               |
| S5   | Roles are enforced by the relay and again on the page; an observer's write runs only as a proposal the operator accepted, and a session only narrows the policy                                                                |
| S6   | Consequential tools prompt on the page and a timeout denies, unless the page lets member drivers confirm in their client; Accept on a proposal is its confirmation, and under deny a consequential proposal is refused at once |
| S7   | Every call that reaches a page is in the activity log and the relay's audit log (user, client, tool, time, outcome), never its arguments                                                                                       |
| S8   | Revoke is immediate: calls in flight are cancelled, waits end, proposals drop and later calls fail with `not_attached`; removing a member does the same                                                                        |
| S9   | Limits bound people and watchers per page, requests, calls, queues, frames, results, images (one still picture, never animated), state, waits, proposals and memory                                                            |
| S10  | Results, images, page state and proposal results reach clients only behind labels, never as structured content; page text is capped and kept out of the relay's own tool text                                                  |
| S11  | Tokens, codes and invite secrets never appear in logs; a QR nonce is single use; an agent token is kept only as a digest                                                                                                       |
| S12  | The relay listens on loopback unless hosted behind a TLS edge, and refuses a `Host`, or an `Origin` on `/mcp` or `/g/mcp`, that is not its own                                                                                 |
| S13  | A user reaches only pages they are attached to, and reads or withdraws only their own proposals; nothing depends on an id being hard to guess                                                                                  |
| S14  | Invites are bounded and end no later than a session live when minted; watchers sit in watching seats; a revoke's bar survives member list changes and restarts                                                                 |

## What it relies on you for

**Run your own relay.** It reads everything in plain text and decides who is who, so run it yourself, or trust whoever does as you trust your page's server. Nothing is encrypted end to end between client and page.

**Treat your tools as an API.** Each is an endpoint an agent, and whoever steers it, can call with any arguments the role allows. Keep tools narrow, mark every consequential one with `consequentialHint` and in `policy.consequentialTools`, since some runtimes drop the hint, and validate input in the handler: the relay's argument check is advisory. Make writes safe to repeat.

**Never return what the agent should not see.** A result passes the relay in plain text into a model's context and a client's history. Leave out tokens, cookies, API keys and other people's data, even when the page can read them.

**Treat both directions as untrusted.** Results carry a `[tabdock: untrusted content from <origin>, tool <name>]` label because page text may hold instructions aimed at the model; keep such text as data. Arguments come from agents that read untrusted text elsewhere: handle them as any client's input, never as HTML.

**List exact origins.** `TABDOCK_ALLOWED_ORIGINS` names each page origin that may attach, scheme, host and port as the browser sends them. Anything outside a browser can claim a listed origin, so list only your own.

**Keep secrets out of logs.** Never log or send on the pairing code, `state.pairing.url` (its fragment is a single-use nonce), invite links, a session's observer links, an agent token or the command that carries it, or the resume token in `sessionStorage`. The widget's `claude mcp add --header` command leaves the token in `claude`'s argument list while it runs, in the shell's history and in `~/.claude.json`; a project .mcp.json entry naming `${AGENT_TOKEN}` avoids all three ([Larger rooms](20-larger-rooms.md#agent-tokens)). In local mode on macOS and Linux, Claude Code reads the owner token through the relay's header helper, so its settings hold none; avoid `claude mcp get`, which prints a stored header in full ([Quick start](02-quick-start.md)).

**Look after your page.** Allow only the relay in `connect-src`, keep the handle `attach()` returns inside your own code, and refuse framing by other sites. Load the adapter before scripts you trust less: it takes the built-ins it relies on as it loads and attaches, so a later script cannot sit inside the page link or predict a secret, though it can still read some frames and invite secrets and do anything your page can; Tabdock assumes the page is trusted (the threat model's row B5; [below](#csp-trusted-types-and-frames)).

**Operate the relay with care.** In hosted mode name the client address in one header, `TABDOCK_CLIENT_ADDRESS_HEADER`, believed only from `TABDOCK_TRUSTED_PROXY_CIDR`. Keep the audit log, each line chained to the one before, and check it with `pnpm audit:log --verify`. A restart ends every page, attachment and invite unless `TABDOCK_RESTART_SNAPSHOT` carries them across a graceful stop of under 10 minutes; it never carries pairing codes, and its file keeps names, emails and page titles at 0600 until the next start removes it, so delete it from a relay retired with the setting on ([Settings for rooms](14-settings-for-rooms.md#members-agents-and-restarts)). [Run a relay](07-run-a-relay.md) and [Relay settings](08-relay-settings.md) cover the rest.

## Images, state, rooms and records

Images and page state are page content: a picture reaches a client only behind the label and a relay line calling it untrusted, as one still PNG, JPEG or WebP the relay checks again, and state behind a label of its own, which every attached role may read. Never draw or publish a secret.

The adapter runs an accepted proposal only against its own record of the operator's Accept, so a relay alone cannot turn one into a write. Accepting a consequential proposal runs it with no second prompt, so read it first. A time-boxed session only narrows the page's policy, in both layers, and its end closes what invites and agent tokens let in. An agent token is a bearer credential for one page, observer only, kept as a digest and carried by the relay to its own page alone, in each prompt it raises for the token; a deny or three timeouts burn it.

Whoever can write the members file can make anyone a member, so on macOS and Linux the relay refuses one that group or others may write, or that an account other than its own or root owns, anywhere on its path; on Windows keep it where only the relay's account can write. A saved session record names people, invitees by email: keep it as you keep the audit log.

DevTools access to the operator's browser is the operator's seat: launch a CI check's browser over a pipe, never with `--remote-debugging-port` on a shared machine, and never cache or upload the runner's `TABDOCK_HOME`. The threat model's rows B8 and B9 cover the CI check, and B11 to B14 images, the members file, agent tokens and the record.

## CSP, Trusted Types and frames

A Content-Security-Policy must allow the adapter's script in `script-src` and the relay in `connect-src` (`ws://127.0.0.1:8787` or `wss://relay.example`), and in current browsers nothing more: the widget adopts a constructed stylesheet, which no `style-src` governs, draws its QR code as SVG nodes and runs zod without `eval`, so it needs no `'unsafe-inline'`, `'unsafe-eval'` or `data:` images and works under `require-trusted-types-for 'script'`. The adapter shares only its own window's tools, never those of same-origin frames. Refuse framing by other sites (`frame-ancestors`): a framing page could dress up the widget to steer the operator's click.

## What is out of scope

A compromised page, or a hostile script in it, acts with the operator's own power. A hostile relay operator can read every call, refuse service and act as any person the operator approved, within that person's role, but cannot attach someone the operator never approved (beyond what `autoApprove` admits), raise a role or skip the page's prompt, since the adapter keeps its own grants and prompts; a page that chose `confirmVia: 'client'` takes the relay's word that a member's client confirmed. Client names are self-declared labels, and a client's yes proves only that the account's client said yes, perhaps with no person present.

Next: [Troubleshooting](11-troubleshooting.md).

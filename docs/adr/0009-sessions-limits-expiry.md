# 0009: MCP sessions, section 9 limits and idle expiry in M2

Status: Accepted by the owner, 2 October 2026. No SPEC change; sets defaults the spec leaves open. Follows ADR 0005.

## Context

ADR 0005 left 2025-era clients on the SDK's stateless mode for M1, where the relay cannot name the client after `initialize` and a client's cancellation never reaches the running call. The SDK v2 has no session options of its own: its documented sessionful route is composed by the server from `isLegacyRequest` and one transport per session, with no session store, idle expiry or caps, and it does not bind a session to the user who opened it. SPEC section 9 (S9) asks for limits on users per page, calls per user per minute and queue depth without giving numbers, and M2 lists idle expiry without a default.

## Decision

2025-era traffic goes to a sessionful leg composed as the SDK documents; 2026-07-28 traffic stays on `createMcpHandler`. The relay stores each session's owner and answers 404 when another user presents its id. Sessions expire after 30 minutes with no open response; each user may hold 20, a new one evicting that user's least recently used idle session, and the relay 1000, answering 503 when full.

Defaults, all configurable: 10 users per page; 120 calls per user per page per minute; 32 queued mutating calls per page; 20 page sockets per address and 1000 in total, evicting the oldest asleep page when full. Over a limit, calls get `rate_limited` or `page_busy`. Attachments expire after 8 hours without a call, each call moving the expiry; an expired attachment ends like a revoked one.

## Consequences

The roster can name every client, cancellations reach the page, and no user can use another's session. One misbehaving client or page cannot exhaust the relay's memory. M4 revisits the numbers for a public relay.

## Notes after the review

The M2 review showed that counting only open page sockets let one address fill the relay with asleep pages by opening and closing sockets, ending other people's pages. Page sessions are now also counted per creating address, asleep ones included (`pageSessionsPerAddress`, 20, `TABDOCK_MAX_PAGE_SESSIONS_PER_ADDRESS`), beside the 20 open sockets per address checked before the upgrade. Room for a new page is made when its `hello` arrives, never for a valid resume: an address at its own cap ends its own page asleep longest, the relay at its total cap ends the requesting address's own oldest sleeper first and otherwise the oldest of all, and a page with nothing to end is closed with 1013 (ADR 0012). Records of gone pages are capped at the page-session total and keep only what `page_gone` and `detach_page` need. A page socket may send 10 `tools` frames in 10 s before it is closed with 1008 (ADR 0012). Roster frames caused by a new client name are throttled like expiry moves, with one trailing send, and a call the relay refuses never names its client, so a client that renames itself on every call cannot keep the operator's buttons waiting. A second device that joins a pending attach request is named when the operator approves.

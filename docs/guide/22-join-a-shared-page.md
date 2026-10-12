# Join a shared page

This page is the joiner's side: a guest with an invite link, a student watching in a time-boxed session, and a program holding an agent token. The operator's side is on [Sharing](06-sharing.md) and [Larger rooms](20-larger-rooms.md).

## With a link

Open the link in a browser, on your phone or a computer, and never paste it into Claude: `pair_page` takes only one-use links, and a link for many people, such as a class's watch link, answers `pairing_expired` there. At `/i` the page shows who shared it, the page's address and title, and what the invite lets you do. Sign in with any account at the relay's provider and tap Join; a watch invite lets you in at once, and a Can control invite asks the operator first.

`/i` then shows the relay's connector. Add it in Claude on the web or the desktop app (Customize, Connectors, +, Add custom connector), signing in with the same account; it then appears in Claude on your phone too, where installing connectors is still in beta, and the Free plan allows one custom connector ([Connect clients](05-connect-clients.md#claude-on-the-web-desktop-and-phone)). Then ask Claude to list your pages.

## What you can do

As an observer you call the page's read-only tools, read its published state with `get_page_state` and follow it with `wait_for_page_state`. A tool the page declares an image tool returns a picture behind the relay's label; whether hosted Claude's model reads it is not yet verified ([Images and page state](18-images-and-state.md)). Where the page takes proposals, a write answers `proposed` with an id instead of `role_denied`: follow it with `get_proposal` and take it back with `withdraw_proposal` ([Lessons and reviews](19-lessons-and-reviews.md#proposals)). In a class the watchers share 60 calls a minute to the page, so prefer state, which never touches the tab.

The operator sees your verified email, or "unverified account", with a short id and an invited badge, your client's name, your role and each call's tool and outcome, never its arguments or results; they see your proposals' arguments, and a session record they save names you ([Connect clients](05-connect-clients.md#what-the-operator-sees-about-you)). Your access ends when the operator revokes it, when a time-boxed session ends, when the member who shared the link leaves the page, within 24 hours at most, or when you call `detach_page`.

## With an agent token

An agent token lets Claude Code, or any MCP client that sends a header, watch one page with no sign-in. Run the command the operator gives you, or put the .mcp.json entry from [Larger rooms](20-larger-rooms.md#agent-tokens) in your project and set `AGENT_TOKEN`. Its first request raises the operator's prompt, which they answer within 60 s; three prompts left unanswered burn the token. Ask Claude to call `pair_page` with no arguments, which waits up to 50 s for that answer, then `list_pages`: you may call the page's read-only tools and read and follow its state, but never propose. A headless `claude -p` run needs `--allowedTools 'mcp__<name>__*'`, as the [Quick start](02-quick-start.md#connect-pair-and-call) shows, or it calls nothing.

The token ends with the operator's Cancel or Revoke, the session's end, the sponsor leaving, your own `detach_page` or its lifetime, and from then on `/g/mcp` answers 404, which Claude Code reports as no MCP endpoint found.

## When it goes wrong

**`pairing_expired` from `pair_page`.** You pasted a link for many people, or one that is used up or expired; open a live one in a browser instead. **`invite_required`.** Your account came in by invite, so it pairs by invite link only, never by code. **`rate_limited` at `/i`.** Too many sign-ins or joins this minute; tap Join again a minute later, not over and over ([Larger rooms](20-larger-rooms.md#a-class-joining)).

**A 404 at `/g/mcp`.** The token is closed, unknown or mistyped; ask the operator for a new one. **`denied_by_operator`.** The operator denied or closed the token, its text saying how, or that it is "no longer live"; "the page takes no invited guests now" means the page's invites are off. **`timeout`, "the page operator has not been asked yet; call pair_page again".** Call it again; the next request asks. [Troubleshooting](11-troubleshooting.md) gives every code.

Next: [Copy the CI check](23-copy-the-ci-check.md), or back to [the guide's index](README.md).

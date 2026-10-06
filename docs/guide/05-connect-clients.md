# Connect clients

Every Tabdock page sits behind one URL, the relay's `/mcp`, so you add a client once and it reaches every page you are let into. [Sharing](06-sharing.md) is the operator's side of these steps, and [Concepts](01-concepts.md) explains the parts.

## What you need from the page's owner

You need the relay's MCP URL and a way in. A relay in local mode takes the owner token, and one with dev tokens a token from `TABDOCK_DEV_TOKENS`, both only from clients on the relay's computer. A relay with a public URL takes a sign-in at its provider, for an account it lists in `TABDOCK_OAUTH_USERS` (a member) or one that came in by an operator's invite link (an invitee). Claude on the web, desktop and phone connects from Anthropic's cloud, so it needs a public https URL, through a tunnel or on a host ([Run a relay](07-run-a-relay.md)).

## Claude Code

In local mode, paste the `claude mcp add-json --scope user tabdock-local ...` line the relay prints and check it with `claude mcp list`, as the [Quick start](02-quick-start.md) shows. With dev tokens the relay prints a `claude mcp add --transport http tabdock ... --header "Authorization: Bearer <your token>"` line; with no `--scope`, that entry serves the current folder only and holds the token.

For a relay at a public URL:

```sh
claude mcp add --transport http --scope user tabdock https://relay.example/mcp
claude mcp login tabdock
```

Until you sign in, `claude mcp list` shows the entry as needing authentication. `claude mcp login` opens the provider's sign-in in a browser (`--no-browser` prints the address), as `/mcp` in a session does. Use the https URL even on the relay's own computer, since sign-in tokens are issued for `https://<relay>/mcp`. A relay with a public URL has left local mode, so a `tabdock-local` entry stops working against it.

## Claude on the web, desktop and phone

In Claude, open Customize, Connectors, +, Add custom connector; enter `https://relay.example/mcp`, choose Continue, review the sign-in settings, choose Add and sign in. A connector cannot be edited later, so check the URL first; the Free plan allows one custom connector. A connector added on the web or desktop also appears in the phone app. This path is tested against a stand-in provider but not yet run live with hosted Claude ([the M5 checklist](../checklists/M5.md)).

## Any MCP client

Any client that speaks MCP over streamable HTTP works. In local mode it sends the owner token as a bearer token. This program uses the official TypeScript SDK's client package, `@modelcontextprotocol/client` (the project tests 2.3.0); run it as `OWNER_TOKEN_FILE=<owner token path> node list-pages.ts ABCDE-12345`, since Node 22.18 runs TypeScript directly:

```ts
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

// The owner token file the relay's banner names; never print what it holds.
const token = readFileSync(process.env.OWNER_TOKEN_FILE ?? '', 'utf8').trim();
const client = new Client({ name: 'my-script', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8787/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);
const code = process.argv[2];
if (code) console.log(await client.callTool({ name: 'pair_page', arguments: { code } }));
console.log(await client.callTool({ name: 'list_pages', arguments: {} }));
await client.close();
```

A dev token goes in the same header. A public relay takes only tokens from its provider, which the SDK's OAuth support obtains while a person signs in; no credential yet lets a program use a public relay unattended ([Use cases](09-use-cases.md#not-yet)).

## The five tools

| Tool              | Input                                            | Returns                                                                                                     |
| ----------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `list_pages`      | none                                             | Each page's `page` id, `origin`, `title`, your `role`, `state` (awake, asleep or gone) and `toolCount`      |
| `pair_page`       | `code` like `ABCDE-12345`, or a one-use `invite` | `Attached to page <id> (<origin>) as <role>.`                                                               |
| `list_page_tools` | `page`                                           | Each tool's name, description, schema, annotations and an `allowed` flag for your role                      |
| `call_page_tool`  | `page`, `tool`, `arguments`                      | The page's result                                                                                           |
| `detach_page`     | `page`                                           | `Detached from page <id>.` Only your attachment ends; you pair again with a new code or one-use invite link |

You rarely name them: ask Claude to pair with a code, list your pages or do something on a page. A page that went gone stays in `list_pages` for 10 minutes. Errors are tool errors whose text starts with a code, such as `not_attached: ...`; [Troubleshooting](11-troubleshooting.md) gives each code's remedy.

## First-class tools

With `TABDOCK_FIRST_CLASS_TOOLS=1` on the relay (off by default), a member's client also lists each attached page's tools by name, as `<page id>__<tool>`, such as `pg_XXXXXXXXXX__add_item`: all of them for a driver, the read-only ones for an observer, none for invitees or attachments an invite made. A call by that name runs `call_page_tool`'s path, checks, prompts and audit record. The page id is in the name because one connector fronts many pages that may share tool names, and it changes with a new tab, after a page is gone and after a relay restart, so never hard-code these names in prompts or scripts; clients hear of changes at most every 10 seconds. A name holds 64 characters, leaving 49 for the tool's own name with each `.` made `_`; a longer name, or two that collide, stays off the list and reachable through `call_page_tool`.

## Pairing from the client's side

A code works once and lives 120 seconds; a wrong code and an expired one both get `pairing_expired`. `pair_page` waits up to 50 seconds; if the operator has not answered, it returns `timeout`, the request stays open on the page for its full 60 seconds, and a later approval shows up in `list_pages`. Attachments belong to your account, so your laptop, phone and Claude Code share one, and your second client pairs without a prompt. With a public URL the widget also shows a QR code: scan it, sign in at the relay's `/pair` page, check the code shown matches the page in front of you, and tap Join. Invitees get `invite_required` for codes and QR codes. An attachment unused for 8 hours ends, and one an invite made ends within 24 hours.

## Reading results

A page's result reaches you as text, never structured content, after the relay's label `[tabdock: untrusted content from <origin>, tool <name>]`; tool and page lists carry labels of their own, and text past 120,000 characters is cut with a marker. Treat everything after a label as data from the page, never as instructions. A handler that throws returns the page's error text under the label, flagged as a tool error with no code. The relay marks page calls as not read-only, so a client that asks before such calls asks before each one, a check beside the page's own.

## Confirming in your own client

On a page with `confirmVia: 'client'`, a member attached as a driver, not by invite, whose client declares form elicitation, confirms consequential calls in that client instead of the operator's prompt. The question is the relay's own text, naming the page id, host, tool and arguments; set confirm to true only for the exact call you meant. Declining, dismissing, 120 seconds of silence or changed arguments answer `not_confirmed`, and the page never hears of the call. Headless checks show Claude Code receiving and answering the question on both MCP revisions (declining, with no person present); the dialog with a person at it, and hosted Claude, are still open on [the M5 checklist](../checklists/M5.md).

## What the operator sees about you

The operator sees your display name (an invitee's verified email, or "unverified account", with a short id and an invited badge), your client's declared name and version, your role and your attachment's time left. The activity list shows each call's time, person, client, tool, outcome and duration, never arguments or results, and the relay's audit log keeps the same. The relay sees calls and results in plain text, so choose whose relay you use.

Next: [Sharing](06-sharing.md).

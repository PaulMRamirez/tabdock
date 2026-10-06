# Add Tabdock to your app

From "my app has functions" to "Claude can call them safely": a WebMCP runtime, marked tools, the adapter and a relay URL, with words as [Concepts](01-concepts.md) defines them. Tabdock 0.1.0 is not yet on npm, so today the adapter comes from a clone; `npm install @tabdock/adapter` and the CDN tag work once 0.1.0 is on npm.

## A WebMCP runtime

Tools live on `document.modelContext`, only in a secure context (https, or http on `localhost` and `127.0.0.1`). Chrome's own WebMCP is an origin trial, off by default even on localhost (`--enable-features=WebMCPTesting` turns it on for testing), so most pages load MCP-B's polyfill, which installs `document.modelContext` only where the browser has none. With a bundler, `npm install @mcp-b/webmcp-polyfill@5.1.0` and run it first:

<!-- fragment -->

```ts
import { initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill';

initializeWebMCPPolyfill(); // the 6.0 beta exports installWebMCP() instead
```

Without a bundler, load the package's `dist/index.iife.js` in a classic script tag before the adapter; it installs itself. The adapter looks for `document.modelContext` once, at `attach()`; if it is missing, the adapter logs how to add a polyfill, puts that text in `state.error` and stays idle. For TypeScript, declare the slice you use, as [`apps/demo/src/webmcp.ts`](../../apps/demo/src/webmcp.ts) does; MCP-B's own types for 5.1.0 have no `consequentialHint`.

## Register tools

A tool has a name, a description the model reads, a JSON Schema for its input, annotations and an `execute` handler, which runs in the tab with the page's state and the user's session. The adapter never registers tools; it reads the page's and follows changes through `toolchange` and a 2 s poll, so register before or after `attach()`.

```ts
import { attach } from '@tabdock/adapter';

interface Order {
  id: string;
  total: number;
  submitted: boolean;
}
const orders = new Map<string, Order>([['A-1', { id: 'A-1', total: 42, submitted: false }]]);
const byId = {
  type: 'object',
  properties: { id: { type: 'string', description: 'An order id, such as A-1' } },
  required: ['id'],
  additionalProperties: false,
};

// The handler checks its own input: the relay's check is advisory.
function findOrder(input: unknown): Order | undefined {
  const id: unknown =
    typeof input === 'object' && input !== null ? Reflect.get(input, 'id') : undefined;
  return typeof id === 'string' ? orders.get(id) : undefined;
}

const context = document.modelContext;
if (context) {
  const registration = new AbortController(); // abort() removes both tools
  const report = (error: unknown): void => {
    console.error('could not register a tool', error);
  };
  context
    .registerTool(
      {
        name: 'get_order',
        title: 'Get order',
        description: 'Return one order: its id, total and whether it was submitted.',
        inputSchema: byId,
        annotations: { readOnlyHint: true },
        execute: async (input: unknown) => findOrder(input) ?? { error: 'no such order' },
      },
      { signal: registration.signal },
    )
    .catch(report);
  context
    .registerTool(
      {
        name: 'submit_order',
        title: 'Submit order',
        description: 'Submit one open order for payment. This cannot be undone.',
        inputSchema: byId,
        annotations: { readOnlyHint: false, consequentialHint: true },
        execute: async (input: unknown, options?: { signal?: AbortSignal }) => {
          const order = findOrder(input);
          if (!order) return { error: 'no such order' };
          if (order.submitted) return { id: order.id, submitted: true, already: true };
          options?.signal?.throwIfAborted();
          order.submitted = true;
          return { id: order.id, submitted: true };
        },
      },
      { signal: registration.signal },
    )
    .catch(report);
}

attach({
  relay: 'ws://127.0.0.1:8787/page',
  policy: { consequentialTools: ['submit_order'] },
});
```

## Read-only, write or consequential

| Mark                                                             | Who may call it       | How it runs                              | Prompt                                                                                       |
| ---------------------------------------------------------------- | --------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `readOnlyHint: true`                                             | observers and drivers | beside other calls                       | none                                                                                         |
| anything else, a write                                           | drivers               | one at a time per page, in arrival order | none                                                                                         |
| also `consequentialHint: true`, or named in `consequentialTools` | as above              | as above, once confirmed                 | the operator, under `consequential: 'confirm'`; refused under `'deny'`; none under `'allow'` |

Only the page's own `readOnlyHint: true` makes a tool read-only. Set `consequentialHint` and also name the tool in `policy.consequentialTools`: MCP-B 5.x and Chrome 153 drop the hint, and there, when tools carry annotations but the list names none, every tool that is not read-only prompts and the widget says how to fix it (ADRs 0002 and 0034). Tools with no annotations at all get no such fallback. `untrustedContentHint` changes nothing, as every result is labelled anyway. Under `confirmVia: 'client'` a member driver confirms in their own client ([Sharing](06-sharing.md)). Clients see `call_page_tool` and first-class page tools as not read-only and open-world, so a client that asks before such tools asks before every page call.

## Add the adapter

Today, build it in a clone: `pnpm --filter @tabdock/adapter build` writes the script-tag file, `dist/tabdock-adapter.js` in `packages/adapter`, to serve from your own origin. For a bundler, `pnpm release:pack` writes `dist/packages/tabdock-protocol-0.1.0.tgz` and `dist/packages/tabdock-adapter-0.1.0.tgz`; install both in one `npm install`, as the adapter needs that exact protocol. Once 0.1.0 is on npm, `npm install @tabdock/adapter` replaces both.

Call `attach()` once per page load, in browser code only (a client-only module in a server-rendered framework), and keep the handle it returns inside your own code: it approves attachments and answers prompts. It throws a `TypeError` for a relay URL that is not `ws:` or `wss:` and for a bad policy value, naming the fields; a misspelled key is silently dropped, which TypeScript catches and plain JavaScript does not.

In React, call `attach()` at module scope, not in an effect: StrictMode runs effects twice in development, and a cleanup calling `dock.close()` detaches for good and forgets the resume token. Components follow `dock.on('state', ...)`, whose return value is the cleanup:

<!-- fragment -->

```ts
// tabdock.ts, imported only by browser code
import { attach, type DockState } from '@tabdock/adapter';
import { useEffect, useState } from 'react';

export const dock = attach({
  relay: 'ws://127.0.0.1:8787/page',
  policy: { consequentialTools: ['submit_order'] },
});

export function useDockState(): DockState {
  const [state, setState] = useState(dock.state);
  useEffect(() => dock.on('state', setState), []);
  return state;
}
```

## The script tag

A page with no build step loads the polyfill, then the adapter's script-tag file:

```html
<script src="/vendor/webmcp-polyfill.js"></script>
<script
  src="/vendor/tabdock-adapter.js"
  data-relay="ws://127.0.0.1:8787/page"
  data-consequential-tools="submit_order"
></script>
```

It reads `data-relay` and the policy attributes the [adapter reference](04-adapter-reference.md#the-script-tag) lists, and attaches once the document has parsed, so a polyfill loaded as a module script is ready first. It gives no handle: the widget is the only control, with no `ui: false` or `modelContext`. A bad attribute logs `[tabdock] invalid data attributes for <fields>` and nothing attaches. Once 0.1.0 is on npm, jsDelivr serves the file pinned to a version, with the digest from the release asset `tabdock-adapter.integrity.txt`, which also holds a ready tag:

```html
<!-- once 0.1.0 is on npm -->
<script
  src="https://cdn.jsdelivr.net/npm/@tabdock/adapter@0.1.0/dist/tabdock-adapter.js"
  integrity="sha384-(the digest in tabdock-adapter.integrity.txt)"
  crossorigin="anonymous"
  data-relay="wss://relay.example/page"
></script>
```

## Point the page at a relay

| Relay mode                   | The page dials             | The page's browser runs | Page origins allowed                                                                             |
| ---------------------------- | -------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| Local, or dev tokens         | `ws://127.0.0.1:8787/page` | on the relay's machine  | http and https on `localhost`, `127.0.0.1` and `[::1]` at any port, or `TABDOCK_ALLOWED_ORIGINS` |
| Public URL, through a tunnel | `ws://127.0.0.1:8787/page` | on the relay's machine  | `TABDOCK_ALLOWED_ORIGINS`, required                                                              |
| Hosted                       | `wss://relay.example/page` | anywhere                | `TABDOCK_ALLOWED_ORIGINS`, required                                                              |

`TABDOCK_ALLOWED_ORIGINS` takes exact origins as the browser sends them (scheme, host and any port; no path or wildcard) and replaces the localhost default. Outside hosted mode, `/page` takes only sockets made on the relay's machine (a loopback `Host`, no forwarding headers), so a tunnel never carries pages, and a public https page dialing a loopback relay meets Chrome's Local Network Access prompt. A refused origin just keeps reconnecting, as browsers hide why a WebSocket failed; the relay logs `page socket refused: origin not allowed`. [Run a relay](07-run-a-relay.md) sets up each mode.

## CSP, Trusted Types and frames

A Content-Security-Policy must allow the adapter's script in `script-src` and the relay in `connect-src` (`ws://127.0.0.1:8787` or `wss://relay.example`), and in current browsers nothing more, since the widget adopts a constructed stylesheet (which no `style-src` governs), draws its QR code as SVG nodes and runs zod without `eval`: no `'unsafe-inline'`, `'unsafe-eval'` or `data:` images, and it works under `require-trusted-types-for 'script'`. The adapter shares only its own window's tools, not those of same-origin frames, which Chrome also lists. Refuse framing by other sites (`frame-ancestors`): a framing page could dress up the widget to steer the operator's click.

## Writing handlers

Always return a value (`undefined` fails on MCP-B 6). It reaches the client as text, an object as JSON and a string as it is, though MCP-B 6 quotes strings, under a `[tabdock: untrusted content from <origin>, tool <name>]` line, cut at 120,000 characters with a marker, never as structured content. A thrown error becomes an error result under the same label, but native WebMCP and MCP-B 6 replace its message with `Tool execution failed`, so return errors the agent should read, as `{ error: 'no such order' }` does above.

Check your own input: the relay checks arguments against `inputSchema` but leaves out `pattern`, `format` and `uniqueItems`, and lets a call through when its check takes over 50 ms (ADRs 0008 and 0010). A call has about 45 s from when the relay receives it, its wait in the write queue and the operator's prompt included; an unanswered prompt is `denied_by_operator`. The handler's `signal` fires on a cancel, a revoke or the deadline on native WebMCP and MCP-B 6; MCP-B 5.1 never tells the handler, and a write holds the page until its handler returns (ADR 0001).

Limits: 128 tools per page, names matching `^[A-Za-z0-9_.-]{1,128}$`, descriptions cut to 1,000 characters, and input schemas over 8,192 characters or 64 levels deep replaced by a stub. First-class names, `<page id>__<tool>`, stop at 64 characters, which leaves 49 for yours (`.` becomes `_`); a longer one is reachable only through `call_page_tool`.

## Designing tools

Keep tools small, one job each, with a verb_noun name that says it. Describe what a tool returns and when to use it; return only the fields an agent needs and never secrets, since results cross the relay in plain text into a model's context. Make writes safe to repeat, as `submit_order` reports an order already submitted rather than charging twice, and take ids, not positions on screen. Mark consequential whatever cannot be undone, spends money or sends something. [Security](10-security.md) says more.

## What counts as one page

The adapter keeps its resume token, grants, invite records and pause switch in the tab's `sessionStorage`, keyed by relay URL and the page's origin and path, read once at `attach()`. A reload of the same path in the same tab within 10 minutes resumes with the same page id and attachments; a new tab, or a full load of another path, is a new page for the operator to approve. A single-page app that changes its path through the History API stays one page, under the path it attached with.

Next: [Adapter reference](04-adapter-reference.md).

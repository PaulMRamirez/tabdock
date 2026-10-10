# Adapter reference

`@tabdock/adapter` exports one function, `attach()`, which links the page's WebMCP tools to a relay, mounts the widget and returns the only control handle. This page and [The control handle](13-the-control-handle.md) list all of it as [core.ts](../../packages/adapter/src/core.ts), [script-options.ts](../../packages/adapter/src/script-options.ts) and the protocol's `PolicySchema` ([page-link.ts](../../packages/protocol/src/page-link.ts)) declare it; [Add to your app](03-add-to-your-app.md) explains when to use what.

## attach(options)

| Option         | Type               | Default                 | Meaning                                                                                                                             |
| -------------- | ------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `relay`        | string             | required                | The relay's page endpoint, a `ws:` or `wss:` URL such as `ws://127.0.0.1:8787/page`                                                 |
| `policy`       | `PolicyInput`      | every field's default   | The page's policy, below                                                                                                            |
| `ui`           | boolean            | `true`                  | `false` mounts no widget; your code then answers prompts through the handle                                                         |
| `modelContext` | `ModelContextLike` | `document.modelContext` | A WebMCP context to read instead, with `getTools`, `executeTool`, and `addEventListener` and `removeEventListener` for `toolchange` |

`attach()` throws a `TypeError` for a relay URL that is not `ws:` or `wss:` ("the relay URL must be a ws: or wss: URL") and for a policy it cannot use ("invalid policy for maxDrivers", naming fields, never values; ADR 0032). The policy schema drops keys it does not know, so a misspelled key such as `consequentialTool` is ignored and its field keeps the default; TypeScript catches the typo, plain JavaScript does not. Without a `document.modelContext` (and no `modelContext` option), `attach()` still returns a handle, but the adapter only logs how to add a polyfill, sets `state.error` and never dials.

## The policy

| Field                | Type                               | Default     | Script tag                 | Effect                                                                                                       |
| -------------------- | ---------------------------------- | ----------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `autoApprove`        | `'none'` or `'observer'`           | `'none'`    | `data-auto-approve`        | `'observer'` lets members attach as observers with no prompt; invitees never                                 |
| `maxDrivers`         | an integer from 1 to 100           | `1`         | `data-max-drivers`         | How many people may drive at once, counting people, not clients                                              |
| `consequential`      | `'confirm'`, `'allow'` or `'deny'` | `'confirm'` | `data-consequential`       | A consequential call prompts, runs, or is refused with `denied_by_operator`                                  |
| `consequentialTools` | tool names, at most 128            | `[]`        | `data-consequential-tools` | Tools that are consequential whatever the runtime reports; the attribute is a comma list                     |
| `invites`            | `'off'`, `'watch'` or `'all'`      | `'watch'`   | `data-invites`             | Which invites the operator may mint: none, Can watch, or Can watch and Can control                           |
| `confirmVia`         | `'page'` or `'client'`             | `'page'`    | `data-confirm-via`         | Under `'confirm'`, whether a member driver confirms in their own client instead of the page                  |
| `imageTools`         | tool names, at most 128            | `[]`        | `data-image-tools`         | Tools whose results may carry one image, as an envelope (ADR 0039); the attribute is a comma list            |
| `proposals`          | `'off'`, `'members'` or `'all'`    | `'off'`     | `data-proposals`           | Whose calls to tools not marked read-only become proposals the operator accepts or dismisses here (ADR 0042) |

How they combine: the relay seats a driver past `maxDrivers` as an observer, so a guest driving beside another driver needs `maxDrivers: 2` or more, and a Can control invite also needs `invites: 'all'`; without a free seat its guest joins as an observer. `confirmVia: 'client'` applies only under `consequential: 'confirm'`, to a member driver whose attachment no invite made, in a client that declares form elicitation; everyone else gets the page's prompt ([Sharing](06-sharing.md)). An empty `consequentialTools` names no tool, so on a runtime that drops `consequentialHint` every tool that is not read-only prompts (ADR 0034); a page that wants no prompts says `consequential: 'allow'`.

A tool `imageTools` names returns `{ image: { mimeType, data }, text }`, and its PNG, JPEG or WebP reaches clients only within the size the relay's welcome allows; any other tool's result is text, whatever it holds. `proposals` changes only what an observer's call to a tool not marked read-only does: `'members'` takes it from members, `'all'` from invitees too, and accepting one in the widget is that call's confirmation ([Sharing](06-sharing.md)). A time-boxed session may narrow `maxDrivers` and `proposals` for its length, never widen them.

## The script tag

The script-tag build, `dist/tabdock-adapter.js`, reads these attributes from its own `<script>` element and calls `attach()` once the document has parsed. It keeps the handle to itself, so the widget is its only control surface.

| Attribute                  | Value                                                     |
| -------------------------- | --------------------------------------------------------- |
| `data-relay`               | Required: the relay's page endpoint                       |
| `data-auto-approve`        | `none` or `observer`                                      |
| `data-max-drivers`         | 1 to 100                                                  |
| `data-consequential`       | `confirm`, `allow` or `deny`                              |
| `data-consequential-tools` | Tool names separated by commas; an empty value names none |
| `data-invites`             | `off`, `watch` or `all`                                   |
| `data-confirm-via`         | `page` or `client`                                        |
| `data-image-tools`         | Tool names separated by commas; an empty value names none |
| `data-proposals`           | `off`, `members` or `all`                                 |

An absent attribute keeps the default, and so does a misspelled one, which is ignored without a word. A bad value logs `[tabdock] invalid data attributes for <fields>`, naming policy fields (`maxDrivers` for `data-max-drivers`); a missing `data-relay` logs `[tabdock] data-relay is required, for example ws://127.0.0.1:8787/page`, and one that is not a `ws:` or `wss:` URL `[tabdock] data-relay must be a ws: or wss: URL, for example ws://127.0.0.1:8787/page`, never repeating it; a file loaded as a module logs `[tabdock] load the adapter build with a classic <script> tag`; and in each case nothing attaches. The widget's hint notice names `data-consequential-tools` rather than `policy.consequentialTools`.

## The handle

`attach()` returns a frozen `Dock`, the only control handle. With it your code approves and denies attach requests, answers prompts, switches roles, revokes, mints invites and pauses, and from M6 publishes the page's state, decides proposals, runs time-boxed sessions, mints agent tokens and saves session records. [The control handle](13-the-control-handle.md) lists every member, every `DockState` field and the invite options.

## Your own operator UI

With `ui: false` no widget is mounted, and your code shows the prompts and answers them through the handle:

```ts
import { attach, type DockState } from '@tabdock/adapter';

const dock = attach({
  relay: 'ws://127.0.0.1:8787/page',
  ui: false,
  policy: { consequentialTools: ['submit_order'] },
});
const panel = document.createElement('section');
document.body.append(panel);

function button(label: string, act: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  // Only a person's click counts; a script can dispatch clicks too.
  node.addEventListener('click', (event) => {
    if (event.isTrusted) act();
  });
  return node;
}

function line(text: string, ...buttons: HTMLButtonElement[]): HTMLParagraphElement {
  const node = document.createElement('p');
  node.textContent = text;
  node.append(...buttons);
  return node;
}

function render(state: DockState): void {
  panel.replaceChildren(line(`Tabdock: ${state.link}`));
  // On screen for the operator to read out; never logged.
  if (state.pairing) panel.append(line(`Pairing code ${state.pairing.code}`));
  for (const request of state.pendingRequests) {
    panel.append(
      line(
        `${request.user.displayName} wants to attach via ${request.via} `,
        button('Allow as driver', () => dock.approve(request.requestId, 'driver')),
        button('Allow as observer', () => dock.approve(request.requestId, 'observer')),
        button('Deny', () => dock.deny(request.requestId)),
      ),
    );
  }
  for (const prompt of state.pendingConfirms) {
    panel.append(
      line(
        `${prompt.caller.displayName} wants to run ${prompt.tool} `,
        button('Allow', () => dock.confirm(prompt.callId, true)),
        button('Deny', () => dock.confirm(prompt.callId, false)),
      ),
    );
  }
}

dock.on('state', render);
render(dock.state);
```

Your UI takes on what the widget did: it should take only trusted clicks, keep the code and links off logs, and, against clickjacking, refuse to be framed; the widget also ignores clicks on a prompt until it has held still for half a second.

## Timeouts and limits

An attach request waits 60 s for the operator, and silence denies it. A consequential prompt waits until the call's deadline, about 45 s from the relay's receipt of the call, and silence denies it too. `invite()` waits 10 s for the relay. The page remembers its last 1,000 prompted call ids and takes no new call under any of them, so a late `confirm()` from a stale dialog answers nothing. After a dropped link the adapter reconnects with backoff from 0.5 s to 30 s.

## Secrets

Never log or send on `state.pairing.code`, `state.pairing.url` (its fragment is a single-use nonce), an invite link or the resume token in `sessionStorage`: anyone who sees a live code can ask to attach. The adapter's own log lines name invitees by a short id, never by email.

Next: [Connect clients](05-connect-clients.md).

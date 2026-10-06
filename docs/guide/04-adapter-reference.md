# Adapter reference

`@tabdock/adapter` exports one function, `attach()`, which links the page's WebMCP tools to a relay, mounts the widget and returns the only control handle. This page lists all of it as [core.ts](../../packages/adapter/src/core.ts), [script-options.ts](../../packages/adapter/src/script-options.ts) and the protocol's `PolicySchema` ([page-link.ts](../../packages/protocol/src/page-link.ts)) declare it; [Add to your app](03-add-to-your-app.md) explains when to use what.

## attach(options)

| Option         | Type               | Default                 | Meaning                                                                                                                             |
| -------------- | ------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `relay`        | string             | required                | The relay's page endpoint, a `ws:` or `wss:` URL such as `ws://127.0.0.1:8787/page`                                                 |
| `policy`       | `PolicyInput`      | every field's default   | The page's policy, below                                                                                                            |
| `ui`           | boolean            | `true`                  | `false` mounts no widget; your code then answers prompts through the handle                                                         |
| `modelContext` | `ModelContextLike` | `document.modelContext` | A WebMCP context to read instead, with `getTools`, `executeTool`, and `addEventListener` and `removeEventListener` for `toolchange` |

`attach()` throws a `TypeError` for a relay URL that is not `ws:` or `wss:` ("the relay URL must be a ws: or wss: URL") and for a policy it cannot use ("invalid policy for maxDrivers", naming fields, never values; ADR 0032). The policy schema drops keys it does not know, so a misspelled key such as `consequentialTool` is ignored and its field keeps the default; TypeScript catches the typo, plain JavaScript does not. Without a `document.modelContext` (and no `modelContext` option), `attach()` still returns a handle, but the adapter only logs how to add a polyfill, sets `state.error` and never dials.

## The policy

| Field                | Type                               | Default     | Script tag                 | Effect                                                                                      |
| -------------------- | ---------------------------------- | ----------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| `autoApprove`        | `'none'` or `'observer'`           | `'none'`    | `data-auto-approve`        | `'observer'` lets members attach as observers with no prompt; invitees never                |
| `maxDrivers`         | an integer from 1 to 100           | `1`         | `data-max-drivers`         | How many people may drive at once, counting people, not clients                             |
| `consequential`      | `'confirm'`, `'allow'` or `'deny'` | `'confirm'` | `data-consequential`       | A consequential call prompts, runs, or is refused with `denied_by_operator`                 |
| `consequentialTools` | tool names, at most 128            | `[]`        | `data-consequential-tools` | Tools that are consequential whatever the runtime reports; the attribute is a comma list    |
| `invites`            | `'off'`, `'watch'` or `'all'`      | `'watch'`   | `data-invites`             | Which invites the operator may mint: none, Can watch, or Can watch and Can control          |
| `confirmVia`         | `'page'` or `'client'`             | `'page'`    | `data-confirm-via`         | Under `'confirm'`, whether a member driver confirms in their own client instead of the page |

How they combine: the relay seats a driver past `maxDrivers` as an observer, so a guest driving beside another driver needs `maxDrivers: 2` or more, and a Can control invite also needs `invites: 'all'`; without a free seat its guest joins as an observer. `confirmVia: 'client'` applies only under `consequential: 'confirm'`, to a member driver whose attachment no invite made, in a client that declares form elicitation; everyone else gets the page's prompt ([Sharing](06-sharing.md)). An empty `consequentialTools` names no tool, so on a runtime that drops `consequentialHint` every tool that is not read-only prompts (ADR 0034); a page that wants no prompts says `consequential: 'allow'`.

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

An absent attribute keeps the default, and so does a misspelled one, which is ignored without a word. A bad value logs `[tabdock] invalid data attributes for <fields>`, naming policy fields (`maxDrivers` for `data-max-drivers`); a missing `data-relay` logs `[tabdock] data-relay is required, for example ws://127.0.0.1:8787/page`, and one that is not a `ws:` or `wss:` URL `[tabdock] data-relay must be a ws: or wss: URL, for example ws://127.0.0.1:8787/page`, never repeating it; a file loaded as a module logs `[tabdock] load the adapter build with a classic <script> tag`; and in each case nothing attaches. The widget's hint notice names `data-consequential-tools` rather than `policy.consequentialTools`.

## The handle

`attach()` returns a frozen `Dock`. Its methods that return a boolean return `false` when there was nothing to act on, such as a request that already ended.

| Member          | Call                                   | Returns                      | What it does                                                                                                                                                |
| --------------- | -------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`         | `dock.state`                           | `DockState`                  | The current state, a frozen snapshot                                                                                                                        |
| `on`            | `dock.on('state', listener)`           | a function that unsubscribes | Calls the listener after every change; `'state'` is the only event, and any other name throws                                                               |
| `approve`       | `dock.approve(requestId, role)`        | boolean                      | Allows a pending attach request as `'driver'` or `'observer'`                                                                                               |
| `deny`          | `dock.deny(requestId)`                 | boolean                      | Denies it                                                                                                                                                   |
| `confirm`       | `dock.confirm(callId, allow)`          | boolean                      | Answers a consequential prompt; only `true` allows                                                                                                          |
| `rotatePairing` | `dock.rotatePairing()`                 | boolean                      | Asks the relay for a fresh pairing code; `false` while not linked                                                                                           |
| `setRole`       | `dock.setRole(userId, role)`           | boolean                      | Switches the role of someone approved here or let in by `autoApprove`; at `maxDrivers` the relay keeps a new driver an observer, though this returns `true` |
| `revoke`        | `dock.revoke(userId, { closeInvite })` | boolean                      | Ends one user's attachment, or everyone's with `'*'`, cancelling their calls and prompts; `closeInvite` also closes the invite that let them in             |
| `cancelInvite`  | `dock.cancelInvite(inviteId)`          | boolean                      | Closes one invite link; attachments it made stay until revoked                                                                                              |
| `invite`        | `dock.invite(options)`                 | `Promise<InviteResult>`      | Mints an invite, below                                                                                                                                      |
| `pause`         | `dock.pause(paused)`                   | nothing                      | `true` answers `page_busy` to every call not yet running, queued and prompted ones included; only `false` resumes; it survives a reload                     |
| `close`         | `dock.close()`                         | nothing                      | Detaches for good: denies open prompts, ends the page session at once, forgets the resume token and grants, and removes the widget                          |

Calls run under the least of the operator's grant here, the relay's roster and the role the call claims. Revoking someone an invite let in bars them from that invite; for a multi-use link, Revoke closes it unless `closeInvite` is `false`, and `revoke('*')` closes every link.

## Invites

`dock.invite(options)` mints an invite on the page, as far as `policy.invites` allows, on a relay with invites on (`TABDOCK_INVITES=1` and a public URL; [Sharing](06-sharing.md)). The secret is 128 bits from WebCrypto, which needs a secure context; only its SHA-256 leaves the page.

| `InviteOptions` field | Type                                                 | Default  | Meaning                                                                   |
| --------------------- | ---------------------------------------------------- | -------- | ------------------------------------------------------------------------- |
| `label`               | 1 to 60 characters                                   | required | Shown wherever the invite appears, as the page's own words                |
| `role`                | `'observer'` (Can watch) or `'driver'` (Can control) | required | Can control needs `invites: 'all'` and prompts the operator on redemption |
| `lifetime`            | `'15m'`, `'1h'` or `'open'`                          | `'1h'`   | `'open'` lasts while the page is open; no invite outlives 24 hours        |
| `uses`                | 1 to 20                                              | `1`      | Can watch only; Can control always has one                                |

The promise resolves once, with `{ ok: true, inviteId, link, expiresAt }`, the link being `<public URL>/i#<secret>`, or with `{ ok: false, reason }`. The reasons: `invalid` (bad options), `policy` (`policy.invites` forbids that role), `link_down`, `unavailable` (no invites on the relay, no WebCrypto, or no answer in 10 s), `no_public_url`, `limit` (10 live per page), `no_sponsor` (no member attached to sponsor it), `duplicate`, `expired` (the page's clock runs behind the relay's) and `cancelled` (closed before the relay answered). The link exists only in that result; the page stores the hash.

## The state

| `DockState` field | Type                                                                 | What it holds                                                                                             |
| ----------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `link`            | `'idle'`, `'connecting'`, `'linked'`, `'reconnecting'` or `'closed'` | The page link                                                                                             |
| `pageId`          | string or null                                                       | The relay's id for this page session, such as `pg_0123456789`                                             |
| `pairing`         | `{ code, url?, expiresAt }` or null                                  | The current code, and the QR link when the relay has a public URL                                         |
| `roster`          | attachments                                                          | Everyone attached, as the relay lists them: user, kind, role, clients, times, and the invite that made it |
| `pageRoles`       | one per roster entry                                                 | The role the page itself runs that user's calls under (null for none), and whether a revoke is pending    |
| `pendingRequests` | attach requests                                                      | `requestId`, `user`, `account`, `via` (`code`, `qr` or `invite`), `invite`, `client`, `expiresAt`         |
| `pendingConfirms` | consequential prompts                                                | `callId`, `tool`, `caller`, and `expiresAt`, the call's deadline                                          |
| `notice`          | string or null                                                       | Advice for the page author, such as the `consequentialHint` fallback                                      |
| `error`           | string or null                                                       | Why the link is not working, such as a missing `document.modelContext`                                    |
| `paused`          | boolean                                                              | The pause switch                                                                                          |
| `activity`        | the last 50 calls, newest first                                      | user, client, tool, outcome, `confirmedBy`, duration; never arguments or results                          |
| `invites`         | live invites                                                         | Those this page minted and its own record still holds                                                     |
| `invitesOffered`  | `{ linkBase }` or null                                               | Null until a relay with invites on says so                                                                |
| `joins`           | people let in by invite                                              | Newest first, while their grant lasts                                                                     |
| `observerSeats`   | people the driver limit held back                                    | Newest first: each `user`, `account` and `asked` (`'allow'` or `'promote'`), while they stay observers    |
| `policy`          | `Policy`                                                             | The policy `attach()` was given, with defaults filled in; a copy                                          |

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

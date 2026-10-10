# @tabdock/adapter

The browser library a web page loads to join [Tabdock](https://github.com/PaulMRamirez/tabdock), which lets MCP clients such as Claude attach to a live tab. It reads the page's WebMCP tools from `document.modelContext`, dials out to a Tabdock relay over a WebSocket, checks every call again on the page (roles, and a prompt for consequential tools), and shows the operator's widget. It never registers tools of its own. Apache-2.0.

Version 0.1.0 is prepared but not yet on npm. Until it is, build the adapter in a clone of the repository with `pnpm --filter @tabdock/adapter build`, or pack it with `pnpm release:pack` and install `dist/packages/tabdock-protocol-0.1.0.tgz` and `dist/packages/tabdock-adapter-0.1.0.tgz` together. Once 0.1.0 is on npm, `npm install @tabdock/adapter` is all it takes.

```ts
import { attach } from '@tabdock/adapter';

let count = 0;
const report = (error: unknown): void => {
  console.error(error);
};
document.modelContext
  ?.registerTool({
    name: 'increment',
    description: 'Add one to the counter and return the new count.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false },
    execute: async () => ({ count: ++count }),
  })
  .catch(report);
document.modelContext
  ?.registerTool({
    name: 'reset',
    description: 'Set the counter back to zero. This cannot be undone.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, consequentialHint: true },
    execute: async () => ({ count: (count = 0) }),
  })
  .catch(report);

const dock = attach({
  relay: 'ws://127.0.0.1:8787/page',
  policy: { consequentialTools: ['reset'] },
});
dock.on('state', (state) => {
  document.title = `Counter (Tabdock: ${state.link}, ${String(state.roster.length)} attached)`;
});
```

The page needs a WebMCP runtime first: Chrome's own, or MCP-B's polyfill (`@mcp-b/webmcp-polyfill`, whose `initializeWebMCPPolyfill()` on 5.x, or `installWebMCP()` on 6.x, must run before `attach()`). TypeScript knows no `document.modelContext`, so a typed page declares it, as [Add Tabdock to your app](https://github.com/PaulMRamirez/tabdock/blob/main/docs/guide/03-add-to-your-app.md#a-webmcp-runtime) shows. A tool is consequential when its `consequentialHint` is true or `consequentialTools` names it. Set both: MCP-B 5.x and Chrome 153 drop the hint, and there, on a page whose tools carry annotations but whose list names none, every tool that is not read-only prompts and the widget says how to fix it. A page that wants no prompts says `consequential: 'allow'`.

At a glance: `attach({ relay, policy, ui, modelContext })` takes a policy of `autoApprove`, `maxDrivers`, `consequential`, `consequentialTools`, `invites`, `confirmVia`, `imageTools` and `proposals`, and returns the only control handle, whose members are `state`, `on`, `approve`, `deny`, `confirm`, `rotatePairing`, `setRole`, `revoke`, `cancelInvite`, `invite`, `pause`, `close`, `publishState`, `acceptProposal`, `dismissProposal`, `dismissAllProposals`, `startSession`, `extendSession`, `endSession`, `renewSessionLink`, `agentToken`, `cancelAgent`, `sessionRecord` and `discardRecord`. The guide has the whole story: [Add Tabdock to your app](https://github.com/PaulMRamirez/tabdock/blob/main/docs/guide/03-add-to-your-app.md), the [adapter reference](https://github.com/PaulMRamirez/tabdock/blob/main/docs/guide/04-adapter-reference.md) with every option, type and default, [the control handle](https://github.com/PaulMRamirez/tabdock/blob/main/docs/guide/13-the-control-handle.md) with every member and state field, and [Security](https://github.com/PaulMRamirez/tabdock/blob/main/docs/guide/10-security.md).

## Getting the adapter

A page gets the adapter in one of two ways ([ADR 0028](https://github.com/PaulMRamirez/tabdock/blob/main/docs/adr/0028-packaging-and-release.md)). An app with a build step installs the package and calls `attach()` as above; the package is compiled JavaScript with type declarations, ESM only, and exports `.` alone. Any other page loads the script-tag build, `dist/tabdock-adapter.js` in the same package, one self-contained file held under 200,000 bytes ([ADR 0048](https://github.com/PaulMRamirez/tabdock/blob/main/docs/adr/0048-script-tag-ceiling-for-m6.md)). Serve it from your own origin; a clone builds it today. Once 0.1.0 is on npm, a page may instead load jsDelivr's copy of the npm file, pinned to an exact version with `crossorigin="anonymous"` and the `integrity` digest from the release asset `tabdock-adapter.integrity.txt`, which holds the digest and a ready tag. Load the WebMCP polyfill first:

```html
<!-- the polyfill from @mcp-b/webmcp-polyfill's dist/index.iife.js, then the adapter -->
<script src="/vendor/webmcp-polyfill.js"></script>
<script
  src="/vendor/tabdock-adapter.js"
  data-relay="ws://127.0.0.1:8787/page"
  data-consequential-tools="reset"
></script>
```

The script-tag build reads `data-relay`, `data-auto-approve`, `data-max-drivers`, `data-consequential`, `data-consequential-tools`, `data-invites`, `data-confirm-via` (`page` or `client`), `data-image-tools` and `data-proposals` (`off`, `members` or `all`) from its own tag, and attaches once the document has parsed, so a polyfill loaded as a module script is in place first. It keeps the handle to itself: the widget is its only control surface, and it cannot set `ui: false` or `modelContext`. A bad value logs `[tabdock] invalid data attributes for <fields>` to the console, naming policy fields (`maxDrivers` for `data-max-drivers`), and nothing attaches; a misspelled attribute is ignored without a word, and a `data-relay` that is not a `ws:` or `wss:` URL logs `[tabdock] data-relay must be a ws: or wss: URL ...`, repeating no value, and nothing attaches. Its hint notice names the `data-consequential-tools` attribute where `attach()`'s names `policy.consequentialTools`.

The relay never serves the adapter: its checks (S5's second layer) and S6's prompts run on the page precisely so that they do not come from the relay they check. Importing the package turns zod's jitless mode on for the whole page, as the script tag always has, and sets zod's English messages only where the page chose no locale. `@tabdock/protocol` comes with it at the same exact version.

## Errors and secrets

`attach()` throws a `TypeError` for a relay URL that is not `ws:` or `wss:`, and for a policy value it cannot use, naming the policy's bad fields and never their values ([ADR 0032](https://github.com/PaulMRamirez/tabdock/blob/main/docs/adr/0032-fixes-from-the-m5-step-1-review.md)), so a mistake fails at once rather than as a link that never comes up. A key the policy does not know is dropped rather than refused, so a misspelling such as `consequentialTool` leaves that field at its default; TypeScript catches it, plain JavaScript does not. Without `document.modelContext` the adapter logs how to add a polyfill, sets `state.error` and stays idle.

The pairing code shows in the widget for the operator to read out; never log it, print it or send it anywhere else, and the same goes for resume tokens, invite links and the pairing URL in `state.pairing.url`, whose fragment is a single-use nonce ([SPEC](https://github.com/PaulMRamirez/tabdock/blob/main/SPEC.md) section 9, S11). Anyone who sees a live code can ask to attach.

## How it works inside

The rest of this page is for contributors and for anyone who wants the details behind the guide.

**The handle.** `attach()` returns the only control handle; with `ui: false` no widget is mounted and the handle answers prompts. `modelContext` replaces `document.modelContext` as the WebMCP context the adapter reads. Every method that returns a boolean returns false when there was nothing to act on; `pause` and `close` return nothing, and `invite` a promise.

`setRole(userId, role)` works, while the link is up, for a listed user the operator approved on this page (or that `autoApprove: 'observer'` let in) and who is not pending a revoke, and returns false otherwise. It records the operator's choice before telling the relay, which may still hold a driver at `maxDrivers`; calls always run under the lesser of that choice, the relay's roster and the role the call claims.

`revoke(userId)` (or `'*'` for everyone) drops the grant, denies that user's pending request and prompts, cancels their calls in flight and tells the relay. `pause(true)` answers `page_busy` to every call not yet running, queued and prompted ones included, while calls already running finish; it is stored beside the grants, so a reload stays paused, and only `pause(false)` resumes. `close()` detaches for good: it denies open prompts, ends the page session at once, forgets the resume token and grants, and removes the widget.

The resume token, grants, pending revokes and pause belong to one page, its origin and path, so another page of the site in the same tab starts its own session and is approved anew ([ADR 0011](https://github.com/PaulMRamirez/tabdock/blob/main/docs/adr/0011-one-approval-per-page.md)). `state.activity` holds the last 50 calls, newest first, with user, client, tool, outcome and duration, never the arguments.

**Consequential calls.** `consequential: 'confirm'` (the default) prompts the operator for each consequential call, `'allow'` runs it, and `'deny'` refuses it with `denied_by_operator`. Where the runtime cannot report `consequentialHint` and the page names no tool in `consequentialTools`, no list or an empty one, every tool that is not read-only counts as consequential ([ADRs 0002](https://github.com/PaulMRamirez/tabdock/blob/main/docs/adr/0002-consequential-tools-without-hint.md) and [0034](https://github.com/PaulMRamirez/tabdock/blob/main/docs/adr/0034-an-empty-consequential-list.md)); a page whose tools carry no annotations at all declared no hints, so only its list applies. Every tool the page counts as consequential carries `consequential: true` in the tools frame.

`policy.confirmVia: 'client'` (default `'page'`; `data-confirm-via` on the script tag) lets a member driver whose attachment no invite made confirm a consequential call under `consequential: 'confirm'` in their own MCP client, where it declares form elicitation, instead of the operator here ([ADR 0026](https://github.com/PaulMRamirez/tabdock/blob/main/docs/adr/0026-confirmation-in-the-client.md)). The page skips its prompt only under its own policy, its own consequential rule and its own grant for that caller, so invitees, observers and invite-made attachments still get the prompt. `state.activity` marks such calls `confirmedBy: 'client'`, shown as "confirmed in <client> by <name>".

**Invites.** With a relay that offers invites ([ADRs 0016](https://github.com/PaulMRamirez/tabdock/blob/main/docs/adr/0016-invites-and-guest-access.md) and [0017](https://github.com/PaulMRamirez/tabdock/blob/main/docs/adr/0017-invite-wire-format.md)), `invite({ label, role, lifetime, uses })` mints one as far as `policy.invites` allows (`watch` by default, `all` for Can control too, `off` for none). It draws a 128-bit secret with WebCrypto, keeps a record of its SHA-256 and terms beside the grants (never the secret), sends the relay only the hash, and resolves once with the link `<public URL>/i#<secret>`, or with why there is none.

The page honours a redemption only against that record and the secret the relay presents. A Can watch link lets its holder in as observer without a prompt; a Can control one prompts (one at a time, burnt by three refusals or timeouts); and neither gives more than its role, past its uses or its end, to anyone revoked from it, or 24 hours after joining. `revoke(userId)` bars someone an invite let in from it and, by default for a multi-use link, closes it (`{ closeInvite: false }` keeps it open); `revoke('*')` closes every link; `cancelInvite(id)` closes one; no redemption ever undoes a revoke; and a session the relay does not resume drops every record.

`state.invites` lists the live ones the page's own record holds, `state.invitesOffered` says what the relay offers, and `state.joins` names whom the page itself let in by invite (while their grant lasts). Invitees, whose ids start `g_`, appear in logs by a short id, never by email.

**Prompts and ids.** A UI port's answer counts only for the very request or consequential prompt it was asked about while that one still waits, so a late answer never settles another the relay sent under the same id. The page takes no call under the id of any of its last 1,000 prompts, so `confirm(callId)` from a host dialog still showing a settled prompt answers nothing.

**Built-ins taken early.** The adapter takes WebCrypto's `getRandomValues` and `digest`, `TextEncoder`'s `encode`, `Uint8Array` and `WebSocket` once, at load or `attach()`, so a page script that replaces them later can neither predict a secret nor sit inside the page link. What such a script can still reach is in the [threat model](https://github.com/PaulMRamirez/tabdock/blob/main/docs/threat-model.md) (B5).

**Write order.** Writes (any tool the page does not mark read-only) run one at a time in arrival order on the page even if a relay sends several at once, each holding the page until its handler ends; reads run beside them. The one exception is on the MCP-B polyfill when the page unregisters a tool while its write runs: the page then waits until that call's deadline plus 2 s and lets the next write go, possibly beside the old handler ([ADR 0001](https://github.com/PaulMRamirez/tabdock/blob/main/docs/adr/0001-webmcp-runtime-variance.md)'s notes, [ADR 0012](https://github.com/PaulMRamirez/tabdock/blob/main/docs/adr/0012-contract-clarifications-m2.md)).

**The widget.** It shows the pairing code, the prompts, a roster row per user (role, clients, expiry, a role switch and Revoke), Revoke all, the activity log and a pause switch whose state also shows on the badge. When the relay's pairing carries a URL (a relay with a public URL), a QR code of it sits beside the code so a phone can scan instead of typing; it is redrawn for each new pairing and goes when a pairing comes without one.

The QR code is drawn at error correction level M with a four-module quiet zone, as one SVG path built with `createElementNS` from `qrcode-generator`'s module matrix, never the library's SVG string or data URL, so it works on pages that enforce Trusted Types, with its own white ground and 124 px size as attributes, so it stays scannable on a dark page that refuses the widget's styles. It draws only the shape the relay builds, `<https origin>/pair#<22 base64url characters>`, spelled exactly as a URL parser spells it back (so no credentials, backslashes, other paths, queries or fragments), in printable ASCII and at most 256 characters; anything else gets no QR code, and the typed code still works.

The widget's styles go into its shadow root as a constructed stylesheet (`adoptedStyleSheets`), which no `style-src` governs, so a page whose CSP leaves out `'unsafe-inline'` still shows the widget styled; a `<style>` element is used only where the browser cannot adopt sheets.

An Invite section offers a form (a label, Can watch or Can control as the policy allows, 15 minutes, 1 hour or while the page is open, and uses for Can watch). It shows the new link once, as a QR code drawn the same way (`inviteQrUrl` accepts only `<https origin>/i#<22 base64url characters>`) and as text with Copy, until Done or until its invite ends, and lists live invites with how many joined and a Cancel; while the link is down the section stays and says why Create waits. Copy writes through the clipboard's `writeText` as it was when the widget mounted.

Roster rows, prompts and activity lines name an invitee by verified email or "unverified account" with the first 8 characters of their id and an "invited" badge; a Can control prompt names the account beside the invite's label. A join by invite shows a notice, taken from the page's own honour decisions (never from the roster) and naming the role the page runs the guest under, which opens the panel, keeps the badge asking for attention until it has been seen and stays until it has been on screen for 20 s. A row for someone a multi-use link let in offers "and close this link", checked.

Prompt boxes, roster rows, the pause switch and the Invite form take a click only once they have held still for half a second, and wait again whenever they move or their buttons change meaning, as when the form switches between Can watch and Can control.

**Building.** In this workspace `pnpm --filter @tabdock/adapter build` writes the library build and `dist/tabdock-adapter.js` with its source map (`build:script-tag` writes the script-tag file alone), and [`tests/e2e/test/adapter-size.test.ts`](https://github.com/PaulMRamirez/tabdock/blob/main/tests/e2e/test/adapter-size.test.ts) builds that file with the same options and fails at 200,000 bytes or more. The package still exports its TypeScript sources here ([ADR 0003](https://github.com/PaulMRamirez/tabdock/blob/main/docs/adr/0003-toolchain.md)), and only packing builds it for npm. Licensed Apache-2.0; see the NOTICE file in this package.

**Inside the workspace only** (the published package exports `.` alone, so these are not importable from npm): [`packages/adapter/src/core.ts`](https://github.com/PaulMRamirez/tabdock/blob/main/packages/adapter/src/core.ts), the workspace's `./core` export, holds all behaviour and touches no browser global, so the Node sim page runs the same code. [`packages/adapter/src/index.ts`](https://github.com/PaulMRamirez/tabdock/blob/main/packages/adapter/src/index.ts) and [`packages/adapter/src/page.ts`](https://github.com/PaulMRamirez/tabdock/blob/main/packages/adapter/src/page.ts) wire it to the page, and [`packages/adapter/src/widget.ts`](https://github.com/PaulMRamirez/tabdock/blob/main/packages/adapter/src/widget.ts) renders the badge and panel in a closed shadow root, with [`packages/adapter/src/qr.ts`](https://github.com/PaulMRamirez/tabdock/blob/main/packages/adapter/src/qr.ts), the workspace's `./qr` export so browser tests can compare its drawing with the library's matrix, drawing the pairing QR code. [`packages/adapter/src/taken.ts`](https://github.com/PaulMRamirez/tabdock/blob/main/packages/adapter/src/taken.ts) and [`packages/adapter/src/dom.ts`](https://github.com/PaulMRamirez/tabdock/blob/main/packages/adapter/src/dom.ts) hold the built-ins and DOM calls the adapter takes by the time `attach()` returns, so that a page script that patches one later is handed no secret, relay frame or widget node through it. The runtime differences it absorbs are recorded in [`docs/notes/baseline.md`](https://github.com/PaulMRamirez/tabdock/blob/main/docs/notes/baseline.md) and [ADRs 0001](https://github.com/PaulMRamirez/tabdock/blob/main/docs/adr/0001-webmcp-runtime-variance.md) and [0002](https://github.com/PaulMRamirez/tabdock/blob/main/docs/adr/0002-consequential-tools-without-hint.md).

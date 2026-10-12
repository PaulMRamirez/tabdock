# @tabdock/protocol

The wire format that Tabdock's adapter and relay share: every page link frame as a `zod/mini` schema with its TypeScript type, the fixed limits and timings, the error codes MCP clients see, and the shapes of invites and audit records. Tabdock links a live web page's WebMCP tools to MCP clients through a relay; the repository, with the user guide, is [github.com/PaulMRamirez/tabdock](https://github.com/PaulMRamirez/tabdock).

Most apps never import this package: `@tabdock/adapter` and `@tabdock/relay` bring it with them, at their own version. You need it to write another adapter or relay, a client of the page link, or a test harness that checks what Tabdock sends.

```ts
import { ERROR_CODES, PolicySchema, untrustedHeader } from '@tabdock/protocol';

// A page's policy with its defaults filled in, as the relay reads it from hello.
const policy = PolicySchema.parse({ consequentialTools: ['clear_board'] });
// { autoApprove: 'none', maxDrivers: 1, consequential: 'confirm',
//   consequentialTools: ['clear_board'], invites: 'watch', confirmVia: 'page',
//   imageTools: [], proposals: 'off' }

ERROR_CODES.includes('not_confirmed'); // true: the 14 codes a tool error starts with
untrustedHeader('https://app.example', 'add_item');
// '[tabdock: untrusted content from https://app.example, tool add_item]'
```

Once 0.1.0 is on npm, `npm install @tabdock/protocol` installs it; until then it is a workspace package in a clone of the repository. 0.1.0 carries the page link as M5 left it; the modules and fields for images, page state, proposals, time-boxed sessions, members files, agent tokens, session records and the restart snapshot, `@tabdock/protocol/devtools` among them, arrive in the release after 0.1.0, and until then work from a clone. The [troubleshooting page](https://github.com/PaulMRamirez/tabdock/blob/main/docs/guide/11-troubleshooting.md) explains each error code and limit, and the [adapter reference](https://github.com/PaulMRamirez/tabdock/blob/main/docs/guide/04-adapter-reference.md) each policy field.

## What it holds

The schemas follow [SPEC.md](https://github.com/PaulMRamirez/tabdock/blob/main/SPEC.md) sections 5 to 7. Both sides validate every frame with them and infer their TypeScript types from them, so this package is the single place the wire format is defined.

`constants.ts` holds the fixed numbers (the subprotocol, size limits, invite, image, state, proposal, session, members file, agent token and session record bounds) and `errors.ts` the error codes MCP clients see, `invite_required` from M4, `not_confirmed` from M5 (ADR 0026) and `proposal_not_found` from M6 (ADR 0042), with the relay's fixed lines: the untrusted label, `imageLine` between that label and an image, and `pageStateHeader` above a page's published state. `page-link.ts` defines the page link's frames: M4's `invite_create`, `invite_cancel` and `invites`; M5's optional `policy.confirmVia`, per-tool `consequential` mark and invoke `confirmation` (ADR 0026); and M6's `policy.imageTools` and `policy.proposals`, the result's `image`, the invoke's `proposal`, an `attach_request` `via: 'agent'`, the welcome's `maxImageBytes`, `maxStateBytes`, `usersPerPage` and `observersPerPage`, and the frames `state`, `proposal`, `proposal_decision`, `proposal_end`, `session_start`, `session_extend`, `session_end`, `session`, `agent_create`, `agent_cancel` and `agents` (ADRs 0039 to 0044).

The link stays `tabdock.v1`: every field M5 and M6 added is optional, so an older peer's frames still parse, but M6's frame types and `via: 'agent'` are new to an M5 peer, which is why M6 ships in a new minor version. `invites.ts` holds the invite link `<public URL>/i#<secret>` and `pair_page`'s input (ADR 0017); `images.ts` the one strict check the adapter and the relay both run on an image result, its type, size, base64, first bytes, header dimensions and the chunk headers that mark a PNG or WebP animated, never decoding pixels (ADR 0039 and its notes); `sessions.ts` how a time-boxed session's policy narrows the page's own, never wider (ADR 0043); `members.ts` one entry of the member list, read alike from `TABDOCK_OAUTH_USERS` and a members file (ADR 0043); `session-record.ts` the session record the widget saves and `tabdock-relay audit --match` reads, strict so no argument or result can ride in (ADR 0045); and `snapshot.ts` the restart snapshot, holding digests in place of every secret (ADR 0046).

`storage.ts` holds what the adapter keeps in the tab's storage beside its resume token, read back as warily as a frame (ADR 0011), and `audit.ts` the relay's audit records and file lines (ADR 0019), each type a strict object listing exactly the fields it may hold, so nothing else can reach the log. `devtools.ts` checks the Chrome DevTools protocol replies that `@tabdock/adapter/testing` acts on (ADR 0041); it is exported only at the `./devtools` subpath, `@tabdock/protocol/devtools`, in `exports` and `publishConfig.exports` alike, never from the package's root, `.`, so neither the relay nor a page's bundle carries it. The schemas are built on `zod/mini` (ADR 0028), which keeps the adapter's script-tag build small; `zod-config.ts` runs zod jitless, so loading the adapter on a page that enforces Trusted Types reports no violation, and sets English messages unless a locale is already set. The ADRs are in [docs/adr](https://github.com/PaulMRamirez/tabdock/tree/main/docs/adr).

## The published package

From npm (ADR 0028) the package is compiled JavaScript with type declarations, ESM only, published at the same version as `@tabdock/adapter` and `@tabdock/relay`, which depend on it at exactly that version. Its schemas are `zod/mini` schemas: they keep `parse` and `safeParse` but not classic zod's chained methods such as `.optional()` or `.array()`, so code that builds on them uses `zod/mini`'s functions (`z.optional(schema)`, `z.array(schema)`); an older peer's frames still parse, since every field M5 and M6 added is optional. Importing it runs `zod-config.ts`, which turns zod's jitless mode on for the whole page or process and sets English only where no locale is set, which is why the package never declares `sideEffects: false`; it names `zod-config` as its only side effect instead, so a bundler may drop the modules a page never imports (ADR 0048's notes). In the workspace it still exports its TypeScript sources (ADR 0003), and `pnpm --filter @tabdock/protocol build` writes `dist/` only when a release packs it. Licensed Apache-2.0; see `NOTICE`.

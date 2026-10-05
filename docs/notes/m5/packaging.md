# Release 0.1.0: packages, publishing and a slimmer adapter (M5 research)

Checked on 5 October 2026 against the npm registry, docs.npmjs.com, GitHub's changelog, pnpm.io, code.claude.com/docs/en/mcp, zod.dev, chromestatus, the W3C secure contexts and mixed content drafts, and tarballs in `/tmp/m5-pack` (npm 12.2.0, zod 4.6.5, tsup 8.5.1). Probes ran in a scratch copy, `/tmp/m5-pack/repo`: a zod/mini protocol, a built relay installed from its tarball, Claude Code 2.1.289 in a throwaway HOME, and Chrome for Testing 154 (Stable). Nothing in the repo changed.

## Names

`@tabdock/relay`, `@tabdock/adapter`, `@tabdock/protocol` and unscoped `tabdock` all return 404, and the scope endpoint answers "Scope not found" for `tabdock` while it lists packages for org and user scopes alike, so nobody holds the scope. It is first come, first served: the owner should create the free npm org `tabdock` before anything else. I would publish nothing under unscoped `tabdock`.

## The relay as an npx package

Node 22.22 still refuses to strip types under `node_modules`, so the package ships JavaScript. tsup's README now says it "is not actively maintained anymore", so esbuild 0.28.2, already in the adapter build, does it. The prototype bundled `main`, `argument-worker` and `audit-cli`, dependencies external, into a 125,654-byte tarball; installed (11 packages, 22 MB), its bin started local mode, refused `/mcp` without the token, served it with one, and the worker reported ready.

Five things assume a checkout. The worker URL names `argument-worker.ts`. `CHECKOUT` in `local-token.ts` is `../../..` from the module, inside an install the `node_modules` directory, so its refusal would guard nothing; packaged, it should be the git work tree around the current directory, so a `TABDOCK_HOME` inside one's project is still refused. `main.ts` loads `../../../.env`; the bin should read no implicit `.env`. The banner points at `pnpm dev:public` and `docs/deploy.md`. `RELAY_VERSION` is a literal `0.0.0`, which `relay_start` records. One bin, `tabdock-relay`, keeps `npx @tabdock/relay` unambiguous (npm runs a sole bin), with `audit` as a subcommand and `--new-token` drawing a token through the same atomic link and checks. npm recommends `npm-shrinkwrap.json` for CLIs, so the relay ships one, pinning the transitive tree. `pnpm pack` 10.28 applies `publishConfig` overrides of `bin` and `exports`, rewrites `workspace:*` to the exact version and adds the root LICENSE but not NOTICE, which each package must carry.

`@tabdock/protocol` should be published, not bundled, because the adapter's types reference it. TypeScript 6.0.3 with `rewriteRelativeImportExtensions` emitted it with declarations; Node loaded it and a NodeNext consumer typechecked with `skipLibCheck` off. Its package.json must not say `sideEffects: false`, since `zod-config.ts` works only by side effect.

## The banner: add-json with headersHelper

The docs say a `headersHelper` prints a JSON object within 10 seconds, runs at every connection and again after a 401, and waits for the trust dialog only in project `.mcp.json` and local scope; ADR 0022 assumed it always did. In the probe, `claude mcp add-json --scope user` with a helper in a path holding spaces connected, `~/.claude.json` held no token and `claude mcp get` showed none; at local scope the same entry printed "headersHelper not run" and failed. So the relay should write `claude-headers` beside the token (0700, a `#!/bin/sh` that reads the token file, holding no token), check its owner, mode and exact content each start as it checks the token, and print, on POSIX:

`claude mcp add-json --scope user tabdock-local '{"type":"http","url":"http://127.0.0.1:8787/mcp","headersHelper":"/home/u/.config/tabdock/claude-headers"}'`

with the path in escaped double quotes when it holds spaces (macOS) and fully quoted otherwise. The token leaves `claude`'s argument list and `~/.claude.json`, which tightens S11, and `--new-token` needs no change in Claude Code. Windows keeps today's line until a Windows run shows which shell runs helpers.

## zod/mini

zod `latest` is still 4.6.5. Today's IIFE is 286,140 bytes minified (87,242 gzip, 74,542 brotli), not M1's 213 KiB; zod is 192 KB of it, 29 KB being the compiler that jitless mode never runs. With `page-link.ts`, `invites.ts`, `storage.ts`, `audit.ts` and `zod-config.ts` on `zod/mini` in the scratch copy, it fell to 126,658 bytes (43,536 gzip, 38,660 brotli). All 144 protocol tests, 1,057 relay and adapter tests (one failure is the copy's missing `docs/` symlink target) and 38 Playwright specs, Trusted Types and `later-scripts` among them, passed. Nine call sites use classic methods on protocol schemas (`auth.ts`, `mcp.ts`, `oauth.ts`, `IdSchema.array()` in `core.ts`). Traps: arrays take `z.maxLength`, not `z.maxSize`; mini loads no locale, so `zod-config.ts` sets `en` beside `jitless`; a classic object holding mini schemas throws "Non-representable type" from `~standard.jsonSchema`, which the SDK reads, so fixed tools' inputs stay classic; and the SDK imports classic `zod/v4`, so the relay keeps classic for its own schemas.

## Serving the adapter from the local relay

`http://127.0.0.1` is potentially trustworthy, so not mixed content, but Local Network Access gates it: Chrome 142 for subresources, a `loopback-network` permission from 145, WebSockets from 147. In Chrome 154 a page treated as public loaded neither the loopback script nor the page socket until that permission was granted; then SRI worked only with `crossorigin="anonymous"` and `Access-Control-Allow-Origin`, and a wrong digest was refused. Serving it makes the relay supply the code that runs S5's second check, so a compromised or squatting relay could remove it; pinned SRI narrows that, but jsDelivr and unpkg already serve npm files with `Access-Control-Allow-Origin: *`, CORP `cross-origin` and `nosniff`. I recommend no: ship `dist/tabdock-adapter.js` in `@tabdock/adapter` and give a jsDelivr tag with its `integrity` in the release notes, or self-host it. The GitHub Pages demo aimed at a local relay now meets that prompt too.

## Publishing and release

Trusted publishing needs npm 11.5.1, Node 22.14, a GitHub-hosted runner, `id-token: write`, the exact workflow filename and `repository.url`, and a public repo (this one is) for its automatic provenance. Publishers configured after 3 September 2026 may only `npm stage publish` unless direct publishing is ticked; a staged version goes live when a maintainer approves it with 2FA after the malware scan. A trusted publisher needs an existing package; tokens are granular only, stage-only ones exist, and direct token publishing ends in January 2027. Node 22's npm 10.9.9 is too old, so the publish job alone runs Node 24.21.0 (npm 11.19.0).

First publish, options: (A) the owner publishes by hand from a laptop, with no provenance; (B) CI stages 0.1.0 with a one-day stage-only token, the owner approves with 2FA, then adds trusted publishers and deletes the token; (C) placeholder versions. I recommend B: no laptop, no direct-publish credential, and npm 12.2.0's source sends staged publishes through the same provenance path (unconfirmed live).

Mechanics: the three packages move together to 0.1.0, with one root `CHANGELOG.md` and tag `v0.1.0`. After the release PR, Claude drafts the GitHub release and the owner publishes it from the phone, starting `publish.yml`: a build job packs and checks the tarballs (version equals tag, a file allowlist, no tests, `.env` or token); a job in environment `npm` (required reviewer, `v*` tags only, self-review prevention off for a sole maintainer) stages protocol, adapter and relay; a last job attaches tarballs, `SHA256SUMS` and the IIFE's SRI line to the release.

Only the owner can create the npm account with 2FA and the `tabdock` org; create the `npm` environment; for 0.1.0, make the stage-only token for `@tabdock`, without 2FA bypass, that environment's secret; approve the job and the three staged versions; then add a trusted publisher to each package (`PaulMRamirez/tabdock`, `publish.yml`, environment `npm`, stage only), delete the token and choose "Require two-factor authentication and disallow tokens".

No section 9 rule weakens. The packaging, banner and script-tag decisions amend ADR 0022 and need one new ADR.

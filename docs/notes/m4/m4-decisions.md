# M4: what the research changes, what you decide, and the plan

Synthesis of the five M4 research files beside this one (hosting, audit, signin, container-threat, invites-map), checked against `CLAUDE.md`, `SPEC.md`, ADRs 0013, 0014 and 0016, `docs/plans/backlog.md` and `docs/plans/M3.md` on branch `m4-cloud` at 4aa1464, 3 October 2026. I added three checks of my own today: domain prices from Porkbun's pricing API, the licences of the proposed CI actions, and GitHub's rules for protected environments on a free plan.

## 1. Where SPEC and accepted ADRs no longer fit M4

CLAUDE.md asks me to raise every place where the code or the research and the spec disagree, and to change the spec only through an ADR. I found 30, grouped into five proposed ADRs. Each item names the place, the problem and the resolution I propose.

### ADR 0017: invite wire format and clarifications of ADR 0016

1. **SPEC section 6.** There are no invite frames. `attach_request` has no account or invite field, roster entries have no kind and no end time, and the `revoke "*"` row does not mention invites. **Resolution:** add three frames. `invite_create` (page to relay) carries an `inviteId` the adapter draws, `role`, a `label` of up to 60 characters, `uses` from 1 to 20, `expiresAt` or null, and a 64-hex `secretHash`. `invite_cancel` (page to relay) carries an `inviteId`. `invites` (relay to page, after each `welcome` and on every change) carries `linkBase`, up to 32 live invites with uses left, sponsor, pending and refusals, and an optional `refused` reason. `attach_request` gains `account` (`kind`, `verified`) and, for `via: 'invite'`, an `invite` object with `inviteId`, the presented secret and the label. Roster entries gain `kind`, `inviteId` and `endsAt`. `revoke "*"` also cancels every invite. Secrets are 22 base64url characters, which is 128 bits.
2. **SPEC section 7, line 116.** "The last covers arguments the relay will not forward" now points at `invite_required` instead of `invalid_arguments`. **Resolution:** name `invalid_arguments` in that sentence.
3. **SPEC section 7 and ADR 0016.** `pair_page` takes only `code`. ADR 0016's "pair_page also takes a single-use link" could mean an invite minted for one use, or any link used once. **Resolution:** `pair_page` takes exactly one of `code` or `invite`, and accepts only invites minted for one use, since a link pasted into a chat stays in its history. The argument is a redacted log field.
4. **SPEC section 5.** User has no kind or email, and Attachment has no `inviteId` or `endsAt`. **Resolution:** add them. An invitee's `userId` is `g_` plus the digest of its `sub`, a shape the config refuses for members.
5. **SPEC section 8.** The example policy has no `invites` field, the control handle has no `invite()`, and stored state has no invite records. **Resolution:** add `invites: 'watch'` to the example. `dock.invite({ label, role, lifetime, uses })` returns the link once. The adapter keeps each invite's id, secret hash, terms, refusal count and bars beside its grants under ADR 0011's key, never the secret itself, and drops both on `resumed: false`.
6. **ADR 0016.** "With invites on" names no switch. **Resolution:** add `TABDOCK_INVITES`, off by default, which keeps M3's 403 for accounts not on the allowlist. With invites on, the relay refuses to start if the user limit per page is 2 or less, since that leaves no invite seats.
7. **ADR 0016's sponsor rule.** It does not say which member is the sponsor when several are attached, or whether "no sponsor is left" means that member or any member. **Resolution:** the sponsor is the member who has been attached longest when the invite is minted. It stays fixed for the invite's life, because `/i` showed that name. When that member's attachment ends in any way, their invites end, and so do the attachments those invites made.
8. **ADR 0016's lifetimes.** "While the page is open" has no upper bound, although invite-made attachments end after 24 hours. **Resolution:** every invite lasts at most 24 hours and 20 uses, and a page holds at most 10 live invites.
9. **ADR 0016 and `hub.ts:1339`.** A control invite redeemed while the page's one driver seat is taken is silently granted observer. **Resolution:** the prompt says the guest will join as observer. The operator can promote them with `set_role` once a seat is free.
10. **ADR 0016.** What happens when a member redeems an invite is undefined. **Resolution:** treat the attachment as invite-made, with the invite's role cap, 24-hour end and seat rule.
11. **ADR 0016 and the dev-token plugin.** Dev tokens have no invitee kind, so invite tests and the demo would need OAuth. **Resolution:** a dev-token entry may mark a user as `invitee`, outside public mode only.
12. **ADR 0016.** "Refuse a display name that copies a member's" has no rule for comparing names. **Resolution:** compare names after NFKC normalisation and case folding. On a match, show the short id instead of the name.
13. **ADR 0016's barring.** A bar keyed only on `sub` can be shed: AuthKit deletes users fully, so the same person can sign up again under a new `sub`. **Resolution:** for the invite's life, bar the `sub` digest and also, when the email is verified, the email's digest.
14. **S14.** It leaves out sponsor loss, the three-refusal burn, barring, name copying, and the limits per user, per invite and per page. **Resolution:** extend S14's text to list them, each with its own test.

### ADR 0018: the relay on a host behind a TLS-terminating edge

15. **S12 and `config.ts:402-405`.** The relay binds only loopback "until TLS arrives in M4". On a host, TLS ends at the platform's edge, so the container must listen on its internal interface. **Resolution:** in production, with an https public URL and a named client-address header, the relay may bind `0.0.0.0` or `::`. S12 becomes "the relay binds loopback unless it runs in production behind a host edge that terminates TLS; every public URL is https".
16. **SPEC section 2's relay-trust line.** It names only a tunnel. **Resolution:** "a tunnel or host edge that terminates TLS in front of it" also sees plaintext. The threat model names Fly's proxy.
17. **ADR 0014 and `relay.ts:88-96`.** In public mode `/page` accepts only local upgrades with no `Forwarded` or `X-Forwarded-*` header, and every platform proxy adds those. **Resolution:** in hosted mode, `/page` accepts upgrades through the public host. The client address comes from exactly one configured header, `TABDOCK_CLIENT_ADDRESS_HEADER` (`fly-client-ip` on Fly), which must appear once and parse as an IP address. Every other forwarding header is ignored, and IPv6 addresses are grouped by /64 for limits. Outside hosted mode, M3's rule stays.
18. **S3 and ADR 0013's notes.** Both defer a per-address share of the `/pair` sign-in budget until M4 has a trusted address. **Resolution:** each address gets 10 sign-ins a minute and 2 in flight, shared across `/pair` and `/i` and sized for carrier NAT. The relay-wide limits of 60 a minute and 8 in flight stay as a backstop. `/mcp` stays per user, since all hosted Claude traffic arrives from one address range.
19. **No health route.** The exact Host allowlist would answer a platform probe with 403. **Resolution:** add `GET /healthz`, which answers 204 with no body and no log line. It runs after the RFC 9110 Host syntax check and before the allowlist and auth.
20. **SPEC section 4.** "One process" is enforced by no host setting, and two overlapping instances would split the in-memory store. **Resolution:** the deploy guide requires one Machine with a volume, deploys that stop the old Machine before starting the new one, and `auto_stop_machines` off.

### ADR 0019: persistent audit log and restart state

21. **S7 and `hub.ts:1943-1956`.** S7 says every call is audited, but the access check runs before the call rate limit, so `not_attached` refusals are never budgeted. With invites on, any stranger who signs up could write about 2.7 GB of audit a day. **Resolution:** each user gets a call budget, checked before the access check. Refusals past it become one `refused_summary` record per user per minute, under a relay-wide cap. S7 becomes "every call that reaches a page, and refused calls up to a per-user budget, past which they are counted".
22. **SPEC section 4 and M4's scope.** Both ask for a persistent audit log, but nothing sets its format, retention, failure behaviour or contents beyond S7's keys. **Resolution:** use D3's design with the defaults in section 2. The record types are `call`, `attach`, `attach_refused`, `role`, `revoke`, `detach`, `expire`, `invite_minted`, `invite_redeemed`, `invite_closed`, `sponsor_gone`, `relay_start`, `relay_stop`, `audit_gap` and `refused_summary`. The log never holds arguments, results, tokens, codes, secrets or their hashes, `sub`, addresses or page-written labels. Client text that fails the id or tool-name schema is stored as `(invalid, N chars)`. `TABDOCK_AUDIT_DIR` is required in production. M4 adds no HTTP route for reading; a later one would show each member only their own records (S13).
23. **The spec never says what a relay restart does.** With an in-memory store, a restart ends every page session, attachment, pairing ticket and invite. **Resolution:** record the D3 choice. Under option (A), a restart detaches everyone, and the adapter drops its invite records along with its grants on `resumed: false`.
24. **The audit hash chain.** It could read as hand-rolled cryptography under CLAUDE.md. **Resolution:** it uses SHA-256 from `node:crypto`, with no keys and no new primitive. The section 9 reviewer decides; if it fails, only the sequence number stays.

### ADR 0020: production sign-in

25. **ADR 0013's consequences.** It says swapping providers changes only the issuer, key URL and audience. Moving WorkOS from staging to production also changes every `sub`, the `/pair` client and its secret, and Claude's registration. **Resolution:** correct the consequence. The deploy guide redoes `TABDOCK_OAUTH_USERS` and re-adds the connector in the same step as leaving ngrok.
26. **ADR 0013's notes.** They give `/pair` the scope `openid` (`pair.ts:503`), but `/pair` and `/i` need the email to show invitees. **Resolution:** use the scope `openid email` and read `email` and `email_verified` from the ID token. When they are missing, fetch them from UserInfo with `openid-client`'s `fetchUserInfo`.
27. **ADR 0016's "verify before M4".** It asks whether a JWT template can carry a verified flag. The docs show `user.email_verified` in the template context but never show a rendered boolean, so this is medium confidence. **Resolution:**
    - **Template:** one template with namespaced keys, `urn:tabdock:email` and `urn:tabdock:email_verified`, parsed with zod. An email may be up to 320 characters.
    - **Missing claims:** a missing or mistyped claim shows as "unverified account". Identity stays `sub`.
    - **Settling it:** the first time the relay sees a session id, it logs the token's lifetime and the types of its claims, never their values, so your first production run answers the question.
28. **SPEC section 7's "M4 hardens it".** The hardening is undefined, and WorkOS documents no token lifetime, no key rotation, and nothing on whether revoking a session ends tokens already issued. **Resolution:**
    - **Token checks:** require `iat` and `jti`, and refuse a token whose `exp - iat` exceeds 2 hours (jose's `maxTokenAge` also refuses tokens dated in the future). Leave `typ` unpinned, since WorkOS sends none.
    - **Keys:** set jose's key cache and cooldown explicitly. The runbook notes up to about 330 s of 401s after a key rotation.
    - **Metadata:** re-read the provider's metadata hourly and refuse an issuer change.
    - **Logs:** add `email` to the redacted log fields and collapse repeated 401 lines per address.
    - **Revocation:** record the missing revocation feed as a residual risk.

### ADR 0021: refresh SPEC sections 3, 10, 11 and 12

29. **SPEC section 3.** It lacks the facts M4 builds on: WorkOS environments and JWT templates, Claude's rule that the hostname have a public IPv4 A record, Node 22's end of life on 30 April 2027, and `node:sqlite` still being experimental on Node 22. **Resolution:** add rows from section 4 below, as ADRs 0004 and 0015 did.
30. **SPEC sections 11, 12 and 10.** Section 11 says only "a small container host from M4", and section 12 leaves the public demo open. **Resolution:** name the D1 host and the deploy guide, and close or narrow the demo item according to D6. If D6 is (A), section 10's line about publishing the demo moves from M5 to M4.

## 2. Decisions only the owner can make

Six decisions. If you take every recommendation, the running cost is about $3.84 a month for Fly. Add a domain only if you have none: $11.08 a year for a .com, about $0.92 a month. WorkOS, GHCR, GitHub Actions and GitHub Pages cost nothing. No new npm runtime dependency is needed: the invites use WebCrypto, the audit log uses `node:fs` and `node:crypto`, and the email lookup uses `fetchUserInfo` from the already approved `openid-client` 6.8.8.

### D1. Where the relay runs

**(A) Recommended: Fly.io, about $3.84 a month.** One `shared-cpu-1x` 512 MB Machine in Ashburn (`iad`) with a 1 GB volume. A card is required, and there is no free tier.

- **Why:**
  - It is the cheapest host that meets every need.
  - It is the only one whose client-address header I could test live: Fly's proxy replaced a forged `Fly-Client-IP` with the real address.
  - A mounted volume makes Fly run exactly one Machine and refuse overlapping deploys, which the in-memory relay needs.
  - Fly documents no request time limit, only an idle timer, which the relay's 15 s pings beat.
  - Deploys run from GitHub Actions, so you can set it up and deploy from a phone browser.
- **Trade-offs:** the relay is down for the seconds a deploy takes, and the default idle timeout is stated only in Fly staff forum posts.

**(B) Render, about $7.25 a month.** Starter plus a 1 GB disk. It is fully dashboard-driven, with native GitHub deploys, requests of up to 100 minutes and no WebSocket limit. **Trade-offs:** nearly twice the price. Its trusted address header (`CF-Connecting-IP`, through Cloudflare) rests on a vendor article I could not test, and whether Cloudflare challenges Anthropic's addresses is unknown.

**(C) Railway Hobby, $5 a month.** **Trade-offs:** streamed HTTP responses are cut off at 15 minutes. The only assurance that `X-Real-IP` cannot be forged is an employee's forum post, and another thread reports a CDN address in that header.

**(D) A DigitalOcean droplet behind Caddy, $6 a month.** **Trade-off:** you would patch and reboot an operating system, which is a poor fit when you mostly work from a phone.

I ruled out three others:

- **Cloud Run:** about $63 a month once you add the load balancer a custom domain needs.
- **Koyeb:** its volumes are a preview for testing only, on a $29 plan.
- **DigitalOcean App Platform:** no persistent disk.

### D2. The hostname in the connector URL

This hostname is in the connector URL, in every member's and invitee's connector, and in every invite link. A connector cannot be edited once added.

**(A) Recommended: your own domain, $0, or $11.08 a year for a new .com.** Use a subdomain such as `relay.<your domain>` of a personal domain you control, with a DNS-only record. "Not proxied" keeps the platform's address header and WebSockets direct.

- **Cost:** $0 if you already own a domain. A new .com is $11.08 a year at Porkbun, the same at renewal, which is about $0.92 a month. Avoid cheap first-year domains that renew high: .xyz is $2.04 the first year, then $14.21.
- **Trade-off:** one more renewal to keep up. In return, a later host move changes only DNS.
- **Personal-hat rule:** the domain must be personal, never an employer's.

**(B) The platform's free name, $0.** For example `<app>.fly.dev`. **Trade-off:** every connector is tied to Fly. If you move hosts, every member and invitee removes and re-adds the connector, and an invitee on Claude's Free plan uses up their one connector slot again.

### D3. What the relay keeps on disk

SPEC asks only that the audit log persist. On every host, every restart, including every deploy, wipes the in-memory state.

**(A) Recommended: the audit log on the volume, everything else in memory.** The cost is the volume's $0.15 a month, already in D1's price.

- **How it works:**
  - The audit log is JSON Lines files on the 1 GB volume, written with `node:fs`.
  - Each record is one append, synced at most once a second and at shutdown.
  - Files rotate at 8 MiB or at UTC midnight, and are kept for 30 days or 64 MiB (about 200,000 records), whichever comes first.
  - The existing stderr `call` line stays as an off-host copy that the platform keeps for 7 days.
- **Trade-off:** after any restart, every page comes back as a new session. Everyone pairs again and every live invite link stops working. Claude stays signed in, and `relay_stop` and `relay_start` records mark the gap. That is why deploys run on demand, not on every merge.

**(B) As (A), plus a snapshot at graceful shutdown, $0 more.** The relay writes a snapshot as it shuts down and loads it once at start if it is under 10 minutes old. A planned deploy then keeps attachments and invite links: pages come back asleep and resume.

- **Trade-offs:**
  - It needs another ADR and roughly a day of code and tests.
  - A stale snapshot could bring back a revoked attachment or invite. Loading it only once, and only while it is fresh, guards against that.
  - Emails and page titles sit on disk briefly.
  - A crash still falls back to (A).
- I would build this in M5 if re-pairing under (A) turns out to be annoying.

**(C) No volume, platform logs only, $0.**

- **Trade-offs:**
  - Logs are kept 7 days.
  - Lines over the platform's rate limit are dropped, so a flood can push real records out.
  - There is no filtered reading.
  - It is not really persistent.

`node:sqlite` is ruled out on Node 22: it is still experimental there and prints a warning into the JSON log stream.

### D4. WorkOS for production

Staging and production share nothing. Moving changes the issuer, the key URL, the `/pair` client and its secret, and every member's `sub`. So `TABDOCK_OAUTH_USERS` must be redone, and the connector is re-added in the same step as leaving ngrok.

**(A) Recommended: a production environment, $0 a month with a card on file.** It stays free up to 1 million monthly users, as long as there is no SSO, no custom domain and Radar is off.

- **Sign-in:** by email, with a password or a one-time code; both are on by default.
- **Sign-up:** left open so friends can make accounts. The relay's allowlist and invites are the real gate.
- **Domain:** none of your own. The sign-in page lives on a random `*.authkit.app` name.
- **Trade-offs:**
  - There is no Google or GitHub sign-in button, because WorkOS's shared credentials for those work only in staging.
  - Any stranger can create an account. That account can reach only a page it holds an invite to, and its refused calls are budgeted (ADR 0019).

**(B) As (A), plus your own Google OAuth app, $0.** Guests get "Sign in with Google". It needs a project and consent screen in Google Cloud's console; I did not check today what moving that screen out of testing mode involves. You can add it later without changing any `sub`.

**(C) Stay on staging, $0.** No card, Google and GitHub buttons work, and nothing needs redoing now. **Trade-offs:** WorkOS's terms say staging is "not intended for customer-facing traffic", and invitees are other people. The eventual move would reset every `sub`, every invite bar and the connector again.

**(D) Production with a custom AuthKit domain, $99 a month.** It puts the sign-in page on your own domain. Not worth it for a personal project.

I also considered closing sign-up and rejected it: every guest would then need an invitation sent from the WorkOS dashboard, which defeats the point of a one-tap invite.

### D5. What the container image and its build pipeline pull in

None of this is an npm runtime dependency. But the base image is what runs in production, and the CI actions hold publishing rights, so I am asking rather than assuming.

**(A) Recommended: a distroless runtime image, a scanner, and pinned actions, $0.**

- **Images:**
  - Build on `node:22-bookworm-slim`.
  - Run on `gcr.io/distroless/nodejs22-debian13:nonroot`: Apache-2.0, Node 22.23.3, runs as uid 65532, no shell, 54.6 MB compressed. The relay adds about 3.5 MB compressed.
  - Both images are pinned by digest.
- **CI actions, each pinned by commit SHA:**
  - `docker/setup-buildx-action` v4, `docker/login-action` v4, `docker/metadata-action` v6 and `docker/build-push-action` v7, all Apache-2.0.
  - `actions/attest` v4 (MIT).
  - `anchore/scan-action` v7.4.2 (MIT, uses Grype).
  - `superfly/flyctl-actions` v1 (Apache-2.0), with Fly only.
  - Dependabot, to keep digests and SHAs current.
- **Cost:** $0. GHCR, provenance, SBOM and attestations are free for a public repo, and publishing needs only `GITHUB_TOKEN`.
- **Trade-off:** with no shell in the image, debugging is through logs. Whether `fly ssh console -C` can run the audit reader on distroless is unverified.

**(B) As (A), but the official slim image at runtime too.** It is 79.8 MB compressed and has a shell. **Trade-off:** easier to inspect on the host, but more operating system packages to patch and more for an attacker to use.

**(C) As (A), without the scanner.** **Trade-off:** one less third-party action, but no vulnerability (CVE) check on the image; Dependabot only bumps digests. `trivy-action` is ruled out under every option: an attacker force-pushed 76 of its 77 tags on 19 March 2026.

### D6. Where the operator's page runs for A4.2

A4.2 needs a page that runs the adapter, is served from an origin on the production allowlist, and connects to the hosted relay. SPEC section 12 leaves "where a public demo lives" open, and section 10 publishes the demo on GitHub Pages only at the M5 release.

**(A) Recommended: publish `apps/demo` to GitHub Pages now, $0.** It takes the relay URL as a parameter, as M5 planned, and `https://<your GitHub user>.github.io` goes on the allowlist.

- **Why:** any device with a browser can then hold the operator's tab, so the checklist works without the laptop.
- **Trade-offs:**
  - The demo goes public one milestone early.
  - Every project site under your account shares that origin, so any of them could open page sessions on your relay. Those sessions are bounded by the per-address and total caps, and minting invites still needs one of your members attached.
- **Variant:** if you take D2 (A), a `demo.<your domain>` custom domain on GitHub Pages gives the demo its own origin at no cost.

**(B) Run the demo on the laptop, $0.** A new `pnpm demo:hosted` serves it on localhost and connects to the hosted relay. `http://localhost:<port>` goes on the production allowlist for the test only. Nothing is published. **Trade-offs:** it needs the laptop, and while that entry is listed, a localhost page at that port on any machine could open page sessions on the relay.

### Defaults I will take unless you object

- **Node version:** Node 22 for M4, matching `.nvmrc`, CI and the distroless image. A backlog row moves `.nvmrc`, CI and the image to Node 24 together before Node 22's end of life on 30 April 2027.
- **Deploys:**
  - They run only from a manual workflow (`workflow_dispatch`) that deploys a GHCR image by digest.
  - Fly's deploy token is app-scoped. It is a secret of a GitHub environment named `production`, with you as the required reviewer. A deploy the sandbox starts still waits for your tap in the GitHub app, and no job can read the token before you approve.
  - Rollback means redeploying the previous digest.
- **Fly settings:** region `iad`, `auto_stop_machines` off, one Machine.
- **When the audit disk fails, calls still run (fail open):**
  - If the disk fills or errors, the call still runs and its record still reaches stderr. An `audit_gap` record follows once writing works again.
  - Failing closed would let a full disk stop every page.
- **Retention:** 30 days or 64 MiB, whichever comes first.
- **Invitee email in the audit log:** kept on the `attach` record only. Without it, the log cannot say who joined. Call records carry only the opaque id, and nothing else personal is kept: no `sub`, no addresses, no labels.
- **Audit tamper evidence:**
  - Each line carries a sequence number and the SHA-256 (`node:crypto`) of the previous line, with checkpoints written to stderr.
  - The section 9 reviewer decides whether that counts as hand-rolled cryptography. If it does, only the sequence number stays.
- **Invites switch:** invites are off unless `TABDOCK_INVITES` is set, which keeps M3's 403. Your deploy turns them on.
- **WorkOS sign-up:** stays open (D4).
- **No deny list of revoked WorkOS sessions in M4:**
  - A deny list needs a feed of revocations, which means WorkOS webhooks with a signature check.
  - Short token lifetimes, the allowlist and the widget's Revoke cover the realistic cases, and the threat model records the gap.
- **Audit reader name:** `pnpm audit:log`, because `pnpm audit` is pnpm's own vulnerability command (checked on pnpm 10.28).

## 3. M4 plan outline

**Order of work.**

1. **Owner step:** you answer D1 to D6 and accept ADRs 0017 to 0021. I write `docs/plans/M4.md` and the verified rows in section 4, and add backlog rows for Node 24, D3 (B) if not taken, and the deny list of revoked sessions.
2. **Interfaces (the lead, one commit):** these interfaces are fixed before the work splits.
   - **Protocol schemas:** the invite frames and fields from item 1, `AccountSchema`, `PolicySchema.invites`, `invite_required`, the `pair_page` input union, and an `AuditEventSchema` discriminated union with `v: 1`.
   - **Relay types and signatures:**
     - `AuthOutcome.user.account` (`kind`, `email?`, `emailVerified?`), plus the `InviteStore` interface.
     - `AuditLog.record(event: AuditEvent): void`, which stays synchronous and never throws.
     - The hub methods `createInvite`, `cancelInvite`, `previewInvite(secret)` and `claimInvite(caller, secret)`.
     - `clientAddress(request)`, returning the address and its limit key.
   - **Adapter:** `dock.invite()`, `state.invites`, and stored grants in the form `{ role, inviteId?, endsAt? }`, still reading the old form.
   - **Config keys:** `TABDOCK_INVITES`, `TABDOCK_BIND_HOST`, `TABDOCK_CLIENT_ADDRESS_HEADER`, `TABDOCK_AUDIT_DIR`, `TABDOCK_AUDIT_RETENTION_DAYS`, `TABDOCK_AUDIT_MAX_MB` and `TABDOCK_OAUTH_MAX_TOKEN_AGE`, all added to `.env.example`.
3. **Three workstreams in parallel.** Each relies only on the interfaces above.
   - **A. Relay: invites and sign-in.**
     - The invite store and its lifecycle hooks (mint, redeem, spend, cancel, expire, sponsor loss, revoke, sleep, gone), the sponsor rule and the seat rule.
     - The invitee tier: one session until the invitee holds a page, and its own pool, evicted first.
     - `pair_page` with an invite, and `invite_required` for an invitee's code, returned before the code is matched.
     - The refusal budget, with summary records.
     - `oauth.ts` hardening (item 28) and the template claims.
     - Emitting `AuditEvent`s.
   - **B. Adapter and widget.**
     - The adapter's own invite record, with WebCrypto for the secret and the hash, and the honour path, which checks an invite against that record.
     - Role caps and `endsAt`, and `revoke('*')` clearing the records.
     - In the widget: the Invite form as an armed box, the live list with Cancel, roster badges with the email or "unverified account", Revoke with "and close this link", and the QR code for `/i#<22>`.
     - Playwright tests under Trusted Types, run against a sim relay.
   - **C. Edge, audit and shipping.**
     - `/i` and its routes, reusing `/pair/login` and `/pair/callback` with a fixed return target and the `openid email` scope.
     - The trusted client address, hosted-mode binding, `/healthz`, and the per-address share for `/pair` and `/i`.
     - `FileAuditLog`, with `audit-cli.ts` run as `pnpm audit:log`.
     - The Dockerfile, `.dockerignore` and `fly.toml`.
     - Two workflows: one builds, scans, attests and smoke-tests the image; the other deploys from a dispatch.
     - `docs/deploy.md`.
4. **Integration (the lead):**
   - End-to-end invite journeys with the sim page and Playwright, and `pnpm demo:m4`.
   - `docs/threat-model.md`: assets, actors, trust boundaries, STRIDE per boundary mapped to S1 to S14 and their test files, and the residual risks from the research.
   - SPEC edits from the accepted ADRs.
   - A decision on the backlog's per-page memory budget for schemas: build it if it is cheap, otherwise record it in the threat model and move it to M5.
5. **First deploy:** CI builds and smoke-tests the image. Once you have created the Fly app, the token and the DNS, the sandbox dispatches the deploy and checks the live `/healthz`, the 401 challenge and the metadata with curl.
6. **Review:** a separate reviewer agent runs the section 9 review with adversarial verification (A4.3). Every fix comes with a test that fails without it.
7. **Wrap-up:** the explainer, the checklist, a pull request with the explainer linked, and the report.

Your account setup in the checklist can run in parallel with steps 2 to 4.

**Sandbox tests for A4.1.** The existing S1 to S14 tests stay. M4 adds the following.

| Rule    | New or extended tests                                                                                                                                                                                                                                                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1      | Hosted mode still reads origin only from the `Origin` header; production refuses a missing origin                                                                                                                                                                                                                                                                                                 |
| S2      | Hosted production refuses to start without an origin list, a client-address header or a writable audit directory                                                                                                                                                                                                                                                                                  |
| S3      | Per-address share at `/pair` and `/i`, with IPv6 grouped by /64. A second or unconfigured address header is ignored. An invitee's code gets `invite_required` and is neither spent nor rotated                                                                                                                                                                                                    |
| S4      | A watch invite attaches an observer without a prompt only when the adapter's record matches. Cancelled, expired, spent and barred invites attach nothing. Control invites always prompt                                                                                                                                                                                                           |
| S5      | An invite's role cap holds at the relay and in the adapter: a tampered `driver` and a `set_role` above the cap are both refused. The adapter-bypass test covers an invitee                                                                                                                                                                                                                        |
| S6      | Consequential prompts apply to an invitee, and a timeout means deny                                                                                                                                                                                                                                                                                                                               |
| S7      | Every call that reaches a page has the S7 keys. No argument marker appears in any file. `seq` and the chain continue across a reopen. A torn last line is repaired. Rotation and retention run on an injected clock. Calls failed by shutdown are synced. ENOSPC and EIO fail open with `audit_gap`. A refusal flood adds a bounded number of lines. `--verify` catches an edited or deleted line |
| S8      | Revoking an invitee cancels its call in flight and bars it from that invite. `revoke('*')` kills every link. Sponsor loss ends the sponsor's invites and the attachments they made                                                                                                                                                                                                                |
| S9      | Two seats are kept for members. Caps of 10 live invites, 20 uses and 24 hours hold. The invitee session pool is evicted first, and the refusal budget applies                                                                                                                                                                                                                                     |
| S10     | Labels are capped and marked as written by the page on `/i`, in prompts and in the roster. A name that copies a member's shows the short id                                                                                                                                                                                                                                                       |
| S11     | The log sink and audit files contain no secret, hash, `/i` link, token, `sub` or address, and logs contain no email. A `pair_page` invite is redacted. The `/i` fragment never reaches the server                                                                                                                                                                                                 |
| S12     | The relay binds beyond loopback only in production, with an https URL and a named address header. `/healthz` answers 204 after the Host syntax check, with no log line. `/page` through the public host is accepted only in hosted mode                                                                                                                                                           |
| S13     | An invitee lists and calls only pages it holds. A guessed page id gets `not_attached`                                                                                                                                                                                                                                                                                                             |
| S14     | The invites-map rule table: member sponsor, the `policy.invites` levels, watch in advance, a control prompt with one pending request, three refusals burn the invite, the adapter's own record and the secret, `revoke('*')`, the end on session close, revoke or 24 hours, two seats, sponsor loss, barring, `invite_required`                                                                   |
| Sign-in | Tokens are refused without `iat` or `jti`, or with a lifetime over the cap. Missing or mistyped template claims show as unverified. An issuer change on the metadata timer is refused. Repeated 401s collapse in the log. The token-shape line names types, never values                                                                                                                          |

**Container image checks.** Docker cannot build images in the sandbox (its daemon is not running), so the image is checked in two places:

- **In the sandbox:** I copy the image's file layout into a scratch directory with the filtered `pnpm install --prod`, and run the relay under `node --permission` with only the audit directory writable.
- **In CI:**
  - CI builds the image, scans it, attests it, and runs it with a read-only root as uid 65532, against `oauth2-mock-server`.
  - The checks are: `/healthz` answers 204, a POST to `/mcp` gets a 401 naming `resource_metadata`, and SIGTERM ends the process within 5 s.
  - I read the CI results through the GitHub API.

**`pnpm demo:m4`** runs the whole invite journey locally from a clean clone, with the mock provider holding two accounts, an https stand-in for the public URL, and a small local stand-in for the edge that sets the address header:

1. A member pairs and mints a watch invite.
2. The second account redeems it at `/i` in a phone-sized browser and calls a read-only tool.
3. A control invite raises the operator's prompt, which is approved.
4. Revoke all kills the link.
5. The audit reader prints the log and runs `--verify`.

**For `docs/checklists/M4.md` (yours):**

1. **Accounts:** Fly (card), WorkOS production (card), and the domain's DNS record (A and AAAA, DNS-only).
2. **WorkOS production:**
   - Turn on client ID metadata documents (CIMD) and dynamic client registration (DCR).
   - Set the default Resource Indicator to `https://<host>/mcp`.
   - Use email sign-in and leave sign-up open.
   - Paste the JWT template.
   - Create the `/pair` client with redirect `https://<host>/pair/callback`.
   - Put its secret into Fly's vault. If Fly's dashboard cannot set secrets (unverified), use an environment secret staged by the deploy workflow.
3. **Fly app:**
   - Create the app, a 1 GB volume and a certificate.
   - Store an app-scoped deploy token in the GitHub `production` environment, with you as reviewer.
   - Make the GHCR package public once.
   - If D6 (A), turn on GitHub Pages.
4. **First deploy:**
   1. Approve the first deploy in the GitHub app.
   2. Sign in once, and copy your new user ID from the WorkOS dashboard into `TABDOCK_OAUTH_USERS`.
   3. Restart the relay.
5. **Connector:**
   - On claude.ai web, remove the ngrok connector, add `https://<host>/mcp` and sign in. Check that it appears on the phone.
   - Add it in Claude Code too, which checks the `localhost` callback in production.
6. **A4.2 on web and phone:**
   1. Open the operator page (D6) and pair by code from Claude web, then call a tool from Claude mobile.
   2. A second account adds the connector on the web. That account can be a friend, or yours under another email in a separate browser profile.
   3. Mint a watch invite. The second account opens it on a phone, signs in, taps Join, and reads; a write is refused.
   4. Mint a control invite. Check that the prompt shows the email and label, approve it, and have the second account write.
   5. Revoke all and confirm the link is dead.
7. **Observe and record:**
   - The token-shape log line: the lifetime, and the types of the two template claims.
   - What hosted Claude does after a relay restart.
   - Whether the WorkOS dashboard works in a phone browser.
   - Whether `fly ssh console -C` runs the audit reader.

**Explainer:** `docs/tour/04-hosted-invites.md`. It traces one watch invite on the hosted relay:

1. The widget's Create button and the adapter's WebCrypto secret.
2. The `invite_create` frame and the relay's hash-only store.
3. The `/i` preview, sign-in and Join.
4. The adapter checking the presented secret against its own record.
5. The guest's first read-only call, and its line in the audit file.

Fly's edge and the trusted address header frame the route the request takes. Three things to try:

- Open a watch invite in a private window, then Revoke all.
- Edit one audit line and run `pnpm audit:log --verify`.
- Send a forged second address header to the local demo and see it ignored.

## 4. Rows for docs/notes/verified.md (3 October 2026)

Same columns as the file. Status uses its words: confirmed, differs, new, open.

| Fact                                                                | Spec said                                                             | Observed today                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Status    | Source                                                                                                                                                                       |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fly.io pricing (checked 3 October, M4)                              | "a small container host from M4" (section 11)                         | `shared-cpu-1x` 512 MB $3.69 a month in `iad` and `ewr`; volumes $0.15/GB-month; shared IPv4 and IPv6 free; first 10 certificates free; egress $0.02/GB; no free tier, card or $25 credit required                                                                                                                                                                                                                                                                   | new       | docs.fly.io/about/pricing, /about/billing                                                                                                                                    |
| Fly single Machine with a volume (checked 3 October, M4)            | one process with an in-memory store (section 4)                       | First deploy with a volume creates one Machine; `bluegreen` and `canary` refused with volumes; one Machine with one volume is down during each deploy; `auto_stop_machines = "off"` keeps it running; health checks come over the private network, steer routing and never restart; default `kill_signal` SIGINT, `kill_timeout` 5 s; log search keeps 7 days                                                                                                        | new       | docs.fly.io app-availability, volumes/overview, reference/configuration, reference/health-checks, launch/autostop-autostart, monitoring/search-logs                          |
| Fly client address (checked 3 October, M4)                          | trusted proxy header (backlog, M4)                                    | `Fly-Client-IP` is the client as Fly Proxy sees it. A live probe of `debug.fly.dev` with forged headers: `Fly-Client-IP` replaced by the real peer, `X-Forwarded-For` had the peer appended, `X-Real-IP` passed unchanged                                                                                                                                                                                                                                            | new       | docs.fly.io/networking/request-headers; curl probe                                                                                                                           |
| Fly idle timeout (checked 3 October, M4)                            | not stated                                                            | `http_options.idle_timeout` is configurable; the 60 s default appears only in Fly staff forum posts; the relay's 15 s pings beat it either way                                                                                                                                                                                                                                                                                                                       | open      | docs.fly.io/reference/configuration; community.fly.io/t/2373                                                                                                                 |
| Fly deploys from Actions (checked 3 October, M4)                    | not stated                                                            | `superfly/flyctl-actions` (Apache-2.0; `v1` is 1.6) with `FLY_API_TOKEN`; app and org deploy tokens are created and revoked in the dashboard; custom domains by dashboard Certificates or `fly certs add`                                                                                                                                                                                                                                                            | new       | docs.fly.io continuous-deployment-with-github-actions, reference/deploy-tokens, networking/custom-domain; `git ls-remote`                                                    |
| Other hosts compared (checked 3 October, M4)                        | not stated                                                            | Render Starter $7 plus disk $0.25/GB-month, requests up to 100 min, no WebSocket maximum, a disk means one instance; Railway Hobby $5, HTTP streams cut at 15 min, `X-Real-IP` anti-spoofing only in a forum post; Cloud Run about $63 with the load balancer, max instances can be briefly exceeded; Koyeb volumes a preview "only suitable for testing"; DigitalOcean App Platform has no volumes; Hetzner US from $20.49 plus $0.60 IPv4; DigitalOcean droplet $6 | new       | render.com pricing and docs; docs.railway.com; cloud.google.com/run docs and pricing; koyeb.com/docs; digitalocean.com pricing; Hetzner price API                            |
| Claude connector hostname (checked 3 October, M4)                   | not stated                                                            | The hostname needs a public IPv4 A record; private, CGNAT, loopback, mixed and AAAA-only answers are refused                                                                                                                                                                                                                                                                                                                                                         | new       | claude.com/docs/connectors/building/troubleshooting.md                                                                                                                       |
| Claude connector docs re-checked (checked 3 October, M4, 20:20 UTC) | section 3 rows                                                        | Five connector auth pages, Claude Code `mcp.md` and its CIMD document byte-identical to the 14:06 UTC copies; support articles still modified 2026-10-01; Free allows one custom connector; mobile install still beta; no page mentions DPoP, so tokens are plain bearer tokens                                                                                                                                                                                      | confirmed | claude.com/docs/connectors/building/authentication.md; support.claude.com 11175166, 11176164; code.claude.com/docs/en/mcp                                                    |
| MCP authorization for resource servers (checked 3 October, M4)      | section 7                                                             | 2025-11-25 and 2026-07-28 unchanged: OAuth 2.1 section 5.2 validation, RFC 8707 audience, 401 for invalid or expired tokens, no token passthrough; 2026-07-28 adds SHOULD NOT list `offline_access` in protected resource metadata and MUST honour scope hierarchies; the relay complies                                                                                                                                                                             | confirmed | modelcontextprotocol.io 2025-11-25 and 2026-07-28 authorization.md, security-considerations.md                                                                               |
| MCP 2025-era session loss (checked 3 October, M4)                   | not stated                                                            | A client MUST start a new session when its session id gets a 404, so a relay restart costs 2025-era clients one re-initialize                                                                                                                                                                                                                                                                                                                                        | new       | modelcontextprotocol.io/specification/2025-06-18/basic/transports                                                                                                            |
| WorkOS environments (checked 3 October, M4)                         | WorkOS AuthKit (ADR 0013)                                             | Staging and production share nothing (keys, client ids, users, redirect URIs), so every `sub` changes; production needs a card, $0 to 1M monthly users without SSO, custom domain or Radar; staging is "not intended for customer-facing traffic"; default Google and GitHub credentials only in staging; custom AuthKit domain $99 a month; production redirect URIs must be https except `http://127.0.0.1`                                                        | new       | workos.com/docs/authkit/environments, integrations/google-oauth, github-oauth, custom-domains, pricing                                                                       |
| WorkOS Connect access tokens (checked 3 October, M4)                | verified email shown for invitees (ADR 0016)                          | Claims `iss`, `aud`, `sub`, `client_id`, `org_id`, `sid`, `scope`, `jti`, `exp`, `iat`; no email by default; header has `alg` and `kid`, no `typ`; DCR and CIMD clients get `openid profile email offline_access`; lifetime undocumented (example `exp - iat` 300 s, `expires_in` 3600)                                                                                                                                                                              | open      | workos.com/docs/authkit/connect/token-claims; reference/workos-connect/token                                                                                                 |
| WorkOS JWT templates (checked 3 October, M4)                        | verify before M4 (ADR 0016)                                           | One template per environment renders into access tokens, including Connect tokens for DCR and CIMD clients; context has `user.email` and boolean `user.email_verified`; reserved `iss`, `sub`, `exp`, `iat`, `nbf`, `jti`; output capped at 3,072 bytes; how a bare boolean renders is not shown, so a real token must be decoded                                                                                                                                    | open      | workos.com/docs/authkit/jwt-templates; reference/authkit/jwt-template                                                                                                        |
| WorkOS sign-up and users (checked 3 October, M4)                    | not stated                                                            | Email verification "is always on" for hosted sign-up; sign-up can be closed, leaving only WorkOS invitations or approved waitlist entries; deleted users are removed fully, so a new sign-up gets a new `sub`                                                                                                                                                                                                                                                        | new       | workos.com/docs/authkit/email-verification, invite-only-signup, invitations, waitlist, radar                                                                                 |
| WorkOS keys, limits and revocation (checked 3 October, M4)          | not stated                                                            | Production key set holds one RS256 key whose `kid` dates to 18 March 2024, served `max-age=300` through Cloudflare; no documented rotation; `/oauth2` endpoints absent from the rate limit table; neither session revoke nor consent deletion is said to end issued tokens; live metadata does not advertise RFC 9207 `iss`                                                                                                                                          | new       | live JWKS and metadata at signin.workos.com; workos.com/docs/reference/rate-limits, reference/authkit/session, connect/oauth                                                 |
| `@workos/emulate` 0.14.0 (checked 3 October, M4)                    | not stated                                                            | Lacks resource indicators and dynamic registration, so `oauth2-mock-server` stays the test provider                                                                                                                                                                                                                                                                                                                                                                  | new       | github.com/workos/emulate SUPPORTED.md                                                                                                                                       |
| OAuth libraries (checked 3 October, M4)                             | `jose` 6.2.12, `openid-client` 6.8.8, `oauth4webapi` 3.8.8 (ADR 0013) | Still latest; `pnpm audit --prod` clean; `openid-client` offers `fetchUserInfo`                                                                                                                                                                                                                                                                                                                                                                                      | confirmed | npm registry; pnpm audit                                                                                                                                                     |
| OIDC email claims (checked 3 October, M4)                           | not stated                                                            | With scope `email`, `email` and `email_verified` come from UserInfo in the code flow (WorkOS also puts them in its ID token); only `iss` plus `sub` is a stable identifier                                                                                                                                                                                                                                                                                           | new       | openid.net/specs/openid-connect-core-1_0.html 5.1, 5.4, 5.7; workos.com/docs/reference/workos-connect/authorize                                                              |
| WebCrypto in the adapter (checked 3 October, M4)                    | not stated                                                            | `crypto.subtle.digest` needs a secure context; `getRandomValues` is fit for cryptographic use                                                                                                                                                                                                                                                                                                                                                                        | new       | MDN SubtleCrypto/digest, Crypto/getRandomValues                                                                                                                              |
| Node release lines (checked 3 October, M4)                          | Node 22+ (section 2), 22.18 or later (section 3)                      | Node 22 in maintenance, end of life 30 April 2027; Node 24 enters maintenance 20 October 2026, end of life 30 April 2028; type stripping rated 1.2 on 22 and 2 on 24                                                                                                                                                                                                                                                                                                 | new       | github.com/nodejs/Release schedule.json; nodejs.org typescript docs                                                                                                          |
| `node:sqlite` (checked 3 October, M4)                               | not stated                                                            | Stability 1.1 on the 22 line (no flag, still experimental), release candidate from 24.15.0; Node 22.22.0 and 22.23.3 print `ExperimentalWarning` to stderr without a flag, 24.21.0 prints nothing                                                                                                                                                                                                                                                                    | new       | nodejs.org/docs/latest-v22.x and latest-v24.x api/sqlite; local probe                                                                                                        |
| Running the relay from a pruned workspace (checked 3 October, M4)   | no build step (ADR 0003)                                              | pnpm 10.28 `deploy` needs `--legacy` and puts the protocol package under `node_modules`, where Node refuses type stripping (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`); a filtered `pnpm install --prod --frozen-lockfile` keeps the workspace symlink: 10 packages, 22 MB, 3.5 MB compressed; the relay serves and exits on SIGTERM under `node --permission` with no write grant                                                                               | new       | local probes; pnpm.io/cli/deploy; nodejs.org typescript docs                                                                                                                 |
| Container base images (checked 3 October, M4)                       | not stated                                                            | `node:22-bookworm-slim` Node 22.23.3, 79.8 MB compressed; `gcr.io/distroless/nodejs22-debian13:nonroot` Node 22.23.3, uid 65532, no shell, 54.6 MB, Apache-2.0, cosign signed; `node:22-alpine` musl on amd64 "Experimental"; Chainguard free tier only `latest` (Node 26.10.0); Docker Hardened Images need `docker login dhi.io`                                                                                                                                   | new       | registry configs; distroless README and SUPPORT_POLICY; docker-node README; cgr.dev tags; docs.docker.com/dhi                                                                |
| Image publishing and attestations (checked 3 October, M4)           | not stated                                                            | `GITHUB_TOKEN` with `packages: write` publishes to GHCR; first publish is private; attestations are free on public repos (SLSA Build L2); current majors `docker/login-action` v4, `setup-buildx-action` v4, `metadata-action` v6, `build-push-action` v7 (Apache-2.0), `actions/attest` v4 (MIT)                                                                                                                                                                    | new       | docs.github.com publishing docker images, container registry, artifact attestations; LICENSE files; `git ls-remote`                                                          |
| Image scanning (checked 3 October, M4)                              | not stated                                                            | `anchore/scan-action` v7 (latest tag v7.4.2, MIT, Grype) offers `severity-cutoff` and `only-fixed`; an attacker force-pushed 76 of 77 `trivy-action` tags on 19 March 2026                                                                                                                                                                                                                                                                                           | new       | anchore/scan-action README and LICENSE; aquasec.com incident post                                                                                                            |
| GitHub protected environments (checked 3 October, M4)               | not stated                                                            | On GitHub Free, required reviewers and environment secrets work on public repositories; a job cannot read an environment's secrets until a required reviewer approves it                                                                                                                                                                                                                                                                                             | new       | docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments                                                                                      |
| Platform log retention (checked 3 October, M4)                      | not stated                                                            | Fly, Railway Hobby and Render Hobby keep 7 days and drop lines over their rate limits (Railway 500 lines/s, Render 6,000 a minute); Cloud Logging keeps 30 days, free to 50 GiB; Cloud Run's filesystem is in memory                                                                                                                                                                                                                                                 | new       | docs.fly.io monitoring; docs.railway.com reference/logging; render.com/docs/logging; cloud.google.com/stackdriver/pricing; docs.cloud.google.com/run/docs/container-contract |
| Append-only audit files (checked 3 October, M4)                     | persistent audit log (section 4)                                      | `O_APPEND` positions and writes in one atomic step except on NFS; Node 22 has `fdatasyncSync`; sandbox guide only: 314 B per record, 4.2 us per append with a SHA-256 link, 0.64 ms with `fdatasync`                                                                                                                                                                                                                                                                 | new       | man7.org open(2); nodejs.org fs (v22); `bench.mjs`                                                                                                                           |
| Domain prices (checked 3 October, M4)                               | not stated                                                            | Porkbun: .com $11.08 to register and renew; .dev $8.75 then $12.87; .app $8.75 then $14.93; .xyz $2.04 then $14.21                                                                                                                                                                                                                                                                                                                                                   | new       | api.porkbun.com/api/json/v3/pricing/get                                                                                                                                      |
| pnpm built-in audit (checked 3 October, M4)                         | not stated                                                            | pnpm 10.28 has a built-in `audit` command, so a workspace script named `audit` would be shadowed                                                                                                                                                                                                                                                                                                                                                                     | new       | `pnpm audit --help`                                                                                                                                                          |
| Relay memory (checked 3 October, M4)                                | not stated                                                            | Idle RSS of `node src/main.ts` is 137 MB and the argument worker's heap cap is 256 MB, so 512 MB is the floor                                                                                                                                                                                                                                                                                                                                                        | new       | local probe; ADR 0010 notes                                                                                                                                                  |
| Sandbox reach for M4 (checked 3 October, M4)                        | not stated                                                            | HTTPS reaches every platform API; the `flyctl` download from GitHub releases returns 403; the proxy refuses WebSocket upgrades; the Docker daemon is not running; the GitHub API is limited to this repo                                                                                                                                                                                                                                                             | new       | probes from this session                                                                                                                                                     |

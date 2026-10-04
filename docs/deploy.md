# Deploying Tabdock

Tabdock runs on any host that meets SPEC section 11, with any identity provider that meets section 7; the hosted setup in this guide is one worked example. The simplest start needs neither. With no settings, `pnpm relay` runs **local mode** (ADR 0022): the relay listens on loopback only, keeps a 256-bit owner token in a private file outside the repository, and prints a `claude mcp add` command that reads it. Claude Code and any other MCP client on the same computer can use it straight away, with no account, tunnel or host.

Claude on the web, desktop and phone connects from Anthropic's cloud, so it reaches only a relay in **public URL mode**, by one of two routes. A tunnel in front of a relay on your own machine is the quick one: `pnpm dev:public` runs that mode with the demo board, as the M3 spike did with ngrok (ADR 0014). A host is the lasting one (ADR 0018). Tabdock names no tunnel, host or provider, and every setting is an environment variable.

Everything after the next two sections is one worked example, the project's **reference deployment**: Fly.io as the host, a WorkOS AuthKit production environment as the provider, a DNS-only `relay.<domain>` on the owner's personal domain, deploys by manual dispatch from GitHub Actions, and the demo page on GitHub Pages at `demo.<domain>`. Steps that belong to one platform are marked **Fly**, **WorkOS** or **GitHub**, so running on another host means a new section here, not a code change. `docs/checklists/M4.md` holds the same setup as a click list; (C) marks a step that needs a computer.

## Local mode

From a clone, `pnpm install` and then `pnpm relay` (or `pnpm dev`, which adds the demo board). If a `.env` exists its settings win, so move it aside first. The first start creates `owner-token` in a directory only you can read: `TABDOCK_HOME` when set (an absolute path), otherwise `$XDG_CONFIG_HOME/tabdock` or `~/.config/tabdock` on Linux, `~/Library/Application Support/Tabdock` on macOS and `%LOCALAPPDATA%\Tabdock` on Windows. The directory is 0700 and the file 0600 where POSIX modes apply. Paste the command the banner prints, then check with `claude mcp list`; never with `claude mcp get`, which prints the stored header in full. A refusal at start names its fix (`chmod 600`, `chmod 700`, or delete the file and start again) and never the file's contents.

To rotate the token, stop the relay, delete the file, start again, run `claude mcp remove tabdock-local --scope user` and paste the new command; the old token then gets 401. Local mode trusts every account on its computer: another account could take the port while the relay is down, and Claude Code keeps its own copy of the token in `~/.claude.json`. On a machine shared with accounts you do not trust, use a host with sign-in instead. Its audit log lives in `audit/` beside the token.

## What a host and a provider must do

A host qualifies when it does each of the following (SPEC section 11, ADRs 0018 and 0019); after each, how Fly meets it in the reference deployment.

**TLS and pass-through.** It terminates TLS for the public URL and passes requests and WebSocket upgrades through with the original `Host`. On Fly: Fly's proxy, through `[http_service]`.

**Slow and streamed answers.** It lets a request wait at least 60 s for its first byte and streams responses unbuffered. On Fly: no request time cap is documented, only an idle timer.

**One trusted address header.** Its proxy sets one client-address header, replacing any value a client sent, from a range nothing else can reach the port from. On Fly: `Fly-Client-IP`, which replaced a forged value in a live probe; the range is narrowed after the first deploy.

**One instance with a disk.** It runs exactly one instance, stopping the old before starting the new, with a persistent directory for the audit log. On Fly: one Machine with a volume, which makes Fly refuse the `bluegreen` and `canary` strategies.

**Long connections.** It keeps open a connection that carries a ping every 15 s. On Fly: the relay's pings beat the idle timer.

**Public IPv4.** It gives the hostname a public IPv4 `A` record, as Claude requires. On Fly: a shared IPv4 address, free.

A provider qualifies (SPEC section 7, ADRs 0013 and 0020) when its metadata names its issuer, S256 PKCE, and client ID metadata documents or dynamic registration; when it issues access tokens as RS256-signed JWTs, never opaque ones, whose keys sit at its `jwks_uri`, whose `aud` is the relay's MCP URL from the `resource` parameter, with a stable `sub`, `iat`, `jti`, an `exp` within the relay's cap (2 hours by default) and, if you set `TABDOCK_OAUTH_CLIENT_IDS`, RFC 9068's `client_id`; and when it offers a confidential client for `/pair` and `/i` whose signed ID token carries the same `sub`. Email claims are optional: without them guests show as unverified accounts. WorkOS meets this through the switches and template below.

## The reference deployment at a glance

```mermaid
flowchart LR
  you["You, approving in the GitHub app"] --> env["GitHub environment production, holding the secrets"]
  env -->|deploy workflow| fly["Fly.io: one Machine in iad and a 1 GB volume"]
  ghcr["GHCR: the image, by digest"] --> fly
  claude["Claude on web, desktop and phone"] -->|MCP over HTTPS| edge["Fly edge: TLS and Fly-Client-IP"]
  demo["GitHub Pages: the demo page"] -->|page socket| edge
  edge --> fly
  fly -->|keys and metadata| workos["WorkOS AuthKit production"]
  claude -->|sign-in| workos
```

It costs about $3.84 a month on Fly ($3.69 for a `shared-cpu-1x` Machine with 512 MB running all month in `iad`, $0.15 for the 1 GB volume), plus outbound data at $0.02 per GB in North America and Europe. Daily volume snapshots fit in the free 10 GB, and shared IPv4, IPv6 and the first ten certificates are free. WorkOS production is $0 with a card on file, GHCR, Actions and Pages are free for a public repository, and the domain is whatever you already pay for it.

## Accounts

Create the GitHub `production` environment first (its protections are under GitHub below), so that each value goes into it the moment a page shows it, two of them only once; then Fly, WorkOS and Pages.

### Fly.io (Fly)

Fly has no free tier: a trial lasts 2 Machine hours or 7 days, after which the organization needs a card on its Billing page, or at least $25 of prepaid credit. Most of the rest needs flyctl (C): install it with `brew install flyctl` or `curl -L https://fly.io/install.sh | sh` (on Windows, `pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"`) and sign in with `fly auth login`.

**The app.** `fly apps create <app> --org personal`. App names are unique across Fly and public: the app also answers at `<app>.fly.dev`, where the relay's Host check gives 403 to everything but `/healthz`. `deploy/fly/fly.toml` names no app; the deploy workflow passes the name to flyctl through `FLY_APP`, a secret, and GitHub hides a secret's value wherever a log prints it, so pick a name the deploy log would not print anyway (not plain `tabdock`, which would also hide `tabdock_audit`). If the `personal` organization holds or will hold other apps, create an organization for Tabdock alone and use it instead, since the deploy token below reaches its organization's private network; each organization needs its own card.

**The volume.** `fly volumes create tabdock_audit --app <app> --region iad --size 1`. It holds only the audit log (ADR 0019). Its name must match the `[mounts]` source in `fly.toml`; with a different name, `fly deploy` would create a fresh volume and leave this one unused (and still billed). Volumes are encrypted at rest, snapshotted daily and the snapshots kept 5 days by default (1 to 60 can be set). Fly recommends two volumes per app, because one sits on one server; the relay keeps its state in memory and must run as exactly one instance, so one volume and a short outage on each deploy or host failure is the accepted trade.

**Addresses.** A first deploy gives the app a dedicated IPv6 and a shared IPv4 address. Since that deploy waits for the M4 merge, allocate them by hand so DNS and the certificate can go first: `fly ips allocate-v6 --app <app>` and `fly ips allocate-v4 --shared --app <app>`. Leaving out `--shared` buys a dedicated IPv4 for $2 a month, which the relay does not need.

**The certificate.** In the dashboard, the app's Certificates page, add `relay.<domain>` (or `fly certs add relay.<domain> --app <app>`). Fly then shows several alternative DNS setups, not one list to copy. This one uses the `A` and `AAAA` records for the two addresses and the `_acme-challenge` CNAME, which lets Fly issue the certificate before anything runs (`fly certs setup` shows every option). Skip the alternative CNAME for `relay` itself, which DNS does not allow beside the `A` and `AAAA` records, and the `_fly-ownership` TXT record, which only setups without these need. Fly validates through the `AAAA` record or that CNAME and renews on its own.

**The deploy token.** In the dashboard, the app's Tokens page, create a token named `github-production`, or run `fly tokens create deploy --app <app> --name github-production --expiry 8760h`. It is app-scoped, but not to the app alone: it can manage this app, and since Fly counts WireGuard tunnels as part of deploying, it can also open one into the organization's private network, which reaches every other app there. Its default lifetime is 20 years, so give it about one and note the date. Copy all of it, including the leading `FlyV1` and the space after it, straight into the environment secret `FLY_API_TOKEN`. Fly's own documentation warns that anyone who can deploy can ship code that reads the app's secrets, so this token is as sensitive as every other setting together; that is why it lives behind the environment's required reviewer.

### WorkOS AuthKit production (WorkOS)

Staging and production share nothing: issuer, keys, applications, redirect URIs and users are separate, so moving changes every `sub` and the M3 values do not carry over (ADR 0020). Production stays locked until a payment method is on the workspace's Billing page. AuthKit is free below a million monthly active users while no SSO connection, custom domain or Radar is in use; the sign-in page then lives on the environment's random `*.authkit.app` name.

**Sign-in.** Email + Password is on by default. Magic Auth, a six-digit code by email that lasts 10 minutes, is off until you enable it under Authentication. Email verification is always on for hosted sign-up. Sign up stays open (it is a toggle under Authentication): the relay's allowlist and invites are the gate, and closing sign-up would mean sending a WorkOS invitation to every guest. WorkOS's shared Google and GitHub sign-in credentials work only in staging; your own Google app can come later without changing any `sub`.

**MCP clients.** Under Connect, Configuration, turn on Client ID Metadata Document and Dynamic Client Registration. Hosted Claude and Claude Code use client ID metadata documents when the provider offers them; registration stays on for clients that do not, until the record shows it is unused. Add `https://relay.<domain>/mcp` as a resource indicator and Set as default: tokens then carry it as `aud`, also for clients that send no `resource`. The default applies only to clients that register themselves, which is how MCP clients arrive.

**The JWT template.** Under Authentication, Features, JWT Template:

```
{ "urn:tabdock:email": {{ user.email }}, "urn:tabdock:email_verified": {{ user.email_verified }} }
```

One template per environment renders into every access token from a sign-in or consent, including those for registered MCP clients. Namespaced keys keep clear of the reserved ones (`iss`, `sub`, `exp`, `iat`, `nbf`, `jti`), a null value drops its key, and the output may be at most 3,072 bytes. No WorkOS example shows how a bare boolean renders, so the relay logs the claim types (never values) from the first production token. A missing or mistyped claim shows a guest as an unverified account; identity is always `sub`.

**The `/pair` client.** Under Connect, Applications, an OAuth application, first-party and confidential (not Public), with the redirect URI `https://relay.<domain>/pair/callback`; production accepts only https redirect URIs, apart from `http://127.0.0.1`. The relay signs a phone's browser in through it at `/pair` and `/i`, asking for `openid email`. An application holds up to five secrets, each shown once and never expiring, which is what makes rotation painless.

**The issuer and your user ID.** The issuer is the `issuer` field at `https://<authkit domain>/.well-known/oauth-authorization-server`, copied exactly. Your user ID (`user_...`) appears on your page under Users once you have signed up; the checklist signs you up through the `/pair` client's authorize address, before the relay exists, so the ID is ready for the first deploy. Every member does the same once.

### GitHub (GitHub)

**The `production` environment.** Required reviewers, with you as the only one; Prevent self-review off, or nobody could approve a deploy you start; Allow administrators to bypass configured protection rules off, so even a run under your own account waits for Approve; and deployment branches limited to `main`. A job that references the environment cannot read its secrets until a reviewer approves it. On the free plan all of this needs a public repository.

**Protecting `main`.** The branch rule is only as strong as `main`, which also holds the deploy workflow. A branch ruleset on the default branch, active, with an empty bypass list, keeps Restrict deletions and Block force pushes and adds Require a pull request before merging, with no approvals required, since nobody else could approve your own pull requests. It does not stop someone acting as you from opening and merging a pull request, so the approval is the real gate: approve only a run on `main` that you started or were told about, whose commit is a merge you reviewed, reject any other, and never ask a session to approve for you.

**Dispatch.** GitHub runs a `workflow_dispatch` workflow only when its file is on the default branch, so the first deploy waits for the M4 merge; the branch rule then refuses a dispatch from any other branch.

**The image.** CI publishes to GHCR with the workflow's own token. A first publish is private, and since Fly pulls anonymously, you make the package public once, under its Package settings.

**Pages.** The demo is a static site, published by a workflow at `demo.<domain>`. A custom domain that points at Pages without being claimed can be taken over, so the order is fixed (ADR 0021): verify `<domain>` in your profile's Pages settings (a TXT record named `_github-pages-challenge-<user>`, kept for good, which also protects every immediate subdomain); set the repository's Pages source to GitHub Actions and its custom domain to `demo.<domain>`; only then create the CNAME; and tick Enforce HTTPS once offered, which GitHub says can take up to 24 hours. No wildcard record may exist in the zone, since GitHub warns it allows a takeover even of a verified domain. To retire the demo, remove its origin from `TABDOCK_ALLOWED_ORIGINS` and deploy, then delete the CNAME, then the Pages site.

### DNS

The zone ends up with `A` and `AAAA` records for `relay`, the `_acme-challenge.relay` CNAME Fly names, a CNAME from `demo` to `<user>.github.io`, the Pages verification TXT record, and no wildcard. Every record is DNS only: a proxy in front of Fly would put its own address in `Fly-Client-IP`, hold WebSockets and see the plaintext. Claude refuses a connector hostname whose answers are private, loopback, mixed public and private, or IPv6 only, so the `A` record is required. If the zone has CAA records, they must allow `letsencrypt.org`, which issues both Fly's and GitHub's certificates. A hostname of your own is the point of all this: a connector cannot be edited, so a later host move should change only DNS.

## Settings

### Where they live

Every setting that names your domain, accounts or credentials is a secret of the GitHub `production` environment, and nowhere else you maintain. Not in the repository, which is public. Not as an environment variable, which GitHub prints unmasked in logs. Not as a repository secret, which any workflow could read without your approval. GitHub redacts secrets printed to logs, though not reliably once a value is transformed, so the workflows never print them. Redaction also cuts the other way: GitHub hides every occurrence of a secret's value in a job's log, with no minimum length, so a setting that names nothing of yours stays out of the secrets (a secret of `1` would turn every `1` in the deploy log, digests and Machine IDs included, into `***`).

After your approval, the deploy workflow (`.github/workflows/deploy.yml`) copies the relay's settings into Fly's secret store, which encrypts them, never logs them, and hands them to the Machine as environment variables at boot. flyctl can stage them from standard input with `fly secrets import --stage`, so no value appears on a command line, and the deploy that follows applies them. Fly's store keeps its own copy: deleting a secret at GitHub leaves it at Fly until the workflow or `fly secrets unset` (C) removes it. `FLY_API_TOKEN` and `FLY_APP` stay on the runner and never reach the relay.

A changed setting takes effect only with a deploy, and every deploy restarts the relay: pages reconnect as new sessions, everyone pairs again and live invite links die, while Claude stays signed in (ADR 0019). Batch changes where you can.

### Each secret

**`FLY_API_TOKEN`**, for flyctl in the deploy job. It comes from the app's Tokens page, `FlyV1` prefix included. To rotate, create a new token, replace the secret, dispatch a deploy to prove it works, then revoke the old token on the Tokens page (or `fly tokens list --app <app>` and `fly tokens revoke <id>`, (C)). If it leaks, revoke it first; since it could have deployed code that reads every secret, rotate the `/pair` secret too. When it expires, deploys fail to authenticate and the running Machine carries on.

**`FLY_APP`**, the app's name, which flyctl reads from this variable so `fly.toml` names none. It is public anyway as `<app>.fly.dev`; it is a secret only so the repository names no app. It does not rotate: moving to a new app means a new volume (the old one keeps the audit history), new addresses, a new certificate and new DNS records, while the connector URL stays as it was.

**`TABDOCK_PUBLIC_URL`**, the relay's public origin, `https://relay.<domain>`, with no path. The connector URL is this plus `/mcp`; it is also the `resource` in the relay's protected resource metadata and so the audience every token must carry, the base of `/pair` and `/i` links and of the page socket `wss://relay.<domain>/page`, and its host joins the Host allowlist. Treat it as permanent: a connector cannot be edited, so a new URL means every member and guest removes and re-adds theirs, plus a new resource indicator, redirect URI and certificate.

**`TABDOCK_OAUTH_ISSUER`**, the provider's issuer, copied from its metadata. The relay checks the metadata at start (S256, and client ID metadata documents or registration) and again hourly, refusing a changed issuer or key URL. It changes only when you move to another provider or environment, which also changes every `sub`, the `/pair` client and every connector (ADR 0020). WorkOS rotating its signing keys is a different event, covered by the key rotation runbook below.

**`TABDOCK_OAUTH_USERS`**, the members: comma-separated `sub=userId:Display Name` entries, where `sub` is the WorkOS user ID, `userId` is 1 to 64 letters, digits, `_` or `-` and never starts with `g_`, and the name is optional and has no comma. Only members pair by code and sponsor invites. To add someone, they sign up once and you add their ID and deploy. To remove someone, delete their entry and deploy; with invites on they become an invitee, who sees only pages they hold by invite, and the restart ends their attachments. A person who deletes their WorkOS account and signs up again gets a new `sub`.

**`TABDOCK_PAIR_CLIENT_ID`** and **`TABDOCK_PAIR_CLIENT_SECRET`**, the relay's own confidential client, from Connect, Applications. The relay sends the secret to WorkOS on each code exchange at `/pair/callback`, which it bounds to 60 a minute and 8 at once for the whole relay and 10 a minute and 2 at once per address. To rotate the secret, create a second one on the same application, replace the GitHub secret, deploy, then delete the old one at WorkOS; if it leaked, delete the old one at once and accept that QR sign-in fails until the deploy. The client ID changes only if you recreate the application.

**`TABDOCK_ALLOWED_ORIGINS`**, the page origins that may open the page socket (S2): `https://demo.<domain>`, plus any other origin whose pages run the adapter against this relay. Production refuses to start without it. Retire an origin by removing it here and deploying before its DNS record or site goes.

### Settings in the repository

Settings that are the same for anyone deploying this way and name nothing of yours live in `deploy/fly/fly.toml` (ADR 0018), where each change is a pull request you review: `TABDOCK_ENV=production`, `TABDOCK_HOST=0.0.0.0`, the port, `TABDOCK_AUDIT_DIR` on the volume's mount, and the three below. See the `fly.toml` section below.

**`TABDOCK_INVITES`**, set to `1` to turn invites on (ADRs 0016 and 0017): a signed-in account off the allowlist becomes an invitee instead of getting 403, and members can mint watch invites in the widget, and control invites only on pages that allow them (`policy.invites: 'all'`; the default is `watch`). Delete the line in a pull request and deploy to turn invites off again.

**`TABDOCK_CLIENT_ADDRESS_HEADER`**, the one header the host's proxy overwrites with the client's address: `fly-client-ip` on Fly, the same for every Fly deployment. With production and a public URL it is what makes hosted mode, the only mode that may bind `0.0.0.0`. It must never name `X-Forwarded-For`, to which Fly appends, or `X-Real-IP`, which Fly passed through unchanged in the probe. A request whose header is missing, repeated or not an address gets 400 on the routes that count by address (`/page`, `/pair`, `/i`). It changes only with the host.

**`TABDOCK_TRUSTED_PROXY_CIDR`**, the TCP peers whose header is believed, as a comma-separated list of ranges. It is not set at first, so the relay's default, the RFC 1918 ranges, applies, because Fly documents no range for its proxy. After the first deploy the relay logs the first proxy address it sees and every untrusted peer; a pull request then sets it to the smallest range holding the proxy's address, and you deploy again. The range describes Fly's proxy, not you. If untrusted-peer lines appear later, Fly has changed its addressing, and the setting follows.

### Optional, later

**`TABDOCK_OAUTH_CLIENT_IDS`** names the OAuth clients whose tokens the relay accepts and refuses others with 401. Set it once the first run shows hosted Claude and Claude Code signing in through client ID metadata documents, to the URLs seen (in `fly.toml`, since they name nothing of yours), and turn Dynamic Client Registration off at WorkOS in the same step; until then a client anyone registers could ask a member for consent (ADR 0020). **`TABDOCK_OAUTH_MAX_TOKEN_AGE`** is the token lifetime cap in minutes, 120 by default and refused above 1440; raise it only if the first production token shows a longer lifetime, and record why in ADR 0020. The hosted limits (100 page sessions, 5 page sockets and 5 page sessions per address, `TABDOCK_MAX_REQUESTS_PER_USER` at 240 a minute, `TABDOCK_MAX_REQUESTS_PER_INVITEE` at 60, and `TABDOCK_MAX_TOOL_BYTES`) suit a 512 MB Machine; raise them only with a larger one.

### Never in production

`TABDOCK_DEV_TOKENS` (ignored with a public URL, where only OAuth tokens work), `TABDOCK_SPIKE` (production refuses to start with it), `TABDOCK_DEV_ALLOW_NO_ORIGIN`, and anything from local mode.

## The image

The `Dockerfile` at the root names no host, provider or domain; every setting is an environment variable. It builds on `node:22-bookworm-slim` and runs on `gcr.io/distroless/nodejs22-debian13:nonroot`, both pinned by digest (looked up on 4 October 2026). The build stage runs `pnpm install --prod --frozen-lockfile --filter '@tabdock/relay...'` from the lockfile and copies only the relay's and protocol's sources; `.dockerignore` lets nothing else into the build context, so a local `.env`, owner token or audit file can never reach a layer. The relay has no build step, since Node 22 strips TypeScript types itself. The runtime image has no shell or package manager, holds about 58 MB, runs as uid 65532 and owns none of its files, so the root file system can be read-only and only the audit directory needs to be writable. Its command is exec form, `node --max-old-space-size=192 packages/relay/src/main.ts`, so `SIGTERM` reaches the relay, which closes in well under a second; the heap cap is provisional until integration sizes it with `TABDOCK_MAX_TOOL_BYTES` (ADR 0018). There is no `HEALTHCHECK`: the host's own check calls `/healthz`.

CI proves the rest (`.github/workflows/image.yml`). On every pull request and push to `main` it builds the image, scans it with Grype through `anchore/scan-action` (failing on a high or critical finding that has a fix), and runs `scripts/smoke-image.ts`, which starts the image the way a host would: read-only, with every capability dropped and `no-new-privileges`, in hosted mode against a stand-in identity provider, with a volume that starts owned by root and is handed to uid 65532 by the same one-off `chown` the fallback below uses. The image must answer `/healthz` with 200 for any `Host`, answer `/mcp` with 401 naming its `resource_metadata` for the public host and 403 for any other, serve metadata naming the connector URL and the issuer, exit 0 within 5 s of `SIGTERM`, log no client secret, and leave an audit log whose `relay_start` and `relay_stop` pass `--verify`. Only a push to `main` then publishes it as `ghcr.io/<user>/tabdock`, tagged `sha-<commit>` and `main`, with an SPDX SBOM and full provenance in the registry, and attests its build provenance with `actions/attest`, so GitHub signs which workflow, commit and ref built which digest. The run's summary names the digest to deploy.

To check an image yourself (C), with the GitHub CLI:

```
gh attestation verify oci://ghcr.io/<user>/tabdock@sha256:<digest> --repo <user>/tabdock --signer-workflow <user>/tabdock/.github/workflows/image.yml --source-ref refs/heads/main
```

To build and smoke-test one on a computer with Docker (C): `docker build -t tabdock-relay .`, then `pnpm install` and `node scripts/smoke-image.ts tabdock-relay`. Behind a proxy that intercepts TLS, as in a Claude Code cloud session, the build stage also needs that proxy's certificate authority, which CI does not.

Dependabot proposes new base digests and action SHAs as pull requests. Four pins sit where it cannot see them and move by hand with the Dockerfile's build base: the BuildKit image and its SBOM scanner in `image.yml`, flyctl's version in `deploy.yml` and `volume-owner.yml`, and the helper image in `volume-owner.yml`, which is the build base itself. Node 22 reaches end of life on 30 April 2027; before then `.nvmrc`, CI and both bases move to Node 24 together (`nodejs24-debian13` at runtime).

## The workflows

Every action in every workflow is pinned by its full commit SHA, with its version in a comment, each looked up on 4 October 2026; a check in `pnpm test` (`tests/e2e/test/deploy-files.test.ts`) fails CI if one is not, if a workflow but `ci.yml` grants any permission by default, or if a `${{ }}` expression is spliced into a shell script, where an input could become a command. Values reach scripts through `env:` instead.

**`ci.yml`**, unchanged in shape: lint, typecheck, tests, the browser tests and the demos on every pull request and push to `main`. The test run includes the checks on `fly.toml`, the Dockerfile and these workflows.

**`image.yml`**, described under The image. Its check job reads the repository and nothing else; only its publish job, which runs for a push to `main` alone, may write packages and attestations.

**`deploy.yml`**, dispatched by hand on `main` with one input, the image digest. Its first job, with no environment and no secrets, checks the digest against `^sha256:[0-9a-f]{64}$` (through an environment variable, never spliced into the script) and runs `gh attestation verify` with `--signer-workflow` pointing at `image.yml` and `--source-ref refs/heads/main`, so only an image this repository's main branch built can go further. The deploy job then waits for your approval in the `production` environment; only after it can it read a secret. It checks that each secret it needs exists and holds no line break, stages the relay's six settings as Fly secrets by piping `NAME=VALUE` lines into `fly secrets import --stage` (no value ever on a command line), runs `fly deploy --image ghcr.io/<user>/tabdock@<digest> --config deploy/fly/fly.toml --ha=false --strategy rolling` with flyctl 0.4.111 pinned, and checks the live relay: `/healthz` answers 200, `/mcp` answers 401 naming the metadata URL, and the metadata names the connector URL and the issuer. Last, its Pages job builds `apps/demo` with the demo's own static build and publishes it to GitHub Pages, in the `github-pages` environment that Pages creates. Deploys share one concurrency group, so two never overlap and none is cancelled half way.

To dispatch from a phone, open the repository in a browser, then Actions, Deploy, Run workflow, keep the branch `main`, paste the digest from the Image run's summary and Run workflow; then approve the waiting deployment, in the browser or the GitHub app, under Review deployments.

**`volume-owner.yml`**, the one-off fallback below, dispatched on `main`, typed confirmation and all, and approved like a deploy.

**`.github/dependabot.yml`** proposes action and base image updates weekly. Nothing merges on its own.

## `deploy/fly/fly.toml`

The file holds only what is the same for anyone deploying this way, so each change is a pull request you review; it names no app (the workflow passes `FLY_APP`), domain or secret. Section by section:

- `primary_region = "iad"`, beside the 1 GB volume made there; `kill_signal = "SIGTERM"` and `kill_timeout = 5`, comfortably more than the second the relay needs to close.
- `[deploy] strategy = "rolling"`: with one Machine and a volume, Fly stops the old Machine before starting the new, which is the one-instance rule; it refuses `bluegreen` and `canary` with a volume anyway.
- `[env]`: `TABDOCK_ENV=production`, `TABDOCK_HOST=0.0.0.0` (hosted mode alone may bind it, S12), `TABDOCK_PORT=8787`, `TABDOCK_AUDIT_DIR=/data/audit` on the volume, `TABDOCK_INVITES=1`, and `TABDOCK_CLIENT_ADDRESS_HEADER=fly-client-ip`. `TABDOCK_TRUSTED_PROXY_CIDR` waits for the first deploy.
- `[http_service]` on internal port 8787, with `force_https`, `auto_stop_machines = "off"` (the relay keeps its state in memory and must never be stopped for idling), `auto_start_machines = true` (a Machine stopped by a host restart starts on the next request) and one health check, `GET /healthz` every 30 s. Its ports carry Fly's HTTP handler, and that handler is what overwrites `Fly-Client-IP` with the address Fly's proxy saw; a `[[services]]` section that passed raw TCP instead would leave the header to the client.
- `[mounts]`: the volume `tabdock_audit` at `/data`. A different name would make `fly deploy` create a fresh volume and leave the audit history behind.
- `[[vm]]`: `shared-cpu-1x` with 512 MB.

The same test that guards the workflows fails CI if `[http_service]` goes or a `[[services]]` section appears, if the header is anything but `fly-client-ip`, if the mount is not `tabdock_audit` holding the audit directory, if `auto_stop_machines` is not `off`, if the strategy is not `rolling` or `immediate`, or if the file gains an app name or any secret setting.

## First deploy

After the M4 merge, in this order.

1. The Image workflow runs on `main` and publishes the first image. Open the package from the repository's page, then Package settings, and change its visibility to Public once, since Fly pulls it anonymously and the attestation check reads it.
2. Copy the digest from that run's summary and dispatch Deploy with it (see The workflows). The verify job must pass before anything asks for your approval; approve the deploy job only for a run on `main` that you started.
3. The deploy job stages the secrets, deploys and checks the live relay. If it fails because the relay cannot write `/data/audit`, `fly logs` shows `cannot create the audit directory /data/audit (TABDOCK_AUDIT_DIR, EACCES)`: run the Volume ownership fallback, then dispatch Deploy again with the same digest.
4. Check it yourself from anywhere: `https://relay.<domain>/healthz` answers `ok`; a POST to `https://relay.<domain>/mcp` without a token answers 401 with a `WWW-Authenticate` header naming `resource_metadata="https://relay.<domain>/.well-known/oauth-protected-resource/mcp"`; and that document names `https://relay.<domain>/mcp` as its `resource` and your issuer among its `authorization_servers`. `https://<app>.fly.dev/mcp` answers 403.
5. Narrow the proxy range. In the app's Monitoring page (or (C) `fly logs --app <app>`), find `first request through the host edge: its proxy connects from this address` and the address it names. Open a pull request that sets `TABDOCK_TRUSTED_PROXY_CIDR` in `fly.toml` to the range holding it (for an address in `172.16.0.0/12`, the `/16` around it), merge it, and deploy again. Afterwards, a line saying `request from a peer outside TABDOCK_TRUSTED_PROXY_CIDR` means Fly's proxy also uses addresses outside the range; widen it the same way. Until then every client counts as itself or as the proxy, never as an address it claims.
6. Add the connector `https://relay.<domain>/mcp` on claude.ai and continue with `docs/checklists/M4.md`.

## Rollback

Dispatch Deploy with the digest that ran before, from an earlier Image run's summary or the package's versions page, where each image carries its `sha-<commit>` tag; never `main` and never `latest`, which name whatever was built last. A rollback is a deploy, so it is a restart: pages reconnect as new sessions, everyone pairs again and live invite links die, while Claude stays signed in. Deploy reads `deploy/fly/fly.toml` and the workflows from `main` as they are when you dispatch, not from the image's commit, so if the change to undo is in those files, revert its pull request first and deploy after. Secrets are staged from GitHub on every deploy: to undo a changed setting, put the old value back in the `production` environment first. WorkOS changes (redirect URIs, resource indicators, the template, Dynamic Client Registration) are undone by hand in its dashboard.

## Key rotation runbook

**WorkOS rotates its signing keys.** Nothing to do. The relay caches the key set for 10 minutes and, after a token names a key it does not hold, fetches again no sooner than 30 s later, while WorkOS serves the key set with a 5-minute cache, so for up to about 330 s after a rotation some tokens get 401, and Claude refreshes them and tries again (ADR 0020). If 401s go on for longer, the provider has likely moved its key URL: the relay re-reads the metadata hourly but refuses a changed issuer or key URL and keeps what it checked at start, and says so in its log. A deploy picks the new metadata up.

**After a suspected leak, rotate everything, in this order.** First the Fly deploy token, since it can deploy code that reads every secret: revoke it on the app's Tokens page, create a new one and replace `FLY_API_TOKEN`. Then the `/pair` client secret: create a new one on the WorkOS application, delete the old one at once (QR sign-in fails until the deploy) and replace `TABDOCK_PAIR_CLIENT_SECRET`. Then dispatch Deploy with the current digest, which stages every secret again and restarts the relay, ending every page session, attachment and invite. Members' access tokens are the provider's and live until their `exp`, at most 2 hours by the relay's cap: for an account you suspect, remove its entry from `TABDOCK_OAUTH_USERS` in the same deploy and revoke its sessions at WorkOS. Last, check the audit log against the newest checkpoint the platform's logs hold (Reading the audit log). `FLY_APP`, `TABDOCK_PUBLIC_URL`, `TABDOCK_OAUTH_ISSUER` and `TABDOCK_ALLOWED_ORIGINS` are no credentials and stay.

## Volume ownership fallback

The image runs as uid 65532, and production refuses to start when it cannot create and write its audit directory (ADR 0019), naming the directory and pointing here. Fly documents no way to set who owns a new volume. If the first deploy shows the volume belongs to root, dispatch the Volume owner workflow on `main`, type `chown` as asked, and approve it. It destroys the relay's Machine, which is failing to start anyway and holds the volume, since a volume attaches to one Machine at a time; runs a throwaway Machine from the Dockerfile's own pinned build base that runs `chown 65532:65532 /data` on the volume and is removed when it exits; and waits until it is gone. Then dispatch Deploy again with the same digest, and Fly creates the relay's Machine on the same volume. It is needed once: the volume keeps its owner. The image side of this is what CI's smoke test runs on every build; the Fly side is checked on the first deploy.

From a computer (C), the same by hand: `fly machine list --app <app>` and `fly machine destroy <id> --app <app> --force` for the relay's Machine, then `fly machine run node:22-bookworm-slim@sha256:<the Dockerfile's build digest> chown 65532:65532 /data --app <app> --region iad --volume <volume id>:/data --restart no --rm`, then a deploy.

## Reading the audit log

`pnpm audit:log` (pnpm's own `audit` command shadows the shorter name) reads the audit directory, `TABDOCK_AUDIT_DIR` or local mode's `audit/` beside its owner token unless `--dir` names another, and prints each record on one line, oldest first: its sequence number, its time, its type and its fields. `--user`, `--page`, `--type` (`call`, `attach`, `revoke` and the rest, comma-separated), `--outcome`, `--since` and `--until` (ISO 8601, or a span such as `24h` or `7d`) narrow it, and `--json` prints the records as JSON Lines instead. It checks every line against the protocol's schema, names a line that is no record instead of printing it, and writes every control or bidirectional character a client put into a name as a `\u` escape, so nothing in the log can rewrite your terminal.

`--verify` checks the chain: each record's sequence number follows the last, and each `prev` is the SHA-256 of the line before, across files and restarts, from the oldest file retention kept. It names a line a crash or a failed write tore, which the relay closed at its next start and chained past, and fails, exit code 1, on an edited, removed or foreign line. An edit to the last lines leaves no later line to show it, so the relay writes a checkpoint to its log every 15 minutes, at each rotation and at stop (`audit checkpoint` with `seq` and `head`); give the newest one the platform's logs still hold as `--checkpoint <seq>:<head>` and the line with that sequence number must match it. The chain is evidence, not prevention: whoever holds the disk can rewrite everything after that checkpoint, never before it unseen.

On the reference deployment the files live on the volume, and the image has node but no shell or pnpm, so the reader runs as node directly (C):

```
fly ssh console --app <app> -C "/nodejs/bin/node /app/packages/relay/src/audit-cli.ts --dir /data/audit --since 24h"
fly ssh console --app <app> -C "/nodejs/bin/node /app/packages/relay/src/audit-cli.ts --dir /data/audit --verify"
```

or copies a file out and reads it locally: `fly ssh sftp get /data/audit/<file> --app <app>` into an empty directory, then `pnpm audit:log --dir <that directory> --verify`. Whether `fly ssh console -C` can run a command in an image with no shell is confirmed on the first deploy (the checklist asks); `sftp` needs none.

Beside the files, Fly keeps 7 days of the relay's stderr: a copy of every record without the invitee's email, which the logger drops, plus the checkpoints and the `audit_gap` records that count what a failing disk missed. Its log search finds a record by type or user from a phone; the files remain the record of truth, with 30 days or 64 MiB of history.

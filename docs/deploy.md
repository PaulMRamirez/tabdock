# Running Tabdock beyond this computer

With no settings, `pnpm relay` (or `pnpm dev`, with the demo board) runs local mode (ADR 0022): the relay listens on loopback and serves MCP clients on the same computer, such as Claude Code, and needs no account, tunnel or host. Claude on the web, desktop and phone is different: it connects from Anthropic's cloud, so it can reach the relay only at a public https address, which means public URL mode (ADR 0014) with sign-in through an OAuth provider. There are two ways to give the relay such an address. Which one, and which provider, tunnel or host, is your choice; Tabdock depends on none of them.

## A tunnel from your own computer

`pnpm dev:public` runs the relay and the demo board in public URL mode behind a tunnel you run, such as ngrok, which terminates TLS and forwards to `http://127.0.0.1:8787`. The relay itself still listens on loopback. The tunnel's https origin is `TABDOCK_PUBLIC_URL`; people sign in at your provider (`TABDOCK_OAUTH_ISSUER`, with the allowed accounts in `TABDOCK_OAUTH_USERS`), and the QR page at `/pair` signs a phone in with a second client of yours at the same provider (`TABDOCK_PAIR_CLIENT_ID`, `TABDOCK_PAIR_CLIENT_SECRET`). Run it once with nothing set: it names each missing setting, then prints the connector URL and the values to enter at the provider, never a secret. `.env.example` describes every setting, and settings in `.env` win over local mode.

Turn off any request inspector the tunnel offers (`--inspect=false` for ngrok), since it would show bearer tokens (ADR 0016). Pages still attach only from the computer running the relay, and the address works only while that computer is awake and the tunnel runs. The owner's run with ngrok and WorkOS is sections 1 and 2 of `docs/checklists/M3.md`, and `docs/tour/03-phone.md` traces a phone through it.

## A host

A relay on a host stays up without your computer. ADR 0018 defines hosted mode for that and what a host must provide: TLS ended at its edge for the public host, with plain HTTP and WebSocket upgrades passed to the container with `Host` unchanged; at least 60 seconds to a first byte and streamed responses passed through unbuffered; a proxy that sets one client-address header on every request, replacing any value a client sent; exactly one instance, with a persistent directory for the audit log (ADR 0019); and a public IPv4 `A` record for the hostname. Hosted mode lands during M4 (`docs/plans/M4.md`, workstream C). Until it does, the relay listens on loopback only and refuses any other `TABDOCK_HOST`, so a tunnel is the way in.

## The reference deployment

The project's own relay will run on Fly.io with WorkOS, behind a subdomain of the owner's domain (ADRs 0018 and 0020): one worked example of a host and a provider that meet the rules above, with each platform-specific step marked, and nothing in the code depends on it. Its steps join this guide with hosted mode.

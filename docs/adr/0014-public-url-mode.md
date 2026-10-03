# 0014: Public URL mode for the M3 spike

Status: Accepted by the owner, 3 October 2026 (decisions D4, D5, D6 and D8 of the M3 plan). Changes SPEC sections 2 and 9.

## Context

M3 puts the relay on a public HTTPS address so hosted Claude, which connects from Anthropic's cloud, can reach it. The relay still runs on the owner's laptop behind a tunnel that terminates TLS. Today it refuses any Host that is not a loopback name, and every request through a tunnel arrives from loopback, so per-address limits and "only from this machine" rules mean nothing for tunnelled traffic. A3.3 also needs a tool list that changes, which the five fixed tools never do before M5.

## Decision

`TABDOCK_PUBLIC_URL`, which must be https, switches on public URL mode. Its host joins the Host allowlist, it becomes the protected resource metadata `resource`, the expected token audience and the base of the pairing URL, and production rules apply (an explicit origin allowlist, no missing-origin flag). In public mode the relay accepts only OAuth tokens; dev tokens keep working for loopback-only runs, tests and demos. The relay still binds loopback. The page link stays local in M3: the relay refuses `/page` upgrades that arrive with the public hostname, so only pages on the relay's machine attach until M4 brings a host and a trusted client-address header. The owner runs ngrok's free static dev domain as the tunnel, which sees traffic in plaintext and so sits inside the relay's trust boundary. For A3.3 only, a spike flag, off by default and refused in production, adds one marker tool on demand, tells open sessions the list changed, and logs what Claude fetches.

## Consequences

SPEC section 2's relay-trust line names the tunnel, and S12 reads as "the relay binds loopback, and a public URL must be https". The connector URL is ngrok's until M4 moves the relay to a host, when the connector is added again once.

## Notes after the build

`TABDOCK_PUBLIC_URL` must be a bare https origin that does not name this machine, so the connector URL is always `<origin>/mcp`, and the OAuth settings are refused without it. In public mode `/page` accepts only upgrades with a loopback `Host` and no `Forwarded` or `X-Forwarded-*` header, which also covers a tunnel set to rewrite `Host`; whether ngrok passes the public `Host` and adds `X-Forwarded-For` is confirmed on the owner's first run.

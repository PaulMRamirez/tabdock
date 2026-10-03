# How Claude connectors and Claude Code authenticate to a remote MCP server

Checked 3 October 2026. All sources fetched today; raw copies in `m3research/src/`, probe logs in `m3research/probe/`. Confidence: H (primary doc or observed), M (doc implies it), L (secondary or inferred).

Source keys. [A] claude.com/docs/connectors/building/authentication.md. [L] .../building/lazy-authentication.md. [T] .../building/troubleshooting.md. [B] .../building/index.md. [U] .../connectors/custom/add-unlisted.md. [DG] .../building/mcp-apps/design-guidelines (llms-full.txt line 13937). [S1] support.claude.com/en/articles/11175166 (modified 2026-10-01). [S2] support.claude.com/en/articles/11176164 (modified 2026-10-01). [CC] code.claude.com/docs/en/mcp.md. [IP] platform.claude.com/docs/en/api/ip-addresses.md. [CIMD] https://claude.ai/oauth/claude-code-client-metadata. [SPEC] modelcontextprotocol.io/specification/2026-07-28/basic/authorization.md and changelog.md. [SDK] `packages/relay/node_modules/@modelcontextprotocol/server` 2.3.0. [P] live probe: Claude Code 2.1.288 (`claude mcp login --no-browser`, isolated `CLAUDE_CONFIG_DIR`) against a loopback stub resource and authorization server metadata.

## 1. Spec revisions

| Claim                                                                                                                                                                                                   | Evidence                                            | Conf |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---- |
| Hosted Claude follows the 2025-03-26, 2025-06-18 and 2025-11-25 authorization specs. No Claude connector page mentions 2026-07-28                                                                       | [B]:43; grep of claude.com/docs/llms-full.txt       | H    |
| One auth stack backs claude.ai, Desktop, mobile, Claude Code and Cowork                                                                                                                                 | [A]:15                                              | H    |
| Claude Code's v2 runtime (MCP SDK 2.0, adds 2026-07-28) also rejects an authorization response naming an unexpected issuer (RFC 9207) and sends credentials only to an HTTPS or loopback token endpoint | [CC]:323, 339-340                                   | H    |
| Claude Code's discovery requests carry `MCP-Protocol-Version: 2025-11-25`                                                                                                                               | [P] stub logs                                       | H    |
| 2026-07-28 deprecates DCR in favour of CIMD (still allowed), adds RFC 9207 `iss`, requires `application_type` in DCR, binds client credentials to the issuer                                            | [SPEC] changelog 40-49, 95-101; authorization 63-75 | H    |

## 2. Client registration

| Claim                                                                                                                                                                                                                                                                                                           | Evidence                                             | Conf        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------- |
| Custom connector dialog offers three OAuth client modes: "Use Claude's published identity" (CIMD, recommended), "Register automatically" (DCR), "Use your own OAuth client" (client ID, optional secret)                                                                                                        | [U]:124-128; [S1] add steps 7-8                      | H           |
| The client ID and secret go in the Add custom connector dialog (under **Advanced settings** on one-screen layouts), at Customize > Connectors (individual plans) or Organization settings > Connectors (Team, Enterprise Owners). Auth settings cannot be edited later; remove and re-add                       | [U]:44-64, 98-110, 114, 207                          | H           |
| Hosted Claude picks CIMD only if AS metadata has `client_id_metadata_document_supported: true` and `"none"` in `token_endpoint_auth_methods_supported`; otherwise DCR via `registration_endpoint`. DCR registers a new client on every fresh connection                                                         | [A]:21, 92, 97; [L]:211                              | H           |
| DCR and CIMD make Claude a public client (PKCE only, no secret)                                                                                                                                                                                                                                                 | [A]:199; [L]:203, 211                                | H           |
| The URL of the hosted apps' CIMD is not published                                                                                                                                                                                                                                                               | grep of llms-full.txt finds only the Claude Code URL | H (absence) |
| Claude Code has its own CIMD: `client_id` = that URL, `redirect_uris` `http://localhost/callback` and `http://127.0.0.1/callback`, `token_endpoint_auth_method: none`, `refresh_token` grant; served with `max-age=300`                                                                                         | [CIMD] fetched; [A]:107, 186                         | H           |
| Observed: Claude Code used CIMD when both CIMD values were advertised, and made no `/register` call. With DCR only, it POSTed `/register` with `client_name: "Claude Code (<name>)"`, `redirect_uris: ["http://localhost:<port>/callback"]`, `application_type: "native"`, `token_endpoint_auth_method: "none"` | [P] stub-both.log, stub-dcr.log                      | H           |
| Claude Code pre-registered clients: `--client-id`, `--client-secret` (masked prompt), `--callback-port`                                                                                                                                                                                                         | [CC]:820-900                                         | H           |
| `client_credentials` is not supported                                                                                                                                                                                                                                                                           | [A]:24, 101                                          | H           |

## 3. Redirect URIs

| Claim                                                                                                                                                                    | Evidence                      | Conf |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ---- |
| Hosted apps (web, Desktop, mobile, Cowork): exactly `https://claude.ai/api/mcp/auth_callback`                                                                            | [A]:174-178; [B]:45           | H    |
| `https://claude.com/api/mcp/auth_callback` as a future callback appears only in third-party docs and a removed support article (11503834 now 404)                        | docs.strata.io; curl 404      | L    |
| Claude Code: RFC 8252 loopback on an ephemeral port; match `localhost` and `127.0.0.1` with the port ignored. Observed `redirect_uri=http://localhost:<random>/callback` | [A]:180-186; [L]:220-221; [P] | H    |
| v2.1.229 briefly sent `127.0.0.1`; v2.1.231 restored `localhost`                                                                                                         | [CC]:841                      | H    |

## 4. Discovery and metadata

| Claim                                                                                                                                                                                                                                                                | Evidence                             | Conf |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ---- |
| Sign-in starts only on HTTP `401` with `WWW-Authenticate: Bearer resource_metadata="..."`; a header on a `200` is ignored; a tool result with `isError` never prompts sign-in, so the check must run before the SDK                                                  | [A]:19, 144, 156; [L]:40-47, 143-144 | H    |
| RFC 9728 document: `resource` must equal the URL the user entered, path included; only the first `authorization_servers` entry is used                                                                                                                               | [A]:145-146                          | H    |
| Without `resource_metadata`, hosted Claude probes `/.well-known/oauth-protected-resource/<path>` then the root form; if both fail it treats the MCP origin as the AS and sends users to `/authorize` there                                                           | [A]:158; [T]:65-67                   | H    |
| AS metadata: hosted Claude tries RFC 8414 `/.well-known/oauth-authorization-server`, then OIDC `/.well-known/openid-configuration`                                                                                                                                   | [T]:82                               | H    |
| Claude Code: RFC 9728 first, then RFC 8414; `oauth.authServerMetadataUrl` overrides. Observed fallback to `openid-configuration`, which it validates as full OIDC metadata (`jwks_uri`, `subject_types_supported`, `id_token_signing_alg_values_supported` required) | [CC]:907; [P] stub-oidc.log          | H    |
| Claude caches discovery documents globally per URL for about 5 minutes, serving stale ones on failure                                                                                                                                                                | [L]:241-247                          | H    |

## 5. PKCE, resource, scopes, refresh

| Claim                                                                                                                                                                                                                                                         | Evidence                            | Conf |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---- |
| Every authorization request carries S256 PKCE; AS must advertise `code_challenge_methods_supported: ["S256"]`                                                                                                                                                 | [A]:132; [T]:92; [P]                | H    |
| Claude sends RFC 8707 `resource` on authorization and token requests, set to the canonical MCP URL (lowercase scheme and host, no trailing slash, fragment or default port). Server must check `aud` against it; Entra needs the URL as an Application ID URI | [T]:91, 99; [SPEC] 219-254, 285-299 | H    |
| Observed Claude Code authorize URL: `client_id`, `code_challenge_method=S256`, `redirect_uri`, `state`, `scope=tabdock:use offline_access`, `prompt=consent`, `resource=<mcp url>`                                                                            | [P] login-both.typescript           | H    |
| Hosted scopes: the `scope` in the 401 challenge, else PRM `scopes_supported`, plus `offline_access` if AS metadata lists it                                                                                                                                   | [A]:134; [L]:58                     | H    |
| Claude Code (2.1.196+): challenge or PRM scope, never the AS catalogue; appends `offline_access` if advertised; `oauth.scopes` pins                                                                                                                           | [CC]:929-949                        | H    |
| Hosted refresh: on 401 and up to 5 min before expiry; return `invalid_grant` on a dead refresh token; rotate refresh tokens for public clients; `/token` must accept form-urlencoded                                                                          | [A]:196-201                         | H    |
| Timeouts: 10 s for discovery, registration, token; 30 s for refresh                                                                                                                                                                                           | [A]:205                             | H    |

## 6. Mid-session 401 and 403

| Claim                                                                                                                                                                                         | Evidence              | Conf |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---- |
| Hosted: a 401 on a protected call shows an inline **Connect** card; after sign-in Claude retries the same tool call                                                                           | [L]:19-22             | H    |
| Hosted: a 401 with a stored token triggers refresh; whether the call is then retried silently is not stated                                                                                   | [A]:196               | M    |
| `403` with `error="insufficient_scope"` triggers step-up re-authorization and retry; any other 403 is terminal                                                                                | [L]:144, 225-237      | H    |
| Claude Code: 401 after sign-in refreshes, reconnects and retries once; flags `/mcp` if that fails; rejected refresh token shows a notice. In `-p` mode, tools report the server needs sign-in | [CC]:758-768; [L]:299 | H    |
| Cloud sessions do not sign in themselves; the session proxy uses the claude.ai authorization, reconnect at claude.ai                                                                          | [CC]:756, 1173-1177   | H    |

## 7. Network

| Claim                                                                                                                      | Evidence                 | Conf |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---- |
| Outbound from `160.79.104.0/21` (IPv4); AS discovery comes from the same range                                             | [IP]:25-29; [A]:147, 230 | H    |
| Host must have a public A record; private, CGNAT, loopback, mixed or AAAA-only answers are refused before any request      | [T]:25-33                | H    |
| A cross-host redirect drops `Authorization`                                                                                | [T]:55                   | H    |
| Hosted limits: 240 s per call, about 150,000 characters per result ("claude.ai and Desktop"; mobile not listed separately) | [B]:73-76                | H    |

## 8. Mobile

| Claim                                                                                                                                                                                                | Evidence                  | Conf       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------- |
| Custom connectors are documented as added on Claude (web), Cowork and Desktop; "Installing connectors on mobile is currently in beta; Desktop and web remain the primary path for custom connectors" | [S2] lines 23, 70; [S1]:1 | H          |
| "Users must add a connector on web or desktop before it appears on mobile"; once connected it is on iOS and Android                                                                                  | [DG]; [S2]:53             | H          |
| Mobile uses the same hosted callback and reaches servers from Anthropic's cloud                                                                                                                      | [A]:174; [S1]:14          | H          |
| Free plan: one custom connector                                                                                                                                                                      | [U]:88; [S1]:1            | H          |
| Whether claude.ai's Customize > Connectors works in a phone browser, and how a mobile Connect card opens the browser, are not documented                                                             | none                      | unverified |

## 9. What the relay's SDK already provides

`@modelcontextprotocol/server` 2.3.0 exports `requireBearerAuth`, `verifyBearerToken` (`expectedResource`, `requiredScopes`, rejects tokens without `expiresAt`), `bearerAuthChallengeResponse` (401 or 403 with `resource_metadata`), `oauthMetadataResponse`, `buildOAuthProtectedResourceMetadata` and `getOAuthProtectedResourceMetadataUrl` ([SDK] dist/index.d.mts:52-290, 809; dist/mcp-DIH4cS6P.mjs:524-541). `OAuthTokenVerifier` is only an interface, so JWT checks need a library (H). One candidate, not a proposal: `jose` 6.2.12, MIT, maintainer panva, no dependencies, 169.8M downloads in the week to 1 Oct (`npm view`; api.npmjs.org).

## 10. Unverified

The hosted CIMD URL and its contents; what hosted DCR registers; whether hosted Claude sends `prompt=consent` or checks `iss`; the `claude.com` callback. Log `client_id` and `redirect_uri` at the AS on the first hosted sign-in in M3.

## 11. Implications for M3

1. The relay answers every unauthenticated `/mcp` request (`server/discover` and `initialize` included) with the SDK's 401 challenge before `createMcpHandler`, and serves PRM at `/.well-known/oauth-protected-resource/mcp` with `resource` equal to the public URL.
2. The IdP needs CIMD or DCR (or a client entered at add time), S256, `none` auth for public clients, RFC 8707 audience, refresh rotation, form-urlencoded `/token`, reachability from 160.79.104.0/21 and both redirect forms. One that ignores `resource` cannot pass the audience check (inference).
3. Add the connector on claude.ai web, then use it on mobile.
4. The tunnel host must be in the relay's Host allowlist, resolve to public IPv4 and not redirect.

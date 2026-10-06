# The Tabdock guide

This guide is for people using Tabdock: adding it to a web app, calling a page from Claude or another MCP client, sharing a page, or running a relay. It describes the code as it stands, and says so wherever something waits for the 0.1.0 publish or has not yet run live. The [tour](../tour/00-baseline.md) is different: one short explainer per milestone, the history of how Tabdock was built.

Tabdock 0.1.0 is prepared but not yet on npm, so every page leads with the path that works from a clone. `npx @tabdock/relay`, `npm install @tabdock/adapter` and the CDN script tag work once 0.1.0 is on npm.

## Where to start

| You want to                                    | Read, in order                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Understand what Tabdock is and whether it fits | [Concepts](01-concepts.md), [Use cases](09-use-cases.md)                                                           |
| See it work in ten minutes                     | [Quick start](02-quick-start.md)                                                                                   |
| Add it to your own web app                     | [Add to your app](03-add-to-your-app.md), [Adapter reference](04-adapter-reference.md), [Security](10-security.md) |
| Use a page from Claude or another MCP client   | [Connect clients](05-connect-clients.md), [Troubleshooting](11-troubleshooting.md)                                 |
| Let other people use a page you operate        | [Sharing](06-sharing.md)                                                                                           |
| Run a relay for yourself or a team             | [Run a relay](07-run-a-relay.md), [Relay settings](08-relay-settings.md), [Security](10-security.md)               |
| Find out why something failed                  | [Troubleshooting](11-troubleshooting.md)                                                                           |

Whatever your role, read [Concepts](01-concepts.md) first: every other page uses its words (operator, member, invitee, driver, observer, consequential) in exactly its sense.

## Every page

1. [Concepts](01-concepts.md): the five parts, four flows and three dials, and what makes Tabdock unusual.
2. [Quick start](02-quick-start.md): from a clone to a working call with Claude Code, then a first page of your own.
3. [Add to your app](03-add-to-your-app.md): a WebMCP runtime, writing tools, marking them, the adapter, the script tag and which relay URL to dial.
4. [Adapter reference](04-adapter-reference.md): `attach()`, every policy field, the handle's methods and its state, as tables.
5. [Connect clients](05-connect-clients.md): adding the connector to Claude Code, Claude on the web, desktop and phone, or another client; the fixed tools; pairing and results.
6. [Sharing](06-sharing.md): approvals, roles, Revoke and Pause, invites, and confirmation in the client, as tasks for the operator.
7. [Run a relay](07-run-a-relay.md): choosing local, dev token, public URL or hosted mode, and running each.
8. [Relay settings](08-relay-settings.md): every `TABDOCK_*` setting with its mode, default and bounds.
9. [Use cases](09-use-cases.md): what you can build, with an honest status on each.
10. [Security](10-security.md): what Tabdock protects, and what it relies on you for.
11. [Troubleshooting](11-troubleshooting.md): error codes, setup failures and the limits.

For the design itself, `SPEC.md` is the source of truth, `docs/adr/` holds the decisions and `docs/threat-model.md` maps each boundary to its tests. `docs/develop.md` is for contributors.

Next: [Concepts](01-concepts.md).

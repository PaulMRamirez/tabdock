// Agent tokens (ADR 0044) from outside the relay: a relay in public URL mode
// with invites and TABDOCK_AGENT_TOKENS on, as public-harness.ts starts one
// without them, beside the demo page and the relay tests' stand-in provider;
// and an agent on /g/mcp through the stand-in tunnel with its token as the
// bearer, as the widget's `claude mcp add` command has Claude Code connect.

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startDemoServer, type DemoServer } from '@tabdock/demo/server';
import { AGENT_PATH } from '@tabdock/protocol';
import { createOAuthAuth, createRelay, type LogSink, type Relay } from '@tabdock/relay';
import {
  MOCK_SUBJECT,
  PAIR_CLIENT,
  startProvider,
  type TestProvider,
} from '@tabdock/relay/test/provider';
import { PUBLIC_MCP_URL, PUBLIC_ORIGIN, tunnelFetch } from '@tabdock/relay/test/tunnel';
import { demoPageUrl } from './tabdock-harness.ts';

/** Where the widget's command points an agent: the public URL's /g/mcp. */
export const AGENT_URL = `${PUBLIC_ORIGIN}${AGENT_PATH}`;

/** The command the widget shows once, with the token it carries as its only secret. */
export const AGENT_COMMAND =
  /^claude mcp add --transport http --scope local tabdock-([A-Za-z0-9_-]{8}) (\S+) --header "Authorization: Bearer (tda_[A-Za-z0-9_-]{43})"$/;

export interface AgentTabdock {
  relay: Relay;
  provider: TestProvider;
  demo: DemoServer;
  /** The demo page linked to this relay over loopback, with the test hook on. */
  pageUrl: string;
  close(): Promise<void>;
}

/**
 * The relay for https://relay.test with invites on, and agent tokens on
 * unless `agentTokens` is false; the provider signs in MOCK_SUBJECT, who is
 * Alice, a member, to sponsor them.
 */
export async function startAgentTabdock(
  options: { agentTokens?: boolean; logSink?: LogSink } = {},
): Promise<AgentTabdock> {
  const provider = await startProvider();
  const demo = await startDemoServer({ e2eHook: true });
  let relay: Relay;
  try {
    relay = await createRelay({
      auth: createOAuthAuth({
        issuer: provider.issuer,
        resource: PUBLIC_MCP_URL,
        users: [{ sub: MOCK_SUBJECT, userId: 'alice', displayName: 'Alice' }],
      }),
      publicUrl: PUBLIC_ORIGIN,
      pairClient: PAIR_CLIENT,
      allowedOrigins: [new URL(demo.url).origin],
      port: 0,
      logLevel: 'debug',
      logSink: options.logSink ?? (() => undefined),
      invites: true,
      agentTokens: options.agentTokens !== false,
    });
  } catch (error) {
    await demo.close();
    await provider.stop();
    throw error;
  }
  return {
    relay,
    provider,
    demo,
    pageUrl: demoPageUrl(demo, relay.pageUrl),
    async close() {
      await relay.close();
      await demo.close();
      await provider.stop();
    },
  };
}

/** Alice's client on /mcp through the tunnel, signed in at the stand-in provider. */
export async function connectAlice(live: AgentTabdock): Promise<Client> {
  const token = await live.provider.token({ sub: MOCK_SUBJECT, aud: PUBLIC_MCP_URL });
  const client = new Client({ name: 'claude-alice', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(PUBLIC_MCP_URL), {
      authProvider: { token: () => Promise.resolve(token) },
      fetch: tunnelFetch(live.relay.url),
    }),
  );
  return client;
}

/**
 * An agent's client on /g/mcp with the token as its bearer, named `name`.
 * Its initialize is answered at once and raises the token's prompt on the
 * page, so this resolves while the operator is being asked.
 */
export async function connectAgent(
  relayUrl: string,
  token: string,
  name = 'claude-code',
): Promise<Client> {
  const client = new Client({ name, version: '2.1.296' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(AGENT_URL), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: tunnelFetch(relayUrl),
    }),
  );
  return client;
}

/** The status of one fresh initialize on /g/mcp with `token`: 404 once the token no longer works. */
export async function agentStatus(relayUrl: string, token: string): Promise<number> {
  const answer = await tunnelFetch(relayUrl)(AGENT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'status-probe', version: '0.0.0' },
      },
    }),
  });
  await answer.body?.cancel();
  return answer.status;
}

// An agent token's unanswered prompt (ADR 0044, decision 18) between the
// real adapter core on a sim page and the real relay, with the page's clock
// running ahead of the relay's, as a tab's may: the adapter's own timer then
// ends the prompt before the relay's does. A silence only returns the token
// to waiting for its next request, and only the third burns it, so the
// adapter must send the relay nothing for one; a refusal from the page reads
// as the operator's deny, which burns the token at the first silence and
// records a denial nobody made (S7).

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AGENT_PATH } from '@tabdock/protocol';
import { createOAuthAuth, createRelay, type Relay } from '@tabdock/relay';
import { PAIR_CLIENT, startProvider, type TestProvider } from '@tabdock/relay/test/provider';
import { PUBLIC_MCP_URL, PUBLIC_ORIGIN, tunnelFetch } from '@tabdock/relay/test/tunnel';
import { DEFAULT_SIM_ORIGIN, type SimPage, startSimPage } from '@tabdock/sim-page';
import { afterEach, expect, it } from 'vitest';
import { callTool } from './helpers.ts';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
});

/** The relay's prompt lifetime here, well under the page's lead, so the adapter's timer fires first. */
const PROMPT_MS = 800;
const PAGE_AHEAD_MS = 2000;

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'claude-code', version: '2.1.296' },
  },
};

async function bench(): Promise<{ relay: Relay; provider: TestProvider }> {
  const provider = await startProvider();
  closers.push(() => provider.stop());
  const relay = await createRelay({
    auth: createOAuthAuth({
      issuer: provider.issuer,
      resource: PUBLIC_MCP_URL,
      users: [{ sub: 'sub-alice', userId: 'alice', displayName: 'Alice' }],
    }),
    publicUrl: PUBLIC_ORIGIN,
    pairClient: PAIR_CLIENT,
    allowedOrigins: [DEFAULT_SIM_ORIGIN],
    invites: true,
    agentTokens: true,
    timings: { attachRequestTtlMs: PROMPT_MS },
    port: 0,
    logSink: () => undefined,
  });
  closers.push(() => relay.close());
  return { relay, provider };
}

/** Alice, a member, attached by the page's code so she can sponsor a token. */
async function sponsor(relay: Relay, provider: TestProvider, sim: SimPage): Promise<void> {
  const alice = new Client({ name: 'claude-code', version: '2.1.296' });
  await alice.connect(
    new StreamableHTTPClientTransport(new URL(PUBLIC_MCP_URL), {
      fetch: tunnelFetch(relay.url),
      authProvider: {
        token: () => provider.token({ sub: 'sub-alice', aud: PUBLIC_MCP_URL }),
      },
    }),
  );
  closers.push(() => alice.close());
  const pending = callTool(alice, 'pair_page', { code: sim.state.pairing?.code ?? '' });
  const asked = await sim.waitFor((state) => state.pendingRequests.length > 0);
  const request = asked.pendingRequests[0];
  if (!request) throw new Error('no attach request');
  expect(sim.dock.approve(request.requestId, 'driver')).toBe(true);
  const outcome = await pending;
  expect(outcome.isError, outcome.text).toBe(false);
}

/** One request on /g/mcp with the token as its bearer, through the stand-in tunnel. */
async function agentAsks(relay: Relay, token: string): Promise<number> {
  const answer = await tunnelFetch(relay.url)(`${PUBLIC_ORIGIN}${AGENT_PATH}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(INITIALIZE),
  });
  await answer.body?.cancel();
  return answer.status;
}

it("a prompt left unanswered on a page whose clock runs ahead only counts, as the relay's own timer does", async () => {
  const { relay, provider } = await bench();
  const sim = await startSimPage({
    relayUrl: relay.pageUrl,
    policy: { invites: 'all' },
    // No attach answer: every prompt is left to its deadline.
    operator: {},
    clock: () => Date.now() + PAGE_AHEAD_MS,
  });
  closers.push(() => sim.close());
  await sim.waitFor((state) => state.link === 'linked' && state.pairing !== null);
  await sponsor(relay, provider, sim);
  await sim.waitFor(
    (state) => state.agentsOffered !== null && state.agentsOffered.endpoint !== null,
  );
  const minted = await sim.agentToken({ label: 'Lab agent' });
  if (!minted.ok) throw new Error(`no token: ${minted.reason}`);

  expect(await agentAsks(relay, minted.token)).toBe(200);
  const counted = await sim.waitFor(
    (state) => state.agents.some((agent) => agent.timeouts === 1),
    PROMPT_MS + 4000,
  );
  expect(counted.agents).toMatchObject([
    { tokenId: minted.tokenId, state: 'dormant', timeouts: 1 },
  ]);
  const events = relay.audit.events();
  expect(events.filter((event) => event.type === 'agent_closed')).toEqual([]);
  expect(events.filter((event) => event.type === 'attach_refused')).toMatchObject([
    { via: 'agent', inviteId: minted.tokenId, outcome: 'timeout' },
  ]);
  // Still live: its next request asks the operator again rather than getting 404.
  expect(await agentAsks(relay, minted.token)).toBe(200);
  await sim.waitFor((state) => state.agents.some((agent) => agent.state === 'asking'));
}, 20_000);

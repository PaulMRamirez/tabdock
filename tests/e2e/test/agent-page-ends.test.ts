// An agent token's prompt the page itself drops (ADR 0044) between the real
// adapter core on a sim page and the real relay. The operator's Deny says
// they do not know the agent, and only it may read as a denial; when the
// operator ends the time-boxed session or cancels the token while its prompt
// shows, the relay must hear the end or the cancel, never a deny, so the
// token closes for that reason (S7), the session_end record counts it, and
// the agent waiting in pair_page hears why.

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AGENT_PATH, type AuditEvent, type AuditEventOf } from '@tabdock/protocol';
import { createOAuthAuth, createRelay, type Relay } from '@tabdock/relay';
import { PAIR_CLIENT, startProvider, type TestProvider } from '@tabdock/relay/test/provider';
import { PUBLIC_MCP_URL, PUBLIC_ORIGIN, tunnelFetch } from '@tabdock/relay/test/tunnel';
import { DEFAULT_SIM_ORIGIN, type SimPage, startSimPage } from '@tabdock/sim-page';
import { afterEach, expect, it } from 'vitest';
import { callTool, type ToolOutcome } from './helpers.ts';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
});

interface Bench {
  relay: Relay;
  sim: SimPage;
  lines: string[];
}

async function bench(): Promise<Bench> {
  const provider = await startProvider();
  closers.push(() => provider.stop());
  const lines: string[] = [];
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
    port: 0,
    logSink: (line) => {
      lines.push(line);
    },
  });
  closers.push(() => relay.close());
  const sim = await startSimPage({
    relayUrl: relay.pageUrl,
    policy: { invites: 'all' },
    // No attach answer: every prompt waits for the test's own click.
    operator: {},
  });
  closers.push(() => sim.close());
  await sim.waitFor((state) => state.link === 'linked' && state.pairing !== null);
  await sponsor(relay, provider, sim);
  await sim.waitFor(
    (state) => state.agentsOffered !== null && state.agentsOffered.endpoint !== null,
  );
  return { relay, sim, lines };
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

/**
 * A minted token whose agent connected and waits in pair_page, its prompt
 * showing on the page: the token's id, the prompt's request id and the
 * agent's pending answer.
 */
async function promptShowing({
  relay,
  sim,
}: Bench): Promise<{ tokenId: string; requestId: string; waiting: Promise<ToolOutcome> }> {
  const minted = await sim.agentToken({ label: 'Lab agent' });
  if (!minted.ok) throw new Error(`no token: ${minted.reason}`);
  const agent = new Client({ name: 'claude-code', version: '2.1.296' });
  await agent.connect(
    new StreamableHTTPClientTransport(new URL(`${PUBLIC_ORIGIN}${AGENT_PATH}`), {
      requestInit: { headers: { Authorization: `Bearer ${minted.token}` } },
      fetch: tunnelFetch(relay.url),
    }),
  );
  closers.push(() => agent.close());
  const asked = await sim.waitFor((state) =>
    state.pendingRequests.some((request) => request.agent?.tokenId === minted.tokenId),
  );
  const request = asked.pendingRequests.find((item) => item.agent?.tokenId === minted.tokenId);
  if (!request) throw new Error('no agent prompt');
  const waiting = callTool(agent, 'pair_page', { code: sim.state.pairing?.code ?? '' });
  // pair_page joins the waiting prompt before the test clicks anything.
  await new Promise((resolve) => setTimeout(resolve, 150));
  return { tokenId: minted.tokenId, requestId: request.requestId, waiting };
}

function records<T extends AuditEvent['type']>(relay: Relay, type: T): AuditEventOf<T>[] {
  return relay.audit.events().filter((event): event is AuditEventOf<T> => event.type === type);
}

it("the operator's Deny closes the token as denied, which the agent hears", async () => {
  const room = await bench();
  const { tokenId, requestId, waiting } = await promptShowing(room);
  expect(room.sim.dock.deny(requestId)).toBe(true);
  const outcome = await waiting;
  expect(outcome.isError).toBe(true);
  expect(outcome.text).toContain('denied this agent token');
  expect(records(room.relay, 'agent_closed')).toMatchObject([{ tokenId, reason: 'denied' }]);
  // The page's own close of the token it burned changes nothing on the relay, and is no stray frame.
  expect(room.lines.filter((line) => line.includes('ignored'))).toEqual([]);
}, 20_000);

it("End while a token's prompt shows closes it as session_ended, counted on the session's end", async () => {
  const room = await bench();
  const started = await room.sim.dock.startSession({ label: 'Lesson', lengthMinutes: 30 });
  expect(started.ok).toBe(true);
  const { tokenId, waiting } = await promptShowing(room);
  expect(room.sim.dock.endSession()).toBe(true);
  const outcome = await waiting;
  expect(outcome.isError).toBe(true);
  expect(outcome.text).toContain('time-boxed session ended');
  expect(records(room.relay, 'agent_closed')).toMatchObject([{ tokenId, reason: 'session_ended' }]);
  expect(records(room.relay, 'session_end')).toMatchObject([{ reason: 'operator', agents: 1 }]);
  expect(room.lines.filter((line) => line.includes('ignored'))).toEqual([]);
}, 20_000);

it("Cancel while a token's prompt shows closes it as cancelled", async () => {
  const room = await bench();
  const { tokenId, waiting } = await promptShowing(room);
  expect(room.sim.dock.cancelAgent(tokenId)).toBe(true);
  const outcome = await waiting;
  expect(outcome.isError).toBe(true);
  expect(outcome.text).toContain('cancelled this agent token');
  expect(records(room.relay, 'agent_closed')).toMatchObject([{ tokenId, reason: 'cancelled' }]);
  expect(room.lines.filter((line) => line.includes('ignored'))).toEqual([]);
}, 20_000);

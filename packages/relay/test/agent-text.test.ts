// What a client's model reads about agent tokens, page state and proposals
// (ADR 0044's notes, ADR 0049 decision 4). On /g/mcp the relay never reads a
// code or an invite, so an agent asked to fetch one from a human could never
// use it: its empty list_pages and the relay's instructions say instead to
// call pair_page with no arguments, which waits on the token's own request.
// The instructions also name the tools that read page state and follow a
// proposal, since the answers an observer gets point to them. Each text is
// held word for word, so a rewording, or the agent's answer falling back to
// the code and invite text, fails here; the fixed tools' descriptions are
// held by fixed-tools-golden.test.ts.

import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { connectAgent, mintAgent } from './helpers/agents.ts';
import { attachMember, call, type InviteRelay, startInviteRelay } from './helpers/invites.ts';

const AGENT_EMPTY =
  "You are not attached yet. Your agent token asks the page's operator when it first connects; call pair_page with no arguments to wait for their answer.";

const MEMBER_EMPTY =
  'You are not attached to any page. Ask the page operator for the pairing code on their page, or, if your account joins pages by invite, for an invite link minted for one use, and call pair_page with it.';

const AGENT_SENTENCE =
  "On a connection made with an agent token, call pair_page with no arguments to wait for the operator's answer.";

// detach_page's clause for an agent: its detach closes the token (agents.ts,
// attachmentsEnded) and /g/mcp answers 404 after, so only a new token from
// the operator brings it back; the code and invite sentence is for the rest.
const DETACH_AGENT =
  "An agent token's detach closes the token for good; to come back, the agent needs a new token from the page's operator. On any other connection, to use the page again, pair with a new code, or, if your account joins pages by invite, with a new invite link from the page's operator.";

const STATE_SENTENCE =
  'get_page_state reads what a page publishes, and wait_for_page_state follows it, without running a page tool; on a page that takes proposals, a write your role may not run answers proposed, which get_proposal follows.';

let current: InviteRelay | undefined;
const agents: Client[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close().catch(() => undefined);
  await current?.close();
  current = undefined;
});

/** A relay with agent tokens on, a page that allows them, Alice attached, and one agent connected. */
async function agentRoom() {
  current = await startInviteRelay({ agentTokens: true });
  const relay = current;
  const page = await relay.page({ policy: { invites: 'all' } });
  await attachMember(await relay.claude('sub-alice'), page);
  const minted = await mintAgent(page);
  const agent = await connectAgent(relay.relay.url, minted.token);
  agents.push(agent);
  return { relay, page, agent };
}

describe('what an agent token is told (ADR 0044, ADR 0049 decision 4)', () => {
  it('reads instructions naming pair_page with no arguments, page state and proposals', async () => {
    const { agent } = await agentRoom();
    const instructions = agent.getInstructions() ?? '';
    expect(instructions).toContain(AGENT_SENTENCE);
    expect(instructions).toContain(STATE_SENTENCE);
    // The pairing sentence comes first, so a model reads how to attach before what to call.
    expect(instructions.indexOf('Pair with pair_page')).toBeLessThan(
      instructions.indexOf(AGENT_SENTENCE),
    );
  });

  it('is told by an empty list_pages to call pair_page with no arguments, never to ask for a code', async () => {
    const { agent } = await agentRoom();
    const listed = await call(agent, 'list_pages');
    expect(listed.isError).toBe(false);
    expect(listed.text).toBe(AGENT_EMPTY);
    expect(listed.text).not.toMatch(/pairing code|invite link/);
    expect(listed.structured).toEqual({ pages: [] });
  });

  it('attaches with pair_page and no arguments once the operator allows its prompt', async () => {
    const { page, agent } = await agentRoom();
    const request = await page.next('attach_request');
    const pending = call(agent, 'pair_page', {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    page.send({
      t: 'attach_decision',
      requestId: request.requestId,
      allow: true,
      role: 'observer',
    });
    const outcome = await pending;
    expect(outcome.isError, outcome.text).toBe(false);
    expect(outcome.text).toContain(`Attached to page ${page.pageId}`);
  });

  it('reads in detach_page that its detach needs a new token, the code and invite left to other connections', async () => {
    const { agent } = await agentRoom();
    const { tools } = await agent.listTools();
    const detach = tools.find((tool) => tool.name === 'detach_page')?.description ?? '';
    expect(detach).toContain(DETACH_AGENT);
    // Nothing after the agent's clause sends it back to a code or an invite unscoped.
    expect(detach.slice(detach.indexOf("An agent token's detach"))).toBe(DETACH_AGENT);
  });

  it("leaves a member's empty list_pages on /mcp asking for a code or an invite, and the same instructions", async () => {
    const { relay, agent } = await agentRoom();
    const bob = await relay.claude('sub-bob');
    const listed = await call(bob, 'list_pages');
    expect(listed.text).toBe(MEMBER_EMPTY);
    expect(bob.getInstructions()).toBe(agent.getInstructions());
  });
});

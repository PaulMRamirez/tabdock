// Where an agent token travels on the page link (S11, ADR 0044's notes from
// the A6.28 review). The adapter checks the presented token on every prompt,
// so a relay that never saw it cannot raise one (S4); the relay therefore
// puts it in each attach_request it raises for the token: its first
// request's, and the first after a prompt timed out or the page dropped it on
// a reload. Every copy goes to the page that minted it and nowhere else: no
// other page's socket, no log line and no audit record holds it.

import { afterEach, describe, expect, it } from 'vitest';
import { agentRequest, mintAgent } from './helpers/agents.ts';
import {
  type AttachRequestFrame,
  attachMember,
  type InviteRelay,
  latest,
  startInviteRelay,
} from './helpers/invites.ts';
import { connectPage, TOOLS, type TestPage } from './helpers/page-client.ts';
import { leakIn } from './helpers/secrecy.ts';

let current: InviteRelay | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'raw-agent', version: '1.0.0' },
  },
};

const PROMPT_MS = 200;

function carrying(page: TestPage, token: string): AttachRequestFrame[] {
  return page.all('attach_request').filter((frame) => frame.agent?.secret === token);
}

describe('an agent token on the page link (S11)', () => {
  it('rides in each prompt the relay raises for it, to the page that minted it alone', async () => {
    current = await startInviteRelay({
      agentTokens: true,
      timings: { attachRequestTtlMs: PROMPT_MS },
    });
    const relay = current;
    let page = await relay.page({ policy: { invites: 'all' } });
    const other = await relay.page({ policy: { invites: 'all' } });
    const alice = await relay.claude('sub-alice');
    await attachMember(alice, page);
    await attachMember(alice, other);
    const minted = await mintAgent(page);
    const first = page;

    // Two prompts left to time out: each returns the token to waiting, and
    // its next request raises a new prompt, which carries it again.
    for (let silence = 1; silence <= 2; silence += 1) {
      await agentRequest(relay.relay.url, minted.token, INITIALIZE);
      await page.next('attach_request');
      await new Promise((resolve) => setTimeout(resolve, PROMPT_MS + 100));
      await page.sync();
      expect((await latest(page, 'agents')).agents[0]).toMatchObject({
        state: 'dormant',
        timeouts: silence,
      });
    }
    expect(carrying(first, minted.token)).toHaveLength(2);

    // A prompt the page drops on a reload counts toward no burn, and the
    // request after it raises a new prompt on the page's new socket.
    await agentRequest(relay.relay.url, minted.token, INITIALIZE);
    await page.next('attach_request');
    const resumed = await connectPage(relay.relay.pageUrl, {
      tools: TOOLS,
      policy: { invites: 'all' },
      resumeToken: page.welcome?.resumeToken ?? '',
    });
    relay.pages.push(resumed);
    expect(resumed.pageId).toBe(page.pageId);
    await page.closed;
    page = resumed;
    await page.sync();
    expect((await latest(page, 'agents')).agents[0]).toMatchObject({
      state: 'dormant',
      timeouts: 2,
    });
    await agentRequest(relay.relay.url, minted.token, INITIALIZE);
    const again = await page.next('attach_request');
    expect(again).toMatchObject({
      via: 'agent',
      agent: { tokenId: minted.tokenId, secret: minted.token },
    });
    expect(carrying(first, minted.token)).toHaveLength(3);
    expect(carrying(page, minted.token)).toHaveLength(1);
    for (const frame of [...carrying(first, minted.token), ...carrying(page, minted.token)]) {
      expect(frame).toMatchObject({ via: 'agent', agent: { tokenId: minted.tokenId } });
    }

    // Nowhere else: not the other page the sponsor holds, not a log line, not an audit record.
    expect(leakIn(JSON.stringify(other.received), minted.token)).toBeNull();
    expect(leakIn(relay.lines.join('\n'), minted.token)).toBeNull();
    expect(leakIn(JSON.stringify(relay.relay.audit.events()), minted.token)).toBeNull();
  });
});

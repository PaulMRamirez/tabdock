// Where Wave 2's rules meet on one page (ADRs 0042 to 0044): a time-boxed
// session's end against agent tokens and proposals (C11, C13), a session's
// narrowing against pending proposals, the watchers' share while a session
// runs, and a waiting agent prompt against a watch redemption for the last
// watching seat. Each workstream's own file tests its rule alone; these hold
// the rules together once merged. Against the relay in public URL mode with
// the stand-in provider and the test's own page, which answers every request
// itself, so each case shows what the relay alone does.

import type { Client } from '@modelcontextprotocol/client';
import type { AuditEventOf, AuditEventType } from '@tabdock/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentRequest, agentUserId, connectAgent, mintAgent } from './helpers/agents.ts';
import {
  attachMember,
  call,
  type InviteRelay,
  type InviteRelayOptions,
  joinAtI,
  latest,
  mintOk,
  signedInAtI,
  startInviteRelay,
} from './helpers/invites.ts';
import type { TestPage } from './helpers/page-client.ts';
import { ARGS, getProposal, propose, proposalIdOf } from './helpers/proposals.ts';
import { roomLimits } from './helpers/room.ts';

let current: InviteRelay | undefined;
const agents: Client[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const agent of agents.splice(0)) await agent.close().catch(() => undefined);
  await current?.close();
  current = undefined;
});

const MINUTE = 60_000;

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

type SessionPolicy = { maxDrivers: number; proposals: 'off' | 'members' | 'all' };

/**
 * A relay with invites and agent tokens on, a page taking proposals from
 * all, Alice attached as its driver and Bob, a member, watching.
 */
async function classroom(
  options: InviteRelayOptions = {},
  policy: Record<string, unknown> = {},
): Promise<{ relay: InviteRelay; page: TestPage; alice: Client; bob: Client }> {
  current = await startInviteRelay({
    agentTokens: true,
    ...options,
    rateLimits: { ...roomLimits, ...options.rateLimits },
  });
  const relay = current;
  const page = await relay.page({ policy: { invites: 'all', proposals: 'all', ...policy } });
  const alice = await relay.claude('sub-alice');
  await attachMember(alice, page);
  const bob = await relay.claude('sub-bob');
  await attachMember(bob, page, 'observer');
  return { relay, page, alice, bob };
}

async function start(page: TestPage, sessionId: string, policy: SessionPolicy, minutes = 30) {
  page.send({ t: 'session_start', sessionId, lengthMs: minutes * MINUTE, policy });
  const answer = await latest(page, 'session');
  expect(answer.session?.sessionId).toBe(sessionId);
  return answer;
}

/** A guest joins at /i by a session's watch invite, allowed as an observer, then calls from Claude. */
async function letGuestIn(relay: InviteRelay, page: TestPage, secret: string, name: string) {
  const email = `${name}@example.com`;
  const phone = await signedInAtI(relay, `sub-${name}`, email);
  const { request, settled } = await joinAtI(phone, page, secret, {
    allow: true,
    role: 'observer',
  });
  expect(settled.status).toBe('approved');
  return { client: await relay.claude(`sub-${name}`, email), userId: request.user.userId };
}

/** Mints a token, connects its agent and has the page allow the prompt that raises. */
async function attachedAgent(relay: InviteRelay, page: TestPage) {
  const minted = await mintAgent(page);
  const agent = await connectAgent(relay.relay.url, minted.token);
  agents.push(agent);
  const request = await page.next('attach_request');
  expect(request.via).toBe('agent');
  page.send({ t: 'attach_decision', requestId: request.requestId, allow: true });
  await page.sync();
  return { ...minted, agent, userId: agentUserId(page.pageId, minted.tokenId) };
}

function records<T extends AuditEventType>(relay: InviteRelay, type: T): AuditEventOf<T>[] {
  return relay.relay.audit
    .events()
    .filter((event): event is AuditEventOf<T> => event.type === type);
}

/** Every miss on /g/mcp is one 404 (S11). */
async function gone(relay: InviteRelay, token: string): Promise<void> {
  expect((await agentRequest(relay.relay.url, token, INITIALIZE)).status).toBe(404);
}

describe("a session's end against agent tokens and proposals (C11, C13)", () => {
  it("closes the page's tokens in use or not, ends its guests' proposals, and keeps a member's", async () => {
    const { relay, page, bob } = await classroom();
    await start(page, 'ses_class', { maxDrivers: 1, proposals: 'all' });
    const minted = await mintOk(page, { uses: 5 });
    const guest = await letGuestIn(relay, page, minted.secret, 'guest');
    const inUse = await attachedAgent(relay, page);
    const dormant = await mintAgent(page);

    const guestProposal = proposalIdOf(await propose(guest.client, page.pageId));
    const bobProposal = proposalIdOf(await propose(bob, page.pageId));
    // An agent never proposes, even while the session takes proposals from all.
    const refused = await call(inUse.agent, 'call_page_tool', {
      page: page.pageId,
      tool: 'add_item',
      arguments: ARGS,
    });
    expect(refused.text).toMatch(/^role_denied/);
    await page.sync();
    expect(page.all('proposal').map((frame) => frame.proposer.userId)).toEqual([
      guest.userId,
      'bob',
    ]);

    page.send({ t: 'session_end', sessionId: 'ses_class' });
    expect((await latest(page, 'session')).ended).toEqual({
      sessionId: 'ses_class',
      reason: 'operator',
    });
    expect(
      records(relay, 'agent_closed')
        .map((event) => [event.tokenId, event.reason])
        .sort(),
    ).toEqual(
      [
        [inUse.tokenId, 'session_ended'],
        [dormant.tokenId, 'session_ended'],
      ].sort(),
    );
    // One expire each, for the agent's attachment and the guest's.
    const expires = records(relay, 'expire');
    for (const userId of [inUse.userId, guest.userId]) {
      expect(expires.filter((event) => event.userId === userId).map((e) => e.reason)).toEqual([
        'session_ended',
      ]);
    }
    expect(records(relay, 'session_end')).toEqual([
      expect.objectContaining({ reason: 'operator', attachments: 2, invites: 1, agents: 2 }),
    ]);
    // The guest's proposal ended with their attachment; the member's waits on.
    expect(page.all('proposal_end')).toEqual([
      { t: 'proposal_end', proposalId: guestProposal, reason: 'attachment_ended' },
    ]);
    expect(records(relay, 'proposal_closed')).toEqual([
      expect.objectContaining({ proposalId: guestProposal, reason: 'cancelled' }),
    ]);
    expect((await getProposal(bob, page.pageId, bobProposal)).head).toBe('pending');
    await gone(relay, inUse.token);
    await gone(relay, dormant.token);
  });

  it('closes a token whose session passed its end with its timer not yet run, and its next request gets 404', async () => {
    const { relay, page } = await classroom();
    await start(page, 'ses_late', { maxDrivers: 1, proposals: 'all' });
    const minted = await mintAgent(page);
    const endsAt = relay.store.pages.get(page.pageId)?.timedSession?.endsAt ?? 0;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(endsAt + 1000);
    await gone(relay, minted.token);
    expect(records(relay, 'agent_closed')).toEqual([
      expect.objectContaining({ tokenId: minted.tokenId, reason: 'session_ended' }),
    ]);
    expect(records(relay, 'session_end')).toEqual([
      expect.objectContaining({ reason: 'time', agents: 1 }),
    ]);
  });

  it("grants nothing to a token's prompt the operator allows after the session's end", async () => {
    const { relay, page } = await classroom();
    await start(page, 'ses_prompt', { maxDrivers: 1, proposals: 'all' });
    const minted = await mintAgent(page);
    agents.push(await connectAgent(relay.relay.url, minted.token));
    const request = await page.next('attach_request');
    const endsAt = relay.store.pages.get(page.pageId)?.timedSession?.endsAt ?? 0;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(endsAt + 1000);
    page.send({ t: 'attach_decision', requestId: request.requestId, allow: true });
    await page.sync();
    const userId = agentUserId(page.pageId, minted.tokenId);
    expect(relay.store.attachments.get(page.pageId, userId)).toBeUndefined();
    expect(records(relay, 'attach').filter((event) => event.userId === userId)).toEqual([]);
    expect(records(relay, 'agent_closed')).toEqual([
      expect.objectContaining({ tokenId: minted.tokenId, reason: 'session_ended' }),
    ]);
    await gone(relay, minted.token);
  });

  it("grants nothing to a redemption the operator allows after the session's end", async () => {
    const { relay, page } = await classroom();
    await start(page, 'ses_door', { maxDrivers: 1, proposals: 'all' });
    const minted = await mintOk(page, { uses: 5 });
    const phone = await signedInAtI(relay, 'sub-late', 'late@example.com');
    const claimed = await phone.post('/i/claim', { secret: minted.secret });
    expect(claimed.status).toBe(200);
    const request = await page.next('attach_request');
    const endsAt = relay.store.pages.get(page.pageId)?.timedSession?.endsAt ?? 0;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(endsAt + 1000);
    page.send({ t: 'attach_decision', requestId: request.requestId, allow: true });
    await page.sync();
    expect(relay.store.attachments.get(page.pageId, request.user.userId)).toBeUndefined();
    expect((await phone.post('/i/status', { claim: claimed.data.claim })).data.status).not.toBe(
      'approved',
    );
  });
});

describe("a session's narrowing against pending proposals (ADR 0042 meeting ADR 0043)", () => {
  it('ends a pending proposal as cancelled when a session starts that takes none', async () => {
    const { relay, page, bob } = await classroom({}, { proposals: 'members' });
    const proposalId = proposalIdOf(await propose(bob, page.pageId));
    await start(page, 'ses_quiet', { maxDrivers: 1, proposals: 'off' });
    expect(page.all('proposal_end')).toEqual([{ t: 'proposal_end', proposalId, reason: 'policy' }]);
    expect(records(relay, 'proposal_closed')).toEqual([
      expect.objectContaining({ proposalId, reason: 'cancelled' }),
    ]);
    expect((await getProposal(bob, page.pageId, proposalId)).head).toBe('cancelled');
    // And a write now is refused as before proposals, not proposed.
    expect((await propose(bob, page.pageId)).text).toMatch(/^role_denied/);
  });
});

describe("the watchers' share while a session runs (ADR 0044 meeting ADR 0043)", () => {
  it("holds a session's guests to the share, their proposals spending it, and never a member", async () => {
    const { relay, page, bob } = await classroom({
      rateLimits: { watchingCallsPerUserPerPage: 2 },
    });
    await start(page, 'ses_share', { maxDrivers: 1, proposals: 'all' });
    const minted = await mintOk(page, { uses: 5 });
    const reader = await letGuestIn(relay, page, minted.secret, 'reader');
    const proposer = await letGuestIn(relay, page, minted.secret, 'proposer');
    const getView = { page: page.pageId, tool: 'get_view', arguments: {} };
    for (let i = 0; i < 2; i += 1) {
      expect((await call(reader.client, 'call_page_tool', getView)).isError).toBe(false);
      proposalIdOf(await propose(proposer.client, page.pageId));
    }
    for (const guest of [reader, proposer]) {
      const refused = await call(guest.client, 'call_page_tool', getView);
      expect(refused.text).toMatch(/^rate_limited: a watcher may make 2 calls to this page in /);
    }
    // A member watching is no watcher, session or not.
    for (let i = 0; i < 4; i += 1) {
      expect((await call(bob, 'call_page_tool', getView)).isError).toBe(false);
    }
  });
});

describe('a waiting agent prompt and a watch redemption for the last watching seat (ADR 0044)', () => {
  it('a waiting agent prompt holds the seat, so a watch redemption is refused before the page hears', async () => {
    const { relay, page } = await classroom({ limits: { observersPerPage: 1 } });
    const minted = await mintAgent(page);
    agents.push(await connectAgent(relay.relay.url, minted.token));
    expect((await page.next('attach_request')).via).toBe('agent');
    const invite = await mintOk(page, { uses: 5 });
    const phone = await signedInAtI(relay, 'sub-student', 'student@example.com');
    expect(await phone.post('/i/claim', { secret: invite.secret })).toMatchObject({
      status: 409,
      data: { error: 'page_busy' },
    });
    await page.sync();
    expect(page.all('attach_request').filter((frame) => frame.via !== 'agent')).toHaveLength(2);
  });

  it("a waiting watch redemption holds the seat against a token's first request", async () => {
    const { relay, page } = await classroom({ limits: { observersPerPage: 1 } });
    const invite = await mintOk(page, { uses: 5 });
    const phone = await signedInAtI(relay, 'sub-student', 'student@example.com');
    expect((await phone.post('/i/claim', { secret: invite.secret })).status).toBe(200);
    await page.next('attach_request');
    const minted = await mintAgent(page);
    const agent = await connectAgent(relay.relay.url, minted.token);
    agents.push(agent);
    expect((await call(agent, 'pair_page', { code: page.code })).text).toMatch(/^page_busy/);
    await page.sync();
    expect(page.all('attach_request').filter((frame) => frame.via === 'agent')).toEqual([]);
    expect(relay.store.agents.get(page.pageId, minted.tokenId)?.state).toBe('dormant');
  });
});

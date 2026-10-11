// A6.23 on the relay's side (ADR 0044): agent tokens on /g/mcp, against the
// relay in public URL mode with the stand-in provider and the test's own
// page, which answers every attach request itself, so each test shows what
// the relay does: a token is minted only by the page's own rules, its first
// request raises an ordinary prompt and is never approved in advance (S4),
// an approved agent reads one page as observer only (S5, S13), and every way
// a token can end (deny, three timeouts, revoke, Revoke all, Cancel, its
// sponsor's end, its page's end and its time) closes it with its own record,
// ends its attachment and leaves /g/mcp answering 404, which is all /g/mcp
// ever answers a token it does not know (S11). The adapter's half (its own
// record, the presented token, the derived id) is agent-tokens.test.ts there.

import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import {
  AUDIT_VERSION,
  type AuditEventOf,
  AuditEventSchema,
  type AuditEventType,
  MAX_LIVE_AGENTS_PER_PAGE,
} from '@tabdock/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_URL,
  agentRequest,
  agentUserId,
  connectAgent,
  mintAgent,
  newAgentToken,
  toolCall,
} from './helpers/agents.ts';
import {
  attachMember,
  call,
  type InviteRelay,
  type InviteRelayOptions,
  latest,
  mintOk,
  redeem,
  startInviteRelay,
} from './helpers/invites.ts';
import { PAGE_ORIGIN, READ_TOOL, type TestPage, WRITE_TOOL } from './helpers/page-client.ts';
import { startRelay, type TestRelay } from './helpers/relay.ts';
import { PUBLIC_ORIGIN, rawRequest } from './helpers/tunnel.ts';

let current: InviteRelay | undefined;
let plain: TestRelay | undefined;
const agents: Client[] = [];
const scratches: string[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close().catch(() => undefined);
  await current?.close();
  current = undefined;
  await plain?.close();
  plain = undefined;
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOT_FOUND = JSON.stringify({
  jsonrpc: '2.0',
  error: { code: -32001, message: 'Not found' },
  id: null,
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

const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(resolve, ms, value));
}

/**
 * A 2026-07-28 subscriptions/listen on /g/mcp with the token as its bearer,
 * held open: whether the relay answered with an event stream, and when the
 * stream ends from the relay's side.
 */
function agentListen(
  relay: InviteRelay,
  token: string,
): Promise<{ streaming: boolean; ended: Promise<void> }> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 'listen:1',
    method: 'subscriptions/listen',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'raw-agent', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
      notifications: { toolsListChanged: true },
    },
  });
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL('/g/mcp', relay.relay.url), {
      method: 'POST',
      headers: {
        Host: new URL(PUBLIC_ORIGIN).host,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Method': 'subscriptions/listen',
        'Mcp-Protocol-Version': '2026-07-28',
      },
    });
    req.on('response', (res) => {
      const ended = new Promise<void>((done) => {
        res.on('end', done);
        res.on('close', done);
        res.on('error', () => {
          done();
        });
      });
      res.resume();
      resolve({
        streaming: (res.headers['content-type'] ?? '').startsWith('text/event-stream'),
        ended,
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** A relay with agent tokens on, a page that allows them, and Alice attached as its driver. */
async function room(options: InviteRelayOptions = {}, policy: Record<string, unknown> = {}) {
  current = await startInviteRelay({ agentTokens: true, ...options });
  const relay = current;
  const page = await relay.page({ policy: { invites: 'all', ...policy } });
  const alice = await relay.claude('sub-alice');
  await attachMember(alice, page);
  return { relay, page, alice };
}

async function agentOn(relay: InviteRelay, token: string, name = 'claude-code'): Promise<Client> {
  const client = await connectAgent(relay.relay.url, token, name);
  agents.push(client);
  return client;
}

/** Mints a token, connects its agent and has the page allow the prompt that raises. */
async function attachedAgent(relay: InviteRelay, page: TestPage, label = 'Lab agent') {
  const minted = await mintAgent(page, { label });
  const agent = await agentOn(relay, minted.token);
  const request = await page.next('attach_request');
  page.send({ t: 'attach_decision', requestId: request.requestId, allow: true, role: 'driver' });
  await page.sync();
  return { ...minted, agent, request, userId: agentUserId(page.pageId, minted.tokenId) };
}

/** The relay's audit records of one type. */
function records<T extends AuditEventType>(relay: InviteRelay, type: T): AuditEventOf<T>[] {
  return relay.relay.audit
    .events()
    .filter((event): event is AuditEventOf<T> => event.type === type);
}

/** Whether every audit record the relay kept is one the schema takes (S7). */
function auditValid(relay: InviteRelay): void {
  for (const event of relay.relay.audit.events()) {
    expect(AuditEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true);
  }
}

/**
 * An initialize on /g/mcp whose headers go now and whose body waits for
 * `meanwhile`, as a client holding its body back would send it; resolves
 * with the status the relay answered.
 */
function heldBody(
  relay: InviteRelay,
  token: string,
  meanwhile: () => Promise<void>,
): Promise<number> {
  const body = JSON.stringify(INITIALIZE);
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest(new URL('/g/mcp', relay.relay.url), {
      method: 'POST',
      headers: {
        Host: new URL(PUBLIC_ORIGIN).host,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': String(Buffer.byteLength(body)),
      },
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.flushHeaders();
    // The token checks out on arrival; the body comes once `meanwhile` is done.
    setTimeout(() => {
      meanwhile().then(() => req.end(body), reject);
    }, 100);
  });
}

async function gone(relay: InviteRelay, token: string): Promise<void> {
  const answer = await agentRequest(relay.relay.url, token, INITIALIZE);
  expect(answer.status).toBe(404);
  expect(answer.body).toBe(NOT_FOUND);
  expect(answer.headers.get('www-authenticate')).toBeNull();
}

describe('with TABDOCK_AGENT_TOKENS off', () => {
  it('serves no /g/mcp and ignores agent_create, sending no agents frame', async () => {
    current = await startInviteRelay();
    const page = await current.page({ policy: { invites: 'all' } });
    const alice = await current.claude('sub-alice');
    await attachMember(alice, page);
    const { token } = await mintOrNothing(page);
    expect(page.all('agents')).toEqual([]);
    expect(current.store.agents.listForPage(page.pageId)).toEqual([]);
    const answer = await agentRequest(current.relay.url, token, INITIALIZE);
    expect(answer.status).toBe(404);
    expect(answer.body).toBe('Not found');
  });
});

/** Sends an agent_create and waits for the relay to have read it, whatever it answers. */
async function mintOrNothing(page: TestPage): Promise<{ token: string }> {
  const { token, hash } = newAgentToken();
  page.send({
    t: 'agent_create',
    tokenId: 'agt_off',
    label: 'Off',
    expiresAt: Date.now() + 3_600_000,
    secretHash: hash,
  });
  await page.sync();
  return { token };
}

describe('minting (ADR 0044)', () => {
  it('follows every welcome with the endpoint, and lists a token by the terms it was minted with', async () => {
    const { relay, page } = await room();
    expect(page.all('agents')[0]).toEqual({
      t: 'agents',
      endpoint: `${PUBLIC_ORIGIN}/g/mcp`,
      agents: [],
    });
    const expiresAt = Date.now() + 4 * 3_600_000;
    const minted = await mintAgent(page, { label: 'Nightly checker', expiresAt });
    expect(minted.answer.refused).toBeUndefined();
    expect(minted.answer.agents).toEqual([
      {
        tokenId: minted.tokenId,
        label: 'Nightly checker',
        expiresAt,
        sponsor: { userId: 'alice', displayName: 'Alice' },
        state: 'dormant',
        timeouts: 0,
      },
    ]);
    // Only the digest is kept, and the record names the agent user it will be.
    const kept = relay.store.agents.get(page.pageId, minted.tokenId);
    expect(kept?.secretHash).toBe(minted.hash);
    expect(JSON.stringify(kept)).not.toContain(minted.token);
    expect(kept?.userId).toBe(agentUserId(page.pageId, minted.tokenId));
    const [record] = records(relay, 'agent_minted');
    expect(record).toEqual({
      v: AUDIT_VERSION,
      type: 'agent_minted',
      at: expect.any(Number) as number,
      pageId: page.pageId,
      origin: PAGE_ORIGIN,
      tokenId: minted.tokenId,
      expiresAt,
      sponsor: 'alice',
    });
    auditValid(relay);
  });

  it('refuses with nobody to sponsor it, by policy, past ten live, twice, and already expired', async () => {
    current = await startInviteRelay({ agentTokens: true });
    const relay = current;
    const page = await relay.page({ policy: { invites: 'all' } });
    expect((await mintAgent(page)).answer.refused?.reason).toBe('no_sponsor');
    const alice = await relay.claude('sub-alice');
    await attachMember(alice, page);
    const closed = await relay.page({ policy: { invites: 'off' } });
    await attachMember(await relay.claude('sub-bob'), closed);
    expect((await mintAgent(closed)).answer.refused?.reason).toBe('policy');
    const first = await mintAgent(page);
    expect(first.answer.refused).toBeUndefined();
    const twice = await mintAgent(page, { token: first.token });
    expect(twice.answer.refused).toEqual({ tokenId: twice.tokenId, reason: 'duplicate' });
    const sameId = await mintAgent(page, { tokenId: first.tokenId });
    expect(sameId.answer.refused?.reason).toBe('duplicate');
    const soon = await mintAgent(page, { expiresAt: Date.now() + 1000 });
    expect(soon.answer.refused?.reason).toBe('expired');
    for (let i = 1; i < MAX_LIVE_AGENTS_PER_PAGE; i += 1) {
      expect((await mintAgent(page)).answer.refused).toBeUndefined();
    }
    const eleventh = await mintAgent(page);
    expect(eleventh.answer.refused?.reason).toBe('limit');
    expect(eleventh.answer.agents).toHaveLength(MAX_LIVE_AGENTS_PER_PAGE);
  }, 20_000);

  it('holds a token to 8 hours on its own clock, whatever the page asks', async () => {
    const { relay, page } = await room();
    const asked = Date.now() + 48 * 3_600_000;
    const minted = await mintAgent(page, { expiresAt: asked });
    const kept = relay.store.agents.get(page.pageId, minted.tokenId);
    expect(kept?.expiresAt).toBeLessThanOrEqual(Date.now() + 8 * 3_600_000);
    expect(minted.answer.agents[0]?.expiresAt).toBe(asked);
  });

  it('refuses without a public URL, which the agents frame names as none', async () => {
    plain = await startRelay({
      invites: true,
      agentTokens: true,
      allowedOrigins: [PAGE_ORIGIN],
    });
    const { connectPage } = await import('./helpers/page-client.ts');
    const page = await connectPage(plain.relay.pageUrl, { policy: { invites: 'all' } });
    expect(page.all('agents')).toEqual([{ t: 'agents', endpoint: null, agents: [] }]);
    expect((await mintAgent(page)).answer.refused?.reason).toBe('no_public_url');
    page.ws.terminate();
  });
});

describe('the first request (S4)', () => {
  it('raises one ordinary prompt carrying the token, its label and its client, which later requests join', async () => {
    const { relay, page } = await room();
    const minted = await mintAgent(page, { label: 'Nightly checker' });
    const agent = await agentOn(relay, minted.token, 'claude-code');
    const request = await page.next('attach_request');
    const userId = agentUserId(page.pageId, minted.tokenId);
    expect(request).toMatchObject({
      via: 'agent',
      agent: { tokenId: minted.tokenId, secret: minted.token, label: 'Nightly checker' },
      user: { userId, displayName: `agent ${userId.slice(2, 10)}` },
      account: { kind: 'invitee', verified: false },
      client: { name: 'claude-code', version: '2.1.287' },
    });
    expect(request).not.toHaveProperty('invite');
    // Nothing is granted before the operator answers; later requests join the prompt.
    const listed = await call(agent, 'list_pages');
    expect(listed.text).toMatch(/not attached to any page/);
    await call(agent, 'list_pages');
    await page.sync();
    expect(page.all('attach_request')).toHaveLength(2);
    expect((await latest(page, 'agents')).agents[0]?.state).toBe('asking');
    expect(relay.store.attachments.get(page.pageId, userId)).toBeUndefined();
  });

  it("pair_page waits on the token's own prompt and never spends a code it names", async () => {
    const { relay, page } = await room();
    const minted = await mintAgent(page);
    const agent = await agentOn(relay, minted.token);
    const request = await page.next('attach_request');
    const code = page.code;
    const pairings = page.all('pairing').length;
    const pending = call(agent, 'pair_page', { code });
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
    expect(outcome.text).toContain('as observer');
    await page.sync();
    // The code was never looked at: it is still the page's, unrotated.
    expect(page.code).toBe(code);
    expect(page.all('pairing')).toHaveLength(pairings);
    expect(page.all('attach_request')).toHaveLength(2);
  });
});

describe('an allowed agent (S5, S13)', () => {
  it("reads one page as an observer, whatever the answer named, ending at its token's end", async () => {
    const { relay, page, alice } = await room({}, { proposals: 'all' });
    const other = await relay.page({ policy: { invites: 'all' } });
    await attachMember(alice, other);
    const { agent, tokenId, userId } = await attachedAgent(relay, page);
    const attachment = relay.store.attachments.get(page.pageId, userId);
    const token = relay.store.agents.get(page.pageId, tokenId);
    expect(attachment).toMatchObject({
      role: 'observer',
      kind: 'invitee',
      inviteId: tokenId,
      inviteRole: 'observer',
      sponsorId: 'alice',
      endsAt: token?.expiresAt,
    });
    expect(token?.state).toBe('attached');
    const pages = await call(agent, 'list_pages');
    expect((pages.structured as { pages: { page: string }[] }).pages.map((p) => p.page)).toEqual([
      page.pageId,
    ]);
    // The other page answers as one it never saw (S13).
    const elsewhere = await call(agent, 'list_page_tools', { page: other.pageId });
    expect(elsewhere.text).toMatch(/^not_attached/);
    const read = await call(agent, 'call_page_tool', {
      page: page.pageId,
      tool: READ_TOOL.name,
      arguments: {},
    });
    expect(read.isError, read.text).toBe(false);
    // An agent never writes, nor proposes, even where the page takes proposals from all (C13).
    const write = await call(agent, 'call_page_tool', {
      page: page.pageId,
      tool: WRITE_TOOL.name,
      arguments: { text: 'x' },
    });
    expect(write.text).toMatch(/^role_denied/);
    // An operator's set_role cannot pass the token's observer cap.
    page.send({ t: 'set_role', userId, role: 'driver' });
    await page.sync();
    expect(relay.store.attachments.get(page.pageId, userId)?.role).toBe('observer');
    const [attach] = records(relay, 'attach').filter((event) => event.userId === userId);
    expect(attach).toMatchObject({
      via: 'agent',
      inviteId: tokenId,
      kind: 'invitee',
      email: 'unverified',
      clientId: null,
    });
    auditValid(relay);
  });

  it('may hold a state wait (C28)', async () => {
    const { relay, page } = await room();
    const { agent } = await attachedAgent(relay, page);
    const waited = await call(agent, 'wait_for_page_state', {
      page: page.pageId,
      after: 0,
      timeoutMs: 300,
    });
    expect(waited.isError, waited.text).toBe(false);
  });
});

describe('seats (S14)', () => {
  it('takes a watching seat, and a token that finds none raises no prompt and says page_busy', async () => {
    const { relay, page } = await room({ limits: { observersPerPage: 1 } });
    await attachedAgent(relay, page);
    const second = await mintAgent(page);
    const agent = await agentOn(relay, second.token);
    const paired = await call(agent, 'pair_page', { code: page.code });
    expect(paired.text).toMatch(/^page_busy/);
    await page.sync();
    // Alice's prompt and the first agent's only.
    expect(page.all('attach_request')).toHaveLength(2);
    expect(relay.store.agents.get(page.pageId, second.tokenId)?.state).toBe('dormant');
  });

  it('answers an approval page_busy once a demotion filled the watching seat meanwhile', async () => {
    const { relay, page } = await room({ limits: { observersPerPage: 1 } }, { maxDrivers: 2 });
    const carol = await relay.claude('sub-carol', 'carol@example.com');
    const invite = await mintOk(page, { role: 'driver' });
    const joined = await redeem(carol, page, invite.link, { allow: true, role: 'driver' });
    expect(joined.outcome.isError, joined.outcome.text).toBe(false);
    const guest = relay.store.attachments
      .listForPage(page.pageId)
      .find((attachment) => attachment.inviteId === invite.inviteId);
    if (guest === undefined) throw new Error('no guest');
    expect(guest.role).toBe('driver');
    const minted = await mintAgent(page);
    await agentOn(relay, minted.token);
    const request = await page.next('attach_request');
    expect(request.via).toBe('agent');
    // A demotion is always allowed, and moves Carol into the one watching seat.
    page.send({ t: 'set_role', userId: guest.userId, role: 'observer' });
    await page.sync();
    page.send({
      t: 'attach_decision',
      requestId: request.requestId,
      allow: true,
      role: 'observer',
    });
    await page.sync();
    expect(records(relay, 'attach_refused').at(-1)).toMatchObject({
      via: 'agent',
      inviteId: minted.tokenId,
      outcome: 'page_busy',
    });
    const userId = agentUserId(page.pageId, minted.tokenId);
    expect(relay.store.attachments.get(page.pageId, userId)).toBeUndefined();
    expect(relay.store.agents.get(page.pageId, minted.tokenId)?.state).toBe('dormant');
  });

  it("with no watching seats, agents keep to the invites' share of the people, leaving members two", async () => {
    const { relay, page } = await room({ limits: { usersPerPage: 4, observersPerPage: 0 } });
    await attachedAgent(relay, page, 'One');
    await attachedAgent(relay, page, 'Two');
    const third = await mintAgent(page);
    const agent = await agentOn(relay, third.token);
    expect((await call(agent, 'pair_page', { code: page.code })).text).toMatch(/^page_busy/);
    // Bob, a member, still pairs by code into the fourth seat.
    await attachMember(await relay.claude('sub-bob'), page, 'observer');
    expect(relay.store.attachments.listForPage(page.pageId)).toHaveLength(4);
  });

  // W2-C's #pageFull counts the people alone, so watching agents leave the
  // people's seats to members (this case failed on W2-D's branch alone).
  it("watching agents never take a member's seat among the people", async () => {
    const { relay, page } = await room({ limits: { usersPerPage: 3, observersPerPage: 5 } });
    await attachedAgent(relay, page, 'One');
    await attachedAgent(relay, page, 'Two');
    await attachedAgent(relay, page, 'Three');
    await attachMember(await relay.claude('sub-bob'), page, 'observer');
    expect(relay.store.attachments.listForPage(page.pageId)).toHaveLength(5);
  });
});

describe('every way a token ends (S8, S14)', () => {
  it('a deny closes it as denied, and the next request gets 404', async () => {
    const { relay, page } = await room();
    const minted = await mintAgent(page);
    await agentRequest(relay.relay.url, minted.token, INITIALIZE);
    const request = await page.next('attach_request');
    page.send({ t: 'attach_decision', requestId: request.requestId, allow: false });
    await page.sync();
    expect(records(relay, 'agent_closed')).toMatchObject([
      { tokenId: minted.tokenId, reason: 'denied' },
    ]);
    expect(records(relay, 'attach_refused').at(-1)).toMatchObject({
      via: 'agent',
      inviteId: minted.tokenId,
      outcome: 'denied_by_operator',
    });
    expect((await latest(page, 'agents')).agents).toEqual([]);
    await gone(relay, minted.token);
    auditValid(relay);
  });

  it('three prompts left to time out burn it; one returns it to waiting', async () => {
    const { relay, page } = await room({ timings: { attachRequestTtlMs: 200 } });
    const minted = await mintAgent(page);
    for (let timeouts = 1; timeouts <= 3; timeouts += 1) {
      await agentRequest(relay.relay.url, minted.token, INITIALIZE);
      await page.next('attach_request');
      await new Promise((resolve) => setTimeout(resolve, 300));
      await page.sync();
      if (timeouts < 3) {
        expect((await latest(page, 'agents')).agents[0]).toMatchObject({
          state: 'dormant',
          timeouts,
        });
      }
    }
    expect(records(relay, 'agent_closed')).toMatchObject([{ reason: 'burned' }]);
    await gone(relay, minted.token);
  });

  it('a revoke cancels its call in flight, closes it as revoked, and the next request gets 404', async () => {
    const { relay, page } = await room();
    const { agent, token, tokenId, userId } = await attachedAgent(relay, page);
    page.onInvoke = () => undefined;
    const pending = call(agent, 'call_page_tool', {
      page: page.pageId,
      tool: READ_TOOL.name,
      arguments: {},
    });
    await page.next('invoke');
    page.send({ t: 'revoke', userId });
    const answer = await pending;
    expect(answer.text).toMatch(/^not_attached/);
    await page.sync();
    expect(page.all('cancel')).toHaveLength(1);
    expect(records(relay, 'agent_closed')).toMatchObject([{ tokenId, reason: 'revoked' }]);
    expect(records(relay, 'revoke')).toMatchObject([{ userId, everyone: false }]);
    expect(relay.store.attachments.get(page.pageId, userId)).toBeUndefined();
    await gone(relay, token);
    auditValid(relay);
  });

  it('Revoke all closes every token, attached or not', async () => {
    const { relay, page } = await room();
    const attached = await attachedAgent(relay, page);
    const dormant = await mintAgent(page);
    page.send({ t: 'revoke', userId: '*' });
    await page.sync();
    const closed = records(relay, 'agent_closed');
    expect(closed.map((event) => event.reason)).toEqual(['revoked', 'revoked']);
    expect(relay.store.agents.listForPage(page.pageId)).toEqual([]);
    await gone(relay, attached.token);
    await gone(relay, dormant.token);
  });

  it("the operator's Cancel closes it and ends its attachment", async () => {
    const { relay, page } = await room();
    const { token, tokenId, userId } = await attachedAgent(relay, page);
    page.send({ t: 'agent_cancel', tokenId });
    await page.sync();
    expect(records(relay, 'agent_closed')).toMatchObject([{ tokenId, reason: 'cancelled' }]);
    expect(relay.store.attachments.get(page.pageId, userId)).toBeUndefined();
    expect((await latest(page, 'roster')).attachments.map((entry) => entry.userId)).toEqual([
      'alice',
    ]);
    await gone(relay, token);
    auditValid(relay);
  });

  it("its sponsor's end closes it, counted on the sponsor_gone record", async () => {
    const { relay, page, alice } = await room();
    const { token, tokenId, userId } = await attachedAgent(relay, page);
    const dormant = await mintAgent(page);
    const detached = await call(alice, 'detach_page', { page: page.pageId });
    expect(detached.isError, detached.text).toBe(false);
    await page.sync();
    expect(records(relay, 'agent_closed').map((event) => [event.tokenId, event.reason])).toEqual([
      [tokenId, 'sponsor_gone'],
      [dormant.tokenId, 'sponsor_gone'],
    ]);
    expect(records(relay, 'expire')).toMatchObject([{ userId, reason: 'sponsor_gone' }]);
    expect(records(relay, 'sponsor_gone')).toMatchObject([
      { sponsor: 'alice', invites: 2, attachments: 0 },
    ]);
    await gone(relay, token);
    await gone(relay, dormant.token);
    auditValid(relay);
  });

  it('a member the members file drops takes the tokens they sponsored, once (ADR 0043)', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tabdock-agents-')));
    chmodSync(dir, 0o700);
    scratches.push(dir);
    const file = join(dir, 'members.txt');
    const save = (lines: string[]): void => {
      writeFileSync(`${file}.new`, `${lines.join('\n')}\n`, { mode: 0o600 });
      renameSync(`${file}.new`, file);
    };
    save(['sub-alice=alice:Alice', 'sub-bob=bob:Bob']);
    const { relay, page } = await room({ membersFile: file });
    const { token, tokenId, userId } = await attachedAgent(relay, page);
    const dormant = await mintAgent(page);
    save(['sub-bob=bob:Bob']);
    expect(await relay.relay.reloadMembers()).toBe('applied');
    expect(records(relay, 'agent_closed').map((event) => [event.tokenId, event.reason])).toEqual([
      [tokenId, 'sponsor_gone'],
      [dormant.tokenId, 'sponsor_gone'],
    ]);
    expect(relay.store.attachments.get(page.pageId, userId)).toBeUndefined();
    await gone(relay, token);
    await gone(relay, dormant.token);
    // The same id ended again holds nothing, so nothing more is closed or written.
    save(['sub-alice=alice:Alice', 'sub-bob=bob:Bob']);
    expect(await relay.relay.reloadMembers()).toBe('applied');
    save(['sub-bob=bob:Bob']);
    expect(await relay.relay.reloadMembers()).toBe('applied');
    expect(records(relay, 'agent_closed')).toHaveLength(2);
    expect(records(relay, 'sponsor_gone')).toHaveLength(1);
    auditValid(relay);
  });

  it("its page's end closes it", async () => {
    const { relay, page } = await room();
    const { token, tokenId } = await attachedAgent(relay, page);
    page.ws.close(4000, 'detach');
    await page.closed;
    await expect
      .poll(() => records(relay, 'agent_closed'))
      .toMatchObject([{ tokenId, reason: 'page_gone' }]);
    await gone(relay, token);
    auditValid(relay);
  });

  it('its time closes it however late its timer, ending its attachment there', async () => {
    const { relay, page } = await room();
    const { token, tokenId, userId } = await attachedAgent(relay, page);
    const kept = relay.store.agents.get(page.pageId, tokenId);
    if (kept === undefined) throw new Error('no token');
    // As a timer running late would find it: past its end, still in the store.
    kept.expiresAt = Date.now() - 1;
    await gone(relay, token);
    expect(records(relay, 'agent_closed')).toMatchObject([{ tokenId, reason: 'expired' }]);
    expect(records(relay, 'expire')).toMatchObject([{ userId, reason: 'ends_at' }]);
    expect(relay.store.attachments.get(page.pageId, userId)).toBeUndefined();
    auditValid(relay);
  });

  it('a token closed while its request body was on its way serves nothing (S8)', async () => {
    const { relay, page } = await room();
    const minted = await mintAgent(page);
    const answered = heldBody(relay, minted.token, async () => {
      page.send({ t: 'agent_cancel', tokenId: minted.tokenId });
      await page.sync();
    });
    expect(await answered).toBe(404);
    // Nothing reached the page: no prompt was raised.
    await page.sync();
    expect(page.all('attach_request')).toHaveLength(1);
  });

  it('nor does one closed and minted again under the same id meanwhile, which is another token', async () => {
    const { relay, page } = await room();
    const minted = await mintAgent(page);
    const answered = heldBody(relay, minted.token, async () => {
      page.send({ t: 'agent_cancel', tokenId: minted.tokenId });
      await page.sync();
      const again = await mintAgent(page, { tokenId: minted.tokenId });
      expect(again.answer.refused).toBeUndefined();
    });
    expect(await answered).toBe(404);
    // The new token raised no prompt carrying the old one, which would burn it.
    await page.sync();
    expect(page.all('attach_request')).toHaveLength(1);
    expect(relay.store.agents.get(page.pageId, minted.tokenId)?.state).toBe('dormant');
  });
});

describe('/g/mcp answers (S11, S12)', () => {
  it('every token miss with one 404, never 401 or 403, a challenge or metadata', async () => {
    const { relay, page } = await room();
    const minted = await mintAgent(page);
    page.send({ t: 'agent_cancel', tokenId: minted.tokenId });
    await page.sync();
    const misses: (Record<string, string> | null)[] = [
      null,
      { Authorization: 'Bearer abc' },
      { Authorization: `Basic ${Buffer.from('a:b').toString('base64')}` },
      { Authorization: `Bearer ${newAgentToken().token}` },
      { Authorization: `Bearer ${minted.token}` },
    ];
    for (const headers of misses) {
      const answer = await agentRequest(relay.relay.url, null, INITIALIZE, {
        headers: headers ?? {},
      });
      expect(answer.status).toBe(404);
      expect(answer.body).toBe(NOT_FOUND);
      expect(answer.headers.get('www-authenticate')).toBeNull();
    }
    const metadata = await rawRequest(
      relay.relay.url,
      '/.well-known/oauth-protected-resource/g/mcp',
      { host: new URL(PUBLIC_ORIGIN).host },
    );
    expect(metadata.status).toBe(404);
  });

  it('refuses a foreign Origin and a wrong Host with 403 before any token is read', async () => {
    const { relay, page } = await room();
    const minted = await mintAgent(page);
    const origin = await agentRequest(relay.relay.url, minted.token, INITIALIZE, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(origin.status).toBe(403);
    const host = await agentRequest(relay.relay.url, minted.token, INITIALIZE, {
      headers: { Host: 'evil.example' },
    });
    expect(host.status).toBe(403);
    // Neither raised a prompt.
    await page.sync();
    expect(page.all('attach_request')).toHaveLength(1);
  });

  it("neither leg takes the other's live session, and the token's close ends its sessions and streams", async () => {
    const { relay, page } = await room();
    const { token, tokenId, userId } = await attachedAgent(relay, page);
    const host = new URL(PUBLIC_ORIGIN).host;
    const signedIn = `Bearer ${await relay.provider.token({ sub: 'sub-alice', aud: `${PUBLIC_ORIGIN}/mcp` })}`;
    const onMcp = (authorization: string, body: unknown, sessionId?: string) =>
      rawRequest(relay.relay.url, '/mcp', {
        method: 'POST',
        host,
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(sessionId === undefined
            ? {}
            : { 'Mcp-Session-Id': sessionId, 'Mcp-Protocol-Version': '2025-11-25' }),
        },
        body: JSON.stringify(body),
      });
    const onAgent = (body: unknown, sessionId: string) =>
      agentRequest(relay.relay.url, token, body, {
        headers: { 'Mcp-Session-Id': sessionId, 'Mcp-Protocol-Version': '2025-11-25' },
      });
    const presentedBy = (who: string) =>
      relay
        .events()
        .some(
          (line) => line.msg === 'MCP session id presented by another user' && line.userId === who,
        );
    // The token is no OAuth token, so /mcp asks for a sign-in instead.
    expect((await onMcp(`Bearer ${token}`, INITIALIZE)).status).toBe(401);
    const agentSession = (await agentRequest(relay.relay.url, token, INITIALIZE)).headers.get(
      'mcp-session-id',
    );
    const aliceSession = (await onMcp(signedIn, INITIALIZE)).headers.get('mcp-session-id');
    if (agentSession === null || aliceSession === null) throw new Error('no session');
    expect((await onAgent(INITIALIZED, agentSession)).status).toBe(202);
    expect((await onMcp(signedIn, INITIALIZED, aliceSession)).status).toBe(202);
    // While both are live, each id is the same 404 as an unknown one to the
    // other's leg and account, and its line says whose it was not (S13).
    expect((await onMcp(signedIn, toolCall('list_pages', {}), agentSession)).status).toBe(404);
    expect(presentedBy('alice')).toBe(true);
    expect((await onAgent(toolCall('list_pages', {}), aliceSession)).status).toBe(404);
    expect(presentedBy(userId)).toBe(true);
    // Each still serves its own owner.
    expect((await onAgent(toolCall('list_pages', {}), agentSession)).status).toBe(200);
    expect((await onMcp(signedIn, toolCall('list_pages', {}), aliceSession)).status).toBe(200);
    const listen = await agentListen(relay, token);
    expect(listen.streaming).toBe(true);
    page.send({ t: 'agent_cancel', tokenId });
    await page.sync();
    await expect
      .poll(() =>
        relay
          .events()
          .some(
            (line) =>
              line.msg === 'MCP session closed' &&
              line.userId === userId &&
              line.reason === 'agent token closed',
          ),
      )
      .toBe(true);
    // Its listen stream ends with it (ADR 0044, decision 26).
    expect(await Promise.race([listen.ended.then(() => 'ended'), delay(5000, 'open')])).toBe(
      'ended',
    );
    // Its session id still means nothing to anyone else, and Alice's own goes on.
    expect((await onMcp(signedIn, toolCall('list_pages', {}), agentSession)).status).toBe(404);
    expect((await onMcp(signedIn, toolCall('list_pages', {}), aliceSession)).status).toBe(200);
  });

  it('parses no large body to name a client, nor any body an attached agent sends (ADR 0030)', async () => {
    const { relay, page } = await room();
    const attached = await attachedAgent(relay, page);
    const dormant = await mintAgent(page);
    // About 1.8 MB of empty objects, which would hold some fifty times that once parsed.
    const flood = Array.from({ length: 600_000 }, () => ({}));
    const parse = vi.spyOn(JSON, 'parse');
    try {
      for (const token of [dormant.token, attached.token]) {
        const answer = await agentRequest(relay.relay.url, token, flood);
        expect(answer.status).toBe(413);
      }
      const long = parse.mock.calls.filter(
        ([text]) => typeof text === 'string' && text.length > 16 * 1024,
      );
      expect(long).toHaveLength(0);
    } finally {
      parse.mockRestore();
    }
  });

  it('never writes the token, its digest or its label to a line or a record', async () => {
    const { relay, page } = await room();
    const label = 'Quiet label 7f3a';
    const { token, hash, tokenId } = await attachedAgent(relay, page, label);
    page.send({ t: 'agent_cancel', tokenId });
    await page.sync();
    await gone(relay, token);
    const written = [
      ...relay.lines,
      ...relay.relay.audit.events().map((event) => JSON.stringify(event)),
    ].join('\n');
    const digest = createHash('sha256').update(token, 'utf8').digest();
    expect(written).not.toContain(token);
    expect(written).not.toContain(token.slice(4, 20));
    expect(written).not.toContain(hash);
    expect(written).not.toContain(digest.toString('base64url'));
    expect(written).not.toContain(label);
    expect(AGENT_URL).toBe(`${PUBLIC_ORIGIN}/g/mcp`);
  });
});

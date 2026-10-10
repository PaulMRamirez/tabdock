// ADR 0044's protocol pieces for larger read-only rooms: agent tokens, the
// attach requests and frames that carry them, the adapter's record of one,
// the welcome's room numbers and the constants both sides enforce. Each case
// fails without its schema change.

import { describe, expect, it } from 'vitest';
import {
  AGENT_BURN_TIMEOUTS,
  AGENT_KEY_DOMAIN,
  AGENT_LIFETIMES_MS,
  AGENT_PATH,
  AGENT_TOKEN_BYTES,
  AGENT_TOKEN_CHARS,
  AGENT_TOKEN_PREFIX,
  agentKeyInput,
  AgentListingSchema,
  AgentTokenSchema,
  DEFAULT_AGENT_LIFETIME_MS,
  isAgentEndpoint,
  LimitsSchema,
  MAX_AGENT_LIFETIME_MS,
  MAX_LIVE_AGENTS_PER_PAGE,
  MAX_OBSERVERS_PER_PAGE,
  MAX_ROSTER_CLIENTS_PER_INVITEE,
  MAX_USERS_PER_PAGE,
  MEMBER_RESERVED_SEATS,
  parsePageFrame,
  parseRelayFrame,
  StoredAgentSchema,
  StoredAgentsSchema,
} from './index.ts';

const TOKEN = `tda_${'Ab0_-'.repeat(8)}abc`;
const AGENT_ID = `g_${'a'.repeat(32)}`;

const request = {
  t: 'attach_request',
  requestId: 'rq_1',
  user: { userId: AGENT_ID, displayName: 'agent aaaaaaaa' },
  account: { kind: 'invitee', verified: false },
  via: 'agent',
  agent: { tokenId: 'ag_1', secret: TOKEN, label: 'CI walk' },
  client: { name: 'claude-code', version: '2.1.288' },
  expiresAt: 60_000,
};

const listing = {
  tokenId: 'ag_1',
  label: 'CI walk',
  expiresAt: 3_600_000,
  sponsor: { userId: 'alice', displayName: 'Alice' },
  state: 'dormant',
  timeouts: 0,
};

describe('agent tokens', () => {
  it('are the prefix and 43 base64url characters, and nothing else', () => {
    expect(TOKEN).toHaveLength(AGENT_TOKEN_CHARS);
    expect(AgentTokenSchema.safeParse(TOKEN).success).toBe(true);
    for (const bad of [
      TOKEN.slice(0, -1),
      `${TOKEN}a`,
      `tdx_${TOKEN.slice(4)}`,
      `TDA_${TOKEN.slice(4)}`,
      `${TOKEN.slice(0, -1)}=`,
      `${TOKEN.slice(0, -1)}+`,
      `${TOKEN.slice(0, -1)}/`,
      ` ${TOKEN.slice(1)}`,
    ]) {
      expect(AgentTokenSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('give an agent an id hashed from a text no subject can be', () => {
    expect(agentKeyInput('pg_1', 'ag_1')).toBe('tabdock agent\npg_1\nag_1');
    expect(agentKeyInput('pg_1', 'ag_1').startsWith(`${AGENT_KEY_DOMAIN}\n`)).toBe(true);
  });

  it("keep ADR 0044's numbers", () => {
    expect(AGENT_PATH).toBe('/g/mcp');
    expect(AGENT_TOKEN_PREFIX).toBe('tda_');
    expect(AGENT_TOKEN_BYTES).toBe(32);
    // 32 bytes are 43 base64url characters without padding, after the prefix.
    expect(AGENT_TOKEN_CHARS).toBe(
      AGENT_TOKEN_PREFIX.length + Math.ceil((AGENT_TOKEN_BYTES * 4) / 3),
    );
    expect(DEFAULT_AGENT_LIFETIME_MS).toBe(3_600_000);
    expect(MAX_AGENT_LIFETIME_MS).toBe(28_800_000);
    expect(AGENT_LIFETIMES_MS).toEqual([3_600_000, 14_400_000, 28_800_000]);
    expect(AGENT_LIFETIMES_MS).toContain(DEFAULT_AGENT_LIFETIME_MS);
    expect(Math.max(...AGENT_LIFETIMES_MS)).toBe(MAX_AGENT_LIFETIME_MS);
    expect(MAX_LIVE_AGENTS_PER_PAGE).toBe(10);
    expect(AGENT_BURN_TIMEOUTS).toBe(3);
    expect(MAX_OBSERVERS_PER_PAGE).toBe(100);
    expect(MAX_USERS_PER_PAGE).toBe(50);
    expect(MAX_ROSTER_CLIENTS_PER_INVITEE).toBe(2);
    expect(MEMBER_RESERVED_SEATS).toBe(2);
  });
});

describe('an attach request through an agent token', () => {
  it('carries its token and an unverified invitee account', () => {
    expect(parseRelayFrame(JSON.stringify(request))).toEqual({ kind: 'ok', frame: request });
  });

  it('is refused without its token, with a token beside another way in, or as anything but an unverified invitee', () => {
    // JSON leaves an undefined key out, so this frame has no agent at all.
    const withoutAgent = { ...request, agent: undefined };
    const invite = { inviteId: 'inv_1', secret: 'a'.repeat(22), label: 'Friends' };
    for (const [what, frame] of [
      ['no agent object', withoutAgent],
      ['an agent object on an invite request', { ...request, via: 'invite', invite }],
      ['an agent object on a code request', { ...request, via: 'code' }],
      [
        'a member',
        {
          ...request,
          user: { userId: 'alice', displayName: 'Alice' },
          account: { kind: 'member', verified: true },
        },
      ],
      ['a verified invitee', { ...request, account: { kind: 'invitee', verified: true } }],
      ['a malformed token', { ...request, agent: { ...request.agent, secret: 'tda_short' } }],
    ] as const) {
      expect(parseRelayFrame(JSON.stringify(frame)).kind, what).toBe('invalid');
    }
  });

  it('never repeats the token in a refusal', () => {
    const parsed = parseRelayFrame(JSON.stringify({ ...request, via: 'code' }));
    expect(JSON.stringify(parsed)).not.toContain(TOKEN);
  });
});

describe('the agents frame', () => {
  const frame = { t: 'agents', endpoint: 'https://relay.example/g/mcp', agents: [listing] };

  it('lists live tokens with their sponsor, state and timeouts', () => {
    expect(parseRelayFrame(JSON.stringify(frame))).toEqual({ kind: 'ok', frame });
    for (const state of ['dormant', 'asking', 'attached']) {
      const agents = [{ ...listing, state }];
      expect(parseRelayFrame(JSON.stringify({ ...frame, agents })).kind, state).toBe('ok');
    }
    expect(parseRelayFrame(JSON.stringify({ ...frame, endpoint: null })).kind).toBe('ok');
    const refused = { ...frame, refused: { tokenId: 'ag_2', reason: 'limit' } };
    expect(parseRelayFrame(JSON.stringify(refused)).kind).toBe('ok');
  });

  it('is capped at ten tokens, each at three timeouts', () => {
    const agents = (count: number): unknown[] =>
      Array.from({ length: count }, (_, i) => ({ ...listing, tokenId: `ag_${String(i)}` }));
    expect(parseRelayFrame(JSON.stringify({ ...frame, agents: agents(10) })).kind).toBe('ok');
    expect(parseRelayFrame(JSON.stringify({ ...frame, agents: agents(11) })).kind).toBe('invalid');
    expect(AgentListingSchema.safeParse({ ...listing, timeouts: 3 }).success).toBe(true);
    expect(AgentListingSchema.safeParse({ ...listing, timeouts: 4 }).success).toBe(false);
    expect(AgentListingSchema.safeParse({ ...listing, state: 'burned' }).success).toBe(false);
  });

  it("names only an https origin's /g/mcp as the endpoint", () => {
    expect(isAgentEndpoint('https://relay.example/g/mcp')).toBe(true);
    expect(isAgentEndpoint('https://relay.example:8443/g/mcp')).toBe(true);
    expect(isAgentEndpoint('https://[::1]:8787/g/mcp')).toBe(true);
    for (const bad of [
      'http://relay.example/g/mcp',
      'https://relay.example/g/mcp?x=1',
      'https://relay.example/g/mcp#x',
      'https://relay.example/mcp',
      'https://relay.example/g/mcp/',
      'https://relay.example/i',
      'https://user@relay.example/g/mcp',
      'https://Relay.example/g/mcp',
      `https://${'a'.repeat(2048)}.example/g/mcp`,
    ]) {
      expect(isAgentEndpoint(bad), bad).toBe(false);
      expect(parseRelayFrame(JSON.stringify({ ...frame, endpoint: bad })).kind, bad).toBe(
        'invalid',
      );
    }
  });
});

describe('the page frames for agent tokens', () => {
  const create = {
    t: 'agent_create',
    tokenId: 'ag_1',
    label: 'CI walk',
    expiresAt: 3_600_000,
    secretHash: 'f'.repeat(64),
  };

  it('mint by hash and cancel by id, never carrying the token', () => {
    expect(parsePageFrame(JSON.stringify(create)).kind).toBe('ok');
    expect(parsePageFrame('{"t":"agent_cancel","tokenId":"ag_1"}').kind).toBe('ok');
    for (const bad of [
      { ...create, expiresAt: undefined },
      { ...create, expiresAt: null },
      { ...create, secretHash: 'F'.repeat(64) },
      { ...create, label: '' },
    ]) {
      expect(parsePageFrame(JSON.stringify(bad)).kind, JSON.stringify(bad)).toBe('invalid');
    }
    // A token sent by mistake is dropped, never forwarded: the frame strips keys it does not know.
    const parsed = parsePageFrame(JSON.stringify({ ...create, secret: TOKEN }));
    expect(JSON.stringify(parsed)).not.toContain(TOKEN);
  });
});

describe("the adapter's record of an agent token", () => {
  const stored = {
    tokenId: 'ag_1',
    secretHash: 'f'.repeat(64),
    label: 'CI walk',
    createdAt: 1,
    expiresAt: 3_600_001,
    timeouts: 1,
    burned: false,
  };

  it('reads back as written, and is no record when it holds the token', () => {
    expect(StoredAgentSchema.parse(stored)).toEqual(stored);
    expect(StoredAgentSchema.safeParse({ ...stored, token: TOKEN }).success).toBe(false);
    expect(StoredAgentSchema.safeParse({ ...stored, secret: TOKEN }).success).toBe(false);
    expect(StoredAgentSchema.safeParse({ ...stored, timeouts: 4 }).success).toBe(false);
  });

  it('is kept ten to a page', () => {
    const agents = (count: number): unknown[] =>
      Array.from({ length: count }, (_, i) => ({ ...stored, tokenId: `ag_${String(i)}` }));
    expect(StoredAgentsSchema.safeParse({ pageId: 'pg_1', agents: agents(10) }).success).toBe(true);
    expect(StoredAgentsSchema.safeParse({ pageId: 'pg_1', agents: agents(11) }).success).toBe(
      false,
    );
  });
});

describe("the welcome's room numbers", () => {
  const limits = {
    maxFrameBytes: 1_048_576,
    maxResultChars: 120_000,
    maxDescriptionChars: 1000,
    pingIntervalMs: 15_000,
    idleTimeoutMs: 30_000,
    resumeWindowMs: 600_000,
    attachRequestTtlMs: 60_000,
  };

  it('are optional, so a welcome without them parses', () => {
    expect(LimitsSchema.parse(limits)).toEqual(limits);
  });

  it('take 0 watching seats and any count above, which the adapter clamps', () => {
    expect(
      LimitsSchema.safeParse({ ...limits, usersPerPage: 4, observersPerPage: 0 }).success,
    ).toBe(true);
    expect(LimitsSchema.safeParse({ ...limits, observersPerPage: 101 }).success).toBe(true);
    expect(LimitsSchema.safeParse({ ...limits, observersPerPage: -1 }).success).toBe(false);
    expect(LimitsSchema.safeParse({ ...limits, usersPerPage: 0 }).success).toBe(false);
    expect(LimitsSchema.safeParse({ ...limits, usersPerPage: 2.5 }).success).toBe(false);
  });
});

// A6.23 on the page's side (ADR 0044): minting an agent token keeps only its
// hash, here as at the relay, and hands the token and its command back once;
// a first request is honoured only against this page's own record (the
// token presented, its label, the agent's id derived from this page and the
// token, and its time), so a relay that lies is refused without a prompt
// (S4); an allowed agent is an observer whatever anyone asks (S5); and a
// denial, three timeouts, a revoke or a Cancel each tell the relay to close
// the token.

import {
  AGENT_BURN_TIMEOUTS,
  agentKeyInput,
  ATTACH_REQUEST_TTL_MS,
  type PolicyInput,
  type RelayFrame,
  StoredAgentsSchema,
} from '@tabdock/protocol';
import { describe, expect, it } from 'vitest';
import { type AgentTokenOptions, type AgentTokenResult, type UiPort } from '../src/core.ts';
import {
  attachment,
  type FakeSocket,
  flush,
  type Harness,
  invitedAttachment,
  invoke,
  link,
  MapStorage,
  results,
  setup,
  sha256Hex,
  SPONSOR,
  until,
} from './harness.ts';

const AGENTS_KEY = 'tabdock:agents:["ws://relay.test/page","http://127.0.0.1:5173/board"]';
const GRANTS_KEY = 'tabdock:grants:["ws://relay.test/page","http://127.0.0.1:5173/board"]';
const ENDPOINT = 'https://relay.example/g/mcp';
const HOUR = 3_600_000;

type AgentsFrame = Extract<RelayFrame, { t: 'agents' }>;
type AttachRequestFrame = Extract<RelayFrame, { t: 'attach_request' }>;
type AgentCreate = Extract<ReturnType<FakeSocket['frames']>[number], { t: 'agent_create' }>;
type Listing = AgentsFrame['agents'][number];

/** The agent user the relay names for a token on a page, as both sides derive it. */
async function agentUser(tokenId: string, pageId: string): Promise<string> {
  return `g_${(await sha256Hex(agentKeyInput(pageId, tokenId))).slice(0, 32)}`;
}

function listingOf(create: AgentCreate, overrides: Partial<Listing> = {}): Listing {
  return {
    tokenId: create.tokenId,
    label: create.label,
    expiresAt: create.expiresAt,
    sponsor: SPONSOR,
    state: 'dormant',
    timeouts: 0,
    ...overrides,
  };
}

function agentsFrame(agents: Listing[], overrides: Partial<AgentsFrame> = {}): AgentsFrame {
  return { t: 'agents', endpoint: ENDPOINT, agents, ...overrides };
}

/** A page linked to a relay that takes agent tokens, with Alice attached as their sponsor. */
async function offering(
  policy: PolicyInput = {},
  ui?: UiPort,
): Promise<{ h: Harness; socket: FakeSocket; listed: Listing[] }> {
  const h = setup({ core: { policy: { invites: 'all', ...policy }, ...(ui ? { ui } : {}) } });
  const socket = await link(h);
  socket.deliver(agentsFrame([]));
  await flush();
  return { h, socket, listed: [] };
}

interface MintedAgent {
  readonly tokenId: string;
  readonly token: string;
  readonly command: string;
  readonly create: AgentCreate;
  readonly result: AgentTokenResult;
  /** Its agent's id on this page, and the id it would have on another. */
  readonly userId: string;
  readonly elsewhere: string;
}

/** Mints through the Dock against a relay that lists every token it is asked for. */
async function mintAgent(
  h: Harness,
  socket: FakeSocket,
  listed: Listing[],
  options: AgentTokenOptions = { label: 'Lab agent' },
): Promise<MintedAgent> {
  const before = socket.framesOf('agent_create').length;
  const pending = h.dock.agentToken(options);
  await until(() => socket.framesOf('agent_create').length > before, 'an agent_create frame');
  const create = socket.framesOf('agent_create')[before];
  if (!create) throw new Error('no agent_create');
  listed.push(listingOf(create));
  socket.deliver(agentsFrame([...listed]));
  const result = await pending;
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return {
    tokenId: result.tokenId,
    token: result.token,
    command: result.command,
    create,
    result,
    userId: await agentUser(result.tokenId, 'page-1'),
    elsewhere: await agentUser(result.tokenId, 'page-2'),
  };
}

/** A token's first request as an honest relay forwards it. */
function agentRequest(
  h: Harness,
  minted: MintedAgent,
  overrides: Partial<AttachRequestFrame> = {},
): AttachRequestFrame {
  const { userId } = minted;
  return {
    t: 'attach_request',
    requestId: `agent-${minted.tokenId}`,
    user: { userId, displayName: `agent ${userId.slice(2, 10)}` },
    account: { kind: 'invitee', verified: false },
    via: 'agent',
    agent: { tokenId: minted.tokenId, secret: minted.token, label: minted.create.label },
    client: { name: 'claude-code', version: '2.1.287' },
    expiresAt: h.clock.now + ATTACH_REQUEST_TTL_MS,
    ...overrides,
  };
}

/** Lets the core's real WebCrypto settle on a request it is checking. */
async function checked(h: Harness, requestId: string): Promise<void> {
  await until(
    () =>
      h.dock.state.pendingRequests.some((request) => request.requestId === requestId) ||
      h
        .socket()
        .framesOf('attach_decision')
        .some((frame) => frame.requestId === requestId),
    'the request to be checked',
  );
}

describe('minting (ADR 0044)', () => {
  it('keeps only the hash, and hands the token and its command back once', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mintAgent(h, socket, listed, { label: 'Nightly checker', lifetime: '4h' });
    expect(minted.token).toMatch(/^tda_[A-Za-z0-9_-]{43}$/);
    expect(minted.create.secretHash).toBe(await sha256Hex(minted.token));
    expect(minted.create.expiresAt).toBe(h.clock.now + 4 * HOUR);
    expect(minted.command).toBe(
      `claude mcp add --transport http --scope local tabdock-${minted.tokenId.slice(4, 12)} ${ENDPOINT} --header "Authorization: Bearer ${minted.token}"`,
    );
    expect(minted.result).toMatchObject({ endpoint: ENDPOINT, expiresAt: h.clock.now + 4 * HOUR });
    // Storage holds the record, by a strict schema, and nowhere the token.
    const stored = StoredAgentsSchema.parse(JSON.parse(h.storage.getItem(AGENTS_KEY) ?? 'null'));
    expect(stored.agents.map((agent) => agent.tokenId)).toEqual([minted.tokenId]);
    for (const value of h.storage.items.values()) {
      expect(value).not.toContain(minted.token);
      expect(value).not.toContain(minted.token.slice(4, 20));
    }
    expect(JSON.stringify(h.dock.state)).not.toContain(minted.token);
    expect(h.logs.join('\n')).not.toContain(minted.token);
    expect(h.dock.state.agents).toEqual([
      {
        tokenId: minted.tokenId,
        label: 'Nightly checker',
        expiresAt: h.clock.now + 4 * HOUR,
        state: 'dormant',
        timeouts: 0,
        sponsor: SPONSOR,
      },
    ]);
  });

  it('refuses what it cannot mint, and what the relay refuses', async () => {
    const quiet = setup({ core: { policy: { invites: 'all' } } });
    await link(quiet);
    expect(await quiet.dock.agentToken({ label: 'x' })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    const off = await offering({ invites: 'off' });
    expect(await off.h.dock.agentToken({ label: 'x' })).toEqual({ ok: false, reason: 'policy' });
    const { h, socket } = await offering();
    for (const bad of [
      { label: '' },
      { label: 'x'.repeat(61) },
      { label: 'x', lifetime: '2h' },
    ] as AgentTokenOptions[]) {
      expect(await h.dock.agentToken(bad)).toEqual({ ok: false, reason: 'invalid' });
    }
    const pending = h.dock.agentToken({ label: 'x' });
    await until(() => socket.framesOf('agent_create').length > 0, 'an agent_create frame');
    const create = socket.framesOf('agent_create')[0];
    socket.deliver(
      agentsFrame([], { refused: { tokenId: create?.tokenId ?? '', reason: 'no_sponsor' } }),
    );
    expect(await pending).toEqual({ ok: false, reason: 'no_sponsor' });
    expect(h.storage.getItem(AGENTS_KEY)).toBeNull();
    socket.deliver(agentsFrame([], { endpoint: null }));
    await flush();
    expect(await h.dock.agentToken({ label: 'x' })).toEqual({ ok: false, reason: 'no_public_url' });
  });
});

describe("a token's first request (S4)", () => {
  it('prompts, for observer only, once it checks out against the record', async () => {
    const asked: string[] = [];
    const { h, socket, listed } = await offering(
      {},
      {
        askAttach: (request) => {
          asked.push(request.requestId);
          return undefined;
        },
      },
    );
    const minted = await mintAgent(h, socket, listed, { label: 'Nightly checker' });
    const frame = agentRequest(h, minted);
    socket.deliver(frame);
    await checked(h, frame.requestId);
    expect(h.dock.state.pendingRequests).toMatchObject([
      {
        requestId: frame.requestId,
        via: 'agent',
        agent: { tokenId: minted.tokenId, label: 'Nightly checker' },
        invite: null,
        client: { name: 'claude-code' },
      },
    ]);
    expect(JSON.stringify(h.dock.state.pendingRequests)).not.toContain(minted.token);
    expect(asked.filter((id) => id !== 'grant-alice')).toEqual([frame.requestId]);
    // Allowed as driver, it is an observer all the same, capped as a watch guest is.
    expect(h.dock.approve(frame.requestId, 'driver')).toBe(true);
    expect(socket.framesOf('attach_decision').at(-1)).toEqual({
      t: 'attach_decision',
      requestId: frame.requestId,
      allow: true,
      role: 'observer',
    });
    const grants = JSON.parse(h.storage.getItem(GRANTS_KEY) ?? 'null') as {
      grants: Record<string, unknown>;
    };
    expect(grants.grants[frame.user.userId]).toEqual({
      role: 'observer',
      inviteId: minted.tokenId,
      endsAt: h.clock.now + HOUR,
      inviteRole: 'observer',
    });
    // A relay that claims driver for it still runs only what is read-only.
    socket.deliver({
      t: 'roster',
      attachments: [
        attachment('alice', 'driver'),
        invitedAttachment(frame.user.userId, 'driver', minted.tokenId, h.clock.now + HOUR, 'agent'),
      ],
    });
    const caller = {
      userId: frame.user.userId,
      displayName: 'agent',
      client: null,
      role: 'driver' as const,
    };
    socket.deliver(invoke('set_value', { callId: 'w', caller }));
    socket.deliver(invoke('get_value', { callId: 'r', caller }));
    await until(() => results(socket).length === 2, 'both answers');
    const byCall = new Map(results(socket).map((result) => [result.callId, result]));
    expect(byCall.get('w')?.error?.code).toBe('role_denied');
    expect(byCall.get('r')?.ok).toBe(true);
    expect(h.dock.setRole(frame.user.userId, 'driver')).toBe(false);
  });

  const lies: [string, (h: Harness, minted: MintedAgent) => Partial<AttachRequestFrame>][] = [
    [
      'a token other than the one minted',
      (_h, m) => ({
        agent: { tokenId: m.tokenId, secret: `tda_${'A'.repeat(43)}`, label: m.create.label },
      }),
    ],
    [
      'a label it never had',
      (_h, m) => ({ agent: { tokenId: m.tokenId, secret: m.token, label: 'Someone else' } }),
    ],
    [
      'a token id this page never minted',
      (_h, m) => ({ agent: { tokenId: 'agt_unknown', secret: m.token, label: m.create.label } }),
    ],
    [
      'an agent id not derived from this page and token',
      (_h, m) => ({ user: { userId: m.elsewhere, displayName: 'agent' } }),
    ],
    [
      "another account's id",
      () => ({ user: { userId: `g_${'1a2b3c4d'.repeat(4)}`, displayName: 'guest' } }),
    ],
  ];
  for (const [what, lie] of lies) {
    it(`is refused without a prompt when the relay forwards ${what}`, async () => {
      const { h, socket, listed } = await offering();
      const minted = await mintAgent(h, socket, listed);
      const frame = agentRequest(h, minted, lie(h, minted));
      socket.deliver(frame);
      await checked(h, frame.requestId);
      expect(h.dock.state.pendingRequests).toEqual([]);
      expect(socket.framesOf('attach_decision').at(-1)).toEqual({
        t: 'attach_decision',
        requestId: frame.requestId,
        allow: false,
      });
    });
  }

  it("is refused once the token has expired on the page's clock", async () => {
    const { h, socket, listed } = await offering();
    const minted = await mintAgent(h, socket, listed);
    // Past its end on this page's clock, with no timer run, as a relay whose clock lags would see it.
    h.clock.now += HOUR;
    const late = agentRequest(h, minted, { requestId: 'late' });
    socket.deliver(late);
    await checked(h, 'late');
    expect(h.dock.state.pendingRequests).toEqual([]);
    expect(socket.framesOf('attach_decision').at(-1)).toMatchObject({
      requestId: 'late',
      allow: false,
    });
  });

  it('is refused once a reload leaves the page taking no invites', async () => {
    const storage = new MapStorage();
    const first = setup({ storage, core: { policy: { invites: 'all' } } });
    const socket = await link(first);
    socket.deliver(agentsFrame([]));
    await flush();
    const minted = await mintAgent(first, socket, []);
    const reloaded = setup({ storage, core: { policy: { invites: 'off' } } });
    const again = await link(
      reloaded,
      { resumed: true, roster: [attachment('alice', 'driver')] },
      {},
    );
    again.deliver(agentsFrame([listingOf(minted.create)]));
    await flush();
    const frame = agentRequest(reloaded, minted, { requestId: 'after-reload' });
    again.deliver(frame);
    await checked(reloaded, 'after-reload');
    expect(reloaded.dock.state.pendingRequests).toEqual([]);
    expect(again.framesOf('attach_decision').at(-1)).toMatchObject({
      requestId: 'after-reload',
      allow: false,
    });
  });

  it('never reaches the page as an agent with an account, which the protocol refuses', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mintAgent(h, socket, listed);
    socket.deliver(agentRequest(h, minted, { account: { kind: 'invitee', verified: true } }));
    await flush();
    expect(h.dock.state.pendingRequests).toEqual([]);
    expect(socket.closedWith).not.toBeNull();
  });
});

describe('every way the page ends a token', () => {
  it('a denial burns it and tells the relay to close it', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mintAgent(h, socket, listed);
    const frame = agentRequest(h, minted);
    socket.deliver(frame);
    await checked(h, frame.requestId);
    expect(h.dock.deny(frame.requestId)).toBe(true);
    // The deny first, which the relay closes the token on as denied (S7); the
    // cancel after it changes nothing there unless the deny crossed the prompt's end.
    expect(
      socket
        .frames()
        .filter(
          (sent) =>
            (sent.t === 'attach_decision' && sent.requestId === frame.requestId) ||
            sent.t === 'agent_cancel',
        ),
    ).toEqual([
      { t: 'attach_decision', requestId: frame.requestId, allow: false },
      { t: 'agent_cancel', tokenId: minted.tokenId },
    ]);
    expect(h.storage.getItem(AGENTS_KEY)).toBeNull();
    // A request after that finds no record and is refused without a prompt.
    socket.deliver(agentRequest(h, minted, { requestId: 'again' }));
    await checked(h, 'again');
    expect(h.dock.state.pendingRequests).toEqual([]);
  });

  it('three prompts left to time out burn it; one only counts', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mintAgent(h, socket, listed, { label: 'x', lifetime: '8h' });
    for (let timeouts = 1; timeouts <= AGENT_BURN_TIMEOUTS; timeouts += 1) {
      // A short prompt, so its silence comes before the link's own silence timer.
      const frame = agentRequest(h, minted, {
        requestId: `ask-${String(timeouts)}`,
        expiresAt: h.clock.now + 1000,
      });
      socket.deliver(frame);
      await checked(h, frame.requestId);
      await h.clock.advance(1000);
      if (timeouts < AGENT_BURN_TIMEOUTS) {
        const stored = StoredAgentsSchema.parse(JSON.parse(h.storage.getItem(AGENTS_KEY) ?? ''));
        expect(stored.agents[0]?.timeouts).toBe(timeouts);
        expect(socket.framesOf('agent_cancel')).toEqual([]);
      }
    }
    // Silence is never sent as a refusal, which the relay would take for the
    // operator's deny and burn the token on: its own timer counts each one.
    expect(
      socket.framesOf('attach_decision').filter((frame) => frame.requestId.startsWith('ask-')),
    ).toEqual([]);
    expect(socket.framesOf('agent_cancel')).toEqual([
      { t: 'agent_cancel', tokenId: minted.tokenId },
    ]);
    expect(h.storage.getItem(AGENTS_KEY)).toBeNull();
  });

  it('revoking an agent cancels its token, and Revoke all forgets every one', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mintAgent(h, socket, listed);
    const other = await mintAgent(h, socket, listed);
    const frame = agentRequest(h, minted);
    socket.deliver(frame);
    await checked(h, frame.requestId);
    h.dock.approve(frame.requestId, 'observer');
    socket.deliver({
      t: 'roster',
      attachments: [
        attachment('alice', 'driver'),
        invitedAttachment(
          frame.user.userId,
          'observer',
          minted.tokenId,
          h.clock.now + HOUR,
          'agent',
        ),
      ],
    });
    await flush();
    expect(h.dock.revoke(frame.user.userId)).toBe(true);
    expect(socket.framesOf('agent_cancel')).toEqual([
      { t: 'agent_cancel', tokenId: minted.tokenId },
    ]);
    expect(h.dock.revoke('*')).toBe(true);
    expect(h.storage.getItem(AGENTS_KEY)).toBeNull();
    expect(socket.framesOf('agent_cancel').map((cancel) => cancel.tokenId)).not.toContain(
      other.tokenId,
    );
  });

  it('Cancel closes it; a token the relay lists unknown to the page is closed once; one it stops listing goes', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mintAgent(h, socket, listed);
    const kept = await mintAgent(h, socket, listed);
    expect(h.dock.cancelAgent(minted.tokenId)).toBe(true);
    expect(h.dock.cancelAgent(minted.tokenId)).toBe(false);
    expect(socket.framesOf('agent_cancel')).toEqual([
      { t: 'agent_cancel', tokenId: minted.tokenId },
    ]);
    const stranger = { ...listingOf(kept.create), tokenId: 'agt_stranger' };
    socket.deliver(agentsFrame([listingOf(kept.create), stranger]));
    socket.deliver(agentsFrame([listingOf(kept.create), stranger]));
    await flush();
    expect(socket.framesOf('agent_cancel').map((cancel) => cancel.tokenId)).toEqual([
      minted.tokenId,
      'agt_stranger',
    ]);
    socket.deliver(agentsFrame([]));
    await flush();
    expect(h.dock.state.agents).toEqual([]);
    expect(h.storage.getItem(AGENTS_KEY)).toBeNull();
  });

  it('Cancel while its prompt shows sends the cancel alone, never a deny the relay would close it on', async () => {
    const { h, socket, listed } = await offering();
    const minted = await mintAgent(h, socket, listed);
    const frame = agentRequest(h, minted);
    socket.deliver(frame);
    await checked(h, frame.requestId);
    expect(h.dock.state.pendingRequests).toHaveLength(1);
    expect(h.dock.cancelAgent(minted.tokenId)).toBe(true);
    expect(h.dock.state.pendingRequests).toEqual([]);
    expect(
      socket.framesOf('attach_decision').filter((sent) => sent.requestId === frame.requestId),
    ).toEqual([]);
    expect(socket.framesOf('agent_cancel')).toEqual([
      { t: 'agent_cancel', tokenId: minted.tokenId },
    ]);
  });

  it('keeps its records across a reload of the same page session, and none for another', async () => {
    const storage = new MapStorage();
    const first = setup({ storage, core: { policy: { invites: 'all' } } });
    const socket = await link(first);
    socket.deliver(agentsFrame([]));
    await flush();
    const minted = await mintAgent(first, socket, []);
    const reloaded = setup({ storage, core: { policy: { invites: 'all' } } });
    const again = await link(
      reloaded,
      { resumed: true, roster: [attachment('alice', 'driver')] },
      {},
    );
    again.deliver(agentsFrame([listingOf(minted.create)]));
    await flush();
    expect(reloaded.dock.state.agents.map((agent) => agent.tokenId)).toEqual([minted.tokenId]);
    const other = setup({ storage, core: { policy: { invites: 'all' } } });
    const fresh = await link(other, { pageId: 'page-2' }, {});
    fresh.deliver(agentsFrame([listingOf(minted.create)]));
    await flush();
    expect(other.dock.state.agents).toEqual([]);
    expect(fresh.framesOf('agent_cancel')).toEqual([
      { t: 'agent_cancel', tokenId: minted.tokenId },
    ]);
  });
});

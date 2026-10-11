// Proposals on the page's side (ADR 0042, A6.10, A6.11 and A6.13). The page
// takes a proposal frame only under its own policy and role rules, never
// from an agent token's caller (C13), and keeps it in memory alone; the
// operator's Accept is refused while paused, past its end and for an id it
// does not hold; and an invoke naming a proposal runs only against the
// page's own record of that Accept, for the same caller, tool and canonical
// arguments, once, within ACCEPTED_PROPOSAL_RUN_MS, its handler never run
// otherwise. A proposal ends with the roster, a revoke, the link and its own
// clock, each leaving its line in the proposal log.

import {
  ACCEPTED_PROPOSAL_RUN_MS,
  agentKeyInput,
  INVITEE_ID_PREFIX,
  type PolicyInput,
  PROPOSAL_TTL_MS,
  type RelayFrame,
} from '@tabdock/protocol';
import { describe, expect, it } from 'vitest';
import {
  attachment,
  flush,
  GRANTS_KEY,
  type Harness,
  invoke,
  link,
  MapStorage,
  results,
  runtimeTool,
  setup,
  sha256Hex,
  until,
} from './harness.ts';

type ProposalFrame = Extract<RelayFrame, { t: 'proposal' }>;

const BOB = { userId: 'bob', displayName: 'Bob', client: null, role: 'observer' } as const;

function proposal(h: Harness, overrides: Partial<ProposalFrame> = {}): ProposalFrame {
  return {
    t: 'proposal',
    proposalId: 'pr_1',
    tool: 'set_value',
    arguments: { value: 3, note: 'move to stop 3' },
    proposer: BOB,
    expiresAt: h.clock.now + PROPOSAL_TTL_MS,
    ...overrides,
  };
}

/** A page with the policy given, Alice driving and Bob watching. */
async function page(policy: PolicyInput = { proposals: 'members' }) {
  const h = setup({ core: { policy } });
  const socket = await link(h, {}, { alice: 'driver', bob: 'observer' });
  return { h, socket };
}

async function propose(h: Harness, frame: ProposalFrame): Promise<void> {
  h.socket().deliver(frame);
  await until(
    () =>
      h.dock.state.proposals.some((held) => held.proposalId === frame.proposalId) ||
      h
        .socket()
        .framesOf('proposal_decision')
        .some((sent) => sent.proposalId === frame.proposalId),
    'the page to take or refuse the proposal',
  );
}

/** Moves the clock on with the relay pinging, so the link stays up as it would. */
async function linkedFor(h: Harness, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 10_000) {
    h.socket().deliver({ t: 'ping' });
    await h.clock.advance(Math.min(10_000, left));
  }
}

function decisions(h: Harness) {
  return h.socket().framesOf('proposal_decision');
}

describe('taking a proposal (A6.10)', () => {
  it('holds a member observer’s proposal for the operator, its arguments as escaped text', async () => {
    const { h } = await page();
    await propose(h, proposal(h, { arguments: { note: 'pay ‮evil' } }));
    expect(decisions(h)).toEqual([]);
    expect(h.dock.state.proposals).toEqual([
      {
        proposalId: 'pr_1',
        tool: 'set_value',
        proposer: BOB,
        arguments: '{"note":"pay \\u202eevil"}',
        argumentChars: '{"note":"pay \\u202eevil"}'.length,
        consequential: false,
        receivedAt: h.clock.now,
        expiresAt: h.clock.now + PROPOSAL_TTL_MS,
      },
    ]);
    // Never in storage: a reload leaves nothing to accept (decision 12).
    for (const value of h.storage.items.values()) expect(value).not.toContain('pr_1');
  });

  it("refuses under 'off', the default, with the reason 'policy'", async () => {
    const { h } = await page({});
    await propose(h, proposal(h));
    expect(decisions(h)).toEqual([
      { t: 'proposal_decision', proposalId: 'pr_1', accept: false, refused: 'policy' },
    ]);
    expect(h.dock.state.proposals).toEqual([]);
  });

  it('refuses a driver, someone unlisted, a read-only or missing tool, and arguments past the caps', async () => {
    const { h } = await page();
    const cases: [ProposalFrame, string][] = [
      [proposal(h, { proposalId: 'pr_a', proposer: { ...BOB, userId: 'alice' } }), 'role'],
      [proposal(h, { proposalId: 'pr_b', proposer: { ...BOB, userId: 'carol' } }), 'role'],
      [proposal(h, { proposalId: 'pr_c', tool: 'get_value' }), 'tool'],
      [proposal(h, { proposalId: 'pr_d', tool: 'nothing' }), 'tool'],
      [proposal(h, { proposalId: 'pr_e', arguments: { v: 'x'.repeat(16_400) } }), 'too_large'],
    ];
    for (const [frame] of cases) await propose(h, frame);
    expect(decisions(h).map((sent) => [sent.proposalId, sent.refused])).toEqual(
      cases.map(([frame, refused]) => [frame.proposalId, refused]),
    );
  });

  it('refuses a fourth pending proposal from one user', async () => {
    const { h } = await page();
    for (const id of ['pr_1', 'pr_2', 'pr_3', 'pr_4']) {
      await propose(h, proposal(h, { proposalId: id }));
    }
    expect(h.dock.state.proposals.map((held) => held.proposalId)).toEqual(['pr_1', 'pr_2', 'pr_3']);
    expect(decisions(h)).toEqual([
      { t: 'proposal_decision', proposalId: 'pr_4', accept: false, refused: 'limit' },
    ]);
  });

  it('refuses a consequential tool under deny, and marks it under confirm', async () => {
    const denied = await page({ proposals: 'members', consequential: 'deny' });
    await propose(denied.h, proposal(denied.h, { tool: 'wipe' }));
    expect(decisions(denied.h)[0]?.refused).toBe('consequential');
    const asked = await page();
    await propose(asked.h, proposal(asked.h, { tool: 'wipe' }));
    expect(asked.h.dock.state.proposals[0]?.consequential).toBe(true);
  });

  it("refuses an invitee under 'members' and an agent token's caller even under 'all' (C13)", async () => {
    const tokenId = 'agt_0123456789';
    const agent = `${INVITEE_ID_PREFIX}${(await sha256Hex(agentKeyInput('page-1', tokenId))).slice(0, 32)}`;
    const guest = `${INVITEE_ID_PREFIX}${(await sha256Hex('a guest')).slice(0, 32)}`;
    const endsAt = Date.UTC(2026, 9, 2, 20, 0, 0);
    const made = { agent: tokenId, guest: 'inv_0123456789' };
    const stored = (inviteId: string) => ({
      role: 'observer',
      inviteId,
      endsAt,
      inviteRole: 'observer',
    });
    for (const proposals of ['members', 'all'] as const) {
      // An agent token's grant (ADR 0044) and an invite's, as their approvals
      // store them, read back on a reload into the same page session: both
      // listed observers, told apart only by how the page derives the agent's id.
      const storage = new MapStorage();
      storage.setItem(
        GRANTS_KEY,
        JSON.stringify({
          pageId: 'page-1',
          grants: { [agent]: stored(made.agent), [guest]: stored(made.guest) },
        }),
      );
      const h = setup({ storage, core: { policy: { proposals } } });
      const roster = [
        {
          ...attachment(agent, 'observer'),
          kind: 'invitee' as const,
          inviteId: made.agent,
          endsAt,
        },
        {
          ...attachment(guest, 'observer'),
          kind: 'invitee' as const,
          inviteId: made.guest,
          endsAt,
        },
      ];
      await link(h, { resumed: true, roster }, {});
      expect(h.dock.state.pageRoles.map((role) => role.role)).toEqual(['observer', 'observer']);
      const proposer = (userId: string) => ({ ...BOB, userId, displayName: userId.slice(0, 8) });
      await propose(h, proposal(h, { proposalId: 'pr_agent', proposer: proposer(agent) }));
      await propose(h, proposal(h, { proposalId: 'pr_guest', proposer: proposer(guest) }));
      expect(
        decisions(h).map((sent) => [sent.proposalId, sent.refused]),
        proposals,
      ).toEqual(
        proposals === 'all'
          ? [['pr_agent', 'role']]
          : [
              ['pr_agent', 'role'],
              ['pr_guest', 'policy'],
            ],
      );
      expect(h.dock.state.proposals.map((held) => held.proposalId)).toEqual(
        proposals === 'all' ? ['pr_guest'] : [],
      );
    }
  });
});

describe('the operator decides (A6.11)', () => {
  it('accepts with a decision frame, and the proposal leaves the queue', async () => {
    const { h } = await page();
    await propose(h, proposal(h));
    expect(h.dock.acceptProposal('pr_1')).toBe(true);
    expect(decisions(h)).toEqual([{ t: 'proposal_decision', proposalId: 'pr_1', accept: true }]);
    expect(h.dock.state.proposals).toEqual([]);
    // Spent: a second Accept, or a Dismiss after it, does nothing.
    expect(h.dock.acceptProposal('pr_1')).toBe(false);
    expect(h.dock.dismissProposal('pr_1')).toBe(false);
  });

  it('accepts nothing while paused, past its end, or for an id it does not hold', async () => {
    const { h } = await page();
    await propose(h, proposal(h));
    h.dock.pause(true);
    expect(h.dock.acceptProposal('pr_1')).toBe(false);
    h.dock.pause(false);
    expect(h.dock.acceptProposal('pr_unknown')).toBe(false);
    expect(h.dock.acceptProposal(undefined as unknown as string)).toBe(false);
    await linkedFor(h, PROPOSAL_TTL_MS);
    expect(h.dock.acceptProposal('pr_1')).toBe(false);
    expect(decisions(h)).toEqual([]);
    expect(h.dock.state.proposalLog.map((entry) => entry.outcome)).toEqual(['expired']);
  });

  it('dismisses one, or every one at once', async () => {
    const { h } = await page();
    for (const id of ['pr_1', 'pr_2', 'pr_3']) await propose(h, proposal(h, { proposalId: id }));
    expect(h.dock.dismissProposal('pr_2')).toBe(true);
    expect(h.dock.dismissAllProposals()).toBe(2);
    expect(decisions(h)).toEqual(
      ['pr_2', 'pr_1', 'pr_3'].map((proposalId) => ({
        t: 'proposal_decision',
        proposalId,
        accept: false,
      })),
    );
    expect(h.dock.state.proposalLog.map((entry) => entry.outcome)).toEqual([
      'dismissed',
      'dismissed',
      'dismissed',
    ]);
  });

  it("runs the accepted call's own arguments, marks it accepted, and asks nothing for a consequential one", async () => {
    const { h, socket } = await page();
    await propose(h, proposal(h, { tool: 'wipe', arguments: { b: 2, a: 1 } }));
    h.dock.acceptProposal('pr_1');
    // The relay's copy, its keys in another order: the same canonical arguments.
    socket.deliver(
      invoke('wipe', {
        callId: 'call-9',
        caller: BOB,
        arguments: { a: 1, b: 2 },
        proposal: { proposalId: 'pr_1' },
      }),
    );
    await until(() => results(socket).length === 1, 'the result');
    expect(results(socket)[0]).toMatchObject({ callId: 'call-9', ok: true });
    expect(h.dock.state.pendingConfirms).toEqual([]);
    expect(h.context.runs).toEqual([
      expect.objectContaining({ tool: 'wipe', args: { b: 2, a: 1 } }),
    ]);
    expect(h.dock.state.activity[0]).toMatchObject({
      callId: 'call-9',
      proposalId: 'pr_1',
      acceptedOnPage: true,
      outcome: 'ok',
    });
    expect(h.dock.state.proposalLog[0]).toMatchObject({
      proposalId: 'pr_1',
      outcome: 'accepted',
      callId: 'call-9',
    });
  });

  it('logs an Accept no invoke binds within ACCEPTED_PROPOSAL_RUN_MS as not run', async () => {
    const { h } = await page();
    await propose(h, proposal(h));
    h.dock.acceptProposal('pr_1');
    await linkedFor(h, ACCEPTED_PROPOSAL_RUN_MS);
    expect(h.dock.state.proposalLog[0]).toMatchObject({ outcome: 'not_run', callId: null });
  });

  it('ends a proposal as the relay says, and an accepted one it could not run as not run', async () => {
    const { h, socket } = await page();
    for (const id of ['pr_1', 'pr_2', 'pr_3']) await propose(h, proposal(h, { proposalId: id }));
    h.dock.acceptProposal('pr_3');
    socket.deliver({ t: 'proposal_end', proposalId: 'pr_1', reason: 'withdrawn' });
    socket.deliver({ t: 'proposal_end', proposalId: 'pr_2', reason: 'attachment_ended' });
    socket.deliver({ t: 'proposal_end', proposalId: 'pr_3', reason: 'not_run' });
    socket.deliver({ t: 'proposal_end', proposalId: 'pr_none', reason: 'expired' });
    await flush();
    expect(h.dock.state.proposalLog.map((entry) => [entry.proposalId, entry.outcome])).toEqual([
      ['pr_3', 'not_run'],
      ['pr_2', 'cancelled'],
      ['pr_1', 'withdrawn'],
    ]);
  });
});

describe('what ends a proposal on the page', () => {
  it('expires it on its own clock, whatever the relay said', async () => {
    const { h } = await page();
    await propose(h, proposal(h, { expiresAt: h.clock.now + PROPOSAL_TTL_MS * 2 }));
    expect(h.dock.state.proposals[0]?.expiresAt).toBe(h.clock.now + PROPOSAL_TTL_MS);
    await linkedFor(h, PROPOSAL_TTL_MS);
    expect(h.dock.state.proposals).toEqual([]);
    expect(h.dock.state.proposalLog[0]?.outcome).toBe('expired');
  });

  it('cancels a proposal whose proposer the roster drops, or the operator revokes', async () => {
    const { h, socket } = await page();
    await propose(h, proposal(h));
    socket.deliver({ t: 'roster', attachments: [attachment('alice', 'driver')] });
    await flush();
    expect(h.dock.state.proposals).toEqual([]);
    const again = await page();
    await propose(again.h, proposal(again.h));
    expect(again.h.dock.revoke('bob')).toBe(true);
    expect(again.h.dock.state.proposals).toEqual([]);
    expect(again.h.dock.state.proposalLog[0]?.outcome).toBe('cancelled');
  });

  it('cancels every proposal, accepted or not, when the link goes, so nothing is left to accept or bind', async () => {
    const { h, socket } = await page();
    await propose(h, proposal(h, { proposalId: 'pr_1' }));
    await propose(h, proposal(h, { proposalId: 'pr_2' }));
    h.dock.acceptProposal('pr_2');
    socket.drop();
    await flush();
    expect(h.dock.state.proposals).toEqual([]);
    expect(h.dock.state.proposalLog.map((entry) => entry.outcome)).toEqual([
      'cancelled',
      'cancelled',
    ]);
  });
});

describe('crafted invokes (A6.13, S5)', () => {
  /** An accepted proposal pr_1 of set_value by Bob, and a socket to send invokes on. */
  async function accepted(policy?: PolicyInput) {
    const { h, socket } = await page(policy);
    await propose(h, proposal(h));
    expect(h.dock.acceptProposal('pr_1')).toBe(true);
    return { h, socket };
  }

  const right = {
    callId: 'call-1',
    caller: BOB,
    arguments: { value: 3, note: 'move to stop 3' },
    proposal: { proposalId: 'pr_1' },
  };

  async function refusedUnrun(
    h: Harness,
    frame: RelayFrame,
    code: string = 'role_denied',
  ): Promise<void> {
    const socket = h.socket();
    const before = results(socket).length;
    socket.deliver(frame);
    await until(() => results(socket).length > before, 'an answer');
    expect(results(socket).at(-1)).toMatchObject({ ok: false, error: { code } });
    expect(h.context.runs).toEqual([]);
  }

  it('refuses one naming a proposal the page never received, or never accepted', async () => {
    const { h } = await page();
    await refusedUnrun(h, invoke('set_value', right));
    await propose(h, proposal(h));
    await refusedUnrun(h, invoke('set_value', { ...right, callId: 'call-2' }));
    // Not even for a driver, who could run the write without one: the claim itself is refused.
    const alice = { userId: 'alice', displayName: 'Alice', client: null, role: 'driver' } as const;
    await refusedUnrun(h, invoke('set_value', { ...right, callId: 'call-3', caller: alice }));
    expect(results(h.socket()).map((sent) => sent.error?.message)).toEqual([
      'the page holds no accepted proposal for this call',
      'the page holds no accepted proposal for this call',
      'the page holds no accepted proposal for this call',
    ]);
  });

  it('refuses changed arguments, another caller and another tool', async () => {
    for (const changed of [
      { arguments: { value: 4, note: 'move to stop 3' } },
      { caller: { ...BOB, userId: 'alice', displayName: 'Alice' } },
    ]) {
      const { h } = await accepted();
      await refusedUnrun(h, invoke('set_value', { ...right, ...changed }));
    }
    const { h } = await accepted();
    await refusedUnrun(h, invoke('wipe', right));
  });

  it('runs it once: a replay under the same proposal is refused', async () => {
    const { h, socket } = await accepted();
    socket.deliver(invoke('set_value', right));
    await until(() => results(socket).length === 1, 'the first answer');
    expect(results(socket)[0]).toMatchObject({ ok: true });
    socket.deliver(invoke('set_value', { ...right, callId: 'call-2' }));
    await until(() => results(socket).length === 2, 'the replay answer');
    expect(results(socket)[1]).toMatchObject({ ok: false, error: { code: 'role_denied' } });
    expect(h.context.runs).toHaveLength(1);
  });

  it('refuses one past ACCEPTED_PROPOSAL_RUN_MS after the Accept', async () => {
    const { h } = await accepted();
    await linkedFor(h, ACCEPTED_PROPOSAL_RUN_MS + 1000);
    await refusedUnrun(h, invoke('set_value', right));
  });

  it('refuses one past the window even before a throttled timer ends the Accept', async () => {
    // A background tab may run its timers late; the clock still says the window closed.
    const { h } = await accepted();
    h.clock.now += ACCEPTED_PROPOSAL_RUN_MS + 1;
    await refusedUnrun(h, invoke('set_value', right));
  });

  it("refuses an observer's write that names no proposal, as before", async () => {
    const { h } = await page();
    await refusedUnrun(h, invoke('set_value', { caller: BOB, arguments: { value: 1 } }));
  });

  it('refuses a bound call under deny once its tool is listed consequential, its handler never run', async () => {
    const { h } = await accepted({ proposals: 'members', consequential: 'deny' });
    // The page re-lists set_value as consequential after the Accept.
    h.context.tools = h.context.tools.map((tool) =>
      tool.name === 'set_value'
        ? runtimeTool('set_value', {
            consequentialHint: true,
            readOnlyHint: false,
            untrustedContentHint: false,
          })
        : tool,
    );
    await refusedUnrun(h, invoke('set_value', right), 'denied_by_operator');
  });
});

describe('under a time-boxed session (ADR 0042 meeting ADR 0043)', () => {
  /**
   * Starts a session that takes no proposals, as the widget's form would,
   * and returns before the relay hears more than its session_start: the
   * narrowing holds on the page first, as its demotions do (S5).
   */
  async function narrowing(h: Harness) {
    const socket = h.socket();
    socket.deliver({ t: 'session', session: null });
    await flush();
    const pending = h.dock.startSession({ label: 'Class', lengthMinutes: 30, proposals: 'off' });
    const [start] = socket.framesOf('session_start');
    if (start === undefined) throw new Error('no session_start');
    return {
      start,
      async listed(): Promise<void> {
        socket.deliver({
          t: 'session',
          session: {
            sessionId: start.sessionId,
            lengthMs: start.lengthMs,
            remainingMs: start.lengthMs,
            policy: start.policy,
          },
        });
        expect((await pending).ok).toBe(true);
      },
    };
  }

  it('cancels the pending proposals it no longer takes at its start, before the relay says', async () => {
    const { h, socket } = await page();
    await propose(h, proposal(h));
    const { start, listed } = await narrowing(h);
    expect(start.policy.proposals).toBe('off');
    expect(h.dock.state.proposals).toEqual([]);
    expect(h.dock.state.proposalLog[0]).toMatchObject({ proposalId: 'pr_1', outcome: 'cancelled' });
    // Nothing is left to accept, and the relay's proposal_end later changes nothing.
    expect(h.dock.acceptProposal('pr_1')).toBe(false);
    await listed();
    socket.deliver({ t: 'proposal_end', proposalId: 'pr_1', reason: 'policy' });
    await flush();
    expect(h.dock.state.proposalLog).toHaveLength(1);
    expect(decisions(h)).toEqual([]);
  });

  it('cancels them too when the relay lists the session narrower than the page asked', async () => {
    const { h, socket } = await page();
    await propose(h, proposal(h));
    socket.deliver({ t: 'session', session: null });
    await flush();
    const pending = h.dock.startSession({ label: 'Class', lengthMinutes: 30 });
    const [start] = socket.framesOf('session_start');
    if (start === undefined) throw new Error('no session_start');
    expect(start.policy.proposals).toBe('members');
    expect(h.dock.state.proposals).toHaveLength(1);
    socket.deliver({
      t: 'session',
      session: {
        sessionId: start.sessionId,
        lengthMs: start.lengthMs,
        remainingMs: start.lengthMs,
        policy: { ...start.policy, proposals: 'off' },
      },
    });
    expect((await pending).ok).toBe(true);
    expect(h.dock.state.proposals).toEqual([]);
    expect(h.dock.state.proposalLog[0]).toMatchObject({ proposalId: 'pr_1', outcome: 'cancelled' });
  });

  it('refuses an invoke bound to an Accept made before a session narrowed proposals, its handler never run', async () => {
    const { h, socket } = await page();
    await propose(h, proposal(h));
    expect(h.dock.acceptProposal('pr_1')).toBe(true);
    const { listed } = await narrowing(h);
    await listed();
    const before = results(socket).length;
    socket.deliver(
      invoke('set_value', {
        callId: 'call-1',
        caller: BOB,
        arguments: { value: 3, note: 'move to stop 3' },
        proposal: { proposalId: 'pr_1' },
      }),
    );
    await until(() => results(socket).length > before, 'an answer');
    expect(results(socket).at(-1)).toMatchObject({
      ok: false,
      error: { code: 'role_denied', message: 'the page holds no accepted proposal for this call' },
    });
    expect(h.context.runs).toEqual([]);
  });
});

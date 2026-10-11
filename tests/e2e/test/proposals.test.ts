// Proposals end to end (ADR 0042, A6.10 and A6.11): a real relay, the real
// adapter core on a sim page and an SDK client on each revision. An
// observer's write answers proposed and the page lists it; the operator's
// Accept runs it once, and the proposer's get_proposal, waiting, answers the
// Accept and then the labelled result; the run's audit line names the proposer, accepted on the
// page, with the very call id the page's activity log shows; an accepted
// consequential call raises no second prompt; and under deny a proposal for
// a consequential tool is refused at once, the page never hearing of it.

import { untrustedHeader } from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { getProposal, propose, settledProposal } from '../src/proposal-helpers.ts';
import {
  attachAs,
  callTool,
  SIM_TOOL_COUNT,
  startWorld,
  waitForTools,
  type World,
} from './helpers.ts';

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

const LEGS = [
  ['2025-era', false],
  ['2026-07-28', true],
] as const;

describe('A6.10 and A6.11: a proposal from an observer, accepted on the page', () => {
  it.each(LEGS)(
    'on the %s leg: proposed, accepted, run once, and read back behind its label',
    async (_, modern) => {
      world = await startWorld();
      const page = await world.page({ policy: { proposals: 'members' } });
      const bob = await world.client(world.bob, 'bob-laptop', { modern });
      const pageId = await attachAs(bob, page, 'observer');
      await waitForTools(bob, pageId, SIM_TOOL_COUNT);

      const listed = await callTool(bob, 'list_page_tools', { page: pageId });
      const setValue = (
        listed.structured as { tools: { name: string; proposable?: boolean }[] }
      ).tools.find((tool) => tool.name === 'set_value');
      expect(setValue?.proposable).toBe(true);

      const { answer, proposalId } = await propose(bob, pageId, 'set_value', {
        value: 'proposed by Bob',
      });
      expect(answer.isError, answer.text).toBe(false);
      expect(answer.head).toBe('proposed');
      if (proposalId === null) throw new Error('no proposal id');
      const shown = await page.waitFor((s) => s.proposals.length === 1);
      expect(shown.proposals[0]).toMatchObject({
        proposalId,
        tool: 'set_value',
        proposer: { userId: 'bob', role: 'observer' },
        arguments: '{"value":"proposed by Bob"}',
      });
      expect(page.store.calls).toEqual([]);

      const waiting = getProposal(bob, pageId, proposalId, 30_000);
      expect(page.acceptProposal(proposalId)).toBe(true);
      // A wait answers each change: the Accept, or the run's end where the
      // Accept reached the relay before the wait did.
      expect((await waiting).head).toBe('accepted');
      const read = await settledProposal(bob, pageId, proposalId);
      expect(read.isError, read.text).toBe(false);
      expect(read.text.split('\n').slice(0, 2)).toEqual([
        `accepted: the operator accepted proposal ${proposalId} for tool set_value, and the page ran it.`,
        untrustedHeader(page.url.slice(0, page.url.indexOf('/', 8)), 'set_value'),
      ]);
      expect(read.structuredContent).toBeUndefined();
      expect(page.store.value).toBe('proposed by Bob');
      expect(page.store.calls.map((call) => call.tool)).toEqual(['set_value']);

      // The page's log and the relay's audit name one call, run as the proposer, accepted here.
      const [entry] = page.activity;
      expect(entry).toMatchObject({ proposalId, acceptedOnPage: true, outcome: 'ok' });
      const lines = world.relay.audit.records().filter((line) => line.proposalId === proposalId);
      expect(lines.map((line) => [line.userId, line.outcome, line.acceptedOnPage])).toEqual([
        ['bob', 'proposed', undefined],
        ['bob', 'ok', true],
      ]);
      expect(lines[1]?.callId).toBe(entry?.callId);
      expect(page.state.proposalLog[0]).toMatchObject({
        proposalId,
        outcome: 'accepted',
        callId: entry?.callId,
      });
    },
  );

  it('runs an accepted consequential tool under confirm with no second prompt', async () => {
    world = await startWorld();
    const page = await world.page({ policy: { proposals: 'members', consequential: 'confirm' } });
    const bob = await world.client(world.bob, 'bob-laptop');
    const pageId = await attachAs(bob, page, 'observer');
    await waitForTools(bob, pageId, SIM_TOOL_COUNT);
    const { proposalId } = await propose(bob, pageId, 'wipe');
    if (proposalId === null) throw new Error('no proposal id');
    const shown = await page.waitFor((s) => s.proposals.length === 1);
    expect(shown.proposals[0]?.consequential).toBe(true);
    expect(page.acceptProposal(proposalId)).toBe(true);
    const read = await settledProposal(bob, pageId, proposalId);
    expect(read.head).toBe('accepted');
    expect(page.store.calls.map((call) => call.tool)).toEqual(['wipe']);
    expect(page.prompts).toEqual([]);
  });

  it('refuses a proposal for a consequential tool at once under deny', async () => {
    world = await startWorld();
    const page = await world.page({ policy: { proposals: 'members', consequential: 'deny' } });
    const bob = await world.client(world.bob, 'bob-laptop');
    const pageId = await attachAs(bob, page, 'observer');
    await waitForTools(bob, pageId, SIM_TOOL_COUNT);
    const { answer } = await propose(bob, pageId, 'wipe');
    expect(answer.text).toBe(
      'denied_by_operator: this page runs no consequential tools, so it takes no proposal for wipe',
    );
    expect(page.state.proposals).toEqual([]);
    // A write that is not consequential is still a proposal.
    expect((await propose(bob, pageId, 'set_value', { value: 'one' })).answer.head).toBe(
      'proposed',
    );
  });

  it('answers role_denied as before on a page that takes no proposals, and Dismiss ends one with its line', async () => {
    world = await startWorld();
    const off = await world.page();
    const bob = await world.client(world.bob, 'bob-laptop');
    const offId = await attachAs(bob, off, 'observer');
    await waitForTools(bob, offId, SIM_TOOL_COUNT);
    expect((await propose(bob, offId, 'set_value', { value: 'one' })).answer.text).toBe(
      'role_denied: you are an observer on this page, and set_value is not marked read-only',
    );

    const on = await world.page({ policy: { proposals: 'members' } });
    const onId = await attachAs(bob, on, 'observer');
    await waitForTools(bob, onId, SIM_TOOL_COUNT);
    const { proposalId } = await propose(bob, onId, 'set_value', { value: 'two' });
    if (proposalId === null) throw new Error('no proposal id');
    await on.waitFor((s) => s.proposals.length === 1);
    expect(on.dismissProposal(proposalId)).toBe(true);
    expect((await getProposal(bob, onId, proposalId)).head).toBe('dismissed');
    expect(
      world.relay.audit
        .events()
        .filter((event) => event.type === 'proposal_closed')
        .map((event) => [event.proposalId, event.reason]),
    ).toEqual([[proposalId, 'dismissed']]);
    expect(on.store.calls).toEqual([]);
  });
});

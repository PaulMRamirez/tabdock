// The answers of get_proposal and withdraw_proposal (ADR 0042), their
// arguments already checked and their request already counted in mcp.ts. A
// proposal's status is the relay's own words with structuredContent; an
// accepted run's result is page text, so it travels only as labelled text
// behind untrustedHeader, never as structuredContent (S10). Relay words come
// first, the label next, and the page's text last, so nothing the page wrote
// stands where the relay speaks. An image the run returned is never kept
// (decision 15): a relay line says so, ahead of the label.

import type { CallToolResult } from '@modelcontextprotocol/server';
import { formatError, untrustedHeader } from '@tabdock/protocol';
import type { ProposalAnswer } from './hub.ts';
import type { FixedToolRequest } from './state-tools.ts';

export type GetProposalTool = (
  request: FixedToolRequest,
  args: { page: string; proposal: string; waitMs: number },
) => Promise<CallToolResult>;

export type WithdrawProposalTool = (
  request: FixedToolRequest,
  args: { page: string; proposal: string },
) => CallToolResult | Promise<CallToolResult>;

type Found = Extract<ProposalAnswer, { kind: 'proposal' }>;

/** The relay's line for a proposal as it stands. */
function statusLine(answer: Found): string {
  const { proposalId: id, tool } = answer;
  const notRun = 'the page did not run it';
  switch (answer.status) {
    case 'pending':
      return `pending: proposal ${id} for tool ${tool} waits for the page's operator to accept or dismiss it, until ${new Date(answer.expiresAt ?? 0).toISOString()}.`;
    case 'accepted':
      switch (answer.outcome) {
        case undefined:
        case 'running':
          return `accepted: the operator accepted proposal ${id} for tool ${tool}, and the page is running it; call get_proposal again for its result.`;
        case 'ok':
          return `accepted: the operator accepted proposal ${id} for tool ${tool}, and the page ran it.`;
        case 'tool_error':
          return `accepted: the operator accepted proposal ${id} for tool ${tool}, and the page ran it; the tool reported an error.`;
        default:
          return `accepted: the operator accepted proposal ${id} for tool ${tool}, but it did not run: ${answer.outcome}.`;
      }
    case 'dismissed':
      return `dismissed: the page's operator dismissed proposal ${id} for tool ${tool}; ${notRun}.`;
    case 'refused':
      return `refused: the page would not take proposal ${id} for tool ${tool} under its own policy, limits or tools; ${notRun}.`;
    case 'expired':
      return `expired: nobody decided on proposal ${id} for tool ${tool} in time; ${notRun}.`;
    case 'withdrawn':
      return `withdrawn: you withdrew proposal ${id} for tool ${tool}; ${notRun}.`;
    case 'cancelled':
      return `cancelled: proposal ${id} for tool ${tool} ended before anyone decided, as the page went away or reloaded, your attachment ended, or the page stopped taking proposals from you; ${notRun}.`;
  }
}

/** The answer for one proposal, or a relay refusal in its own words. */
export function proposalResult(answer: ProposalAnswer): CallToolResult {
  if (answer.kind === 'error') {
    return {
      content: [{ type: 'text', text: formatError(answer.code, answer.message) }],
      isError: true,
    };
  }
  const line = statusLine(answer);
  const ran = answer.outcome === 'ok' || answer.outcome === 'tool_error';
  if (ran && answer.result !== undefined) {
    const image = answer.image
      ? '\n[tabdock: the page also returned an image, which proposals never keep]'
      : '';
    return {
      content: [
        {
          type: 'text',
          text: `${line}${image}\n${untrustedHeader(answer.origin, answer.tool)}\n${answer.result.text}`,
        },
      ],
    };
  }
  const note = !ran
    ? ''
    : answer.dropped
      ? ' Its result is no longer held: the relay keeps results for a while only.'
      : ' It returned no text.';
  return {
    content: [{ type: 'text', text: `${line}${note}` }],
    structuredContent: {
      page: answer.pageId,
      proposal: answer.proposalId,
      status: answer.status,
      ...(answer.outcome === undefined ? {} : { outcome: answer.outcome }),
      ...(answer.expiresAt === undefined ? {} : { expiresAt: answer.expiresAt }),
    },
  };
}

export const getProposal: GetProposalTool = async ({ hub, who, signal, heldBytes }, args) =>
  proposalResult(
    await hub.getProposal(who, args.page, args.proposal, args.waitMs, signal, heldBytes),
  );

export const withdrawProposal: WithdrawProposalTool = ({ hub, who }, args) =>
  proposalResult(hub.withdrawProposal(who, args.page, args.proposal));

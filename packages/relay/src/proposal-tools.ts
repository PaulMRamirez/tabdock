// The answers of get_proposal and withdraw_proposal (ADR 0042), their
// arguments already checked and their request already counted in mcp.ts. A
// proposal's status is the relay's own words with structuredContent; an
// accepted run's result is page text, so it travels only as labelled text
// behind untrustedHeader, never as structuredContent (S10).

import type { CallToolResult } from '@modelcontextprotocol/server';
import type { FixedToolRequest } from './state-tools.ts';

export type GetProposalTool = (
  request: FixedToolRequest,
  args: { page: string; proposal: string; waitMs: number },
) => Promise<CallToolResult>;

export type WithdrawProposalTool = (
  request: FixedToolRequest,
  args: { page: string; proposal: string },
) => CallToolResult | Promise<CallToolResult>;

export const getProposal: GetProposalTool = async () => {
  // M6 seam: not built. Thrown, so the dispatcher answers an isError result in these words.
  await Promise.resolve();
  throw new Error('M6 seam: not built');
};

export const withdrawProposal: WithdrawProposalTool = () => {
  // M6 seam: not built. Thrown, so the dispatcher answers an isError result in these words.
  throw new Error('M6 seam: not built');
};

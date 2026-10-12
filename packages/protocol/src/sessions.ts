// A time-boxed session's policy against the page's ceiling (ADR 0043). The
// page's attach() policy is the ceiling; a session may narrow two of its
// fields, maxDrivers and proposals, and never widen either. The relay and the
// adapter both call these, so the two sides can never order the proposal
// values differently or clamp a field one way and not the other.

import type { Policy, ProposalPolicy, SessionPolicy } from './page-link.ts';

/** Proposal policies from narrowest to widest. */
export const PROPOSALS_ORDER = [
  'off',
  'members',
  'all',
] as const satisfies readonly ProposalPolicy[];

function width(policy: ProposalPolicy): number {
  return PROPOSALS_ORDER.indexOf(policy);
}

/** Whether a session's policy stays within the ceiling, field by field. */
export function withinCeiling(ceiling: Policy, wanted: SessionPolicy): boolean {
  return (
    wanted.maxDrivers <= ceiling.maxDrivers && width(wanted.proposals) <= width(ceiling.proposals)
  );
}

/**
 * The policy in force: a copy of the ceiling with each session field taken as
 * the narrower of the two, or the ceiling itself (copied) with no session. A
 * smaller ceiling after a reload therefore narrows a live session too.
 */
export function narrowPolicy(ceiling: Policy, session: SessionPolicy | null): Policy {
  const policy: Policy = {
    ...ceiling,
    consequentialTools: [...ceiling.consequentialTools],
    imageTools: [...ceiling.imageTools],
  };
  if (session === null) return policy;
  policy.maxDrivers = Math.min(ceiling.maxDrivers, session.maxDrivers);
  if (width(session.proposals) < width(ceiling.proposals)) policy.proposals = session.proposals;
  return policy;
}

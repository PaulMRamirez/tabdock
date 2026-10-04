// The board's page policy (SPEC.md section 8), from its query. clear_board is
// always listed as consequential, because the MCP-B polyfill drops
// consequentialHint (ADR 0002) and it must still prompt here.
//
// From M4, ?invites picks how far the operator may share the board by invite
// (ADR 0016): `all` offers Can control invites beside Can watch ones and gives
// the board two driver seats, so a guest with control can drive beside the
// operator's own client; `off` offers none; anything else, or nothing, keeps
// the adapter's default, Can watch only.

import type { PolicyInput } from '@tabdock/adapter';

export const DEMO_CONSEQUENTIAL_TOOLS = ['clear_board'];

/** Driver seats under ?invites=all: the operator's own client and one guest. */
export const DEMO_SHARED_DRIVERS = 2;

export function policyFromQuery(params: URLSearchParams): PolicyInput {
  const policy: PolicyInput = { consequentialTools: [...DEMO_CONSEQUENTIAL_TOOLS] };
  const invites = params.get('invites');
  if (invites === 'all') return { ...policy, invites: 'all', maxDrivers: DEMO_SHARED_DRIVERS };
  if (invites === 'off') return { ...policy, invites: 'off' };
  return policy;
}

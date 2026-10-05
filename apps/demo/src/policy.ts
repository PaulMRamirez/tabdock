// The board's page policy (SPEC.md section 8), from its query. clear_board is
// always listed as consequential, because the MCP-B polyfill drops
// consequentialHint (ADR 0002) and it must still prompt here.
//
// From M4, ?invites picks how far the operator may share the board by invite
// (ADR 0016): `all` offers Can control invites beside Can watch ones and gives
// the board two driver seats, so a guest with control can drive beside the
// operator's own client; `off` offers none; anything else, or nothing, keeps
// the adapter's default, Can watch only.
//
// From M5, ?confirm=client lets a member driver whose attachment no invite
// made confirm clear_board in their own MCP client instead of on the board
// (ADR 0026); the adapter still prompts here for everyone else. Anything
// else, or nothing, keeps the adapter's default, the board's own prompt.

import type { PolicyInput } from '@tabdock/adapter';

export const DEMO_CONSEQUENTIAL_TOOLS = ['clear_board'];

/** Driver seats under ?invites=all: the operator's own client and one guest. */
export const DEMO_SHARED_DRIVERS = 2;

export function policyFromQuery(params: URLSearchParams): PolicyInput {
  const policy: PolicyInput = { consequentialTools: [...DEMO_CONSEQUENTIAL_TOOLS] };
  if (params.get('confirm') === 'client') policy.confirmVia = 'client';
  const invites = params.get('invites');
  if (invites === 'all') return { ...policy, invites: 'all', maxDrivers: DEMO_SHARED_DRIVERS };
  if (invites === 'off') return { ...policy, invites: 'off' };
  return policy;
}

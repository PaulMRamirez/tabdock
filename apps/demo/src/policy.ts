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
//
// Whoever writes a link writes these too, so the board never takes them on
// trust (ADR 0029's notes): the Connect bar names every one that departs from
// the defaults before its visitor chooses, the status area names them once
// linked, and the remembered choice covers them, so a link that changes them
// asks again (connect.ts).

import type { PolicyInput } from '@tabdock/adapter';

export const DEMO_CONSEQUENTIAL_TOOLS = ['clear_board'];

/** Driver seats under ?invites=all: the operator's own client and one guest. */
export const DEMO_SHARED_DRIVERS = 2;

/** The policy choices a link can make, each read strictly; anything else is the default. */
export interface LinkPolicy {
  /** ?confirm=client */
  readonly confirmInClient: boolean;
  /** ?invites=all or ?invites=off; `watch` is the adapter's default. */
  readonly invites: 'watch' | 'all' | 'off';
}

export const DEFAULT_LINK_POLICY: LinkPolicy = Object.freeze({
  confirmInClient: false,
  invites: 'watch',
});

export function linkPolicyFromQuery(params: URLSearchParams): LinkPolicy {
  const invites = params.get('invites');
  return {
    confirmInClient: params.get('confirm') === 'client',
    invites: invites === 'all' || invites === 'off' ? invites : 'watch',
  };
}

export function policyInput(link: LinkPolicy): PolicyInput {
  const policy: PolicyInput = { consequentialTools: [...DEMO_CONSEQUENTIAL_TOOLS] };
  if (link.confirmInClient) policy.confirmVia = 'client';
  if (link.invites === 'all') return { ...policy, invites: 'all', maxDrivers: DEMO_SHARED_DRIVERS };
  if (link.invites === 'off') return { ...policy, invites: 'off' };
  return policy;
}

export function policyFromQuery(params: URLSearchParams): PolicyInput {
  return policyInput(linkPolicyFromQuery(params));
}

/**
 * The link's policy as the query parameters that set it, in one order, or ''
 * for the defaults; the remembered choice is keyed on it (connect.ts).
 */
export function policyTag(link: LinkPolicy): string {
  const parts: string[] = [];
  if (link.confirmInClient) parts.push('confirm=client');
  if (link.invites !== 'watch') parts.push(`invites=${link.invites}`);
  return parts.join('&');
}

/** Sets exactly the parameters that carry this policy, removing any others for it. */
export function setPolicyParams(params: URLSearchParams, link: LinkPolicy): void {
  params.delete('confirm');
  params.delete('invites');
  if (link.confirmInClient) params.set('confirm', 'client');
  if (link.invites !== 'watch') params.set('invites', link.invites);
}

/**
 * Each way the policy departs from the defaults, in words for the person at
 * the tab, or '' when it departs in none.
 */
export function policyNotes(link: LinkPolicy): string {
  const notes: string[] = [];
  if (link.confirmInClient) {
    notes.push(
      `members you approve confirm ${DEMO_CONSEQUENTIAL_TOOLS.join(', ')} in their own MCP client, not on this board`,
    );
  }
  if (link.invites === 'all') {
    notes.push('the board offers Can control invites and a second driver seat');
  }
  if (link.invites === 'off') notes.push('the board offers no invites');
  return notes.length === 0 ? '' : `${notes.join('; ')}.`;
}

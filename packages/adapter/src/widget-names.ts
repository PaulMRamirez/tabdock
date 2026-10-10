// The names the widget puts on its nodes for browser tests and for the
// `@tabdock/adapter/testing` helper (ADR 0041): its host element's tag, every
// data-action a button or input carries and every data-role a block or line
// carries. They live here, free of the DOM, so a helper that drives the widget
// through the DevTools protocol imports the very names the widget sets; the
// widget sets them only through typed helpers, so a typo, or a new button left
// out of these lists, fails tsc rather than a browser test much later. The M6
// names (ADRs 0040 to 0045) are listed from the foundation on, so each
// workstream adds its controls without touching these lists.

/** A valid custom element name needs no registration to host a shadow root, so nothing is defined globally. */
export const HOST_TAG = 'tabdock-dock';

/** Every data-action the widget sets: what a click or an edit on that node does. */
export const WIDGET_ACTIONS = [
  // Prompts, the badge and the pairing block
  'approve-driver',
  'approve-observer',
  'deny',
  'confirm-allow',
  'confirm-deny',
  'rotate',
  'toggle',
  // Roster rows
  'make-driver',
  'make-observer',
  'revoke',
  'close-link',
  'revoke-all',
  // The pause control
  'pause',
  'resume',
  // Invites (ADR 0017)
  'invite-open',
  'invite-close',
  'invite-label',
  'invite-role-observer',
  'invite-role-driver',
  'invite-lifetime-15m',
  'invite-lifetime-1h',
  'invite-lifetime-open',
  'invite-uses',
  'invite-create',
  'invite-copy',
  'invite-done',
  'cancel-invite',
  // Proposals (ADR 0042)
  'proposal-accept',
  'proposal-dismiss',
  'proposal-dismiss-all',
  'proposal-args',
  // Time-boxed sessions (ADR 0043)
  'session-open',
  'session-label',
  'session-length',
  'session-drivers',
  'session-observers',
  'session-proposals',
  'session-start',
  'session-qr',
  'session-renew',
  'session-extend',
  'session-end',
  'session-end-yes',
  'session-end-no',
  // Revoking a sponsor whose invites let people in (ADR 0043, plan C21)
  'revoke-anyway',
  'revoke-keep',
  // The Watching section of the roster (ADR 0044)
  'watching-toggle',
  'watching-filter',
  // Agent tokens (ADR 0044)
  'invite-kind-agent',
  'agent-lifetime-1h',
  'agent-lifetime-4h',
  'agent-lifetime-8h',
  'agent-copy',
  'agent-done',
  'agent-cancel',
  // The session record (ADR 0045)
  'record-open',
  'record-which-current',
  'record-which-previous',
  'record-which-ended',
  'record-save-json',
  'record-save-md',
  'record-discard',
  'record-offer-close',
] as const;
export type WidgetAction = (typeof WIDGET_ACTIONS)[number];

/** Every data-role the widget sets: which block, line or mark a node is. */
export const WIDGET_ROLES = [
  'pairing-code',
  'pairing-qr',
  'roster',
  'invites',
  'invite-link',
  'invite-qr',
  'invite-link-text',
  'invite-list',
  'invite-error',
  'invite-form',
  'invite-reason',
  'activity',
  'pause-box',
  'badge-paused',
  'joins',
  'invited',
  'confirmed',
  // Page state (ADR 0040)
  'state-line',
  // Proposals (ADR 0042)
  'proposals',
  'proposal-list',
  'proposal-args',
  'badge-proposals',
  // Time-boxed sessions (ADR 0043)
  'session',
  'session-reason',
  'session-effects',
  'session-countdown',
  'session-sponsor',
  'session-sponsor-warning',
  'session-ended',
  'badge-session',
  // The Watching section of the roster (ADR 0044)
  'watching',
  'watching-filter',
  // Agent tokens (ADR 0044)
  'agent-list',
  'agent-command',
  // The session record (ADR 0045)
  'record-summary',
  'record-box',
  'record-warning',
  'record-offer',
] as const;
export type WidgetRole = (typeof WIDGET_ROLES)[number];

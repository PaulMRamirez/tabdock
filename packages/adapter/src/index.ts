// Browser entry (SPEC.md section 8). attach() wires the core to the real page
// (page.ts), mounts the widget and returns the only control handle; nothing is
// exposed on window.

import type { PolicyInput } from '@tabdock/protocol';
import type { Dock, ModelContextLike } from './core.ts';
import { attachPage } from './page.ts';
import { ADAPTER_VERSION } from './version.ts';

export type {
  ActivityEntry,
  ActivityOutcome,
  AttachAnswer,
  CryptoLike,
  Dock,
  DockState,
  HintSupport,
  InviteJoin,
  InviteLifetime,
  InviteOptions,
  InviteRefusal,
  InviteResult,
  InvitesOffered,
  InviteView,
  LinkState,
  ModelContextLike,
  ObserverSeat,
  PageRole,
  PendingConfirm,
  PendingRequest,
  RevokeOptions,
  RuntimeTool,
  StoredGrant,
  StoredInvite,
  StoredInvites,
  AgentLifetime,
  AgentsOffered,
  AgentTokenOptions,
  AgentTokenResult,
  AgentView,
  PendingProposal,
  ProposalLogEntry,
  ProposalOutcome,
  PublishResult,
  PublishStatus,
  SeatLimits,
  SessionEnded,
  SessionEndedReason,
  SessionOptions,
  SessionResult,
  SessionView,
} from './core.ts';
export { INVITE_LIFETIMES, STATE_EVENT } from './core.ts';
export type { RecordView, RecordWhich, SessionRecord } from './record.ts';
export type {
  Account,
  AttachmentView,
  AttachVia,
  ClientInfo,
  ConfirmVia,
  InvitePolicy,
  Pairing,
  PolicyInput,
  Role,
  User,
  UserKind,
  AgentState,
  ImageMimeType,
  ProposalPolicy,
} from '@tabdock/protocol';
export { DEFAULT_IMAGE_BYTES, MAX_IMAGE_BYTES } from '@tabdock/protocol';
export { ADAPTER_VERSION };

export interface AttachOptions {
  /** The relay's page endpoint, such as wss://relay.example/page. */
  relay: string;
  /**
   * SPEC section 8's page policy. From M5 confirmVia 'client' (default
   * 'page') lets member drivers whose attachment no invite made confirm a
   * consequential call in their own MCP client instead of the operator here,
   * under consequential 'confirm' only; everyone else still gets the on-page
   * prompt (ADR 0026). From M6 imageTools names the tools whose results may
   * carry an image (ADR 0039), and proposals ('off' unless set) lets
   * observers propose writes for the operator to accept here (ADR 0042).
   */
  policy?: PolicyInput;
  /** Mount the on-page widget; true unless set to false, in which case the handle answers prompts. */
  ui?: boolean;
  /** Defaults to document.modelContext. */
  modelContext?: ModelContextLike;
}

export function attach(options: AttachOptions): Dock {
  return attachPage(options, 'attach');
}

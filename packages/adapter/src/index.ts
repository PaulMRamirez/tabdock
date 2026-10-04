// Browser entry (SPEC.md section 8). attach() wires the core to the real page,
// mounts the widget and returns the only control handle; nothing is exposed on
// window.

import type { PolicyInput } from '@tabdock/protocol';
import {
  createAdapterCore,
  type Dock,
  type LocksLike,
  type ModelContextLike,
  type StorageLike,
} from './core.ts';
import { ADAPTER_VERSION } from './version.ts';
import { mountWidget } from './widget.ts';

export type {
  ActivityEntry,
  ActivityOutcome,
  AttachAnswer,
  Dock,
  DockState,
  HintSupport,
  InviteLifetime,
  InviteOptions,
  InviteRefusal,
  InviteResult,
  InvitesOffered,
  InviteView,
  LinkState,
  ModelContextLike,
  PageRole,
  PendingConfirm,
  PendingRequest,
  RevokeOptions,
  RuntimeTool,
  StoredGrant,
  StoredInvite,
  StoredInvites,
} from './core.ts';
export { INVITE_LIFETIMES } from './core.ts';
export type {
  Account,
  AttachmentView,
  AttachVia,
  ClientInfo,
  InvitePolicy,
  Pairing,
  PolicyInput,
  Role,
  User,
  UserKind,
} from '@tabdock/protocol';
export { ADAPTER_VERSION };

export interface AttachOptions {
  /** The relay's page endpoint, such as wss://relay.example/page. */
  relay: string;
  policy?: PolicyInput;
  /** Mount the on-page widget; true unless set to false, in which case the handle answers prompts. */
  ui?: boolean;
  /** Defaults to document.modelContext. */
  modelContext?: ModelContextLike;
}

export function attach(options: AttachOptions): Dock {
  const core = createAdapterCore({
    relayUrl: options.relay,
    policy: options.policy,
    modelContext: options.modelContext ?? pageModelContext(),
    socketFactory: (url, protocols) => new WebSocket(url, [...protocols]),
    storage: sessionStorageIfAllowed(),
    locks: 'locks' in navigator ? (navigator.locks satisfies LocksLike) : undefined,
    ownWindow: window,
    // The page one approval covers (ADR 0011), read once: origin and path only,
    // as queries and fragments can carry secrets.
    pageUrl: `${location.origin}${location.pathname}`,
    pageInfo: () => ({ title: document.title }),
    adapterVersion: ADAPTER_VERSION,
  });
  if (options.ui !== false) mountWidget(core.dock);
  core.start();
  return core.dock;
}

/** Read without trusting the shape: a page may carry an old or partial polyfill. */
function pageModelContext(): ModelContextLike | undefined {
  const candidate: unknown = Reflect.get(document, 'modelContext');
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const shape = candidate as { getTools?: unknown; addEventListener?: unknown };
  return typeof shape.getTools === 'function' && typeof shape.addEventListener === 'function'
    ? (candidate as ModelContextLike)
    : undefined;
}

/** Sandboxed frames and blocked storage throw on access; the link works without a resume token. */
function sessionStorageIfAllowed(): StorageLike | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

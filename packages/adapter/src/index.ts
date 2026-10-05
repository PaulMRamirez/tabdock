// Browser entry (SPEC.md section 8). attach() wires the core to the real page,
// mounts the widget and returns the only control handle; nothing is exposed on
// window.

import type { PolicyInput } from '@tabdock/protocol';
import {
  createAdapterCore,
  type Dock,
  type LocksLike,
  type ModelContextLike,
  type SocketFactory,
  type SocketLike,
  type StorageLike,
} from './core.ts';
import { apply, taken } from './taken.ts';
import { ADAPTER_VERSION } from './version.ts';
import { mountWidget } from './widget.ts';

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
    socketFactory: pageSockets(),
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

/** WebSocket's readyState values, which the HTML standard fixes. */
const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/**
 * The page link's sockets, made and driven only through what attach() takes
 * here, never through what the page's prototypes hold later: the WebSocket
 * constructor, its send and close, addEventListener, and the data, code and
 * reason getters of the events that arrive. A script that runs
 * after attach() and replaced any of them (the constructor, the onmessage
 * setter, MessageEvent's data getter) would otherwise sit inside the link
 * from then on or from the next reconnect, reading every relay frame (a
 * redemption's invite secret among them), dropping or rewriting what the
 * page sends at the socket, and playing relay. This closes the socket's
 * routes only. Past it, each relay frame is still checked against the
 * protocol's schemas on the page's built-ins once parsed, and so is each
 * frame the page sends before it becomes text; the protocol's JSON.stringify
 * that makes the text is taken, but still calls any toJSON a later script
 * defines. So such a script can still read and rewrite frames either way
 * there, an operator's Deny included (docs/threat-model.md, B5).
 */
function pageSockets(): SocketFactory {
  const Socket = WebSocket;
  const send = taken(Socket.prototype, 'send', 'value');
  const close = taken(Socket.prototype, 'close', 'value');
  const listen = taken(Socket.prototype, 'addEventListener', 'value');
  const messageData = taken(MessageEvent.prototype, 'data', 'get');
  const closeCode = taken(CloseEvent.prototype, 'code', 'get');
  const closeReason = taken(CloseEvent.prototype, 'reason', 'get');
  return (url, protocols) => {
    const socket = new Socket(url, [...protocols]);
    // Followed from the socket's own events rather than read through a
    // getter: OPEN from 'open', CLOSING once closed from here, CLOSED from
    // 'close'. The core only asks whether the link is open before it sends.
    let readyState = CONNECTING;
    // Own data properties, which the core sets and reads directly: no setter on any prototype runs.
    const link: SocketLike = {
      get readyState() {
        return readyState;
      },
      send(data) {
        apply(send, socket, [data]);
      },
      close(code, reason) {
        const args = code === undefined ? [] : reason === undefined ? [code] : [code, reason];
        apply(close, socket, args);
        if (readyState < CLOSING) readyState = CLOSING;
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    apply(listen, socket, [
      'open',
      (event: Event) => {
        readyState = OPEN;
        link.onopen?.(event);
      },
    ]);
    apply(listen, socket, [
      'message',
      (event: MessageEvent) => link.onmessage?.({ data: apply(messageData, event, []) }),
    ]);
    apply(listen, socket, [
      'close',
      (event: CloseEvent) => {
        readyState = CLOSED;
        link.onclose?.({
          code: apply(closeCode, event, []) as number,
          reason: apply(closeReason, event, []) as string,
        });
      },
    ]);
    apply(listen, socket, ['error', (event: Event) => link.onerror?.(event)]);
    return link;
  };
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

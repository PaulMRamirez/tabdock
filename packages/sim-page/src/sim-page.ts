// startSimPage: the real adapter core running in Node against a
// FakeModelContext, linked to a relay over a `ws` client that sends an Origin
// header the way a browser does. Relay tests drive it like a tab: an operator
// answers prompts (scripted, or through the Dock handle), and reload() drops
// the socket without a goodbye and boots a fresh page on the same storage.

import {
  createAdapterCore,
  type AdapterCore,
  type Dock,
  type DockState,
  type Logger,
  type SocketFactory,
  type StorageLike,
  type UiPort,
} from '@tabdock/adapter/core';
import type { PolicyInput } from '@tabdock/protocol';
import { WebSocket } from 'ws';
import { createDefaultTools, createSimStore, type SimStore } from './default-tools.ts';
import {
  FakeModelContext,
  type FakeToolDefinition,
  type RuntimeProfile,
} from './fake-model-context.ts';

/** The demo page's dev origin, which a dev relay allows. */
export const DEFAULT_SIM_ORIGIN = 'http://127.0.0.1:5173';

/** sessionStorage for one simulated tab: it outlives reload(), like the real thing. */
export class MemoryStorage implements StorageLike {
  readonly #items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }

  removeItem(key: string): void {
    this.#items.delete(key);
  }

  get size(): number {
    return this.#items.size;
  }
}

/**
 * A scripted operator. attach returns 'driver', 'observer' or 'deny'; confirm
 * returns true or false. Leaving a method out, or returning undefined, leaves
 * that prompt to sim.dock, and silence until the deadline denies.
 */
export type SimOperator = UiPort;

export interface SimPageOptions {
  /** The relay's page endpoint, for example ws://127.0.0.1:8787/page. */
  relayUrl: string;
  /** Which measured runtime the fake plays; chrome-156 by default. */
  profile?: RuntimeProfile;
  /** The Origin header to send; null sends none, as a non-browser client would. */
  origin?: string | null;
  policy?: PolicyInput;
  operator?: SimOperator;
  /** Builds the page's tools; createDefaultTools by default. */
  tools?: (store: SimStore) => FakeToolDefinition[];
  title?: string;
  /** Path part of the page URL sent in hello. */
  path?: string;
  /** Receives the adapter's log lines as well as sim.logs. */
  logger?: Logger;
  adapterVersion?: string;
}

export interface SimPage {
  /** The current page's handle; reload() replaces it. */
  readonly dock: Dock;
  readonly state: DockState;
  /** The current page's model context; reload() replaces it. */
  readonly context: FakeModelContext;
  readonly storage: MemoryStorage;
  readonly store: SimStore;
  /** Every adapter log line, prefixed with its level, so tests can check what was logged. */
  readonly logs: readonly string[];
  /** The current link's ws client, for tests that cut the network. */
  readonly socket: WebSocket | null;
  /** How many sockets this sim page has opened. */
  readonly connections: number;
  /** The last socket error, such as "Unexpected server response: 403" for a refused upgrade. */
  readonly lastSocketError: string | null;
  /** The last close the relay sent, or null. */
  readonly lastClose: { code: number; reason: string } | null;
  /** Resolves with the first state, current or later, that matches; rejects after timeoutMs (5000). */
  waitFor(predicate: (state: DockState) => boolean, timeoutMs?: number): Promise<DockState>;
  /**
   * A browser reload: no detach, socket closed as going away, a fresh page on
   * the same storage. awayMs keeps the tab gone that long before the fresh page
   * boots, like a reload stuck behind a sleeping laptop.
   */
  reload(options?: { awayMs?: number }): Promise<void>;
  /** A deliberate detach: pending prompts denied, socket closed with 1000, resume token dropped. */
  close(): Promise<void>;
}

/** A socket factory for the core that dials with `ws` and sends an Origin header unless origin is null. */
export function wsSocketFactory(
  origin: string | null,
  onSocket?: (socket: WebSocket) => void,
): SocketFactory {
  return (url, protocols) => {
    const socket = new WebSocket(url, [...protocols], origin === null ? {} : { origin });
    // The core lets go of a socket it closes; a late error on it must not crash Node.
    socket.on('error', () => undefined);
    onSocket?.(socket);
    return socket;
  };
}

function waitClosed(socket: WebSocket | null, timeoutMs = 2000): Promise<void> {
  if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.terminate();
      resolve();
    }, timeoutMs);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

interface Booted {
  readonly core: AdapterCore;
  readonly context: FakeModelContext;
}

export async function startSimPage(options: SimPageOptions): Promise<SimPage> {
  const originHeader = options.origin === undefined ? DEFAULT_SIM_ORIGIN : options.origin;
  const pageOrigin = originHeader ?? DEFAULT_SIM_ORIGIN;
  const profile = options.profile ?? 'chrome-156';
  const buildTools = options.tools ?? createDefaultTools;
  const storage = new MemoryStorage();
  const store = createSimStore();
  const logs: string[] = [];
  let socket: WebSocket | null = null;
  let connections = 0;
  let lastSocketError: string | null = null;
  let lastClose: { code: number; reason: string } | null = null;

  const logger: Logger = {
    info: (message) => {
      logs.push(`info ${message}`);
      options.logger?.info(message);
    },
    warn: (message) => {
      logs.push(`warn ${message}`);
      options.logger?.warn(message);
    },
    error: (message) => {
      logs.push(`error ${message}`);
      options.logger?.error(message);
    },
  };

  const socketFactory = wsSocketFactory(originHeader, (created) => {
    socket = created;
    connections += 1;
    created.on('error', (error) => {
      lastSocketError = error.message;
    });
    created.on('close', (code, reason) => {
      lastClose = { code, reason: reason.toString() };
    });
  });

  async function boot(): Promise<Booted> {
    const context = new FakeModelContext({ profile, origin: pageOrigin });
    // Registrations last as long as the simulated page.
    const registration = new AbortController();
    await Promise.all(
      buildTools(store).map((tool) => context.registerTool(tool, { signal: registration.signal })),
    );
    const core = createAdapterCore({
      relayUrl: options.relayUrl,
      policy: options.policy,
      modelContext: context,
      socketFactory,
      storage,
      ui: options.operator,
      pageInfo: () => ({
        title: options.title ?? 'Sim page',
        url: `${pageOrigin}${options.path ?? '/'}`,
      }),
      ownWindow: context.window,
      adapterVersion: options.adapterVersion ?? '0.0.0-sim',
      logger,
    });
    core.start();
    return { core, context };
  }

  let current = await boot();

  return {
    get dock() {
      return current.core.dock;
    },
    get state() {
      return current.core.dock.state;
    },
    get context() {
      return current.context;
    },
    storage,
    store,
    logs,
    get socket() {
      return socket;
    },
    get connections() {
      return connections;
    },
    get lastSocketError() {
      return lastSocketError;
    },
    get lastClose() {
      return lastClose;
    },
    waitFor(predicate, timeoutMs = 5000) {
      const dock = current.core.dock;
      return new Promise<DockState>((resolve, reject) => {
        if (predicate(dock.state)) {
          resolve(dock.state);
          return;
        }
        const stop = dock.on('state', (state) => {
          if (!predicate(state)) return;
          clearTimeout(timer);
          stop();
          resolve(state);
        });
        const timer = setTimeout(() => {
          stop();
          reject(
            new Error(`waitFor timed out after ${timeoutMs} ms with the link ${dock.state.link}`),
          );
        }, timeoutMs);
      });
    },
    async reload(reloadOptions = {}) {
      const closing = socket;
      current.core.close('unload');
      await waitClosed(closing);
      socket = null;
      const awayMs = reloadOptions.awayMs ?? 0;
      if (awayMs > 0) await new Promise((resolve) => setTimeout(resolve, awayMs));
      current = await boot();
    },
    async close() {
      const closing = socket;
      current.core.close('detach');
      await waitClosed(closing);
      socket = null;
    },
  };
}

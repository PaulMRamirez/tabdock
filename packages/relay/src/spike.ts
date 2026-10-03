// The M3 spike's measurements (ADR 0014, SPEC A3.3), on only with
// TABDOCK_SPIKE=1 and refused in production (config.ts). Four things:
//
// 1. A marker tool. The owner adds or removes it from the relay's own
//    terminal (attachSpikeConsole, reading stdin), never over HTTP: a route on
//    the loopback Host would still be reachable by any web page open in the
//    owner's browser (a no-cors POST needs no permission), and by the internet
//    through a tunnel told to rewrite Host, so the only control is one with no
//    network surface at all. Adding or removing it tells open sessions the
//    tool list changed: 2025-era sessions through notifications/tools/
//    list_changed on their listening GET stream (the SDK sends it when a tool
//    is registered on a connected server), 2026-07-28 clients through the
//    SDK's subscriptions/listen bus.
// 2. A log line for every tools/list request and every stream a client opens
//    (a 2025 session's GET stream, a 2026 subscriptions/listen), with the
//    client's name and, for a session, a short label such as s3.
// 3. Timestamps for each call_page_tool (request in, invoke out, result in,
//    response out), in the result's _meta and in a log line, so a client can
//    split its round trip into tunnel-and-client and page.
// 4. Pairing milestones (ticket or nonce issued, QR scanned, claimed,
//    decided, first call), for the time from scan to first call. The /pair
//    routes call pairingScanned and pairingClaimed(..., 'qr'); the hub calls
//    the rest.
//
// Nothing here logs a token, a pairing code, a nonce or a session id; the
// logger redacts those field names anyway (log.ts).

import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import {
  type AuthInfo,
  CLIENT_INFO_META_KEY,
  type CallToolResult,
  type McpServer,
  readRequestBody,
  type RegisteredTool,
} from '@modelcontextprotocol/server';
import type { ClientInfo } from '@tabdock/protocol';
import { z } from 'zod';
import type { Logger } from './log.ts';
import { parseClientInfo } from './mcp.ts';
import { trackBody } from './sessions.ts';

/** The marker's name, numbered so a client showing an old list is told apart from one showing the new. */
export function markerToolName(generation: number): string {
  return `tabdock_spike_marker_${String(generation)}`;
}

/** Where call_page_tool results carry their timestamps while the spike is on. */
export const SPIKE_TIMING_META_KEY = 'tabdock/spikeTiming';

/** What the owner can do to the marker, from the relay's terminal only. */
export interface SpikeControl {
  /** The marker tool's name while it is listed, else null. */
  readonly marker: string | null;
  addMarker(): MarkerChange;
  removeMarker(): MarkerChange;
}

export interface MarkerChange {
  changed: boolean;
  /** The marker's name after the change, or null when none is listed. */
  marker: string | null;
  /** Open 2025-era sessions whose list changed; each was sent list_changed if it holds a stream. */
  sessions: number;
}

/** When a call passed the page link, in performance.now() milliseconds; the hub fills them in. */
export interface CallMarks {
  invokeOut: number | null;
  resultIn: number | null;
}

/**
 * Milliseconds from the moment the relay read the request, each to 0.01 ms.
 * responseOut is when the handler handed its result to the SDK, a fraction of
 * a millisecond before the SDK writes it.
 */
export const SpikeTimingSchema = z.object({
  handlerIn: z.number(),
  invokeOut: z.number().nullable(),
  resultIn: z.number().nullable(),
  responseOut: z.number(),
  /** resultIn minus invokeOut: the page link and the page's handler. */
  pageMs: z.number().nullable(),
  /** responseOut: everything the relay saw, the page included. */
  relayMs: z.number(),
});
export type SpikeTiming = z.infer<typeof SpikeTimingSchema>;

/** One call being timed, from startCall to finishCall. */
export interface CallTimer {
  requestIn: number;
  handlerIn: number;
  marks: CallMarks;
}

export type PairingVia = 'code' | 'qr';

/**
 * The hub's side of the spike: pairing milestones, and the end of each call.
 * The hub calls pairingIssued with every ticket, pairingClaimed for a code,
 * pairingDecided and callFinished. The /pair phase calls pairingScanned from
 * its preview and pairingClaimed(..., 'qr') from its claim, which is all the
 * scan-to-first-call figure still needs.
 */
export interface SpikeHooks {
  pairingIssued(pageId: string): void;
  pairingScanned(pageId: string): void;
  pairingClaimed(pageId: string, userId: string, via: PairingVia): void;
  pairingDecided(pageId: string, userId: string, allowed: boolean): void;
  callFinished(pageId: string, userId: string, outcome: string): void;
}

interface Marker {
  generation: number;
  name: string;
  addedAt: string;
}

interface LegacyServer {
  registered: RegisteredTool | null;
}

interface SessionLabel {
  label: string;
  client: ClientInfo | null;
  userId: string;
}

interface PendingPairing {
  via: PairingVia;
  issuedAt: number | null;
  scannedAt: number | null;
  claimedAt: number;
  approvedAt: number | null;
}

/** Labels and pairing records are kept for this long, or this many, whichever ends first. */
const KEEP_MS = 15 * 60_000;
const KEEP_ENTRIES = 2000;

function rounded(ms: number): number {
  return Math.round(ms * 100) / 100;
}

function since(start: number | null | undefined, now: number): number | null {
  return start === null || start === undefined ? null : Math.round(now - start);
}

/** The receive time relay.ts puts into authInfo.extra while the spike is on. */
function receivedAt(authInfo: AuthInfo | undefined): number | null {
  const value = authInfo?.extra?.receivedAt;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Drops the oldest entries past KEEP_ENTRIES; Maps keep insertion order. */
function bound<V>(map: Map<string, V>): void {
  for (const key of map.keys()) {
    if (map.size <= KEEP_ENTRIES) return;
    map.delete(key);
  }
}

interface RpcMessage {
  method: string;
  params: Record<string, unknown>;
}

/** The JSON-RPC requests in a body, one or a batch; anything else is no request at all. */
function rpcMessages(text: string): RpcMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const messages: RpcMessage[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const { method, params } = item as Record<string, unknown>;
    if (typeof method !== 'string') continue;
    messages.push({
      method,
      params:
        typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {},
    });
  }
  return messages;
}

function metaClient(params: Record<string, unknown>): ClientInfo | null {
  const meta = params._meta;
  if (typeof meta !== 'object' || meta === null) return null;
  return parseClientInfo((meta as Record<string, unknown>)[CLIENT_INFO_META_KEY]);
}

export class Spike implements SpikeControl, SpikeHooks {
  readonly #log: Logger;
  readonly #maxBodyBytes: number;
  #marker: Marker | null = null;
  #generation = 0;
  /** Every 2025-era session's server, so a change reaches the sessions already open. */
  readonly #legacy = new Map<McpServer, LegacyServer>();
  #notifyModern: (() => void) | null = null;
  /** Session id to its label; the id itself is never logged. */
  readonly #sessions = new Map<string, SessionLabel>();
  #nextSession = 1;
  readonly #issued = new Map<string, number>();
  readonly #scanned = new Map<string, number>();
  readonly #pairings = new Map<string, PendingPairing>();

  constructor(log: Logger, maxBodyBytes: number) {
    this.#log = log;
    this.#maxBodyBytes = maxBodyBytes;
  }

  // 1. The marker tool

  get marker(): string | null {
    return this.#marker?.name ?? null;
  }

  /** Called for every server the MCP factory builds, so each one lists the marker while it exists. */
  attachServer(server: McpServer, era: 'legacy' | 'modern'): void {
    const registered = this.#marker ? this.#register(server, this.#marker) : null;
    // A 2026-07-28 server lives for one request; the next request builds a new one.
    if (era !== 'legacy') return;
    this.#legacy.set(server, { registered });
    const previous = server.server.onclose;
    server.server.onclose = () => {
      this.#legacy.delete(server);
      previous?.();
    };
  }

  /** How 2026-07-28 clients hear of a change: the handler's subscriptions/listen bus. */
  setModernNotifier(notify: () => void): void {
    this.#notifyModern = notify;
  }

  addMarker(): MarkerChange {
    if (this.#marker) return { changed: false, marker: this.#marker.name, sessions: 0 };
    this.#generation += 1;
    const marker: Marker = {
      generation: this.#generation,
      name: markerToolName(this.#generation),
      addedAt: new Date().toISOString(),
    };
    this.#marker = marker;
    // Registering on a connected server makes the SDK send list_changed itself.
    const sessions = this.#eachLiveSession((entry, server) => {
      entry.registered = this.#register(server, marker);
    });
    this.#notifyModern?.();
    this.#log.info('spike: marker tool added', { tool: marker.name, sessions });
    return { changed: true, marker: marker.name, sessions };
  }

  removeMarker(): MarkerChange {
    const marker = this.#marker;
    if (!marker) return { changed: false, marker: null, sessions: 0 };
    this.#marker = null;
    // Removing a registered tool sends list_changed the same way.
    const sessions = this.#eachLiveSession((entry) => {
      entry.registered?.remove();
      entry.registered = null;
    });
    this.#notifyModern?.();
    this.#log.info('spike: marker tool removed', { tool: marker.name, sessions });
    return { changed: true, marker: null, sessions };
  }

  #eachLiveSession(change: (entry: LegacyServer, server: McpServer) => void): number {
    let count = 0;
    for (const [server, entry] of this.#legacy) {
      if (!server.isConnected()) {
        this.#legacy.delete(server);
        continue;
      }
      change(entry, server);
      count += 1;
    }
    return count;
  }

  #register(server: McpServer, marker: Marker): RegisteredTool {
    const added = `marker ${String(marker.generation)}, added at ${marker.addedAt}`;
    return server.registerTool(
      marker.name,
      {
        title: `Tabdock spike marker ${String(marker.generation)}`,
        description: `A measurement marker from the Tabdock relay (${added}). It exists only to test whether this client notices a tool list that changes during a conversation. Calling it returns when it was added and does nothing else.`,
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      () => ({ content: [{ type: 'text', text: `Tabdock spike ${added}.` }] }),
    );
  }

  // 2. What clients fetch and listen on

  /**
   * Logs what a request asks for, then forwards it. `legacy` says which leg
   * serves it. Only the method names, the client's own name for itself and a
   * session label are read out of a body.
   */
  async observe(
    request: Request,
    who: { userId: string; legacy: boolean },
    forward: (request: Request) => Promise<Response>,
  ): Promise<Response> {
    const era = who.legacy ? '2025' : '2026-07-28';
    const sessionId = request.headers.get('mcp-session-id');
    const known = sessionId === null ? undefined : this.#sessions.get(sessionId);
    // Someone else's session id gets no label; sessions.ts answers it 404 anyway.
    const session = known?.userId === who.userId ? known : undefined;
    const base = {
      userId: who.userId,
      era,
      ...(session ? { session: session.label } : {}),
    };

    if (request.method === 'GET') {
      const response = await forward(request);
      const fields = { ...base, kind: 'GET', client: session?.client ?? null };
      if (response.ok && response.body !== null) {
        return this.#trackStream(response, request.signal, fields);
      }
      this.#log.info('spike: client stream refused', { ...fields, status: response.status });
      return response;
    }
    if (request.method !== 'POST') {
      const response = await forward(request);
      if (request.method === 'DELETE' && session && sessionId !== null && response.ok) {
        this.#sessions.delete(sessionId);
      }
      return response;
    }

    const body = await readRequestBody(request.clone(), this.#maxBodyBytes);
    const messages = body.tooLarge ? [] : rpcMessages(body.text);
    const response = await forward(request);
    const status = response.status;
    let listen: Record<string, unknown> | null = null;
    for (const message of messages) {
      const client = session?.client ?? metaClient(message.params);
      if (message.method === 'initialize') {
        this.#labelSession(response, who.userId, parseClientInfo(message.params.clientInfo), base);
      } else if (message.method === 'tools/list') {
        this.#log.info('spike: tools/list', { ...base, client, status });
      } else if (message.method === 'subscriptions/listen') {
        const filter = message.params.notifications;
        listen = {
          ...base,
          kind: 'subscriptions/listen',
          client,
          toolsListChanged:
            typeof filter === 'object' &&
            filter !== null &&
            (filter as Record<string, unknown>).toolsListChanged === true,
        };
      }
    }
    if (listen && response.ok && response.body !== null) {
      return this.#trackStream(response, request.signal, listen);
    }
    if (listen) this.#log.info('spike: client stream refused', { ...listen, status });
    return response;
  }

  /** A new 2025-era session gets a short label, so its lists and streams can be told apart. */
  #labelSession(
    response: Response,
    userId: string,
    client: ClientInfo | null,
    base: Record<string, unknown>,
  ): void {
    const opened = response.headers.get('mcp-session-id');
    if (!response.ok || opened === null) return;
    const label = `s${String(this.#nextSession)}`;
    this.#nextSession += 1;
    this.#sessions.set(opened, { label, client, userId });
    bound(this.#sessions);
    this.#log.info('spike: session opened', { ...base, session: label, client });
  }

  #trackStream(response: Response, signal: AbortSignal, fields: Record<string, unknown>): Response {
    const opened = Date.now();
    this.#log.info('spike: client opened a stream', fields);
    return trackBody(response, signal, () => {
      this.#log.info('spike: client stream ended', { ...fields, openMs: Date.now() - opened });
    });
  }

  // 3. Call timestamps

  startCall(authInfo: AuthInfo | undefined): CallTimer {
    const handlerIn = performance.now();
    return {
      requestIn: receivedAt(authInfo) ?? handlerIn,
      handlerIn,
      marks: { invokeOut: null, resultIn: null },
    };
  }

  /** Puts the timestamps into the result's _meta and logs them. */
  finishCall(
    timer: CallTimer,
    result: CallToolResult,
    fields: { userId: string; pageId: string; tool: string },
  ): CallToolResult {
    const responseOut = performance.now();
    const from = (at: number | null): number | null =>
      at === null ? null : rounded(at - timer.requestIn);
    const { invokeOut, resultIn } = timer.marks;
    const timing: SpikeTiming = {
      handlerIn: rounded(timer.handlerIn - timer.requestIn),
      invokeOut: from(invokeOut),
      resultIn: from(resultIn),
      responseOut: rounded(responseOut - timer.requestIn),
      pageMs: invokeOut === null || resultIn === null ? null : rounded(resultIn - invokeOut),
      relayMs: rounded(responseOut - timer.requestIn),
    };
    this.#log.info('spike: call timing', { ...fields, isError: result.isError === true, timing });
    return { ...result, _meta: { ...result._meta, [SPIKE_TIMING_META_KEY]: timing } };
  }

  // 4. Pairing milestones

  /** A ticket was issued: a pairing code, and from the /pair phase its QR nonce with it. */
  pairingIssued(pageId: string): void {
    this.#issued.set(pageId, Date.now());
    bound(this.#issued);
    this.#log.debug('spike: pairing milestone', { stage: 'issued', pageId });
  }

  /** The /pair preview: a phone opened the QR URL for this page. Called by the /pair routes. */
  pairingScanned(pageId: string): void {
    const now = Date.now();
    this.#scanned.set(pageId, now);
    bound(this.#scanned);
    this.#log.info('spike: pairing milestone', {
      stage: 'scanned',
      pageId,
      sinceIssuedMs: since(this.#issued.get(pageId), now),
    });
  }

  /** pair_page matched a code, or /pair/claim consumed a nonce. */
  pairingClaimed(pageId: string, userId: string, via: PairingVia): void {
    const now = Date.now();
    this.#prune(now);
    const issuedAt = this.#issued.get(pageId) ?? null;
    const scannedAt = via === 'qr' ? (this.#scanned.get(pageId) ?? null) : null;
    this.#pairings.set(`${pageId} ${userId}`, {
      via,
      issuedAt,
      scannedAt,
      claimedAt: now,
      approvedAt: null,
    });
    bound(this.#pairings);
    this.#log.info('spike: pairing milestone', {
      stage: 'claimed',
      pageId,
      userId,
      via,
      sinceIssuedMs: since(issuedAt, now),
      sinceScannedMs: since(scannedAt, now),
    });
  }

  pairingDecided(pageId: string, userId: string, allowed: boolean): void {
    const key = `${pageId} ${userId}`;
    const pending = this.#pairings.get(key);
    if (!pending) return;
    const now = Date.now();
    this.#log.info('spike: pairing milestone', {
      stage: allowed ? 'approved' : 'refused',
      pageId,
      userId,
      via: pending.via,
      sinceClaimedMs: since(pending.claimedAt, now),
      sinceScannedMs: since(pending.scannedAt, now),
    });
    if (allowed) pending.approvedAt = now;
    else this.#pairings.delete(key);
  }

  /** The first call after an approval closes the pairing's record. */
  callFinished(pageId: string, userId: string, outcome: string): void {
    const key = `${pageId} ${userId}`;
    const pending = this.#pairings.get(key);
    if (pending === undefined || pending.approvedAt === null) return;
    this.#pairings.delete(key);
    const now = Date.now();
    this.#log.info('spike: pairing milestone', {
      stage: 'first_call',
      pageId,
      userId,
      via: pending.via,
      outcome,
      sinceApprovedMs: since(pending.approvedAt, now),
      sinceClaimedMs: since(pending.claimedAt, now),
      sinceScannedMs: since(pending.scannedAt, now),
      sinceIssuedMs: since(pending.issuedAt, now),
    });
  }

  #prune(now: number): void {
    for (const [key, pending] of this.#pairings) {
      if (now - pending.claimedAt > KEEP_MS) this.#pairings.delete(key);
    }
  }
}

const HELP = [
  'Tabdock spike console (TABDOCK_SPIKE=1). Commands:',
  '  add      add the marker tool beside the five fixed tools and tell open sessions',
  '  remove   remove it again and tell open sessions',
  '  status   say whether the marker is listed',
  '  help     show this',
].join('\n');

/**
 * Reads marker commands from the relay's terminal. Returns a function that
 * stops reading. Only the person who started the relay can type here.
 */
export function attachSpikeConsole(
  control: SpikeControl,
  input: Readable,
  print: (line: string) => void,
): () => void {
  const lines = createInterface({ input, terminal: false });
  lines.on('line', (raw) => {
    const command = raw
      .trim()
      .toLowerCase()
      .replace(/^marker\s+/, '');
    if (command === '') return;
    if (command === 'add') {
      const change = control.addMarker();
      print(
        change.changed
          ? `spike: added ${change.marker ?? ''}; ${String(change.sessions)} open 2025 session(s) and every subscriptions/listen stream were told the list changed`
          : `spike: ${change.marker ?? ''} is already listed`,
      );
    } else if (command === 'remove') {
      const change = control.removeMarker();
      print(
        change.changed
          ? `spike: removed the marker; ${String(change.sessions)} open 2025 session(s) and every subscriptions/listen stream were told the list changed`
          : 'spike: no marker is listed',
      );
    } else if (command === 'status') {
      print(
        control.marker === null
          ? 'spike: no marker is listed'
          : `spike: ${control.marker} is listed`,
      );
    } else {
      print(HELP);
    }
  });
  return () => {
    lines.close();
  };
}

export const SPIKE_CONSOLE_HELP = HELP;

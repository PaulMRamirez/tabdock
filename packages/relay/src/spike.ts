// The M3 spike's measurements (ADR 0014, SPEC A3.3), on only with
// TABDOCK_SPIKE=1 and refused in production (config.ts). Four things:
//
// 1. A marker tool. The owner adds or removes it from the relay's own
//    terminal (attachSpikeConsole, reading stdin), never over HTTP: a route on
//    the loopback Host would still be reachable by any web page open in the
//    owner's browser (a no-cors POST needs no permission), and by the internet
//    through a tunnel told to rewrite Host, so the only control is one with no
//    network surface at all. Every server the MCP factory builds lists it
//    beside the five for members while it exists (mcp.ts), and adding or
//    removing it tells every member's open sessions and listen streams the
//    tool list changed, through the notifier relay.ts gives it: 2025-era
//    sessions get notifications/tools/list_changed on their listening GET
//    stream, 2026-07-28 clients on their subscriptions/listen streams. A
//    first-class list change reaches only its own user (ADR 0025); the
//    marker concerns every member, so the spike tells them all itself.
// 2. A log line for every tools/list request and every stream a client opens
//    (a 2025 session's GET stream, a 2026 subscriptions/listen), with the
//    client's name and, for a session, a short label such as s3.
// 3. Timestamps for each call_page_tool (request in, invoke out, result in,
//    response out), in the result's _meta and in a log line, so a client can
//    split its round trip into tunnel-and-client and page.
// 4. Pairing milestones (ticket issued, QR scanned, claimed, decided, first
//    call), for the time from scan to first call. The hub calls every hook,
//    pairingScanned from the /pair preview and pairingClaimed(..., 'qr')
//    from the /pair claim among them. These lines are the only record of
//    those times: each carries a trace id the spike draws for the ticket
//    (tr_...), random and unrelated to the code or nonce, so one pairing can
//    be followed through the log without a secret in it.
//
// Nothing here logs a token, a pairing code, a nonce or a session id; the
// logger redacts those field names anyway (log.ts).

import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import {
  type AuthInfo,
  CLIENT_INFO_META_KEY,
  type CallToolResult,
  readRequestBody,
} from '@modelcontextprotocol/server';
import type { AttachVia, ClientInfo } from '@tabdock/protocol';
import { z } from 'zod';
import type { Logger } from './log.ts';
import { type ListedTool, listedInputSchema, parseClientInfo } from './mcp.ts';
import { newId } from './secrets.ts';
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

/** How a pairing came in; from M4 an invite redemption is one too (ADR 0017). */
export type PairingVia = AttachVia;

/**
 * The hub's side of the spike: pairing milestones, and the end of each call.
 * A page has one live ticket at a time (its code and, in public URL mode, the
 * QR nonce beside it), so the page id names the ticket.
 */
export interface SpikeHooks {
  /** A new ticket replaced the page's last one. */
  pairingIssued(pageId: string): void;
  /** /pair previewed the page's live nonce; only the first look is the scan. */
  pairingScanned(pageId: string): void;
  /** A live code or nonce matched, called before the hub spends and replaces it. */
  pairingClaimed(pageId: string, userId: string, via: PairingVia): void;
  /** The claim ended in an attachment (approved, let in, or already attached) or a refusal. */
  pairingDecided(pageId: string, userId: string, allowed: boolean): void;
  callFinished(pageId: string, userId: string, outcome: string): void;
}

interface Marker {
  generation: number;
  name: string;
  addedAt: string;
}

/** The marker as the MCP factory lists and answers it (mcp.ts). */
export interface MarkerTool {
  entry: ListedTool;
  call(): CallToolResult;
}

/**
 * Tells every member's open sessions and listen streams that the tool list
 * changed; answers how many open 2025-era sessions it told.
 */
export type MarkerNotifier = () => number;

/** The marker's input schema: no arguments, as McpServer listed it in M3. */
const MARKER_INPUT = z.object({});

interface SessionLabel {
  label: string;
  client: ClientInfo | null;
  userId: string;
}

/** A page's live ticket, as the spike saw it. */
interface IssuedTicket {
  trace: string;
  issuedAt: number;
  scannedAt: number | null;
}

interface PendingPairing {
  trace: string;
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

export interface SpikeOptions {
  /**
   * The wall clock for pairing milestones and stream lifetimes, in
   * milliseconds; Date.now unless a test steps its own.
   */
  now?: () => number;
}

export class Spike implements SpikeControl, SpikeHooks {
  readonly #log: Logger;
  readonly #maxBodyBytes: number;
  readonly #now: () => number;
  #marker: Marker | null = null;
  #generation = 0;
  #notify: MarkerNotifier | null = null;
  /** Session id to its label; the id itself is never logged. */
  readonly #sessions = new Map<string, SessionLabel>();
  #nextSession = 1;
  /** Each page's live ticket, by page id. */
  readonly #tickets = new Map<string, IssuedTicket>();
  readonly #pairings = new Map<string, PendingPairing>();

  constructor(log: Logger, maxBodyBytes: number, options: SpikeOptions = {}) {
    this.#log = log;
    this.#maxBodyBytes = maxBodyBytes;
    this.#now = options.now ?? Date.now;
  }

  // 1. The marker tool

  get marker(): string | null {
    return this.#marker?.name ?? null;
  }

  /** The marker while it exists, else null; the MCP factory lists it for members. */
  markerTool(): MarkerTool | null {
    const marker = this.#marker;
    if (marker === null) return null;
    const added = `marker ${String(marker.generation)}, added at ${marker.addedAt}`;
    return {
      entry: {
        name: marker.name,
        title: `Tabdock spike marker ${String(marker.generation)}`,
        description: `A measurement marker from the Tabdock relay (${added}). It exists only to test whether this client notices a tool list that changes during a conversation. Calling it returns when it was added and does nothing else.`,
        inputSchema: listedInputSchema(MARKER_INPUT),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      call: () => ({ content: [{ type: 'text', text: `Tabdock spike ${added}.` }] }),
    };
  }

  /** How a change reaches every member's clients (relay.ts). */
  setNotifier(notify: MarkerNotifier): void {
    this.#notify = notify;
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
    const sessions = this.#notify?.() ?? 0;
    this.#log.info('spike: marker tool added', { tool: marker.name, sessions });
    return { changed: true, marker: marker.name, sessions };
  }

  removeMarker(): MarkerChange {
    const marker = this.#marker;
    if (!marker) return { changed: false, marker: null, sessions: 0 };
    this.#marker = null;
    const sessions = this.#notify?.() ?? 0;
    this.#log.info('spike: marker tool removed', { tool: marker.name, sessions });
    return { changed: true, marker: null, sessions };
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
    const opened = this.#now();
    this.#log.info('spike: client opened a stream', fields);
    return trackBody(response, signal, () => {
      this.#log.info('spike: client stream ended', { ...fields, openMs: this.#now() - opened });
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

  /** A ticket was issued: a pairing code, and in public URL mode its QR nonce with it. */
  pairingIssued(pageId: string): void {
    const trace = newId('tr');
    // Delete first so a page's re-issued ticket moves to the newest end for bound().
    this.#tickets.delete(pageId);
    this.#tickets.set(pageId, { trace, issuedAt: this.#now(), scannedAt: null });
    bound(this.#tickets);
    this.#log.debug('spike: pairing milestone', { stage: 'issued', pageId, trace });
  }

  /**
   * The /pair preview: a phone opened the QR URL for this page's live ticket.
   * The page previews again after sign-in; only the first look is the scan.
   */
  pairingScanned(pageId: string): void {
    const ticket = this.#tickets.get(pageId);
    if (ticket === undefined || ticket.scannedAt !== null) return;
    const now = this.#now();
    ticket.scannedAt = now;
    this.#log.info('spike: pairing milestone', {
      stage: 'scanned',
      pageId,
      trace: ticket.trace,
      sinceIssuedMs: since(ticket.issuedAt, now),
    });
  }

  /** pair_page matched a code, or /pair/claim consumed a nonce; the ticket is spent. */
  pairingClaimed(pageId: string, userId: string, via: PairingVia): void {
    const now = this.#now();
    this.#prune(now);
    const ticket = this.#tickets.get(pageId);
    this.#tickets.delete(pageId);
    const issuedAt = ticket?.issuedAt ?? null;
    // A scan belongs to a QR claim; someone who looked and then typed the code did not scan to pair.
    const scannedAt = via === 'qr' ? (ticket?.scannedAt ?? null) : null;
    const trace = ticket?.trace ?? newId('tr');
    // A second claim by the same person (another device, or a retry) is the one timed from here.
    this.#pairings.delete(`${pageId} ${userId}`);
    this.#pairings.set(`${pageId} ${userId}`, {
      trace,
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
      trace,
      sinceIssuedMs: since(issuedAt, now),
      sinceScannedMs: since(scannedAt, now),
    });
  }

  pairingDecided(pageId: string, userId: string, allowed: boolean): void {
    const key = `${pageId} ${userId}`;
    const pending = this.#pairings.get(key);
    if (!pending) return;
    const now = this.#now();
    this.#log.info('spike: pairing milestone', {
      stage: allowed ? 'approved' : 'refused',
      pageId,
      userId,
      via: pending.via,
      trace: pending.trace,
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
    const now = this.#now();
    this.#log.info('spike: pairing milestone', {
      stage: 'first_call',
      pageId,
      userId,
      via: pending.via,
      trace: pending.trace,
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

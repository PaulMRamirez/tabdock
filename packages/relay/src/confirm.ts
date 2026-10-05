// Confirmation in the caller's client (ADR 0026): the relay's half, apart
// from the call flow itself, which stays in hub.ts so both routes to a page
// tool share it. A page that chose confirmVia 'client' lets a member driver,
// on an attachment no invite made, confirm a consequential call in the very
// client that made it, where that client declared form elicitation; every
// other case keeps the page's own prompt (S6).
//
// Here: when the relay asks (asksClient), the question it writes (relay text,
// never a page title or description, S10), the one answer that confirms, the
// SHA-256 digest that binds a confirmation to the exact arguments, the
// single-use records a 2026-07-28 question leaves behind and the questions a
// 2025-era call holds open (at most four a user across both, 120 s each, all
// gone with the process), and the SDK's own request state codec, keyed per
// process from node:crypto and bound to the user, the OAuth client and the
// method, which carries only a record's id through the client. Nothing here
// logs: a record's id, its digest and a request state are as secret as the
// arguments they stand for (S7, S11).

import { createHash, randomBytes } from 'node:crypto';
import { createRequestStateCodec, type ServerContext } from '@modelcontextprotocol/server';
import type { ClientInfo, ErrorCode, JsonObject, Policy, Role, UserKind } from '@tabdock/protocol';
import { z } from 'zod';

/** How long a question waits for its answer, on either leg (ADR 0026). */
export const CONFIRMATION_TTL_MS = 120_000;
/** Questions one user may have waiting at once, across both revisions; a fifth is rate_limited. */
export const MAX_PENDING_CONFIRMATIONS = 4;
/** The most of the arguments' JSON a question shows; the digest still binds every argument. */
export const MAX_QUESTION_ARGUMENT_CHARS = 500;
/** The most of the page's tool name a question shows, so the relay's own words stay in view. */
export const MAX_QUESTION_TOOL_CHARS = 64;
/** The most of the origin's host a question shows. */
export const MAX_QUESTION_HOST_CHARS = 100;
/** Random bytes in a record's id: 128 bits, so nobody guesses one (it also rides inside a signed state). */
const RECORD_ID_BYTES = 16;
/** The SDK codec's key: 256 bits, as its typings require, drawn once per process. */
const CODEC_KEY_BYTES = 32;

/**
 * What a present requestState that is not a string becomes before the SDK
 * sees it, on a call to a page tool: a string the codec refuses as malformed.
 * The SDK answers such a state with its frozen -32602 before any handler
 * runs, which would leave the attempt with no not_confirmed answer and no
 * call line (S7, ADR 0026's notes); as a string it reaches the verify hook,
 * which refuses it, and the dispatcher, which answers it.
 */
export const FORGED_REQUEST_STATE = '';

/** The questions are the relay's words, so this one field is all a client is asked for. */
export const CONFIRM_FIELD = 'confirm';

// When the relay asks

/** Who is calling and through what attachment, as asksClient reads them. */
export interface AskingStanding {
  /** The caller's account kind, from the auth plugin (ADR 0017). */
  account: UserKind;
  /** The attachment's own record: its kind, role and whether an invite made it. */
  attachment: { kind: UserKind; role: Role; inviteId: string | null };
}

/**
 * Whether a call goes to its caller's client for confirmation rather than to
 * the page's prompt, apart from the client's own capability: the page's
 * hello policy says consequential 'confirm' and confirmVia 'client', its
 * latest tools frame marks the tool consequential (which only the adapter
 * can work out, ADR 0002), and the caller is a member whose attachment is a
 * driver's that no invite made. Anyone else, and any other page, keeps the
 * page prompt (S6). Read again just before a confirmed call goes out, so a
 * page that changed its policy, or a caller demoted, revoked or replaced by
 * an invite's attachment meanwhile, sends no confirmation.
 */
export function asksClient(
  policy: Pick<Policy, 'consequential' | 'confirmVia'>,
  tool: { consequential?: boolean | undefined },
  standing: AskingStanding,
): boolean {
  return (
    policy.consequential === 'confirm' &&
    policy.confirmVia === 'client' &&
    tool.consequential === true &&
    standing.account === 'member' &&
    standing.attachment.kind === 'member' &&
    standing.attachment.inviteId === null &&
    standing.attachment.role === 'driver'
  );
}

// The arguments' digest

/**
 * An object with its own keys sorted, holding the same values, for
 * JSON.stringify's replacer. A null prototype keeps a key named __proto__
 * an ordinary key, as JSON.parse made it.
 */
function sortedKeys(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const sorted = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(source).sort()) sorted[key] = source[key];
  return sorted;
}

/**
 * The arguments as canonical JSON: every object's keys in code unit order,
 * no white space. Two calls whose arguments mean the same JSON give the same
 * text whatever order their keys came in, and any change to a value gives
 * another. JSON.stringify does the walk, so the depth it can take is the
 * depth the invoke itself was encoded at; null when it cannot.
 */
export function canonicalJson(args: JsonObject): string | null {
  try {
    return JSON.stringify(args, (_key, value: unknown) => sortedKeys(value));
  } catch {
    return null;
  }
}

/** SHA-256 of the canonical JSON, hex: what binds a confirmation to one exact call. Never logged. */
export function argumentsDigest(args: JsonObject): string | null {
  const text = canonicalJson(args);
  return text === null ? null : createHash('sha256').update(text, 'utf8').digest('hex');
}

// The question

/** One boolean field, false by default, and nothing secret asked for. */
export interface ConfirmSchema {
  [key: string]: unknown;
  type: 'object';
  properties: {
    confirm: {
      type: 'boolean';
      title: string;
      description: string;
      default: false;
    };
  };
  required: ['confirm'];
}

/** What the relay asks a client: its own message and the form's schema. */
export interface ConfirmQuestion {
  message: string;
  requestedSchema: ConfirmSchema;
}

export const CONFIRM_SCHEMA: ConfirmSchema = {
  type: 'object',
  properties: {
    confirm: {
      type: 'boolean',
      title: 'Run this call',
      description: 'True runs the call on the page now; anything else refuses it.',
      default: false,
    },
  },
  required: ['confirm'],
};

/**
 * Characters that would not read as written in a client's dialog: controls,
 * line and paragraph breaks, format characters (the bidirectional controls
 * among them), surrogate halves and every other default-ignorable code
 * point. Shown escaped, so the arguments a person confirms cannot reorder or
 * hide the relay's words around them.
 */
const NOT_AS_WRITTEN = /[\p{Cc}\p{Zl}\p{Zp}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu;

function escapedForQuestion(text: string): string {
  return text.replace(NOT_AS_WRITTEN, (char) => {
    const point = char.codePointAt(0) ?? 0;
    return point > 0xffff
      ? `\\u{${point.toString(16)}}`
      : `\\u${point.toString(16).padStart(4, '0')}`;
  });
}

/** The first `max` code units, one fewer when the cut would split a surrogate pair. */
function cutAt(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/**
 * The arguments' JSON as a question shows it, at most
 * MAX_QUESTION_ARGUMENT_CHARS characters of it: a cut ends saying how many
 * characters it left out, so nobody confirms what looks like a whole call
 * while the part that matters lies past the cut.
 */
export function shownArguments(args: JsonObject): string {
  let text: string;
  try {
    text = escapedForQuestion(JSON.stringify(args));
  } catch {
    // canonicalJson failed on the same arguments first, and the call was refused.
    text = '(arguments too deeply nested to show)';
  }
  if (text.length <= MAX_QUESTION_ARGUMENT_CHARS) return text;
  const shown = cutAt(text, MAX_QUESTION_ARGUMENT_CHARS);
  return `${shown}... (${String(text.length - shown.length)} more characters not shown)`;
}

/** The origin's host, port included, or the origin itself when it is no URL (the dev flag's stand-in). */
function hostOf(origin: string): string {
  const host = URL.parse(origin)?.host ?? origin;
  return escapedForQuestion(cutAt(host, MAX_QUESTION_HOST_CHARS));
}

/** The page's tool name, which a page chooses: WebMCP's characters only, capped and labelled as the page's. */
function shownTool(name: string): string {
  const cut = cutAt(name, MAX_QUESTION_TOOL_CHARS);
  return `"${escapedForQuestion(cut)}${cut.length < name.length ? '...' : ''}" (a name the page chose)`;
}

/**
 * The relay's question: the tool, the page id, the origin's host and the
 * arguments, never the page's title or a tool's description, which are page
 * text a page could fill with instructions (S10). The page id is the
 * relay's, and the host comes from the socket's Origin header (S1).
 */
export function confirmQuestion(input: {
  tool: string;
  pageId: string;
  origin: string;
  args: JsonObject;
}): ConfirmQuestion {
  const message = [
    'Tabdock asks you to confirm one call to a web page before it runs. The page will not ask its operator.',
    `Page: ${input.pageId} at ${hostOf(input.origin)}`,
    `Tool: ${shownTool(input.tool)}`,
    `Arguments (JSON): ${shownArguments(input.args)}`,
    'Set confirm to true only if you meant this exact call. Declining, dismissing or waiting refuses it.',
  ].join('\n');
  return { message, requestedSchema: CONFIRM_SCHEMA };
}

/**
 * The one answer that confirms: accept, with confirm exactly true, read from
 * what the SDK hands over. decline, cancel, accept with false, and a missing,
 * wrapped or malformed answer all refuse.
 */
const ConfirmingAnswerSchema = z.object({
  action: z.literal('accept'),
  content: z.object({ [CONFIRM_FIELD]: z.literal(true) }),
});

export function confirms(answer: unknown): boolean {
  return ConfirmingAnswerSchema.safeParse(answer).success;
}

// The records and the questions waiting

/**
 * What a 2026-07-28 question leaves behind until its retry or its expiry.
 * The client holds only the id, inside a signed state; everything that
 * decides whether a retry is the call that was confirmed stays here.
 */
export interface ConfirmationRecord {
  /** 128 random bits; never logged, never sent to a page. */
  readonly id: string;
  readonly userId: string;
  readonly pageId: string;
  /** The MCP tool as the client called it: call_page_tool, or a first-class name. */
  readonly calledAs: string;
  /** The page tool it reached. */
  readonly pageTool: string;
  /** argumentsDigest of the arguments asked about. */
  readonly digest: string;
  /** For the expiry's call line (S7): the page's origin and the client that was asked. */
  readonly origin: string;
  readonly client: ClientInfo | null;
  readonly askedAt: number;
  readonly expiresAt: number;
}

export type NewRecord = Omit<ConfirmationRecord, 'id' | 'askedAt' | 'expiresAt'>;

/** What a revoke, the attachment's end or the page's end tells a question it drops. */
export interface DroppedAnswer {
  code: ErrorCode;
  message: string;
}

/** A 2025-era question held open inside its request. */
export interface WaitingQuestion {
  /** Aborts when the question is dropped; `dropped` then says how the call answers. */
  readonly signal: AbortSignal;
  readonly dropped: DroppedAnswer | null;
  /** Frees its place among the user's questions, once its answer is in or it ended. */
  done(): void;
}

interface Waiting {
  userId: string;
  pageId: string;
  controller: AbortController;
  dropped: DroppedAnswer | null;
}

export interface PendingConfirmationsOptions {
  ttlMs: number;
  perUser: number;
  /** A record that expired with no retry: its call line goes out here, within the refusal budget. */
  onExpired: (record: ConfirmationRecord) => void;
  now?: () => number;
}

/**
 * The single-use records and the waiting questions, both counted against one
 * user's MAX_PENDING_CONFIRMATIONS. In memory only, so a restart voids every
 * record and fails closed: the retry finds none and answers not_confirmed.
 */
export class PendingConfirmations {
  readonly #options: PendingConfirmationsOptions;
  readonly #records = new Map<string, { record: ConfirmationRecord; timer: NodeJS.Timeout }>();
  readonly #waiting = new Set<Waiting>();
  readonly #perUser = new Map<string, number>();
  readonly #now: () => number;
  #closed = false;

  constructor(options: PendingConfirmationsOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** Records and waiting questions held now, for tests. */
  get size(): number {
    return this.#records.size + this.#waiting.size;
  }

  /** Questions this user has waiting, records and open ones together. */
  heldBy(userId: string): number {
    return this.#perUser.get(userId) ?? 0;
  }

  #take(userId: string): boolean {
    const held = this.heldBy(userId);
    if (this.#closed || held >= this.#options.perUser) return false;
    this.#perUser.set(userId, held + 1);
    return true;
  }

  #give(userId: string): void {
    const held = this.heldBy(userId) - 1;
    if (held > 0) this.#perUser.set(userId, held);
    else this.#perUser.delete(userId);
  }

  /** A new record, or null when the user already has as many questions waiting as allowed. */
  add(fields: NewRecord): ConfirmationRecord | null {
    if (!this.#take(fields.userId)) return null;
    const askedAt = this.#now();
    const record: ConfirmationRecord = {
      ...fields,
      id: randomBytes(RECORD_ID_BYTES).toString('base64url'),
      askedAt,
      expiresAt: askedAt + this.#options.ttlMs,
    };
    // The sweep: a record nobody retried leaves its line when it goes (ADR 0026).
    const timer = setTimeout(() => {
      if (this.#forget(record.id) !== null) this.#options.onExpired(record);
    }, this.#options.ttlMs);
    timer.unref();
    this.#records.set(record.id, { record, timer });
    return record;
  }

  /**
   * The record, taken out before any other check so a retry refused for
   * any reason has spent it; null for an unknown, used, dropped or expired
   * one. A record past its time that the sweep has not reached yet goes
   * here too, with no expiry line: the retry that found it writes its own.
   */
  take(id: string): ConfirmationRecord | null {
    const record = this.#forget(id);
    return record !== null && record.expiresAt > this.#now() ? record : null;
  }

  /** Removes a record whose question never went out, its state having failed to mint. */
  discard(id: string): void {
    this.#forget(id);
  }

  #forget(id: string): ConfirmationRecord | null {
    const held = this.#records.get(id);
    if (held === undefined) return null;
    clearTimeout(held.timer);
    this.#records.delete(id);
    this.#give(held.record.userId);
    return held.record;
  }

  /** A 2025-era question held open from here until done(), or null when the user has too many waiting. */
  wait(userId: string, pageId: string): WaitingQuestion | null {
    if (!this.#take(userId)) return null;
    const entry: Waiting = { userId, pageId, controller: new AbortController(), dropped: null };
    this.#waiting.add(entry);
    let released = false;
    return {
      signal: entry.controller.signal,
      get dropped() {
        return entry.dropped;
      },
      done: () => {
        if (released) return;
        released = true;
        if (this.#waiting.delete(entry)) this.#give(userId);
      },
    };
  }

  /**
   * A revoke, the attachment's end (users named) or the page's end (null):
   * those users' records for the page go at once, so a confirmation never
   * outlives the attachment it was given under, and their waiting questions
   * abort, answering as `answer` says (S8).
   */
  drop(pageId: string, users: ReadonlySet<string> | null, answer: DroppedAnswer): void {
    for (const { record } of [...this.#records.values()]) {
      if (record.pageId === pageId && (users === null || users.has(record.userId))) {
        this.#forget(record.id);
      }
    }
    for (const entry of [...this.#waiting]) {
      if (entry.pageId !== pageId || (users !== null && !users.has(entry.userId))) continue;
      this.#abort(entry, answer);
    }
  }

  #abort(entry: Waiting, answer: DroppedAnswer): void {
    if (entry.dropped !== null) return;
    entry.dropped = answer;
    this.#waiting.delete(entry);
    this.#give(entry.userId);
    entry.controller.abort();
  }

  /** At shutdown: no record survives, and every waiting question answers `answer` at once. */
  close(answer: DroppedAnswer): void {
    this.#closed = true;
    for (const id of [...this.#records.keys()]) this.#forget(id);
    for (const entry of [...this.#waiting]) this.#abort(entry, answer);
  }
}

// The request state

/**
 * What the verify hook leaves for the dispatcher: the record id a state
 * opened to, or a refusal. The hook takes no record: only a call to a page
 * tool can be a confirmation's retry, and the hook runs before the name is
 * known, so the dispatcher takes it for such a call alone (ADR 0026).
 */
export type OpenedState =
  | { kind: 'opened'; id: string }
  /** A bad MAC, expiry, another binding, or no state the codec made. */
  | { kind: 'refused' };

/** What a retry found: the record its state named, taken out of the store, or a refusal. */
export type RetryState =
  | { kind: 'record'; record: ConfirmationRecord }
  /** Forged, expired, reused, dropped, bound to someone else, or no state the codec made. */
  | { kind: 'refused' };

export const REFUSED_RETRY: { readonly kind: 'refused' } = Object.freeze({ kind: 'refused' });

const StatePayloadSchema = z.object({ id: z.string().min(1).max(64) });

export interface ConfirmationCodec {
  /** The state a 2026-07-28 question carries: the record's id, signed and bound to this request's caller. */
  mint(recordId: string, ctx: ServerContext): Promise<string>;
  /** The record id a state carries, or null on any failure: a bad MAC, expiry, another binding, a malformed state. */
  open(state: string, ctx: ServerContext): Promise<string | null>;
}

/**
 * The SDK's HMAC request state codec (createRequestStateCodec), never a
 * hand-rolled one, under a key drawn here once per process, so a restart
 * voids every state. `bind` names the user, the token's OAuth client and the
 * method, which the codec folds into a keyed tag; its TTL is the record's,
 * in whole seconds. The codec signs and does not encrypt, so the payload is
 * only the record's id.
 */
export function createConfirmationCodec(options: {
  ttlMs: number;
  bind: (ctx: ServerContext) => string;
}): ConfirmationCodec {
  const codec = createRequestStateCodec<{ id: string }>({
    key: randomBytes(CODEC_KEY_BYTES),
    ttlSeconds: Math.max(1, Math.ceil(options.ttlMs / 1000)),
    bind: options.bind,
  });
  return {
    mint: (recordId, ctx) => codec.mint({ id: recordId }, ctx),
    async open(state, ctx) {
      let payload: unknown;
      try {
        payload = await codec.verify(state, ctx);
      } catch {
        // The reason ('mac', 'expired', 'bind', 'malformed') answers the same way.
        return null;
      }
      const parsed = StatePayloadSchema.safeParse(payload);
      return parsed.success ? parsed.data.id : null;
    },
  };
}

/**
 * A call to a page tool, as one JSON-RPC message, whose requestState is
 * present and not a string, with the state replaced by FORGED_REQUEST_STATE;
 * any other message, the very same object. Only calls to page tools change,
 * since only they answer not_confirmed with a call line; any other tool keeps
 * the SDK's own refusal.
 */
export function withStringRequestState<T>(message: T, isPageCall: (name: string) => boolean): T {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return message;
  const fields = message as Record<string, unknown>;
  if (fields.method !== 'tools/call') return message;
  const params = fields.params;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return message;
  const { name, requestState } = params as Record<string, unknown>;
  if (!('requestState' in params) || typeof requestState === 'string') return message;
  if (typeof name !== 'string' || !isPageCall(name)) return message;
  // Only the state changes, so the message is the same kind of JSON-RPC message it was.
  return { ...fields, params: { ...params, requestState: FORGED_REQUEST_STATE } } as T;
}

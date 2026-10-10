// The session record's seam (ADR 0045): what the core tells a recorder and
// what it reads back. The record is advisory, so the core holds a recorder
// through this interface alone and tells it of each change only after making
// its own decision: nothing a recorder returns or throws decides how a call
// runs (S5 and S6 never read it). A record holds names the operator's own
// screen already showed, in memory only, and never arguments, results,
// images, page state or secrets. NOOP_RECORDER keeps nothing;
// CoreOptions.recorder lets a test hand the core a recorder of its own.

import type { AttachmentView, Policy, RecordAttachment, SessionRecord } from '@tabdock/protocol';
import type {
  ActivityEntry,
  PageRole,
  PendingProposal,
  ProposalLogEntry,
  SessionEnded,
  SessionView,
} from './core.ts';

export type { SessionRecord } from '@tabdock/protocol';

/**
 * The three records the adapter may hold at once: the one being kept now,
 * the last page-session record sealed by a new page session, and the last
 * time-boxed session's record sealed at its end.
 */
export type RecordWhich = 'current' | 'previous' | 'ended';

/** How a person came in, as an attachment span records it. */
export type RecordHow = RecordAttachment['how'];

/** How the page let one listed user in: what its grant, or autoApprove, says. */
export interface RecordWayIn {
  readonly how: RecordHow;
  /** The invite that made the grant; null for any other way in. */
  readonly inviteId: string | null;
}

/**
 * One record as DockState.records lists it, for the widget's summary line
 * and its choice of what to save: counts and times, never a name.
 */
export interface RecordView {
  readonly which: RecordWhich;
  /** A page session's record, or a time-boxed session's (ADR 0043). */
  readonly scope: 'page' | 'session';
  /** A time-boxed session's label, the page's own words; null for a page session's record. */
  readonly label: string | null;
  /** Local epoch milliseconds at which the record began. */
  readonly from: number;
  /** When it was sealed; null while it is still being kept. */
  readonly to: number | null;
  readonly calls: number;
  readonly people: number;
  /** How many of those people are invitees, whose names are emails (ADR 0017). */
  readonly invitees: number;
  readonly proposals: number;
  /** Calls, spans and proposals the caps pushed out, so a capped record never passes for a whole one. */
  readonly dropped: number;
  /** A recorder fault stopped it: the widget then offers no save, and says the audit log keeps every call. */
  readonly failed: boolean;
}

/** What a saved record says of its page; read only when the operator saves one. */
export interface RecordContext {
  readonly adapterVersion: string;
  /** The page's origin and path as hello sends them, never a query or fragment. */
  readonly origin: string;
  readonly path: string;
  readonly title: string;
  /** The relay's host alone: its URL's path carries nothing a record needs. */
  readonly relay: string;
  readonly policy: Policy;
}

/** A call's place in the record, so its later changes reach the same entry; null when nothing was kept. */
export type RecordHandle = number | null;

/**
 * What the core tells the recorder, each at the moment its own state
 * changes, and what it reads back. Every method is total: a recorder that
 * throws is stopped by the core's guard, never the call it was told about.
 */
export interface Recorder {
  /** A welcome: a new page session seals the page-scope record, a resumed one keeps it. */
  pageSession(pageId: string, resumed: boolean, at: number): void;
  /** The link went: open spans close at this time should the next welcome start a new page session. */
  linkLost(at: number): void;
  /** The relay's roster and the roles the page enforces, so spans open, change role and close. */
  roster(
    attachments: readonly AttachmentView[],
    roles: readonly PageRole[],
    wayIn: (userId: string) => RecordWayIn,
    at: number,
  ): void;
  /** The operator revoked one user, or everyone with '*', so their spans close as revoked. */
  revoking(target: string): void;
  /** A call the adapter accepted (ADR 0045's notes): never the fixed tools, which never reach the page. */
  call(entry: ActivityEntry, pageId: string): RecordHandle;
  /** The call's line changed: its outcome, its duration, or where it was confirmed. */
  update(handle: RecordHandle, entry: ActivityEntry): void;
  /** The operator allowed the call's prompt, or accepted the proposal that ran it (S6). */
  confirmedOnPage(handle: RecordHandle): void;
  /** A proposal the page took (ADR 0042), never its arguments. */
  proposal(proposal: PendingProposal, pageId: string): void;
  /** How a proposal ended, and the call that ran it when one did. */
  proposalSettled(entry: ProposalLogEntry): void;
  /** A time-boxed session began (ADR 0043): the page-scope record is sealed and a session record starts. */
  sessionStarted(session: SessionView): void;
  /** It ended: its record is sealed into `ended` and a page-scope record starts again. */
  sessionEnded(ended: SessionEnded): void;
  /** The records held now, the same frozen list until a count changes. */
  views(): readonly RecordView[];
  /** A fresh, schema-checked copy of one record, or null when there is none. */
  snapshot(which: RecordWhich, context: RecordContext, at: number): SessionRecord | null;
  /** Drops a sealed record, or restarts the current one from `at`. */
  discard(which: RecordWhich, at: number): boolean;
  /** Everything goes: the page detached or unloaded. */
  dropAll(): void;
}

const NO_VIEWS: readonly RecordView[] = Object.freeze([]);

/** A recorder that keeps nothing, so a record is never more than ADR 0045's own recorder makes it. */
export const NOOP_RECORDER: Recorder = Object.freeze({
  pageSession: () => undefined,
  linkLost: () => undefined,
  roster: () => undefined,
  revoking: () => undefined,
  call: () => null,
  update: () => undefined,
  confirmedOnPage: () => undefined,
  proposal: () => undefined,
  proposalSettled: () => undefined,
  sessionStarted: () => undefined,
  sessionEnded: () => undefined,
  views: () => NO_VIEWS,
  snapshot: () => null,
  discard: () => false,
  dropAll: () => undefined,
});

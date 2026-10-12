// The operator's widget (SPEC.md section 8), kept thin: a badge and a panel in
// a closed shadow root, which other frames, and page script going through the
// DOM's own ways in, cannot open. A page script that runs before attach()
// could (by patching attachShadow, say), which is acceptable because the page
// itself is trusted (SPEC.md section 2). Buttons ignore events whose isTrusted
// is false, so page script cannot press Allow by dispatching a click.
// Everything shown comes from the Dock handle, every relay- or page-supplied
// string goes in as text (the pairing URL only as a QR drawing built with DOM
// calls; see qr.ts), nothing goes through an HTML parser, and nothing lands on
// window. Text nodes keep markup out, but not what a caller says of itself:
// its client's name and version, shown beside the page's own words, could
// still break a line to pass for another activity entry, or reverse the words
// after it. So the widget makes them, and every person's name, one plain line
// (plainLine) whatever the relay did, and where page words follow, in the
// activity log and the attach prompt, sets each in a run of its own that
// nothing inside can reach out of; see entryLine.
// From M4 the panel also mints invites (ADR 0017): an invite link shows once,
// as a QR drawing and as text to send, and only until the operator is done
// with it or the invite ends; the adapter keeps no copy of its secret.
// Against scripts that run after attach(), what holds is what the adapter
// took by the time attach() returned. Every DOM call the widget makes on its
// nodes goes through functions dom.ts took at mount (qr.ts's too), so
// patching a DOM prototype afterwards hands a script none of those nodes, and
// so not the shadow root getRootNode() on one would give: the A4.3 review
// found getBoundingClientRect doing that every second. The hold-still wait
// (ARM_DELAY_MS) runs on the window's timers and reads boxes through
// DOMRect's getters, both taken at mount too (here and in dom.ts), so
// patching those afterwards arms no box early and keeps no moved box armed.
// WebCrypto, TextEncoder, Uint8Array, the page link's socket, JSON.parse and
// JSON.stringify are taken likewise (core.ts, index.ts, the protocol's
// page-link.ts), and so is the clipboard's writeText (here). That narrows the
// routes; it is no boundary. The routes known to stay open follow, and they
// may not be all. The widget's own bookkeeping (the Maps, Sets and arrays
// that hold its nodes and boxes) and the text it shows still pass through
// the page's JavaScript built-ins, so a later script that patches one of
// those, or a string method the QR encoder calls, can still reach the nodes,
// rewrite the panel, read what it shows (an invite link included), or arm a
// box the moment it appears. The tab's visibility is read from the page's
// document, so such a script can also keep the tab coming back into view
// from restarting the wait. The operator's answer leaves in a frame that
// still passes through the page's built-ins on its way out (the schema
// check's, and any toJSON the script defines; see index.ts), so a real click
// on Deny can leave the page as Allow. Nor does any of it stop a later script
// misleading the operator without touching the widget at all: its own
// element drawn over the panel can label Allow as Deny, and the operator's
// real click, trusted and on a box that held still, then allows. The
// trusted-page rule (SPEC.md section 2) covers all of this, since such a
// script can run the page's tools itself; docs/threat-model.md (B5) records
// it.
// From M6 the panel also saves the session record (ADR 0045). It leaves the
// page only on a trusted click in an armed box that says how many people it names, as a
// file through the Blob, object URL and click dom.ts took at mount, never
// unasked; the page itself, and scripts before attach(), stay trusted.
// Buttons carry stable data-action attributes, and blocks data-role ones, for
// browser tests and the testing helper; widget-names.ts lists every name.

import {
  type Account,
  type AttachmentView,
  INVITE_BURN_REFUSALS,
  INVITEE_SHORT_ID_CHARS,
  InviteeIdSchema,
  MAX_INVITE_LABEL_CHARS,
  MAX_INVITE_USES,
  MAX_LIVE_AGENTS_PER_PAGE,
  MAX_LIVE_INVITES_PER_PAGE,
  MAX_SESSION_MS,
  MAX_STATE_BYTES,
  plainLine,
  PROPOSALS_ORDER,
  type Role,
  SESSION_EXTEND_MS,
  SESSION_WARNINGS_MS,
  UNVERIFIED_ACCOUNT_NAME,
} from '@tabdock/protocol';
import type {
  ActivityEntry,
  AgentLifetime,
  AgentView,
  Dock,
  DockState,
  InviteJoin,
  InviteLifetime,
  InviteRefusal,
  InviteView,
  LinkState,
  PageRole,
  PendingConfirm,
  PendingProposal,
  PendingRequest,
  SessionLink,
} from './core.ts';
import { sessionSeats } from './core.ts';
import { type BoxRect, takeDom } from './dom.ts';
import { createQrView, inviteQrUrl, QR_SIDE_PX } from './qr.ts';
import {
  sessionRecordFileName,
  sessionRecordJson,
  sessionRecordMarkdown,
} from './record-markdown.ts';
import type { RecordView, RecordWhich } from './record.ts';
import { apply, taken } from './taken.ts';
import { HOST_TAG, type WidgetAction, type WidgetRole } from './widget-names.ts';

/**
 * A box's buttons ignore clicks until the box has held still this long since
 * it appeared or last moved, so a click aimed at one button never lands on
 * another that just slid under the pointer. Prompts are boxes, and so are
 * roster rows, the pause control and the Invite form, since Make driver,
 * Resume and Create grant access as surely as Allow does. Each box is
 * measured rather than guessed at: the relay controls text that can shift it
 * (a roster name that wraps, a longer pairing code, an error), and the panel
 * can scroll. Boxes are timed one by one, so prompts arriving on top, which
 * move nothing below them, never keep an older prompt disarmed. A box whose
 * buttons change meaning (a role switch that flips, Pause turning into
 * Resume, the Invite form switching between Can watch and Can control) waits
 * again too. A tab coming back into view, or its window into focus, restarts
 * every box's wait, since the operator is seeing the boxes afresh.
 * data-armed shows the state, for people and for browser tests.
 */
const ARM_DELAY_MS = 500;

/**
 * How long a line saying someone joined by invite stays, the notice ADR 0016
 * asks for. It counts only while the panel is open on a visible tab, so no
 * notice is gone before anyone could have read it.
 */
const JOIN_NOTICE_MS = 20_000;

const LINK_LABELS: Record<LinkState, string> = {
  idle: 'Idle',
  connecting: 'Connecting',
  linked: 'Linked',
  reconnecting: 'Reconnecting',
  closed: 'Closed',
};

const LIFETIME_CHOICES: readonly (readonly [InviteLifetime, string])[] = [
  ['15m', '15 minutes'],
  ['1h', '1 hour'],
  ['open', 'While the page is open'],
];

/** What the operator reads when no link came back, by reason. */
const REFUSAL_TEXT: Record<InviteRefusal, string> = {
  no_sponsor: 'The relay found no member attached to sponsor it. Pair one first.',
  policy: 'This page does not allow that kind of invite.',
  limit: `This page already has ${MAX_LIVE_INVITES_PER_PAGE} live invites. Cancel one first.`,
  duplicate: 'The relay already held an invite like it. Try again.',
  no_public_url: 'This relay has no public URL, so it makes no invite links.',
  expired:
    "This computer's clock is behind the relay's, so the invite would have expired. Check the clock.",
  invalid: `Give it a label of up to ${MAX_INVITE_LABEL_CHARS} characters, and from 1 to ${MAX_INVITE_USES} uses.`,
  link_down: 'The link to the relay is down. Try again once it is back.',
  unavailable:
    'No link came back: the relay did not answer, or this page cannot make one (it needs https).',
  cancelled: 'The invite was closed before the relay answered.',
};

// The M6 blocks' rules, a labelled section each with its own dark-mode
// rules, so each workstream edits its own lines alone (plan section 2.6).
/**
 * The page state line (ADR 0040) needs no rules of its own: a muted line,
 * wrapped within the panel's width like every other, so none are added.
 */
const STATE_STYLE = '';

/** The state line for each status but 'none', which hides it. */
const STATE_LINES = {
  shared: 'This page shares its state with everyone attached, invited people included.',
  paused: 'Page state is held while paused.',
  too_large: `Page state not shared: over ${String(MAX_STATE_BYTES)} bytes.`,
  invalid: 'Page state not shared: not a JSON object.',
  unsupported: 'This relay does not take page state.',
} as const;
/**
 * The proposal queue and its badge (ADR 0042). The list scrolls within its
 * own height, so twenty rows never push the rest of the panel off a phone's
 * screen, and arguments are the caller's words: isolated, wrapped anywhere,
 * cut to a few lines until Show all.
 */
const PROPOSALS_STYLE = `
.proposals { max-height: min(45vh, 28em); overflow-y: auto; }
.args { margin: 2px 0; padding: 2px 4px; border: 1px dashed #9ca3af; border-radius: 4px; max-height: 4.2em;
  overflow: hidden; white-space: pre-wrap; overflow-wrap: anywhere; unicode-bidi: isolate;
  font: 12px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.args.open { max-height: 12em; overflow-y: auto; }
.accepted { padding: 0 6px; border-radius: 10px; background: #e0e7ff; color: #312e81; }
@media (prefers-color-scheme: dark) { .accepted { background: #312e81; color: #e0e7ff; } }`;

/** Characters of a proposal's arguments shown before Show all. */
const ARGS_SHOWN = 160;
/** The time-boxed session's form, countdown and badge (ADR 0043). */
const SESSION_STYLE = '';
/**
 * The roster's Watching section and compact rows (ADR 0044): one line each,
 * at least a finger tall, the name cut short before the short id is. A row
 * too narrow for its buttons beside 4em of name (a control guest's Make
 * driver at 360 px) puts them on a line below, right-aligned, rather than
 * past the list's edge. The list scrolls inside the panel, under 50vh, so
 * the panel around it, and Revoke all below it, stay where they are.
 */
const ROSTER_STYLE = `
.compact, .whead { display: flex; align-items: center; gap: 6px; }
.compact { flex-wrap: wrap; min-height: 44px; margin: 0 0 4px; padding: 2px 8px; }
.compact > * { flex: none; }
.compact > .nm { flex: 1 1 4em; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 600; }
.compact > .buttons { margin: 0 0 0 auto; }
.watch { max-height: 50vh; overflow: auto; }
.whead { justify-content: space-between; margin: 10px 0 2px; }
`;

/** Past this many rows the Watching section starts closed and offers a filter. */
const COMPACT_ROWS = 8;
/**
 * Agent tokens in the invite form and list (ADR 0044) need no rules of their
 * own: the command is shown as the invite link's text is, and the list's
 * rows are the invite list's.
 */
const AGENTS_STYLE = '';

/** What each state of a live agent token means to the operator. */
const AGENT_STATES = {
  dormant: 'not used yet',
  asking: 'asking now',
  attached: 'attached',
} as const;
/** The session record's choices, one to a line so a long one wraps at phone width (ADR 0045). */
const RECORD_STYLE = '.col { flex-direction: column; }';

const STYLE = `
:host { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
  font: 13px/1.4 system-ui, sans-serif; color: #1f2937; color-scheme: light dark; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.badge { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px;
  border: 1px solid #cbd5e1; background: #fff; color: inherit; font: inherit; cursor: pointer;
  box-shadow: 0 2px 8px rgb(0 0 0 / 0.15); }
.badge.attention { border-color: #d97706; box-shadow: 0 0 0 3px rgb(217 119 6 / 0.35); }
.dot { width: 9px; height: 9px; border-radius: 50%; background: #9ca3af; }
.dot.linked { background: #16a34a; }
.dot.connecting, .dot.reconnecting { background: #d97706; }
.dot.closed { background: #dc2626; }
.count { min-width: 20px; padding: 0 6px; border-radius: 10px; background: #e5e7eb; text-align: center; }
.tag { padding: 0 6px; border-radius: 10px; background: #b91c1c; color: #fff; font-size: 11px;
  letter-spacing: 0.04em; text-transform: uppercase; }
.invited { margin-left: 6px; padding: 0 6px; border-radius: 10px; background: #dbeafe; color: #1e3a8a;
  font-size: 11px; font-weight: 400; }
.invited:empty { display: none; }
/* Only as tall as its content, up to just above the badge: a panel that scrolls moves every box in it. */
.panel { width: 360px; max-width: calc(100vw - 32px); max-height: calc(100vh - 88px); overflow: auto; padding: 12px;
  border-radius: 12px; border: 1px solid #cbd5e1; background: #fff; box-shadow: 0 6px 24px rgb(0 0 0 / 0.2);
  overflow-wrap: anywhere; }
.label { margin: 10px 0 2px; font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; color: #6b7280; }
.code { font: 600 26px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: 0.08em;
  user-select: all; }
/* The QR code beside the typed code, whose basis is the code's own width, so a
   panel too narrow for both (a phone's) puts the code below the QR rather than
   breaking it. The QR is taller than the text beside it, so a longer expiry
   line never moves the boxes around the pairing block. */
.pair { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
.pair-text { flex: 1 1 196px; min-width: 0; }
/* Light ground in every theme, quiet zone included, as scanners need dark on light.
   The drawing carries its own ground and size too (qr.ts), should these styles not apply. */
.qr { flex: none; width: ${QR_SIDE_PX}px; height: ${QR_SIDE_PX}px; background: #fff; }
.qr svg { display: block; width: 100%; height: 100%; }
.muted { margin: 2px 0; color: #6b7280; }
.error { margin: 0 0 8px; color: #b91c1c; }
.notice { margin: 0 0 8px; color: #92400e; }
.join { margin: 0 0 8px; color: #1e3a8a; }
.prompt { margin: 0 0 8px; padding: 8px; border: 1px solid #d97706; border-radius: 8px; background: #fffbeb; }
.prompt p { margin: 0 0 4px; }
.buttons { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 4px; }
.action { padding: 4px 8px; border-radius: 6px; border: 1px solid #9ca3af; background: #f9fafb; color: inherit;
  font: inherit; cursor: pointer; }
.action.primary { border-color: #1d4ed8; background: #1d4ed8; color: #fff; }
.action:disabled { opacity: 0.5; cursor: default; }
.action[data-armed='false'] { opacity: 0.6; cursor: default; }
ul, ol { margin: 2px 0 0; padding: 0; list-style: none; }
li { padding: 2px 0; }
.row { margin: 0 0 6px; padding: 6px 8px; border: 1px solid #e5e7eb; border-radius: 8px; }
.row p { margin: 0; }
.row .buttons { margin: 4px 0 0; }
/* One line whatever the clients call themselves, so a growing list never moves a row. */
.clients { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.who { font-weight: 600; }
.check { display: inline-flex; align-items: center; gap: 4px; }
.field { display: block; margin: 6px 0 2px; }
.field input { display: block; width: 100%; margin-top: 2px; padding: 4px 6px; border-radius: 6px;
  border: 1px solid #9ca3af; background: #fff; color: inherit; font: inherit; }
.field input[type='number'] { width: 6em; }
.choices { display: flex; flex-wrap: wrap; gap: 2px 12px; margin: 6px 0 2px; }
.choices label { display: inline-flex; align-items: center; gap: 4px; }
.link-text { margin: 4px 0; font: 12px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  user-select: all; }
.activity { height: 6.5em; overflow-y: auto; padding: 2px 6px; border: 1px solid #e5e7eb; border-radius: 6px;
  font-size: 12px; }
/* Each entry ruled off, its time in a column of its own: whatever an entry
   holds wraps beside the time, so no text can start a line where a time goes. */
.activity li { display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: 6px; padding: 1px 0;
  border-top: 1px solid #e5e7eb; }
.activity li:first-child { border-top: none; }
.activity .time { color: #6b7280; font-variant-numeric: tabular-nums; }
.activity [data-outcome='running'] { color: #92400e; }
/* What a caller says of itself, or a person's name: isolated, so none of it
   can reorder the words around it. A client's name also stays on one line,
   cut short with an ellipsis, so it cannot wrap into what looks like an entry. */
.claimed { unicode-bidi: isolate; }
.quoted { white-space: nowrap; }
.client { display: inline-block; max-width: min(14em, calc(100% - 1em)); overflow: hidden; white-space: nowrap;
  text-overflow: ellipsis; vertical-align: bottom; unicode-bidi: isolate; }
/* ADR 0026's mark, built by the page alone: a ground of its own that no client's text can draw. */
.confirmed { padding: 0 6px; border-radius: 10px; background: #dcfce7; color: #14532d; }
.pause { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 10px 0 0;
  padding: 6px 8px; border: 1px solid #e5e7eb; border-radius: 8px; }
.pause.paused { border-color: #b91c1c; }
@media (prefers-color-scheme: dark) {
  :host { color: #e5e7eb; }
  .badge, .panel { background: #111827; border-color: #374151; }
  .count { background: #374151; }
  .prompt { background: #3b2a06; }
  .row, .activity, .activity li, .pause { border-color: #374151; }
  .action, .field input { background: #1f2937; border-color: #4b5563; }
  .invited { background: #1e3a8a; color: #dbeafe; }
  .confirmed { background: #14532d; color: #dcfce7; }
  .muted, .label, .activity .time { color: #9ca3af; }
  .error { color: #fca5a5; }
  .join { color: #93c5fd; }
  .notice, .activity [data-outcome='running'] { color: #fcd34d; }
}
${STATE_STYLE}${PROPOSALS_STYLE}${SESSION_STYLE}${ROSTER_STYLE}${AGENTS_STYLE}${RECORD_STYLE}`;

/** A box whose buttons take a click only once it has held still; see ARM_DELAY_MS. */
interface ArmedBox {
  readonly element: HTMLElement;
  /** Its buttons, kept here rather than looked up in the tree. */
  readonly buttons: HTMLButtonElement[];
  /** Where the box was when it appeared or last moved; null until first measured. */
  rect: BoxRect | null;
  armed: boolean;
  timer: number | undefined;
}

interface PromptView extends ArmedBox {
  readonly countdown: HTMLElement;
  readonly expiresAt: number;
}

interface RowView extends ArmedBox {
  /** A one-line row in the Watching section (ADR 0044): name, short id, badge and buttons only. */
  readonly compact: boolean;
  readonly name: HTMLElement;
  /** A compact row's short id, apart from the name, so cutting a long name never cuts it. */
  readonly sid: HTMLElement;
  readonly badge: HTMLElement;
  readonly clients: HTMLElement;
  readonly expiry: HTMLElement;
  /** "and close this link", shown for someone a multi-use invite let in. */
  readonly closeLink: HTMLElement;
  readonly closeInput: HTMLInputElement;
  roleSwitch: HTMLButtonElement;
  /** Whom the buttons act on and what they do; when it changes, the row waits again. */
  key: string;
  /** The role the page enforces, which the switch offers the other of; null hides the switch. */
  role: Role | null;
  expiresAt: number | null;
}

/** One waiting proposal (ADR 0042): an armed box, as its Accept runs a write. */
interface ProposalRow extends ArmedBox {
  accept: HTMLButtonElement;
  readonly countdown: HTMLElement;
  /** "Resume the page to accept", shown while paused (decision 13). */
  readonly paused: HTMLElement;
  readonly expiresAt: number;
}

interface PauseView extends ArmedBox {
  readonly text: HTMLElement;
  toggle: HTMLButtonElement;
  /** null until the first render. */
  paused: boolean | null;
}

/** One join notice on show; see JOIN_NOTICE_MS. */
interface JoinLine {
  readonly element: HTMLElement;
  /** Milliseconds it has been on screen before `since`. */
  shownMs: number;
  /** Since when it has been on screen without a break, or null while it is not. */
  since: number | null;
  /** Whether it has been on screen at all; until then the badge asks for attention. */
  seen: boolean;
}

interface InviteRowView {
  readonly element: HTMLElement;
  readonly title: HTMLElement;
  readonly detail: HTMLElement;
  view: InviteView;
}

function sameRect(a: BoxRect | null, b: BoxRect): boolean {
  return (
    a !== null &&
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height
  );
}

/** Whether two lists hold the same nodes in the same order. */
function sameNodes(a: readonly Node[], b: readonly Node[]): boolean {
  return a.length === b.length && a.every((node, i) => node === b[i]);
}

function secondsLeft(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
}

function clockText(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Relative and coarse: the relay's clock can differ from this one, and minutes are what the operator needs. */
function expiryText(expiresAt: number | null): string {
  if (expiresAt === null) return 'No expiry set';
  const minutes = Math.ceil((expiresAt - Date.now()) / 60_000);
  if (minutes <= 0) return 'Expiring now';
  if (minutes < 60) return `Expires in ${minutes} min`;
  return `Expires in ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * A client as it names itself, made one plain line here too, since the
 * adapter does not trust the relay to have done it; empty when nothing is left.
 */
function clientText(client: { name: string; version: string }): string {
  return plainLine(`${client.name} ${client.version}`);
}

/**
 * Who an activity line's badge names for a call the page ran without asking
 * because the caller confirmed it in their own client (ADR 0026): the client
 * as it names itself (null when it gave no name) and the person, so the
 * operator sees after the fact every call nobody confirmed here. null for
 * every other call. The widget builds the badge itself and sets each name in
 * a run of its own, so a client's name can neither imitate the badge nor
 * reorder it.
 */
export function confirmedIn(
  entry: ActivityEntry,
): { readonly client: string | null; readonly person: string } | null {
  if (entry.confirmedBy !== 'client') return null;
  const client = entry.client === null ? '' : clientText(entry.client);
  return { client: client === '' ? null : client, person: personText(entry.user) };
}

/**
 * What an activity line says of an image a call returned (ADR 0039), such as
 * "image, PNG, 47 KB": its type and size, never what it shows, so the
 * operator sees each time someone's client took a picture of the page. null
 * for every other call.
 */
export function imageText(entry: ActivityEntry): string | null {
  if (entry.image === null) return null;
  const kb = entry.image.bytes / 1024;
  return `image, ${entry.image.mimeType.slice(6).toUpperCase()}, ${kb < 10 ? kb.toFixed(1) : String(Math.round(kb))} KB`;
}

function timeText(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour12: false });
}

/** The first characters of an invitee's account key, which the widget always shows beside their name (ADR 0017). */
function shortId(userId: string): string | null {
  return InviteeIdSchema.safeParse(userId).success
    ? userId.slice(2, 2 + INVITEE_SHORT_ID_CHARS)
    : null;
}

/**
 * How the widget names a person: a member by their name, an invitee by
 * their verified email, or "unverified account", always with the short id,
 * since a name alone could copy someone else's (S10). The name is made one
 * plain line, as a client's is, and a member's that leaves nothing shows
 * their id.
 */
function personText(user: { userId: string; displayName: string }, account?: Account): string {
  const id = shortId(user.userId);
  const shown = plainLine(user.displayName);
  if (id === null) return shown === '' ? user.userId : shown;
  const name = account?.verified === false ? UNVERIFIED_ACCOUNT_NAME : shown;
  return `${name} (${id})`;
}

/**
 * "<who> wants", or "You want" for local mode's one user, whom the relay
 * names You (LOCAL_USER in local-token.ts); any name that reads You takes
 * the verb as you would.
 */
function wants(who: string): string {
  return who === 'You' ? `${who} want` : `${who} wants`;
}

/** Whether a roster entry came in by invite, or is an invitee: either way it carries the "invited" badge. */
function invited(attachment: AttachmentView): boolean {
  return attachment.inviteId !== null || attachment.kind === 'invitee';
}

function roleText(role: Role): string {
  return role === 'driver' ? 'Can control' : 'Can watch';
}

function inviteDetail(view: InviteView): string {
  const joined =
    view.uses === 1 ? `${view.joined} joined` : `${view.joined} of ${view.uses} joined`;
  const ends =
    view.expiresAt === null
      ? 'open while this page is, 24 h at most'
      : expiryText(view.expiresAt).toLowerCase();
  const parts = [joined, ends, `shared by ${view.sponsor.displayName}`];
  if (view.pending) parts.push('someone is waiting');
  if (view.role === 'driver' && view.refusals > 0) {
    parts.push(`${view.refusals} of ${INVITE_BURN_REFUSALS} refusals`);
  }
  return parts.join(', ');
}

/**
 * Styles the shadow root, preferring a constructed stylesheet: a page's CSP
 * refuses an inline <style> unless its style-src allows 'unsafe-inline', but
 * no style-src governs a sheet built through the CSSOM, and the adapter runs
 * on pages whose policy it does not control. The sheet comes from the
 * document's own window, since a sheet constructed for another document
 * cannot be adopted. Returns the <style> element to append instead, only
 * where the browser cannot adopt sheets.
 */
function adoptStyle(root: ShadowRoot, doc: Document): HTMLStyleElement | null {
  const Sheet = doc.defaultView?.CSSStyleSheet;
  if (Sheet !== undefined && 'adoptedStyleSheets' in root) {
    try {
      const sheet = new Sheet();
      sheet.replaceSync(STYLE);
      root.adoptedStyleSheets = [sheet];
      return null;
    } catch {
      // A browser that lists the API but will not build the sheet: the element still works.
    }
  }
  const style = doc.createElement('style');
  style.textContent = STYLE;
  return style;
}

/**
 * The clipboard's writeText, bound once, when the widget mounts:
 * Clipboard.prototype stays open to page scripts, and one that ran after
 * attach() and patched it would otherwise be handed every invite link the
 * operator copies. null where the page has no clipboard, as outside a
 * secure context.
 */
function clipboardWriter(doc: Document): ((text: string) => Promise<void>) | null {
  const navigator = doc.defaultView?.navigator;
  const clipboard: unknown = navigator ? Reflect.get(navigator, 'clipboard') : undefined;
  if (typeof clipboard !== 'object' || clipboard === null) return null;
  const write: unknown = Reflect.get(clipboard, 'writeText');
  return typeof write === 'function'
    ? (write as (text: string) => Promise<void>).bind(clipboard)
    : null;
}

/** The window's timers as the widget mounted; see takeTimers. */
interface WidgetTimers {
  after(run: () => void, ms: number): number;
  cancel(id: number | undefined): void;
  every(run: () => void, ms: number): number;
  stop(id: number): void;
}

/**
 * The window's timers, taken when the widget mounts and called through the
 * Reflect.apply taken.ts took. The hold-still wait (ARM_DELAY_MS) runs on
 * them, so a page script that ran after attach() and swapped setTimeout for
 * one that fires at once, or clearTimeout for one that cancels nothing, would
 * otherwise arm a box before it had held still.
 */
function takeTimers(doc: Document): WidgetTimers {
  const scope: object = doc.defaultView ?? globalThis;
  const setTimer = taken(scope, 'setTimeout', 'value');
  const clearTimer = taken(scope, 'clearTimeout', 'value');
  const setRepeat = taken(scope, 'setInterval', 'value');
  const clearRepeat = taken(scope, 'clearInterval', 'value');
  return Object.freeze({
    after: (run: () => void, ms: number) => apply(setTimer, scope, [run, ms]) as number,
    cancel: (id: number | undefined) => {
      apply(clearTimer, scope, [id]);
    },
    every: (run: () => void, ms: number) => apply(setRepeat, scope, [run, ms]) as number,
    stop: (id: number) => {
      apply(clearRepeat, scope, [id]);
    },
  });
}

/** Mounts the widget for one Dock and returns a function that removes it. */
export function mountWidget(dock: Dock, doc: Document = document): () => void {
  // Before anything else, and inside attach(): every DOM call on the widget's nodes from here goes through it.
  const dom = takeDom(doc);
  const timers = takeTimers(doc);
  const host = doc.createElement(HOST_TAG);
  const root = host.attachShadow({ mode: 'closed' });
  const writeClipboard = clipboardWriter(doc);

  function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = '',
    text = '',
  ): HTMLElementTagNameMap[K] {
    const node = dom.create(tag);
    if (className) dom.attr(node, 'class', className);
    if (text) dom.setText(node, text);
    return node;
  }

  /** A block placed now and filled later, hidden until then so the panel looks as it did. */
  function hiddenBlock<K extends 'div' | 'p'>(tag: K): HTMLElementTagNameMap[K] {
    const node = element(tag);
    dom.flag(node, 'hidden', true);
    return node;
  }

  /** Every armed box on show: prompts, roster rows, the pause control and the Invite form. */
  const boxes = new Set<ArmedBox>();
  const requestViews = new Map<string, PromptView>();
  const confirmViews = new Map<string, PromptView>();
  const rowViews = new Map<string, RowView>();
  const inviteRows = new Map<string, InviteRowView>();

  /** Every data-action goes through here, so only a name WIDGET_ACTIONS lists can be set. */
  function setAction(node: Element, action: WidgetAction): void {
    dom.attr(node, 'data-action', action);
  }

  /** Every data-role goes through here, so only a name WIDGET_ROLES lists can be set. */
  function role(node: Element, name: WidgetRole): void {
    dom.attr(node, 'data-role', name);
  }

  function button(label: string, action: WidgetAction, onClick: () => void, primary = false) {
    const node = element('button', primary ? 'action primary' : 'action', label);
    dom.attr(node, 'type', 'button');
    setAction(node, action);
    dom.listen(node, 'click', (event) => {
      // Page script can dispatch a click, but never a trusted one.
      if (!event.isTrusted) return;
      onClick();
    });
    return node;
  }

  /** The "invited" badge; empty, and so not shown, for anyone else. */
  function badge(show: boolean): HTMLElement {
    const node = element('span', 'invited', show ? 'invited' : '');
    role(node, 'invited');
    return node;
  }

  /** A person's name, isolated from the words around it. */
  function person(text: string): HTMLElement {
    return element('span', 'claimed', text);
  }

  /**
   * A client's name and version in the page's quotes, isolated and kept to
   * one line cut short with an ellipsis, so whatever it says stays inside
   * them; the quotes never wrap away from it.
   */
  function quotedClient(text: string): HTMLElement {
    const node = element('span', 'quoted');
    dom.append(node, '"', element('span', 'client', text), '"');
    return node;
  }

  /**
   * ADR 0026's mark for a call confirmed in the caller's client: the page's
   * own words on a ground of their own, naming the client and the person in
   * runs of their own, so no client's name can draw one or turn it around.
   */
  function confirmedBadge(confirmed: {
    readonly client: string | null;
    readonly person: string;
  }): HTMLElement {
    const node = element('span', 'confirmed');
    role(node, 'confirmed');
    if (confirmed.client === null) dom.append(node, 'confirmed in their client');
    else dom.append(node, 'confirmed in ', quotedClient(confirmed.client));
    dom.append(node, ' by ', person(confirmed.person));
    return node;
  }

  function setArmed(box: ArmedBox, value: boolean): void {
    box.armed = value;
    for (const node of box.buttons) {
      dom.attr(node, 'data-armed', String(value));
      dom.attr(node, 'aria-disabled', String(!value));
    }
  }

  /** Records where the box is now and disarms it until it has stayed there for ARM_DELAY_MS. */
  function restartArming(box: ArmedBox): void {
    timers.cancel(box.timer);
    box.rect = dom.rect(box.element);
    setArmed(box, false);
    box.timer = timers.after(() => {
      // A move nobody noticed in between starts the wait again.
      if (sameRect(box.rect, dom.rect(box.element))) setArmed(box, true);
      else restartArming(box);
    }, ARM_DELAY_MS);
  }

  /** Restarts the wait of every box that is new or no longer where it was. */
  function checkMoves(): void {
    for (const box of boxes) {
      if (!sameRect(box.rect, dom.rect(box.element))) restartArming(box);
    }
  }

  function newBox(element: HTMLElement): ArmedBox {
    return { element, buttons: [], rect: null, armed: false, timer: undefined };
  }

  function dropBox(box: ArmedBox): void {
    timers.cancel(box.timer);
    dom.remove(box.element);
    boxes.delete(box);
  }

  /** A button inside an armed box, which only takes a click while its box is armed. */
  function boxButton(
    box: ArmedBox,
    label: string,
    action: WidgetAction,
    onClick: () => void,
    primary = false,
  ) {
    const node = button(
      label,
      action,
      () => {
        // Checked again here, as a shift may land between the last check and the click.
        if (!box.armed || !sameRect(box.rect, dom.rect(box.element))) {
          restartArming(box);
          return;
        }
        onClick();
      },
      primary,
    );
    dom.attr(node, 'data-armed', String(box.armed));
    dom.attr(node, 'aria-disabled', String(!box.armed));
    box.buttons.push(node);
    return node;
  }

  function newPrompt(box: HTMLElement, expiresAt: number): PromptView {
    return { ...newBox(box), countdown: element('p', 'muted'), expiresAt };
  }

  const style = adoptStyle(root, doc);

  const panel = element('section', 'panel');
  dom.flag(panel, 'hidden', true);
  dom.attr(panel, 'aria-label', 'Tabdock');
  const errorLine = element('p', 'error');
  const noticeLine = element('p', 'notice');
  // Who just joined by a Can watch invite, with no prompt to say so (ADR 0016).
  const joins = element('div');
  role(joins, 'joins');
  dom.attr(joins, 'aria-live', 'polite');
  const prompts = element('div');
  dom.attr(prompts, 'aria-live', 'polite');

  // The M6 blocks, each hidden until the workstream that owns it fills it,
  // and placed in the panel in the order plan C22 fixes; see the append below.
  /** The session record's offer at a session's end (ADR 0045), right under the prompts. */
  const recordOfferBox = hiddenBlock('div');
  role(recordOfferBox, 'record-offer');
  /** Proposals waiting for the operator (ADR 0042). */
  const proposalsBlock = hiddenBlock('div');
  role(proposalsBlock, 'proposals');
  /** The time-boxed session's form, or the running session (ADR 0043). */
  const sessionBlock = hiddenBlock('div');
  role(sessionBlock, 'session');
  /** Agent tokens beside the invites (ADR 0044). */
  const agentsBlock = hiddenBlock('div');
  /** The session record: what it holds, and Save (ADR 0045). */
  const recordBlock = hiddenBlock('div');
  /** Whether the page's state reaches the relay (ADR 0040). */
  const stateLine = hiddenBlock('p');
  role(stateLine, 'state-line');

  const pairing = element('div');
  const code = element('div', 'code');
  role(code, 'pairing-code');
  const expiry = element('p', 'muted');
  const rotate = button('New code', 'rotate', () => {
    dock.rotatePairing();
  });
  // Shown only when the relay sent a pairing URL the QR module accepts.
  const qr = createQrView(doc);
  const qrBox = element('div', 'qr');
  role(qrBox, 'pairing-qr');
  dom.flag(qrBox, 'hidden', true);
  dom.append(qrBox, qr.element);
  const pairText = element('div', 'pair-text');
  dom.append(pairText, code, expiry, rotate);
  const pairRow = element('div', 'pair');
  dom.append(pairRow, qrBox, pairText);
  dom.append(pairing, element('div', 'label', 'Pairing code'), pairRow);

  const roster = element('ul');
  role(roster, 'roster');
  const nobody = element('p', 'muted', 'Nobody yet');
  // Revoking only takes access away, so it is not held back like the boxes,
  // though it asks first while invites let people in (askFirst).
  const revokeAll = button('Revoke all', 'revoke-all', () => {
    askFirst('*', true, () => dock.revoke('*'));
  });
  const peopleLabel = element('div', 'label');

  // Plan C21: Revoke on a sponsor's row, and Revoke all, ask first while
  // anyone that sponsor's invites let in is still attached, since their
  // access ends with it (ADR 0017's sponsor rule). One box for either, armed,
  // so the click that asked can never also answer.
  const confirmBox = element('div', 'prompt');
  dom.flag(confirmBox, 'hidden', true);
  const revokeView = newBox(confirmBox);
  boxes.add(revokeView);
  const confirmText = element('p');
  /** What Revoke anyway does, and whose row asked; null while nothing is asked. */
  let asking: { userId: string; go: () => void } | null = null;
  const confirmButtons = element('div', 'buttons');
  dom.append(
    confirmButtons,
    boxButton(revokeView, 'Revoke anyway', 'revoke-anyway', () => {
      const go = asking?.go;
      unask();
      go?.();
    }),
    button('Keep', 'revoke-keep', unask),
  );
  dom.append(confirmBox, confirmText, confirmButtons);

  // ADR 0044: invitees watching by invite, in a compact section of their own
  // under the people, collapsed past COMPACT_ROWS rows behind an armed
  // toggle, filterable, and scrolling inside the panel, so prompts and Revoke
  // all stay in reach with a class attached.
  const watching = hiddenBlock('div');
  role(watching, 'watching');
  const watchHead = element('div', 'whead');
  const watchTitle = element('span');
  const watchView = newBox(watchHead);
  boxes.add(watchView);
  /** The operator's choice for a section past COMPACT_ROWS rows; closed until they open it. */
  let watchOpen = false;
  const watchToggle = boxButton(watchView, '', 'watching-toggle', () => {
    watchOpen = !watchOpen;
    // Show turned into Hide, so the box waits again.
    restartArming(watchView);
    render(dock.state);
  });
  dom.append(watchHead, watchTitle, watchToggle);
  const watchFilter = element('label', 'field', 'Find a name or short id');
  role(watchFilter, 'watching-filter');
  const filterInput = element('input');
  dom.attr(filterInput, 'autocomplete', 'off');
  setAction(filterInput, 'watching-filter');
  dom.append(watchFilter, filterInput);
  dom.listen(filterInput, 'input', () => {
    render(dock.state);
  });
  // ADR 0016's "and close this link", once for the section: checked whenever
  // it appears and again after each Revoke it served, so unticking it spares
  // one link once, as a full row's box does.
  const closeAll = element('label', 'check');
  const closeAllInput = element('input');
  dom.attr(closeAllInput, 'type', 'checkbox');
  setAction(closeAllInput, 'close-link');
  dom.setChecked(closeAllInput, true);
  dom.append(closeAll, closeAllInput, 'Revoke closes their link');
  const watchList = element('ul', 'watch');
  // A scrolled list, or panel, moves every box in it, so each waits again at
  // once rather than at the next tick: a long roster scrolls at phone width.
  dom.listen(watchList, 'scroll', checkMoves);
  dom.listen(panel, 'scroll', checkMoves);
  dom.append(watching, watchHead, watchFilter, closeAll, watchList);

  const rosterBlock = element('div');
  dom.append(rosterBlock, peopleLabel, roster, nobody, confirmBox, watching, revokeAll);

  // Invites (ADR 0017): the link shown once, the live list, and the form.
  const invitesBlock = element('div');
  role(invitesBlock, 'invites');
  dom.flag(invitesBlock, 'hidden', true);

  const linkBox = element('div', 'prompt');
  role(linkBox, 'invite-link');
  dom.flag(linkBox, 'hidden', true);
  const linkHeading = element('p');
  const linkQr = createQrView(doc, {
    accept: inviteQrUrl,
    label: 'Invite QR code: scan it with a phone to join',
  });
  const linkQrBox = element('div', 'qr');
  role(linkQrBox, 'invite-qr');
  dom.append(linkQrBox, linkQr.element);
  const linkText = element('p', 'link-text');
  role(linkText, 'invite-link-text');
  const copyLink = button('Copy link', 'invite-copy', () => {
    copyShown(shownLink?.link, copyLink, 'Select the link to copy it');
  });
  const doneLink = button('Done', 'invite-done', () => {
    hideLink();
  });
  const linkButtons = element('div', 'buttons');
  dom.append(linkButtons, copyLink, doneLink);
  dom.append(linkBox, linkHeading, linkQrBox, linkText, linkButtons);
  /** The link on show and its invite, or null; Copy reads it here, never back from the tree. */
  let shownLink: { readonly inviteId: string; readonly link: string } | null = null;

  const inviteList = element('ul');
  role(inviteList, 'invite-list');
  const noInvites = element('p', 'muted', 'No live invites');
  const inviteError = element('p', 'error');
  role(inviteError, 'invite-error');
  dom.flag(inviteError, 'hidden', true);
  const inviteToggle = button('Invite someone', 'invite-open', () => {
    // Any hidden attribute, 'until-found' too, means closed.
    setFormOpen(dom.has(formBox, 'hidden'));
  });

  // The form is an armed box: Create grants access, as Allow does.
  const formBox = element('div', 'row');
  role(formBox, 'invite-form');
  dom.flag(formBox, 'hidden', true);
  const formView = newBox(formBox);
  boxes.add(formView);
  const labelField = element('label', 'field', 'Label, shown wherever the invite is');
  const labelInput = element('input');
  dom.attr(labelInput, 'type', 'text');
  dom.attr(labelInput, 'maxlength', String(MAX_INVITE_LABEL_CHARS));
  dom.attr(labelInput, 'autocomplete', 'off');
  dom.attr(labelInput, 'spellcheck', 'false');
  dom.attr(labelInput, 'placeholder', 'Who is it for?');
  setAction(labelInput, 'invite-label');
  dom.append(labelField, labelInput);

  function choice(
    group: string,
    value: string,
    text: string,
    action: WidgetAction,
  ): { label: HTMLLabelElement; input: HTMLInputElement } {
    const label = element('label');
    const input = element('input');
    dom.attr(input, 'type', 'radio');
    dom.attr(input, 'name', group);
    dom.attr(input, 'value', value);
    setAction(input, action);
    dom.append(label, input, text);
    return { label, input };
  }

  const roleChoices = element('div', 'choices');
  dom.attr(roleChoices, 'role', 'radiogroup');
  dom.attr(roleChoices, 'aria-label', 'What the invite allows');
  const watchChoice = choice(
    'invite-role',
    'observer',
    roleText('observer'),
    'invite-role-observer',
  );
  const controlChoice = choice('invite-role', 'driver', roleText('driver'), 'invite-role-driver');
  // An agent token (ADR 0044): watching only, for a client that cannot sign in.
  const agentChoice = choice(
    'invite-role',
    'agent',
    'Agent (Claude Code, no sign-in)',
    'invite-kind-agent',
  );
  dom.setChecked(watchChoice.input, true);
  dom.append(roleChoices, watchChoice.label, controlChoice.label, agentChoice.label);

  const lifetimeChoices = element('div', 'choices');
  dom.attr(lifetimeChoices, 'role', 'radiogroup');
  dom.attr(lifetimeChoices, 'aria-label', 'How long the link works');
  const lifetimeInputs = LIFETIME_CHOICES.map(([value, text]) => {
    const made = choice('invite-lifetime', value, text, `invite-lifetime-${value}`);
    dom.setChecked(made.input, value === '1h');
    dom.append(lifetimeChoices, made.label);
    return [value, made.input] as const;
  });
  const agentLifetimes = element('div', 'choices');
  dom.attr(agentLifetimes, 'role', 'radiogroup');
  dom.attr(agentLifetimes, 'aria-label', 'How long the command works');
  const agentLifetimeInputs = (['1h', '4h', '8h'] as const).map((value) => {
    const made = choice(
      'agent-lifetime',
      value,
      value === '1h' ? '1 hour' : `${value[0]} hours`,
      `agent-lifetime-${value}`,
    );
    dom.setChecked(made.input, value === '1h');
    dom.append(agentLifetimes, made.label);
    return [value, made.input] as const;
  });

  const usesField = element('label', 'field', 'Uses');
  const usesInput = element('input');
  dom.attr(usesInput, 'type', 'number');
  dom.attr(usesInput, 'min', '1');
  dom.attr(usesInput, 'max', String(MAX_INVITE_USES));
  dom.attr(usesInput, 'step', '1');
  dom.setValue(usesInput, '1');
  setAction(usesInput, 'invite-uses');
  dom.append(usesField, usesInput);

  const formReason = element('p', 'muted');
  role(formReason, 'invite-reason');
  const createButton = boxButton(
    formView,
    'Create link',
    'invite-create',
    () => {
      void createInvite();
    },
    true,
  );
  const formButtons = element('div', 'buttons');
  dom.append(formButtons, createButton);
  dom.append(
    formBox,
    labelField,
    roleChoices,
    lifetimeChoices,
    agentLifetimes,
    usesField,
    formReason,
    formButtons,
  );

  for (const input of [watchChoice.input, controlChoice.input, agentChoice.input]) {
    dom.listen(input, 'change', () => {
      // Create now grants something else, so the form waits again.
      restartArming(formView);
      render(dock.state);
    });
  }
  dom.listen(labelInput, 'input', () => {
    render(dock.state);
  });

  // Agent tokens (ADR 0044): the command, shown once, and the live tokens.
  // Done loses the command for good, so its box waits as the others do.
  const commandBox = element('div', 'prompt');
  dom.flag(commandBox, 'hidden', true);
  const commandView = newBox(commandBox);
  boxes.add(commandView);
  const commandHeading = element('p');
  const commandText = element('p', 'link-text');
  role(commandText, 'agent-command');
  const copyCommand = boxButton(commandView, 'Copy', 'agent-copy', () => {
    copyShown(shownCommand?.command, copyCommand, 'Select the command to copy it');
  });
  const commandButtons = element('div', 'buttons');
  dom.append(
    commandButtons,
    copyCommand,
    boxButton(commandView, 'Done', 'agent-done', hideCommand),
  );
  dom.append(commandBox, commandHeading, commandText, commandButtons);
  /** The command on show and its token, or null; Copy reads it here, never back from the tree. */
  let shownCommand: { readonly tokenId: string; readonly command: string } | null = null;
  const agentList = element('ul');
  role(agentList, 'agent-list');
  dom.append(agentsBlock, commandBox, agentList);

  dom.append(
    invitesBlock,
    element('div', 'label', 'Invites'),
    linkBox,
    inviteList,
    noInvites,
    agentsBlock,
    inviteError,
    formBox,
    inviteToggle,
  );

  // A fixed height, so new calls never move the boxes around it.
  const activity = element('ol', 'activity');
  role(activity, 'activity');
  dom.attr(activity, 'aria-label', 'Recent calls, newest first');
  const activityBlock = element('div');
  dom.append(activityBlock, element('div', 'label', 'Activity'), activity);

  // Last in the panel, beside the badge, where other changes move it least.
  const pauseBox = element('div', 'pause');
  role(pauseBox, 'pause-box');
  const pauseView: PauseView = {
    ...newBox(pauseBox),
    text: element('span'),
    toggle: element('button'),
    paused: null,
  };
  pauseView.toggle = boxButton(pauseView, 'Pause', 'pause', () => {
    // What the button says now: Pause when running, Resume when paused.
    dock.pause(pauseView.paused !== true);
  });
  dom.append(pauseBox, pauseView.text, pauseView.toggle);
  boxes.add(pauseView);

  // Plan C22's order: what needs the operator now first, the pause control last beside the badge.
  dom.append(
    panel,
    errorLine,
    noticeLine,
    joins,
    prompts,
    recordOfferBox,
    proposalsBlock,
    pairing,
    rosterBlock,
    sessionBlock,
    invitesBlock,
    activityBlock,
    recordBlock,
    stateLine,
    pauseBox,
  );

  const dot = element('span', 'dot');
  const count = element('span', 'count', '0');
  const pausedTag = element('span', 'tag', 'Paused');
  role(pausedTag, 'badge-paused');
  // The running session's minutes left (ADR 0043) and the proposals waiting (ADR 0042), shown once built.
  const sessionTag = element('span', 'tag');
  role(sessionTag, 'badge-session');
  dom.flag(sessionTag, 'hidden', true);
  const proposedTag = element('span', 'tag');
  role(proposedTag, 'badge-proposals');
  dom.flag(proposedTag, 'hidden', true);
  const badgeButton = button('', 'toggle', () => {
    // Any hidden attribute, 'until-found' too, means closed.
    setOpen(dom.has(panel, 'hidden'));
  });
  dom.attr(badgeButton, 'class', 'badge');
  dom.attr(badgeButton, 'aria-expanded', 'false');
  dom.append(
    badgeButton,
    dot,
    element('span', '', 'Tabdock'),
    count,
    pausedTag,
    sessionTag,
    proposedTag,
  );

  const wrap = element('div', 'wrap');
  dom.append(wrap, panel, badgeButton);
  if (style) root.append(style);
  root.append(wrap);

  function setOpen(open: boolean): void {
    // Time on screen so far counts for the join notices before the panel changes.
    ageJoinLines();
    dom.flag(panel, 'hidden', !open);
    dom.attr(badgeButton, 'aria-expanded', String(open));
    // Opening moves every box from nowhere onto the screen, so each waits from now.
    checkMoves();
    ageJoinLines();
    updateAttention();
  }

  function requestView(request: PendingRequest, state: DockState): PromptView {
    const box = element('div', 'prompt');
    dom.attr(box, 'data-request-id', request.requestId);
    // ADR 0041: the testing helper approves only the request whose client it
    // names exactly, never by a match on the prompt's words, which a client
    // named after another could share. The name is the one the prompt shows.
    const clientName = request.client === null ? '' : plainLine(request.client.name);
    if (clientName !== '') dom.attr(box, 'data-client-name', clientName);
    const who = personText(request.user, request.account);
    const line = element('p');
    if (request.agent !== null) {
      // The page's own words: the id this page derived and checked, and the label the operator gave the token.
      dom.append(
        line,
        `An agent (${shortId(request.user.userId) ?? ''}) wants to watch by your agent token "${request.agent.label}"`,
      );
    } else if (request.invite !== null) {
      // The account beside the label the operator gave the invite, which is this page's own text.
      dom.append(line, `${wants(who)} to join by your invite "${request.invite.label}"`);
    } else {
      const via = request.via === 'qr' ? 'QR code' : 'code';
      dom.append(line, `${wants(who)} to attach via ${via}`);
    }
    dom.append(line, badge(request.invite !== null || request.account.kind === 'invitee'));
    dom.append(box, line);
    // An agent has no account to vouch for, and the line above says what it is.
    if (!request.account.verified && request.agent === null) {
      dom.append(
        box,
        element('p', 'muted', 'Unverified account: the sign-in provider vouches for no email.'),
      );
    }
    const drivers = state.roster.filter((attachment) => attachment.role === 'driver').length;
    // A running session's seats, which may be fewer than attach()'s (ADR 0043).
    if (request.invite !== null && drivers >= (state.session?.policy ?? state.policy).maxDrivers) {
      // ADR 0017: the relay seats them as observer; Make driver works once a seat is free.
      dom.append(
        box,
        element('p', 'muted', 'The driver seats are full, so they join as observer for now.'),
      );
    }
    const client = request.client === null ? '' : clientText(request.client);
    if (client !== '') {
      const said = element('p', 'muted', 'Client: ');
      dom.append(said, quotedClient(client));
      dom.append(box, said);
    }
    const view = newPrompt(box, request.expiresAt);
    const buttons = element('div', 'buttons');
    // An agent token lets its holder watch, never control (ADR 0044).
    if (request.agent === null) {
      dom.append(
        buttons,
        boxButton(view, 'Allow as driver', 'approve-driver', () => {
          dock.approve(request.requestId, 'driver');
        }),
      );
    }
    dom.append(
      buttons,
      boxButton(view, 'Allow as observer', 'approve-observer', () => {
        dock.approve(request.requestId, 'observer');
      }),
      boxButton(
        view,
        'Deny',
        'deny',
        () => {
          dock.deny(request.requestId);
        },
        true,
      ),
    );
    dom.append(box, buttons, view.countdown);
    return view;
  }

  function confirmView(confirm: PendingConfirm): PromptView {
    const box = element('div', 'prompt');
    dom.attr(box, 'data-call-id', confirm.callId);
    const line = element('p');
    dom.append(line, `${wants(personText(confirm.caller))} to run ${confirm.tool}`);
    dom.append(line, badge(shortId(confirm.caller.userId) !== null));
    dom.append(box, line);
    const view = newPrompt(box, confirm.expiresAt);
    const buttons = element('div', 'buttons');
    dom.append(
      buttons,
      boxButton(view, 'Allow', 'confirm-allow', () => {
        dock.confirm(confirm.callId, true);
      }),
      boxButton(
        view,
        'Deny',
        'confirm-deny',
        () => {
          dock.confirm(confirm.callId, false);
        },
        true,
      ),
    );
    dom.append(box, buttons, view.countdown);
    return view;
  }

  /**
   * Adds and removes prompt boxes by id, so a box under the operator's pointer
   * is never rebuilt. New boxes go on top: the panel is pinned at the bottom of
   * the screen, so the boxes already shown keep their place (and stay armed).
   */
  function syncPrompts<T>(
    views: Map<string, PromptView>,
    items: readonly T[],
    key: (item: T) => string,
    build: (item: T) => PromptView,
  ): boolean {
    let added = false;
    const live = new Set(items.map(key));
    for (const [id, view] of views) {
      if (!live.has(id)) {
        dropBox(view);
        views.delete(id);
      }
    }
    for (const item of items) {
      const id = key(item);
      if (views.has(id)) continue;
      const view = build(item);
      views.set(id, view);
      boxes.add(view);
      dom.prepend(prompts, view.element);
      added = true;
    }
    return added;
  }

  function rowView(userId: string, compact: boolean): RowView {
    const box = element('li', compact ? 'row compact' : 'row');
    dom.attr(box, 'data-user-id', userId);
    const closeLink = element('label', 'check');
    const closeInput = element('input');
    dom.attr(closeInput, 'type', 'checkbox');
    setAction(closeInput, 'close-link');
    dom.append(closeLink, closeInput, 'and close this link');
    dom.flag(closeLink, 'hidden', true);
    const view: RowView = {
      ...newBox(box),
      compact,
      name: element('span', compact ? 'nm' : ''),
      sid: element('span', 'muted'),
      badge: badge(false),
      clients: element('p', 'muted clients'),
      expiry: element('p', 'muted'),
      closeLink,
      closeInput,
      roleSwitch: element('button'),
      key: '',
      role: null,
      expiresAt: null,
    };
    view.roleSwitch = boxButton(view, 'Make driver', 'make-driver', () => {
      // view.role is what the button says, since both change together in updateRow.
      dock.setRole(userId, view.role === 'driver' ? 'observer' : 'driver');
    });
    const revoke = boxButton(view, 'Revoke', 'revoke', () => {
      // The row's own choice when it shows, which starts checked, or the
      // Watching section's for a compact row; the adapter's default
      // otherwise, which closes a multi-use link (ADR 0016).
      const choice = compact ? closeAllInput : view.closeInput;
      askFirst(userId, member(userId), () => {
        if (dom.has(view.closeLink, 'hidden')) dock.revoke(userId);
        else dock.revoke(userId, { closeInvite: dom.checked(choice) });
        // The section's box is one Revoke's choice, as a row's own box is
        // that row's: the next Revoke starts from S14's default again.
        if (compact) dom.setChecked(closeAllInput, true);
      });
    });
    const buttons = element('div', 'buttons');
    dom.append(buttons, view.roleSwitch, revoke);
    if (compact) {
      dom.append(box, view.name, ' ', view.sid, view.badge, buttons);
      return view;
    }
    dom.append(buttons, view.closeLink);
    const who = element('p', 'who');
    dom.append(who, view.name, view.badge);
    dom.append(box, who, view.clients, view.expiry, buttons);
    return view;
  }

  /** Whether the roster lists this user as a member: only a member sponsors invites (ADR 0017). */
  function member(userId: string): boolean {
    return dock.state.roster.some((entry) => entry.userId === userId && entry.kind === 'member');
  }

  /**
   * Who sponsored each invite and agent token the page lists, kept while
   * anyone still listed came in by it, so Revoke can say whose access ends
   * with a sponsor's (plan C21). Only ids the page names now are kept.
   */
  const sponsors = new Map<string, string>();
  function learnSponsors(state: DockState): void {
    for (const view of state.invites) sponsors.set(view.inviteId, view.sponsor.userId);
    for (const view of state.agents) sponsors.set(view.tokenId, view.sponsor.userId);
    const named = new Set<string | null>([
      ...state.roster.map((entry) => entry.inviteId),
      ...state.invites.map((view) => view.inviteId),
      ...state.agents.map((view) => view.tokenId),
    ]);
    for (const id of sponsors.keys()) if (!named.has(id)) sponsors.delete(id);
  }

  /**
   * Runs `go` at once, or first asks in the confirm box when it would end
   * access for people invites let in: everyone's, for Revoke all ('*'), or
   * a member's sponsored ones. An invite this page no longer lists (used up
   * before a reload, say) has no sponsor known here, so its people are
   * counted for any member, as the relay may end them with that member;
   * hence "up to" for a member.
   */
  function askFirst(userId: string, sponsor: boolean, go: () => void): void {
    const count = dock.state.roster.filter((entry) => {
      const by = sponsors.get(entry.inviteId ?? '');
      return (
        sponsor &&
        entry.inviteId !== null &&
        entry.userId !== userId &&
        (userId === '*' || by === userId || by === undefined)
      );
    }).length;
    if (count === 0) {
      go();
      return;
    }
    const row = dock.state.roster.find((entry) => entry.userId === userId);
    setText(
      confirmText,
      `${row ? `Revoking ${personText(row)} also ends access for up to` : 'Revoke all also ends access for'} ${String(count)} ${count === 1 ? 'person' : 'people'} invites let in.`,
    );
    asking = { userId, go };
    dom.flag(confirmBox, 'hidden', false);
    restartArming(revokeView);
  }

  function unask(): void {
    asking = null;
    dom.flag(confirmBox, 'hidden', true);
  }

  function setText(node: HTMLElement, text: string): void {
    if (dom.text(node) !== text) dom.setText(node, text);
  }

  /**
   * The row shows the role the page enforces, not the relay's claim alone; a
   * user the page runs nothing for gets Revoke only, since even Make
   * observer would grant them something, and so does a guest a Can watch
   * invite let in, whom no switch may make a driver (ADR 0017).
   */
  function updateRow(
    view: RowView,
    attachment: AttachmentView,
    access: PageRole | undefined,
    invite: InviteView | undefined,
    agent: string | undefined,
  ): void {
    view.expiresAt =
      attachment.endsAt === null
        ? attachment.expiresAt
        : Math.min(attachment.endsAt, attachment.expiresAt ?? attachment.endsAt);
    const role = access?.role ?? null;
    const revoking = access?.revoked === true;
    const status = role ?? (revoking ? 'revoke pending' : 'not approved on this page');
    if (view.compact) {
      // An agent by the label this page gave its token, from its own record
      // (ADR 0044); anyone else by their name, the short id beside it.
      const name = agent === undefined ? plainLine(attachment.displayName) : `agent "${agent}"`;
      setText(view.name, role === 'observer' ? name : `${name} (${status})`);
      setText(view.sid, `(${shortId(attachment.userId) ?? ''})`);
      setText(view.badge, agent === undefined ? 'invited' : 'agent');
    } else {
      setText(view.name, `${personText(attachment)} (${status})`);
      setText(view.badge, invited(attachment) ? 'invited' : '');
    }
    const clients = attachment.clients
      .map(clientText)
      .filter((text) => text !== '')
      .join(', ');
    setText(view.clients, clients === '' ? 'No client seen yet' : `Clients: ${clients}`);
    const capped = access?.inviteRole === 'observer';
    const closable = invite !== undefined && invite.uses > 1 && invite.usesLeft > 0;
    // Clients name themselves, on every call if they like, so their names
    // never make the row wait again; the line keeps its height, and real
    // movement is checkMoves' job.
    const key = JSON.stringify([attachment.displayName, role, revoking, capped, closable]);
    if (key === view.key) return;
    const isNew = view.key === '';
    view.key = key;
    view.role = role;
    dom.flag(view.roleSwitch, 'hidden', role === null || capped);
    const promote = role !== 'driver';
    dom.setText(view.roleSwitch, promote ? 'Make driver' : 'Make observer');
    setAction(view.roleSwitch, promote ? 'make-driver' : 'make-observer');
    // "and close this link" starts checked whenever it appears.
    if (closable && dom.has(view.closeLink, 'hidden')) dom.setChecked(view.closeInput, true);
    dom.flag(view.closeLink, 'hidden', !closable);
    // The role switch may now do the opposite of what the operator was reaching for, or be gone.
    if (!isNew) restartArming(view);
  }

  /** The rows in the roster lists and the rows in the invite list, in order, as last put there. */
  let rosterShown: readonly HTMLElement[] = [];
  let watchShown: readonly HTMLElement[] = [];
  let inviteListShown: readonly HTMLElement[] = [];
  /** Rows in the Watching section as syncRows last listed them, for the badge. */
  let watchCount = 0;

  /**
   * Rows are kept by user id and only reordered when the relay's order
   * changes, like prompts. The relay lists attachments in the order they
   * were granted, so someone joining appends a row and never moves the rows
   * above it. With watching seats (ADR 0044) an invitee observer's row is a
   * compact one in the Watching section; a row changing sections is made anew.
   */
  function syncRows(state: DockState): void {
    learnSponsors(state);
    const access = new Map(state.pageRoles.map((entry) => [entry.userId, entry]));
    const invites = new Map(state.invites.map((view) => [view.inviteId, view]));
    const agents = new Map(state.agents.map((view) => [view.tokenId, view.label]));
    const seats = state.seatLimits?.observersPerPage ?? 0;
    const watches = (entry: AttachmentView): boolean =>
      seats > 0 && entry.kind === 'invitee' && entry.role === 'observer';
    const listed = new Map(state.roster.map((entry) => [entry.userId, entry]));
    for (const [userId, view] of rowViews) {
      const entry = listed.get(userId);
      if (entry === undefined || view.compact !== watches(entry)) {
        dropBox(view);
        rowViews.delete(userId);
      }
    }
    if (asking !== null && asking.userId !== '*' && !listed.has(asking.userId)) unask();
    const find = dom.value(filterInput).trim().toLowerCase();
    const people: HTMLElement[] = [];
    const watchers: HTMLElement[] = [];
    let closable = false;
    for (const attachment of state.roster) {
      const compact = watches(attachment);
      let view = rowViews.get(attachment.userId);
      if (!view) {
        view = rowView(attachment.userId, compact);
        rowViews.set(attachment.userId, view);
        boxes.add(view);
      }
      const inviteId = attachment.inviteId ?? '';
      updateRow(
        view,
        attachment,
        access.get(attachment.userId),
        invites.get(inviteId),
        agents.get(inviteId),
      );
      // Role changes need the relay; revoking works offline and is sent on resume.
      dom.flag(view.roleSwitch, 'disabled', state.link !== 'linked');
      if (!compact) {
        people.push(view.element);
        continue;
      }
      closable ||= !dom.has(view.closeLink, 'hidden');
      const text = `${dom.text(view.name)} ${dom.text(view.sid)}`.toLowerCase();
      dom.flag(view.element, 'hidden', find !== '' && !text.includes(find));
      watchers.push(view.element);
    }
    if (!sameNodes(rosterShown, people)) {
      dom.replaceChildren(roster, people);
      rosterShown = people;
    }
    if (!sameNodes(watchShown, watchers)) {
      dom.replaceChildren(watchList, watchers);
      watchShown = watchers;
    }
    watchCount = watchers.length;
    const many = watchCount > COMPACT_ROWS;
    const open = watchOpen || !many;
    dom.flag(watching, 'hidden', watchCount === 0);
    setText(watchTitle, `Watching by invite: ${String(watchCount)} of ${String(seats)}`);
    dom.flag(watchToggle, 'hidden', !many);
    setText(watchToggle, open ? 'Hide' : 'Show');
    dom.flag(watchList, 'hidden', !open);
    dom.flag(watchFilter, 'hidden', !open || !many);
    // Ticked whenever it appears, as a row's own box is (updateRow).
    const showClose = open && closable;
    if (showClose && dom.has(closeAll, 'hidden')) dom.setChecked(closeAllInput, true);
    dom.flag(closeAll, 'hidden', !showClose);
    setText(peopleLabel, watchCount > 0 ? 'People' : 'Attached');
    dom.flag(nobody, 'hidden', state.roster.length > 0);
    // Revoke all also closes every live invite, so it stays while any is live.
    dom.flag(revokeAll, 'hidden', state.roster.length === 0 && state.invites.length === 0);
  }

  /** The seq of the newest join already dealt with; null before the first render. */
  let lastJoin: number | null = null;
  /** Joins this page honoured that are not told of yet, by seq, until the relay lists them. */
  const waitingJoins = new Map<number, InviteJoin>();
  const joinLines: JoinLine[] = [];

  /**
   * ADR 0016: a Can watch invite lets its holder in without a prompt, but
   * never unseen. The notice comes from the page's own honour decisions
   * (DockState.joins), never from the roster, so a relay that lists someone
   * the page never let in announces nothing; it waits until the relay lists
   * them, and names the role the page runs their calls under. Returns
   * whether a notice was added, which opens the panel.
   */
  function noticeJoins(state: DockState): boolean {
    const newest = state.joins[0]?.seq ?? 0;
    // Joins made before the widget mounted are not news.
    if (lastJoin === null) {
      lastJoin = newest;
      return false;
    }
    for (const join of state.joins) if (join.seq > lastJoin) waitingJoins.set(join.seq, join);
    lastJoin = Math.max(lastJoin, newest);
    const current = new Set(state.joins.map((join) => join.seq));
    const access = new Map(state.pageRoles.map((entry) => [entry.userId, entry]));
    let added = false;
    for (const [seq, join] of [...waitingJoins].sort(([a], [b]) => a - b)) {
      // Its grant went before the relay listed them (revoked, say): there is no join to tell of.
      if (!current.has(seq)) {
        waitingJoins.delete(seq);
        continue;
      }
      const role = access.get(join.user.userId);
      if (role === undefined || role.role === null || role.inviteRole === null) continue;
      waitingJoins.delete(seq);
      showJoin(join, role.role);
      added = true;
    }
    return added;
  }

  /**
   * Each invite's join notices still on screen, by invite (ADR 0044): a room
   * joining by one invite gets one line, not one each, once three are told
   * of while the first is still there. The roster lists every one of them.
   */
  const joinGroups = new Map<string, { lines: JoinLine[]; names: string[] }>();

  function showJoin(join: InviteJoin, role: Role): void {
    let group = joinGroups.get(join.inviteId);
    if (!group?.lines.some((line) => joinLines.includes(line))) {
      group = { lines: [], names: [] };
      joinGroups.set(join.inviteId, group);
    }
    const who = personText(join.user, join.account);
    group.names.push(who);
    const count = group.names.length;
    const said = `joined by your invite "${join.label}" as ${role}`;
    const newest = group.names.slice(-3).reverse().join(', ');
    const line = element(
      'p',
      'join',
      count < 3
        ? `${who} ${said}`
        : `${String(count)} ${said}: ${newest}${count > 3 ? ` and ${String(count - 3)} more` : ''}`,
    );
    if (count < 3) {
      // Not data-user-id, which names roster rows.
      dom.attr(line, 'data-joined', join.user.userId);
    } else {
      dom.attr(line, 'data-joined-batch', join.inviteId);
      // One line in place of the group's, on screen afresh for the newest.
      for (const old of group.lines.splice(0)) {
        dom.remove(old.element);
        const at = joinLines.indexOf(old);
        if (at !== -1) joinLines.splice(at, 1);
      }
    }
    dom.prepend(joins, line);
    const shown: JoinLine = { element: line, shownMs: 0, since: null, seen: false };
    joinLines.push(shown);
    group.lines.push(shown);
    for (const [inviteId, { lines }] of joinGroups) {
      if (!lines.some((old) => joinLines.includes(old))) joinGroups.delete(inviteId);
    }
  }

  /** The seq of the newest observer seat already dealt with; null before the first render. */
  let lastSeat: number | null = null;
  /** Each seat notice on screen, by its seat's seq, with the user it names. */
  const seatLines = new Map<number, { userId: string; line: JoinLine }>();

  /**
   * Says so when the driver limit seated someone as an observer after the
   * operator chose driver, which nothing else on the panel would: the row
   * just reads observer (DockState.observerSeats). The words are the
   * operator's own; the line ages and goes as a join notice does. Returns
   * whether a notice was added, which opens the panel.
   */
  function noticeSeats(state: DockState): boolean {
    withdrawSeats(state);
    const newest = state.observerSeats[0]?.seq ?? 0;
    // Seats recorded before the widget mounted are not news.
    if (lastSeat === null) {
      lastSeat = newest;
      return false;
    }
    const fresh = state.observerSeats.filter((seat) => seat.seq > (lastSeat ?? 0));
    lastSeat = Math.max(lastSeat, newest);
    for (const seat of [...fresh].reverse()) {
      const who = personText(seat.user, seat.account ?? undefined);
      // ADR 0044: a watcher kept for want of a seat among the people, not by the driver limit.
      const line = element(
        'p',
        'join',
        seat.heldBy === 'people'
          ? `The page has no seat left among its ${String(state.seatLimits?.usersPerPage)} people, so ${who} is still an observer.`
          : `The page already has its maximum drivers, so ${who} ${seat.asked === 'allow' ? 'joined as observer' : 'is still an observer'}.`,
      );
      // Not data-user-id, which names roster rows.
      dom.attr(line, 'data-seated', seat.user.userId);
      dom.prepend(joins, line);
      const shown: JoinLine = { element: line, shownMs: 0, since: null, seen: false };
      joinLines.push(shown);
      seatLines.set(seat.seq, { userId: seat.user.userId, line: shown });
    }
    return fresh.length > 0;
  }

  /**
   * Takes a seat notice down once the roster lists its person as a driver
   * after all, as when a roster sent before the relay read the click came
   * first: the notice would now say the opposite of the row beside it.
   */
  function withdrawSeats(state: DockState): void {
    for (const [seq, { userId, line }] of [...seatLines]) {
      const at = joinLines.indexOf(line);
      if (at === -1) {
        // Aged away already.
        seatLines.delete(seq);
        continue;
      }
      if (state.observerSeats.some((seat) => seat.seq === seq)) continue;
      const driving = state.roster.some(
        (entry) => entry.userId === userId && entry.role === 'driver',
      );
      if (!driving) continue;
      dom.remove(line.element);
      joinLines.splice(at, 1);
      seatLines.delete(seq);
    }
  }

  /**
   * Counts the time each join notice has been on screen, the panel open on a
   * visible tab, and removes those shown for JOIN_NOTICE_MS. Called on every
   * tick and whenever the panel or the tab's visibility changes, so time off
   * screen never counts.
   */
  function ageJoinLines(): void {
    const now = Date.now();
    const onScreen = !dom.has(panel, 'hidden') && doc.visibilityState === 'visible';
    for (let i = joinLines.length - 1; i >= 0; i -= 1) {
      const line = joinLines[i];
      if (!line) continue;
      if (!onScreen) {
        if (line.since !== null) line.shownMs += now - line.since;
        line.since = null;
        continue;
      }
      line.seen = true;
      line.since ??= now;
      if (line.shownMs + now - line.since >= JOIN_NOTICE_MS) {
        dom.remove(line.element);
        joinLines.splice(i, 1);
      }
    }
  }

  /** The badge asks for attention while a prompt waits, or a join notice or a proposal has not been seen. */
  function updateAttention(): void {
    const waiting = requestViews.size + confirmViews.size > 0;
    const attention = waiting || joinLines.some((line) => !line.seen) || unseenProposals.size > 0;
    dom.attr(badgeButton, 'class', attention ? 'badge attention' : 'badge');
  }

  function inviteRow(view: InviteView): InviteRowView {
    const box = element('li', 'row');
    dom.attr(box, 'data-invite-id', view.inviteId);
    const title = element('p', 'who');
    const detail = element('p', 'muted');
    const buttons = element('div', 'buttons');
    // Cancelling only takes access away, so it is not held back like the boxes.
    dom.append(
      buttons,
      button('Cancel', 'cancel-invite', () => {
        dock.cancelInvite(view.inviteId);
      }),
    );
    dom.append(box, title, detail, buttons);
    return { element: box, title, detail, view };
  }

  function syncInvites(state: DockState): void {
    const live = new Set(state.invites.map((view) => view.inviteId));
    for (const [inviteId, row] of inviteRows) {
      if (!live.has(inviteId)) {
        dom.remove(row.element);
        inviteRows.delete(inviteId);
      }
    }
    const ordered = state.invites.map((view) => {
      let row = inviteRows.get(view.inviteId);
      if (!row) {
        row = inviteRow(view);
        inviteRows.set(view.inviteId, row);
      }
      row.view = view;
      // The label is this page's own words; quoted so it reads as a name, never as the widget's text.
      setText(row.title, `"${view.label}", ${roleText(view.role)}`);
      setText(row.detail, inviteDetail(view));
      return row.element;
    });
    if (!sameNodes(inviteListShown, ordered)) {
      dom.replaceChildren(inviteList, ordered);
      inviteListShown = ordered;
    }
    // Between links the page lists nothing, which says nothing about what is live.
    dom.flag(noInvites, 'hidden', state.invites.length > 0 || state.link !== 'linked');
    // A link whose invite the relay no longer lists (used up, cancelled, expired) is dead: it goes.
    if (shownLink !== null && state.invitesOffered !== null && !live.has(shownLink.inviteId)) {
      hideLink();
    }
  }

  /** Why Create cannot work now, or null; `agent` when the form makes an agent token. */
  function inviteBlocker(state: DockState, agent: boolean): string | null {
    if (state.link !== 'linked') return REFUSAL_TEXT.link_down;
    if (state.invitesOffered?.linkBase === null) return REFUSAL_TEXT.no_public_url;
    if (!state.roster.some((attachment) => attachment.kind === 'member')) {
      return 'Invites need a member attached to sponsor them. Pair one first.';
    }
    if (agent) {
      return state.agents.length >= MAX_LIVE_AGENTS_PER_PAGE
        ? `This page already has ${MAX_LIVE_AGENTS_PER_PAGE} live agent tokens. Cancel one first.`
        : null;
    }
    if (state.invites.length >= MAX_LIVE_INVITES_PER_PAGE) return REFUSAL_TEXT.limit;
    return null;
  }

  let creating = false;

  function chosenRole(state: DockState): Role {
    return state.policy.invites === 'all' && dom.checked(controlChoice.input)
      ? 'driver'
      : 'observer';
  }

  function chosenLifetime(): InviteLifetime {
    for (const [value, input] of lifetimeInputs) if (dom.checked(input)) return value;
    return '1h';
  }

  function chosenAgentLifetime(): AgentLifetime {
    for (const [value, input] of agentLifetimeInputs) if (dom.checked(input)) return value;
    return '1h';
  }

  function chosenUses(): number | null {
    const uses = Number(dom.value(usesInput));
    return Number.isInteger(uses) && uses >= 1 && uses <= MAX_INVITE_USES ? uses : null;
  }

  /** Whether a relay has offered invites on this page since the widget mounted; see updateForm. */
  let everOffered = false;

  function updateForm(state: DockState): void {
    if (state.invitesOffered !== null) everOffered = true;
    // A relay offers invites in a frame of each link (ADR 0017's notes), so
    // between links nothing is offered. A relay that did offer them keeps the
    // block while its link is down, so the operator reads why Create waits
    // instead of seeing it vanish; one that linked and offers none hides it.
    const offered =
      state.policy.invites !== 'off' &&
      (state.invitesOffered !== null || (everOffered && state.link !== 'linked'));
    dom.flag(invitesBlock, 'hidden', !offered);
    // Can control only where the page opted into it (ADR 0016).
    const watchOnly = state.policy.invites !== 'all';
    dom.flag(controlChoice.label, 'hidden', watchOnly);
    if (watchOnly && dom.checked(controlChoice.input)) dom.setChecked(watchChoice.input, true);
    // The agent kind only where the relay serves agent tokens at a public URL (ADR 0044).
    const agentsOn = typeof state.agentsOffered?.endpoint === 'string';
    dom.flag(agentChoice.label, 'hidden', !agentsOn);
    if (!agentsOn && dom.checked(agentChoice.input)) dom.setChecked(watchChoice.input, true);
    const agent = dom.checked(agentChoice.input);
    dom.flag(lifetimeChoices, 'hidden', agent);
    dom.flag(agentLifetimes, 'hidden', !agent);
    setText(createButton, agent ? 'Create command' : 'Create link');
    // A Can control invite always has exactly one use, and an agent token has none to count.
    dom.flag(usesField, 'hidden', agent || chosenRole(state) === 'driver');
    const blocker = inviteBlocker(state, agent);
    const reason = creating ? 'Asking the relay for the link' : blocker;
    setText(formReason, reason ?? '');
    dom.flag(formReason, 'hidden', reason === null);
    dom.flag(
      createButton,
      'disabled',
      creating || blocker !== null || dom.value(labelInput).trim() === '',
    );
    const open = !dom.has(formBox, 'hidden');
    dom.setText(inviteToggle, open ? 'Close the form' : 'Invite someone');
    setAction(inviteToggle, open ? 'invite-close' : 'invite-open');
  }

  function setFormOpen(open: boolean): void {
    dom.flag(formBox, 'hidden', !open);
    if (open) dom.flag(inviteError, 'hidden', true);
    render(dock.state);
  }

  async function createInvite(): Promise<void> {
    const state = dock.state;
    const label = dom.value(labelInput).trim();
    const agent = dom.checked(agentChoice.input);
    const role = chosenRole(state);
    const uses = role === 'driver' || agent ? 1 : chosenUses();
    if (label === '' || uses === null) {
      showInviteError(REFUSAL_TEXT.invalid);
      return;
    }
    creating = true;
    dom.flag(inviteError, 'hidden', true);
    render(state);
    const result = agent
      ? await dock.agentToken({ label, lifetime: chosenAgentLifetime() })
      : await dock.invite({ label, role, lifetime: chosenLifetime(), uses });
    creating = false;
    if (!mounted) return;
    if (result.ok) {
      dom.setValue(labelInput, '');
      dom.setValue(usesInput, '1');
      dom.flag(formBox, 'hidden', true);
      if ('command' in result) showCommand(result.tokenId, result.command, label, result.expiresAt);
      else showLink(result.inviteId, result.link, label);
    } else {
      showInviteError(REFUSAL_TEXT[result.reason]);
    }
    render(dock.state);
  }

  function showInviteError(text: string): void {
    dom.setText(inviteError, text);
    dom.flag(inviteError, 'hidden', false);
  }

  /** The link, once: as a QR drawing and as text to send, until Done or until its invite ends. */
  function showLink(inviteId: string, link: string, label: string): void {
    shownLink = { inviteId, link };
    dom.setText(
      linkHeading,
      `Send this link to ${label}. It shows only now, and anyone who holds it can join as the invite says.`,
    );
    dom.setText(linkText, link);
    dom.flag(linkQrBox, 'hidden', !linkQr.show(link));
    dom.setText(copyLink, 'Copy link');
    dom.flag(linkBox, 'hidden', false);
    setOpen(true);
  }

  function hideLink(): void {
    shownLink = null;
    // Nothing of the link stays in the tree.
    dom.setText(linkText, '');
    dom.setText(linkHeading, '');
    linkQr.show(undefined);
    dom.flag(linkBox, 'hidden', true);
  }

  /** Copies what is on show, an invite link or an agent's command, and says so on its button. */
  function copyShown(text: string | undefined, node: HTMLElement, fallbackText: string): void {
    const fallback = (): void => {
      dom.setText(node, fallbackText);
    };
    if (text === undefined || writeClipboard === null) {
      fallback();
      return;
    }
    // Only through the writeText taken at mount; see clipboardWriter.
    writeClipboard(text).then(() => {
      dom.setText(node, 'Copied');
    }, fallback);
  }

  /** The command, once, until Done or until its token is no longer live; the token is never kept. */
  function showCommand(tokenId: string, command: string, label: string, expiresAt: number): void {
    shownCommand = { tokenId, command };
    dom.setText(
      commandHeading,
      `Run this in Claude Code for ${label}. It shows only now, and anyone who holds it can ask to watch this page until ${timeText(expiresAt)}.`,
    );
    dom.setText(commandText, command);
    dom.setText(copyCommand, 'Copy');
    dom.flag(commandBox, 'hidden', false);
    setOpen(true);
  }

  function hideCommand(): void {
    shownCommand = null;
    // Nothing of the token stays in the tree.
    dom.setText(commandText, '');
    dom.flag(commandBox, 'hidden', true);
  }

  function updatePause(paused: boolean): void {
    dom.flag(pausedTag, 'hidden', !paused);
    dom.attr(badgeButton, 'data-paused', String(paused));
    if (pauseView.paused === paused) return;
    const isNew = pauseView.paused === null;
    pauseView.paused = paused;
    dom.attr(pauseBox, 'class', paused ? 'pause paused' : 'pause');
    dom.setText(
      pauseView.text,
      paused ? 'Paused: every call is refused' : 'Calls run as they come',
    );
    dom.setText(pauseView.toggle, paused ? 'Resume' : 'Pause');
    setAction(pauseView.toggle, paused ? 'resume' : 'pause');
    // Resume grants access again, so a switch that just flipped waits like a new box.
    if (!isNew) restartArming(pauseView);
  }

  /**
   * One call: its time in a column of its own, then who, through which
   * client, what and how it ended. The person and the client are what the
   * caller and the relay say, so each sits in a run of its own (person,
   * quotedClient) and the ADR 0026 mark is the page's own badge; a client's
   * name can then neither wrap into a line that passes for another entry nor
   * reverse the page's words after it.
   */
  function entryLine(entry: ActivityEntry): HTMLElement {
    const line = element('li');
    dom.attr(line, 'data-activity-id', entry.callId);
    dom.attr(line, 'data-outcome', entry.outcome);
    const what = element('span');
    dom.append(what, person(personText(entry.user)));
    if (shortId(entry.user.userId) !== null) dom.append(what, badge(true));
    const client = entry.client === null ? '' : clientText(entry.client);
    if (client !== '') dom.append(what, ' via ', quotedClient(client));
    dom.append(what, `: ${entry.tool}`);
    const confirmed = confirmedIn(entry);
    if (confirmed !== null) dom.append(what, ', ', confirmedBadge(confirmed));
    // ADR 0042's mark, the page's own on a ground of its own, as ADR 0026's is.
    if (entry.acceptedOnPage)
      dom.append(what, ', ', element('span', 'accepted', 'accepted proposal'));
    const took = entry.durationMs === null ? '' : ` in ${entry.durationMs} ms`;
    // A write answered early still holds the page while its handler runs on.
    const lingering = entry.handlerRunning ? ', but its handler is still running' : '';
    const image = imageText(entry);
    dom.append(what, `, ${entry.outcome}${took}${lingering}${image === null ? '' : `, ${image}`}`);
    // The grid lays out no white space between its cells; the space keeps
    // the entry's text, as a screen reader or a copy has it, readable.
    dom.append(line, element('span', 'time', timeText(entry.time)), ' ', what);
    return line;
  }

  let shownActivity: readonly ActivityEntry[] | null = null;

  function renderActivity(entries: readonly ActivityEntry[]): void {
    if (entries === shownActivity) return;
    shownActivity = entries;
    dom.replaceChildren(activity, entries.map(entryLine));
    if (entries.length === 0) dom.append(activity, element('li', 'muted', 'No calls yet'));
  }

  /** Whether the panel has opened by itself to show the code since anyone was last attached; see render. */
  let codeShown = false;

  // The M6 blocks (plan section 2.6): the state line, proposals, the
  // time-boxed session, agent tokens and the session record.

  /**
   * Whether the page's state reaches everyone attached (ADR 0040): the
   * operator sees that a guest can read it, and that pause holds it. Hidden
   * while the page shares nothing. The value itself is never shown.
   */
  let shownPublished: DockState['published'] = 'none';
  function syncStateLine(state: DockState): void {
    const published = state.published;
    if (published === shownPublished) return;
    shownPublished = published;
    dom.flag(stateLine, 'hidden', published === 'none');
    if (published === 'none') return;
    dom.attr(stateLine, 'class', 'muted');
    dom.setText(stateLine, STATE_LINES[published]);
  }
  // Proposals (ADR 0042): a row a proposal, newest on top so the rows shown
  // keep their place, each an armed box whose Accept is that call's
  // confirmation (S6). Dismissing grants nothing, so Dismiss all is not
  // held back, as Revoke all is not, and there is no Accept all (decision 3).
  const proposalLabel = element('div', 'label');
  const proposalList = element('ul', 'proposals');
  role(proposalList, 'proposal-list');
  dom.attr(proposalsBlock, 'aria-live', 'polite');
  dom.append(
    proposalsBlock,
    proposalLabel,
    proposalList,
    button('Dismiss all', 'proposal-dismiss-all', () => {
      dock.dismissAllProposals();
    }),
  );
  const proposalRows = new Map<string, ProposalRow>();
  /** Rows not yet on screen, which ring the badge as a join notice does. */
  const unseenProposals = new Set<string>();
  let proposalsPaused = false;

  function proposalRow(view: PendingProposal): ProposalRow {
    const box = element('li', 'row');
    dom.attr(box, 'data-proposal-id', view.proposalId);
    const { proposer } = view;
    const line = element('p');
    dom.append(
      line,
      person(personText(proposer)),
      badge(shortId(proposer.userId) !== null),
      ' proposes ',
      element('span', 'who', view.tool),
    );
    dom.append(box, line);
    const client = proposer.client === null ? '' : clientText(proposer.client);
    if (client !== '') {
      const said = element('p', 'muted', 'Client: ');
      dom.append(said, quotedClient(client));
      dom.append(box, said);
    }
    if (view.consequential) {
      dom.append(
        box,
        element('p', 'notice', 'Accepting runs this consequential tool without asking again.'),
      );
    }
    // The caller's words, escaped where a character would not read as written
    // (escapeUnseen), as text alone, and cut with the count left out.
    const args = element('pre', 'args');
    role(args, 'proposal-args');
    const text = view.arguments;
    // Never between the two halves of a pair, which would show as a broken character.
    const cut = ARGS_SHOWN - (/[\uD800-\uDBFF]/.test(text.charAt(ARGS_SHOWN - 1)) ? 1 : 0);
    const short =
      text.length > ARGS_SHOWN
        ? `${text.slice(0, cut)}... (${String(text.length - cut)} more characters)`
        : text;
    dom.setText(args, short);
    dom.append(box, element('p', 'muted', 'Arguments, as their client wrote them:'), args);
    const row: ProposalRow = {
      ...newBox(box),
      accept: element('button'),
      countdown: element('p', 'muted'),
      paused: element('p', 'muted', 'Resume the page to accept'),
      expiresAt: view.expiresAt,
    };
    if (short !== view.arguments) {
      let open = false;
      const toggle = button('Show all', 'proposal-args', () => {
        open = !open;
        dom.setText(args, open ? view.arguments : short);
        dom.attr(args, 'class', open ? 'args open' : 'args');
        dom.setText(toggle, open ? 'Show less' : 'Show all');
        // The row changed under the pointer, so its Accept waits again.
        restartArming(row);
      });
      dom.append(box, toggle);
    }
    row.accept = boxButton(row, 'Accept', 'proposal-accept', () => {
      dock.acceptProposal(view.proposalId);
    });
    const buttons = element('div', 'buttons');
    dom.append(
      buttons,
      row.accept,
      boxButton(
        row,
        'Dismiss',
        'proposal-dismiss',
        () => {
          dock.dismissProposal(view.proposalId);
        },
        true,
      ),
    );
    dom.append(box, buttons, row.paused, row.countdown);
    return row;
  }

  function syncProposals(state: DockState): void {
    const live = new Set(state.proposals.map((view) => view.proposalId));
    for (const [proposalId, row] of proposalRows) {
      if (live.has(proposalId)) continue;
      dropBox(row);
      proposalRows.delete(proposalId);
      unseenProposals.delete(proposalId);
    }
    for (const view of state.proposals) {
      if (proposalRows.has(view.proposalId)) continue;
      const row = proposalRow(view);
      proposalRows.set(view.proposalId, row);
      boxes.add(row);
      dom.prepend(proposalList, row.element);
      unseenProposals.add(view.proposalId);
    }
    const waiting = state.proposals.length;
    dom.flag(proposalsBlock, 'hidden', waiting === 0);
    dom.setText(proposalLabel, `Proposals (${String(waiting)})`);
    dom.setText(proposedTag, `${String(waiting)} proposed`);
    dom.flag(proposedTag, 'hidden', waiting === 0);
    // No Accept while paused (decision 13); Resume grants again, so each row waits anew.
    for (const row of proposalRows.values()) {
      dom.flag(row.accept, 'disabled', state.paused);
      dom.flag(row.paused, 'hidden', !state.paused);
      if (proposalsPaused && !state.paused) restartArming(row);
    }
    proposalsPaused = state.paused;
  }

  function tickProposals(): void {
    for (const row of proposalRows.values()) {
      dom.setText(row.countdown, `Expires in ${clockText(secondsLeft(row.expiresAt))}`);
    }
    if (!dom.has(panel, 'hidden') && doc.visibilityState === 'visible') unseenProposals.clear();
  }
  // Time-boxed sessions (ADR 0043): the form, and the running session's
  // countdown, links and controls. Start, Extend, New link and End sit in
  // armed boxes, as Create link does: the first three grant access, and End
  // sends a whole room away. The links live here in memory only, the first
  // still open shown as a QR to project, never stored (ADR 0017).
  const sessionForm = element('div', 'row');
  dom.flag(sessionForm, 'hidden', true);
  const formSession = newBox(sessionForm);
  boxes.add(formSession);
  const sessionToggle = button('Start a session', 'session-open', () => {
    sessionError = null;
    dom.flag(sessionForm, 'hidden', !dom.has(sessionForm, 'hidden'));
    render(dock.state);
  });
  /** A field of the form; a change restarts its wait, since Start then does something else. */
  function sessionField(text: string, action: WidgetAction, value: string, type = 'number') {
    const label = element('label', 'field', text);
    const input = element('input');
    dom.attr(input, 'type', type);
    dom.setValue(input, value);
    setAction(input, action);
    dom.append(label, input);
    dom.append(sessionForm, label);
    dom.listen(input, 'input', () => {
      sessionError = null;
      restartArming(formSession);
      render(dock.state);
    });
    return { label, input };
  }
  const sLabel = sessionField('Label', 'session-label', '', 'text');
  dom.attr(sLabel.input, 'maxlength', String(MAX_INVITE_LABEL_CHARS));
  const sLength = sessionField('Minutes, 30 to 240', 'session-length', '60');
  const sDrivers = sessionField('Driver seats', 'session-drivers', '1');
  const sObservers = sessionField('Observers by invite', 'session-observers', '0');
  const sProposals = element('div', 'choices', 'Proposals:');
  const proposalChoices = PROPOSALS_ORDER.map((value) => {
    const made = choice('session-proposals', value, value, 'session-proposals');
    dom.setChecked(made.input, value === dock.state.policy.proposals);
    dom.listen(made.input, 'change', () => {
      restartArming(formSession);
    });
    dom.append(sProposals, made.label);
    return [value, made] as const;
  });
  const sReason = element('p', 'muted');
  role(sReason, 'session-reason');
  const sEffects = element('p', 'muted');
  role(sEffects, 'session-effects');
  const startButton = boxButton(
    formSession,
    'Start',
    'session-start',
    () => {
      void beginSession();
    },
    true,
  );
  dom.append(sessionForm, sProposals, sReason, sEffects, startButton);

  const running = element('div', 'row');
  const runningBox = newBox(running);
  boxes.add(runningBox);
  const sCountdown = element('p', 'who');
  role(sCountdown, 'session-countdown');
  // Five minutes and one minute left, told once each, and a link that did not come.
  const sAlert = element('p', 'notice');
  dom.attr(sAlert, 'aria-live', 'polite');
  const sSponsor = element('p', 'muted');
  role(sSponsor, 'session-sponsor');
  const sWarning = element('p', 'notice');
  role(sWarning, 'session-sponsor-warning');
  const sQr = createQrView(doc, { accept: inviteQrUrl, label: 'Session QR code: scan to join' });
  const sQrBox = element('div', 'qr');
  dom.append(sQrBox, sQr.element);
  const sLinkText = element('p', 'link-text');
  const qrToggle = button('Show QR', 'session-qr', () => {
    qrOpen = !qrOpen;
    render(dock.state);
  });
  const renew = boxButton(runningBox, 'New link', 'session-renew', () => {
    void renewLink();
  });
  const extend = boxButton(runningBox, 'Extend 15 min', 'session-extend', () => {
    dock.extendSession(SESSION_EXTEND_MS / 60_000);
  });
  const end = boxButton(runningBox, 'End session', 'session-end', () => {
    ending = true;
    render(dock.state);
  });
  const endRow = element('div', 'buttons');
  const endText = element('span');
  dom.append(
    endRow,
    endText,
    boxButton(
      runningBox,
      'End now',
      'session-end-yes',
      () => {
        ending = false;
        dock.endSession();
      },
      true,
    ),
    button('Keep it', 'session-end-no', () => {
      ending = false;
      render(dock.state);
    }),
  );
  const runningButtons = element('div', 'buttons');
  dom.append(runningButtons, qrToggle, renew, extend, end);
  dom.append(
    running,
    sCountdown,
    sAlert,
    sSponsor,
    sWarning,
    sQrBox,
    sLinkText,
    runningButtons,
    endRow,
  );
  const sHeading = element('div', 'label');
  const sEnded = element('p', 'muted');
  role(sEnded, 'session-ended');
  dom.append(sessionBlock, sHeading, sEnded, running, sessionForm, sessionToggle);

  /** This session's links in the order minted, held here alone; see the block's comment. */
  let sessionLinks: readonly SessionLink[] = [];
  let qrOpen = false;
  let ending = false;
  let sessionStarting = false;
  let sessionError: string | null = null;
  /** How many of SESSION_WARNINGS_MS have been told. */
  let warned = 0;

  function counted(n: number, one: string, many: string): string {
    return `${String(n)} ${n === 1 ? one : many}`;
  }

  function syncSession(state: DockState): void {
    const live = state.session;
    const ended = state.sessionEnded;
    const guests = state.roster.filter((entry) => entry.inviteId !== null).length;
    dom.flag(sessionBlock, 'hidden', !state.sessionsOffered && live === null && ended === null);
    dom.flag(running, 'hidden', live === null);
    dom.flag(sessionToggle, 'hidden', live !== null || !state.sessionsOffered);
    dom.flag(sEnded, 'hidden', ended === null || live !== null);
    // The label is the page's own words, quoted so it reads as a name (S10).
    setText(sHeading, live === null ? 'Session' : `Session "${live.label}"`);
    if (ended !== null) setText(sEnded, `Session "${ended.label}" ended (${ended.reason}).`);
    if (live === null) {
      sessionLinks = [];
      qrOpen = false;
      ending = false;
      syncSessionForm(state, guests);
      return;
    }
    dom.flag(sessionForm, 'hidden', true);
    setText(
      sSponsor,
      live.sponsor === null ? '' : `Invites shared by ${plainLine(live.sponsor.displayName)}`,
    );
    // One QR at a time: the first link whose invite still has a use left (C12).
    const shown = sessionLinks.find((entry) =>
      state.invites.some((view) => view.inviteId === entry.inviteId && view.usesLeft > 0),
    );
    dom.flag(sQrBox, 'hidden', !qrOpen || !sQr.show(shown?.link));
    setText(sLinkText, qrOpen && shown !== undefined ? shown.link : '');
    dom.flag(qrToggle, 'hidden', shown === undefined);
    setText(qrToggle, qrOpen ? 'Hide QR' : 'Show QR');
    dom.flag(renew, 'hidden', shown !== undefined || live.observers === 0);
    dom.flag(endRow, 'hidden', !ending);
    setText(endText, `End now? ${counted(guests, 'guest leaves.', 'guests leave.')} `);
  }

  function syncSessionForm(state: DockState, guests: number): void {
    const { policy, roster } = state;
    dom.flag(sDrivers.label, 'hidden', policy.maxDrivers < 2);
    dom.attr(sDrivers.input, 'max', String(policy.maxDrivers));
    dom.flag(
      sObservers.label,
      'hidden',
      policy.invites === 'off' || (state.invitesOffered?.linkBase ?? null) === null,
    );
    dom.attr(sObservers.input, 'max', String(sessionSeats(state.seatLimits)));
    dom.flag(sProposals, 'hidden', policy.proposals === 'off');
    for (const [value, made] of proposalChoices) {
      dom.flag(
        made.label,
        'hidden',
        PROPOSALS_ORDER.indexOf(value) > PROPOSALS_ORDER.indexOf(policy.proposals),
      );
    }
    const observers = dom.has(sObservers.label, 'hidden') ? 0 : Number(dom.value(sObservers.input));
    // Whom the relay names the invites' sponsor (ADR 0017): the member attached longest.
    const sponsor = roster
      .filter((entry) => entry.kind === 'member')
      .sort((a, b) => a.grantedAt - b.grantedAt)[0];
    const blocker =
      state.link !== 'linked'
        ? REFUSAL_TEXT.link_down
        : observers > 0 && sponsor === undefined
          ? REFUSAL_TEXT.no_sponsor
          : null;
    const reason = blocker ?? (sessionStarting ? 'Starting' : sessionError);
    setText(sReason, reason ?? '');
    dom.flag(sReason, 'hidden', reason === null);
    // Whom Start makes observers: the drivers past its seats, newest first, as both layers pick them.
    const demoted = roster
      .filter((entry) => entry.role === 'driver')
      .sort((a, b) => a.grantedAt - b.grantedAt)
      .slice(Number(dom.value(sDrivers.input)) || 1)
      .map((entry) => personText(entry));
    // Named before Start, since their leaving ends everyone the invites let in (S14).
    setText(
      sEffects,
      `${observers > 0 && sponsor !== undefined ? `Invites shared by ${personText(sponsor)}, whose leaving ends guests' access. ` : ''}At its end ${counted(guests, 'guest leaves', 'guests leave')} and ${counted(state.invites.length, 'link closes', 'links close')}.${demoted.length > 0 ? ` Start makes ${demoted.join(', ')} observers.` : ''}`,
    );
    dom.flag(
      startButton,
      'disabled',
      blocker !== null || sessionStarting || dom.value(sLabel.input).trim() === '',
    );
    setText(sessionToggle, dom.has(sessionForm, 'hidden') ? 'Start a session' : 'Close the form');
  }

  async function beginSession(): Promise<void> {
    sessionStarting = true;
    render(dock.state);
    const hidden = (field: { label: HTMLElement }): boolean => dom.has(field.label, 'hidden');
    const result = await dock.startSession({
      label: dom.value(sLabel.input).trim(),
      lengthMinutes: Number(dom.value(sLength.input)),
      drivers: hidden(sDrivers) ? 1 : Number(dom.value(sDrivers.input)),
      observers: hidden(sObservers) ? 0 : Number(dom.value(sObservers.input)),
      proposals: proposalChoices.find(([, made]) => dom.checked(made.input))?.[0] ?? 'off',
    });
    sessionStarting = false;
    if (!mounted) return;
    if (result.ok) {
      sessionLinks = result.links;
      qrOpen = sessionLinks.length > 0;
      warned = 0;
      dom.setValue(sLabel.input, '');
      setText(sAlert, result.inviteRefusal === undefined ? '' : REFUSAL_TEXT[result.inviteRefusal]);
    } else {
      sessionError = `The session did not start (${result.reason}).`;
    }
    render(dock.state);
  }

  async function renewLink(): Promise<void> {
    const result = await dock.renewSessionLink();
    if (!mounted) return;
    if (result.ok) {
      sessionLinks = [{ inviteId: result.inviteId, link: result.link }];
      qrOpen = true;
    } else {
      setText(sAlert, REFUSAL_TEXT[result.reason]);
    }
    render(dock.state);
  }

  /** Every second: the countdown, the badge's minutes, the two warnings and the sponsor's. */
  function tickSession(): void {
    const live = dock.state.session;
    dom.flag(sessionTag, 'hidden', live === null);
    if (live === null) return;
    const left = Math.max(0, live.endsAt - Date.now());
    setText(sCountdown, `Ends in ${clockText(Math.ceil(left / 1000))}`);
    setText(sessionTag, `${String(Math.ceil(left / 60_000))} min`);
    const due = SESSION_WARNINGS_MS.filter((at) => left <= at).length;
    // An extension takes a told warning back.
    if (due > warned) setText(sAlert, `${String(Math.ceil(left / 60_000))} min left.`);
    warned = due;
    dom.flag(extend, 'disabled', live.lengthMinutes * 60_000 + SESSION_EXTEND_MS > MAX_SESSION_MS);
    // The sponsor's attachment ending first, if unused, ends everyone their invites let in.
    const held = dock.state.roster.find((entry) => entry.userId === live.sponsor?.userId);
    const early = held?.expiresAt != null && held.expiresAt < live.endsAt;
    setText(
      sWarning,
      early ? `${personText(held)} may time out first, and their guests with them.` : '',
    );
    dom.flag(sWarning, 'hidden', !early);
  }
  /** The live agent tokens as last drawn, so a frame that changes nothing redraws nothing. */
  let shownAgents = '';
  let agentBoxes: ArmedBox[] = [];
  /**
   * The relay's list of this page's live agent tokens, each with Cancel in
   * an armed box: the list is drawn anew on every change, so a row can move
   * under the pointer as another token goes, and a click meant for one must
   * never cancel the next. The label is this page's own words, quoted so it
   * reads as a name.
   */
  function syncAgents(state: DockState): void {
    const live = state.agents;
    // A command whose token the relay no longer lists (burned, cancelled, expired) is dead: it goes.
    const shown = shownCommand?.tokenId;
    if (shown && state.agentsOffered !== null && !live.some((view) => view.tokenId === shown)) {
      hideCommand();
    }
    dom.flag(agentsBlock, 'hidden', live.length === 0 && shownCommand === null);
    const key = JSON.stringify(live);
    if (key === shownAgents) return;
    shownAgents = key;
    agentBoxes.forEach(dropBox);
    agentBoxes = live.map(agentRow);
    dom.replaceChildren(
      agentList,
      agentBoxes.map((box) => box.element),
    );
  }

  function agentRow(view: AgentView): ArmedBox {
    const row = element('li', 'row');
    const box = newBox(row);
    boxes.add(box);
    dom.attr(row, 'data-token-id', view.tokenId);
    const buttons = element('div', 'buttons');
    dom.append(
      buttons,
      boxButton(box, 'Cancel', 'agent-cancel', () => {
        dock.cancelAgent(view.tokenId);
      }),
    );
    dom.append(
      row,
      element('p', 'who', `"${view.label}", agent token`),
      element('p', 'muted', `${AGENT_STATES[view.state]}, until ${timeText(view.expiresAt)}`),
      buttons,
    );
    return box;
  }
  // The session record (ADR 0045): what the current record holds, Save
  // record to open the box that saves one, and the offer of a session's
  // record at its end. Each Save sits in an armed box beside a warning that
  // says how many people the file names, and the offer and the box are never on show
  // together, so each Save is the only one of its name.
  const recordSummary = element('p', 'muted');
  role(recordSummary, 'record-summary');
  const recordOpen = button('Save record', 'record-open', () => {
    showRecordBox(recordBox === null);
    render(dock.state);
  });
  dom.append(recordBlock, element('div', 'label', 'Session record'), recordSummary, recordOpen);
  /**
   * The box while it is open, the record chosen in it, that record's own
   * identity (its slot, kind and start), and its parts that change.
   */
  let recordBox: (ArmedBox & { which: RecordWhich; chosen: string }) | null = null;
  const recordChoices = element('div', 'choices col');
  dom.attr(recordChoices, 'role', 'radiogroup');
  let shownChoices = '';
  const boxWarning = element('p');
  role(boxWarning, 'record-warning');
  let discardButton: HTMLButtonElement | null = null;
  /** The offer while it shows, and the ended record it was made for, by its span. */
  let offer: ArmedBox | null = null;
  let offeredKey = '';
  dom.attr(recordOfferBox, 'aria-live', 'polite');

  const recordCounts = (view: RecordView): string =>
    `${counted(view.calls, 'call', 'calls')}, ${counted(view.people, 'person', 'people')}`;

  /** Whom a record names, said before any Save as counts: how many people, and how many by an email address (ADR 0017). */
  function warning(view: RecordView): string {
    return `This record names ${counted(view.people, 'person', 'people')}${view.emails > 0 ? `, ${String(view.emails)} of them by email address,` : ''} and every call they made on this page, never its arguments or result. Anyone you share the file with can read it.`;
  }

  /** Saves one record as JSON or as its Markdown summary; the object URL goes a minute later. */
  function saveRecord(which: RecordWhich, kind: 'json' | 'md'): void {
    const record = dock.sessionRecord(which);
    if (record === null) return;
    timers.after(
      dom.save(
        wrap,
        sessionRecordFileName(record, kind),
        kind === 'json' ? 'application/json' : 'text/markdown;charset=utf-8',
        kind === 'json' ? sessionRecordJson(record) : sessionRecordMarkdown(record),
      ),
      60_000,
    );
  }

  function saveButtons(box: ArmedBox, which: () => RecordWhich): HTMLElement {
    const buttons = element('div', 'buttons');
    dom.append(
      buttons,
      boxButton(
        box,
        'Save JSON',
        'record-save-json',
        () => {
          saveRecord(which(), 'json');
        },
        true,
      ),
      boxButton(box, 'Save summary', 'record-save-md', () => {
        saveRecord(which(), 'md');
      }),
    );
    return buttons;
  }

  function showRecordBox(open: boolean): void {
    if (recordBox !== null) dropBox(recordBox);
    recordBox = null;
    if (!open) return;
    closeOffer();
    const box = {
      ...newBox(element('div', 'prompt')),
      which: 'current' as RecordWhich,
      chosen: '',
    };
    role(box.element, 'record-box');
    boxes.add(box);
    recordBox = box;
    shownChoices = '';
    const buttons = saveButtons(box, () => box.which);
    discardButton = boxButton(box, '', 'record-discard', () => {
      dock.discardRecord(box.which);
      box.which = 'current';
      restartArming(box);
      render(dock.state);
    });
    dom.append(buttons, discardButton);
    dom.append(box.element, recordChoices, boxWarning, buttons);
    dom.append(recordBlock, box.element);
  }

  function closeOffer(): void {
    if (offer === null) return;
    timers.cancel(offer.timer);
    boxes.delete(offer);
    offer = null;
    dom.replaceChildren(recordOfferBox, []);
    dom.flag(recordOfferBox, 'hidden', true);
  }

  /** A session's end offers its record, armed like the box, and never saves it by itself. */
  function showOffer(view: RecordView): void {
    showRecordBox(false);
    const box = newBox(recordOfferBox);
    boxes.add(box);
    offer = box;
    dom.attr(recordOfferBox, 'class', 'prompt');
    const buttons = saveButtons(box, () => 'ended');
    dom.append(
      buttons,
      boxButton(box, 'Close', 'record-offer-close', () => {
        closeOffer();
        render(dock.state);
      }),
    );
    const told = element('p', '', warning(view));
    role(told, 'record-warning');
    dom.replaceChildren(recordOfferBox, [
      element('p', '', `Session "${view.label ?? ''}" ended. Save its record?`),
      told,
      buttons,
    ]);
    dom.flag(recordOfferBox, 'hidden', false);
  }

  /** A record's name in the box's choice: whose session, when, and what it holds. */
  function recordName(view: RecordView): string {
    const what =
      view.scope === 'session'
        ? `Session "${view.label ?? ''}"`
        : view.which === 'current'
          ? 'This page session'
          : 'The last page session';
    const when =
      view.to === null
        ? `since ${timeText(view.from)}`
        : `${timeText(view.from)} to ${timeText(view.to)}`;
    return `${what}, ${when}: ${recordCounts(view)}`;
  }

  /** Returns whether a session's end offers its record, which opens the panel as a join notice does. */
  function syncRecords(state: DockState): boolean {
    const views = state.records;
    const failed = views.some((view) => view.failed);
    const now = views.find((view) => view.which === 'current');
    dom.flag(recordBlock, 'hidden', views.length === 0);
    setText(
      recordSummary,
      failed
        ? 'The record stopped after an error; the audit log keeps every call.'
        : now === undefined || now.calls + now.people === 0
          ? 'Nothing recorded yet'
          : `${recordCounts(now)} since ${timeText(now.from)}`,
    );
    const held = failed
      ? []
      : views.filter((view) => view.calls + view.people + view.proposals > 0);
    dom.flag(recordOpen, 'disabled', held.length === 0);
    if (held.length === 0) showRecordBox(false);
    const box = recordBox;
    if (box !== null) {
      const chosen = held.find((view) => view.which === box.which) ?? held[0];
      // Another record in the chosen slot is another file to save, so the box
      // waits again whether or not it moved: a session's start, a new page
      // session or a page script's discardRecord replaces a slot's record in place.
      const identity = chosen && `${chosen.which} ${chosen.scope} ${String(chosen.from)}`;
      if (chosen !== undefined && identity !== box.chosen) {
        box.which = chosen.which;
        box.chosen = identity ?? '';
        restartArming(box);
      }
      const names = held.map(recordName);
      const key = JSON.stringify([names, box.which]);
      if (key !== shownChoices) {
        shownChoices = key;
        dom.replaceChildren(
          recordChoices,
          held.map((view, at) => {
            const made = choice(
              'record-which',
              view.which,
              names[at] ?? '',
              `record-which-${view.which}`,
            );
            dom.setChecked(made.input, view.which === box.which);
            dom.listen(made.input, 'change', () => {
              box.which = view.which;
              // Save now saves another record, so the box waits again.
              restartArming(box);
              render(dock.state);
            });
            return made.label;
          }),
        );
      }
      dom.flag(recordChoices, 'hidden', held.length < 2);
      if (chosen !== undefined) setText(boxWarning, warning(chosen));
      if (discardButton !== null) {
        setText(discardButton, box.which === 'current' ? 'Clear' : 'Discard');
      }
    }
    // Only a record that holds something is offered, as only such a one is in the box.
    const ended = held.find((view) => view.which === 'ended');
    const key = ended === undefined ? '' : `${String(ended.from)}:${String(ended.to)}`;
    if (key === offeredKey) return false;
    offeredKey = key;
    closeOffer();
    if (ended === undefined) return false;
    showOffer(ended);
    return true;
  }

  function tick(): void {
    for (const view of [...requestViews.values(), ...confirmViews.values()]) {
      dom.setText(view.countdown, `Denied automatically in ${secondsLeft(view.expiresAt)} s`);
    }
    for (const view of rowViews.values()) dom.setText(view.expiry, expiryText(view.expiresAt));
    for (const row of inviteRows.values()) setText(row.detail, inviteDetail(row.view));
    tickSession();
    tickProposals();
    ageJoinLines();
    updateAttention();
    const current = dock.state.pairing;
    if (current) {
      const left = secondsLeft(current.expiresAt);
      dom.setText(
        expiry,
        left > 0 ? `Expires in ${clockText(left)}` : 'Expired, waiting for a new code',
      );
    }
    // Catches shifts no state change caused, such as a resized window or a scrolled panel.
    checkMoves();
  }

  function render(state: DockState): void {
    if (state.link === 'closed' && state.error === null) {
      unmount();
      return;
    }
    dom.attr(dot, 'class', `dot ${state.link}`);
    dom.attr(
      badgeButton,
      'title',
      `Tabdock: ${LINK_LABELS[state.link]}${state.paused ? ', paused' : ''}`,
    );
    dom.setText(errorLine, state.error ?? '');
    dom.flag(errorLine, 'hidden', state.error === null);
    dom.setText(noticeLine, state.notice ?? '');
    dom.flag(noticeLine, 'hidden', state.notice === null);

    dom.flag(pairing, 'hidden', state.pairing === null);
    dom.setText(code, state.pairing?.code ?? '');
    // A new pairing carries a new URL, so it redraws; one without a URL clears the code.
    dom.flag(qrBox, 'hidden', !qr.show(state.pairing?.url));
    dom.flag(rotate, 'disabled', state.link !== 'linked');

    syncInvites(state);
    syncRows(state);
    // Everyone attached, and how many of them watch, in its title (ADR 0044).
    dom.setText(count, String(state.roster.length));
    dom.attr(
      count,
      'title',
      `${String(state.roster.length - watchCount)} people, ${String(watchCount)} watching`,
    );
    const joined = noticeJoins(state);
    const seated = noticeSeats(state);
    updateForm(state);
    renderActivity(state.activity);
    updatePause(state.paused);
    syncStateLine(state);
    syncProposals(state);
    syncSession(state);
    syncAgents(state);
    const offered = syncRecords(state);

    const newRequest = syncPrompts(
      requestViews,
      state.pendingRequests,
      (r) => r.requestId,
      (r) => requestView(r, state),
    );
    const newConfirm = syncPrompts(
      confirmViews,
      state.pendingConfirms,
      (c) => c.callId,
      confirmView,
    );
    // A new prompt opens the panel, as the operator has a deadline to meet, and
    // so does a join notice, as nobody was asked about that join, a seat
    // notice, as the operator was answered with less than they chose, and the
    // offer of a session's record, which the browser saves only on a click.
    if (newRequest || newConfirm || joined || seated || offered) setOpen(true);
    // The code is how anyone attaches, so show it without a click while nobody has.
    // Only once on the way in, so the badge can still close the panel: a link that
    // drops and resumes with nobody attached leaves the panel as the operator left it.
    // Once someone has attached, the next time nobody is counts as a new way in.
    if (state.roster.length > 0) {
      codeShown = false;
    } else if (state.link === 'linked' && state.pairing !== null && !codeShown) {
      codeShown = true;
      setOpen(true);
    }
    // After every change the relay or the page made above, which may have moved the boxes.
    tick();
  }

  /**
   * A tab coming back into view, or its window into focus, is a new sight of
   * every box, so each waits again before taking a click: a box that armed
   * while the operator was elsewhere must not take the first click on return.
   */
  function rearmAll(): void {
    for (const box of boxes) restartArming(box);
  }
  const onVisibility = (): void => {
    ageJoinLines();
    updateAttention();
    if (doc.visibilityState === 'visible') rearmAll();
  };
  const win = doc.defaultView;

  let mounted = true;
  const unsubscribe = dock.on('state', render);
  const interval = timers.every(tick, 1000);
  doc.addEventListener('visibilitychange', onVisibility);
  win?.addEventListener('focus', rearmAll);

  function unmount(): void {
    if (!mounted) return;
    mounted = false;
    unsubscribe();
    timers.stop(interval);
    doc.removeEventListener('visibilitychange', onVisibility);
    win?.removeEventListener('focus', rearmAll);
    for (const box of boxes) timers.cancel(box.timer);
    hideLink();
    hideCommand();
    dom.remove(host);
  }

  const place = (): void => {
    // body is typed as always present, but a document can lack one.
    const body = doc.body as HTMLElement | null;
    if (mounted) dom.append(body ?? doc.documentElement, host);
  };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', place, { once: true });
  else place();
  render(dock.state);
  return unmount;
}

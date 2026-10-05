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
// Buttons carry stable data-action attributes for browser tests.

import {
  type Account,
  type AttachmentView,
  INVITE_BURN_REFUSALS,
  INVITEE_SHORT_ID_CHARS,
  InviteeIdSchema,
  MAX_INVITE_LABEL_CHARS,
  MAX_INVITE_USES,
  MAX_LIVE_INVITES_PER_PAGE,
  plainLine,
  type Role,
  UNVERIFIED_ACCOUNT_NAME,
} from '@tabdock/protocol';
import type {
  ActivityEntry,
  Dock,
  DockState,
  InviteJoin,
  InviteLifetime,
  InviteRefusal,
  InviteView,
  LinkState,
  PageRole,
  PendingConfirm,
  PendingRequest,
} from './core.ts';
import { type BoxRect, takeDom } from './dom.ts';
import { createQrView, inviteQrUrl, QR_SIDE_PX } from './qr.ts';
import { apply, taken } from './taken.ts';

/** A valid custom element name needs no registration to host a shadow root, so nothing is defined globally. */
const HOST_TAG = 'tabdock-dock';

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
`;

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
  readonly name: HTMLElement;
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

  /** Every armed box on show: prompts, roster rows, the pause control and the Invite form. */
  const boxes = new Set<ArmedBox>();
  const requestViews = new Map<string, PromptView>();
  const confirmViews = new Map<string, PromptView>();
  const rowViews = new Map<string, RowView>();
  const inviteRows = new Map<string, InviteRowView>();

  function button(label: string, action: string, onClick: () => void, primary = false) {
    const node = element('button', primary ? 'action primary' : 'action', label);
    dom.attr(node, 'type', 'button');
    dom.attr(node, 'data-action', action);
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
    dom.attr(node, 'data-role', 'invited');
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
    dom.attr(node, 'data-role', 'confirmed');
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
    action: string,
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
  dom.attr(joins, 'data-role', 'joins');
  dom.attr(joins, 'aria-live', 'polite');
  const prompts = element('div');
  dom.attr(prompts, 'aria-live', 'polite');

  const pairing = element('div');
  const code = element('div', 'code');
  dom.attr(code, 'data-role', 'pairing-code');
  const expiry = element('p', 'muted');
  const rotate = button('New code', 'rotate', () => {
    dock.rotatePairing();
  });
  // Shown only when the relay sent a pairing URL the QR module accepts.
  const qr = createQrView(doc);
  const qrBox = element('div', 'qr');
  dom.attr(qrBox, 'data-role', 'pairing-qr');
  dom.flag(qrBox, 'hidden', true);
  dom.append(qrBox, qr.element);
  const pairText = element('div', 'pair-text');
  dom.append(pairText, code, expiry, rotate);
  const pairRow = element('div', 'pair');
  dom.append(pairRow, qrBox, pairText);
  dom.append(pairing, element('div', 'label', 'Pairing code'), pairRow);

  const roster = element('ul');
  dom.attr(roster, 'data-role', 'roster');
  const nobody = element('p', 'muted', 'Nobody yet');
  // Revoking only takes access away, so it is not held back like the boxes.
  const revokeAll = button('Revoke all', 'revoke-all', () => {
    dock.revoke('*');
  });
  const rosterBlock = element('div');
  dom.append(rosterBlock, element('div', 'label', 'Attached'), roster, nobody, revokeAll);

  // Invites (ADR 0017): the link shown once, the live list, and the form.
  const invitesBlock = element('div');
  dom.attr(invitesBlock, 'data-role', 'invites');
  dom.flag(invitesBlock, 'hidden', true);

  const linkBox = element('div', 'prompt');
  dom.attr(linkBox, 'data-role', 'invite-link');
  dom.flag(linkBox, 'hidden', true);
  const linkHeading = element('p');
  const linkQr = createQrView(doc, {
    accept: inviteQrUrl,
    label: 'Invite QR code: scan it with a phone to join',
  });
  const linkQrBox = element('div', 'qr');
  dom.attr(linkQrBox, 'data-role', 'invite-qr');
  dom.append(linkQrBox, linkQr.element);
  const linkText = element('p', 'link-text');
  dom.attr(linkText, 'data-role', 'invite-link-text');
  const copyLink = button('Copy link', 'invite-copy', () => {
    copyShownLink();
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
  dom.attr(inviteList, 'data-role', 'invite-list');
  const noInvites = element('p', 'muted', 'No live invites');
  const inviteError = element('p', 'error');
  dom.attr(inviteError, 'data-role', 'invite-error');
  dom.flag(inviteError, 'hidden', true);
  const inviteToggle = button('Invite someone', 'invite-open', () => {
    // Any hidden attribute, 'until-found' too, means closed.
    setFormOpen(dom.has(formBox, 'hidden'));
  });

  // The form is an armed box: Create grants access, as Allow does.
  const formBox = element('div', 'row');
  dom.attr(formBox, 'data-role', 'invite-form');
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
  dom.attr(labelInput, 'data-action', 'invite-label');
  dom.append(labelField, labelInput);

  function choice(
    group: string,
    value: string,
    text: string,
    action: string,
  ): { label: HTMLLabelElement; input: HTMLInputElement } {
    const label = element('label');
    const input = element('input');
    dom.attr(input, 'type', 'radio');
    dom.attr(input, 'name', group);
    dom.attr(input, 'value', value);
    dom.attr(input, 'data-action', action);
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
  dom.setChecked(watchChoice.input, true);
  dom.append(roleChoices, watchChoice.label, controlChoice.label);

  const lifetimeChoices = element('div', 'choices');
  dom.attr(lifetimeChoices, 'role', 'radiogroup');
  dom.attr(lifetimeChoices, 'aria-label', 'How long the link works');
  const lifetimeInputs = LIFETIME_CHOICES.map(([value, text]) => {
    const made = choice('invite-lifetime', value, text, `invite-lifetime-${value}`);
    dom.setChecked(made.input, value === '1h');
    dom.append(lifetimeChoices, made.label);
    return [value, made.input] as const;
  });

  const usesField = element('label', 'field', 'Uses');
  const usesInput = element('input');
  dom.attr(usesInput, 'type', 'number');
  dom.attr(usesInput, 'min', '1');
  dom.attr(usesInput, 'max', String(MAX_INVITE_USES));
  dom.attr(usesInput, 'step', '1');
  dom.setValue(usesInput, '1');
  dom.attr(usesInput, 'data-action', 'invite-uses');
  dom.append(usesField, usesInput);

  const formReason = element('p', 'muted');
  dom.attr(formReason, 'data-role', 'invite-reason');
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
  dom.append(formBox, labelField, roleChoices, lifetimeChoices, usesField, formReason, formButtons);

  for (const input of [watchChoice.input, controlChoice.input]) {
    dom.listen(input, 'change', () => {
      // Create now grants something else, so the form waits again.
      restartArming(formView);
      render(dock.state);
    });
  }
  dom.listen(labelInput, 'input', () => {
    render(dock.state);
  });

  dom.append(
    invitesBlock,
    element('div', 'label', 'Invites'),
    linkBox,
    inviteList,
    noInvites,
    inviteError,
    formBox,
    inviteToggle,
  );

  // A fixed height, so new calls never move the boxes around it.
  const activity = element('ol', 'activity');
  dom.attr(activity, 'data-role', 'activity');
  dom.attr(activity, 'aria-label', 'Recent calls, newest first');
  const activityBlock = element('div');
  dom.append(activityBlock, element('div', 'label', 'Activity'), activity);

  // Last in the panel, beside the badge, where other changes move it least.
  const pauseBox = element('div', 'pause');
  dom.attr(pauseBox, 'data-role', 'pause-box');
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

  dom.append(
    panel,
    errorLine,
    noticeLine,
    joins,
    prompts,
    pairing,
    rosterBlock,
    invitesBlock,
    activityBlock,
    pauseBox,
  );

  const dot = element('span', 'dot');
  const count = element('span', 'count', '0');
  const pausedTag = element('span', 'tag', 'Paused');
  dom.attr(pausedTag, 'data-role', 'badge-paused');
  const badgeButton = button('', 'toggle', () => {
    // Any hidden attribute, 'until-found' too, means closed.
    setOpen(dom.has(panel, 'hidden'));
  });
  dom.attr(badgeButton, 'class', 'badge');
  dom.attr(badgeButton, 'aria-expanded', 'false');
  dom.append(badgeButton, dot, element('span', '', 'Tabdock'), count, pausedTag);

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
    const who = personText(request.user, request.account);
    const line = element('p');
    if (request.invite !== null) {
      // The account beside the label the operator gave the invite, which is this page's own text.
      dom.append(line, `${who} wants to join by your invite "${request.invite.label}"`);
    } else {
      const via = request.via === 'qr' ? 'QR code' : 'code';
      dom.append(line, `${who} wants to attach via ${via}`);
    }
    dom.append(line, badge(request.invite !== null || request.account.kind === 'invitee'));
    dom.append(box, line);
    if (!request.account.verified) {
      dom.append(
        box,
        element('p', 'muted', 'Unverified account: the sign-in provider vouches for no email.'),
      );
    }
    const drivers = state.roster.filter((attachment) => attachment.role === 'driver').length;
    if (request.invite !== null && drivers >= state.policy.maxDrivers) {
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
    dom.append(
      buttons,
      boxButton(view, 'Allow as driver', 'approve-driver', () => {
        dock.approve(request.requestId, 'driver');
      }),
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
    dom.append(line, `${personText(confirm.caller)} wants to run ${confirm.tool}`);
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

  function rowView(userId: string): RowView {
    const box = element('li', 'row');
    dom.attr(box, 'data-user-id', userId);
    const closeLink = element('label', 'check');
    const closeInput = element('input');
    dom.attr(closeInput, 'type', 'checkbox');
    dom.attr(closeInput, 'data-action', 'close-link');
    dom.append(closeLink, closeInput, 'and close this link');
    dom.flag(closeLink, 'hidden', true);
    const view: RowView = {
      ...newBox(box),
      name: element('span'),
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
    const buttons = element('div', 'buttons');
    dom.append(
      buttons,
      view.roleSwitch,
      boxButton(view, 'Revoke', 'revoke', () => {
        // The box's own choice when it shows, which starts checked; the
        // adapter's default otherwise, which closes a multi-use link (ADR 0016).
        if (dom.has(view.closeLink, 'hidden')) dock.revoke(userId);
        else dock.revoke(userId, { closeInvite: dom.checked(view.closeInput) });
      }),
      view.closeLink,
    );
    const who = element('p', 'who');
    dom.append(who, view.name, view.badge);
    dom.append(box, who, view.clients, view.expiry, buttons);
    return view;
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
  ): void {
    view.expiresAt =
      attachment.endsAt === null
        ? attachment.expiresAt
        : Math.min(attachment.endsAt, attachment.expiresAt ?? attachment.endsAt);
    const role = access?.role ?? null;
    const revoking = access?.revoked === true;
    const status = role ?? (revoking ? 'revoke pending' : 'not approved on this page');
    setText(view.name, `${personText(attachment)} (${status})`);
    setText(view.badge, invited(attachment) ? 'invited' : '');
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
    dom.attr(view.roleSwitch, 'data-action', promote ? 'make-driver' : 'make-observer');
    // "and close this link" starts checked whenever it appears.
    if (closable && dom.has(view.closeLink, 'hidden')) dom.setChecked(view.closeInput, true);
    dom.flag(view.closeLink, 'hidden', !closable);
    // The role switch may now do the opposite of what the operator was reaching for, or be gone.
    if (!isNew) restartArming(view);
  }

  /** The rows in the roster list and the rows in the invite list, in order, as last put there. */
  let rosterShown: readonly HTMLElement[] = [];
  let inviteListShown: readonly HTMLElement[] = [];

  /** Rows are kept by user id and only reordered when the relay's order changes, like prompts. */
  function syncRows(state: DockState): void {
    const access = new Map(state.pageRoles.map((entry) => [entry.userId, entry]));
    const invites = new Map(state.invites.map((view) => [view.inviteId, view]));
    const live = new Set(state.roster.map((attachment) => attachment.userId));
    for (const [userId, view] of rowViews) {
      if (!live.has(userId)) {
        dropBox(view);
        rowViews.delete(userId);
      }
    }
    const ordered = state.roster.map((attachment) => {
      let view = rowViews.get(attachment.userId);
      if (!view) {
        view = rowView(attachment.userId);
        rowViews.set(attachment.userId, view);
        boxes.add(view);
      }
      const invite = attachment.inviteId === null ? undefined : invites.get(attachment.inviteId);
      updateRow(view, attachment, access.get(attachment.userId), invite);
      // Role changes need the relay; revoking works offline and is sent on resume.
      dom.flag(view.roleSwitch, 'disabled', state.link !== 'linked');
      return view.element;
    });
    if (!sameNodes(rosterShown, ordered)) {
      dom.replaceChildren(roster, ordered);
      rosterShown = ordered;
    }
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
      const line = element(
        'p',
        'join',
        `${personText(join.user, join.account)} joined by your invite "${join.label}" as ${role.role}`,
      );
      // Not data-user-id, which names roster rows.
      dom.attr(line, 'data-joined', join.user.userId);
      dom.prepend(joins, line);
      joinLines.push({ element: line, shownMs: 0, since: null, seen: false });
      added = true;
    }
    return added;
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

  /** The badge asks for attention while a prompt waits or a join notice has not been seen. */
  function updateAttention(): void {
    const waiting = requestViews.size + confirmViews.size > 0;
    const attention = waiting || joinLines.some((line) => !line.seen);
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

  /** Why Create cannot work now, or null. */
  function inviteBlocker(state: DockState): string | null {
    if (state.link !== 'linked') return REFUSAL_TEXT.link_down;
    if (state.invitesOffered?.linkBase === null) return REFUSAL_TEXT.no_public_url;
    if (!state.roster.some((attachment) => attachment.kind === 'member')) {
      return 'Invites need a member attached to sponsor them. Pair one first.';
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
    // A Can control invite always has exactly one use.
    dom.flag(usesField, 'hidden', chosenRole(state) === 'driver');
    const blocker = inviteBlocker(state);
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
    dom.attr(inviteToggle, 'data-action', open ? 'invite-close' : 'invite-open');
  }

  function setFormOpen(open: boolean): void {
    dom.flag(formBox, 'hidden', !open);
    if (open) dom.flag(inviteError, 'hidden', true);
    render(dock.state);
  }

  async function createInvite(): Promise<void> {
    const state = dock.state;
    const label = dom.value(labelInput).trim();
    const role = chosenRole(state);
    const uses = role === 'driver' ? 1 : chosenUses();
    if (label === '' || uses === null) {
      showInviteError(REFUSAL_TEXT.invalid);
      return;
    }
    creating = true;
    dom.flag(inviteError, 'hidden', true);
    render(state);
    const result = await dock.invite({ label, role, lifetime: chosenLifetime(), uses });
    creating = false;
    if (!mounted) return;
    if (result.ok) {
      dom.setValue(labelInput, '');
      dom.setValue(usesInput, '1');
      dom.flag(formBox, 'hidden', true);
      showLink(result.inviteId, result.link, label);
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

  function copyShownLink(): void {
    const fallback = (): void => {
      dom.setText(copyLink, 'Select the link to copy it');
    };
    if (shownLink === null || writeClipboard === null) {
      fallback();
      return;
    }
    // Only through the writeText taken at mount; see clipboardWriter.
    writeClipboard(shownLink.link).then(() => {
      dom.setText(copyLink, 'Copied');
    }, fallback);
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
    dom.attr(pauseView.toggle, 'data-action', paused ? 'resume' : 'pause');
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
    const took = entry.durationMs === null ? '' : ` in ${entry.durationMs} ms`;
    // A write answered early still holds the page while its handler runs on.
    const lingering = entry.handlerRunning ? ', but its handler is still running' : '';
    dom.append(what, `, ${entry.outcome}${took}${lingering}`);
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

  function tick(): void {
    for (const view of [...requestViews.values(), ...confirmViews.values()]) {
      dom.setText(view.countdown, `Denied automatically in ${secondsLeft(view.expiresAt)} s`);
    }
    for (const view of rowViews.values()) dom.setText(view.expiry, expiryText(view.expiresAt));
    for (const row of inviteRows.values()) setText(row.detail, inviteDetail(row.view));
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
    dom.setText(count, String(state.roster.length));
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
    const joined = noticeJoins(state);
    updateForm(state);
    renderActivity(state.activity);
    updatePause(state.paused);

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
    // so does a join notice, as nobody was asked about that join.
    if (newRequest || newConfirm || joined) setOpen(true);
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

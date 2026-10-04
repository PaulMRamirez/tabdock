// The operator's widget (SPEC.md section 8), kept thin: a badge and a panel in
// a closed shadow root. Scripts that run after attach(), and other frames,
// cannot reach into it for the pairing code or an invite link, or reach the
// buttons inside it. A page script that runs before attach() could (by
// patching attachShadow, say), which is acceptable because the page itself is
// trusted (SPEC.md section 1). As defence in depth, buttons ignore events
// whose isTrusted is false, so a script that does reach one still cannot press
// Allow. Everything shown comes from the Dock handle, every relay- or
// page-supplied string goes in through textContent (the pairing URL only as a
// QR drawing built with DOM calls; see qr.ts), nothing goes through an HTML
// parser, and nothing lands on window.
// From M4 the panel also mints invites (ADR 0017): an invite link shows once,
// as a QR drawing and as text to send, and only until the operator is done
// with it or the invite ends; the adapter keeps no copy of its secret. Against
// scripts that run later, the boundary is what the adapter has taken once by
// the time attach() returns: WebCrypto's two functions, TextEncoder's encode
// and the Uint8Array constructor (core.ts), the WebSocket constructor
// (index.ts) and the clipboard's writeText (here), so replacing any of them
// afterwards neither predicts a secret nor catches one on its way to the
// relay's hash or the clipboard. The built-ins the panel draws with stay the
// page's: a later script that patches a DOM text setter, or a string method
// the QR encoder calls, can still read what the panel shows, as a script that
// ran first could, and the trusted page answers for both.
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
import { createQrView, inviteQrUrl, QR_SIDE_PX } from './qr.ts';

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
.activity li { padding: 1px 0; }
.activity [data-outcome='running'] { color: #92400e; }
.pause { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 10px 0 0;
  padding: 6px 8px; border: 1px solid #e5e7eb; border-radius: 8px; }
.pause.paused { border-color: #b91c1c; }
@media (prefers-color-scheme: dark) {
  :host { color: #e5e7eb; }
  .badge, .panel { background: #111827; border-color: #374151; }
  .count { background: #374151; }
  .prompt { background: #3b2a06; }
  .row, .activity, .pause { border-color: #374151; }
  .action, .field input { background: #1f2937; border-color: #4b5563; }
  .invited { background: #1e3a8a; color: #dbeafe; }
  .muted, .label { color: #9ca3af; }
  .error { color: #fca5a5; }
  .join { color: #93c5fd; }
  .notice, .activity [data-outcome='running'] { color: #fcd34d; }
}
`;

interface BoxRect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/** A box whose buttons take a click only once it has held still; see ARM_DELAY_MS. */
interface ArmedBox {
  readonly element: HTMLElement;
  /** Where the box was when it appeared or last moved; null until first measured. */
  rect: BoxRect | null;
  armed: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
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

function measure(box: HTMLElement): BoxRect {
  const { top, left, width, height } = box.getBoundingClientRect();
  return { top, left, width, height };
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

function clientText(client: { name: string; version: string }): string {
  return `${client.name} ${client.version}`.trim();
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
 * since a name alone could copy someone else's (S10).
 */
function personText(user: { userId: string; displayName: string }, account?: Account): string {
  const id = shortId(user.userId);
  if (id === null) return user.displayName;
  const name = account?.verified === false ? UNVERIFIED_ACCOUNT_NAME : user.displayName;
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

/** Mounts the widget for one Dock and returns a function that removes it. */
export function mountWidget(dock: Dock, doc: Document = document): () => void {
  const host = doc.createElement(HOST_TAG);
  const root = host.attachShadow({ mode: 'closed' });
  const writeClipboard = clipboardWriter(doc);

  function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = '',
    text = '',
  ): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
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
    node.type = 'button';
    node.dataset.action = action;
    node.addEventListener('click', (event) => {
      // Page script can dispatch a click, but never a trusted one.
      if (!event.isTrusted) return;
      onClick();
    });
    return node;
  }

  /** The "invited" badge; empty, and so not shown, for anyone else. */
  function badge(show: boolean): HTMLElement {
    const node = element('span', 'invited', show ? 'invited' : '');
    node.dataset.role = 'invited';
    return node;
  }

  function setArmed(box: ArmedBox, value: boolean): void {
    box.armed = value;
    for (const node of box.element.querySelectorAll('button')) {
      node.dataset.armed = String(value);
      node.setAttribute('aria-disabled', String(!value));
    }
  }

  /** Records where the box is now and disarms it until it has stayed there for ARM_DELAY_MS. */
  function restartArming(box: ArmedBox): void {
    clearTimeout(box.timer);
    box.rect = measure(box.element);
    setArmed(box, false);
    box.timer = setTimeout(() => {
      // A move nobody noticed in between starts the wait again.
      if (sameRect(box.rect, measure(box.element))) setArmed(box, true);
      else restartArming(box);
    }, ARM_DELAY_MS);
  }

  /** Restarts the wait of every box that is new or no longer where it was. */
  function checkMoves(): void {
    for (const box of boxes) {
      if (!sameRect(box.rect, measure(box.element))) restartArming(box);
    }
  }

  function newBox(element: HTMLElement): ArmedBox {
    return { element, rect: null, armed: false, timer: undefined };
  }

  function dropBox(box: ArmedBox): void {
    clearTimeout(box.timer);
    box.element.remove();
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
        if (!box.armed || !sameRect(box.rect, measure(box.element))) {
          restartArming(box);
          return;
        }
        onClick();
      },
      primary,
    );
    node.dataset.armed = String(box.armed);
    node.setAttribute('aria-disabled', String(!box.armed));
    return node;
  }

  function newPrompt(box: HTMLElement, expiresAt: number): PromptView {
    return { ...newBox(box), countdown: element('p', 'muted'), expiresAt };
  }

  const style = adoptStyle(root, doc);

  const panel = element('section', 'panel');
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Tabdock');
  const errorLine = element('p', 'error');
  const noticeLine = element('p', 'notice');
  // Who just joined by a Can watch invite, with no prompt to say so (ADR 0016).
  const joins = element('div');
  joins.dataset.role = 'joins';
  joins.setAttribute('aria-live', 'polite');
  const prompts = element('div');
  prompts.setAttribute('aria-live', 'polite');

  const pairing = element('div');
  const code = element('div', 'code');
  code.dataset.role = 'pairing-code';
  const expiry = element('p', 'muted');
  const rotate = button('New code', 'rotate', () => {
    dock.rotatePairing();
  });
  // Shown only when the relay sent a pairing URL the QR module accepts.
  const qr = createQrView(doc);
  const qrBox = element('div', 'qr');
  qrBox.dataset.role = 'pairing-qr';
  qrBox.hidden = true;
  qrBox.append(qr.element);
  const pairText = element('div', 'pair-text');
  pairText.append(code, expiry, rotate);
  const pairRow = element('div', 'pair');
  pairRow.append(qrBox, pairText);
  pairing.append(element('div', 'label', 'Pairing code'), pairRow);

  const roster = element('ul');
  roster.dataset.role = 'roster';
  const nobody = element('p', 'muted', 'Nobody yet');
  // Revoking only takes access away, so it is not held back like the boxes.
  const revokeAll = button('Revoke all', 'revoke-all', () => {
    dock.revoke('*');
  });
  const rosterBlock = element('div');
  rosterBlock.append(element('div', 'label', 'Attached'), roster, nobody, revokeAll);

  // Invites (ADR 0017): the link shown once, the live list, and the form.
  const invitesBlock = element('div');
  invitesBlock.dataset.role = 'invites';
  invitesBlock.hidden = true;

  const linkBox = element('div', 'prompt');
  linkBox.dataset.role = 'invite-link';
  linkBox.hidden = true;
  const linkHeading = element('p');
  const linkQr = createQrView(doc, {
    accept: inviteQrUrl,
    label: 'Invite QR code: scan it with a phone to join',
  });
  const linkQrBox = element('div', 'qr');
  linkQrBox.dataset.role = 'invite-qr';
  linkQrBox.append(linkQr.element);
  const linkText = element('p', 'link-text');
  linkText.dataset.role = 'invite-link-text';
  const copyLink = button('Copy link', 'invite-copy', () => {
    copyShownLink();
  });
  const doneLink = button('Done', 'invite-done', () => {
    hideLink();
  });
  const linkButtons = element('div', 'buttons');
  linkButtons.append(copyLink, doneLink);
  linkBox.append(linkHeading, linkQrBox, linkText, linkButtons);
  /** The link on show and its invite, or null; Copy reads it here, never back from the tree. */
  let shownLink: { readonly inviteId: string; readonly link: string } | null = null;

  const inviteList = element('ul');
  inviteList.dataset.role = 'invite-list';
  const noInvites = element('p', 'muted', 'No live invites');
  const inviteError = element('p', 'error');
  inviteError.dataset.role = 'invite-error';
  inviteError.hidden = true;
  const inviteToggle = button('Invite someone', 'invite-open', () => {
    // hidden can also be 'until-found', which still means closed.
    setFormOpen(formBox.hidden !== false);
  });

  // The form is an armed box: Create grants access, as Allow does.
  const formBox = element('div', 'row');
  formBox.dataset.role = 'invite-form';
  formBox.hidden = true;
  const formView = newBox(formBox);
  boxes.add(formView);
  const labelField = element('label', 'field', 'Label, shown wherever the invite is');
  const labelInput = element('input');
  labelInput.type = 'text';
  labelInput.maxLength = MAX_INVITE_LABEL_CHARS;
  labelInput.autocomplete = 'off';
  labelInput.spellcheck = false;
  labelInput.placeholder = 'Who is it for?';
  labelInput.dataset.action = 'invite-label';
  labelField.append(labelInput);

  function choice(
    group: string,
    value: string,
    text: string,
    action: string,
  ): { label: HTMLLabelElement; input: HTMLInputElement } {
    const label = element('label');
    const input = element('input');
    input.type = 'radio';
    input.name = group;
    input.value = value;
    input.dataset.action = action;
    label.append(input, text);
    return { label, input };
  }

  const roleChoices = element('div', 'choices');
  roleChoices.setAttribute('role', 'radiogroup');
  roleChoices.setAttribute('aria-label', 'What the invite allows');
  const watchChoice = choice(
    'invite-role',
    'observer',
    roleText('observer'),
    'invite-role-observer',
  );
  const controlChoice = choice('invite-role', 'driver', roleText('driver'), 'invite-role-driver');
  watchChoice.input.checked = true;
  roleChoices.append(watchChoice.label, controlChoice.label);

  const lifetimeChoices = element('div', 'choices');
  lifetimeChoices.setAttribute('role', 'radiogroup');
  lifetimeChoices.setAttribute('aria-label', 'How long the link works');
  const lifetimeInputs = LIFETIME_CHOICES.map(([value, text]) => {
    const made = choice('invite-lifetime', value, text, `invite-lifetime-${value}`);
    made.input.checked = value === '1h';
    lifetimeChoices.append(made.label);
    return [value, made.input] as const;
  });

  const usesField = element('label', 'field', 'Uses');
  const usesInput = element('input');
  usesInput.type = 'number';
  usesInput.min = '1';
  usesInput.max = String(MAX_INVITE_USES);
  usesInput.step = '1';
  usesInput.value = '1';
  usesInput.dataset.action = 'invite-uses';
  usesField.append(usesInput);

  const formReason = element('p', 'muted');
  formReason.dataset.role = 'invite-reason';
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
  formButtons.append(createButton);
  formBox.append(labelField, roleChoices, lifetimeChoices, usesField, formReason, formButtons);

  for (const input of [watchChoice.input, controlChoice.input]) {
    input.addEventListener('change', () => {
      // Create now grants something else, so the form waits again.
      restartArming(formView);
      render(dock.state);
    });
  }
  labelInput.addEventListener('input', () => {
    render(dock.state);
  });

  invitesBlock.append(
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
  activity.dataset.role = 'activity';
  activity.setAttribute('aria-label', 'Recent calls, newest first');
  const activityBlock = element('div');
  activityBlock.append(element('div', 'label', 'Activity'), activity);

  // Last in the panel, beside the badge, where other changes move it least.
  const pauseBox = element('div', 'pause');
  pauseBox.dataset.role = 'pause-box';
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
  pauseBox.append(pauseView.text, pauseView.toggle);
  boxes.add(pauseView);

  panel.append(
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
  pausedTag.dataset.role = 'badge-paused';
  const badgeButton = button('', 'toggle', () => {
    // hidden can also be 'until-found', which still means closed.
    setOpen(panel.hidden !== false);
  });
  badgeButton.className = 'badge';
  badgeButton.setAttribute('aria-expanded', 'false');
  badgeButton.append(dot, element('span', '', 'Tabdock'), count, pausedTag);

  const wrap = element('div', 'wrap');
  wrap.append(panel, badgeButton);
  if (style) root.append(style);
  root.append(wrap);

  function setOpen(open: boolean): void {
    // Time on screen so far counts for the join notices before the panel changes.
    ageJoinLines();
    panel.hidden = !open;
    badgeButton.setAttribute('aria-expanded', String(open));
    // Opening moves every box from nowhere onto the screen, so each waits from now.
    checkMoves();
    ageJoinLines();
    updateAttention();
  }

  function requestView(request: PendingRequest, state: DockState): PromptView {
    const box = element('div', 'prompt');
    box.dataset.requestId = request.requestId;
    const who = personText(request.user, request.account);
    const line = element('p');
    if (request.invite !== null) {
      // The account beside the label the operator gave the invite, which is this page's own text.
      line.append(`${who} wants to join by your invite "${request.invite.label}"`);
    } else {
      const via = request.via === 'qr' ? 'QR code' : 'code';
      line.append(`${who} wants to attach via ${via}`);
    }
    line.append(badge(request.invite !== null || request.account.kind === 'invitee'));
    box.append(line);
    if (!request.account.verified) {
      box.append(
        element('p', 'muted', 'Unverified account: the sign-in provider vouches for no email.'),
      );
    }
    const drivers = state.roster.filter((attachment) => attachment.role === 'driver').length;
    if (request.invite !== null && drivers >= state.policy.maxDrivers) {
      // ADR 0017: the relay seats them as observer; Make driver works once a seat is free.
      box.append(
        element('p', 'muted', 'The driver seats are full, so they join as observer for now.'),
      );
    }
    if (request.client) {
      box.append(element('p', 'muted', `Client: ${clientText(request.client)}`));
    }
    const view = newPrompt(box, request.expiresAt);
    const buttons = element('div', 'buttons');
    buttons.append(
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
    box.append(buttons, view.countdown);
    return view;
  }

  function confirmView(confirm: PendingConfirm): PromptView {
    const box = element('div', 'prompt');
    box.dataset.callId = confirm.callId;
    const line = element('p');
    line.append(`${personText(confirm.caller)} wants to run ${confirm.tool}`);
    line.append(badge(shortId(confirm.caller.userId) !== null));
    box.append(line);
    const view = newPrompt(box, confirm.expiresAt);
    const buttons = element('div', 'buttons');
    buttons.append(
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
    box.append(buttons, view.countdown);
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
      prompts.prepend(view.element);
      added = true;
    }
    return added;
  }

  function rowView(userId: string): RowView {
    const box = element('li', 'row');
    box.dataset.userId = userId;
    const closeLink = element('label', 'check');
    const closeInput = element('input');
    closeInput.type = 'checkbox';
    closeInput.dataset.action = 'close-link';
    closeLink.append(closeInput, 'and close this link');
    closeLink.hidden = true;
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
    buttons.append(
      view.roleSwitch,
      boxButton(view, 'Revoke', 'revoke', () => {
        // The box's own choice when it shows, which starts checked; the
        // adapter's default otherwise, which closes a multi-use link (ADR 0016).
        if (view.closeLink.hidden) dock.revoke(userId);
        else dock.revoke(userId, { closeInvite: view.closeInput.checked });
      }),
      view.closeLink,
    );
    const who = element('p', 'who');
    who.append(view.name, view.badge);
    box.append(who, view.clients, view.expiry, buttons);
    return view;
  }

  function setText(node: HTMLElement, text: string): void {
    if (node.textContent !== text) node.textContent = text;
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
    const clients = attachment.clients.map(clientText).join(', ');
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
    view.roleSwitch.hidden = role === null || capped;
    const promote = role !== 'driver';
    view.roleSwitch.textContent = promote ? 'Make driver' : 'Make observer';
    view.roleSwitch.dataset.action = promote ? 'make-driver' : 'make-observer';
    // "and close this link" starts checked whenever it appears.
    if (closable && view.closeLink.hidden) view.closeInput.checked = true;
    view.closeLink.hidden = !closable;
    // The role switch may now do the opposite of what the operator was reaching for, or be gone.
    if (!isNew) restartArming(view);
  }

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
      view.roleSwitch.disabled = state.link !== 'linked';
      return view.element;
    });
    const current = [...roster.children];
    if (current.length !== ordered.length || current.some((node, i) => node !== ordered[i])) {
      roster.replaceChildren(...ordered);
    }
    nobody.hidden = state.roster.length > 0;
    // Revoke all also closes every live invite, so it stays while any is live.
    revokeAll.hidden = state.roster.length === 0 && state.invites.length === 0;
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
      line.dataset.joined = join.user.userId;
      joins.prepend(line);
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
    const onScreen = !panel.hidden && doc.visibilityState === 'visible';
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
        line.element.remove();
        joinLines.splice(i, 1);
      }
    }
  }

  /** The badge asks for attention while a prompt waits or a join notice has not been seen. */
  function updateAttention(): void {
    const waiting = requestViews.size + confirmViews.size > 0;
    badgeButton.classList.toggle('attention', waiting || joinLines.some((line) => !line.seen));
  }

  function inviteRow(view: InviteView): InviteRowView {
    const box = element('li', 'row');
    box.dataset.inviteId = view.inviteId;
    const title = element('p', 'who');
    const detail = element('p', 'muted');
    const buttons = element('div', 'buttons');
    // Cancelling only takes access away, so it is not held back like the boxes.
    buttons.append(
      button('Cancel', 'cancel-invite', () => {
        dock.cancelInvite(view.inviteId);
      }),
    );
    box.append(title, detail, buttons);
    return { element: box, title, detail, view };
  }

  function syncInvites(state: DockState): void {
    const live = new Set(state.invites.map((view) => view.inviteId));
    for (const [inviteId, row] of inviteRows) {
      if (!live.has(inviteId)) {
        row.element.remove();
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
    const current = [...inviteList.children];
    if (current.length !== ordered.length || current.some((node, i) => node !== ordered[i])) {
      inviteList.replaceChildren(...ordered);
    }
    // Between links the page lists nothing, which says nothing about what is live.
    noInvites.hidden = state.invites.length > 0 || state.link !== 'linked';
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
    return state.policy.invites === 'all' && controlChoice.input.checked ? 'driver' : 'observer';
  }

  function chosenLifetime(): InviteLifetime {
    for (const [value, input] of lifetimeInputs) if (input.checked) return value;
    return '1h';
  }

  function chosenUses(): number | null {
    const uses = Number(usesInput.value);
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
    invitesBlock.hidden = !offered;
    // Can control only where the page opted into it (ADR 0016).
    controlChoice.label.hidden = state.policy.invites !== 'all';
    if (controlChoice.label.hidden && controlChoice.input.checked) watchChoice.input.checked = true;
    // A Can control invite always has exactly one use.
    usesField.hidden = chosenRole(state) === 'driver';
    const blocker = inviteBlocker(state);
    const reason = creating ? 'Asking the relay for the link' : blocker;
    setText(formReason, reason ?? '');
    formReason.hidden = reason === null;
    createButton.disabled = creating || blocker !== null || labelInput.value.trim() === '';
    const open = !formBox.hidden;
    inviteToggle.textContent = open ? 'Close the form' : 'Invite someone';
    inviteToggle.dataset.action = open ? 'invite-close' : 'invite-open';
  }

  function setFormOpen(open: boolean): void {
    formBox.hidden = !open;
    if (open) inviteError.hidden = true;
    render(dock.state);
  }

  async function createInvite(): Promise<void> {
    const state = dock.state;
    const label = labelInput.value.trim();
    const role = chosenRole(state);
    const uses = role === 'driver' ? 1 : chosenUses();
    if (label === '' || uses === null) {
      showInviteError(REFUSAL_TEXT.invalid);
      return;
    }
    creating = true;
    inviteError.hidden = true;
    render(state);
    const result = await dock.invite({ label, role, lifetime: chosenLifetime(), uses });
    creating = false;
    if (!mounted) return;
    if (result.ok) {
      labelInput.value = '';
      usesInput.value = '1';
      formBox.hidden = true;
      showLink(result.inviteId, result.link, label);
    } else {
      showInviteError(REFUSAL_TEXT[result.reason]);
    }
    render(dock.state);
  }

  function showInviteError(text: string): void {
    inviteError.textContent = text;
    inviteError.hidden = false;
  }

  /** The link, once: as a QR drawing and as text to send, until Done or until its invite ends. */
  function showLink(inviteId: string, link: string, label: string): void {
    shownLink = { inviteId, link };
    linkHeading.textContent = `Send this link to ${label}. It shows only now, and anyone who holds it can join as the invite says.`;
    linkText.textContent = link;
    linkQrBox.hidden = !linkQr.show(link);
    copyLink.textContent = 'Copy link';
    linkBox.hidden = false;
    setOpen(true);
  }

  function hideLink(): void {
    shownLink = null;
    // Nothing of the link stays in the tree.
    linkText.textContent = '';
    linkHeading.textContent = '';
    linkQr.show(undefined);
    linkBox.hidden = true;
  }

  function copyShownLink(): void {
    const fallback = (): void => {
      copyLink.textContent = 'Select the link to copy it';
    };
    if (shownLink === null || writeClipboard === null) {
      fallback();
      return;
    }
    // Only through the writeText taken at mount; see clipboardWriter.
    writeClipboard(shownLink.link).then(() => {
      copyLink.textContent = 'Copied';
    }, fallback);
  }

  function updatePause(paused: boolean): void {
    pausedTag.hidden = !paused;
    badgeButton.dataset.paused = String(paused);
    if (pauseView.paused === paused) return;
    const isNew = pauseView.paused === null;
    pauseView.paused = paused;
    pauseBox.classList.toggle('paused', paused);
    pauseView.text.textContent = paused
      ? 'Paused: every call is refused'
      : 'Calls run as they come';
    pauseView.toggle.textContent = paused ? 'Resume' : 'Pause';
    pauseView.toggle.dataset.action = paused ? 'resume' : 'pause';
    // Resume grants access again, so a switch that just flipped waits like a new box.
    if (!isNew) restartArming(pauseView);
  }

  function entryLine(entry: ActivityEntry): HTMLElement {
    const line = element('li');
    line.dataset.activityId = entry.callId;
    line.dataset.outcome = entry.outcome;
    const via = entry.client ? ` via ${clientText(entry.client)}` : '';
    const took = entry.durationMs === null ? '' : ` in ${entry.durationMs} ms`;
    // A write answered early still holds the page while its handler runs on.
    const lingering = entry.handlerRunning ? ', but its handler is still running' : '';
    line.append(`${timeText(entry.time)} ${personText(entry.user)}`);
    if (shortId(entry.user.userId) !== null) line.append(badge(true));
    line.append(`${via}: ${entry.tool}, ${entry.outcome}${took}${lingering}`);
    return line;
  }

  let shownActivity: readonly ActivityEntry[] | null = null;

  function renderActivity(entries: readonly ActivityEntry[]): void {
    if (entries === shownActivity) return;
    shownActivity = entries;
    activity.replaceChildren(...entries.map(entryLine));
    if (entries.length === 0) activity.append(element('li', 'muted', 'No calls yet'));
  }

  /** Whether the panel has opened by itself to show the code since anyone was last attached; see render. */
  let codeShown = false;

  function tick(): void {
    for (const view of [...requestViews.values(), ...confirmViews.values()]) {
      view.countdown.textContent = `Denied automatically in ${secondsLeft(view.expiresAt)} s`;
    }
    for (const view of rowViews.values()) view.expiry.textContent = expiryText(view.expiresAt);
    for (const row of inviteRows.values()) setText(row.detail, inviteDetail(row.view));
    ageJoinLines();
    updateAttention();
    const current = dock.state.pairing;
    if (current) {
      const left = secondsLeft(current.expiresAt);
      expiry.textContent =
        left > 0 ? `Expires in ${clockText(left)}` : 'Expired, waiting for a new code';
    }
    // Catches shifts no state change caused, such as a resized window or a scrolled panel.
    checkMoves();
  }

  function render(state: DockState): void {
    if (state.link === 'closed' && state.error === null) {
      unmount();
      return;
    }
    dot.className = `dot ${state.link}`;
    badgeButton.title = `Tabdock: ${LINK_LABELS[state.link]}${state.paused ? ', paused' : ''}`;
    count.textContent = String(state.roster.length);
    errorLine.textContent = state.error ?? '';
    errorLine.hidden = state.error === null;
    noticeLine.textContent = state.notice ?? '';
    noticeLine.hidden = state.notice === null;

    pairing.hidden = state.pairing === null;
    code.textContent = state.pairing?.code ?? '';
    // A new pairing carries a new URL, so it redraws; one without a URL clears the code.
    qrBox.hidden = !qr.show(state.pairing?.url);
    rotate.disabled = state.link !== 'linked';

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
  const interval = setInterval(tick, 1000);
  doc.addEventListener('visibilitychange', onVisibility);
  win?.addEventListener('focus', rearmAll);

  function unmount(): void {
    if (!mounted) return;
    mounted = false;
    unsubscribe();
    clearInterval(interval);
    doc.removeEventListener('visibilitychange', onVisibility);
    win?.removeEventListener('focus', rearmAll);
    for (const box of boxes) clearTimeout(box.timer);
    hideLink();
    host.remove();
  }

  const place = (): void => {
    // body is typed as always present, but a document can lack one.
    if (mounted) ((doc.body as HTMLElement | null) ?? doc.documentElement).append(host);
  };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', place, { once: true });
  else place();
  render(dock.state);
  return unmount;
}

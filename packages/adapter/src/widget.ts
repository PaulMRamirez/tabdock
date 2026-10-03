// The operator's widget (SPEC.md section 8), kept thin: a badge and a panel in
// a closed shadow root. Scripts that run after attach(), and other frames,
// cannot read the pairing code or reach the buttons inside it. A page script
// that runs before attach() could (by patching attachShadow, say), which is
// acceptable because the page itself is trusted (SPEC.md section 1). As
// defence in depth, buttons ignore events whose isTrusted is false, so a
// script that does reach one still cannot press Allow. Everything shown comes
// from the Dock handle, every relay- or page-supplied string goes in through
// textContent (the pairing URL only as a QR drawing built with DOM calls; see
// qr.ts), nothing goes through an HTML parser, and nothing lands on window.
// Buttons carry stable data-action attributes for browser tests.

import type { AttachmentView, Role } from '@tabdock/protocol';
import type {
  ActivityEntry,
  Dock,
  DockState,
  LinkState,
  PageRole,
  PendingConfirm,
  PendingRequest,
} from './core.ts';
import { createQrView } from './qr.ts';

/** A valid custom element name needs no registration to host a shadow root, so nothing is defined globally. */
const HOST_TAG = 'tabdock-dock';

/**
 * A box's buttons ignore clicks until the box has held still this long since
 * it appeared or last moved, so a click aimed at one button never lands on
 * another that just slid under the pointer. Prompts are boxes, and so are
 * roster rows and the pause control, since Make driver and Resume grant
 * access as surely as Allow does. Each box is measured rather than guessed
 * at: the relay controls text that can shift it (a roster name that wraps, a
 * longer pairing code, an error), and the panel can scroll. Boxes are timed
 * one by one, so prompts arriving on top, which move nothing below them,
 * never keep an older prompt disarmed. A box whose buttons change meaning
 * (a role switch that flips, Pause turning into Resume) waits again too. A
 * tab coming back into view, or its window into focus, restarts every box's
 * wait, since the operator is seeing the boxes afresh. data-armed shows the
 * state, for people and for browser tests.
 */
const ARM_DELAY_MS = 500;

const LINK_LABELS: Record<LinkState, string> = {
  idle: 'Idle',
  connecting: 'Connecting',
  linked: 'Linked',
  reconnecting: 'Reconnecting',
  closed: 'Closed',
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
/* Light ground in every theme, quiet zone included, as scanners need dark on light. */
.qr { flex: none; width: 124px; height: 124px; background: #fff; }
.qr svg { display: block; width: 100%; height: 100%; }
.muted { margin: 2px 0; color: #6b7280; }
.error { margin: 0 0 8px; color: #b91c1c; }
.notice { margin: 0 0 8px; color: #92400e; }
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
  .action { background: #1f2937; border-color: #4b5563; }
  .muted, .label { color: #9ca3af; }
  .error { color: #fca5a5; }
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
  readonly who: HTMLElement;
  readonly clients: HTMLElement;
  readonly expiry: HTMLElement;
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

/** Mounts the widget for one Dock and returns a function that removes it. */
export function mountWidget(dock: Dock, doc: Document = document): () => void {
  const host = doc.createElement(HOST_TAG);
  const root = host.attachShadow({ mode: 'closed' });

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

  /** Every armed box on show: prompts, roster rows and the pause control. */
  const boxes = new Set<ArmedBox>();
  const requestViews = new Map<string, PromptView>();
  const confirmViews = new Map<string, PromptView>();
  const rowViews = new Map<string, RowView>();

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

  const style = element('style');
  style.textContent = STYLE;

  const panel = element('section', 'panel');
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Tabdock');
  const errorLine = element('p', 'error');
  const noticeLine = element('p', 'notice');
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

  panel.append(errorLine, noticeLine, prompts, pairing, rosterBlock, activityBlock, pauseBox);

  const dot = element('span', 'dot');
  const count = element('span', 'count', '0');
  const pausedTag = element('span', 'tag', 'Paused');
  pausedTag.dataset.role = 'badge-paused';
  const badge = button('', 'toggle', () => {
    // hidden can also be 'until-found', which still means closed.
    setOpen(panel.hidden !== false);
  });
  badge.className = 'badge';
  badge.setAttribute('aria-expanded', 'false');
  badge.append(dot, element('span', '', 'Tabdock'), count, pausedTag);

  const wrap = element('div', 'wrap');
  wrap.append(panel, badge);
  root.append(style, wrap);

  function setOpen(open: boolean): void {
    panel.hidden = !open;
    badge.setAttribute('aria-expanded', String(open));
    // Opening moves every box from nowhere onto the screen, so each waits from now.
    checkMoves();
  }

  function requestView(request: PendingRequest): PromptView {
    const box = element('div', 'prompt');
    box.dataset.requestId = request.requestId;
    const via = request.via === 'qr' ? 'QR code' : 'code';
    box.append(element('p', '', `${request.user.displayName} wants to attach via ${via}`));
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
    box.append(element('p', '', `${confirm.caller.displayName} wants to run ${confirm.tool}`));
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
    const view: RowView = {
      ...newBox(box),
      who: element('p', 'who'),
      clients: element('p', 'muted clients'),
      expiry: element('p', 'muted'),
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
        dock.revoke(userId);
      }),
    );
    box.append(view.who, view.clients, view.expiry, buttons);
    return view;
  }

  function setText(node: HTMLElement, text: string): void {
    if (node.textContent !== text) node.textContent = text;
  }

  /**
   * The row shows the role the page enforces, not the relay's claim alone; a
   * user the page runs nothing for gets Revoke only, since even Make
   * observer would grant them something.
   */
  function updateRow(view: RowView, attachment: AttachmentView, access?: PageRole): void {
    view.expiresAt = attachment.expiresAt;
    const role = access?.role ?? null;
    const revoking = access?.revoked === true;
    const status = role ?? (revoking ? 'revoke pending' : 'not approved on this page');
    setText(view.who, `${attachment.displayName} (${status})`);
    const clients = attachment.clients.map(clientText).join(', ');
    setText(view.clients, clients === '' ? 'No client seen yet' : `Clients: ${clients}`);
    // Clients name themselves, on every call if they like, so their names
    // never make the row wait again; the line keeps its height, and real
    // movement is checkMoves' job.
    const key = JSON.stringify([attachment.displayName, role, revoking]);
    if (key === view.key) return;
    const isNew = view.key === '';
    view.key = key;
    view.role = role;
    view.roleSwitch.hidden = role === null;
    const promote = role !== 'driver';
    view.roleSwitch.textContent = promote ? 'Make driver' : 'Make observer';
    view.roleSwitch.dataset.action = promote ? 'make-driver' : 'make-observer';
    // The role switch may now do the opposite of what the operator was reaching for, or be gone.
    if (!isNew) restartArming(view);
  }

  /** Rows are kept by user id and only reordered when the relay's order changes, like prompts. */
  function syncRows(
    attachments: readonly AttachmentView[],
    pageRoles: readonly PageRole[],
    linked: boolean,
  ): void {
    const access = new Map(pageRoles.map((entry) => [entry.userId, entry]));
    const live = new Set(attachments.map((attachment) => attachment.userId));
    for (const [userId, view] of rowViews) {
      if (!live.has(userId)) {
        dropBox(view);
        rowViews.delete(userId);
      }
    }
    const ordered = attachments.map((attachment) => {
      let view = rowViews.get(attachment.userId);
      if (!view) {
        view = rowView(attachment.userId);
        rowViews.set(attachment.userId, view);
        boxes.add(view);
      }
      updateRow(view, attachment, access.get(attachment.userId));
      // Role changes need the relay; revoking works offline and is sent on resume.
      view.roleSwitch.disabled = !linked;
      return view.element;
    });
    const current = [...roster.children];
    if (current.length !== ordered.length || current.some((node, i) => node !== ordered[i])) {
      roster.replaceChildren(...ordered);
    }
    nobody.hidden = attachments.length > 0;
    revokeAll.hidden = attachments.length === 0;
  }

  function updatePause(paused: boolean): void {
    pausedTag.hidden = !paused;
    badge.dataset.paused = String(paused);
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
    line.textContent = `${timeText(entry.time)} ${entry.user.displayName}${via}: ${entry.tool}, ${entry.outcome}${took}${lingering}`;
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
    badge.title = `Tabdock: ${LINK_LABELS[state.link]}${state.paused ? ', paused' : ''}`;
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

    syncRows(state.roster, state.pageRoles, state.link === 'linked');
    renderActivity(state.activity);
    updatePause(state.paused);

    const newRequest = syncPrompts(
      requestViews,
      state.pendingRequests,
      (r) => r.requestId,
      requestView,
    );
    const newConfirm = syncPrompts(
      confirmViews,
      state.pendingConfirms,
      (c) => c.callId,
      confirmView,
    );
    const waiting = requestViews.size + confirmViews.size > 0;
    badge.classList.toggle('attention', waiting);
    // A new prompt opens the panel: the operator has a deadline to meet.
    if (newRequest || newConfirm) setOpen(true);
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
    if (doc.visibilityState === 'visible') rearmAll();
  };
  const win = doc.defaultView;

  const unsubscribe = dock.on('state', render);
  const interval = setInterval(tick, 1000);
  doc.addEventListener('visibilitychange', onVisibility);
  win?.addEventListener('focus', rearmAll);
  let mounted = true;

  function unmount(): void {
    if (!mounted) return;
    mounted = false;
    unsubscribe();
    clearInterval(interval);
    doc.removeEventListener('visibilitychange', onVisibility);
    win?.removeEventListener('focus', rearmAll);
    for (const box of boxes) clearTimeout(box.timer);
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

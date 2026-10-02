// The operator's widget (SPEC.md section 8), kept thin: a badge and a panel in
// a closed shadow root. Scripts that run after attach(), and other frames,
// cannot read the pairing code or reach the buttons inside it. A page script
// that runs before attach() could (by patching attachShadow, say), which is
// acceptable because the page itself is trusted (SPEC.md section 1). As
// defence in depth, buttons ignore events whose isTrusted is false, so a
// script that does reach one still cannot press Allow. Everything shown comes
// from the Dock handle, every relay- or page-supplied string goes in through
// textContent, and nothing lands on window. Buttons carry stable data-action
// attributes for browser tests.

import type { Dock, DockState, LinkState, PendingConfirm, PendingRequest } from './core.ts';

/** A valid custom element name needs no registration to host a shadow root, so nothing is defined globally. */
const HOST_TAG = 'tabdock-dock';

/**
 * A prompt box's buttons ignore clicks until the box has held still this long
 * since it appeared or last moved, so a click aimed at one button never lands
 * on another that just slid under the pointer. Each box is measured rather
 * than guessed at: the relay controls text that can shift it (a roster name
 * that wraps, a longer pairing code, an error), and the panel can scroll.
 * Boxes are timed one by one, so prompts arriving on top, which move nothing
 * below them, never keep an older prompt disarmed. A tab coming back into
 * view, or its window into focus, restarts every box's wait, since the
 * operator is seeing the boxes afresh. data-armed shows the state, for people
 * and for browser tests.
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
.panel { width: 300px; max-width: calc(100vw - 32px); max-height: 70vh; overflow: auto; padding: 12px;
  border-radius: 12px; border: 1px solid #cbd5e1; background: #fff; box-shadow: 0 6px 24px rgb(0 0 0 / 0.2); }
.label { margin: 10px 0 2px; font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; color: #6b7280; }
.code { font: 600 26px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: 0.08em;
  user-select: all; }
.muted { margin: 2px 0; color: #6b7280; }
.error { margin: 0 0 8px; color: #b91c1c; }
.notice { margin: 0 0 8px; color: #92400e; }
.prompt { margin: 0 0 8px; padding: 8px; border: 1px solid #d97706; border-radius: 8px; background: #fffbeb; }
.prompt p { margin: 0 0 4px; }
.buttons { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 4px; }
.action { padding: 4px 10px; border-radius: 6px; border: 1px solid #9ca3af; background: #f9fafb; color: inherit;
  font: inherit; cursor: pointer; }
.action.primary { border-color: #1d4ed8; background: #1d4ed8; color: #fff; }
.action:disabled { opacity: 0.5; cursor: default; }
.action[data-armed='false'] { opacity: 0.6; cursor: default; }
ul { margin: 2px 0 0; padding: 0; list-style: none; }
li { padding: 2px 0; }
@media (prefers-color-scheme: dark) {
  :host { color: #e5e7eb; }
  .badge, .panel { background: #111827; border-color: #374151; }
  .count { background: #374151; }
  .prompt { background: #3b2a06; }
  .action { background: #1f2937; border-color: #4b5563; }
  .muted, .label { color: #9ca3af; }
  .error { color: #fca5a5; }
  .notice { color: #fcd34d; }
}
`;

interface BoxRect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

interface PromptView {
  readonly element: HTMLElement;
  readonly countdown: HTMLElement;
  readonly expiresAt: number;
  /** Where the box was when it appeared or last moved; null until first measured. */
  rect: BoxRect | null;
  armed: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
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

  const requestViews = new Map<string, PromptView>();
  const confirmViews = new Map<string, PromptView>();

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

  function setArmed(view: PromptView, value: boolean): void {
    view.armed = value;
    for (const node of view.element.querySelectorAll('button')) {
      node.dataset.armed = String(value);
      node.setAttribute('aria-disabled', String(!value));
    }
  }

  /** Records where the box is now and disarms it until it has stayed there for ARM_DELAY_MS. */
  function restartArming(view: PromptView): void {
    clearTimeout(view.timer);
    view.rect = measure(view.element);
    setArmed(view, false);
    view.timer = setTimeout(() => {
      // A move nobody noticed in between starts the wait again.
      if (sameRect(view.rect, measure(view.element))) setArmed(view, true);
      else restartArming(view);
    }, ARM_DELAY_MS);
  }

  /** Restarts the wait of every box that is new or no longer where it was. */
  function checkMoves(): void {
    for (const view of [...requestViews.values(), ...confirmViews.values()]) {
      if (!sameRect(view.rect, measure(view.element))) restartArming(view);
    }
  }

  /** A button inside a prompt box, which only takes a click while its box is armed. */
  function promptButton(
    view: PromptView,
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
        if (!view.armed || !sameRect(view.rect, measure(view.element))) {
          restartArming(view);
          return;
        }
        onClick();
      },
      primary,
    );
    node.dataset.armed = String(view.armed);
    node.setAttribute('aria-disabled', String(!view.armed));
    return node;
  }

  function newView(box: HTMLElement, expiresAt: number): PromptView {
    return {
      element: box,
      countdown: element('p', 'muted'),
      expiresAt,
      rect: null,
      armed: false,
      timer: undefined,
    };
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
  pairing.append(element('div', 'label', 'Pairing code'), code, expiry, rotate);

  const roster = element('ul');
  const rosterBlock = element('div');
  rosterBlock.append(element('div', 'label', 'Attached'), roster);
  panel.append(errorLine, noticeLine, prompts, pairing, rosterBlock);

  const dot = element('span', 'dot');
  const count = element('span', 'count', '0');
  const badge = button('', 'toggle', () => {
    // hidden can also be 'until-found', which still means closed.
    setOpen(panel.hidden !== false);
  });
  badge.className = 'badge';
  badge.setAttribute('aria-expanded', 'false');
  badge.append(dot, element('span', '', 'Tabdock'), count);

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
      box.append(element('p', 'muted', `Client: ${request.client.name} ${request.client.version}`));
    }
    const view = newView(box, request.expiresAt);
    const buttons = element('div', 'buttons');
    buttons.append(
      promptButton(view, 'Allow as driver', 'approve-driver', () => {
        dock.approve(request.requestId, 'driver');
      }),
      promptButton(view, 'Allow as observer', 'approve-observer', () => {
        dock.approve(request.requestId, 'observer');
      }),
      promptButton(
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
    const view = newView(box, confirm.expiresAt);
    const buttons = element('div', 'buttons');
    buttons.append(
      promptButton(view, 'Allow', 'confirm-allow', () => {
        dock.confirm(confirm.callId, true);
      }),
      promptButton(
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
        clearTimeout(view.timer);
        view.element.remove();
        views.delete(id);
      }
    }
    for (const item of items) {
      const id = key(item);
      if (views.has(id)) continue;
      const view = build(item);
      views.set(id, view);
      prompts.prepend(view.element);
      added = true;
    }
    return added;
  }

  /** Whether the panel has opened by itself to show the code since anyone was last attached; see render. */
  let codeShown = false;

  function tick(): void {
    for (const view of requestViews.values()) {
      view.countdown.textContent = `Denied automatically in ${secondsLeft(view.expiresAt)} s`;
    }
    for (const view of confirmViews.values()) {
      view.countdown.textContent = `Denied automatically in ${secondsLeft(view.expiresAt)} s`;
    }
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
    badge.title = `Tabdock: ${LINK_LABELS[state.link]}`;
    count.textContent = String(state.roster.length);
    errorLine.textContent = state.error ?? '';
    errorLine.hidden = state.error === null;
    noticeLine.textContent = state.notice ?? '';
    noticeLine.hidden = state.notice === null;

    pairing.hidden = state.pairing === null;
    code.textContent = state.pairing?.code ?? '';
    rotate.disabled = state.link !== 'linked';

    roster.replaceChildren(
      ...state.roster.map((attachment) =>
        element('li', '', `${attachment.displayName} (${attachment.role})`),
      ),
    );
    if (state.roster.length === 0) roster.append(element('li', 'muted', 'Nobody yet'));

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
    for (const view of [...requestViews.values(), ...confirmViews.values()]) {
      restartArming(view);
    }
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
    for (const view of [...requestViews.values(), ...confirmViews.values()]) {
      clearTimeout(view.timer);
    }
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

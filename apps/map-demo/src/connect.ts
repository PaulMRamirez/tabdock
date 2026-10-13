// The map demo dials only a relay its visitor chose (ADR 0050, by the
// board's rules from ADR 0029). A crafted link can name any relay in ?relay,
// and that relay would then show names of its own making in attach prompts,
// so a linked relay waits behind a bar reading "Connect to <host>" until a
// person clicks it, and without ?relay the page offers a form instead. The
// relay URL is checked by the board's own rules (@tabdock/demo/relay) and the
// bar's button by the board's own arming (@tabdock/demo/arming), so the two
// pages share one copy of each. Unlike the board, the map reads no policy
// from its link, so a choice is keyed on the relay URL alone, under a prefix
// of its own: a relay chosen on the board never connects the map.

import { armWhenStill } from '@tabdock/demo/arming';
import { checkRelayUrl } from '@tabdock/demo/relay';

/**
 * The map demo's own sessionStorage keys, apart from the board's
 * (`tabdock-demo:connect:`) and the adapter's (`tabdock:`). A key holds only
 * a relay URL the visitor chose, which carries no credential, query or
 * fragment, so nothing secret is stored.
 */
export const CHOICE_KEY_PREFIX = 'tabdock-map-demo:connect:';

/** The bits of Storage the choice needs, so tests can stand one in. */
export type ChoiceStore = Pick<Storage, 'getItem' | 'setItem'>;

export function choiceKey(relayUrl: string): string {
  return `${CHOICE_KEY_PREFIX}${relayUrl}`;
}

/** Whether this tab's visitor already chose this exact relay URL on the map. */
export function wasChosen(store: ChoiceStore | null, relayUrl: string): boolean {
  if (store === null) return false;
  try {
    return store.getItem(choiceKey(relayUrl)) === '1';
  } catch {
    // Storage the browser refuses (a sandboxed frame, a full quota) remembers nothing.
    return false;
  }
}

export function rememberChoice(store: ChoiceStore | null, relayUrl: string): void {
  if (store === null) return;
  try {
    store.setItem(choiceKey(relayUrl), '1');
  } catch {
    // Without storage a reload asks again, which is the safe way to fail.
  }
}

/** How long a chosen relay may go without ever linking before the status line says what to check. */
export const LINK_HINT_MS = 10_000;

/**
 * The status line once the visitor has chosen a relay. A relay that refuses
 * this site's origin, the likeliest setup mistake, looks the same from the
 * page as an address with no relay at all: a socket that closes, then
 * reconnecting. So once the link has gone LINK_HINT_MS without ever linking,
 * the line names both causes. It names the relay's host and this page's
 * origin, which the page already shows, and nothing secret.
 */
export function linkStatus(
  registered: string,
  host: string,
  link: string,
  stalled: boolean,
  origin: string,
): string {
  const line = `${registered}; Tabdock relay ${host}: ${link}`;
  return stalled
    ? `${line}; still not linked: check that the relay is running and lists ${origin} in TABDOCK_ALLOWED_ORIGINS`
    : line;
}

/** This tab's sessionStorage, or null where reading it throws. */
export function tabStore(): ChoiceStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Where the Connect form goes: this page with ?relay set to the chosen URL,
 * every other parameter dropped, since the map reads none, and no hash.
 */
export function connectHref(pageHref: string, relayUrl: string): string {
  const next = new URL(pageHref);
  next.search = '';
  next.searchParams.set('relay', relayUrl);
  next.hash = '';
  return next.href;
}

/**
 * The bar for a relay named in ?relay. `onChosen` runs once, and only for a
 * click the browser marks trusted (a person's own click or key press, never
 * a script's click() or dispatched event) on a button that had armed before
 * the press began.
 */
export function mountConnectBar(
  slot: Element,
  relay: { url: string; host: string },
  store: ChoiceStore | null,
  onChosen: () => void,
): HTMLElement {
  const bar = document.createElement('section');
  bar.className = 'connect';
  bar.dataset.role = 'connect-bar';
  bar.setAttribute('aria-label', 'Connect to a Tabdock relay');
  const note = document.createElement('span');
  note.textContent = 'This link names a Tabdock relay. The map dials it only if you choose to.';
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.action = 'connect';
  const host = document.createElement('span');
  host.className = 'connect-host';
  host.dataset.role = 'connect-host';
  // textContent, never markup: the host comes from the address bar.
  host.textContent = relay.host;
  button.append('Connect to ', host);
  bar.append(note, button);
  slot.append(bar);

  const arming = armWhenStill(button);
  // Whether the press that ends in the next click began on an armed button;
  // null when no pointer press was seen, as for a key on the button.
  let pressReady: boolean | null = null;
  button.addEventListener('pointerdown', () => {
    pressReady = arming.ready();
  });
  button.addEventListener('pointercancel', () => {
    pressReady = null;
  });
  button.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    const pressed = pressReady;
    pressReady = null;
    if (pressed === false || !arming.ready()) {
      arming.restart();
      return;
    }
    arming.stop();
    rememberChoice(store, relay.url);
    bar.remove();
    onChosen();
  });
  return bar;
}

/**
 * The form shown without ?relay (or with one the page refused). It is
 * handled in script, so the static build's form-action 'none' holds: a
 * person's own click on Connect (a mouse click, a key on the button, or
 * Enter in the field, whose implicit submission clicks the button) records
 * the choice as the bar's click does and goes to ?relay=. The submit event
 * alone will not do, since a script's form.requestSubmit() fires a trusted one.
 */
export function mountConnectForm(
  slot: Element,
  pageProtocol: string,
  store: ChoiceStore | null,
  navigate: (href: string) => void,
): HTMLFormElement {
  const form = document.createElement('form');
  form.className = 'connect';
  form.dataset.role = 'connect-form';
  // The checks below are the board's own; the browser's url check would differ.
  form.noValidate = true;
  const label = document.createElement('label');
  label.htmlFor = 'tabdock-relay-url';
  label.textContent = 'Tabdock relay page URL';
  const input = document.createElement('input');
  input.id = 'tabdock-relay-url';
  input.name = 'relay';
  input.type = 'url';
  input.placeholder = 'wss://relay.example/page';
  input.spellcheck = false;
  input.autocomplete = 'off';
  const button = document.createElement('button');
  button.type = 'submit';
  button.dataset.action = 'connect';
  button.textContent = 'Connect';
  const error = document.createElement('p');
  error.className = 'connect-error';
  error.dataset.role = 'connect-error';
  error.setAttribute('role', 'alert');
  // Every submit stays in the page, whoever asked for it.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    if (!event.isTrusted) return;
    const checked = checkRelayUrl(input.value.trim(), pageProtocol, 'The relay URL');
    if (checked.kind !== 'ok') {
      error.textContent = checked.message;
      return;
    }
    error.textContent = '';
    rememberChoice(store, checked.url);
    navigate(connectHref(window.location.href, checked.url));
  });
  form.append(label, input, button, error);
  slot.append(form);
  return form;
}

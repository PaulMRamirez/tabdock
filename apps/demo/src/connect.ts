// The board dials only a relay its visitor chose (ADR 0029). A crafted link
// can name any relay in ?relay, and that relay would then show names of its
// own making in attach prompts, so a linked relay waits behind a bar reading
// "Connect to <host>" until a person clicks it, and without ?relay the board
// offers a form instead. Either choice is remembered for this tab and that
// relay URL alone, so a reload reconnects and resumes without a second click.

import { checkRelayUrl } from './relay.ts';

/**
 * The demo's own sessionStorage keys, apart from the adapter's (which start
 * `tabdock:`). A key holds only a relay URL the visitor chose, which carries
 * no credential, query or fragment (relay.ts), so nothing secret is stored.
 */
export const CHOICE_KEY_PREFIX = 'tabdock-demo:connect:';

/** The bits of Storage the choice needs, so tests can stand one in. */
export type ChoiceStore = Pick<Storage, 'getItem' | 'setItem'>;

export function choiceKey(relayUrl: string): string {
  return `${CHOICE_KEY_PREFIX}${relayUrl}`;
}

/** Whether this tab's visitor already chose this exact relay URL. */
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
 * keeping the page's other parameters (?invites, ?e2e) and dropping any hash.
 */
export function connectHref(pageHref: string, relayUrl: string): string {
  const next = new URL(pageHref);
  next.searchParams.set('relay', relayUrl);
  next.hash = '';
  return next.href;
}

/**
 * The bar for a relay named in ?relay. `onChosen` runs once, and only for a
 * click the browser marks trusted: a person's own click or key press, never a
 * script's click() or dispatched event.
 */
export function mountConnectBar(
  after: Element,
  relay: { url: string; host: string },
  store: ChoiceStore | null,
  onChosen: () => void,
): HTMLElement {
  const bar = document.createElement('section');
  bar.className = 'connect';
  bar.dataset.role = 'connect-bar';
  bar.setAttribute('aria-label', 'Connect to a Tabdock relay');
  const note = document.createElement('span');
  note.textContent = 'This link names a Tabdock relay. The board dials it only if you choose to.';
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.action = 'connect';
  // textContent, never markup: the host comes from the address bar.
  button.textContent = `Connect to ${relay.host}`;
  button.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    rememberChoice(store, relay.url);
    bar.remove();
    onChosen();
  });
  bar.append(note, button);
  after.after(bar);
  return bar;
}

/**
 * The form shown without ?relay (or with one the board refused). It is
 * handled in script, so the static build's form-action 'none' holds: a
 * person's own submit of a URL that passes relay.ts's checks records the
 * choice exactly as the bar's click does and navigates to ?relay=.
 *
 * A person's own submit is a trusted click on the Connect button: a mouse
 * click, a key on the button, or Enter in the field, whose implicit
 * submission clicks the button for the person. The submit event itself will
 * not do, since a script's form.requestSubmit() fires a trusted one.
 */
export function mountConnectForm(
  after: Element,
  pageProtocol: string,
  store: ChoiceStore | null,
  navigate: (href: string) => void,
): HTMLFormElement {
  const form = document.createElement('form');
  form.className = 'connect';
  form.dataset.role = 'connect-form';
  // The checks below are relay.ts's own; the browser's url check would differ.
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
  const button = document.createElement('button');
  button.type = 'submit';
  button.textContent = 'Connect';
  const error = document.createElement('p');
  error.className = 'meta connect-error';
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
  after.after(form);
  return form;
}

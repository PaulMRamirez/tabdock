// The board dials only a relay its visitor chose (ADR 0029). A crafted link
// can name any relay in ?relay, and that relay would then show names of its
// own making in attach prompts, so a linked relay waits behind a bar reading
// "Connect to <host>" until a person clicks it, and without ?relay the board
// offers a form instead. Either choice is remembered for this tab, that relay
// URL and that page policy alone, so a reload reconnects and resumes without
// a second click, while a link that changes the policy asks again.
//
// The site review added three things (ADR 0029's notes). The bar names every
// policy the link sets beyond the defaults, since whoever wrote the link
// wrote those too. Its button takes a click only once it has held still in a
// visible, focused tab, as the widget's boxes do, so a double-click begun on
// another window cannot land its second half on the bar. And the host sits in
// an element of its own that wraps, so a long one cannot push its end, the
// part that says who runs it, off a phone's screen.

import { type LinkPolicy, policyNotes, policyTag, setPolicyParams } from './policy.ts';
import { checkRelayUrl } from './relay.ts';

/**
 * The demo's own sessionStorage keys, apart from the adapter's (which start
 * `tabdock:`). A key holds only a relay URL the visitor chose, which carries
 * no credential, query or fragment (relay.ts), and the policy tag, so nothing
 * secret is stored.
 */
export const CHOICE_KEY_PREFIX = 'tabdock-demo:connect:';

/**
 * How long the bar's button must hold still, in a visible tab whose window
 * has focus, before a click counts: the widget's ARM_DELAY_MS
 * (packages/adapter/src/widget.ts), for the same reason.
 */
export const CONNECT_ARM_DELAY_MS = 500;

/** How often the bar checks that its button is still where it armed. */
const ARM_CHECK_MS = 100;

/** The bits of Storage the choice needs, so tests can stand one in. */
export type ChoiceStore = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * The key for one relay URL under one policy tag (policy.ts). The defaults'
 * tag is empty, so their key is the relay URL's alone. A parsed URL's href
 * never holds a space, so the space before a tag keeps every key distinct.
 */
export function choiceKey(relayUrl: string, tag: string): string {
  return tag === '' ? `${CHOICE_KEY_PREFIX}${relayUrl}` : `${CHOICE_KEY_PREFIX}${relayUrl} ${tag}`;
}

/** Whether this tab's visitor already chose this exact relay URL under this policy. */
export function wasChosen(store: ChoiceStore | null, relayUrl: string, tag: string): boolean {
  if (store === null) return false;
  try {
    return store.getItem(choiceKey(relayUrl, tag)) === '1';
  } catch {
    // Storage the browser refuses (a sandboxed frame, a full quota) remembers nothing.
    return false;
  }
}

export function rememberChoice(store: ChoiceStore | null, relayUrl: string, tag: string): void {
  if (store === null) return;
  try {
    store.setItem(choiceKey(relayUrl, tag), '1');
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
 * Where the Connect form goes: this page with ?relay set to the chosen URL
 * and the policy parameters set to what the visitor ticked, and nothing else
 * of them, keeping the page's other parameters (?e2e, ?busy) and dropping any
 * hash. A link to the form cannot carry a looser policy past its visitor.
 */
export function connectHref(pageHref: string, relayUrl: string, policy: LinkPolicy): string {
  const next = new URL(pageHref);
  next.searchParams.set('relay', relayUrl);
  setPolicyParams(next.searchParams, policy);
  next.hash = '';
  return next.href;
}

/** "Connect to " and the host in an element of its own, which wraps anywhere. */
function connectLabel(button: HTMLButtonElement, host: string): void {
  const hostText = document.createElement('span');
  hostText.className = 'connect-host';
  hostText.dataset.role = 'connect-host';
  // textContent, never markup: the host comes from the address bar.
  hostText.textContent = host;
  button.append('Connect to ', hostText);
}

function sameRect(a: DOMRect | null, b: DOMRect): boolean {
  return a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Keeps a button disarmed until it has held still for CONNECT_ARM_DELAY_MS in
 * a visible tab whose window has focus, as the widget's boxes do. A window
 * regaining focus (as when a popup closes on the first half of a
 * double-click), the tab coming back into view, the page shown again from the
 * back-forward cache, a resize, a scroll or any move of the button starts the
 * wait again, and so does a click refused for coming too soon. Events that
 * only start the wait need no isTrusted check: a script that sends them can
 * only make the button wait longer.
 */
function armWhenStill(button: HTMLButtonElement): {
  ready: () => boolean;
  restart: () => void;
  stop: () => void;
} {
  const doc = button.ownerDocument;
  const win = doc.defaultView ?? window;
  let armed = false;
  let rect: DOMRect | null = null;
  let stillSince: number | null = null;

  const setArmed = (value: boolean): void => {
    armed = value;
    button.dataset.armed = String(value);
    button.setAttribute('aria-disabled', String(!value));
  };
  const inView = (): boolean => doc.visibilityState === 'visible' && doc.hasFocus();
  const restart = (): void => {
    setArmed(false);
    rect = button.getBoundingClientRect();
    stillSince = inView() ? performance.now() : null;
  };
  const check = (): void => {
    const now = button.getBoundingClientRect();
    if (!inView() || !sameRect(rect, now)) {
      restart();
      return;
    }
    if (stillSince === null) {
      stillSince = performance.now();
      return;
    }
    if (!armed && performance.now() - stillSince >= CONNECT_ARM_DELAY_MS) setArmed(true);
  };

  const windowEvents = ['focus', 'blur', 'pageshow', 'resize'] as const;
  for (const type of windowEvents) win.addEventListener(type, restart);
  doc.addEventListener('visibilitychange', restart);
  doc.addEventListener('scroll', restart, { capture: true, passive: true });
  const interval = win.setInterval(check, ARM_CHECK_MS);
  restart();

  return {
    // Checked again at the click, as a move may land between two checks.
    ready: () => armed && sameRect(rect, button.getBoundingClientRect()),
    restart,
    stop: () => {
      win.clearInterval(interval);
      for (const type of windowEvents) win.removeEventListener(type, restart);
      doc.removeEventListener('visibilitychange', restart);
      doc.removeEventListener('scroll', restart, { capture: true });
    },
  };
}

/**
 * The bar for a relay named in ?relay. `onChosen` runs once, and only for a
 * click the browser marks trusted (a person's own click or key press, never a
 * script's click() or dispatched event) on a button that had armed before
 * the press began. The bar names every way `policy` departs from the
 * defaults, and the choice is remembered under that policy.
 */
export function mountConnectBar(
  after: Element,
  relay: { url: string; host: string },
  policy: LinkPolicy,
  store: ChoiceStore | null,
  onChosen: () => void,
): HTMLElement {
  const bar = document.createElement('section');
  bar.className = 'connect';
  bar.dataset.role = 'connect-bar';
  bar.setAttribute('aria-label', 'Connect to a Tabdock relay');
  const note = document.createElement('span');
  note.textContent = 'This link names a Tabdock relay. The board dials it only if you choose to.';
  bar.append(note);
  const notes = policyNotes(policy);
  if (notes !== '') {
    const policyLine = document.createElement('p');
    policyLine.className = 'connect-policy';
    policyLine.dataset.role = 'connect-policy';
    policyLine.textContent = `If you connect, this link also sets the board's policy: ${notes}`;
    bar.append(policyLine);
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.action = 'connect';
  connectLabel(button, relay.host);
  bar.append(button);
  after.after(bar);

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
    rememberChoice(store, relay.url, policyTag(policy));
    bar.remove();
    onChosen();
  });
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
 *
 * The two boxes set the policy choices that loosen the defaults, unticked
 * whatever the page's own query says, so only the visitor's tick puts them
 * in the link the form goes to.
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
  const confirmBox = option(
    'confirm',
    'Let members I approve confirm clear_board in their own MCP client',
  );
  const invitesBox = option('invites', 'Offer Can control invites and a second driver seat');
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
    const policy: LinkPolicy = {
      confirmInClient: confirmBox.input.checked,
      invites: invitesBox.input.checked ? 'all' : 'watch',
    };
    rememberChoice(store, checked.url, policyTag(policy));
    navigate(connectHref(window.location.href, checked.url, policy));
  });
  // The boxes come before the button, so they are seen before anyone connects.
  form.append(label, input, confirmBox.label, invitesBox.label, button, error);
  after.after(form);
  return form;
}

function option(name: string, text: string): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = document.createElement('label');
  label.className = 'connect-option';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.dataset.option = name;
  // Unticked whatever the query says; see mountConnectForm.
  input.checked = false;
  label.append(input, ` ${text}`);
  return { label, input };
}

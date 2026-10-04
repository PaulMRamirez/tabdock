// The only script of the invite page at /i (ADRs 0016 and 0017), served as a
// file so the page's CSP can forbid inline script. It reads the invite's
// secret from the URL fragment, which no browser sends, clears it from the
// address bar, keeps it in sessionStorage across the sign-in round trip, and
// shows what the invite would join and who shared it, the title and label as
// the page's own words. It claims only when the person clicks Join: never on
// load, and never on the way back from sign-in. Every string it shows is set
// as text, never parsed as HTML.

const STORE_KEY = 'tabdock-invite-secret';
/** 128 bits as base64url, an invite secret's shape; anything else is not one. */
const SECRET = /^[A-Za-z0-9_-]{22}$/;
const POLL_MS = 1500;

/** @param {string} id */
function element(id) {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`the page has no #${id}`);
  return found;
}

const main = element('main');
const message = element('message');
const preview = element('preview');
const account = element('account');
const signIn = element('signin');
const join = /** @type {HTMLButtonElement} */ (element('join'));
const connect = element('connect');

/** Kept here too, for a browser whose sessionStorage refuses writes. */
let remembered = null;

/**
 * @param {string} state
 * @param {string} text
 */
function say(state, text) {
  main.dataset.state = state;
  message.textContent = text;
}

function readStored() {
  try {
    return sessionStorage.getItem(STORE_KEY);
  } catch {
    return remembered;
  }
}

/** @param {string | null} secret */
function store(secret) {
  remembered = secret;
  try {
    if (secret === null) sessionStorage.removeItem(STORE_KEY);
    else sessionStorage.setItem(STORE_KEY, secret);
  } catch {
    // Private browsing may refuse; the variable above lasts until sign-in leaves the page.
  }
}

/** The secret from the fragment, or the one kept from before sign-in; null when there is none. */
function takeSecret() {
  const fragment = location.hash.slice(1);
  if (location.hash !== '') {
    // Off the address bar at once, so no screenshot, share or history entry carries it.
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    if (SECRET.test(fragment)) store(fragment);
  }
  const kept = readStored();
  return kept !== null && SECRET.test(kept) ? kept : null;
}

/**
 * @param {string} path
 * @param {Record<string, string>} body
 * @returns {Promise<{ status: number, data: Record<string, unknown> }>}
 */
async function post(path, body) {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data: typeof data === 'object' && data ? data : {} };
  } catch {
    return { status: 0, data: { error: 'network' } };
  }
}

/** The page's own words for each refusal; the relay's messages are never shown as they come. */
const REFUSALS = {
  pairing_expired:
    'This invite is used up, closed or expired. Ask the person who shared it for a new one.',
  sign_in_required: 'Your sign-in has run out. Sign in again to join.',
  denied_by_operator: "The page's operator closed this invite to this account.",
  rate_limited: 'Too many attempts. Wait a minute, then try the invite again.',
  page_busy: 'The page cannot take anyone else by invite right now. Try again shortly.',
  page_asleep: 'The page is not connected right now. Try again when it is open.',
  network: 'The relay could not be reached. Check the connection and reload.',
};

/** @param {Record<string, unknown>} data */
function refusal(data) {
  const key = typeof data.error === 'string' ? data.error : '';
  return Object.hasOwn(REFUSALS, key)
    ? REFUSALS[/** @type {keyof typeof REFUSALS} */ (key)]
    : 'Something went wrong. Open the invite link again.';
}

/** @param {Record<string, unknown>} invite */
function showPreview(invite) {
  element('sponsor').textContent = String(invite.sponsor ?? '');
  element('origin').textContent = String(invite.origin ?? '');
  element('title').textContent = String(invite.title ?? '');
  element('title-cut').hidden = invite.titleCut !== true;
  element('label').textContent = String(invite.label ?? '');
  element('role').textContent =
    invite.role === 'driver'
      ? "control it, once the page's operator approves"
      : 'watch it: read only, as an observer';
  preview.hidden = false;
}

/**
 * @param {string} claim
 * @param {string} connector
 */
async function poll(claim, connector) {
  const { status, data } = await post('/i/status', { claim });
  if (status !== 200) {
    say('refused', refusal(data));
    return;
  }
  switch (data.status) {
    case 'pending':
      setTimeout(() => void poll(claim, connector), POLL_MS);
      return;
    case 'approved':
      say('approved', `Joined as ${String(data.role)}.`);
      element('connector').textContent = connector;
      connect.hidden = false;
      return;
    case 'denied':
      say('denied', "The page's operator did not let you in.");
      return;
    default:
      say('expired', 'Nobody answered in time. Open the invite link again.');
  }
}

/**
 * @param {string} secret
 * @param {string} connector
 */
async function claim(secret, connector) {
  join.disabled = true;
  const { status, data } = await post('/i/claim', { secret });
  if (status === 200 && typeof data.claim === 'string') {
    // Asked once; a reload must not offer to join with it again.
    store(null);
    join.hidden = true;
    say('pending', 'Asked to join. Waiting for the page to let you in.');
    await poll(data.claim, connector);
    return;
  }
  if (data.error === 'sign_in_required') {
    join.hidden = true;
    signIn.hidden = false;
  } else if (data.error !== 'rate_limited' && data.error !== 'network') {
    store(null);
  }
  say('refused', refusal(data));
}

async function start() {
  const signInFailed = new URLSearchParams(location.search).get('signin') === 'failed';
  const secret = takeSecret();
  if (location.search !== '') history.replaceState(null, '', location.pathname);
  if (secret === null) {
    say('empty', 'No invite here. Open the invite link you were sent to join its page.');
    return;
  }
  const { status, data } = await post('/i/preview', { secret });
  if (status !== 200 || typeof data.invite !== 'object' || data.invite === null) {
    if (data.error !== 'rate_limited' && data.error !== 'network') store(null);
    say('refused', refusal(data));
    return;
  }
  showPreview(/** @type {Record<string, unknown>} */ (data.invite));
  const connector = typeof data.connector === 'string' ? data.connector : '';
  const who = /** @type {Record<string, unknown>} */ (data.account ?? {});
  if (who.signedIn !== true) {
    say(
      'signin',
      signInFailed
        ? 'Sign-in did not finish. Sign in again to join this page.'
        : 'Sign in to join this page.',
    );
    signIn.hidden = false;
    return;
  }
  const name = String(who.displayName ?? '');
  account.textContent =
    who.verified === true
      ? `Signed in as ${name}.`
      : `Signed in as ${name}. Your sign-in vouched for no email, so the page's operator sees none.`;
  account.hidden = false;
  say('ready', 'Check who shared it and where it leads, then join.');
  join.hidden = false;
  join.addEventListener('click', () => void claim(secret, connector), { once: true });
}

void start();

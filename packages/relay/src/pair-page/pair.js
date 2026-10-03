// The only script of the QR page at /pair, served as a file so the page's CSP
// can forbid inline script. It reads the nonce from the URL fragment, clears
// it from the address bar, keeps it in sessionStorage across the sign-in
// round trip, and shows what the nonce would join. It claims only when the
// person clicks Join: never on load, and never on the way back from sign-in.
// Every string it shows is set as text, never parsed as HTML.

const STORE_KEY = 'tabdock-pair-nonce';
/** 128 bits as base64url, the relay's shape for a nonce; anything else is not one. */
const NONCE = /^[A-Za-z0-9_-]{22}$/;
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

/** @param {string | null} nonce */
function store(nonce) {
  remembered = nonce;
  try {
    if (nonce === null) sessionStorage.removeItem(STORE_KEY);
    else sessionStorage.setItem(STORE_KEY, nonce);
  } catch {
    // Private browsing may refuse; the variable above lasts until sign-in leaves the page.
  }
}

/** The nonce from the fragment, or the one kept from before sign-in; null when there is none. */
function takeNonce() {
  const fragment = location.hash.slice(1);
  if (location.hash !== '') {
    // Off the address bar at once, so no screenshot, share or history entry carries it.
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    if (NONCE.test(fragment)) store(fragment);
  }
  const kept = readStored();
  return kept !== null && NONCE.test(kept) ? kept : null;
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
  pairing_expired: 'This pairing link is used or expired. Scan the QR code on the page again.',
  sign_in_required: 'Your sign-in has run out. Sign in again to join.',
  not_allowed: 'This account is not allowed on this relay. Sign in with another account.',
  rate_limited: 'Too many attempts. Wait a minute, then scan the QR code again.',
  page_busy: 'The page cannot take anyone else right now.',
  network: 'The relay could not be reached. Check the connection and reload.',
};

/** @param {Record<string, unknown>} data */
function refusal(data) {
  const key = typeof data.error === 'string' ? data.error : '';
  return Object.hasOwn(REFUSALS, key)
    ? REFUSALS[/** @type {keyof typeof REFUSALS} */ (key)]
    : 'Something went wrong. Scan the QR code on the page again.';
}

/** @param {Record<string, unknown>} page */
function showPreview(page) {
  element('origin').textContent = String(page.origin ?? '');
  element('title').textContent = String(page.title ?? '');
  element('title-cut').hidden = page.titleCut !== true;
  element('code').textContent = String(page.code ?? '');
  preview.hidden = false;
}

/** @param {string} claim */
async function poll(claim) {
  const { status, data } = await post('/pair/status', { claim });
  if (status !== 200) {
    say('refused', refusal(data));
    return;
  }
  switch (data.status) {
    case 'pending':
      setTimeout(() => void poll(claim), POLL_MS);
      return;
    case 'approved':
      say(
        'approved',
        `Approved as ${String(data.role)}. Ask Claude to list your pages and it will find this one.`,
      );
      return;
    case 'denied':
      say('denied', 'The page operator did not let you in.');
      return;
    default:
      say('expired', 'Nobody answered in time. Scan the QR code on the page again.');
  }
}

/** @param {string} nonce */
async function claim(nonce) {
  join.disabled = true;
  const { status, data } = await post('/pair/claim', { nonce });
  if (status === 200 && typeof data.claim === 'string') {
    // Spent now: a reload must not offer to join with it again.
    store(null);
    join.hidden = true;
    say('pending', "Asked to join. Waiting for the page's operator to approve on the page.");
    await poll(data.claim);
    return;
  }
  // Refused before the nonce was looked at, so it may still work after a fresh sign-in.
  if (data.error === 'sign_in_required') {
    join.hidden = true;
    signIn.hidden = false;
  } else {
    store(null);
  }
  say('refused', refusal(data));
}

async function start() {
  const signInFailed = new URLSearchParams(location.search).get('signin') === 'failed';
  const nonce = takeNonce();
  if (location.search !== '') history.replaceState(null, '', location.pathname);
  if (nonce === null) {
    say('empty', 'No pairing link here. Scan the QR code on the page to join it.');
    return;
  }
  const { status, data } = await post('/pair/preview', { nonce });
  if (status !== 200 || typeof data.page !== 'object' || data.page === null) {
    if (data.error !== 'rate_limited' && data.error !== 'network') store(null);
    say('refused', refusal(data));
    return;
  }
  showPreview(/** @type {Record<string, unknown>} */ (data.page));
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
  if (who.member !== true) {
    say('refused', REFUSALS.not_allowed);
    signIn.textContent = 'Sign in with another account';
    signIn.hidden = false;
    return;
  }
  account.textContent = `Signed in as ${String(who.displayName ?? '')}.`;
  account.hidden = false;
  say('ready', 'Check that the code matches the page, then join.');
  join.hidden = false;
  join.addEventListener('click', () => void claim(nonce), { once: true });
}

void start();

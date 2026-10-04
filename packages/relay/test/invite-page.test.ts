// The invite page at /i (ADRs 0016, 0017 and 0020), driven over HTTP the way a
// phone's browser drives it through the tunnel: the page under /pair's CSP and
// headers; a preview of the page and its sponsor, the title and label marked
// as written by the page, that uses nothing up; sign-in through /pair/login
// and back to /i, with scope `openid email` and the email read from the ID
// token or else from UserInfo; a claim only on Join, from /i, signed in; and
// the claim's status read back by its claimant alone.

import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOGIN_COOKIE, SESSION_COOKIE } from '../src/index.ts';
import { SlidingWindowLimiter } from '../src/rate-limit.ts';
import {
  attachMember,
  type InviteRelay,
  joinAtI,
  mintOk,
  settledAtI,
  signedInAtI,
  startInviteRelay,
} from './helpers/invites.ts';
import { PAGE_ORIGIN } from './helpers/page-client.ts';
import { Phone } from './helpers/phone.ts';
import { PUBLIC_ORIGIN } from './helpers/tunnel.ts';

let current: InviteRelay | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function setup(options: Parameters<typeof startInviteRelay>[0] = {}) {
  const relay = await startInviteRelay(options);
  current = relay;
  const page = await relay.page({ policy: { invites: 'all' } });
  await attachMember(await relay.claude('sub-alice'), page);
  return { relay, page };
}

const EXPIRED = {
  error: 'pairing_expired',
  message: 'this invite link is invalid, used up or expired',
};

describe('the page at /i', () => {
  it('is served under the same CSP and headers as /pair, and its script as a file', async () => {
    const { relay } = await setup();
    const phone = new Phone(relay.relay.url);
    const pair = await phone.request('/pair');
    const invite = await phone.request('/i');
    expect(invite.status).toBe(200);
    expect(invite.headers.get('content-type')).toBe('text/html; charset=utf-8');
    for (const name of [
      'content-security-policy',
      'cache-control',
      'referrer-policy',
      'x-content-type-options',
      'x-frame-options',
      'cross-origin-opener-policy',
      'cross-origin-resource-policy',
    ]) {
      expect(invite.headers.get(name), name).toBe(pair.headers.get(name));
    }
    expect(invite.headers.get('content-security-policy')).toContain(
      "require-trusted-types-for 'script'",
    );
    expect(invite.body).toContain('<script type="module" src="/i/invite.js"></script>');
    expect(invite.body).not.toMatch(/<script>|style=/);
    const script = await phone.request('/i/invite.js');
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(script.headers.get('content-security-policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    // Every string it shows goes in as text.
    expect(script.body).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect((await phone.request('/i', { method: 'POST' })).status).toBe(405);
  });

  it('is not there at all on a relay with invites off', async () => {
    const relay = await startInviteRelay({ invites: false });
    current = relay;
    const phone = new Phone(relay.relay.url);
    for (const path of ['/i', '/i/invite.js']) expect((await phone.request(path)).status).toBe(404);
    expect((await phone.post('/i/preview', { secret: 'A'.repeat(22) })).status).toBe(404);
    // Sign-in still returns to /pair, whatever it asks for.
    const login = await phone.request('/pair/login?to=i');
    const cookie = phone.setCookies.find((set) => set.name === LOGIN_COOKIE);
    expect(cookie?.value.split('.')).toHaveLength(4);
    expect(login.status).toBe(303);
  });
});

describe('the preview at /i', () => {
  it('shows the page, its sponsor and the label as the page wrote them, and uses nothing up', async () => {
    const { relay, page } = await setup();
    const label = '‮evil‬ Friends';
    const { secret, inviteId } = await mintOk(page, { label, role: 'driver' });
    const phone = new Phone(relay.relay.url);
    for (let i = 0; i < 3; i += 1) {
      const shown = await phone.post('/i/preview', { secret });
      expect(shown.status).toBe(200);
      expect(shown.data).toEqual({
        invite: {
          origin: PAGE_ORIGIN,
          title: 'Board',
          titleCut: false,
          label: 'evil Friends',
          role: 'driver',
          sponsor: 'Alice',
          expiresAt: relay.store.invites.get(page.pageId, inviteId)?.expiresAt,
        },
        account: { signedIn: false },
        connector: `${PUBLIC_ORIGIN}/mcp`,
      });
    }
    await page.sync();
    expect(page.all('attach_request')).toHaveLength(1);
    expect(relay.store.invites.get(page.pageId, inviteId)).toMatchObject({
      usesLeft: 1,
      pendingRequestId: null,
    });
  });

  it('reads a made-up secret like a spent one, and counts only live invites', async () => {
    const { relay, page } = await setup({ rateLimits: { pairPreviewsPerNonce: 3 } });
    const { secret } = await mintOk(page, { uses: 2 });
    const phone = new Phone(relay.relay.url);
    const record = vi.spyOn(SlidingWindowLimiter.prototype, 'record');
    try {
      for (let i = 0; i < 50; i += 1) {
        const madeUp = randomBytes(16).toString('base64url');
        expect(await phone.post('/i/preview', { secret: madeUp })).toMatchObject({
          status: 404,
          data: EXPIRED,
        });
      }
      expect(await phone.post('/i/preview', { secret: 'not a secret' })).toMatchObject({
        status: 404,
      });
      expect(record).not.toHaveBeenCalled();
    } finally {
      record.mockRestore();
    }
    for (let i = 0; i < 3; i += 1) {
      expect((await phone.post('/i/preview', { secret })).status).toBe(200);
    }
    const limited = await phone.post('/i/preview', { secret });
    expect(limited).toMatchObject({ status: 429, data: { error: 'rate_limited' } });
    expect(limited.headers.get('retry-after')).toBe('60');
  });
});

describe('sign-in from /i (ADR 0020)', () => {
  it('asks for openid email, comes back to /i, and names an invitee by the email in its ID token', async () => {
    const { relay, page } = await setup();
    const { secret } = await mintOk(page, { uses: 2 });
    relay.provider.signInSubject = 'sub-guest';
    relay.provider.idTokenClaims = { email: 'guest@example.com', email_verified: true };
    const phone = new Phone(relay.relay.url);
    let signIn: Awaited<ReturnType<Phone['signIn']>>;
    try {
      signIn = await phone.signIn('/pair/login?to=i');
    } finally {
      relay.provider.signInSubject = null;
      relay.provider.idTokenClaims = null;
    }
    expect(signIn.authorize.searchParams.get('scope')).toBe('openid email');
    expect(signIn.authorize.searchParams.get('redirect_uri')).toBe(
      `${PUBLIC_ORIGIN}/pair/callback`,
    );
    const loginCookie = phone.setCookies.find(
      (cookie) => cookie.name === LOGIN_COOKIE && cookie.value !== '',
    );
    expect(loginCookie?.value.split('.').at(-1)).toBe('i');
    expect(signIn.callback.headers.get('location')).toBe('/i');
    expect(phone.cookies.has(SESSION_COOKIE)).toBe(true);
    // The ID token named the email, so UserInfo was never asked.
    expect(relay.provider.userInfoRequests).toBe(0);
    expect((await phone.post('/i/preview', { secret })).data.account).toEqual({
      signedIn: true,
      member: false,
      displayName: 'guest@example.com',
      verified: true,
    });
    const { request } = await joinAtI(phone, page, secret);
    expect(request).toMatchObject({
      user: { displayName: 'guest@example.com' },
      account: { kind: 'invitee', verified: true },
    });
    // The email went to the page, never to a log line.
    expect(relay.lines.join('\n')).not.toContain('guest@example.com');
    expect(relay.lines.join('\n')).not.toContain('sub-guest');
  });

  it('asks UserInfo for the email when the ID token names none, and counts an unverified one as none', async () => {
    const { relay, page } = await setup();
    relay.provider.userInfo = { email: 'guest@example.com', email_verified: true };
    const verified = await signedInAtI(relay, 'sub-guest', null);
    expect(relay.provider.userInfoRequests).toBe(1);
    const { secret } = await mintOk(page, { uses: 3 });
    expect((await verified.post('/i/preview', { secret })).data.account).toMatchObject({
      displayName: 'guest@example.com',
      verified: true,
    });
    relay.provider.userInfo = { email: 'other@example.com', email_verified: false };
    const unverified = await signedInAtI(relay, 'sub-other', null);
    expect((await unverified.post('/i/preview', { secret })).data.account).toMatchObject({
      displayName: 'unverified account',
      verified: false,
    });
    // A member's email is never asked for: the owner's settings name members.
    relay.provider.userInfo = { email: 'alice@example.com', email_verified: true };
    const member = await signedInAtI(relay, 'sub-alice', null);
    expect(relay.provider.userInfoRequests).toBe(2);
    expect((await member.post('/i/preview', { secret })).data.account).toEqual({
      signedIn: true,
      member: true,
      displayName: 'Alice',
      verified: true,
    });
  });

  it('goes back to /i when a sign-in started there fails', async () => {
    const { relay } = await setup();
    const phone = new Phone(relay.relay.url);
    await phone.request('/pair/login?to=i');
    const refused = await phone.request('/pair/callback?error=access_denied');
    expect(refused.headers.get('location')).toBe('/i?signin=failed');
    // A target other than /i is no target: the sign-in returns to /pair.
    await phone.request('/pair/login?to=https://evil.example');
    const back = await phone.request('/pair/callback?error=access_denied');
    expect(back.headers.get('location')).toBe('/pair?signin=failed');
  });
});

describe('Join at /i', () => {
  it('claims only from /i, signed in, and only its claimant reads the status', async () => {
    const { relay, page } = await setup();
    const { secret } = await mintOk(page, { uses: 2 });
    const anonymous = new Phone(relay.relay.url);
    expect(await anonymous.post('/i/claim', { secret })).toMatchObject({
      status: 401,
      data: { error: 'sign_in_required' },
    });
    const guest = await signedInAtI(relay, 'sub-guest', 'guest@example.com');
    for (const origin of ['https://evil.example', null]) {
      expect((await guest.post('/i/claim', { secret }, { origin })).status).toBe(403);
    }
    const form = await guest.request('/i/claim', {
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      body: `secret=${secret}`,
    });
    expect(form.status).toBe(415);
    await page.sync();
    expect(page.all('attach_request')).toHaveLength(1);

    const claimed = await guest.post('/i/claim', { secret });
    expect(claimed).toMatchObject({ status: 200, data: { status: 'pending' } });
    const claim = String(claimed.data.claim);
    const request = await page.next('attach_request');
    expect(request.via).toBe('invite');
    expect((await guest.post('/i/status', { claim })).data).toEqual({ status: 'pending' });
    const other = await signedInAtI(relay, 'sub-other', 'other@example.com');
    expect(await other.post('/i/status', { claim })).toMatchObject({
      status: 404,
      data: { error: 'unknown_claim' },
    });
    page.send({ t: 'attach_decision', requestId: request.requestId, allow: true });
    expect(await settledAtI(guest, claim)).toEqual({ status: 'approved', role: 'observer' });
    // The same account on Claude finds the page.
    const claude = await relay.claude('sub-guest', 'guest@example.com');
    const listed = await claude.callTool({ name: 'list_pages', arguments: {} });
    expect(listed.structuredContent).toMatchObject({
      pages: [{ page: page.pageId, role: 'observer' }],
    });
  });

  it('reads denied for a refusal, and refuses a spent or made-up secret like /pair does a nonce', async () => {
    const { relay, page } = await setup();
    const { secret } = await mintOk(page);
    const guest = await signedInAtI(relay, 'sub-guest', 'guest@example.com');
    expect((await joinAtI(guest, page, secret, { allow: false })).settled).toEqual({
      status: 'denied',
    });
    expect((await joinAtI(guest, page, secret)).settled).toMatchObject({ status: 'approved' });
    for (const spent of [secret, randomBytes(16).toString('base64url')]) {
      expect(await guest.post('/i/claim', { secret: spent })).toMatchObject({
        status: 404,
        data: { error: 'pairing_expired' },
      });
    }
  });
});

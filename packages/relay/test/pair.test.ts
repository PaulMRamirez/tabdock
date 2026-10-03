// The QR flow at /pair (M3; S3, S4, S11, S13; ADR 0016 groundwork), driven
// over HTTP the way a phone's browser drives it through the tunnel: the page
// and its CSP, a preview that uses nothing up, sign-in at the test provider
// with PKCE, the __Host- session, a claim that only a signed-in member on the
// page's own origin can make, the operator's answer read back by polling, and
// the same person then finding the page through /mcp. Then everything that
// must not happen: a nonce used twice or late, a claim without a session or
// from another origin, a stranger's claim, and any secret in a log line.

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOAuthAuth,
  createRelay,
  LOGIN_COOKIE,
  type Relay,
  type RelayOptions,
  SESSION_COOKIE,
} from '../src/index.ts';
import { connectPage, PAGE_ORIGIN, type TestPage, TOOLS } from './helpers/page-client.ts';
import { type JsonAnswer, Phone } from './helpers/phone.ts';
import { MOCK_SUBJECT, PAIR_CLIENT, startProvider, type TestProvider } from './helpers/provider.ts';
import { delay, eventually, startRelay } from './helpers/relay.ts';
import { PUBLIC_MCP_URL, PUBLIC_ORIGIN, rawRequest, tunnelFetch } from './helpers/tunnel.ts';

const USERS = [
  { sub: MOCK_SUBJECT, userId: 'alice', displayName: 'Alice' },
  { sub: 'sub-bob', userId: 'bob', displayName: 'Bob' },
];
const STRANGER = 'sub-stranger';
const NONCE_URL = /^https:\/\/relay\.test\/pair#[A-Za-z0-9_-]{22}$/;
/** Unknown, used and expired nonces all get exactly this. */
const EXPIRED = { error: 'pairing_expired', message: 'this pairing link is invalid or expired' };

let provider: TestProvider;
let relay: Relay | undefined;
let lines: string[] = [];
const pages: TestPage[] = [];
const clients: Client[] = [];

beforeEach(async () => {
  provider = await startProvider();
  lines = [];
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const opened of pages.splice(0)) opened.ws.terminate();
  await relay?.close();
  relay = undefined;
  await provider.stop();
});

async function start(options: Partial<RelayOptions> = {}): Promise<Relay> {
  relay = await createRelay({
    auth: createOAuthAuth({ issuer: provider.issuer, resource: PUBLIC_MCP_URL, users: USERS }),
    publicUrl: PUBLIC_ORIGIN,
    pairClient: PAIR_CLIENT,
    allowedOrigins: [PAGE_ORIGIN],
    port: 0,
    logLevel: 'debug',
    logSink: (line) => {
      lines.push(line);
    },
    ...options,
  });
  return relay;
}

function current(): Relay {
  if (!relay) throw new Error('no relay');
  return relay;
}

async function page(options: Parameters<typeof connectPage>[1] = {}): Promise<TestPage> {
  const opened = await connectPage(current().pageUrl, {
    tools: TOOLS,
    title: 'Board',
    onInvoke: (frame) => ({ ok: true, content: JSON.stringify({ tool: frame.tool }) }),
    ...options,
  });
  pages.push(opened);
  return opened;
}

function phone(): Phone {
  return new Phone(current().url);
}

/** A phone signed in at /pair as `subject` (the mock's own subject, Alice, by default). */
async function signedIn(subject: string | null = null): Promise<Phone> {
  provider.signInSubject = subject;
  try {
    const browser = phone();
    const { callback } = await browser.signIn();
    expect(callback.headers.get('location')).toBe('/pair');
    return browser;
  } finally {
    provider.signInSubject = null;
  }
}

/** Claude on the phone: an MCP client through the tunnel with a token for `sub`. */
async function claudeAs(sub: string): Promise<{ client: Client; token: string }> {
  const token = await provider.token({ sub, aud: PUBLIC_MCP_URL });
  const client = new Client({ name: 'claude-phone', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(PUBLIC_MCP_URL), {
      authProvider: { token: () => Promise.resolve(token) },
      fetch: tunnelFetch(current().url),
    }),
  );
  clients.push(client);
  return { client, token };
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

function events(): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Claims and reads back the claim id, failing the test with the body when refused. */
async function claimOk(browser: Phone, nonce: string): Promise<string> {
  const claimed = await browser.claim(nonce);
  expect(claimed.status, JSON.stringify(claimed.data)).toBe(200);
  const id = claimed.data.claim;
  if (typeof id !== 'string') throw new Error('no claim id');
  return id;
}

async function settledStatus(browser: Phone, claim: string): Promise<JsonAnswer['data']> {
  let last: JsonAnswer['data'] = {};
  await eventually(async () => {
    last = (await browser.status(claim)).data;
    return last.status !== 'pending';
  }, 3000);
  return last;
}

describe('the pairing URL (S11)', () => {
  it('carries a fresh 128-bit nonce in the fragment of <public URL>/pair, living as long as the code', async () => {
    await start();
    const opened = await page();
    const welcome = opened.welcome?.pairing;
    expect(welcome?.url).toMatch(NONCE_URL);
    expect((welcome?.expiresAt ?? 0) - Date.now()).toBeGreaterThan(110_000);
    const first = opened.nonce;
    opened.send({ t: 'rotate_pairing' });
    expect((await opened.next('pairing')).url).toMatch(NONCE_URL);
    expect(opened.nonce).not.toBe(first);
    // The preview tells the phone the same expiry as the code's.
    const shown = await phone().preview(opened.nonce);
    expect(shown.data.page).toMatchObject({ expiresAt: opened.all('pairing').at(-1)?.expiresAt });
  });

  it('is absent without a public URL, and so is every /pair route', async () => {
    const local = await startRelay();
    try {
      const plain = await connectPage(local.relay.pageUrl, { tools: TOOLS });
      expect(plain.welcome?.pairing.url).toBeUndefined();
      plain.send({ t: 'rotate_pairing' });
      expect((await plain.next('pairing')).url).toBeUndefined();
      plain.ws.terminate();
      for (const [method, path] of [
        ['GET', '/pair'],
        ['GET', '/pair/pair.js'],
        ['GET', '/pair/login'],
        ['GET', '/pair/callback?code=x&state=y'],
        ['POST', '/pair/preview'],
        ['POST', '/pair/claim'],
        ['POST', '/pair/status'],
      ] as const) {
        const answer = await rawRequest(local.relay.url, path, {
          method,
          headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1' },
          ...(method === 'POST' ? { body: '{}' } : {}),
        });
        expect(answer.status, path).toBe(404);
      }
    } finally {
      await local.close();
    }
  });
});

describe('the /pair page', () => {
  it('is static, under a strict CSP with no inline script, never cached, never referring, never framed', async () => {
    await start();
    const browser = phone();
    const html = await browser.request('/pair');
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const csp = html.headers.get('content-security-policy') ?? '';
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "require-trusted-types-for 'script'",
    ]) {
      expect(csp).toContain(directive);
    }
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|unsafe-hashes/);
    expect(html.headers.get('cache-control')).toBe('no-store');
    expect(html.headers.get('referrer-policy')).toBe('no-referrer');
    expect(html.headers.get('x-frame-options')).toBe('DENY');
    expect(html.headers.get('x-content-type-options')).toBe('nosniff');
    // Its one script is a file; no element has a script or style body or an inline handler.
    expect(html.body).toContain('<script type="module" src="/pair/pair.js"></script>');
    expect(html.body).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    expect(html.body).not.toMatch(/<style|\sstyle=|\son[a-z]+=/i);

    const script = await browser.request('/pair/pair.js');
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(script.headers.get('cache-control')).toBe('no-store');
    for (const part of ['location.hash', 'history.replaceState', 'sessionStorage', '/pair/claim']) {
      expect(script.body).toContain(part);
    }
    // Text only: nothing the page wrote can become markup on the phone.
    expect(script.body).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    const style = await browser.request('/pair/pair.css');
    expect(style.headers.get('content-type')).toBe('text/css; charset=utf-8');

    const head = await browser.request('/pair', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    const posted = await browser.request('/pair', { method: 'POST', body: '' });
    expect(posted.status).toBe(405);
    expect(posted.headers.get('allow')).toBe('GET, HEAD');
    expect((await browser.request('/pair/claim')).status).toBe(405);
    expect((await browser.request('/pair/login', { method: 'POST', body: '' })).status).toBe(405);
  });

  it('answers only the public host and loopback names, like /mcp', async () => {
    await start();
    for (const host of ['evil.example', 'relay.test.evil.example']) {
      expect((await rawRequest(current().url, '/pair', { host })).status, host).toBe(403);
    }
    expect((await rawRequest(current().url, '/pair', { host: '127.0.0.1' })).status).toBe(200);
  });
});

describe('scan to first call', () => {
  it('previews, signs in with PKCE, claims, waits for the operator, and the same user then drives the page from /mcp', async () => {
    // The spike flag on, for the scan-to-first-call milestones (A3.3) checked at the end.
    await start({ spike: true });
    const opened = await page();
    const nonce = opened.nonce;
    const code = opened.code;
    const browser = phone();

    // Scanned, before sign-in: what this nonce would join, and nobody signed in.
    const before = await browser.preview(nonce);
    expect(before.status).toBe(200);
    expect(before.data).toEqual({
      page: {
        origin: PAGE_ORIGIN,
        title: 'Board',
        titleCut: false,
        code,
        expiresAt: opened.welcome?.pairing.expiresAt,
      },
      account: { signedIn: false },
    });

    // Sign-in: authorization code with PKCE S256, state and nonce, at the oauth plugin's provider.
    const { login, authorize, callback } = await browser.signIn();
    expect(login.status).toBe(303);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${provider.issuer}/authorize`);
    const asked = authorize.searchParams;
    expect(asked.get('response_type')).toBe('code');
    expect(asked.get('client_id')).toBe(PAIR_CLIENT.clientId);
    expect(asked.get('redirect_uri')).toBe(`${PUBLIC_ORIGIN}/pair/callback`);
    expect(asked.get('scope')).toBe('openid');
    expect(asked.get('code_challenge_method')).toBe('S256');
    for (const name of ['code_challenge', 'state', 'nonce']) {
      expect(asked.get(name), name).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    expect(authorize.href).not.toContain(nonce);
    const loginCookie = browser.setCookies.find((cookie) => cookie.name === LOGIN_COOKIE);
    expect(Object.fromEntries(loginCookie?.attributes ?? [])).toEqual({
      path: '/',
      'max-age': '600',
      secure: '',
      httponly: '',
      samesite: 'Lax',
    });
    expect(callback.status).toBe(303);
    const session = browser.setCookies.find(
      (cookie) => cookie.name === SESSION_COOKIE && cookie.value !== '',
    );
    expect(session?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Object.fromEntries(session?.attributes ?? [])).toEqual({
      path: '/',
      'max-age': '900',
      secure: '',
      httponly: '',
      samesite: 'Lax',
    });
    // The sign-in in progress is over, and the relay presented its own client and secret.
    expect(browser.cookies.has(LOGIN_COOKIE)).toBe(false);
    expect(provider.codeGrants).toEqual([{ clientId: PAIR_CLIENT.clientId, secretSent: true }]);

    // Back from sign-in, the same nonce still previews: nothing was used up.
    const after = await browser.preview(nonce);
    expect(after.data.account).toEqual({ signedIn: true, member: true, displayName: 'Alice' });
    expect(opened.all('attach_request')).toHaveLength(0);

    // Join: the nonce is spent, the page gets a new code and nonce, and its operator is asked.
    const claim = await claimOk(browser, nonce);
    expect(claim).toMatch(/^qc_/);
    const request = await opened.next('attach_request');
    expect(request).toMatchObject({
      user: { userId: 'alice', displayName: 'Alice' },
      via: 'qr',
      client: null,
    });
    const rotated = await opened.next('pairing');
    expect(rotated.code).not.toBe(code);
    expect(opened.nonce).not.toBe(nonce);
    expect((await browser.status(claim)).data).toEqual({ status: 'pending' });

    opened.send({
      t: 'attach_decision',
      requestId: request.requestId,
      allow: true,
      role: 'driver',
    });
    expect(await settledStatus(browser, claim)).toEqual({ status: 'approved', role: 'driver' });

    // Claude on the phone, signed in as the same person, finds the page and drives it.
    const { client } = await claudeAs(MOCK_SUBJECT);
    const listed = await client.callTool({ name: 'list_pages', arguments: {} });
    expect(listed.structuredContent).toEqual({
      pages: [
        {
          page: opened.pageId,
          origin: PAGE_ORIGIN,
          title: 'Board',
          role: 'driver',
          state: 'awake',
          toolCount: TOOLS.length,
        },
      ],
    });
    for (let i = 0; i < 2; i += 1) {
      const called = await client.callTool({
        name: 'call_page_tool',
        arguments: { page: opened.pageId, tool: 'get_view', arguments: {} },
      });
      expect(called.isError ?? false, textOf(called)).toBe(false);
    }

    // A3.3: the spike's milestones, scan to first call, under one trace id that is
    // neither the nonce nor the code. The second preview, after sign-in, is no new scan.
    const milestones = events().filter((event) => event.msg === 'spike: pairing milestone');
    const claimed = milestones.find((event) => event.stage === 'claimed');
    expect(claimed).toMatchObject({ via: 'qr', userId: 'alice', pageId: opened.pageId });
    const trace = claimed?.trace;
    expect(trace).toMatch(/^tr_[0-9A-Z]{10}$/);
    const steps = milestones.filter((event) => event.trace === trace);
    expect(steps.map((event) => event.stage)).toEqual([
      'issued',
      'scanned',
      'claimed',
      'approved',
      'first_call',
    ]);
    for (const step of steps) {
      expect(step).toMatchObject({ pageId: opened.pageId });
      expect(JSON.stringify(step)).not.toContain(nonce);
      expect(JSON.stringify(step)).not.toContain(code);
    }
    const first = steps.at(-1);
    expect(first).toMatchObject({ userId: 'alice', via: 'qr', outcome: 'ok' });
    for (const since of ['sinceIssuedMs', 'sinceScannedMs', 'sinceClaimedMs', 'sinceApprovedMs']) {
      expect(typeof first?.[since], since).toBe('number');
    }
    // The ticket the claim put in its place has a trace of its own.
    const next = milestones.filter((event) => event.stage === 'issued').at(-1);
    expect(next?.trace).not.toBe(trace);
    // Only the first call after the approval is the first call.
    expect(milestones.filter((event) => event.stage === 'first_call')).toHaveLength(1);
  });

  it('logs no pairing milestones with the spike flag off', async () => {
    await start();
    const opened = await page();
    const browser = await signedIn();
    expect((await browser.preview(opened.nonce)).status).toBe(200);
    const claim = await claimOk(browser, opened.nonce);
    const request = await opened.next('attach_request');
    opened.send({ t: 'attach_decision', requestId: request.requestId, allow: true });
    await settledStatus(browser, claim);
    expect(lines.join('\n')).not.toContain('pairing milestone');
  });

  it('a page that lets observers in without asking attaches at once, and the claim reads approved', async () => {
    await start();
    const opened = await page({ policy: { autoApprove: 'observer' } });
    const browser = await signedIn();
    const claim = await claimOk(browser, opened.nonce);
    expect(await settledStatus(browser, claim)).toEqual({ status: 'approved', role: 'observer' });
    expect(opened.all('attach_request')).toHaveLength(0);
  });

  it('a person already attached reads approved with the role they hold, and nobody is asked', async () => {
    await start();
    const opened = await page();
    const browser = await signedIn();
    const first = await claimOk(browser, opened.nonce);
    const request = await opened.next('attach_request');
    opened.send({
      t: 'attach_decision',
      requestId: request.requestId,
      allow: true,
      role: 'driver',
    });
    await settledStatus(browser, first);
    await opened.next('pairing');
    const again = await claimOk(browser, opened.nonce);
    expect(await settledStatus(browser, again)).toEqual({ status: 'approved', role: 'driver' });
    await opened.sync();
    expect(opened.all('attach_request')).toHaveLength(1);
  });

  it('reads denied for a refusal and expired for silence, which is a denial too', async () => {
    await start({ timings: { attachRequestTtlMs: 300 } });
    const opened = await page();
    const browser = await signedIn();
    const denied = await claimOk(browser, opened.nonce);
    const request = await opened.next('attach_request');
    opened.send({ t: 'attach_decision', requestId: request.requestId, allow: false });
    expect(await settledStatus(browser, denied)).toEqual({ status: 'denied' });

    await opened.next('pairing');
    const unanswered = await claimOk(browser, opened.nonce);
    await opened.next('attach_request');
    expect(await settledStatus(browser, unanswered)).toEqual({ status: 'expired' });
    // Nobody was attached by either.
    const { client } = await claudeAs(MOCK_SUBJECT);
    expect(textOf(await client.callTool({ name: 'list_pages', arguments: {} }))).toMatch(
      /not attached to any page/,
    );
  });

  it('a claim joins the request a typed code already raised, and one approval answers both', async () => {
    await start({ spike: true });
    const opened = await page();
    const { client } = await claudeAs(MOCK_SUBJECT);
    const typed = client.callTool({ name: 'pair_page', arguments: { code: opened.code } });
    const request = await opened.next('attach_request');
    expect(request.via).toBe('code');
    await opened.next('pairing');
    const browser = await signedIn();
    const claim = await claimOk(browser, opened.nonce);
    await opened.sync();
    expect(opened.all('attach_request')).toHaveLength(1);
    opened.send({
      t: 'attach_decision',
      requestId: request.requestId,
      allow: true,
      role: 'driver',
    });
    expect(await settledStatus(browser, claim)).toEqual({ status: 'approved', role: 'driver' });
    expect((await typed).isError ?? false).toBe(false);
    // The latest claim, the QR one, is what the spike times to the first call.
    await client.callTool({
      name: 'call_page_tool',
      arguments: { page: opened.pageId, tool: 'get_view', arguments: {} },
    });
    const first = events().filter(
      (event) => event.msg === 'spike: pairing milestone' && event.stage === 'first_call',
    );
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ via: 'qr', userId: 'alice' });
    // This phone claimed without a preview, so there is no scan to time from.
    expect(first[0]?.sinceScannedMs).toBeNull();
    expect(typeof first[0]?.sinceClaimedMs).toBe('number');
  });
});

describe('the nonce (S3, S11)', () => {
  it('works once: a used nonce, an unknown one and a malformed one get the same answer', async () => {
    await start();
    const opened = await page();
    const browser = await signedIn();
    const nonce = opened.nonce;
    await claimOk(browser, nonce);
    const refusals = [
      await browser.claim(nonce),
      await browser.preview(nonce),
      await browser.claim('AAAAAAAAAAAAAAAAAAAAAA'),
      await browser.preview('AAAAAAAAAAAAAAAAAAAAAA'),
      await browser.claim('not a nonce'),
      await browser.preview(`${nonce}x`),
    ];
    for (const refused of refusals) {
      expect(refused.status).toBe(404);
      expect(refused.data).toEqual(EXPIRED);
    }
    await opened.sync();
    expect(opened.all('attach_request')).toHaveLength(1);
  });

  it('dies with its code when the code expires, and the page gets a new pair', async () => {
    await start({ timings: { pairingTtlMs: 300 } });
    const opened = await page();
    const browser = await signedIn();
    const old = opened.nonce;
    expect((await browser.preview(old)).status).toBe(200);
    await opened.next('pairing', 2000);
    expect(await browser.preview(old)).toMatchObject({ status: 404, data: EXPIRED });
    expect(await browser.claim(old)).toMatchObject({ status: 404, data: EXPIRED });
    expect((await browser.preview(opened.nonce)).status).toBe(200);
  });

  it('is refused past its own expiry even before the rotation timer fires', async () => {
    await start();
    const opened = await page();
    const browser = await signedIn();
    const realNow = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 121_000);
    try {
      expect(await browser.preview(opened.nonce)).toMatchObject({ status: 404, data: EXPIRED });
      expect(await browser.claim(opened.nonce)).toMatchObject({ status: 404, data: EXPIRED });
    } finally {
      clock.mockRestore();
    }
    await opened.sync();
    expect(opened.all('attach_request')).toHaveLength(0);
  });

  it('dies with its code when the code is typed or the page asks for a new one', async () => {
    await start();
    const opened = await page({ policy: { autoApprove: 'observer' } });
    const browser = await signedIn();
    const first = opened.nonce;
    const { client } = await claudeAs('sub-bob');
    const typed = await client.callTool({ name: 'pair_page', arguments: { code: opened.code } });
    expect(typed.isError ?? false).toBe(false);
    await opened.sync();
    expect(opened.nonce).not.toBe(first);
    expect(await browser.claim(first)).toMatchObject({ status: 404, data: EXPIRED });
    const second = opened.nonce;
    opened.send({ t: 'rotate_pairing' });
    await opened.next('pairing');
    expect(await browser.claim(second)).toMatchObject({ status: 404, data: EXPIRED });
    expect((await browser.claim(opened.nonce)).status).toBe(200);
  });

  it('dies when its page sleeps, and the page that comes back shows a new one', async () => {
    await start();
    const opened = await page();
    const browser = await signedIn();
    const old = opened.nonce;
    const token = opened.welcome?.resumeToken ?? '';
    await opened.close();
    expect(await browser.preview(old)).toMatchObject({ status: 404, data: EXPIRED });
    const back = await page({ resumeToken: token });
    expect(back.nonce).not.toBe(old);
    expect((await browser.preview(back.nonce)).status).toBe(200);
  });

  it('a preview uses nothing up, signed in or not: no prompt, no new code, and the claim still works', async () => {
    await start();
    const opened = await page();
    const nonce = opened.nonce;
    const stranger = phone();
    const browser = await signedIn();
    for (let i = 0; i < 5; i += 1) {
      expect((await stranger.preview(nonce)).status).toBe(200);
      expect((await browser.preview(nonce)).status).toBe(200);
    }
    await opened.sync();
    expect(opened.all('attach_request')).toHaveLength(0);
    expect(opened.all('pairing')).toHaveLength(0);
    await claimOk(browser, nonce);
  });

  it('a page title is capped and stripped of controls before the phone shows it (S10)', async () => {
    await start();
    const title = `‮evil‬ ${'x'.repeat(200)}`;
    const opened = await page({ title });
    const shown = await phone().preview(opened.nonce);
    const { title: displayed, titleCut } = shown.data.page as { title: string; titleCut: boolean };
    expect(titleCut).toBe(true);
    expect(displayed.startsWith('evil ')).toBe(true);
    expect(displayed).not.toMatch(/[‪-‮]/);
    expect(displayed.length).toBeLessThanOrEqual(120);
  });
});

describe('who may claim (S4, S13, ADR 0016)', () => {
  it('without a session: 401, and the nonce still works for whoever signs in', async () => {
    await start();
    const opened = await page();
    const browser = phone();
    expect(await browser.claim(opened.nonce)).toMatchObject({
      status: 401,
      data: { error: 'sign_in_required' },
    });
    // A made-up session cookie is no session either.
    browser.cookies.set(SESSION_COOKIE, 'A'.repeat(43));
    expect((await browser.claim(opened.nonce)).status).toBe(401);
    await opened.sync();
    expect(opened.all('attach_request')).toHaveLength(0);
    await claimOk(await signedIn(), opened.nonce);
  });

  it('from another origin or with no Origin: refused before anything is read, with a session and all', async () => {
    await start();
    const opened = await page();
    const browser = await signedIn();
    for (const origin of ['https://evil.example', 'http://relay.test', 'null', null]) {
      const refused = await browser.claim(opened.nonce, { origin });
      expect(refused.status, String(origin)).toBe(403);
      expect(refused.data.error).toBe('forbidden');
    }
    // A form post, which a cross-site page can send without asking, is not JSON.
    const form = await browser.request('/pair/claim', {
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      body: `nonce=${opened.nonce}`,
    });
    expect(form.status).toBe(415);
    await opened.sync();
    expect(opened.all('attach_request')).toHaveLength(0);
    await claimOk(browser, opened.nonce);
  });

  it('a signed-in account that is not a member is refused at claim, and its nonce survives', async () => {
    await start();
    const opened = await page();
    const browser = await signedIn(STRANGER);
    expect((await browser.preview(opened.nonce)).data.account).toEqual({
      signedIn: true,
      member: false,
    });
    expect(await browser.claim(opened.nonce)).toMatchObject({
      status: 403,
      data: { error: 'not_allowed' },
    });
    await opened.sync();
    expect(opened.all('attach_request')).toHaveLength(0);
    expect(opened.all('pairing')).toHaveLength(0);
    // On /mcp the same account meets the same mapping: a plain 403.
    const token = await provider.token({ sub: STRANGER, aud: PUBLIC_MCP_URL });
    const mcp = await rawRequest(current().url, '/mcp', {
      method: 'POST',
      host: new URL(PUBLIC_ORIGIN).host,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(mcp.status).toBe(403);
    // The stranger's sign-in left no trace of who they are at the provider.
    expect(lines.join('\n')).not.toContain(STRANGER);
    await claimOk(await signedIn(), opened.nonce);
  });

  it("reads back only the claimant's own claim, from the /pair page, while signed in", async () => {
    await start();
    const opened = await page();
    const alice = await signedIn();
    const bob = await signedIn('sub-bob');
    const claim = await claimOk(alice, opened.nonce);
    expect(await bob.status(claim)).toMatchObject({
      status: 404,
      data: { error: 'unknown_claim' },
    });
    expect(await bob.status('qc_0000000000')).toMatchObject({
      status: 404,
      data: { error: 'unknown_claim' },
    });
    expect((await alice.status(claim, { withoutCookies: true })).status).toBe(401);
    expect((await alice.status(claim, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await alice.status(claim)).data).toEqual({ status: 'pending' });
  });

  it('a session lasts its lifetime and no longer', async () => {
    await start({ timings: { pairSessionMs: 1000 } });
    const opened = await page();
    const browser = await signedIn();
    const cookie = browser.setCookies.find(
      (set) => set.name === SESSION_COOKIE && set.value !== '',
    );
    expect(cookie?.attributes.get('max-age')).toBe('1');
    expect((await browser.preview(opened.nonce)).data.account).toMatchObject({ signedIn: true });
    await delay(1100);
    expect((await browser.preview(opened.nonce)).data.account).toEqual({ signedIn: false });
    expect((await browser.claim(opened.nonce)).status).toBe(401);
  });

  it('holds a bounded number of sessions, ending strangers before members', async () => {
    await start({ limits: { pairSessions: 2 } });
    const opened = await page();
    const alice = await signedIn();
    const first = await signedIn(STRANGER);
    const second = await signedIn('sub-another-stranger');
    expect((await first.preview(opened.nonce)).data.account).toEqual({ signedIn: false });
    expect((await second.preview(opened.nonce)).data.account).toMatchObject({ signedIn: true });
    expect((await alice.preview(opened.nonce)).data.account).toMatchObject({ member: true });
  });
});

describe('sign-in at /pair', () => {
  it("fails closed without the sign-in this browser started, with another sign-in's state, or on the provider's no", async () => {
    await start();
    const browser = phone();
    // No sign-in in progress here: nothing is sent to the provider at all.
    const stray = await browser.request('/pair/callback?code=abc&state=def');
    expect(stray.status).toBe(303);
    expect(stray.headers.get('location')).toBe('/pair?signin=failed');
    expect(provider.codeGrants).toHaveLength(0);

    // A sign-in this browser started, answered with another sign-in's state.
    const login = await browser.request('/pair/login');
    const authorize = new URL(login.headers.get('location') ?? '');
    authorize.searchParams.set('state', 'S'.repeat(43));
    const atProvider = await fetch(authorize, { redirect: 'manual' });
    const back = new URL(atProvider.headers.get('location') ?? '');
    const mismatched = await browser.request(`${back.pathname}${back.search}`);
    expect(mismatched.headers.get('location')).toBe('/pair?signin=failed');
    expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
    expect(browser.cookies.has(LOGIN_COOKIE)).toBe(false);

    // The provider saying no.
    await browser.request('/pair/login');
    const refused = await browser.request('/pair/callback?error=access_denied');
    expect(refused.headers.get('location')).toBe('/pair?signin=failed');
    expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
    const failures = events().filter((event) => event.msg === 'pair sign-in failed');
    expect(failures.length).toBeGreaterThanOrEqual(2);
  });
});

describe('pairing limits on /pair (S3, ADR 0016)', () => {
  it('count claims per user with pair_page, never per address, and leave an unclaimed nonce alone', async () => {
    await start({ rateLimits: { pairAttemptsPerUser: 2 } });
    const opened = await page();
    const alice = await signedIn();
    expect((await alice.claim('AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404);
    const { client } = await claudeAs(MOCK_SUBJECT);
    expect(
      textOf(await client.callTool({ name: 'pair_page', arguments: { code: 'ZZZZZ-ZZZZZ' } })),
    ).toMatch(/^pairing_expired/);
    expect(await alice.claim(opened.nonce)).toMatchObject({
      status: 429,
      data: { error: 'rate_limited' },
    });
    // Bob comes through the same tunnel, so from the same address, and is not held back.
    const bob = await signedIn('sub-bob');
    await claimOk(bob, opened.nonce);
  });

  it('bound previews per nonce', async () => {
    await start({ rateLimits: { pairPreviewsPerNonce: 3 } });
    const opened = await page();
    const browser = phone();
    for (let i = 0; i < 3; i += 1) expect((await browser.preview(opened.nonce)).status).toBe(200);
    const limited = await browser.preview(opened.nonce);
    expect(limited).toMatchObject({ status: 429, data: { error: 'rate_limited' } });
    expect(limited.headers.get('retry-after')).toBe('60');
  });
});

describe('secrets and the log (S11)', () => {
  it('no nonce, code, cookie, sign-in value or token reaches any log line, wherever a URL carried it', async () => {
    // With the spike flag on, so its milestones and timings are scanned too.
    await start({ spike: true });
    const opened = await page();
    const browser = phone();
    const firstNonce = opened.nonce;
    await browser.preview(firstNonce);
    const { authorize } = await browser.signIn();
    const claim = await claimOk(browser, firstNonce);
    const request = await opened.next('attach_request');
    opened.send({
      t: 'attach_decision',
      requestId: request.requestId,
      allow: true,
      role: 'driver',
    });
    await settledStatus(browser, claim);
    const { client, token } = await claudeAs(MOCK_SUBJECT);
    await client.callTool({
      name: 'call_page_tool',
      arguments: { page: opened.pageId, tool: 'get_view', arguments: {} },
    });
    // Secrets where they never belong: in paths and queries, which the relay logs by route only.
    const live = opened.nonce;
    await browser.request(`/pair?nonce=${live}`);
    await browser.request(`/pair/${live}`);
    await browser.request(`/pair/callback?code=${live}&state=${live}`);
    await browser.request(`/mcp?nonce=${live}`, { method: 'POST', body: '{}' });
    await browser.preview(`${live}!`);
    await phone().claim(live);

    const callbackHop = browser.requested.find((url) => url.includes('/pair/callback?code='));
    const providerCode = new URL(callbackHop ?? 'https://x.invalid').searchParams.get('code') ?? '';
    const loginValue =
      browser.setCookies.find((cookie) => cookie.name === LOGIN_COOKIE && cookie.value !== '')
        ?.value ?? '';
    const sessionValue = browser.cookies.get(SESSION_COOKIE) ?? '';
    const nonces: { code: string; url?: string | undefined }[] = pages.flatMap((each) =>
      each.received.flatMap((frame) =>
        frame.t === 'welcome' ? [frame.pairing] : frame.t === 'pairing' ? [frame] : [],
      ),
    );
    const secrets = [
      ...nonces.flatMap((pairing) => [
        new URL(pairing.url ?? 'https://x.invalid/#').hash.slice(1),
        pairing.code,
        pairing.code.replace('-', ''),
      ]),
      providerCode,
      loginValue,
      ...loginValue.split('.').slice(0, 3),
      authorize.searchParams.get('code_challenge') ?? '',
      sessionValue,
      PAIR_CLIENT.clientSecret,
      token,
      ...provider.issuedTokens,
    ].filter((secret) => secret.length > 0);
    expect(secrets.length).toBeGreaterThan(12);
    await current().close();
    const all = lines.join('\n');
    for (const secret of secrets) expect(all, 'a secret in the log').not.toContain(secret);
    // The events are there, so the absence above means something.
    for (const msg of [
      'spike: pairing milestone',
      'spike: call timing',
      'pair sign-in started',
      'pair signed in',
      'pair claim accepted',
      'attach request sent',
      'pair sign-in refused: no sign-in in progress in this browser',
      'mcp request refused: not authenticated',
      'pair claim refused: not signed in',
    ]) {
      expect(all, msg).toContain(msg);
    }
  });
});

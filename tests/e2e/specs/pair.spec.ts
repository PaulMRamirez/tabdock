import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, test } from '@playwright/test';
import { bodyOf } from '@tabdock/relay/test/results';
import { tunnelFetch } from '@tabdock/relay/test/tunnel';
import {
  MOCK_SUBJECT,
  playTunnel,
  PUBLIC_MCP_URL,
  PUBLIC_ORIGIN,
  startPublicTabdock,
  type PublicTabdock,
} from '../src/public-harness.ts';
import {
  clickInWidget,
  dockState,
  waitForDock,
  waitForLink,
  widgetVisible,
} from '../src/tabdock-harness.ts';

// M3's QR flow in two real browsers: the operator's demo page on the laptop
// draws the pairing URL as a QR code, and a phone-sized browser opens that
// URL, signs in at the stand-in provider, joins with a tap, and sees the
// approval the operator gives with a real click in the widget. The phone
// reaches the relay through the stand-in tunnel in src/public-harness.ts.

let tabdock: PublicTabdock;
let relayLogs: string[];

test.beforeEach(async () => {
  relayLogs = [];
  tabdock = await startPublicTabdock({
    logSink: (line) => {
      relayLogs.push(line);
    },
    // The spike's milestones time this scan to its first call (A3.3).
    spike: true,
  });
});
test.afterEach(async () => {
  await tabdock.close();
});

test('a phone opens the QR code URL, signs in, joins, and the operator approves it in the widget', async ({
  page,
  browser,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(tabdock.pageUrl);
  const { pageId, code } = await waitForLink(page);
  // What the QR code in the widget encodes.
  const pairingUrl = await waitForDock(page, (state) => state.pairing?.url);
  expect(pairingUrl).toMatch(/^https:\/\/relay\.test\/pair#[A-Za-z0-9_-]{22}$/);
  await expect.poll(() => widgetVisible(page, 'pairing-qr')).toBe(true);
  const nonce = new URL(pairingUrl).hash.slice(1);

  const phoneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  try {
    const requested: string[] = [];
    await playTunnel(phoneContext, tabdock, requested);
    const phone = await phoneContext.newPage();
    const phoneErrors: string[] = [];
    phone.on('console', (message) => {
      if (message.type() === 'error') phoneErrors.push(message.text());
    });
    phone.on('pageerror', (error) => phoneErrors.push(error.message));

    // Scanned: the nonce leaves the address bar at once, and the page shows what it would join.
    await phone.goto(pairingUrl);
    await expect.poll(() => phone.url()).toBe(`${PUBLIC_ORIGIN}/pair`);
    await expect(phone.locator('#code')).toHaveText(code);
    await expect(phone.locator('#origin')).toHaveText(new URL(tabdock.demo.url).origin);
    await expect(phone.locator('#title')).toHaveText('Tabdock demo board');
    await expect(phone.locator('#message')).toHaveText('Sign in to join this page.');
    await expect(phone.locator('#join')).toBeHidden();

    // Sign in at the provider and come back: signed in, and still nothing claimed.
    await phone.locator('#signin').tap();
    await expect(phone.locator('#account')).toHaveText('Signed in as Alice.');
    expect(phone.url()).toBe(`${PUBLIC_ORIGIN}/pair`);
    await expect(phone.locator('#join')).toBeVisible();
    await expect(phone.locator('#code')).toHaveText(code);
    expect((await dockState(page))?.pendingRequests).toEqual([]);
    const cookies = await phoneContext.cookies(PUBLIC_ORIGIN);
    expect(cookies.map((cookie) => cookie.name)).toEqual(['__Host-tabdock-pair']);
    expect(cookies[0]).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });

    // Join, and the operator approves with a real click on the prompt.
    await phone.locator('#join').tap();
    const request = await waitForDock(page, (state) =>
      state.pendingRequests.find((pending) => pending.via === 'qr'),
    );
    expect(request.user).toEqual({ userId: 'alice', displayName: 'Alice' });
    await expect(phone.locator('#message')).toContainText('Waiting for');
    await clickInWidget(page, { action: 'approve-driver', requestId: request.requestId });
    await expect(phone.locator('#message')).toHaveText(/^Approved as driver\./);
    // The widget moved on to a new code and QR code.
    await waitForDock(page, (state) => state.pairing !== null && state.pairing.code !== code);

    // The nonce went nowhere but the fragment and the page's own POST bodies.
    expect(requested.length).toBeGreaterThan(5);
    for (const url of requested) expect(url).not.toContain(nonce);
    expect(relayLogs.join('\n')).not.toContain(nonce);
    expect(phoneErrors).toEqual([]);

    // Claude on the phone, signed in as the same person, finds the page and calls it.
    const token = await tabdock.provider.token({ sub: MOCK_SUBJECT, aud: PUBLIC_MCP_URL });
    const claude = new Client({ name: 'claude-phone', version: '1.0.0' });
    await claude.connect(
      new StreamableHTTPClientTransport(new URL(PUBLIC_MCP_URL), {
        authProvider: { token: () => Promise.resolve(token) },
        fetch: tunnelFetch(tabdock.relay.url),
      }),
    );
    try {
      const listed = await claude.callTool({ name: 'list_pages', arguments: {} });
      expect(bodyOf(listed)).toMatchObject({ pages: [{ page: pageId, role: 'driver' }] });
      const called = await claude.callTool({
        name: 'call_page_tool',
        arguments: { page: pageId, tool: 'get_view', arguments: {} },
      });
      expect(called.isError ?? false).toBe(false);
    } finally {
      await claude.close();
    }
    const milestones = relayLogs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.msg === 'spike: pairing milestone');
    const first = milestones.filter((entry) => entry.stage === 'first_call');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ pageId, userId: 'alice', via: 'qr', outcome: 'ok' });
    expect(typeof first[0]?.sinceScannedMs).toBe('number');
    // One trace from the widget's ticket to the first call, and never the nonce or the code.
    const trace = first[0]?.trace;
    expect(milestones.filter((entry) => entry.trace === trace).map((entry) => entry.stage)).toEqual(
      ['issued', 'scanned', 'claimed', 'approved', 'first_call'],
    );
    const logged = relayLogs.join('\n');
    expect(logged).not.toContain(nonce);
    expect(logged).not.toContain(code);
  } finally {
    await phoneContext.close();
  }
  expect(pageErrors).toEqual([]);
});

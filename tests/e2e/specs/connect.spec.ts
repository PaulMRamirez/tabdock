import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import {
  type BrowserContext,
  expect,
  type Page,
  test,
  type WebSocketRoute,
} from '@playwright/test';
import { buildDemo, type DemoServer, startDemoServer } from '@tabdock/demo/server';
import {
  ATTACH_REQUEST_TTL_MS,
  encodeFrame,
  MAX_DESCRIPTION_CHARS,
  MAX_FRAME_BYTES,
  MAX_RESULT_CHARS,
  parsePageFrame,
  PING_INTERVAL_MS,
  RESUME_WINDOW_MS,
} from '@tabdock/protocol';
import { widgetText, widgetVisible } from '../src/tabdock-harness.ts';

// The demo dials only a relay its visitor chose (ADR 0029): a ?relay link
// shows a "Connect to <host>" bar that dials after a trusted click alone,
// remembered for the tab and that relay URL; without ?relay the board offers
// a Connect form; and the static build, as Pages serves it, runs under its
// meta policy with no ?e2e bypass. Playwright's routeWebSocket stands in for
// every relay, so nothing here leaves the machine.

/** Never dialled: routeWebSocket answers in its place. */
const FAKE_RELAY = 'ws://127.0.0.1:9/page';
const OTHER_RELAY = 'ws://127.0.0.1:10/page';
/** For the https copy, a wss: relay off loopback, as a published board would use. */
const HOSTED_RELAY = 'wss://relay.example/page';
const PAIRING_CODE = 'ABCDE-FGHJK';
/** Long enough for a dial the page would make at once to have been made. */
const SETTLE_MS = 750;

let demo: DemoServer;
test.beforeAll(async () => {
  demo = await startDemoServer();
});
test.afterAll(async () => {
  await demo.close();
});

interface Dialled {
  urls: string[];
}

/** Answers every page socket in the context as a relay would, and counts the dials. */
async function fakeRelays(context: BrowserContext): Promise<Dialled> {
  const dialled: Dialled = { urls: [] };
  await context.routeWebSocket(/\/page$/, (ws: WebSocketRoute) => {
    dialled.urls.push(ws.url());
    ws.onMessage((message) => {
      const parsed = parsePageFrame(typeof message === 'string' ? message : message.toString());
      if (parsed.kind !== 'ok' || parsed.frame.t !== 'hello') return;
      ws.send(
        encodeFrame({
          t: 'welcome',
          pageId: 'page-1',
          resumeToken: 'resume-1',
          resumed: false,
          pairing: {
            code: PAIRING_CODE,
            // Shaped like the relay's, so the widget draws its QR code: /pair# and a 22-character nonce.
            url: 'https://relay.example/pair#AAAAAAAAAAAAAAAAAAAAAA',
            expiresAt: Date.now() + 120_000,
          },
          roster: [],
          limits: {
            maxFrameBytes: MAX_FRAME_BYTES,
            maxResultChars: MAX_RESULT_CHARS,
            maxDescriptionChars: MAX_DESCRIPTION_CHARS,
            pingIntervalMs: PING_INTERVAL_MS,
            idleTimeoutMs: 600_000,
            resumeWindowMs: RESUME_WINDOW_MS,
            attachRequestTtlMs: ATTACH_REQUEST_TTL_MS,
          },
        }),
      );
    });
  });
  return dialled;
}

/** The board without ?e2e, which every visitor gets. */
function boardUrl(relay: string | null, extra: Record<string, string> = {}): string {
  const url = new URL(demo.url);
  if (relay !== null) url.searchParams.set('relay', relay);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  return url.href;
}

async function openBoard(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForSelector('html[data-tools="ready"]');
}

test('a ?relay link waits behind a Connect bar until a trusted click, and scripted clicks never dial', async ({
  page,
  context,
}) => {
  const dialled = await fakeRelays(context);
  await openBoard(page, boardUrl(FAKE_RELAY));
  const button = page.getByRole('button', { name: 'Connect to 127.0.0.1:9' });
  await expect(button).toBeVisible();
  await expect(page.locator('[data-role="status"]')).toHaveText(
    /Tabdock relay 127\.0\.0\.1:9: waiting for you to connect/,
  );
  await expect(page.locator('html')).toHaveAttribute('data-link', 'waiting');
  expect(await page.locator('tabdock-dock').count()).toBe(0);

  // A script on the page, or a crafted link's helper, cannot click for the visitor.
  await page.evaluate(() => {
    const target = document.querySelector<HTMLButtonElement>('[data-action="connect"]');
    target?.click();
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await button.dispatchEvent('click');
  await page.waitForTimeout(SETTLE_MS);
  expect(dialled.urls).toEqual([]);
  await expect(button).toBeVisible();
  expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);

  await button.click();
  await expect.poll(() => dialled.urls).toEqual([FAKE_RELAY]);
  await expect(page.locator('[data-role="connect-bar"]')).toHaveCount(0);
  await expect(page.locator('[data-role="status"]')).toHaveText(
    /Tabdock relay 127\.0\.0\.1:9: linked/,
  );
  await expect.poll(() => widgetText(page, 'pairing-code')).toContain(PAIRING_CODE);
  // The dev bundle offers the ?e2e hook, but only with ?e2e.
  expect(await page.evaluate(() => window.__tabdockDock === undefined)).toBe(true);
});

test('the choice is remembered for this tab and this relay URL alone', async ({
  page,
  context,
}) => {
  const dialled = await fakeRelays(context);
  await openBoard(page, boardUrl(FAKE_RELAY));
  await page.getByRole('button', { name: 'Connect to 127.0.0.1:9' }).click();
  await expect.poll(() => dialled.urls.length).toBe(1);
  expect(await page.evaluate(() => Object.entries(sessionStorage))).toContainEqual([
    `tabdock-demo:connect:${FAKE_RELAY}`,
    '1',
  ]);

  // A reload reconnects without a second click.
  await page.reload();
  await page.waitForSelector('html[data-tools="ready"]');
  await expect.poll(() => dialled.urls.length).toBe(2);
  await expect(page.locator('[data-role="connect-bar"]')).toHaveCount(0);

  // Another relay in the same tab asks again.
  await openBoard(page, boardUrl(OTHER_RELAY));
  await expect(page.getByRole('button', { name: 'Connect to 127.0.0.1:10' })).toBeVisible();
  await page.waitForTimeout(SETTLE_MS);
  expect(dialled.urls).toHaveLength(2);

  // Another tab knows nothing of this one's choice.
  const other = await context.newPage();
  await openBoard(other, boardUrl(FAKE_RELAY));
  await expect(other.getByRole('button', { name: 'Connect to 127.0.0.1:9' })).toBeVisible();
  await other.waitForTimeout(SETTLE_MS);
  expect(dialled.urls).toHaveLength(2);
});

test('without ?relay the board offers a Connect form, checked by the same rules, that keeps the other parameters', async ({
  page,
  context,
}) => {
  const dialled = await fakeRelays(context);
  await openBoard(page, boardUrl(null, { invites: 'all' }));
  const form = page.locator('form[data-role="connect-form"]');
  const input = form.getByLabel('Tabdock relay page URL');
  await expect(input).toBeVisible();

  for (const [typed, message] of [
    [`${FAKE_RELAY}?token=abc`, 'The relay URL must not carry a query or a fragment'],
    [`${FAKE_RELAY}#x`, 'The relay URL must not carry a query or a fragment'],
    ['https://relay.example/page', 'The relay URL must be a ws: or wss: URL'],
    ['not a url', 'The relay URL is not a URL'],
  ] as const) {
    await input.fill(typed);
    await input.press('Enter');
    await expect(form.locator('[data-role="connect-error"]')).toHaveText(message);
  }
  expect(new URL(page.url()).searchParams.has('relay')).toBe(false);

  // A scripted submit or click of a good URL does nothing; requestSubmit's submit event is even trusted.
  await input.fill(FAKE_RELAY);
  await page.evaluate(() => {
    const scripted = document.querySelector<HTMLFormElement>('form[data-role="connect-form"]');
    scripted?.requestSubmit();
    scripted?.querySelector('button')?.click();
  });
  await page.waitForTimeout(SETTLE_MS);
  expect(new URL(page.url()).searchParams.has('relay')).toBe(false);
  expect(dialled.urls).toEqual([]);

  // A person's own submit records the choice and goes to ?relay=, which then dials without a second click.
  await Promise.all([page.waitForURL(/relay=/), input.press('Enter')]);
  const landed = new URL(page.url());
  expect(landed.searchParams.get('relay')).toBe(FAKE_RELAY);
  expect(landed.searchParams.get('invites')).toBe('all');
  await page.waitForSelector('html[data-tools="ready"]');
  await expect.poll(() => dialled.urls).toEqual([FAKE_RELAY]);
  await expect(page.locator('[data-role="connect-bar"]')).toHaveCount(0);
  await expect(page.locator('form[data-role="connect-form"]')).toHaveCount(0);
});

test('a ?relay with a query or fragment is refused before any bar, and the form is offered instead', async ({
  page,
  context,
}) => {
  const dialled = await fakeRelays(context);
  await openBoard(page, boardUrl(`${FAKE_RELAY}?token=abc`));
  await expect(page.locator('[data-role="status"]')).toHaveText(
    /not linked: \?relay must not carry a query or a fragment/,
  );
  await expect(page.locator('[data-role="connect-bar"]')).toHaveCount(0);
  await expect(page.locator('form[data-role="connect-form"]')).toBeVisible();
  await page.waitForTimeout(SETTLE_MS);
  expect(dialled.urls).toEqual([]);
});

test('inside a frame the board offers neither bar nor form, so a framing site cannot dress up a click', async ({
  page,
  context,
}) => {
  const dialled = await fakeRelays(context);
  const framer = new URL('/framer', demo.url).href;
  await page.route(framer, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><iframe src="${boardUrl(FAKE_RELAY)}"></iframe><iframe src="${boardUrl(null)}"></iframe>`,
    }),
  );
  await page.goto(framer);
  const linked = page.locator('iframe').nth(0).contentFrame();
  const bare = page.locator('iframe').nth(1).contentFrame();
  await expect(linked.locator('[data-role="status"]')).toHaveText(
    /not linked: this board does not link to a relay inside a frame/,
  );
  await expect(bare.locator('html')).toHaveAttribute('data-tools', 'ready');
  for (const frame of [linked, bare]) {
    await expect(frame.locator('[data-role="connect-bar"]')).toHaveCount(0);
    await expect(frame.locator('form[data-role="connect-form"]')).toHaveCount(0);
  }
  await page.waitForTimeout(SETTLE_MS);
  expect(dialled.urls).toEqual([]);
});

test.describe("the demo's static build, as Pages serves it", () => {
  let outDir = '';
  const TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.map': 'application/json',
  };

  test.beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'tabdock-static-demo-'));
    await buildDemo({ outDir });
  });
  test.afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  /** Serves the static build at https://board.example<base>, as a static host would: no headers of ours. */
  async function serveStatic(page: Page, base: string): Promise<string[]> {
    const policyErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && message.text().includes('Content Security Policy')) {
        policyErrors.push(message.text());
      }
    });
    await page.route('https://board.example/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith(base)) {
        await route.fulfill({ status: 404, body: 'Not found' });
        return;
      }
      const name = path.slice(base.length) || 'index.html';
      if (!/^[\w.-]+$/.test(name)) {
        await route.fulfill({ status: 404, body: 'Not found' });
        return;
      }
      try {
        const body = readFileSync(join(outDir, name));
        await route.fulfill({
          status: 200,
          contentType: TYPES[extname(name)] ?? 'application/octet-stream',
          body,
        });
      } catch {
        await route.fulfill({ status: 404, body: 'Not found' });
      }
    });
    return policyErrors;
  }

  test('ignores ?e2e, waits for a trusted click, and links and draws its widget with no policy violation', async ({
    page,
    context,
  }) => {
    const dialled = await fakeRelays(context);
    const policyErrors = await serveStatic(page, '/');
    const url = new URL('https://board.example/');
    url.searchParams.set('relay', HOSTED_RELAY);
    url.searchParams.set('e2e', '');
    await page.goto(url.href);
    await page.waitForSelector('html[data-tools="ready"]');
    const button = page.getByRole('button', { name: 'Connect to relay.example' });
    await expect(button).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);
    expect(dialled.urls).toEqual([]);
    expect(await page.evaluate(() => window.__tabdockDock === undefined)).toBe(true);

    await button.click();
    await expect.poll(() => dialled.urls).toEqual([HOSTED_RELAY]);
    await expect.poll(() => widgetText(page, 'pairing-code')).toContain(PAIRING_CODE);
    await expect.poll(() => widgetVisible(page, 'pairing-qr')).toBe(true);
    expect(await page.evaluate(() => window.__tabdockDock === undefined)).toBe(true);
    expect(policyErrors).toEqual([]);
  });

  test('runs ?busy in its worker and offers the form, still with no violation', async ({
    page,
  }) => {
    const policyErrors = await serveStatic(page, '/');
    await page.goto('https://board.example/?busy=30');
    await page.waitForSelector('html[data-tools="ready"]');
    await expect.poll(() => page.workers().length).toBe(1);
    await expect(page.getByLabel('Tabdock relay page URL')).toBeVisible();
    expect(policyErrors).toEqual([]);
  });

  test('enforces its policy: an inline script is refused', async ({ page }) => {
    const policyErrors = await serveStatic(page, '/');
    await page.goto('https://board.example/');
    await page.waitForSelector('html[data-tools="ready"]');
    const ran = await page.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = 'document.documentElement.dataset.inline = "ran";';
      document.head.append(script);
      return document.documentElement.dataset.inline ?? null;
    });
    expect(ran).toBeNull();
    await expect.poll(() => policyErrors.length).toBeGreaterThan(0);
  });

  test('loads its script by a relative path, so a copy under a subpath works', async ({ page }) => {
    await serveStatic(page, '/tabdock/');
    await page.goto('https://board.example/tabdock/');
    await page.waitForSelector('html[data-tools="ready"]');
    await expect(page.locator('[data-role="status"]')).toHaveText(/6 tools registered/);
  });
});

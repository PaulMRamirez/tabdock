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
/** What the bar and the status area say of ?confirm=client&invites=all (policy.ts). */
const POLICY_NOTES =
  'members you approve confirm clear_board in their own MCP client, not on this board; the board offers Can control invites and a second driver seat.';
const BAR_POLICY_LINE = `If you connect, this link also sets the board's policy: ${POLICY_NOTES}`;
const POLICY_LINE = `This board's policy, from its link: ${POLICY_NOTES}`;
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
  // The board as pnpm dev serves it offers no ?e2e hook at all.
  expect(await page.evaluate(() => window.__tabdockDock === undefined)).toBe(true);
});

test("a crafted link's ?e2e never skips the click: pnpm dev's board has no hook, and a board that has one honours only its server's key", async ({
  page,
  context,
}) => {
  // A5.6: any site could send a tab to the board pnpm dev serves at its
  // predictable port with ?e2e and a relay and policy of its choosing.
  const dialled = await fakeRelays(context);
  const waiting = async (): Promise<void> => {
    await expect(page.locator('[data-role="connect-bar"]')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-link', 'waiting');
    await page.waitForTimeout(SETTLE_MS);
    expect(dialled.urls).toEqual([]);
    expect(await page.evaluate(() => window.__tabdockDock === undefined)).toBe(true);
  };
  for (const e2e of ['', 'x'.repeat(22)]) {
    await openBoard(page, boardUrl(FAKE_RELAY, { e2e, confirm: 'client', invites: 'all' }));
    await waiting();
  }
  const hooked = await startDemoServer({ e2eHook: true });
  try {
    const key = hooked.e2eKey ?? '';
    const at = (e2e: string): string => {
      const url = new URL(hooked.url);
      url.searchParams.set('relay', FAKE_RELAY);
      url.searchParams.set('e2e', e2e);
      return url.href;
    };
    for (const wrong of ['', 'x'.repeat(22), `${key}x`, key.slice(1)]) {
      await openBoard(page, at(wrong));
      await waiting();
    }
    // The yardstick: its own key skips the click, as the specs and demo scripts use it.
    await openBoard(page, at(key));
    await expect.poll(() => dialled.urls).toEqual([FAKE_RELAY]);
    expect(await page.evaluate(() => window.__tabdockDock !== undefined)).toBe(true);
  } finally {
    await hooked.close();
  }
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

test('without ?relay the board offers a Connect form, checked by the same rules, that keeps the parameters that set no policy', async ({
  page,
  context,
}) => {
  const dialled = await fakeRelays(context);
  // A link to the form may name a looser policy too, which the form shows unticked.
  await openBoard(page, boardUrl(null, { invites: 'all', confirm: 'client', lang: 'en' }));
  const form = page.locator('form[data-role="connect-form"]');
  const input = form.getByLabel('Tabdock relay page URL');
  await expect(input).toBeVisible();
  await expect(form.locator('input[data-option="confirm"]')).not.toBeChecked();
  await expect(form.locator('input[data-option="invites"]')).not.toBeChecked();

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

  // A person's own submit records the choice and goes to ?relay=, which then
  // dials without a second click, under the default policy, as nothing was ticked.
  await Promise.all([page.waitForURL(/relay=/), input.press('Enter')]);
  const landed = new URL(page.url());
  expect(landed.searchParams.get('relay')).toBe(FAKE_RELAY);
  expect(landed.searchParams.get('lang')).toBe('en');
  expect(landed.searchParams.has('invites')).toBe(false);
  expect(landed.searchParams.has('confirm')).toBe(false);
  await page.waitForSelector('html[data-tools="ready"]');
  await expect.poll(() => dialled.urls).toEqual([FAKE_RELAY]);
  await expect(page.locator('[data-role="connect-bar"]')).toHaveCount(0);
  await expect(page.locator('form[data-role="connect-form"]')).toHaveCount(0);
  await expect(page.locator('[data-role="policy"]')).toHaveCount(0);
});

test('the Connect form sets ?confirm and ?invites only as its visitor ticks them, and remembers the choice with them', async ({
  page,
  context,
}) => {
  const dialled = await fakeRelays(context);
  await openBoard(page, boardUrl(null));
  const form = page.locator('form[data-role="connect-form"]');
  await form.locator('input[data-option="confirm"]').check();
  await form.locator('input[data-option="invites"]').check();
  const input = form.getByLabel('Tabdock relay page URL');
  await input.fill(FAKE_RELAY);
  await Promise.all([page.waitForURL(/relay=/), input.press('Enter')]);
  const landed = new URL(page.url());
  expect(landed.searchParams.get('confirm')).toBe('client');
  expect(landed.searchParams.get('invites')).toBe('all');
  await page.waitForSelector('html[data-tools="ready"]');
  await expect.poll(() => dialled.urls).toEqual([FAKE_RELAY]);
  await expect(page.locator('[data-role="connect-bar"]')).toHaveCount(0);
  await expect(page.locator('[data-role="policy"]')).toHaveText(POLICY_LINE);
});

test('a link that changes the page policy asks again, and the bar and the status name each change', async ({
  page,
  context,
}) => {
  const dialled = await fakeRelays(context);
  await openBoard(page, boardUrl(FAKE_RELAY));
  await page.getByRole('button', { name: 'Connect to 127.0.0.1:9' }).click();
  await expect.poll(() => dialled.urls.length).toBe(1);
  await expect(page.locator('[data-role="policy"]')).toHaveCount(0);

  // Any page that can navigate this tab can link it to the relay it chose
  // with a looser policy; that is a new choice, so it waits for a click.
  await openBoard(page, boardUrl(FAKE_RELAY, { confirm: 'client', invites: 'all' }));
  const bar = page.locator('[data-role="connect-bar"]');
  await expect(bar).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-link', 'waiting');
  await expect(bar.locator('[data-role="connect-policy"]')).toHaveText(BAR_POLICY_LINE);
  await page.waitForTimeout(SETTLE_MS);
  expect(dialled.urls).toHaveLength(1);

  // Chosen with that policy in view, it dials, the status area names the
  // policy, and a reload under the same policy reconnects without a click.
  await bar.getByRole('button', { name: 'Connect to 127.0.0.1:9' }).click();
  await expect.poll(() => dialled.urls.length).toBe(2);
  await expect(page.locator('[data-role="policy"]')).toHaveText(POLICY_LINE);
  await page.reload();
  await page.waitForSelector('html[data-tools="ready"]');
  await expect.poll(() => dialled.urls.length).toBe(3);
  await expect(page.locator('[data-role="connect-bar"]')).toHaveCount(0);
  await expect(page.locator('[data-role="policy"]')).toHaveText(POLICY_LINE);

  // One parameter fewer is another policy again, and so is a narrower one.
  for (const extra of [{ confirm: 'client' }, { invites: 'off' }]) {
    await openBoard(page, boardUrl(FAKE_RELAY, extra));
    await expect(bar).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);
    expect(dialled.urls).toHaveLength(3);
  }
  await expect(bar.locator('[data-role="connect-policy"]')).toHaveText(
    "If you connect, this link also sets the board's policy: the board offers no invites.",
  );
});

test('the Connect bar takes a click only once it has held still for half a second in a visible, focused tab', async ({
  page,
  context,
}) => {
  const dialled = await fakeRelays(context);
  // Once the bar is up the page's timers stand still until the test moves
  // them, so "too soon" is exact; the board needs them running to start.
  await page.clock.install();
  await openBoard(page, boardUrl(FAKE_RELAY));
  const button = page.locator('[data-action="connect"]');
  await expect(button).toBeVisible();
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 50);
  // Measured before the clock stopped, so this proves the first click too soon.
  await expect(button).toHaveAttribute('data-armed', 'false');
  /** The button's centre now, as a resize moves it. */
  const centre = async (): Promise<{ x: number; y: number }> => {
    const box = await button.boundingBox();
    if (!box) throw new Error('the Connect button has no box');
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const clickBar = async (): Promise<void> => {
    const { x, y } = await centre();
    await page.mouse.click(x, y);
  };
  const refused = async (why: string): Promise<void> => {
    await page.waitForTimeout(100);
    expect(dialled.urls, why).toEqual([]);
    await expect(button, why).toBeVisible();
    await expect(button, why).toHaveAttribute('data-armed', 'false');
  };

  // A click the moment the bar appears, as a double-click's second half would land.
  await clickBar();
  await refused('a click as the bar appears');
  await page.clock.runFor(400);
  await expect(button).toHaveAttribute('data-armed', 'false');
  await clickBar();
  await refused('a click 400 ms after the last one, which started the wait again');
  await page.clock.runFor(700);
  await expect(button).toHaveAttribute('data-armed', 'true');

  // The window regaining focus is a fresh sight of the bar, as when a popup
  // closed on the first half of a double-click; so are pageshow and a resize.
  // Headless Chromium fires no focus event of its own, so the test sends them.
  const disturbances: [string, () => Promise<unknown>][] = [
    ['focus', () => page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')))],
    [
      'pageshow',
      () => page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow'))),
    ],
    [
      'visibilitychange',
      () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))),
    ],
    ['resize', () => page.setViewportSize({ width: 1000, height: 700 })],
  ];
  for (const [why, disturb] of disturbances) {
    await disturb();
    // The page's clock stands still, so measuring first lets no time count towards arming.
    await clickBar();
    await refused(`a click just after ${why}`);
    await page.clock.runFor(700);
    await expect(button, why).toHaveAttribute('data-armed', 'true');
  }

  // A press that began before the bar armed does not count when it ends after.
  await page.evaluate(() => window.dispatchEvent(new FocusEvent('blur')));
  await expect(button).toHaveAttribute('data-armed', 'false');
  const pressAt = await centre();
  await page.mouse.move(pressAt.x, pressAt.y);
  await page.mouse.down();
  await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')));
  await page.clock.runFor(700);
  await expect(button).toHaveAttribute('data-armed', 'true');
  await page.mouse.up();
  await refused('a press that began while the bar was not armed');

  // A click once it has held still dials.
  await page.clock.runFor(700);
  await expect(button).toHaveAttribute('data-armed', 'true');
  await clickBar();
  await page.clock.resume();
  await expect.poll(() => dialled.urls).toEqual([FAKE_RELAY]);
});

test('a long relay host wraps inside a phone-width page, the end of the host in view', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const host = [
    'relay.example.com',
    'a'.repeat(60),
    'b'.repeat(60),
    'c'.repeat(50),
    'attacker.test',
  ].join('.');
  expect(host.length).toBeGreaterThanOrEqual(200);
  await openBoard(page, boardUrl(`wss://${host}/page`));
  const button = page.locator('[data-action="connect"]');
  await expect(button).toHaveText(`Connect to ${host}`);
  const layout = await page.evaluate(() => {
    const target = document.querySelector('[data-role="connect-host"]');
    const text = target?.firstChild;
    const end = text?.textContent?.lastIndexOf('attacker.test') ?? -1;
    if (!text || end < 0) return null;
    const range = document.createRange();
    range.setStart(text, end);
    range.setEnd(text, end + 'attacker.test'.length);
    const tail = range.getBoundingClientRect();
    const rects = ['[data-action="connect"]', '[data-role="status"]'].map((selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect ? { left: rect.left, right: rect.right } : null;
    });
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      tail: { left: tail.left, right: tail.right, bottom: tail.bottom },
      rects,
    };
  });
  if (!layout) throw new Error('the Connect bar shows no host element holding the host');
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  for (const rect of [...layout.rects, layout.tail]) {
    expect(rect?.left).toBeGreaterThanOrEqual(0);
    expect(rect?.right).toBeLessThanOrEqual(layout.clientWidth);
  }
  expect(layout.tail.bottom).toBeLessThanOrEqual(844);
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

  test('ignores ?mcpb, so a copy under a subpath fetches no script from the root of a host it shares', async ({
    page,
  }) => {
    await serveStatic(page, '/tabdock/');
    const requested: string[] = [];
    page.on('request', (request) => {
      requested.push(new URL(request.url()).pathname);
    });
    await page.goto('https://board.example/tabdock/?mcpb=9444');
    await page.waitForSelector('html[data-tools="ready"]');
    await page.waitForTimeout(SETTLE_MS);
    expect(requested.filter((path) => !path.startsWith('/tabdock/'))).toEqual([]);
    expect(await page.locator('script[src*="webmcp-local-relay"]').count()).toBe(0);
  });

  test('loads its script by a relative path, so a copy under a subpath works', async ({ page }) => {
    await serveStatic(page, '/tabdock/');
    await page.goto('https://board.example/tabdock/');
    await page.waitForSelector('html[data-tools="ready"]');
    await expect(page.locator('[data-role="status"]')).toHaveText(/6 tools registered/);
  });
});

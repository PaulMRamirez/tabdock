import { createHash } from 'node:crypto';
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { encodeQr } from '@tabdock/adapter/qr';
import { startDemoServer, type DemoServer } from '@tabdock/demo/server';
import {
  ATTACH_REQUEST_TTL_MS,
  type AttachmentView,
  encodeFrame,
  type InviteRefusalReason,
  MAX_DESCRIPTION_CHARS,
  MAX_FRAME_BYTES,
  MAX_INVITE_LIFETIME_MS,
  MAX_RESULT_CHARS,
  type PageFrame,
  parsePageFrame,
  PING_INTERVAL_MS,
  type RelayFrame,
  RESUME_WINDOW_MS,
  type Role,
} from '@tabdock/protocol';
import {
  clickInWidget,
  demoPageUrl,
  dockState,
  waitForDock,
  widgetButtonCentre,
  widgetButtonNow,
  widgetItems,
  widgetQrDrawing,
  widgetText,
  widgetVisible,
} from '../src/tabdock-harness.ts';

// M4 workstream B: the widget's invites (ADRs 0016 and 0017) on the real demo
// page, against a scripted relay that offers invites. Playwright's
// routeWebSocket stands in for the relay, so a test plays every frame the page
// sees: it lists each invite the page mints, as a relay with invites on and a
// public URL does, and forwards redemptions with whatever secret it likes.

/** Never dialled: routeWebSocket answers in its place. */
const FAKE_RELAY = 'ws://127.0.0.1:9/page';
const LINK_BASE = 'https://relay.example/i';
/** The widget's ARM_DELAY_MS. */
const ARM_DELAY_MS = 500;
const GUEST = `g_${'1a2b3c4d'.repeat(4)}`;
const OTHER_GUEST = `g_${'5e6f7a8b'.repeat(4)}`;
const ALICE = { userId: 'alice', displayName: 'Alice' };
const SECRET_LINK = /^https:\/\/relay\.example\/i#([A-Za-z0-9_-]{22})$/;

/** What a strict page sends: Trusted Types for every script sink, and no data: images. */
const TRUSTED_TYPES_CSP = "require-trusted-types-for 'script'; img-src 'self'";

// Tall enough that the open form never makes the panel scroll, which would move its boxes.
test.use({ viewport: { width: 1280, height: 1200 } });

let demo: DemoServer;
let pageErrors: string[];
let consoleLines: string[];
/** Reads the CSP violations the page reported, once openWithInviteRelay put the strict policy on it. */
let cspViolations: (() => Promise<string[]>) | null;

test.beforeAll(async () => {
  demo = await startDemoServer({ e2eHook: true });
});
test.afterAll(async () => {
  await demo.close();
});
test.beforeEach(({ page }) => {
  pageErrors = [];
  consoleLines = [];
  cspViolations = null;
  page.on('console', (message) => {
    consoleLines.push(message.text());
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
});
test.afterEach(async () => {
  expect(pageErrors).toEqual([]);
  // The widget's every part, the form, the list and both QR codes, works under the M3 specs' strict CSP.
  if (cspViolations) expect(await cspViolations()).toEqual([]);
});

type Listing = Extract<RelayFrame, { t: 'invites' }>['invites'][number];

interface InviteRelay {
  /** Every frame the page sent, in order. */
  readonly frames: PageFrame[];
  readonly connections: number;
  /** What the relay lists, by invite id. */
  readonly listings: Map<string, Listing>;
  /** When set, the relay refuses every invite_create with this reason instead of listing it. */
  refuse: InviteRefusalReason | null;
  /** While true, the relay closes every new link at once, so the page stays unlinked. */
  hold: boolean;
  send(frame: RelayFrame): void;
  /** The invites frame for what is listed now. */
  list(): void;
  /** Closes the current link from the relay's side; the page reconnects. */
  drop(): void;
}

function member(userId: string, displayName: string, role: Role = 'driver'): AttachmentView {
  return {
    userId,
    displayName,
    kind: 'member',
    role,
    grantedAt: Date.now(),
    lastUsedAt: null,
    expiresAt: null,
    clients: [],
    inviteId: null,
    endsAt: null,
  };
}

function guest(userId: string, displayName: string, role: Role, inviteId: string): AttachmentView {
  return {
    ...member(userId, displayName, role),
    kind: userId.startsWith('g_') ? 'invitee' : 'member',
    inviteId,
    endsAt: Date.now() + MAX_INVITE_LIFETIME_MS,
  };
}

/**
 * Opens the demo page (with `query` added) against a scripted relay that
 * welcomes every hello with `roster` (Alice, a member, unless set), offers
 * invites at `linkBase`, lists every invite the page mints, drops every one
 * it cancels, and drops them all on revoke '*'. The page is served under
 * Trusted Types and a style-src that allows only its own <style>.
 */
async function openWithInviteRelay(
  page: Page,
  options: {
    query?: string;
    roster?: AttachmentView[];
    linkBase?: string | null;
    /** false for a page whose policy offers no invites, so the block never shows. */
    expectInvites?: boolean;
  } = {},
): Promise<InviteRelay> {
  const frames: PageFrame[] = [];
  const listings = new Map<string, Listing>();
  const linkBase = options.linkBase === undefined ? LINK_BASE : options.linkBase;
  let connections = 0;
  let send: ((frame: RelayFrame) => void) | null = null;
  let current: WebSocketRoute | null = null;
  const control = { refuse: null as InviteRefusalReason | null, hold: false };
  const list = (): void => {
    send?.({ t: 'invites', linkBase, invites: [...listings.values()] });
  };
  cspViolations = await enforceStrictCsp(page);
  await page.clock.install();
  await page.routeWebSocket(FAKE_RELAY, (ws) => {
    connections += 1;
    if (control.hold) {
      void ws.close();
      return;
    }
    current = ws;
    send = (frame) => {
      ws.send(encodeFrame(frame));
    };
    ws.onMessage((message) => {
      const parsed = parsePageFrame(typeof message === 'string' ? message : message.toString());
      if (parsed.kind !== 'ok') throw new Error(`the page sent a ${parsed.kind} frame`);
      const frame = parsed.frame;
      frames.push(frame);
      if (frame.t === 'hello') {
        send?.({
          t: 'welcome',
          pageId: 'page-1',
          resumeToken: `resume-${connections}`,
          resumed: frame.resumeToken !== undefined,
          pairing: { code: 'ABCDE-FGHJK', expiresAt: Date.now() + 120_000 },
          roster: options.roster ?? [member('alice', 'Alice')],
          limits: {
            maxFrameBytes: MAX_FRAME_BYTES,
            maxResultChars: MAX_RESULT_CHARS,
            maxDescriptionChars: MAX_DESCRIPTION_CHARS,
            pingIntervalMs: PING_INTERVAL_MS,
            // This relay never pings, so keep the page's silence watchdog out of the way.
            idleTimeoutMs: 600_000,
            resumeWindowMs: RESUME_WINDOW_MS,
            attachRequestTtlMs: ATTACH_REQUEST_TTL_MS,
          },
        });
        list();
      } else if (frame.t === 'invite_create' && control.refuse !== null) {
        send?.({
          t: 'invites',
          linkBase,
          invites: [...listings.values()],
          refused: { inviteId: frame.inviteId, reason: control.refuse },
        });
      } else if (frame.t === 'invite_create') {
        listings.set(frame.inviteId, {
          inviteId: frame.inviteId,
          role: frame.role,
          label: frame.label,
          uses: frame.uses,
          expiresAt: frame.expiresAt,
          usesLeft: frame.uses,
          sponsor: ALICE,
          pending: false,
          refusals: 0,
        });
        list();
      } else if (frame.t === 'invite_cancel') {
        listings.delete(frame.inviteId);
        list();
      } else if (frame.t === 'revoke' && frame.userId === '*') {
        listings.clear();
        list();
      }
    });
  });
  const url = demoPageUrl(demo, FAKE_RELAY);
  await page.goto(options.query ? `${url}&${options.query}` : url);
  await page.waitForSelector('html[data-tools="ready"]');
  await waitForDock(page, (state) => state.link === 'linked' && state.invitesOffered !== null);
  // The panel opens by itself only while nobody is attached.
  if (!(await widgetVisible(page, 'pause-box'))) await clickInWidget(page, { action: 'toggle' });
  if (options.expectInvites !== false) {
    await expect.poll(() => widgetVisible(page, 'invites')).toBe(true);
  }
  return {
    frames,
    listings,
    get connections() {
      return connections;
    },
    get refuse() {
      return control.refuse;
    },
    set refuse(reason) {
      control.refuse = reason;
    },
    get hold() {
      return control.hold;
    },
    set hold(value) {
      control.hold = value;
    },
    send(frame) {
      if (!send) throw new Error('the page has not connected');
      send(frame);
    },
    list,
    drop() {
      send = null;
      void current?.close();
      current = null;
    },
  };
}

function framesOf<T extends PageFrame['t']>(relay: InviteRelay, type: T) {
  return relay.frames.filter((frame): frame is Extract<PageFrame, { t: T }> => frame.t === type);
}

/** Stops the page's timers; only runFor moves them on from here. */
async function pauseClock(page: Page): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const now = await page.evaluate(() => Date.now());
    try {
      await page.clock.pauseAt(now + 250);
      return;
    } catch (error) {
      if (attempt === 5 || !String(error).includes('to the past')) throw error;
    }
  }
}

/** Types into a widget input as the operator would: a real click to focus it, then keys. */
async function typeInWidget(page: Page, action: string, text: string): Promise<void> {
  await clickInWidget(page, { action });
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(text);
}

/** Mints through the page's handle (the ?e2e hook), for tests about what happens after. */
async function mintByHandle(
  page: Page,
  options: { label: string; role: Role; uses?: number },
): Promise<{ inviteId: string; link: string; secret: string }> {
  const result = await page.evaluate((opts) => window.__tabdockDock?.invite(opts) ?? null, options);
  if (!result?.ok) throw new Error(`no invite: ${JSON.stringify(result)}`);
  const secret = SECRET_LINK.exec(result.link)?.[1];
  if (secret === undefined) throw new Error('the link is not shaped as an invite link');
  return { inviteId: result.inviteId, link: result.link, secret };
}

function redemption(
  requestId: string,
  invite: { inviteId: string; secret: string },
  label: string,
  user: { userId: string; displayName: string } = {
    userId: GUEST,
    displayName: 'guest@example.com',
  },
  verified = true,
): RelayFrame {
  return {
    t: 'attach_request',
    requestId,
    user,
    account: { kind: user.userId.startsWith('g_') ? 'invitee' : 'member', verified },
    via: 'invite',
    invite: { inviteId: invite.inviteId, secret: invite.secret, label },
    client: { name: 'claude-ai', version: '1.0' },
    expiresAt: Date.now() + ATTACH_REQUEST_TTL_MS,
  };
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The library's dark modules for a URL at level M, shifted by the four-module quiet zone. */
function libraryModules(url: string): { size: number; dark: Set<string> } {
  const code = encodeQr(url);
  if (!code) throw new Error('the library would not encode the URL');
  const count = code.getModuleCount();
  const dark = new Set<string>();
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (code.isDark(row, col)) dark.add(`${row + 4},${col + 4}`);
    }
  }
  return { size: count + 8, dark };
}

function drawnModules(d: string): Set<string> {
  const run = /M(\d+) (\d+)h(\d+)v1h-(\d+)z/gy;
  const dark = new Set<string>();
  for (let match = run.exec(d); match !== null; match = run.exec(d)) {
    const [, x = 0, y = 0, width = 0] = match.map(Number);
    for (let col = x; col < x + width; col += 1) dark.add(`${y},${col}`);
  }
  return dark;
}

/**
 * Serves the demo page with Trusted Types and a style-src that allows only
 * the page's own inline <style>, as the M3 specs do, and records every
 * violation the page reports.
 */
async function enforceStrictCsp(page: Page): Promise<() => Promise<string[]>> {
  const html = await (await fetch(demo.url)).text();
  const own = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
  if (own === undefined) throw new Error('the demo page has no <style>');
  const hash = createHash('sha256').update(own, 'utf8').digest('base64');
  const policy = `${TRUSTED_TYPES_CSP}; style-src 'self' 'sha256-${hash}' 'report-sample'`;
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.defineProperty(window, '__cspViolations', { value: seen });
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(event.effectiveDirective);
    });
  });
  const demoOrigin = new URL(demo.url).origin;
  await page.route(
    (url) => url.origin === demoOrigin && url.pathname === '/',
    async (route) => {
      const response = await route.fetch();
      const headers = response.headers();
      const existing = headers['content-security-policy'];
      await route.fulfill({
        response,
        headers: {
          ...headers,
          'content-security-policy': existing ? `${existing}; ${policy}` : policy,
        },
      });
    },
  );
  return () =>
    page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
}

interface DomNode {
  backendNodeId: number;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
}

function findByAttribute(node: DomNode, name: string, value: string): DomNode | null {
  const list = node.attributes ?? [];
  for (let i = 0; i + 1 < list.length; i += 2) {
    if (list[i] === name && list[i + 1] === value) return node;
  }
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
    const found = findByAttribute(child, name, value);
    if (found) return found;
  }
  return null;
}

/**
 * One property of a node inside the widget's closed shadow root, read
 * through the DevTools protocol: the node with each attribute of `path` in
 * turn, each inside the last, such as a roster row's "and close this link".
 */
async function widgetProperty(
  page: Page,
  path: readonly (readonly [string, string])[],
  property: 'textContent' | 'checked' | 'disabled' | 'className',
): Promise<unknown> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    let node: DomNode | null = root;
    for (const [name, value] of path) node = node && findByAttribute(node, name, value);
    if (!node) return null;
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: node.backendNodeId });
    if (object.objectId === undefined) return null;
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function () { return this[${JSON.stringify(property)}]; }`,
      returnByValue: true,
    });
    return result.value as unknown;
  } finally {
    await cdp.detach();
  }
}

test('the Invite form mints a link that shows once, as a QR code and text, and never reaches the console', async ({
  page,
}) => {
  const relay = await openWithInviteRelay(page);
  // The default policy offers Can watch only.
  await clickInWidget(page, { action: 'invite-open' });
  expect(await widgetButtonNow(page, { action: 'invite-role-driver' })).toBeNull();
  await typeInWidget(page, 'invite-label', 'Friends');
  await typeInWidget(page, 'invite-uses', '3');
  await clickInWidget(page, { action: 'invite-lifetime-15m' });
  const before = await page.evaluate(() => Date.now());
  await clickInWidget(page, { action: 'invite-create' });

  await expect.poll(() => framesOf(relay, 'invite_create')).toHaveLength(1);
  const [create] = framesOf(relay, 'invite_create');
  expect(create).toMatchObject({ role: 'observer', label: 'Friends', uses: 3 });
  expect(create?.expiresAt).toBeGreaterThanOrEqual(before + 15 * 60_000);
  expect(create?.expiresAt).toBeLessThan(before + 16 * 60_000);

  await expect.poll(() => widgetVisible(page, 'invite-link')).toBe(true);
  const link = (await widgetText(page, 'invite-link-text')) ?? '';
  const secret = SECRET_LINK.exec(link)?.[1] ?? '';
  expect(secret).toHaveLength(22);
  // The relay was sent the hash of the secret the link carries, and nothing else of it.
  expect(create?.secretHash).toBe(sha256Hex(secret));
  expect(JSON.stringify(relay.frames)).not.toContain(secret);

  // Drawn like the pairing QR code: the library's matrix, one path, built with DOM calls.
  const drawing = await widgetQrDrawing(page, 'invite-qr');
  const expected = libraryModules(link);
  expect(drawing?.viewBox).toBe(`0 0 ${expected.size} ${expected.size}`);
  expect(drawnModules(drawing?.d ?? '')).toEqual(expected.dark);

  // The live list names it as the page wrote it.
  const rows = await widgetItems(page, 'invite-list');
  expect(rows).toHaveLength(1);
  expect(rows[0]?.text).toContain('"Friends", Can watch');
  expect(rows[0]?.text).toContain('0 of 3 joined');
  expect(rows[0]?.text).toContain('shared by Alice');
  expect(rows[0]?.data.inviteId).toBe(create?.inviteId);

  // Copy puts exactly the link on the clipboard, for sending from a phone.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await clickInWidget(page, { action: 'invite-copy' });
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(link);

  // Done, and the link is gone for good: text, drawing and all.
  await clickInWidget(page, { action: 'invite-done' });
  expect(await widgetVisible(page, 'invite-link')).toBe(false);
  expect(await widgetText(page, 'invite-link-text')).toBe('');
  expect((await widgetQrDrawing(page, 'invite-qr'))?.d ?? null).toBeNull();

  // S11: no console line, and nothing the page stored, holds the secret.
  expect(consoleLines.length).toBeGreaterThan(0);
  expect(consoleLines.filter((line) => line.includes(secret) || line.includes('/i#'))).toEqual([]);
  const stored = await page.evaluate(() =>
    JSON.stringify(Object.keys(sessionStorage).map((key) => sessionStorage.getItem(key))),
  );
  expect(stored).toContain(create?.secretHash ?? 'no hash');
  expect(stored).not.toContain(secret);
});

test('Create waits like Allow, and switching between Can watch and Can control makes it wait again', async ({
  page,
}) => {
  const relay = await openWithInviteRelay(page, { query: 'invites=all' });
  expect((await dockState(page))?.policy).toMatchObject({ invites: 'all', maxDrivers: 2 });
  await clickInWidget(page, { action: 'invite-open' });
  await typeInWidget(page, 'invite-label', 'Help');
  const aimed = await widgetButtonCentre(page, { action: 'invite-create' });
  expect(await widgetVisible(page, 'invite-form')).toBe(true);

  await pauseClock(page);
  // Can control: one use, so the uses field goes and Create moves; it waits again either way.
  await clickInWidget(page, { action: 'invite-role-driver' });
  const switched = await widgetButtonNow(page, { action: 'invite-create' });
  expect(switched?.armed).toBe(false);
  expect(await widgetButtonNow(page, { action: 'invite-uses' })).toBeNull();
  await page.mouse.click(switched?.x ?? aimed.x, switched?.y ?? aimed.y);
  await page.clock.runFor(ARM_DELAY_MS - 100);
  expect(framesOf(relay, 'invite_create')).toEqual([]);
  expect((await widgetButtonNow(page, { action: 'invite-create' }))?.armed).toBe(false);
  await page.clock.runFor(100);
  expect((await widgetButtonNow(page, { action: 'invite-create' }))?.armed).toBe(true);
  await page.mouse.click(switched?.x ?? 0, switched?.y ?? 0);
  await expect
    .poll(() => framesOf(relay, 'invite_create'))
    .toEqual([expect.objectContaining({ role: 'driver', label: 'Help', uses: 1 })]);
});

test('a Can watch link joins without a prompt, with a notice, the invited badge and the email beside a short id, and a forged one is refused', async ({
  page,
}) => {
  const relay = await openWithInviteRelay(page);
  const minted = await mintByHandle(page, { label: 'Friends', role: 'observer', uses: 3 });

  relay.send(
    redemption('forged', { inviteId: minted.inviteId, secret: 'A'.repeat(22) }, 'Friends'),
  );
  await expect
    .poll(() => framesOf(relay, 'attach_decision'))
    .toEqual([{ t: 'attach_decision', requestId: 'forged', allow: false }]);

  relay.send(redemption('watch', minted, 'Friends'));
  await expect
    .poll(() => framesOf(relay, 'attach_decision').at(-1))
    .toEqual({ t: 'attach_decision', requestId: 'watch', allow: true, role: 'observer' });
  expect((await dockState(page))?.pendingRequests).toEqual([]);

  relay.send({
    t: 'roster',
    attachments: [
      member('alice', 'Alice'),
      guest(GUEST, 'guest@example.com', 'observer', minted.inviteId),
    ],
  });
  await waitForDock(page, (state) => state.roster.length === 2);
  const rows = await widgetItems(page, 'roster');
  expect(rows[1]?.text).toContain('guest@example.com (1a2b3c4d) (observer)');
  expect(rows[1]?.text).toContain('invited');
  expect(rows[0]?.text).not.toContain('invited');
  // A Can watch guest can never drive here, so the row offers Revoke only.
  expect(await widgetButtonNow(page, { action: 'make-driver', userId: GUEST })).toBeNull();
  expect(await widgetText(page, 'joins')).toContain(
    'guest@example.com (1a2b3c4d) joined by your invite "Friends" as observer',
  );
  await expect
    .poll(async () => (await widgetItems(page, 'invite-list'))[0]?.text)
    .toContain('1 of 3 joined');
});

test('a Can control link prompts, naming the account beside the label, under the arming rules', async ({
  page,
}) => {
  const relay = await openWithInviteRelay(page, { query: 'invites=all' });
  const minted = await mintByHandle(page, { label: 'Help', role: 'driver' });
  await pauseClock(page);
  relay.send(
    redemption(
      'control',
      minted,
      'Help',
      { userId: OTHER_GUEST, displayName: 'unverified account' },
      false,
    ),
  );
  await waitForDock(page, (state) => state.pendingRequests.length === 1);
  const allow = await widgetButtonNow(page, { action: 'approve-driver', requestId: 'control' });
  expect(allow?.armed).toBe(false);
  // A click before the box has held still does nothing.
  await page.mouse.click(allow?.x ?? 0, allow?.y ?? 0);
  await page.clock.runFor(ARM_DELAY_MS);
  expect(framesOf(relay, 'attach_decision')).toEqual([]);
  const prompt = await page.evaluate(() => window.__tabdockDock?.state.pendingRequests[0]);
  expect(prompt).toMatchObject({ via: 'invite', invite: { label: 'Help' } });

  const text = String(await widgetProperty(page, [['data-request-id', 'control']], 'textContent'));
  expect(text).toContain('unverified account (5e6f7a8b) wants to join by your invite "Help"');
  expect(text).toContain('invited');
  expect(text).toContain('Unverified account');
  await page.mouse.click(allow?.x ?? 0, allow?.y ?? 0);
  await expect
    .poll(() => framesOf(relay, 'attach_decision'))
    .toEqual([{ t: 'attach_decision', requestId: 'control', allow: true, role: 'driver' }]);
});

/** A roster row's "and close this link" box. */
function closeBox(userId: string): [string, string][] {
  return [
    ['data-user-id', userId],
    ['data-action', 'close-link'],
  ];
}

test("Revoke closes a multi-use invitee's link by default, unchecked it only revokes, and Cancel closes a link", async ({
  page,
}) => {
  const relay = await openWithInviteRelay(page);
  const first = await mintByHandle(page, { label: 'Friends', role: 'observer', uses: 3 });
  relay.send(redemption('first', first, 'Friends'));
  await expect.poll(() => framesOf(relay, 'attach_decision')).toHaveLength(1);
  relay.send({
    t: 'roster',
    attachments: [
      member('alice', 'Alice'),
      guest(GUEST, 'guest@example.com', 'observer', first.inviteId),
    ],
  });
  await waitForDock(page, (state) => state.roster.length === 2);
  // Checked by default for a multi-use link.
  expect(await widgetProperty(page, closeBox(GUEST), 'checked')).toBe(true);
  await clickInWidget(page, { action: 'revoke', userId: GUEST });
  await expect
    .poll(() => relay.frames.filter((frame) => frame.t === 'revoke' || frame.t === 'invite_cancel'))
    .toEqual([
      { t: 'revoke', userId: GUEST },
      { t: 'invite_cancel', inviteId: first.inviteId },
    ]);

  const second = await mintByHandle(page, { label: 'Family', role: 'observer', uses: 2 });
  relay.send(
    redemption('second', second, 'Family', {
      userId: OTHER_GUEST,
      displayName: 'other@example.com',
    }),
  );
  await expect.poll(() => framesOf(relay, 'attach_decision')).toHaveLength(2);
  relay.send({
    t: 'roster',
    attachments: [
      member('alice', 'Alice'),
      guest(OTHER_GUEST, 'other@example.com', 'observer', second.inviteId),
    ],
  });
  await waitForDock(page, (state) => state.roster.some((entry) => entry.userId === OTHER_GUEST));
  await clickInWidget(page, { action: 'close-link', userId: OTHER_GUEST });
  expect(await widgetProperty(page, closeBox(OTHER_GUEST), 'checked')).toBe(false);
  await clickInWidget(page, { action: 'revoke', userId: OTHER_GUEST });
  await expect.poll(() => framesOf(relay, 'revoke')).toHaveLength(2);
  expect(framesOf(relay, 'invite_cancel')).toHaveLength(1);

  // Cancel in the live list closes the link at once.
  await clickInWidget(page, { action: 'cancel-invite', inviteId: second.inviteId });
  await expect
    .poll(() => framesOf(relay, 'invite_cancel').at(-1))
    .toEqual({ t: 'invite_cancel', inviteId: second.inviteId });
  await expect.poll(() => widgetItems(page, 'invite-list')).toEqual([]);
});

test('Revoke all closes every live invite and clears the link on show', async ({ page }) => {
  const relay = await openWithInviteRelay(page);
  await clickInWidget(page, { action: 'invite-open' });
  await typeInWidget(page, 'invite-label', 'Friends');
  await clickInWidget(page, { action: 'invite-create' });
  await expect.poll(() => widgetVisible(page, 'invite-link')).toBe(true);
  await mintByHandle(page, { label: 'Family', role: 'observer' });
  await expect.poll(async () => (await widgetItems(page, 'invite-list')).length).toBe(2);

  await clickInWidget(page, { action: 'revoke-all' });
  await expect.poll(() => framesOf(relay, 'revoke')).toEqual([{ t: 'revoke', userId: '*' }]);
  await expect.poll(() => widgetItems(page, 'invite-list')).toEqual([]);
  await expect.poll(() => widgetVisible(page, 'invite-link')).toBe(false);
  expect(await widgetText(page, 'invite-link-text')).toBe('');
});

test('Create says why it cannot work while no member is attached to sponsor an invite', async ({
  page,
}) => {
  await openWithInviteRelay(page, { roster: [] });
  await clickInWidget(page, { action: 'invite-open' });
  await expect
    .poll(() => widgetText(page, 'invite-reason'))
    .toContain('Invites need a member attached to sponsor them');
  await typeInWidget(page, 'invite-label', 'Friends');
  expect(await widgetProperty(page, [['data-action', 'invite-create']], 'disabled')).toBe(true);
});

test('a relay without a public URL offers the list but no way to mint', async ({ page }) => {
  await openWithInviteRelay(page, { linkBase: null });
  await clickInWidget(page, { action: 'invite-open' });
  await expect.poll(() => widgetText(page, 'invite-reason')).toContain('no public URL');
});

test('the board does not link to a relay inside a frame, so a framing site cannot dress up its widget', async ({
  page,
}) => {
  let connections = 0;
  await page.routeWebSocket(FAKE_RELAY, () => {
    connections += 1;
  });
  // A page at the demo's own origin frames it; the demo server's frame-ancestors 'self' allows that much.
  const framer = new URL('/framer', demo.url).href;
  const framed = demoPageUrl(demo, FAKE_RELAY);
  await page.route(framer, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><iframe src="${framed}" style="width:1000px;height:800px"></iframe>`,
    }),
  );
  await page.goto(framer);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('[data-role="status"]')).toHaveText(
    /not linked: this board does not link to a relay inside a frame/,
  );
  await expect(frame.locator('html')).toHaveAttribute('data-link', 'refused');
  expect(await frame.locator('tabdock-dock').count()).toBe(0);
  expect(connections).toBe(0);
});

// What a reviewer found the specs above left open: the join notice's source
// and visibility, the boundary against scripts that run after attach(), and
// the form, list, prompt and activity rules ADRs 0016 and 0017 set.

/** The badge's classes, which carry 'attention' while something waits for the operator. */
async function badgeClass(page: Page): Promise<string> {
  return String(await widgetProperty(page, [['data-action', 'toggle']], 'className'));
}

/** Headless tabs never hide, so a test stands in for the browser's visibility state, as widget.spec.ts does. */
async function hideTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    let visibility: DocumentVisibilityState = 'hidden';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => visibility === 'hidden',
    });
    (window as unknown as { showTab: () => void }).showTab = () => {
      visibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    };
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function showTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { showTab: () => void }).showTab();
  });
}

function invokeFrame(
  callId: string,
  tool: string,
  caller: { userId: string; displayName: string; role: Role },
): RelayFrame {
  return {
    t: 'invoke',
    callId,
    tool,
    arguments: {},
    caller: { ...caller, client: { name: 'claude-ai', version: '1.0' } },
    deadlineMs: 45_000,
  };
}

/** Lets a Can watch guest in by `minted` and has the relay list them beside Alice. */
async function watchGuestJoins(
  page: Page,
  relay: InviteRelay,
  minted: { inviteId: string; secret: string },
): Promise<void> {
  const before = framesOf(relay, 'attach_decision').length;
  relay.send(redemption('watch', minted, 'Friends'));
  await expect
    .poll(() => framesOf(relay, 'attach_decision').slice(before))
    .toEqual([{ t: 'attach_decision', requestId: 'watch', allow: true, role: 'observer' }]);
  relay.send({
    t: 'roster',
    attachments: [
      member('alice', 'Alice'),
      guest(GUEST, 'guest@example.com', 'observer', minted.inviteId),
    ],
  });
  await waitForDock(page, (state) => state.roster.length === 2);
}

test('a Can watch join opens a closed panel, and its notice stays until it has been on screen for 20 s', async ({
  page,
}) => {
  const relay = await openWithInviteRelay(page);
  const minted = await mintByHandle(page, { label: 'Friends', role: 'observer', uses: 3 });
  await clickInWidget(page, { action: 'toggle' });
  expect(await widgetVisible(page, 'pause-box')).toBe(false);
  await pauseClock(page);

  await watchGuestJoins(page, relay, minted);
  // Nobody was asked about this join, so the panel opens to tell of it.
  await expect.poll(() => widgetVisible(page, 'pause-box')).toBe(true);
  const notice = 'guest@example.com (1a2b3c4d) joined by your invite "Friends" as observer';
  expect(await widgetText(page, 'joins')).toBe(notice);

  // Closed again at once: time off screen does not count.
  await clickInWidget(page, { action: 'toggle' });
  expect(await widgetVisible(page, 'pause-box')).toBe(false);
  await page.clock.runFor(25_000);
  expect(await widgetText(page, 'joins')).toBe(notice);
  // Open again: 20 s on screen and it goes.
  await clickInWidget(page, { action: 'toggle' });
  await page.clock.runFor(18_000);
  expect(await widgetText(page, 'joins')).toBe(notice);
  await page.clock.runFor(3_000);
  expect(await widgetText(page, 'joins')).toBe('');
});

test('a Can watch join while the tab is hidden keeps the badge asking for attention, and its notice, until the tab is seen', async ({
  page,
}) => {
  const relay = await openWithInviteRelay(page);
  const minted = await mintByHandle(page, { label: 'Friends', role: 'observer', uses: 3 });
  await clickInWidget(page, { action: 'toggle' });
  await pauseClock(page);
  await hideTab(page);

  await watchGuestJoins(page, relay, minted);
  await expect.poll(() => badgeClass(page)).toContain('attention');
  await page.clock.runFor(30_000);
  expect(await badgeClass(page)).toContain('attention');
  expect(await widgetText(page, 'joins')).toContain('joined by your invite "Friends"');

  await showTab(page);
  await expect.poll(() => badgeClass(page)).not.toContain('attention');
  expect(await widgetText(page, 'joins')).toContain('joined by your invite "Friends"');
  await page.clock.runFor(21_000);
  expect(await widgetText(page, 'joins')).toBe('');
});

test('no notice for someone a lying relay lists by invite, though the page never honoured a redemption', async ({
  page,
}) => {
  const relay = await openWithInviteRelay(page);
  const minted = await mintByHandle(page, { label: 'Friends', role: 'observer', uses: 3 });
  await clickInWidget(page, { action: 'toggle' });
  // A forged redemption first, refused, and then the relay lists the guest as a driver anyway.
  relay.send(
    redemption('forged', { inviteId: minted.inviteId, secret: 'A'.repeat(22) }, 'Friends'),
  );
  await expect
    .poll(() => framesOf(relay, 'attach_decision'))
    .toEqual([{ t: 'attach_decision', requestId: 'forged', allow: false }]);
  relay.send({
    t: 'roster',
    attachments: [
      member('alice', 'Alice'),
      guest(GUEST, 'guest@example.com', 'driver', minted.inviteId),
    ],
  });
  await waitForDock(page, (state) => state.roster.length === 2);
  await page.clock.runFor(1_000);
  expect(await widgetText(page, 'joins')).toBe('');
  expect(await widgetVisible(page, 'pause-box')).toBe(false);
  expect(await badgeClass(page)).not.toContain('attention');
  // The page runs nothing for them, and holds no join of theirs.
  const state = await dockState(page);
  expect(state?.pageRoles[1]).toMatchObject({ userId: GUEST, role: null });
  expect(state?.joins).toEqual([]);
});

test('the join notice names the role the page runs a guest under, not the one a lying relay lists', async ({
  page,
}) => {
  const relay = await openWithInviteRelay(page);
  const minted = await mintByHandle(page, { label: 'Friends', role: 'observer', uses: 3 });
  relay.send(redemption('watch', minted, 'Friends'));
  await expect
    .poll(() => framesOf(relay, 'attach_decision'))
    .toEqual([{ t: 'attach_decision', requestId: 'watch', allow: true, role: 'observer' }]);
  // Honoured as observer; the relay lists them as a driver.
  relay.send({
    t: 'roster',
    attachments: [
      member('alice', 'Alice'),
      guest(GUEST, 'guest@example.com', 'driver', minted.inviteId),
    ],
  });
  await waitForDock(page, (state) => state.roster.length === 2);
  await expect
    .poll(() => widgetText(page, 'joins'))
    .toBe('guest@example.com (1a2b3c4d) joined by your invite "Friends" as observer');
});

test('a script that runs after attach() and patches WebCrypto, TextEncoder, Uint8Array, the clipboard and WebSocket neither predicts nor sees an invite link', async ({
  page,
}) => {
  const relay = await openWithInviteRelay(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  // The board called attach() as it loaded; everything below runs later.
  await page.evaluate(() => {
    const seen: { kind: string; value: string }[] = [];
    const made: Uint8Array[] = [];
    Object.defineProperty(window, '__seen', { value: seen });
    Object.defineProperty(window, '__made', { value: made });
    const patch = (target: object, name: string, value: unknown): void => {
      Object.defineProperty(target, name, { value, configurable: true, writable: true });
    };
    /** The original, to call through as the page's own code still would. */
    const original = (target: object, name: string) =>
      Reflect.get(target, name) as (...args: unknown[]) => unknown;
    // Predictable randomness: every byte zero.
    patch(Crypto.prototype, 'getRandomValues', (array: Uint8Array) => {
      seen.push({ kind: 'random', value: '' });
      return array.fill(0);
    });
    const digest = original(SubtleCrypto.prototype, 'digest');
    patch(
      SubtleCrypto.prototype,
      'digest',
      function (this: SubtleCrypto, algorithm: AlgorithmIdentifier, data: BufferSource) {
        seen.push({ kind: 'digest', value: new TextDecoder().decode(data) });
        return Reflect.apply(digest, this, [algorithm, data]);
      },
    );
    const encode = original(TextEncoder.prototype, 'encode');
    patch(TextEncoder.prototype, 'encode', function (this: TextEncoder, input?: string) {
      seen.push({ kind: 'encode', value: String(input) });
      return Reflect.apply(encode, this, [input]);
    });
    const writeText = original(Clipboard.prototype, 'writeText');
    patch(Clipboard.prototype, 'writeText', function (this: Clipboard, data: string) {
      seen.push({ kind: 'clipboard', value: data });
      return Reflect.apply(writeText, this, [data]);
    });
    // Every byte array made from here on is kept, to be read once the secret is drawn.
    const RealBytes = Uint8Array;
    function Bytes(...args: unknown[]): Uint8Array {
      const bytes = Reflect.construct(RealBytes, args) as Uint8Array;
      made.push(bytes);
      return bytes;
    }
    Object.setPrototypeOf(Bytes, RealBytes);
    Bytes.prototype = RealBytes.prototype;
    patch(window, 'Uint8Array', Bytes);
    const RealSocket = WebSocket;
    patch(window, 'WebSocket', function (url: string, protocols?: string | string[]) {
      seen.push({ kind: 'socket', value: url });
      return new RealSocket(url, protocols);
    });
  });

  await clickInWidget(page, { action: 'invite-open' });
  await typeInWidget(page, 'invite-label', 'Friends');
  await clickInWidget(page, { action: 'invite-create' });
  await expect.poll(() => widgetVisible(page, 'invite-link')).toBe(true);
  const link = (await widgetText(page, 'invite-link-text')) ?? '';
  const secret = SECRET_LINK.exec(link)?.[1] ?? '';
  const [create] = framesOf(relay, 'invite_create');
  // Not the patched zeros, and the relay holds the hash of the very secret the link carries.
  expect(secret).toHaveLength(22);
  expect(secret).not.toBe('A'.repeat(22));
  expect(create?.inviteId).not.toBe(`inv_${'A'.repeat(12)}`);
  expect(create?.secretHash).toBe(sha256Hex(secret));

  await clickInWidget(page, { action: 'invite-copy' });
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  const seenNow = () =>
    page.evaluate(
      () => (window as unknown as { __seen: { kind: string; value: string }[] }).__seen,
    );
  // Read before the reconnect below, as Playwright's own WebSocket stand-in draws random ids.
  const minting = await seenNow();
  expect(minting.filter((entry) => ['random', 'clipboard'].includes(entry.kind))).toEqual([]);

  // A dropped link reconnects through the WebSocket taken at attach().
  relay.drop();
  await expect.poll(() => relay.connections).toBe(2);
  await waitForDock(page, (state) => state.link === 'linked');

  const seen = await seenNow();
  expect(seen.filter((entry) => entry.kind === 'socket')).toEqual([]);
  expect(seen.filter((entry) => entry.value.includes(secret))).toEqual([]);
  // No byte array made after the patch ever held the secret's 16 bytes.
  const bytes = Array.from(Buffer.from(secret, 'base64url')).join(',');
  const made = await page.evaluate(() =>
    (window as unknown as { __made: Uint8Array[] }).__made.map((array) =>
      Array.from(array).join(','),
    ),
  );
  expect(made.filter((array) => array.includes(bytes))).toEqual([]);
});

test('Create offers 1 hour unless the operator picks another lifetime, and "while the page is open" sends no expiry', async ({
  page,
}) => {
  const relay = await openWithInviteRelay(page);
  await clickInWidget(page, { action: 'invite-open' });
  await typeInWidget(page, 'invite-label', 'Friends');
  const before = await page.evaluate(() => Date.now());
  await clickInWidget(page, { action: 'invite-create' });
  await expect.poll(() => framesOf(relay, 'invite_create')).toHaveLength(1);
  const [hour] = framesOf(relay, 'invite_create');
  expect(hour?.expiresAt).toBeGreaterThanOrEqual(before + 60 * 60_000);
  expect(hour?.expiresAt).toBeLessThan(before + 61 * 60_000);
  await clickInWidget(page, { action: 'invite-done' });

  await clickInWidget(page, { action: 'invite-open' });
  await typeInWidget(page, 'invite-label', 'Family');
  await clickInWidget(page, { action: 'invite-lifetime-open' });
  await clickInWidget(page, { action: 'invite-create' });
  await expect.poll(() => framesOf(relay, 'invite_create')).toHaveLength(2);
  expect(framesOf(relay, 'invite_create')[1]).toMatchObject({ label: 'Family', expiresAt: null });
  await expect
    .poll(async () => (await widgetItems(page, 'invite-list'))[1]?.text)
    .toContain('open while this page is, 24 h at most');
});

test("a guest's calls carry the short id and the invited badge, in the activity log and on a confirm prompt", async ({
  page,
}) => {
  const relay = await openWithInviteRelay(page, { query: 'invites=all' });
  const minted = await mintByHandle(page, { label: 'Help', role: 'driver' });
  relay.send(redemption('control', minted, 'Help'));
  await waitForDock(page, (state) => state.pendingRequests.length === 1);
  await clickInWidget(page, { action: 'approve-driver', requestId: 'control' });
  await expect
    .poll(() => framesOf(relay, 'attach_decision'))
    .toEqual([{ t: 'attach_decision', requestId: 'control', allow: true, role: 'driver' }]);
  relay.send({
    t: 'roster',
    attachments: [
      member('alice', 'Alice'),
      guest(GUEST, 'guest@example.com', 'driver', minted.inviteId),
    ],
  });
  await waitForDock(page, (state) => state.pageRoles[1]?.role === 'driver');
  const caller = { userId: GUEST, displayName: 'guest@example.com', role: 'driver' as const };
  relay.send(invokeFrame('alice-read', 'get_view', { ...ALICE, role: 'driver' }));
  relay.send(invokeFrame('guest-read', 'get_view', caller));
  await expect.poll(() => framesOf(relay, 'result')).toHaveLength(2);
  const lines = await widgetItems(page, 'activity');
  const guestLine = lines.find((line) => line.data.activityId === 'guest-read')?.text ?? '';
  expect(guestLine).toContain('guest@example.com (1a2b3c4d)');
  expect(guestLine).toContain('invited');
  expect(lines.find((line) => line.data.activityId === 'alice-read')?.text).not.toContain(
    'invited',
  );

  relay.send(invokeFrame('guest-wipe', 'clear_board', caller));
  await waitForDock(page, (state) => state.pendingConfirms.length === 1);
  const prompt = String(
    await widgetProperty(page, [['data-call-id', 'guest-wipe']], 'textContent'),
  );
  expect(prompt).toContain('guest@example.com (1a2b3c4d) wants to run clear_board');
  expect(prompt).toContain('invited');
  await clickInWidget(page, { action: 'confirm-deny', callId: 'guest-wipe' });
  await expect
    .poll(
      () => framesOf(relay, 'result').find((frame) => frame.callId === 'guest-wipe')?.error?.code,
    )
    .toBe('denied_by_operator');
});

test('a Can control prompt says the guest joins as observer while the driver seats are full', async ({
  page,
}) => {
  const relay = await openWithInviteRelay(page, { query: 'invites=all' });
  const seatsFull = 'The driver seats are full, so they join as observer for now.';
  const minted = await mintByHandle(page, { label: 'Help', role: 'driver' });
  // One driver of the board's two seats: no note.
  relay.send(redemption('one-seat-free', minted, 'Help'));
  await waitForDock(page, (state) => state.pendingRequests.length === 1);
  expect(
    String(await widgetProperty(page, [['data-request-id', 'one-seat-free']], 'textContent')),
  ).not.toContain(seatsFull);
  await clickInWidget(page, { action: 'deny', requestId: 'one-seat-free' });
  await waitForDock(page, (state) => state.pendingRequests.length === 0);

  relay.send({
    t: 'roster',
    attachments: [member('alice', 'Alice'), member('bob', 'Bob')],
  });
  await waitForDock(page, (state) => state.roster.length === 2);
  relay.send(redemption('seats-full', minted, 'Help'));
  await waitForDock(page, (state) => state.pendingRequests.length === 1);
  expect(
    String(await widgetProperty(page, [['data-request-id', 'seats-full']], 'textContent')),
  ).toContain(seatsFull);
});

test('a prompt names an unverified account "unverified account", whatever name the relay gives it', async ({
  page,
}) => {
  const relay = await openWithInviteRelay(page, { query: 'invites=all' });
  const minted = await mintByHandle(page, { label: 'Help', role: 'driver' });
  relay.send(
    redemption(
      'unverified',
      minted,
      'Help',
      { userId: GUEST, displayName: 'alice@example.com' },
      false,
    ),
  );
  await waitForDock(page, (state) => state.pendingRequests.length === 1);
  const text = String(
    await widgetProperty(page, [['data-request-id', 'unverified']], 'textContent'),
  );
  expect(text).toContain('unverified account (1a2b3c4d) wants to join by your invite "Help"');
  expect(text).not.toContain('alice@example.com');
});

test('?invites=off offers no Invite form, though the relay offers invites', async ({ page }) => {
  await openWithInviteRelay(page, { query: 'invites=off', expectInvites: false });
  expect((await dockState(page))?.policy.invites).toBe('off');
  expect(await widgetVisible(page, 'pause-box')).toBe(true);
  expect(await widgetVisible(page, 'invites')).toBe(false);
  expect(
    await page.evaluate(() => window.__tabdockDock?.invite({ label: 'Friends', role: 'observer' })),
  ).toEqual({ ok: false, reason: 'policy' });
});

test('Create says the link is down while it is, and works again once the page has linked', async ({
  page,
}) => {
  const relay = await openWithInviteRelay(page);
  await clickInWidget(page, { action: 'invite-open' });
  await typeInWidget(page, 'invite-label', 'Friends');
  expect(await widgetProperty(page, [['data-action', 'invite-create']], 'disabled')).toBe(false);
  relay.hold = true;
  relay.drop();
  await waitForDock(page, (state) => state.link !== 'linked');
  await expect
    .poll(() => widgetText(page, 'invite-reason'))
    .toBe('The link to the relay is down. Try again once it is back.');
  expect(await widgetProperty(page, [['data-action', 'invite-create']], 'disabled')).toBe(true);
  relay.hold = false;
  await waitForDock(
    page,
    (state) => state.link === 'linked' && state.invitesOffered !== null,
    30_000,
  );
  await expect.poll(() => widgetText(page, 'invite-reason')).toBe('');
  expect(await widgetProperty(page, [['data-action', 'invite-create']], 'disabled')).toBe(false);
});

test('Create says why it waits while the page holds ten live invites', async ({ page }) => {
  await openWithInviteRelay(page);
  for (let n = 0; n < 10; n += 1) {
    await mintByHandle(page, { label: `Guest ${n}`, role: 'observer' });
  }
  await clickInWidget(page, { action: 'invite-open' });
  await typeInWidget(page, 'invite-label', 'One more');
  await expect
    .poll(() => widgetText(page, 'invite-reason'))
    .toBe('This page already has 10 live invites. Cancel one first.');
  expect(await widgetProperty(page, [['data-action', 'invite-create']], 'disabled')).toBe(true);
});

test("a mint the relay refuses shows the relay's reason and no link", async ({ page }) => {
  const relay = await openWithInviteRelay(page);
  relay.refuse = 'no_sponsor';
  await clickInWidget(page, { action: 'invite-open' });
  await typeInWidget(page, 'invite-label', 'Friends');
  await clickInWidget(page, { action: 'invite-create' });
  await expect
    .poll(() => widgetText(page, 'invite-error'))
    .toBe('The relay found no member attached to sponsor it. Pair one first.');
  expect(await widgetVisible(page, 'invite-error')).toBe(true);
  expect(await widgetVisible(page, 'invite-link')).toBe(false);
});

test('the live list shows how long a link lasts, that someone is waiting, and the refusals a Can control link has had', async ({
  page,
}) => {
  const relay = await openWithInviteRelay(page, { query: 'invites=all' });
  const minted = await mintByHandle(page, { label: 'Help', role: 'driver' });
  const listing = relay.listings.get(minted.inviteId);
  if (!listing) throw new Error('the relay does not list the invite');
  relay.listings.set(minted.inviteId, { ...listing, pending: true, refusals: 1 });
  relay.list();
  await expect
    .poll(async () => (await widgetItems(page, 'invite-list'))[0]?.text)
    .toContain('someone is waiting');
  const text = (await widgetItems(page, 'invite-list'))[0]?.text ?? '';
  expect(text).toContain('"Help", Can control');
  expect(text).toMatch(/expires in (1 h 0|59) min/);
  expect(text).toContain('1 of 3 refusals');
});

test('Revoke all shows while invites are live though nobody is attached, and closes them', async ({
  page,
}) => {
  const relay = await openWithInviteRelay(page, { roster: [] });
  expect(await widgetButtonNow(page, { action: 'revoke-all' })).toBeNull();
  await mintByHandle(page, { label: 'Friends', role: 'observer' });
  await expect.poll(() => widgetItems(page, 'invite-list')).toHaveLength(1);
  await clickInWidget(page, { action: 'revoke-all' });
  await expect.poll(() => framesOf(relay, 'revoke')).toEqual([{ t: 'revoke', userId: '*' }]);
  await expect.poll(() => widgetItems(page, 'invite-list')).toEqual([]);
});

test('an https copy of the board refuses a ws: relay off this machine, as relayFromQuery asks', async ({
  page,
}) => {
  let dialled = 0;
  await page.routeWebSocket(/.*/, () => {
    dialled += 1;
  });
  // The demo server's own bytes, served as if from an https host.
  const httpsCopy = 'https://board.example';
  await page.route(`${httpsCopy}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const response = await route.fetch({ url: new URL(path, demo.url).href });
    await route.fulfill({ response });
  });
  const url = new URL(`${httpsCopy}/`);
  url.searchParams.set('relay', 'ws://relay.example/page');
  await page.goto(url.href);
  await page.waitForSelector('html[data-tools="ready"]');
  await expect(page.locator('[data-role="status"]')).toHaveText(
    /not linked: \?relay must be a wss: URL on an https page/,
  );
  expect(await page.locator('tabdock-dock').count()).toBe(0);
  expect(dialled).toBe(0);
});

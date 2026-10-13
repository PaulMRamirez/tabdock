// Shared setup for Tabdock in a real browser: the relay on a free port with
// throwaway dev tokens, the demo page served beside it and opened with ?relay
// and ?e2e=<its key>, and MCP clients from the official SDK with a bearer header. The
// Playwright specs, the milestone demos and the Claude Code checks all use it.
// Its widget clicks and text reads run the published helper,
// @tabdock/adapter/testing (ADR 0041), so every spec that clicks the widget
// exercises the code a CI check copies.

import { randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CDPSession, Page } from '@playwright/test';
import type { Dock, DockState, Role } from '@tabdock/adapter';
// A namespace, since the wrappers here share the names of the helper's functions they call.
import * as helper from '@tabdock/adapter/testing';
import type { WidgetAction, WidgetRole, WidgetTarget } from '@tabdock/adapter/testing';
import { startDemoServer, type DemoServer } from '@tabdock/demo/server';
import { type ErrorCode, isErrorCode } from '@tabdock/protocol';
import {
  createDevTokenAuth,
  createRelay,
  type DevTokenUser,
  type LogLevel,
  type LogSink,
  type Relay,
  type RelayOptions,
} from '@tabdock/relay';
import { resultJson } from '@tabdock/relay/test/results';

declare global {
  interface Window {
    /** The demo page's ?e2e test hook (apps/demo/src/main.ts); the adapter never sets it. */
    __tabdockDock?: Dock;
  }
}

export interface Tabdock {
  relay: Relay;
  demo: DemoServer;
  /** Throwaway users, made fresh for every run and never written anywhere. */
  users: { alice: DevTokenUser; bob: DevTokenUser };
  /** The demo page linked to this relay, with the test hook on. */
  pageUrl: string;
  close(): Promise<void>;
}

export function throwawayUser(userId: string, displayName: string): DevTokenUser {
  return { userId, displayName, token: randomBytes(24).toString('base64url') };
}

export async function startTabdock(
  options: {
    demo?: DemoServer;
    logSink?: LogSink;
    /** info unless set; debug adds the relay's queue lines ('call queued'), which ordering checks read. */
    logLevel?: LogLevel;
    timings?: RelayOptions['timings'];
  } = {},
): Promise<Tabdock> {
  const users = { alice: throwawayUser('alice', 'Alice'), bob: throwawayUser('bob', 'Bob') };
  const demo = options.demo ?? (await startDemoServer({ e2eHook: true }));
  let relay: Relay;
  try {
    relay = await createRelay({
      auth: createDevTokenAuth([users.alice, users.bob]),
      port: 0,
      // A real browser always sends Origin; the dev default allows 127.0.0.1 at any port.
      allowMissingOrigin: false,
      logSink: options.logSink ?? (() => undefined),
      logLevel: options.logLevel,
      timings: options.timings,
    });
  } catch (error) {
    if (!options.demo) await demo.close();
    throw error;
  }
  return {
    relay,
    demo,
    users,
    pageUrl: demoPageUrl(demo, relay.pageUrl),
    async close() {
      await relay.close();
      if (!options.demo) await demo.close();
    },
  };
}

/**
 * The board linked to `relayPageUrl`, by default with the ?e2e test hook
 * under the demo server's own key, which only a server started with
 * `e2eHook` offers (ADR 0029's notes).
 */
export function demoPageUrl(demo: DemoServer, relayPageUrl: string, e2e = true): string {
  const url = new URL(demo.url);
  url.searchParams.set('relay', relayPageUrl);
  if (e2e) {
    if (demo.e2eKey === null) throw new Error('start the demo server with e2eHook: true');
    url.searchParams.set('e2e', demo.e2eKey);
  }
  return url.href;
}

/**
 * modern pins MCP revision 2026-07-28, whose requests name the client every
 * time; by default the SDK speaks a 2025 revision, which the relay serves on
 * its sessionful leg and names from the client's initialize (ADR 0009). Either
 * way the roster and the audit name the client.
 */
export async function connectMcp(
  relay: Relay,
  user: DevTokenUser,
  name: string,
  options: { modern?: boolean } = {},
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(relay.mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${user.token}` } },
  });
  const client = new Client(
    { name, version: '0.0.0' },
    options.modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  await client.connect(transport);
  return client;
}

export { maskCode, type WidgetTarget } from '@tabdock/adapter/testing';

export interface ToolOutcome {
  isError: boolean;
  text: string;
  structured: unknown;
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome> {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  return {
    isError: result.isError === true,
    text,
    structured: resultJson(text, result.structuredContent),
  };
}

export function errorCode(outcome: ToolOutcome): ErrorCode | null {
  if (!outcome.isError) return null;
  const code = outcome.text.split(':', 1)[0] ?? '';
  return isErrorCode(code) ? code : null;
}

// The dock handle, reached through the demo's ?e2e test hook.

/** The handle's current state, copied out of the page. */
export async function dockState(page: Page): Promise<DockState | null> {
  return page.evaluate(() => window.__tabdockDock?.state ?? null);
}

/** Polls the handle's state until pick returns something, and returns that. */
export async function waitForDock<T>(
  page: Page,
  pick: (state: DockState) => T | null | undefined | false,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const last = await dockState(page);
    const picked = last ? pick(last) : null;
    if (picked !== null && picked !== undefined && picked !== false) return picked;
    if (Date.now() > deadline) {
      throw new Error(
        `the dock did not reach the expected state; link is ${last?.link ?? 'absent'}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Waits for the page to link and returns its page id and current pairing code. */
export async function waitForLink(page: Page): Promise<{ pageId: string; code: string }> {
  return waitForDock(page, (state) =>
    state.link === 'linked' && state.pageId !== null && state.pairing !== null
      ? { pageId: state.pageId, code: state.pairing.code }
      : null,
  );
}

export async function approveThroughHandle(
  page: Page,
  requestId: string,
  role: Role,
): Promise<boolean> {
  return page.evaluate(([id, as]) => window.__tabdockDock?.approve(id, as) ?? false, [
    requestId,
    role,
  ] as const);
}

// Clicking inside the widget's closed shadow root. Page script and Playwright
// selectors cannot reach into it, which is the point; the DevTools protocol
// can. The clicks and text reads go through @tabdock/adapter/testing, which
// finds the button there and clicks its centre with trusted input, as a
// person would, once it is armed and uncovered. The readers below it that
// only tests need keep their own node search over the whole document.

interface DomNode {
  backendNodeId: number;
  localName?: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
}

function attribute(node: DomNode, name: string): string | undefined {
  const list = node.attributes ?? [];
  for (let i = 0; i + 1 < list.length; i += 2) if (list[i] === name) return list[i + 1];
  return undefined;
}

function findNode(node: DomNode, match: (node: DomNode) => boolean): DomNode | null {
  if (match(node)) return node;
  const next = [...(node.children ?? []), ...(node.shadowRoots ?? [])];
  if (node.contentDocument) next.push(node.contentDocument);
  for (const child of next) {
    const found = findNode(child, match);
    if (found) return found;
  }
  return null;
}

/**
 * Runs `run` with a DevTools session of its own. Playwright's CDPSession goes
 * to the helper with no cast: the helper's structural DevToolsSession is what
 * keeps Playwright out of its dependencies, and this typechecks that it fits.
 */
async function withCdp<T>(page: Page, run: (cdp: CDPSession) => Promise<T>): Promise<T> {
  const cdp = await page.context().newCDPSession(page);
  try {
    return await run(cdp);
  } finally {
    await cdp.detach();
  }
}

/** The target's button in the whole document, shadow roots included, within its entry when the target names one. */
function targetButton(root: DomNode, target: WidgetTarget): DomNode | null {
  const scope =
    target.requestId !== undefined
      ? findNode(root, (n) => attribute(n, 'data-request-id') === target.requestId)
      : target.callId !== undefined
        ? findNode(root, (n) => attribute(n, 'data-call-id') === target.callId)
        : target.userId !== undefined
          ? findNode(root, (n) => attribute(n, 'data-user-id') === target.userId)
          : target.inviteId !== undefined
            ? findNode(root, (n) => attribute(n, 'data-invite-id') === target.inviteId)
            : root;
  return scope && findNode(scope, (n) => attribute(n, 'data-action') === target.action);
}

/** Where a click on the target button would land, once it is armed and uncovered. */
export async function widgetButtonCentre(
  page: Page,
  target: WidgetTarget,
  timeoutMs = 5000,
): Promise<{ x: number; y: number }> {
  return withCdp(page, async (cdp) => {
    const { x, y } = await helper.widgetButton(cdp, target, { timeoutMs });
    return { x, y };
  });
}

/**
 * The target button as it is right now, without waiting: whether it is armed
 * (data-armed is not false) and where its centre is. null while it has no box.
 * Specs read a button that is not armed yet with this, so it searches on its own.
 */
export async function widgetButtonNow(
  page: Page,
  target: WidgetTarget,
): Promise<{ armed: boolean; x: number; y: number } | null> {
  return withCdp(page, async (cdp) => {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const button = targetButton(root, target);
    if (!button) return null;
    const { backendNodeId } = button;
    const centre = await cdp
      .send('DOM.scrollIntoViewIfNeeded', { backendNodeId })
      .then(() => cdp.send('DOM.getBoxModel', { backendNodeId }))
      .then(({ model }) => {
        const [x1 = 0, y1 = 0, , , x3 = 0, y3 = 0] = model.content;
        // Whole pixels, as the helper's widgetButton reports and presses them, so the two compare.
        return { x: Math.round((x1 + x3) / 2), y: Math.round((y1 + y3) / 2) };
      })
      .catch(() => null);
    if (!centre) return null;
    return { armed: attribute(button, 'data-armed') !== 'false', ...centre };
  });
}

/** A trusted click on the target button, as the operator would make it, through the helper. */
export async function clickInWidget(page: Page, target: WidgetTarget): Promise<void> {
  await withCdp(page, (cdp) => helper.clickInWidget(cdp, target));
}

/**
 * Moves the keyboard's focus to the target button once it is armed, as Tab
 * would bring it there, so the browser draws its focus ring; an Enter press
 * after it clicks the button with trusted input. For a recording, which
 * draws no pointer: a click alone would show nothing of the press. Returns
 * whether the ring shows (the button matches :focus-visible). It never hit
 * tests, so a fixed button on a scrolled page is found where it is drawn.
 */
export async function focusInWidget(
  page: Page,
  target: WidgetTarget,
  timeoutMs = 5000,
): Promise<boolean> {
  return withCdp(page, async (cdp) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
      const button = targetButton(root, target);
      if (button && attribute(button, 'data-armed') !== 'false') {
        const { object } = await cdp.send('DOM.resolveNode', {
          backendNodeId: button.backendNodeId,
        });
        if (object.objectId !== undefined) {
          const { result } = await cdp.send('Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration:
              'function () { this.focus({ preventScroll: true }); return this.matches(":focus-visible"); }',
            returnByValue: true,
          });
          return result.value === true;
        }
      }
      if (Date.now() > deadline) throw new Error(`no armed ${target.action} button to focus`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
}

/**
 * A script's click on the target button (HTMLElement.click(), so isTrusted is
 * false), as hostile page script would try it if it could reach the button.
 */
export async function scriptClickInWidget(page: Page, target: WidgetTarget): Promise<void> {
  await withCdp(page, async (cdp) => {
    const { backendNodeId } = await helper.widgetButton(cdp, target);
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId });
    if (object.objectId === undefined) throw new Error('could not resolve the widget button');
    await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function () { this.click(); }',
    });
  });
}

/** Whether the widget element with this data-role is rendered, that is, the operator can see it. */
export async function widgetVisible(page: Page, role: string): Promise<boolean> {
  return withCdp(page, async (cdp) => {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const node = findNode(root, (n) => attribute(n, 'data-role') === role);
    if (!node) return false;
    return cdp
      .send('DOM.getBoxModel', { backendNodeId: node.backendNodeId })
      .then(() => true)
      .catch(() => false);
  });
}

/** The text of the widget element with this data-role, read through the helper. */
export async function widgetText(page: Page, role: WidgetRole): Promise<string | null> {
  return withCdp(page, (cdp) => helper.widgetText(cdp, role));
}

/**
 * What a function returns, by value, when run in the page with `this` as the
 * widget node whose data-role is `role`; null while there is no such node.
 * For a spec that needs the widget as it is laid out on screen, which the
 * closed shadow root keeps from page script and from Playwright's selectors.
 */
export async function widgetEvaluate(
  page: Page,
  role: string,
  functionDeclaration: string,
): Promise<unknown> {
  return withCdp(page, async (cdp) => {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const node = findNode(root, (n) => attribute(n, 'data-role') === role);
    if (!node) return null;
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: node.backendNodeId });
    if (object.objectId === undefined) return null;
    const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(`the function threw: ${exceptionDetails.text}`);
    return result.value as unknown;
  });
}

/** One entry of a widget list as the operator sees it: its text, and its data-* attributes for telling entries apart. */
export interface WidgetItem {
  text: string;
  data: Record<string, string>;
}

function isWidgetItem(value: unknown): value is WidgetItem {
  if (typeof value !== 'object' || value === null) return false;
  const { text, data } = value as { text?: unknown; data?: unknown };
  return (
    typeof text === 'string' &&
    typeof data === 'object' &&
    data !== null &&
    Object.values(data).every((entry) => typeof entry === 'string')
  );
}

/**
 * The entries of the widget list with this data-role, in screen order, read
 * through the DevTools protocol: 'roster' gives one row per user (data.userId),
 * 'activity' one line per call, newest first (data.activityId, data.outcome).
 * Empty while the list is not in the widget.
 */
export async function widgetItems(page: Page, role: string): Promise<WidgetItem[]> {
  return withCdp(page, async (cdp) => {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const node = findNode(root, (n) => attribute(n, 'data-role') === role);
    if (!node) return [];
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: node.backendNodeId });
    if (object.objectId === undefined) return [];
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration:
        'function () { return Array.from(this.children, (child) => ({ text: child.textContent, data: Object.assign({}, child.dataset) })); }',
      returnByValue: true,
    });
    const value: unknown = result.value;
    if (!Array.isArray(value) || !value.every(isWidgetItem)) {
      throw new Error(`the widget's ${role} list did not read back as text and data attributes`);
    }
    return value;
  });
}

/** The demo page's own activity strip, newest first. */
export async function activityStrip(page: Page): Promise<string[]> {
  return page.locator('[data-role="log"] li').allTextContents();
}

/**
 * A QR drawing in the widget as the operator sees it: the svg's viewBox and
 * its one path, read through the DevTools protocol; null while there is
 * none. The pairing QR code unless role names another, such as invite-qr.
 */
export async function widgetQrDrawing(
  page: Page,
  role = 'pairing-qr',
): Promise<{ viewBox: string | null; d: string | null } | null> {
  return withCdp(page, async (cdp) => {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const box = findNode(root, (n) => attribute(n, 'data-role') === role);
    const svg = box?.children?.find((child) => child.localName === 'svg');
    // By name, as the light ground is drawn before it.
    const path = svg?.children?.find((child) => child.localName === 'path');
    if (!svg || !path) return null;
    return { viewBox: attribute(svg, 'viewBox') ?? null, d: attribute(path, 'd') ?? null };
  });
}

/**
 * The text of one widget box as the operator reads it: the prompt for a
 * request or call, a roster row, or a live invite's row, read through the
 * DevTools protocol. null while there is no such box.
 */
export async function widgetBoxText(
  page: Page,
  target: Omit<WidgetTarget, 'action'>,
): Promise<string | null> {
  const [name, value] =
    target.requestId !== undefined
      ? ['data-request-id', target.requestId]
      : target.callId !== undefined
        ? ['data-call-id', target.callId]
        : target.userId !== undefined
          ? ['data-user-id', target.userId]
          : ['data-invite-id', target.inviteId ?? ''];
  return withCdp(page, async (cdp) => {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const node = findNode(root, (n) => attribute(n, name) === value);
    if (!node) return null;
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: node.backendNodeId });
    if (object.objectId === undefined) return null;
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function () { return this.textContent; }',
      returnByValue: true,
    });
    return typeof result.value === 'string' ? result.value : null;
  });
}

/** Types into a widget input as the operator would: a real click to focus it, then keys. */
export async function typeInWidget(page: Page, action: WidgetAction, text: string): Promise<void> {
  await clickInWidget(page, { action });
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(text);
}

/**
 * Mints an invite with the widget's Invite form, every step a real click or
 * key as the operator makes it (ADR 0016): the label, Can watch or Can
 * control, the uses for Can watch, then Create. Returns the link the widget
 * shows once, read from its text before Done clears it, and the invite's id
 * from the page's own record.
 */
export async function mintInWidget(
  page: Page,
  options: { label: string; role: Role; uses?: number },
): Promise<{ inviteId: string; link: string }> {
  const before = new Set((await dockState(page))?.invites.map((invite) => invite.inviteId) ?? []);
  await clickInWidget(page, { action: 'invite-open' });
  await typeInWidget(page, 'invite-label', options.label);
  if (options.role === 'driver') await clickInWidget(page, { action: 'invite-role-driver' });
  else if (options.uses !== undefined) {
    await typeInWidget(page, 'invite-uses', String(options.uses));
  }
  await clickInWidget(page, { action: 'invite-create' });
  const minted = await waitForDock(page, (state) =>
    state.invites.find(
      (invite) =>
        !before.has(invite.inviteId) &&
        invite.label === options.label &&
        invite.role === options.role,
    ),
  );
  // The relay lists the invite before the widget draws its link, so wait for the text too.
  const deadline = Date.now() + 10_000;
  let link = '';
  while (link === '') {
    link = (await widgetText(page, 'invite-link-text')) ?? '';
    if (link !== '') break;
    if (Date.now() > deadline) throw new Error('the widget never showed the invite link');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await clickInWidget(page, { action: 'invite-done' });
  return { inviteId: minted.inviteId, link };
}

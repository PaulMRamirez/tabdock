// Shared setup for Tabdock in a real browser: the relay on a free port with
// throwaway dev tokens, the demo page served beside it and opened with ?relay
// and ?e2e, and MCP clients from the official SDK with a bearer header. The
// Playwright specs, the milestone demos and the Claude Code checks all use it.

import { randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CDPSession, Page } from '@playwright/test';
import type { Dock, DockState, Role } from '@tabdock/adapter';
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
  const demo = options.demo ?? (await startDemoServer());
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
    pageUrl: demoPageUrl(demo.url, relay.pageUrl),
    async close() {
      await relay.close();
      if (!options.demo) await demo.close();
    },
  };
}

export function demoPageUrl(demoUrl: string, relayPageUrl: string, e2e = true): string {
  const url = new URL(demoUrl);
  url.searchParams.set('relay', relayPageUrl);
  if (e2e) url.searchParams.set('e2e', '');
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

/** A pairing code with its second half hidden, for narration that may end up in a CI log (S11). */
export function maskCode(code: string): string {
  const split = code.indexOf('-');
  return split === -1
    ? '*'.repeat(code.length)
    : `${code.slice(0, split + 1)}${'*'.repeat(code.length - split - 1)}`;
}

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
  return { isError: result.isError === true, text, structured: result.structuredContent };
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
// can, so a test finds the button there and clicks its centre with a real
// mouse event, as a person would.

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

export interface WidgetTarget {
  /**
   * A data-action value: approve-driver, approve-observer, deny, confirm-allow,
   * confirm-deny, rotate, toggle; make-driver, make-observer, revoke and
   * close-link in a roster row; revoke-all; pause or resume; from M4
   * invite-open, invite-close, invite-label, invite-role-observer,
   * invite-role-driver, invite-lifetime-15m, -1h and -open, invite-uses,
   * invite-create, invite-copy, invite-done, and cancel-invite in a list row.
   */
  action: string;
  /** Narrows to the prompt box for one attach request. */
  requestId?: string;
  /** Narrows to the prompt box for one consequential call. */
  callId?: string;
  /** Narrows to one user's roster row. */
  userId?: string;
  /** Narrows to one invite's row in the live list (M4). */
  inviteId?: string;
}

async function withCdp<T>(page: Page, run: (cdp: CDPSession) => Promise<T>): Promise<T> {
  const cdp = await page.context().newCDPSession(page);
  try {
    return await run(cdp);
  } finally {
    await cdp.detach();
  }
}

async function findButton(cdp: CDPSession, target: WidgetTarget): Promise<DomNode | null> {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
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

/** The centre of a node's box, or null while it has none (a button in a hidden panel). */
async function boxCentre(
  cdp: CDPSession,
  backendNodeId: number,
): Promise<{ x: number; y: number } | null> {
  return cdp
    .send('DOM.scrollIntoViewIfNeeded', { backendNodeId })
    .then(() => cdp.send('DOM.getBoxModel', { backendNodeId }))
    .then(({ model }) => {
      const [x1 = 0, y1 = 0, , , x3 = 0, y3 = 0] = model.content;
      return { x: (x1 + x3) / 2, y: (y1 + y3) / 2 };
    })
    .catch(() => null);
}

/**
 * Waits until the target button exists, is armed and is what a click on its
 * centre would hit, then returns that centre. A prompt box's buttons ignore
 * clicks until data-armed turns true, half a second after the box appeared or
 * last moved, so a prompt that slides under the pointer cannot take the click.
 */
async function armedButton(
  cdp: CDPSession,
  target: WidgetTarget,
  timeoutMs: number,
): Promise<{ backendNodeId: number; x: number; y: number }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const button = await findButton(cdp, target);
    if (button && attribute(button, 'data-armed') !== 'false') {
      const { backendNodeId } = button;
      const centre = await boxCentre(cdp, backendNodeId);
      if (centre) {
        // Hit-test first, so a layout shift can never turn this into a click on another button.
        const hit = await cdp.send('DOM.getNodeForLocation', {
          x: Math.round(centre.x),
          y: Math.round(centre.y),
          ignorePointerEventsNone: true,
        });
        // The hit may be a label inside the button, such as the badge's text.
        if (findNode(button, (n) => n.backendNodeId === hit.backendNodeId)) {
          return { backendNodeId, ...centre };
        }
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`no clickable ${target.action} button in the Tabdock widget`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Where a click on the target button would land, once it is armed and uncovered. */
export async function widgetButtonCentre(
  page: Page,
  target: WidgetTarget,
  timeoutMs = 5000,
): Promise<{ x: number; y: number }> {
  return withCdp(page, async (cdp) => {
    const { x, y } = await armedButton(cdp, target, timeoutMs);
    return { x, y };
  });
}

/**
 * The target button as it is right now, without waiting: whether it is armed
 * (data-armed is not false) and where its centre is. null while it has no box.
 */
export async function widgetButtonNow(
  page: Page,
  target: WidgetTarget,
): Promise<{ armed: boolean; x: number; y: number } | null> {
  return withCdp(page, async (cdp) => {
    const button = await findButton(cdp, target);
    const centre = button && (await boxCentre(cdp, button.backendNodeId));
    if (!button || !centre) return null;
    return { armed: attribute(button, 'data-armed') !== 'false', ...centre };
  });
}

/** A real mouse click on the target button, as the operator would make it. */
export async function clickInWidget(page: Page, target: WidgetTarget): Promise<void> {
  const { x, y } = await widgetButtonCentre(page, target);
  await page.mouse.click(x, y);
}

/**
 * A script's click on the target button (HTMLElement.click(), so isTrusted is
 * false), as hostile page script would try it if it could reach the button.
 */
export async function scriptClickInWidget(page: Page, target: WidgetTarget): Promise<void> {
  await withCdp(page, async (cdp) => {
    const { backendNodeId } = await armedButton(cdp, target, 5000);
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

/** The text of the widget element with this data-role, read through the DevTools protocol. */
export async function widgetText(page: Page, role: string): Promise<string | null> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const node = findNode(root, (n) => attribute(n, 'data-role') === role);
    if (!node) return null;
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: node.backendNodeId });
    if (object.objectId === undefined) return null;
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function () { return this.textContent; }',
      returnByValue: true,
    });
    return typeof result.value === 'string' ? result.value : null;
  } finally {
    await cdp.detach();
  }
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

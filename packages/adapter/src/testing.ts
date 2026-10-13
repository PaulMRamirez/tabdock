// @tabdock/adapter/testing (ADR 0041): a test reads the widget's pairing code
// and answers its prompts through the DevTools protocol, as a person at the
// page would. The widget lives in a closed shadow root that page script and a
// browser driver's selectors cannot reach, by design; the DevTools protocol
// can, so this finds a button there and clicks its centre with trusted input.
//
// It approves nothing a person could not: it clicks only a button whose box
// has held still (data-armed, the widget's 500 ms wait) and that a hit test
// says a click at its centre would reach, and checks both again just before
// the press. It presses nothing when more than one button matches what it was
// asked for, so a click naming no request never approves whichever of two
// prompts comes first, and allowAttach approves an attach request only when
// exactly one waiting request carries the client name or request id it was
// given. It reads only the closed shadow root of the one tabdock-dock host in
// the main document, never light DOM or a frame, so a page's own element
// named like the widget's cannot pass for it. No setting or hook approves
// without the click (S4; option C stays rejected).
//
// It runs nothing in the page. It reads the widget from the tree
// DOM.getDocument sends, text included, and presses with trusted input, so a
// script loaded after attach() that patched a DOM prototype is handed none of
// the widget's nodes, as the widget itself takes care of (widget.ts): a
// function run on a node through Runtime.callFunctionOn runs in the page's
// own world and would hand that script the node, and through it the closed
// shadow root.
//
// It takes any DevTools session through a structural type, so Playwright,
// Puppeteer or a plain socket wrapper all fit and none is a dependency, and it
// checks every reply it acts on with @tabdock/protocol/devtools. It never
// logs, and no error it throws quotes text it read from the page: a pairing
// code, a prompt or a client name in a CI log is a secret in a log (S11).
// It imports nothing that touches the DOM, and the script-tag build never
// imports it.

import { PairingCodeSchema, type Role, RoleSchema } from '@tabdock/protocol';
import {
  DevToolsBoxModelSchema,
  DevToolsDocumentSchema,
  DevToolsLayoutMetricsSchema,
  type DevToolsNode,
  DevToolsNodeAtSchema,
} from '@tabdock/protocol/devtools';
import { HOST_TAG, WIDGET_ACTIONS, type WidgetAction, type WidgetRole } from './widget-names.ts';

export {
  HOST_TAG,
  WIDGET_ACTIONS,
  WIDGET_ROLES,
  type WidgetAction,
  type WidgetRole,
} from './widget-names.ts';

/** How long readPairingCode waits for the widget to show a code. */
const READ_CODE_TIMEOUT_MS = 10_000;
/** How long allowAttach waits for its prompt; under pair_page's own 50 s wait and a request's 60 s life. */
const ALLOW_TIMEOUT_MS = 20_000;
/** How long widgetButton and clickInWidget wait for a button to be clickable. */
const BUTTON_TIMEOUT_MS = 5_000;
const POLL_MS = 100;
/** How long allowAttach waits, after its click, for the prompt to go. */
const DECIDED_TIMEOUT_MS = 5_000;

/**
 * Any DevTools protocol session: Playwright's CDPSession and Puppeteer's fit
 * as they are. Method syntax, so a session whose send is typed per method
 * still assigns.
 */
export interface DevToolsSession {
  send(method: string, params?: object): Promise<unknown>;
}

export interface WaitOptions {
  /** How long to wait before giving up, in milliseconds: finite, and 0 or more. */
  timeoutMs?: number;
}

/**
 * The wait the options name, or the default. Throws for a wait that is not a
 * finite count of milliseconds, 0 or more: one of NaN, as Number() gives for
 * an unset variable, would never end, since no time is at or past NaN.
 */
function waitOf(options: WaitOptions, fallback: number): number {
  const timeoutMs: unknown = options.timeoutMs ?? fallback;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError('timeoutMs must be a finite number of milliseconds, 0 or more');
  }
  return timeoutMs;
}

/**
 * A widget button, by its data-action, optionally inside one box. The helper
 * presses only a button the target matches alone.
 */
export interface WidgetTarget {
  action: WidgetAction;
  /** Inside the prompt for one attach request. */
  requestId?: string;
  /** Inside the prompt for one consequential call. */
  callId?: string;
  /** Inside one user's roster row. */
  userId?: string;
  /** Inside one invite's row in the live list. */
  inviteId?: string;
  /** Inside one proposal's row in the queue (ADR 0042), whose Accept and Dismiss every row repeats. */
  proposalId?: string;
}

/** Which attach request to approve, and as what: by its client's name, or by its id. */
export type AllowAttachOptions = WaitOptions & { as: Role } & (
    { client: string; requestId?: never } | { requestId: string; client?: never }
  );

/** The prompts waiting on the widget now. */
export interface WaitingPrompts {
  /** Attach requests, with the client's name as the prompt shows it, or null when it gave none. */
  attach: { requestId: string; client: string | null }[];
  /** Consequential calls waiting for Allow or Deny. */
  confirm: { callId: string }[];
}

/** What the helper throws: a count, an action or a timeout, never text it read from the page. */
export class WidgetTestError extends Error {
  override name = 'WidgetTestError';
}

/** A pairing code with its second half hidden, for narration that may end up in a CI log (S11). */
export function maskCode(code: string): string {
  const split = code.indexOf('-');
  return split === -1
    ? '*'.repeat(code.length)
    : `${code.slice(0, split + 1)}${'*'.repeat(code.length - split - 1)}`;
}

interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/** A reply checked before anything acts on it; a malformed one stops the helper rather than steer a click. */
function checked<T>(method: string, reply: unknown, schema: Schema<T>): T {
  const parsed = schema.safeParse(reply);
  if (!parsed.success) {
    throw new WidgetTestError(`the DevTools protocol answered ${method} in an unexpected shape`);
  }
  return parsed.data;
}

async function ask<T>(
  cdp: DevToolsSession,
  method: string,
  params: object,
  schema: Schema<T>,
): Promise<T> {
  return checked(method, await cdp.send(method, params), schema);
}

/**
 * As ask, but null when the browser refuses the command, as it does for a
 * node with no box or a point off the page; a reply it does send is checked.
 */
async function askOrNull<T>(
  cdp: DevToolsSession,
  method: string,
  params: object,
  schema: Schema<T>,
): Promise<T | null> {
  let reply: unknown;
  try {
    reply = await cdp.send(method, params);
  } catch {
    return null;
  }
  return checked(method, reply, schema);
}

function attribute(node: DevToolsNode, name: string): string | undefined {
  const list = node.attributes ?? [];
  for (let i = 0; i + 1 < list.length; i += 2) if (list[i] === name) return list[i + 1];
  return undefined;
}

/** Every node under the widget's root in document order; the widget's own tree holds no frame or shadow root of its own. */
function* widgetNodes(node: DevToolsNode): Generator<DevToolsNode> {
  for (const child of node.children ?? []) {
    yield child;
    yield* widgetNodes(child);
  }
}

function find(within: DevToolsNode, match: (node: DevToolsNode) => boolean): DevToolsNode | null {
  for (const node of widgetNodes(within)) if (match(node)) return node;
  return null;
}

/** Every element named like the widget's host in the main document, shadow trees included and frames left out. */
function hosts(node: DevToolsNode, found: DevToolsNode[] = []): DevToolsNode[] {
  if (node.localName === HOST_TAG) found.push(node);
  for (const next of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) hosts(next, found);
  return found;
}

/**
 * The widget's closed shadow root, or null while no host is in the page.
 * Throws for two hosts, or for one without a closed shadow root: the adapter
 * attaches its root before placing the host, so neither is the widget.
 */
async function widgetRoot(cdp: DevToolsSession): Promise<DevToolsNode | null> {
  const { root } = await ask(
    cdp,
    'DOM.getDocument',
    { depth: -1, pierce: true },
    DevToolsDocumentSchema,
  );
  const found = hosts(root);
  if (found.length > 1) throw new WidgetTestError('more than one Tabdock widget on the page');
  const [host] = found;
  if (host === undefined) return null;
  const shadow = (host.shadowRoots ?? []).find((node) => node.shadowRootType === 'closed');
  if (shadow === undefined) {
    throw new WidgetTestError('the Tabdock widget host on the page has no closed shadow root');
  }
  return shadow;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** The DOM's numbers for a text node and a CDATA section, the nodes whose value is text. */
const TEXT_NODES: readonly (number | undefined)[] = [3, 4];

/** The text under a node, in document order, as textContent joins it, from values DevTools already sent. */
function textUnder(node: DevToolsNode): string {
  let text = '';
  for (const inner of widgetNodes(node)) {
    if (TEXT_NODES.includes(inner.nodeType)) text += inner.nodeValue ?? '';
  }
  return text;
}

/**
 * The text of the widget node with this data-role, or null while the widget
 * or the node is absent. DevTools leaves text nodes of whitespace alone out of
 * its tree and cuts one at 10,000 characters, so two runs the widget sets
 * apart with a lone space read joined; the pairing code is one text node.
 */
export async function widgetText(cdp: DevToolsSession, role: WidgetRole): Promise<string | null> {
  const widget = await widgetRoot(cdp);
  const node = widget && find(widget, (n) => attribute(n, 'data-role') === role);
  return node === null ? null : textUnder(node);
}

/**
 * The pairing code the widget shows, once it shows one the protocol accepts.
 * Never print it: pass it to pair_page, and narrate it with maskCode.
 */
export async function readPairingCode(
  cdp: DevToolsSession,
  options: WaitOptions = {},
): Promise<string> {
  const timeoutMs = waitOf(options, READ_CODE_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const code = PairingCodeSchema.safeParse(await widgetText(cdp, 'pairing-code'));
    if (code.success) return code.data;
    if (Date.now() >= deadline) {
      throw new WidgetTestError(`the widget showed no pairing code within ${String(timeoutMs)} ms`);
    }
    await sleep(POLL_MS);
  }
}

function attachPrompts(widget: DevToolsNode): WaitingPrompts['attach'] {
  const prompts: WaitingPrompts['attach'] = [];
  for (const node of widgetNodes(widget)) {
    const requestId = attribute(node, 'data-request-id');
    if (requestId !== undefined) {
      prompts.push({ requestId, client: attribute(node, 'data-client-name') ?? null });
    }
  }
  return prompts;
}

/**
 * The prompts waiting on the widget now. A walk that expects none fails fast
 * on a confirm prompt rather than waiting out its deadline: the page prompts
 * for a write, so it should set consequential or consequentialTools (ADR 0034).
 */
export async function waitingPrompts(cdp: DevToolsSession): Promise<WaitingPrompts> {
  const widget = await widgetRoot(cdp);
  if (widget === null) return { attach: [], confirm: [] };
  const confirm: WaitingPrompts['confirm'] = [];
  for (const node of widgetNodes(widget)) {
    const callId = attribute(node, 'data-call-id');
    if (callId !== undefined) confirm.push({ callId });
  }
  return { attach: attachPrompts(widget), confirm };
}

/**
 * The target's button, or null while there is none. Throws, so nothing is
 * pressed, when more than one carries the action where the target looks: a
 * target naming no box, with two attach prompts waiting, must not approve
 * whichever comes first (allowAttach's rule, for every click).
 */
function findButton(widget: DevToolsNode, target: WidgetTarget): DevToolsNode | null {
  const scoped: [string, string | undefined][] = [
    ['data-request-id', target.requestId],
    ['data-call-id', target.callId],
    ['data-user-id', target.userId],
    ['data-invite-id', target.inviteId],
    ['data-proposal-id', target.proposalId],
  ];
  const [name, value] = scoped.find(([, id]) => id !== undefined) ?? [null, undefined];
  const scope = name === null ? widget : find(widget, (n) => attribute(n, name) === value);
  if (scope === null) return null;
  const found = [...widgetNodes(scope)].filter(
    (n) => attribute(n, 'data-action') === target.action,
  );
  if (found.length > 1) {
    throw new WidgetTestError(
      `${String(found.length)} ${target.action} buttons match, so none is pressed`,
    );
  }
  return found[0] ?? null;
}

function contains(node: DevToolsNode, backendNodeId: number): boolean {
  if (node.backendNodeId === backendNodeId) return true;
  for (const inner of widgetNodes(node)) if (inner.backendNodeId === backendNodeId) return true;
  return false;
}

interface ButtonAt {
  backendNodeId: number;
  x: number;
  y: number;
}

/** Where the visual viewport sits in the document, and how much of it shows. */
interface ViewportPlace {
  pageX: number;
  pageY: number;
  width: number;
  height: number;
  /**
   * On each axis, how far the hit test would sit from the press if an element
   * scrolled to its very end in the document's place were counted as the
   * document's scroll: the gap between the two readings where it matched the
   * scroll range (within RANGE_SLACK_PX), else 0. See viewportPlace.
   */
  farEnd: { x: number; y: number };
}

/**
 * How far apart Chromium's readings may sit and still agree. The layout
 * viewport's position is rounded up to a whole pixel, and float rounding under
 * a pinch zoom adds a hair, so a gap just under a pixel is ordinary.
 */
const SCROLL_SLACK_PX = 1.01;
/**
 * The same against the scroll range, which also carries the floor of the
 * content size and a client size that loses a pixel to rounding at a device
 * scale such as 1.25 or 1.75: up to 1.6 px was seen on ordinary pages.
 */
const RANGE_SLACK_PX = 3;

/**
 * The visual viewport's place, or null if DevTools gave none. Its pageX and
 * pageY count the document's scroll from its scroll origin, plus the visual
 * viewport's own offset, which is the very offset the hit test takes away,
 * while the layout viewport's count from the left and top edge of the scroll
 * range. The origin sits at that edge, or at the far end of the range on a
 * right-to-left page or one that scrolls up from the bottom (a vertical
 * writing mode read bottom to top), so on each axis the two differ by nothing
 * or by the whole range. Anything else means Chrome counts the scroll of an
 * element that scrolls in the document's place (Android's implicit root
 * scroller) where the hit test does not, so a check could land beside the
 * press: that throws, since the helper cannot tell where a press would land.
 * Such an element scrolled to its very end matches the range too, and its
 * check would land the whole range from the press; farEnd carries that
 * distance so clickable can check the press point itself as well.
 */
async function viewportPlace(cdp: DevToolsSession): Promise<ViewportPlace | null> {
  const metrics = await askOrNull(cdp, 'Page.getLayoutMetrics', {}, DevToolsLayoutMetricsSchema);
  if (metrics === null) return null;
  const { cssLayoutViewport: layout, cssVisualViewport: view, cssContentSize: size } = metrics;
  /** The gap's distance from the press if it is the range, 0 if it is nothing, or null if neither. */
  const farEnd = (gap: number, range: number): number | null => {
    if (Math.abs(gap) <= SCROLL_SLACK_PX) return 0;
    if (Math.abs(gap - range) <= RANGE_SLACK_PX) return gap;
    return null;
  };
  const x = farEnd(layout.pageX + view.offsetX - view.pageX, size.width - layout.clientWidth);
  const y = farEnd(layout.pageY + view.offsetY - view.pageY, size.height - layout.clientHeight);
  if (x === null || y === null) {
    throw new WidgetTestError(
      'the page scrolls an element in place of the document (an implicit root scroller), so the helper cannot tell where a press would land',
    );
  }
  return {
    pageX: view.pageX,
    pageY: view.pageY,
    width: view.clientWidth,
    height: view.clientHeight,
    farEnd: { x, y },
  };
}

/** Whether a hit test at this document point names the button or a label inside it. */
async function hitsButton(
  cdp: DevToolsSession,
  button: DevToolsNode,
  point: { x: number; y: number },
): Promise<boolean> {
  const hit = await askOrNull(
    cdp,
    'DOM.getNodeForLocation',
    { ...point, ignorePointerEventsNone: true },
    DevToolsNodeAtSchema,
  );
  return hit !== null && contains(button, hit.backendNodeId);
}

/**
 * The target button and the point a click would take, if it is armed now,
 * that point shows in the viewport, and a hit test at that point lands on it
 * (or on a label inside it); null if not yet. `guard` sees the widget first
 * and may throw.
 *
 * The box and the press count from the visual viewport's corner, the hit test
 * from the document's, so on a scrolled page the hit test is moved by the
 * viewport's place in the document: otherwise it checks a spot as far from
 * the press as the page has scrolled, and may wave through a covered button.
 * That place is read before the box and again after the hit test; when a
 * scroll between them has moved one off the other, the button is not clickable
 * yet. Where the readings leave an element scrolled to its very end possible
 * (see viewportPlace), the point that would then be the press is checked too,
 * unless that gap is longer than the button's border box (the area a hit test
 * counts as the button) reaches from the press, plus a pixel for rounding: the
 * first check would then have missed the button, so the gap is a document's.
 */
async function clickable(
  cdp: DevToolsSession,
  target: WidgetTarget,
  guard?: (widget: DevToolsNode) => void,
): Promise<ButtonAt | null> {
  const widget = await widgetRoot(cdp);
  if (widget === null) return null;
  guard?.(widget);
  const button = findButton(widget, target);
  if (button === null || attribute(button, 'data-armed') === 'false') return null;
  const { backendNodeId } = button;
  await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => undefined);
  const before = await viewportPlace(cdp);
  if (before === null) return null;
  const box = await askOrNull(cdp, 'DOM.getBoxModel', { backendNodeId }, DevToolsBoxModelSchema);
  if (box === null) return null;
  const [x1 = 0, y1 = 0, , , x3 = 0, y3 = 0] = box.model.content;
  const { border } = box.model;
  // The hit test takes whole pixels of the document and the press any point of
  // the viewport, so the press goes to the very point the hit test checks.
  const page = {
    x: Math.round((x1 + x3) / 2 + before.pageX),
    y: Math.round((y1 + y3) / 2 + before.pageY),
  };
  const at = { x: page.x - before.pageX, y: page.y - before.pageY };
  // A press outside the viewport reaches nothing, though a hit test there may
  // still find the button in the document.
  if (at.x < 0 || at.y < 0 || at.x >= before.width || at.y >= before.height) return null;
  if (!(await hitsButton(cdp, button, page))) return null;
  // How far the border box reaches from the press on each axis, taken over all
  // four corners, so that a turned box is measured by what it can cover.
  const reach = (from: number, corners: number[]): number =>
    Math.max(from - Math.min(...corners), Math.max(...corners) - from);
  const xs = border.filter((_, i) => i % 2 === 0);
  const ys = border.filter((_, i) => i % 2 === 1);
  const near = (distance: number, within: number): number =>
    Math.abs(distance) <= within + 1 ? Math.round(distance) : 0;
  const shift = {
    x: near(before.farEnd.x, reach(at.x, xs)),
    y: near(before.farEnd.y, reach(at.y, ys)),
  };
  if (shift.x !== 0 || shift.y !== 0) {
    const alsoAt = { x: page.x + shift.x, y: page.y + shift.y };
    if (!(await hitsButton(cdp, button, alsoAt))) return null;
  }
  const after = await viewportPlace(cdp);
  if (after === null || after.pageX !== before.pageX || after.pageY !== before.pageY) return null;
  return { backendNodeId, ...at };
}

function checkTarget(target: WidgetTarget): void {
  if (!(WIDGET_ACTIONS as readonly string[]).includes(target.action)) {
    throw new TypeError('the target names no action the widget has');
  }
}

/**
 * Waits until the target button is armed and is what a click on its centre
 * would hit, and returns it with that point.
 */
export async function widgetButton(
  cdp: DevToolsSession,
  target: WidgetTarget,
  options: WaitOptions = {},
): Promise<ButtonAt> {
  checkTarget(target);
  const timeoutMs = waitOf(options, BUTTON_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await clickable(cdp, target);
    if (found !== null) return found;
    if (Date.now() >= deadline) {
      throw new WidgetTestError(
        `no armed ${target.action} button a click would reach within ${String(timeoutMs)} ms`,
      );
    }
    await sleep(POLL_MS);
  }
}

async function mouse(
  cdp: DevToolsSession,
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
  at: ButtonAt,
): Promise<void> {
  await cdp.send('Input.dispatchMouseEvent', {
    type,
    x: at.x,
    y: at.y,
    button: type === 'mouseMoved' ? 'none' : 'left',
    buttons: type === 'mousePressed' ? 1 : 0,
    clickCount: type === 'mouseMoved' ? 0 : 1,
  });
}

/** Moves to the button, checks it again where the pointer now is, and only then presses. */
async function press(
  cdp: DevToolsSession,
  target: WidgetTarget,
  timeoutMs: number,
  guard?: (widget: DevToolsNode) => void,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const aimed = await clickable(cdp, target, guard);
    if (aimed !== null) {
      await mouse(cdp, 'mouseMoved', aimed);
      const now = await clickable(cdp, target, guard);
      // Within a pixel, and at the point just checked: where the viewport's
      // place is fractional, as at a device scale of 1.25, a scroll between the
      // two checks moves the press point by a fraction though the button has
      // not moved, and a page scrolling every frame would otherwise never settle.
      if (
        now !== null &&
        now.backendNodeId === aimed.backendNodeId &&
        Math.abs(now.x - aimed.x) < 1 &&
        Math.abs(now.y - aimed.y) < 1
      ) {
        await mouse(cdp, 'mousePressed', now);
        await mouse(cdp, 'mouseReleased', now);
        return;
      }
    }
    if (Date.now() >= deadline) {
      throw new WidgetTestError(
        `no armed ${target.action} button a click would reach within ${String(timeoutMs)} ms`,
      );
    }
    await sleep(POLL_MS);
  }
}

/**
 * A trusted click on the target button, as the operator would make it: once
 * it is armed and uncovered, and again just before the press.
 */
export async function clickInWidget(
  cdp: DevToolsSession,
  target: WidgetTarget,
  options: WaitOptions = {},
): Promise<void> {
  checkTarget(target);
  await press(cdp, target, waitOf(options, BUTTON_TIMEOUT_MS));
}

/**
 * Clicks Allow as driver or Allow as observer on the one waiting attach
 * request whose client name, as the prompt shows it, equals `client` exactly,
 * or whose id is `requestId`; returns its request id once the prompt has gone.
 * Throws, clicking nothing, when more than one request matches, before or at
 * the press: CI must never approve an attach it cannot tell apart.
 */
export async function allowAttach(
  cdp: DevToolsSession,
  options: AllowAttachOptions,
): Promise<string> {
  const { as, client, requestId: wanted } = options;
  if (!RoleSchema.safeParse(as).success) throw new TypeError('as must be driver or observer');
  if ((client === undefined) === (wanted === undefined)) {
    throw new TypeError('allowAttach takes a client name or a request id, and not both');
  }
  if (client === '' || wanted === '') throw new TypeError('the client name or request id is empty');
  const timeoutMs = waitOf(options, ALLOW_TIMEOUT_MS);
  /** The one matching request's id, null for none; throws for more than one. */
  const unique = (widget: DevToolsNode): string | null => {
    const found = attachPrompts(widget).filter((prompt) =>
      client !== undefined ? prompt.client === client : prompt.requestId === wanted,
    );
    if (found.length > 1) {
      throw new WidgetTestError(
        `${String(found.length)} waiting attach requests match, so none is approved`,
      );
    }
    return found[0]?.requestId ?? null;
  };
  const deadline = Date.now() + timeoutMs;
  const requestId = await (async (): Promise<string> => {
    for (;;) {
      const widget = await widgetRoot(cdp);
      const found = widget && unique(widget);
      if (found !== null) return found;
      if (Date.now() >= deadline) {
        throw new WidgetTestError(
          `no waiting attach request matched within ${String(timeoutMs)} ms`,
        );
      }
      await sleep(POLL_MS);
    }
  })();
  const action = as === 'driver' ? 'approve-driver' : 'approve-observer';
  await press(cdp, { action, requestId }, Math.max(0, deadline - Date.now()), unique);
  const decided = Date.now() + DECIDED_TIMEOUT_MS;
  for (;;) {
    const widget = await widgetRoot(cdp);
    const box = widget && find(widget, (n) => attribute(n, 'data-request-id') === requestId);
    if (box === null) return requestId;
    if (Date.now() >= decided) {
      throw new WidgetTestError(
        `the attach prompt stayed for ${String(DECIDED_TIMEOUT_MS)} ms after its ${action} click`,
      );
    }
    await sleep(POLL_MS);
  }
}

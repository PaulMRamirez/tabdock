// The teacher at the projected tab in pnpm demo:m6: the canvas map page in
// headless Chromium, linked through its own connect hook and driven only as
// a person would drive it, since the page puts no handle on window (ADR
// 0038). Every read of the widget goes through the DevTools protocol into
// its closed shadow root, and every click through @tabdock/adapter/testing,
// which presses a button only once it has held still and a hit test says the
// click lands on it (ADR 0041). Pairing codes and links read here go to the
// narrator as secrets before anything prints them.

import type { Browser, BrowserContext, Page } from '@playwright/test';
import { allowAttach } from '@tabdock/adapter/testing';
import type { PolicyInput, Role } from '@tabdock/protocol';
import { connectMapPage, mapPairingCode, openMapPage } from '../map-harness.ts';
import {
  clickInWidget,
  typeInWidget,
  widgetEvaluate,
  widgetText,
  widgetVisible,
} from '../tabdock-harness.ts';
import type { Narrator } from './narrator.ts';

// Tall enough that the widget's panel never scrolls a prompt out from under the pointer.
const LAPTOP = { viewport: { width: 1280, height: 1200 } };

export interface OperatorTab {
  readonly context: BrowserContext;
  readonly page: Page;
  /** A pairing code no pairing has used up yet, once the widget shows one. */
  freshCode(): Promise<string>;
  /** Marks a code a pairing used up; the relay shows a new one in its place. */
  usedUp(code: string): void;
  close(): Promise<void>;
}

/**
 * Opens the map page in a context of its own and links it to the relay
 * through its connect hook with `policy`; with `clock`, Playwright's clock is
 * installed first, so the demo can move the page's time and nothing else's.
 */
export async function openOperatorTab(
  browser: Browser,
  narrator: Narrator,
  options: {
    mapUrl: string;
    relayPageUrl: string;
    /** Where the page's console lines go, so the run can scan them for secrets at the end. */
    console: string[];
    policy?: PolicyInput;
    clock?: boolean;
  },
): Promise<OperatorTab> {
  const context = await browser.newContext(LAPTOP);
  const page = await context.newPage();
  page.on('console', (message) => options.console.push(message.text()));
  page.on('pageerror', (error) => options.console.push(error.message));
  if (options.clock === true) await page.clock.install();
  await openMapPage(page, options.mapUrl);
  if (!(await connectMapPage(page, options.relayPageUrl, options.policy))) {
    throw new Error('the map page refused to link');
  }
  const used = new Set<string>();
  return {
    context,
    page,
    async freshCode() {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const code = await mapPairingCode(page);
        narrator.remember(code);
        if (!used.has(code)) return code;
        if (Date.now() > deadline) throw new Error('the widget showed no fresh pairing code');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    usedUp(code) {
      used.add(code);
    },
    async close() {
      await context.close();
    },
  };
}

/** The map page's own status line, which names the link's state. */
export async function linkStatus(page: Page): Promise<string> {
  return (await page.locator('[data-role="status"]').textContent()) ?? '';
}

/** Waits for the status line to say the page is linked, as it does again after a reconnect. */
export async function waitLinked(page: Page, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await linkStatus(page)).endsWith(': linked')) {
    if (Date.now() > deadline) throw new Error('the map page did not link again');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Opens the widget's panel unless it is open; it opens by itself only while nobody is attached. */
export async function openPanel(page: Page): Promise<void> {
  if (!(await widgetVisible(page, 'pause-box'))) await clickInWidget(page, { action: 'toggle' });
}

/**
 * Clicks Allow as `role` on the one prompt from a client of this name, as
 * the operator does, through the published helper, which approves nothing
 * it cannot tell apart from another prompt.
 */
export async function allowIn(page: Page, client: string, role: Role): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await allowAttach(cdp, { as: role, client, timeoutMs: 15_000 });
  } finally {
    await cdp.detach();
  }
}

/** Waits until a widget line's text passes `test`, and returns it. */
export async function widgetTextWhen(
  page: Page,
  role: Parameters<typeof widgetText>[1],
  test: (text: string) => boolean,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = (await widgetText(page, role)) ?? '';
    if (test(text)) return text;
    if (Date.now() > deadline)
      throw new Error(`the widget's ${role} did not show what was expected`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Mints a Can watch link with the widget's Invite form, every step a real
 * click or key, and returns the link it shows once, read before Done clears
 * it. The link's secret goes to the narrator first.
 */
export async function mintWatchLink(
  page: Page,
  narrator: Narrator,
  label: string,
  uses: number,
): Promise<string> {
  await openPanel(page);
  await clickInWidget(page, { action: 'invite-open' });
  await typeInWidget(page, 'invite-label', label);
  await typeInWidget(page, 'invite-uses', String(uses));
  await clickInWidget(page, { action: 'invite-create' });
  const link = await widgetTextWhen(page, 'invite-link-text', (text) => text.includes('#'));
  narrator.rememberLink(link);
  await clickInWidget(page, { action: 'invite-done' });
  return link;
}

export interface WatchingView {
  title: string;
  rows: { userId: string; text: string }[];
}

/** The roster's Watching section as the operator sees it: its title and each row. */
export async function watchingView(page: Page): Promise<WatchingView | null> {
  return (await widgetEvaluate(
    page,
    'watching',
    `function () {
      const list = this.querySelector('ul');
      return {
        title: this.firstElementChild.firstElementChild.textContent,
        rows: Array.from(list.children, (row) => ({ userId: row.dataset.userId, text: row.textContent })),
      };
    }`,
  )) as WatchingView | null;
}

/** Waits until the Watching section's title reads `title`. */
export async function watchingTitle(page: Page, title: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await watchingView(page))?.title !== title) {
    if (Date.now() > deadline) throw new Error(`the Watching section never read "${title}"`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
 * The text of the widget node carrying `name="value"` as laid out on screen,
 * one line per block, so a narrated prompt or row reads as the teacher reads
 * it; null while there is no such node.
 */
export async function shownText(page: Page, name: string, value: string): Promise<string | null> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const node = findByAttribute(root, name, value);
    if (!node) return null;
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: node.backendNodeId });
    if (object.objectId === undefined) return null;
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function () { return this.innerText; }',
      returnByValue: true,
    });
    return typeof result.value === 'string' ? result.value : null;
  } finally {
    await cdp.detach();
  }
}

/** Shown text as trimmed lines with no empty ones, for narration. */
export function shownLines(text: string | null): string[] {
  return (text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

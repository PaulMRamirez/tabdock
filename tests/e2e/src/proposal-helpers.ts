// What the proposal tests and demos share (ADR 0042): an observer's
// proposal, its outcome and its withdrawal through an MCP client as the
// proposer's model would make them, and, in a browser, the widget's
// proposal rows as the operator sees and presses them, through the
// published testing helper with a row's id as its scope.

import type { Client } from '@modelcontextprotocol/client';
import type { Page } from '@playwright/test';
import type { WidgetAction } from '@tabdock/adapter/testing';
import { clickInWidget } from './tabdock-harness.ts';

/** A fixed tool's answer as a model reads it. */
export interface ProposalAnswer {
  isError: boolean;
  /** Every text block joined. */
  text: string;
  /** The status word, or the error code, the answer starts with. */
  head: string;
  structuredContent: unknown;
}

async function ask(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ProposalAnswer> {
  const result = await client.callTool({ name, arguments: args }, { timeout: 60_000 });
  const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  return {
    isError: result.isError === true,
    text,
    head: text.slice(0, Math.max(0, text.indexOf(':'))),
    structuredContent: result.structuredContent,
  };
}

/** call_page_tool by an observer on a page that takes proposals: proposed, with the proposal's id. */
export async function propose(
  client: Client,
  page: string,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<{ answer: ProposalAnswer; proposalId: string | null }> {
  const answer = await ask(client, 'call_page_tool', { page, tool, arguments: args });
  const proposal = (answer.structuredContent as { proposal?: unknown } | undefined)?.proposal;
  return { answer, proposalId: typeof proposal === 'string' ? proposal : null };
}

/** get_proposal, waiting up to waitMs for the proposal to change when given. */
export function getProposal(
  client: Client,
  page: string,
  proposal: string,
  waitMs?: number,
): Promise<ProposalAnswer> {
  return ask(client, 'get_proposal', {
    page,
    proposal,
    ...(waitMs === undefined ? {} : { waitMs }),
  });
}

/** The most one get_proposal may wait (MAX_WAIT_MS). */
const WAIT_CAP_MS = 40_000;

/**
 * get_proposal as a looping agent calls it until the outcome is final: a
 * wait answers each change (SPEC section 7), so the Accept answers
 * 'accepted' while the page still runs it, and a second wait answers the
 * run's end. Gives the last answer once `withinMs` has passed.
 */
export async function settledProposal(
  client: Client,
  page: string,
  proposal: string,
  withinMs = 30_000,
): Promise<ProposalAnswer> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    const left = Math.min(WAIT_CAP_MS, deadline - Date.now());
    const read = await getProposal(client, page, proposal, Math.max(0, left));
    const open = read.head === 'pending' || read.text.includes('and the page is running it');
    if (!open || Date.now() >= deadline) return read;
  }
}

export function withdrawProposal(
  client: Client,
  page: string,
  proposal: string,
): Promise<ProposalAnswer> {
  return ask(client, 'withdraw_proposal', { page, proposal });
}

// The widget's proposal rows (data-proposal-id), read and pressed through
// the DevTools protocol, which the closed shadow root keeps page script and
// Playwright's selectors from.

interface DomNode {
  backendNodeId: number;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
}

function attribute(node: DomNode, name: string): string | undefined {
  const list = node.attributes ?? [];
  for (let i = 0; i + 1 < list.length; i += 2) if (list[i] === name) return list[i + 1];
  return undefined;
}

function findNode(node: DomNode, match: (node: DomNode) => boolean): DomNode | null {
  if (match(node)) return node;
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
    const found = findNode(child, match);
    if (found) return found;
  }
  return null;
}

/**
 * What a function returns, by value, run in the page with `this` as one
 * proposal's row; null while the widget shows no such row.
 */
export async function proposalRow(
  page: Page,
  proposalId: string,
  functionDeclaration = 'function () { return this.textContent; }',
): Promise<unknown> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const row = findNode(root, (n) => attribute(n, 'data-proposal-id') === proposalId);
    if (!row) return null;
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: row.backendNodeId });
    if (object.objectId === undefined) return null;
    const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(`the function threw: ${exceptionDetails.text}`);
    return result.value as unknown;
  } finally {
    await cdp.detach();
  }
}

/** One of a row's buttons as it is now: armed or not, disabled or not, and its centre. */
export async function proposalButtonNow(
  page: Page,
  proposalId: string,
  action: Extract<WidgetAction, 'proposal-accept' | 'proposal-dismiss' | 'proposal-args'>,
): Promise<{ armed: boolean; disabled: boolean; x: number; y: number } | null> {
  const found = await proposalRow(
    page,
    proposalId,
    `function () {
      const button = this.querySelector('[data-action="${action}"]');
      if (!button) return null;
      button.scrollIntoView({ block: 'nearest' });
      const box = button.getBoundingClientRect();
      return {
        armed: button.getAttribute('data-armed') !== 'false',
        disabled: button.disabled,
        x: Math.round(box.left + box.width / 2),
        y: Math.round(box.top + box.height / 2),
      };
    }`,
  );
  return found as { armed: boolean; disabled: boolean; x: number; y: number } | null;
}

/** The operator's trusted click on one proposal's Accept, once it is armed. */
export async function acceptProposalInWidget(page: Page, proposalId: string): Promise<void> {
  await clickInWidget(page, { action: 'proposal-accept', proposalId });
}

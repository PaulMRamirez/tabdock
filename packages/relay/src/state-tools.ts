// The answers of get_page_state and wait_for_page_state (ADR 0040), their
// arguments already checked and their request already counted in mcp.ts.
// Each answer is one text block behind pageStateHeader, the value the page
// published spliced in as the page wrote it, and never structuredContent
// (S10): the value is page text however it is shaped. Splicing the stored
// canonical text, rather than parsing it to build a body, costs nothing per
// reader, and JSON.stringify wrote every line break in it as an escape, so
// no page text can start a line of its own beside the label.

import type { CallToolResult } from '@modelcontextprotocol/server';
import { formatError, pageStateHeader } from '@tabdock/protocol';
import type { CallerIdentity, PageHub, StateOutcome } from './hub.ts';

/** What a fixed tool's answer needs from its request once mcp.ts has checked it. */
export interface FixedToolRequest {
  hub: PageHub;
  who: CallerIdentity;
  /** The request's own signal: a client that gives up ends its wait. */
  signal: AbortSignal;
  /** What the request's body holds while it waits (request-heap.ts), charged for a wait. */
  heldBytes: number;
}

export type GetPageStateTool = (
  request: FixedToolRequest,
  args: { page: string },
) => CallToolResult | Promise<CallToolResult>;

export type WaitForPageStateTool = (
  request: FixedToolRequest,
  args: { page: string; after: number; timeoutMs: number },
) => Promise<CallToolResult>;

/** The answer for one outcome: the label line and the body, or a relay refusal in its own words. */
export function stateResult(outcome: StateOutcome): CallToolResult {
  if (outcome.kind === 'error') {
    return {
      content: [{ type: 'text', text: formatError(outcome.code, outcome.message) }],
      isError: true,
    };
  }
  // Every field but the value is the relay's own; the value is the page's
  // canonical text as stored, already valid JSON.
  const body =
    `{"page":${JSON.stringify(outcome.pageId)},"origin":${JSON.stringify(outcome.origin)},` +
    `"version":${String(outcome.version)},"publishedAt":${String(outcome.publishedAt)},` +
    `"heardAt":${String(outcome.heardAt)},"value":${outcome.text ?? 'null'}` +
    `${outcome.changed === null ? '' : `,"changed":${String(outcome.changed)}`}}`;
  return { content: [{ type: 'text', text: `${pageStateHeader(outcome.origin)}\n${body}` }] };
}

export const getPageState: GetPageStateTool = ({ hub, who }, args) =>
  stateResult(hub.getPageState(who.userId, args.page));

export const waitForPageState: WaitForPageStateTool = async (
  { hub, who, signal, heldBytes },
  args,
) =>
  stateResult(
    await hub.waitForPageState(who, args.page, args.after, args.timeoutMs, signal, heldBytes),
  );

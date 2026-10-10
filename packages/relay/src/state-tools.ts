// The answers of get_page_state and wait_for_page_state (ADR 0040), their
// arguments already checked and their request already counted in mcp.ts.
// Each answer is one text block behind pageStateHeader, the value the page
// published spliced in as the page wrote it, and never structuredContent
// (S10): the value is page text however it is shaped.

import type { CallToolResult } from '@modelcontextprotocol/server';
import type { CallerIdentity, PageHub } from './hub.ts';

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

export const getPageState: GetPageStateTool = () => {
  // M6 seam: not built. Thrown, so the dispatcher answers an isError result in these words.
  throw new Error('M6 seam: not built');
};

export const waitForPageState: WaitForPageStateTool = async () => {
  // M6 seam: not built. Thrown, so the dispatcher answers an isError result in these words.
  await Promise.resolve();
  throw new Error('M6 seam: not built');
};

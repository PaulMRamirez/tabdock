// Reading a page's published state as a client does (ADR 0040): the label
// line first, then the body, which is checked with the protocol's own
// schema, so a test or a walker holds the relay to the wire format rather
// than to whatever a tool happened to answer. ADR 0041's helper reuses these.

import type { Client } from '@modelcontextprotocol/client';
import {
  type ErrorCode,
  isErrorCode,
  pageStateHeader,
  type PageStateResult,
  PageStateResultSchema,
} from '@tabdock/protocol';

/** A state answer: the body, or the refusal's code and words. */
export type StateRead =
  | { ok: true; label: string; body: PageStateResult; blocks: number; structured: boolean }
  | { ok: false; code: ErrorCode | null; text: string };

function stateRead(result: Awaited<ReturnType<Client['callTool']>>): StateRead {
  const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  if (result.isError === true) {
    const code = /^([a-z_]+): /.exec(text)?.[1] ?? '';
    return { ok: false, code: isErrorCode(code) ? code : null, text };
  }
  const newline = text.indexOf('\n');
  const label = newline === -1 ? text : text.slice(0, newline);
  const body = PageStateResultSchema.parse(JSON.parse(text.slice(newline + 1)));
  return {
    ok: true,
    label,
    body,
    blocks: result.content.length,
    structured: result.structuredContent !== undefined,
  };
}

/** get_page_state. */
export async function readPageState(client: Client, page: string): Promise<StateRead> {
  return stateRead(await client.callTool({ name: 'get_page_state', arguments: { page } }));
}

/** wait_for_page_state, which may wait up to timeoutMs (at most 40 s) for a version after `after`. */
export async function waitPageState(
  client: Client,
  page: string,
  after: number,
  timeoutMs?: number,
): Promise<StateRead> {
  return stateRead(
    await client.callTool(
      {
        name: 'wait_for_page_state',
        arguments: { page, after, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
      },
      { timeout: 60_000 },
    ),
  );
}

/** The body of a state answer, failing loudly with the relay's words when there is none. */
export function stateBody(read: StateRead): PageStateResult {
  if (!read.ok) throw new Error(`no page state: ${read.text}`);
  return read.body;
}

/** Whether an answer came behind the page state label for this origin, as text alone (S10). */
export function labelledAlone(read: StateRead, origin: string): boolean {
  return read.ok && read.label === pageStateHeader(origin) && read.blocks === 1 && !read.structured;
}

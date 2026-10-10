// What the page state tests share (ADR 0040): reading get_page_state and
// wait_for_page_state as a client receives them, the label line and the
// JSON body after it checked apart, and a page publishing a value.

import type { Client } from '@modelcontextprotocol/client';
import { type PageStateResult, PageStateResultSchema } from '@tabdock/protocol';
import type { TestPage } from './page-client.ts';

export interface StateAnswer {
  isError: boolean;
  /** Every text block joined, as a model would read them. */
  text: string;
  /** The first line: the label, or a refusal. */
  label: string;
  /** The body after the label, checked against the protocol's schema; null when it is not one. */
  body: PageStateResult | null;
  /** How many content blocks came back, and of which types. */
  types: string[];
  structuredContent: unknown;
}

function answerOf(result: Awaited<ReturnType<Client['callTool']>>): StateAnswer {
  const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  const [label = '', ...rest] = text.split('\n');
  let body: PageStateResult | null;
  try {
    const parsed = PageStateResultSchema.safeParse(JSON.parse(rest.join('\n')));
    body = parsed.success ? parsed.data : null;
  } catch {
    body = null;
  }
  return {
    isError: result.isError === true,
    text,
    label,
    body,
    types: result.content.map((block) => block.type),
    structuredContent: result.structuredContent,
  };
}

/** get_page_state as a client sees it. */
export async function readState(client: Client, page: string): Promise<StateAnswer> {
  return answerOf(await client.callTool({ name: 'get_page_state', arguments: { page } }));
}

/** wait_for_page_state as a client sees it; `signal` lets a test give up as a client would. */
export async function waitState(
  client: Client,
  page: string,
  after: number,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<StateAnswer> {
  return answerOf(
    await client.callTool(
      {
        name: 'wait_for_page_state',
        arguments: { page, after, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
      },
      { timeout: 60_000, ...(signal === undefined ? {} : { signal }) },
    ),
  );
}

/** The page publishes `value` and the relay has handled it by the time this resolves. */
export async function publish(page: TestPage, value: unknown): Promise<void> {
  page.send({ t: 'state', value });
  await page.sync();
}

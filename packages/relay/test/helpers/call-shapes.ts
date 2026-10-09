// call_page_tool bodies shaped to make a waiting call hold as much heap as it
// can per byte on the wire, for what requests waiting on a page may hold (S9,
// ADR 0018's notes, request-heap.ts). Each keeps its invoke within one page
// link frame and its body within the 2 MiB cap; padding outside the page
// tool's arguments is kept by the request all the same.

import type { FetchLike } from '@modelcontextprotocol/client';
import type { PageTool } from '@tabdock/protocol';

/** The read-only tool every shape calls; its schema takes anything, so no argument check refuses a shape. */
export const SEARCH: PageTool = {
  name: 'search',
  description: 'Search what is given.',
  inputSchema: { type: 'object' },
  annotations: { readOnlyHint: true },
};

/** A body's two parts, as JSON text: the page tool's arguments, and what is added to the request's _meta. */
interface CallShape {
  args: string;
  meta: string | null;
  /** Spaces after the body's last value. */
  spaces: number;
}

function repeated(item: string, count: number): string {
  return Array<string>(count).fill(item).join(',');
}

function uniqueKeys(count: number): string {
  return Array.from({ length: count }, (_, n) => `"k${n.toString(36).padStart(5, '0')}":0`).join(
    ',',
  );
}

export const CALL_SHAPES = {
  /** One long ASCII string: a byte on the wire, a byte in the body and a byte parsed. */
  text: (): CallShape => ({ args: `{"text":"${'a'.repeat(1_000_000)}"}`, meta: null, spaces: 0 }),
  /** Text past Latin-1, which V8 holds at two bytes a character, the body string included. */
  twoByteText: (): CallShape => ({
    args: `{"text":"${'一'.repeat(330_000)}"}`,
    meta: null,
    spaces: 0,
  }),
  /** Small numbers: two bytes on the wire, a slot parsed. */
  numbers: (): CallShape => ({
    args: `{"list":[${repeated('0', 500_000)}]}`,
    meta: null,
    spaces: 0,
  }),
  /** Empty objects: three bytes on the wire, an object and a slot parsed. */
  emptyObjects: (): CallShape => ({
    args: `{"list":[${repeated('{}', 330_000)}]}`,
    meta: null,
    spaces: 0,
  }),
  /** One object of keys no other shares: a dictionary the schemas copy, and a string a key. */
  uniqueKeys: (): CallShape => ({ args: `{${uniqueKeys(85_000)}}`, meta: null, spaces: 0 }),
  /** Empty objects outside the arguments, which no frame carries but the request keeps. */
  metaObjects: (): CallShape => ({
    args: '{"text":"x"}',
    meta: `"pad":[${repeated('{}', 680_000)}]`,
    spaces: 0,
  }),
  /** Keys no other object shares in the request's _meta, which the SDK's schema copies. */
  metaKeys: (): CallShape => ({ args: '{"text":"x"}', meta: uniqueKeys(170_000), spaces: 0 }),
  /**
   * Keys of digits alone in the request's _meta, after one as high as an
   * index goes, so V8 keeps them all as a dictionary of elements: 1.12 of
   * its charge on the 2026-07-28 leg without the surcharge for such keys
   * when that was added, and 0.85 since the relay holds one copy fewer of
   * _meta (request-heap.ts, ADR 0030's notes of 9 October 2026).
   */
  metaIndexKeys: (): CallShape => ({
    args: '{"text":"x"}',
    meta: `"4294967294":0,${Array.from({ length: 190_000 }, (_, n) => `"${String(n)}":0`).join(',')}`,
    spaces: 0,
  }),
  /** Next to nothing: what every waiting call holds besides its body. */
  tiny: (): CallShape => ({ args: '{"text":"x"}', meta: null, spaces: 0 }),
  /** Spaces to the cap, which only the body holds. */
  spaces: (): CallShape => ({ args: '{"text":"x"}', meta: null, spaces: 2 * 1024 * 1024 - 4096 }),
} satisfies Record<string, () => CallShape>;

export type CallShapeName = keyof typeof CALL_SHAPES;

/**
 * A fetch for an SDK client whose call_page_tool requests carry this shape
 * instead of their own arguments, keeping the request's id and _meta, so
 * both MCP legs can send what the SDK would never build itself. `sent`
 * receives each body as it goes.
 */
export function shapedFetch(
  shape: CallShapeName,
  page: () => string,
  base: FetchLike = fetch,
  sent: (body: string) => void = () => undefined,
): FetchLike {
  const made = CALL_SHAPES[shape]();
  return (input, init) => {
    const body = init?.body;
    if (typeof body !== 'string' || !body.includes('"call_page_tool"')) return base(input, init);
    const message = JSON.parse(body) as {
      id: unknown;
      params: { _meta?: Record<string, unknown> };
    };
    const meta = JSON.stringify(message.params._meta ?? {});
    const extra =
      made.meta === null ? meta : `${meta.slice(0, -1)}${meta === '{}' ? '' : ','}${made.meta}}`;
    const shaped =
      `{"jsonrpc":"2.0","id":${JSON.stringify(message.id)},"method":"tools/call","params":` +
      `{"name":"call_page_tool","arguments":{"page":${JSON.stringify(page())},` +
      `"tool":"${SEARCH.name}","arguments":${made.args}},"_meta":${extra}}${' '.repeat(made.spaces)}}`;
    sent(shaped);
    return base(input, { ...init, body: shaped });
  };
}

// Tool lists shaped to make the relay hold as much heap as it can per byte on
// the wire, or per tool, for the tool list budget's tests (S9, ADR 0018,
// heldBytes in hub.ts). Each fills a frame's schema walk (MAX_FRAME_SCHEMA_NODES)
// or its characters, the ways a page with no account can try to fill the heap.

import type { PageTool } from '@tabdock/protocol';

function tools(count: number, make: (index: number) => Omit<PageTool, 'name'>): PageTool[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `t_${String(index)}`,
    ...make(index),
  }));
}

export const HEAP_SHAPES = {
  /** Empty objects: three bytes on the wire, an object and a slot on the heap. */
  emptyObjects: (): PageTool[] =>
    tools(128, () => ({
      description: 'd',
      inputSchema: { anyOf: Array.from({ length: 150 }, () => ({})) },
    })),
  /** Empty arrays, the same for arrays. */
  emptyArrays: (): PageTool[] =>
    tools(128, () => ({
      description: 'd',
      inputSchema: { enum: Array.from({ length: 150 }, () => []) },
    })),
  /** Objects whose one key no other object shares, so each brings its own hidden class. */
  uniqueKeys: (): PageTool[] =>
    tools(128, (index) => ({
      description: 'd',
      inputSchema: {
        anyOf: Array.from({ length: 75 }, (_, field) => ({
          [`k${String(index)}_${String(field)}`]: 0,
        })),
      },
    })),
  /**
   * 300 empty objects a tool: one frame walks the first two thirds of its
   * tools and stubs the rest, and the same frame again keeps those and walks
   * the rest, so a page holds more than one frame's walk.
   */
  relisted: (): PageTool[] =>
    tools(128, () => ({
      description: 'd',
      inputSchema: { anyOf: Array.from({ length: 300 }, () => ({})) },
    })),
  /**
   * Descriptions as long as the wire allows, with one character past Latin-1,
   * which V8 stores at two bytes each; the cut text may keep the whole
   * original alive.
   */
  twoByteText: (): PageTool[] =>
    tools(100, () => ({
      description: `${'x'.repeat(9999)}\u20ac`,
      inputSchema: { type: 'object' },
    })),
  /** Schema text kept in the cut copy, two-byte. */
  twoByteSchemaText: (): PageTool[] =>
    tools(128, () => ({
      description: 'd',
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: 7 }, (_, field) => [
            `p${String(field)}`,
            { type: 'string', description: `\u20ac${'x'.repeat(990)}` },
          ]),
        ),
      },
    })),
  /** The most tools, each as small as a tool can be: what a tool costs besides its schema. */
  tinyTools: (): PageTool[] =>
    tools(128, () => ({ description: 'd', inputSchema: { type: 'object' } })),
} satisfies Record<string, () => PageTool[]>;

export type HeapShape = keyof typeof HEAP_SHAPES;

/** How many tools frames a shape takes to reach what it holds at most. */
export function framesFor(shape: HeapShape): number {
  return shape === 'relisted' ? 2 : 1;
}

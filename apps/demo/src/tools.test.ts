import { describe, expect, it } from 'vitest';
import { Board } from './board.ts';
import type { CaptureOptions } from './capture.ts';
import { createTools, type ToolCall } from './tools.ts';
import type { ModelContextTool } from './webmcp.ts';

function setup() {
  const board = new Board();
  const calls: ToolCall[] = [];
  const captures: CaptureOptions[] = [];
  // A stand-in for capture.ts, which needs a canvas: it records what it was asked for.
  const tools = createTools(
    board,
    (call) => calls.push(call),
    (options) => {
      captures.push(options);
      return { data: 'data:image/webp;base64,UklGRg==', width: 400, height: 250, bytes: 4 };
    },
  );
  const byName = new Map(tools.map((t) => [t.name, t]));
  const tool = (name: string): ModelContextTool => {
    const found = byName.get(name);
    if (!found) throw new Error(`missing tool ${name}`);
    return found;
  };
  return { board, calls, tools, tool, captures };
}

describe('demo tools', () => {
  it('registers exactly the seven tools from SPEC.md section 4 with the right annotations', () => {
    const { tools } = setup();
    expect(tools.map((t) => [t.name, t.annotations])).toEqual([
      ['get_view', { readOnlyHint: true }],
      ['list_items', { readOnlyHint: true, untrustedContentHint: true }],
      ['add_item', { readOnlyHint: false }],
      ['move_view', { readOnlyHint: false }],
      ['highlight_item', { readOnlyHint: false, untrustedContentHint: true }],
      ['clear_board', { readOnlyHint: false, consequentialHint: true }],
      ['capture_board', { readOnlyHint: true, untrustedContentHint: true }],
    ]);
  });

  it('answers capture_board with an image envelope of the view, in the format asked for', async () => {
    const { board, tool, calls, captures } = setup();
    board.addItem({ label: 'A', x: 0, y: 0 });
    const result = await tool('capture_board').execute({ format: 'png', maxEdge: 400 });
    expect(captures).toEqual([{ format: 'png', maxEdge: 400 }]);
    expect(result).toEqual({
      image: { data: 'data:image/webp;base64,UklGRg==' },
      text: 'Board view: centre (0, 0), zoom 1, 1 items, 400 by 250 pixels',
    });
    await tool('capture_board').execute({});
    expect(captures[1]).toEqual({ format: 'webp', maxEdge: 1024 });
    await expect(tool('capture_board').execute({ maxEdge: 64 })).rejects.toThrow(/Invalid/);
    await expect(tool('capture_board').execute({ format: 'svg' })).rejects.toThrow(/Invalid/);
    expect(calls.map((call) => [call.tool, call.ok])).toEqual([
      ['capture_board', true],
      ['capture_board', true],
      ['capture_board', false],
      ['capture_board', false],
    ]);
  });

  it('refuses capture_board on a page that gave it no way to capture', async () => {
    const tools = createTools(new Board());
    const capture = tools.find((each) => each.name === 'capture_board');
    await expect(capture?.execute({})).rejects.toThrow(/no canvas/);
  });

  it('publishes plain, serialisable JSON Schemas that forbid unknown arguments', () => {
    const { tools } = setup();
    for (const t of tools) {
      expect(JSON.parse(JSON.stringify(t.inputSchema))).toEqual(t.inputSchema);
      expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(t.inputSchema).not.toHaveProperty('$schema');
      expect(t.description.length).toBeGreaterThan(20);
    }
    const add = tools.find((t) => t.name === 'add_item');
    expect(add?.inputSchema.required).toEqual(['label', 'x', 'y']);
  });

  it('runs a read, a write and a consequential call against the board', async () => {
    const { board, tool, calls } = setup();
    const added = (await tool('add_item').execute({
      label: 'Hello',
      x: 10,
      y: 20,
      color: 'green',
    })) as {
      item: { id: string };
    };
    expect(added.item.id).toBe('item-1');
    await expect(tool('highlight_item').execute({ id: 'item-1' })).resolves.toMatchObject({
      item: { highlighted: true },
    });
    await expect(tool('move_view').execute({ x: 10, y: 20, zoom: 2 })).resolves.toEqual({
      view: { x: 10, y: 20, zoom: 2 },
    });
    await expect(tool('get_view').execute({})).resolves.toMatchObject({
      x: 10,
      y: 20,
      zoom: 2,
      visibleItemIds: ['item-1'],
    });
    await expect(tool('list_items').execute(undefined)).resolves.toMatchObject({ total: 1 });
    await expect(tool('clear_board').execute({})).resolves.toEqual({ removed: 1 });
    expect(board.listItems()).toEqual([]);
    expect(calls.map((c) => [c.tool, c.ok])).toEqual([
      ['add_item', true],
      ['highlight_item', true],
      ['move_view', true],
      ['get_view', true],
      ['list_items', true],
      ['clear_board', true],
    ]);
  });

  it('rejects invalid arguments without touching the board', async () => {
    const { board, tool, calls } = setup();
    await expect(tool('add_item').execute({ label: 'x', x: 'left', y: 0 })).rejects.toThrow(
      /Invalid arguments for add_item/,
    );
    await expect(tool('get_view').execute({ sneaky: true })).rejects.toThrow(/Invalid arguments/);
    await expect(tool('move_view').execute({ x: 0, y: 0, zoom: 99 })).rejects.toThrow(/Invalid/);
    expect(board.listItems()).toEqual([]);
    expect(calls.every((c) => !c.ok)).toBe(true);
  });

  it('turns board errors into rejections and logs them as failures', async () => {
    const { tool, calls } = setup();
    await expect(tool('highlight_item').execute({ id: 'item-7' })).rejects.toThrow(/No item/);
    expect(calls).toMatchObject([{ tool: 'highlight_item', ok: false }]);
  });

  it('does not run when the call was already aborted', async () => {
    const { board, tool } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      tool('add_item').execute({ label: 'late', x: 0, y: 0 }, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(board.listItems()).toEqual([]);
  });
});

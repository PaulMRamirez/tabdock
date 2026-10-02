import { describe, expect, it, vi } from 'vitest';
import { Board, BoardError, MAX_ITEMS, MAX_ZOOM, MIN_ZOOM, WORLD_LIMIT } from './board.ts';

describe('Board', () => {
  it('adds items with sequential ids and a default colour', () => {
    const board = new Board();
    const a = board.addItem({ label: 'A', x: 1, y: 2 });
    const b = board.addItem({ label: ' B ', x: 3, y: 4, color: 'red' });
    expect(a).toEqual({ id: 'item-1', label: 'A', x: 1, y: 2, color: 'blue', highlighted: false });
    expect(b.id).toBe('item-2');
    expect(b.label).toBe('B');
    expect(b.color).toBe('red');
  });

  it('rejects empty and overlong labels', () => {
    const board = new Board();
    expect(() => board.addItem({ label: '   ', x: 0, y: 0 })).toThrow(BoardError);
    expect(() => board.addItem({ label: 'x'.repeat(41), x: 0, y: 0 })).toThrow(BoardError);
  });

  it('clamps coordinates and zoom to their limits', () => {
    const board = new Board();
    const item = board.addItem({ label: 'far', x: 1e9, y: -1e9 });
    expect(item.x).toBe(WORLD_LIMIT);
    expect(item.y).toBe(-WORLD_LIMIT);
    expect(board.moveView({ x: 0, y: 0, zoom: 100 }).zoom).toBe(MAX_ZOOM);
    expect(board.moveView({ x: 0, y: 0, zoom: 0 }).zoom).toBe(MIN_ZOOM);
  });

  it('keeps the zoom when moveView omits it', () => {
    const board = new Board();
    board.moveView({ x: 0, y: 0, zoom: 2 });
    expect(board.moveView({ x: 10, y: 20 })).toEqual({ x: 10, y: 20, zoom: 2 });
  });

  it('caps the number of items', () => {
    const board = new Board();
    for (let i = 0; i < MAX_ITEMS; i++) board.addItem({ label: `i${i}`, x: 0, y: 0 });
    expect(() => board.addItem({ label: 'one more', x: 0, y: 0 })).toThrow(/full/);
  });

  it('reports which items are inside the view', () => {
    const board = new Board();
    board.setScreen({ width: 200, height: 100 });
    const inside = board.addItem({ label: 'in', x: 90, y: 40 });
    board.addItem({ label: 'out', x: 150, y: 0 });
    const view = board.getView();
    expect(view).toMatchObject({ x: 0, y: 0, zoom: 1, width: 200, height: 100 });
    expect(view.visibleItemIds).toEqual([inside.id]);
    expect(board.listItems({ visibleOnly: true }).map((i) => i.id)).toEqual([inside.id]);
    board.moveView({ x: 0, y: 0, zoom: 0.5 });
    expect(board.getView().visibleItemIds).toHaveLength(2);
  });

  it('highlights existing items and rejects unknown ids', () => {
    const board = new Board();
    const item = board.addItem({ label: 'A', x: 0, y: 0 });
    expect(board.highlightItem(item.id).highlighted).toBe(true);
    expect(board.highlightItem(item.id, false).highlighted).toBe(false);
    expect(() => board.highlightItem('item-99')).toThrow(/No item/);
  });

  it('clears the board and reports how many items went', () => {
    const board = new Board();
    board.addItem({ label: 'A', x: 0, y: 0 });
    board.addItem({ label: 'B', x: 0, y: 0 });
    expect(board.clear()).toBe(2);
    expect(board.listItems()).toEqual([]);
  });

  it('notifies subscribers with snapshots that callers cannot mutate', () => {
    const board = new Board();
    const listener = vi.fn();
    const unsubscribe = board.subscribe(listener);
    board.addItem({ label: 'A', x: 0, y: 0 });
    expect(listener).toHaveBeenCalledTimes(1);
    const snapshot = listener.mock.calls[0]?.[0] as ReturnType<Board['snapshot']>;
    const [first] = snapshot.items;
    if (first) first.label = 'tampered';
    expect(board.listItems()[0]?.label).toBe('A');
    unsubscribe();
    board.clear();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// The board is plain data plus pure operations so the same code runs in the
// browser and in Node unit tests. Rendering subscribes to changes; it never
// mutates state itself.

export const COLORS = ['blue', 'green', 'orange', 'red', 'purple', 'gray'] as const;
export type Color = (typeof COLORS)[number];

/** World coordinates are clamped to this square so an agent cannot lose items at 1e308. */
export const WORLD_LIMIT = 10_000;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;
export const MAX_ITEMS = 500;
export const MAX_LABEL_LENGTH = 40;

export interface Item {
  id: string;
  label: string;
  x: number;
  y: number;
  color: Color;
  highlighted: boolean;
}

/** The viewport is a centre point in world coordinates plus a zoom factor. */
export interface View {
  x: number;
  y: number;
  zoom: number;
}

/** Size of the visible canvas in CSS pixels; the page updates it on resize. */
export interface Screen {
  width: number;
  height: number;
}

export interface BoardSnapshot {
  items: Item[];
  view: View;
}

export class BoardError extends Error {
  override name = 'BoardError';
}

type Listener = (snapshot: BoardSnapshot) => void;

export class Board {
  private items = new Map<string, Item>();
  private view: View = { x: 0, y: 0, zoom: 1 };
  private screen: Screen = { width: 800, height: 500 };
  private nextId = 1;
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): BoardSnapshot {
    return { items: this.listItems(), view: { ...this.view } };
  }

  setScreen(screen: Screen): void {
    this.screen = { width: Math.max(1, screen.width), height: Math.max(1, screen.height) };
    this.emit();
  }

  getView(): View & { width: number; height: number; visibleItemIds: string[] } {
    const { width, height } = this.visibleSize();
    return { ...this.view, width, height, visibleItemIds: this.visibleItems().map((i) => i.id) };
  }

  listItems(options: { visibleOnly?: boolean } = {}): Item[] {
    const all = [...this.items.values()].map((item) => ({ ...item }));
    if (!options.visibleOnly) return all;
    const visible = new Set(this.visibleItems().map((i) => i.id));
    return all.filter((item) => visible.has(item.id));
  }

  addItem(input: { label: string; x: number; y: number; color?: Color | undefined }): Item {
    if (this.items.size >= MAX_ITEMS) {
      throw new BoardError(`Board is full (${MAX_ITEMS} items); clear it first`);
    }
    const label = input.label.trim();
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH) {
      throw new BoardError(`Label must be 1 to ${MAX_LABEL_LENGTH} characters`);
    }
    const item: Item = {
      id: `item-${this.nextId++}`,
      label,
      x: clampWorld(input.x),
      y: clampWorld(input.y),
      color: input.color ?? 'blue',
      highlighted: false,
    };
    this.items.set(item.id, item);
    this.emit();
    return { ...item };
  }

  moveView(input: { x: number; y: number; zoom?: number | undefined }): View {
    this.view = {
      x: clampWorld(input.x),
      y: clampWorld(input.y),
      zoom: clamp(input.zoom ?? this.view.zoom, MIN_ZOOM, MAX_ZOOM),
    };
    this.emit();
    return { ...this.view };
  }

  highlightItem(id: string, highlighted = true): Item {
    const item = this.items.get(id);
    if (!item) throw new BoardError(`No item with id ${id}`);
    item.highlighted = highlighted;
    this.emit();
    return { ...item };
  }

  clear(): number {
    const removed = this.items.size;
    this.items.clear();
    this.emit();
    return removed;
  }

  private visibleSize(): { width: number; height: number } {
    return {
      width: this.screen.width / this.view.zoom,
      height: this.screen.height / this.view.zoom,
    };
  }

  private visibleItems(): Item[] {
    const { width, height } = this.visibleSize();
    const left = this.view.x - width / 2;
    const top = this.view.y - height / 2;
    return [...this.items.values()].filter(
      (i) => i.x >= left && i.x <= left + width && i.y >= top && i.y <= top + height,
    );
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampWorld(value: number): number {
  return clamp(value, -WORLD_LIMIT, WORLD_LIMIT);
}

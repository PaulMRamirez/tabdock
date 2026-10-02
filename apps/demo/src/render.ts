import type { Board, BoardSnapshot, Color } from './board.ts';
import type { ToolCall } from './tools.ts';

// Everything an agent changes is drawn immediately, so a person watching the
// tab can see each call land. People can also pan (drag) and zoom (wheel).

const FILL: Record<Color, string> = {
  blue: '#2f6fde',
  green: '#2f9e44',
  orange: '#e8590c',
  red: '#e03131',
  purple: '#7048e8',
  gray: '#868e96',
};

const GRID_STEP = 100;
const MAX_LOG_ENTRIES = 8;

export interface BoardUi {
  logCall: (call: ToolCall) => void;
  setStatus: (text: string) => void;
}

export function mountBoard(root: HTMLElement, board: Board): BoardUi {
  const canvas = required(root.querySelector<HTMLCanvasElement>('canvas'));
  const viewLabel = required(root.querySelector<HTMLElement>('[data-role="view"]'));
  const status = required(root.querySelector<HTMLElement>('[data-role="status"]'));
  const log = required(root.querySelector<HTMLOListElement>('[data-role="log"]'));
  const ctx = required(canvas.getContext('2d'));

  let latest = board.snapshot();
  let frame = 0;
  const schedule = (snapshot: BoardSnapshot) => {
    latest = snapshot;
    if (frame === 0) frame = requestAnimationFrame(draw);
  };

  function draw(): void {
    frame = 0;
    const { items, view } = latest;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // World to screen: translate so the view centre lands mid-canvas, then scale.
    const toScreenX = (x: number) => (x - view.x) * view.zoom + width / 2;
    const toScreenY = (y: number) => (y - view.y) * view.zoom + height / 2;

    ctx.strokeStyle = '#e9ecef';
    ctx.lineWidth = 1;
    const left = view.x - width / 2 / view.zoom;
    const top = view.y - height / 2 / view.zoom;
    for (
      let gx = Math.floor(left / GRID_STEP) * GRID_STEP;
      toScreenX(gx) < width;
      gx += GRID_STEP
    ) {
      line(toScreenX(gx), 0, toScreenX(gx), height);
    }
    for (
      let gy = Math.floor(top / GRID_STEP) * GRID_STEP;
      toScreenY(gy) < height;
      gy += GRID_STEP
    ) {
      line(0, toScreenY(gy), width, toScreenY(gy));
    }
    ctx.strokeStyle = '#ced4da';
    line(toScreenX(0), 0, toScreenX(0), height);
    line(0, toScreenY(0), width, toScreenY(0));

    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const item of items) {
      const sx = toScreenX(item.x);
      const sy = toScreenY(item.y);
      const radius = 18 * Math.sqrt(view.zoom);
      if (item.highlighted) {
        ctx.beginPath();
        ctx.arc(sx, sy, radius + 8, 0, Math.PI * 2);
        ctx.strokeStyle = '#fab005';
        ctx.lineWidth = 5;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      ctx.fillStyle = FILL[item.color];
      ctx.fill();
      ctx.fillStyle = '#212529';
      ctx.fillText(item.label, sx, sy + radius + 12);
    }

    viewLabel.textContent = `centre ${round(view.x)}, ${round(view.y)} · zoom ${round(view.zoom)} · ${items.length} items`;
  }

  function line(x1: number, y1: number, x2: number, y2: number): void {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  board.subscribe(schedule);
  const resize = () => {
    board.setScreen({ width: canvas.clientWidth, height: canvas.clientHeight });
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  // Pan with one pointer at a time; a second finger would otherwise make the view jump.
  let drag: { id: number; x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (event) => {
    if (drag) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (drag?.id !== event.pointerId) return;
    const { view } = latest;
    board.moveView({
      x: view.x - (event.clientX - drag.x) / view.zoom,
      y: view.y - (event.clientY - drag.y) / view.zoom,
    });
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
  });
  const endDrag = (event: PointerEvent) => {
    if (drag?.id === event.pointerId) drag = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const { view } = latest;
      board.moveView({
        x: view.x,
        y: view.y,
        zoom: view.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1),
      });
    },
    { passive: false },
  );

  schedule(board.snapshot());

  return {
    logCall(call) {
      const entry = document.createElement('li');
      entry.className = call.ok ? 'ok' : 'error';
      entry.textContent = `${call.at.toLocaleTimeString()} ${call.tool}: ${call.summary}`;
      log.prepend(entry);
      while (log.children.length > MAX_LOG_ENTRIES) log.lastElementChild?.remove();
    },
    setStatus(text) {
      status.textContent = text;
    },
  };
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error('Demo page markup is missing an element');
  return value;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

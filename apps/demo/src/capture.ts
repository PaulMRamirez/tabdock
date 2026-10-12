// capture_board's picture (ADR 0039): the board drawn as the tab shows it
// onto a canvas of its own, never the tab itself, whose widget shows the
// pairing code and QR. The page fits its own image, since neither the
// adapter nor the relay re-encodes one: lower quality first, then half the
// long edge, until the encoding is under the cap. A canvas encodes nothing
// as "data:," and an unsupported type as PNG, so both are refused rather
// than sent as something they are not.

import { DEFAULT_IMAGE_BYTES } from '@tabdock/adapter';
import type { Board } from './board.ts';
import { drawBoard } from './render.ts';

export const CAPTURE_FORMATS = ['webp', 'png', 'jpeg'] as const;
export type CaptureFormat = (typeof CAPTURE_FORMATS)[number];

export const MIN_CAPTURE_EDGE = 128;
export const MAX_CAPTURE_EDGE = 1600;

export interface CaptureOptions {
  format: CaptureFormat;
  /** The longest side, in pixels, the picture may have. */
  maxEdge: number;
}

export interface Capture {
  /** A data URL, as the envelope's data takes it. */
  data: string;
  width: number;
  height: number;
  /** Decoded bytes. */
  bytes: number;
}

/** Tries each in turn before halving the long edge; PNG takes no quality, so it tries once. */
const QUALITIES = [0.8, 0.6, 0.45] as const;

/** The canvas a capture draws on: a detached one in the page, a stand-in in tests. */
export interface CaptureCanvas {
  width: number;
  height: number;
  getContext(kind: '2d'): CanvasRenderingContext2D | null;
  toDataURL(type: string, quality?: number): string;
}

/** Decoded bytes of a base64 data URL, from its length and padding alone. */
function decodedBytes(dataUrl: string, prefix: string): number {
  const text = dataUrl.slice(prefix.length);
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return (text.length / 4) * 3 - padding;
}

/**
 * The board as its view shows it, at most `maxEdge` pixels on the long side,
 * encoded as `format` within `maxBytes`; throws, in words a model can act
 * on, when the canvas cannot encode it or nothing fits.
 */
export function captureBoard(
  board: Board,
  options: CaptureOptions,
  maxBytes: number = DEFAULT_IMAGE_BYTES,
  makeCanvas: () => CaptureCanvas = () => document.createElement('canvas'),
): Capture {
  const view = board.getView();
  // The view's size in CSS pixels: its width in world units at its zoom.
  const screen = { width: view.width * view.zoom, height: view.height * view.zoom };
  const longest = Math.max(screen.width, screen.height);
  const type = `image/${options.format}`;
  const prefix = `data:${type};base64,`;
  const canvas = makeCanvas();
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('this browser gives the board no canvas to capture on');
  let edge = Math.min(options.maxEdge, Math.ceil(longest));
  for (;;) {
    const scale = edge / longest;
    canvas.width = Math.max(1, Math.round(screen.width * scale));
    canvas.height = Math.max(1, Math.round(screen.height * scale));
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawBoard(ctx, board.snapshot(), screen, '#ffffff');
    for (const quality of options.format === 'png' ? [undefined] : QUALITIES) {
      const data = canvas.toDataURL(type, quality);
      if (data === 'data:,') throw new Error('the canvas has no size to capture');
      if (!data.startsWith(prefix)) {
        throw new Error(`this browser cannot encode ${options.format}; ask for png instead`);
      }
      const bytes = decodedBytes(data, prefix);
      if (bytes <= maxBytes) return { data, width: canvas.width, height: canvas.height, bytes };
    }
    if (edge <= MIN_CAPTURE_EDGE) break;
    edge = Math.max(MIN_CAPTURE_EDGE, Math.floor(edge / 2));
  }
  throw new Error(
    `the board does not fit in ${String(maxBytes)} bytes as ${options.format}, even ${String(MIN_CAPTURE_EDGE)} pixels wide; try jpeg or webp`,
  );
}

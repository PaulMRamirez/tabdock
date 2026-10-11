// capture_view's picture (ADR 0038, ADR 0039): the world drawn again onto a
// canvas of the capture's own, in the same task as that render, never the tab
// itself, whose widget shows the pairing code and QR. drawMap's output
// depends on the world's state alone, so one view gives the same bytes every
// time and another view other bytes. The page fits its own image, since
// neither the adapter nor the relay re-encodes one: JPEG lowers its quality
// first, then each format halves its width, until the encoding is under the
// relay's cap. A canvas encodes nothing as "data:," and an unsupported type
// as PNG, so both are refused rather than sent as something they are not.

import {
  MAP_MIN_CAPTURE_WIDTH_PX,
  type MapCaptured,
  type MapCaptureRequest,
  type MapViewport,
  type MapWorld,
} from '@tabdock/sim-page/map';
import { drawMap } from './draw.ts';

/** The canvas a capture draws on: a detached one in the page, a stand-in in tests. */
export interface CaptureCanvas {
  width: number;
  height: number;
  getContext(kind: '2d'): CanvasRenderingContext2D | null;
  toDataURL(type: string, quality?: number): string;
}

/** JPEG tries each in turn before halving the width; PNG takes no quality, so it tries once a width. */
const JPEG_QUALITIES = [0.85, 0.6] as const;

/** Decoded bytes of base64 text, from its length and padding alone. */
function decodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

/**
 * The world as `viewport` shows it, at most `request.maxWidthPx` and at most
 * the viewport wide, encoded as `request.format` within `maxBytes`, as bare
 * base64. Throws, in words a model can act on, when the canvas cannot encode
 * it or nothing fits.
 */
export function captureMap(
  world: MapWorld,
  viewport: MapViewport,
  request: MapCaptureRequest,
  maxBytes: number,
  makeCanvas: () => CaptureCanvas,
): MapCaptured {
  const mimeType = request.format === 'png' ? 'image/png' : 'image/jpeg';
  const prefix = `data:${mimeType};base64,`;
  const canvas = makeCanvas();
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('this browser gives the map no canvas to capture on');
  let width = Math.max(
    MAP_MIN_CAPTURE_WIDTH_PX,
    Math.min(Math.floor(request.maxWidthPx), viewport.widthPx),
  );
  for (;;) {
    const scale = width / viewport.widthPx;
    canvas.width = width;
    canvas.height = Math.max(1, Math.round(viewport.heightPx * scale));
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawMap(ctx, world, viewport);
    for (const quality of request.format === 'png' ? [undefined] : JPEG_QUALITIES) {
      const url = canvas.toDataURL(mimeType, quality);
      if (url === 'data:,') throw new Error('the map canvas has no size to capture');
      if (!url.startsWith(prefix)) {
        throw new Error(`this browser cannot encode ${request.format}; ask for png instead`);
      }
      const data = url.slice(prefix.length);
      if (decodedBytes(data) <= maxBytes) {
        return { mimeType, data, widthPx: canvas.width, heightPx: canvas.height };
      }
    }
    if (width <= MAP_MIN_CAPTURE_WIDTH_PX) break;
    width = Math.max(MAP_MIN_CAPTURE_WIDTH_PX, Math.floor(width / 2));
  }
  throw new Error(
    `the view does not fit in ${String(maxBytes)} bytes as ${request.format}, even ${String(MAP_MIN_CAPTURE_WIDTH_PX)} pixels wide; try jpeg`,
  );
}

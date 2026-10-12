import { describe, expect, it } from 'vitest';
import { Board } from './board.ts';
import { type CaptureCanvas, captureBoard, MIN_CAPTURE_EDGE } from './capture.ts';

/**
 * A canvas that draws nothing and encodes to `bytesFor(width, height,
 * quality)` bytes of the asked type, or to what `encode` returns; each call
 * is recorded, so a test can follow the fit loop.
 */
function standIn(options: {
  bytesFor?: (width: number, height: number, quality: number | undefined) => number;
  encode?: (type: string) => string;
}): { canvas: CaptureCanvas; tries: string[] } {
  const tries: string[] = [];
  const ctx = new Proxy(
    {},
    {
      get: () => () => undefined,
      set: () => true,
    },
  ) as CanvasRenderingContext2D;
  const canvas: CaptureCanvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
    toDataURL(type, quality) {
      tries.push(`${String(this.width)}x${String(this.height)}@${String(quality)}`);
      if (options.encode) return options.encode(type);
      const bytes = options.bytesFor?.(this.width, this.height, quality) ?? 3;
      return `data:${type};base64,${'A'.repeat(Math.ceil(bytes / 3) * 4)}`;
    },
  };
  return { canvas, tries };
}

function board(): Board {
  const made = new Board();
  made.setScreen({ width: 1600, height: 1000 });
  return made;
}

describe('captureBoard', () => {
  it('lowers the quality, then halves the long edge, until the picture fits', () => {
    // Fits only at 400 pixels wide and quality 0.45.
    const { canvas, tries } = standIn({
      bytesFor: (width, _height, quality) => (width <= 400 && quality === 0.45 ? 9_000 : 90_000),
    });
    const capture = captureBoard(board(), { format: 'webp', maxEdge: 1600 }, 10_000, () => canvas);
    expect(capture).toMatchObject({ width: 400, height: 250, bytes: 9_000 });
    expect(capture.data.startsWith('data:image/webp;base64,')).toBe(true);
    expect(tries).toEqual([
      '1600x1000@0.8',
      '1600x1000@0.6',
      '1600x1000@0.45',
      '800x500@0.8',
      '800x500@0.6',
      '800x500@0.45',
      '400x250@0.8',
      '400x250@0.6',
      '400x250@0.45',
    ]);
  });

  it('keeps to maxEdge, and tries PNG once a size', () => {
    const { canvas, tries } = standIn({ bytesFor: (width) => (width <= 300 ? 100 : 1e6) });
    expect(
      captureBoard(board(), { format: 'png', maxEdge: 600 }, 1_000, () => canvas),
    ).toMatchObject({ width: 300, height: 188 });
    expect(tries).toEqual(['600x375@undefined', '300x188@undefined']);
  });

  it(`gives up at ${String(MIN_CAPTURE_EDGE)} pixels, saying what to try`, () => {
    const { canvas, tries } = standIn({ bytesFor: () => 1e6 });
    expect(() =>
      captureBoard(board(), { format: 'png', maxEdge: 1024 }, 65_536, () => canvas),
    ).toThrow('the board does not fit in 65536 bytes as png, even 128 pixels wide');
    expect(tries.at(-1)).toBe('128x80@undefined');
  });

  it('refuses the empty data URL of a canvas with no size, and a type the browser swapped', () => {
    const empty = standIn({ encode: () => 'data:,' });
    expect(() =>
      captureBoard(board(), { format: 'webp', maxEdge: 512 }, 65_536, () => empty.canvas),
    ).toThrow('the canvas has no size to capture');
    // A browser that cannot encode WebP hands back PNG instead.
    const swapped = standIn({ encode: () => 'data:image/png;base64,iVBORw0KGgo=' });
    expect(() =>
      captureBoard(board(), { format: 'webp', maxEdge: 512 }, 65_536, () => swapped.canvas),
    ).toThrow('this browser cannot encode webp; ask for png instead');
  });
});

// capture_view's picture against a stand-in canvas: it is no wider than
// maxWidthPx or the page's own drawing, fits under the cap by lowering a
// JPEG's quality and then halving the width, gives up at the profile's
// smallest width, and refuses the empty data URL a canvas with no size gives
// and the PNG a browser gives in place of a type it cannot encode (ADR 0038,
// decision 20), so neither goes out labelled as something it is not.

import { createMapWorld, MAP_MIN_CAPTURE_WIDTH_PX, type MapViewport } from '@tabdock/sim-page/map';
import { describe, expect, it } from 'vitest';
import { type CaptureCanvas, captureMap } from '../src/capture.ts';

const VIEWPORT: MapViewport = { widthPx: 960, heightPx: 540 };

/**
 * A canvas that draws nothing and encodes to `bytesFor(width, quality)`
 * bytes of the asked type, or to what `encode` returns; each encoding is
 * recorded, so a test can follow the fit loop.
 */
function standIn(options: {
  bytesFor?: (width: number, quality: number | undefined) => number;
  encode?: (type: string) => string;
}): { canvas: CaptureCanvas; tries: string[]; scales: number[] } {
  const tries: string[] = [];
  const scales: number[] = [];
  const ctx = new Proxy(
    {},
    {
      get: (_target, key) =>
        key === 'setTransform'
          ? (scale: number) => {
              scales.push(scale);
            }
          : () => undefined,
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
      const bytes = options.bytesFor?.(this.width, quality) ?? 3;
      return `data:${type};base64,${'A'.repeat(Math.ceil(bytes / 3) * 4)}`;
    },
  };
  return { canvas, tries, scales };
}

describe('captureMap', () => {
  it('draws at maxWidthPx, scaled from the drawing buffer, and returns bare base64', () => {
    const { canvas, tries, scales } = standIn({});
    const shot = captureMap(
      createMapWorld(),
      VIEWPORT,
      { maxWidthPx: 480, format: 'png' },
      65_536,
      () => canvas,
    );
    expect(shot).toEqual({ mimeType: 'image/png', data: 'AAAA', widthPx: 480, heightPx: 270 });
    expect(tries).toEqual(['480x270@undefined']);
    expect(scales).toEqual([0.5]);
  });

  it('never draws wider than the page itself does', () => {
    const { canvas, tries } = standIn({});
    const shot = captureMap(
      createMapWorld(),
      VIEWPORT,
      { maxWidthPx: 2048, format: 'png' },
      65_536,
      () => canvas,
    );
    expect(shot).toMatchObject({ widthPx: 960, heightPx: 540 });
    expect(tries).toEqual(['960x540@undefined']);
  });

  it('lowers a JPEG quality first, then halves the width, until the picture fits', () => {
    const { canvas, tries } = standIn({
      bytesFor: (width, quality) => (width <= 240 && quality === 0.6 ? 9_000 : 90_000),
    });
    const shot = captureMap(
      createMapWorld(),
      VIEWPORT,
      { maxWidthPx: 960, format: 'jpeg' },
      10_000,
      () => canvas,
    );
    expect(shot).toMatchObject({ mimeType: 'image/jpeg', widthPx: 240, heightPx: 135 });
    expect(tries).toEqual([
      '960x540@0.85',
      '960x540@0.6',
      '480x270@0.85',
      '480x270@0.6',
      '240x135@0.85',
      '240x135@0.6',
    ]);
  });

  it(`gives up at ${String(MAP_MIN_CAPTURE_WIDTH_PX)} pixels wide, saying what to try`, () => {
    const { canvas, tries } = standIn({ bytesFor: () => 1e6 });
    expect(() =>
      captureMap(
        createMapWorld(),
        VIEWPORT,
        { maxWidthPx: 1024, format: 'png' },
        65_536,
        () => canvas,
      ),
    ).toThrow('the view does not fit in 65536 bytes as png, even 64 pixels wide; try jpeg');
    expect(tries).toEqual([
      '960x540@undefined',
      '480x270@undefined',
      '240x135@undefined',
      '120x68@undefined',
      '64x36@undefined',
    ]);
  });

  it('refuses the empty data URL of a canvas with no size, and a type the browser swapped', () => {
    const empty = standIn({ encode: () => 'data:,' });
    expect(() =>
      captureMap(
        createMapWorld(),
        VIEWPORT,
        { maxWidthPx: 512, format: 'png' },
        65_536,
        () => empty.canvas,
      ),
    ).toThrow('the map canvas has no size to capture');
    // A browser that cannot encode JPEG hands back PNG, which must not go out as image/jpeg.
    const swapped = standIn({ encode: () => 'data:image/png;base64,AAAA' });
    expect(() =>
      captureMap(
        createMapWorld(),
        VIEWPORT,
        { maxWidthPx: 512, format: 'jpeg' },
        65_536,
        () => swapped.canvas,
      ),
    ).toThrow('this browser cannot encode jpeg; ask for png instead');
  });

  it('refuses a browser that gives no 2D context', () => {
    const { canvas } = standIn({});
    canvas.getContext = () => null;
    expect(() =>
      captureMap(
        createMapWorld(),
        VIEWPORT,
        { maxWidthPx: 512, format: 'png' },
        65_536,
        () => canvas,
      ),
    ).toThrow('this browser gives the map no canvas to capture on');
  });
});

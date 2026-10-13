// The drawing and capture_view's picture, against a stand-in canvas that
// records every call (ADR 0039, ADR 0050): one scene always draws the same
// calls, so one view always captures to the same bytes, and another view
// draws others; the screen's scale changes sizes only; space, not sea, shows
// past the flat map's poles; the fit loop draws at most the viewport wide,
// lowers a JPEG's quality before drawing a fifth narrower, draws names larger
// on a narrower capture, gives up at the profile's smallest width, and
// refuses an empty data URL or a type the browser swapped. The page's own
// state goes out once per change.

import { MAP_MIN_CAPTURE_WIDTH_PX } from '@tabdock/sim-page/map';
import { describe, expect, it } from 'vitest';
import {
  CAPTURE_MAX_LABEL_SCALE,
  type CaptureCanvas,
  captureLabelScale,
  captureMap,
} from './capture.ts';
import { COLORS, drawMap, prepareEarth, sceneOf } from './draw.ts';
import { createEarthWorld, earthGeography, featureRanks, TOUR_ID } from './earth.ts';
import { statePublisher } from './publish.ts';

const VIEWPORT = { widthPx: 960, heightPx: 540 };
const earth = prepareEarth(earthGeography(), featureRanks());

/** A 2D context that records each call and assignment, with measureText's width from the text's length. */
function recorder(): { ctx: CanvasRenderingContext2D; log: string[] } {
  const log: string[] = [];
  const round = (value: unknown): unknown =>
    typeof value === 'number' ? Math.round(value * 1000) / 1000 : value;
  const ctx = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === 'measureText') {
          return (text: string) => ({ width: text.length * 7 });
        }
        return (...args: unknown[]) => {
          log.push(`${String(key)}(${args.map(round).join(',')})`);
        };
      },
      set: (_target, key, value) => {
        log.push(`${String(key)}=${String(round(value))}`);
        return true;
      },
    },
  ) as CanvasRenderingContext2D;
  return { ctx, log };
}

function drawn(world: ReturnType<typeof createEarthWorld>, scale = 1): string[] {
  const { ctx, log } = recorder();
  drawMap(ctx, sceneOf(world), VIEWPORT, earth, { scale });
  return log;
}

describe('drawMap', () => {
  it('draws one view the same way every time, and another view otherwise', () => {
    const world = createEarthWorld({ viewport: VIEWPORT });
    for (let index = 0; index < 6; index += 1) {
      world.goToStop(TOUR_ID, index);
      const first = drawn(world);
      expect(drawn(world)).toEqual(first);
      expect(first.length).toBeGreaterThan(100);
    }
    world.goToStop(TOUR_ID, 0);
    const before = drawn(world);
    world.setView({ lon: -29 });
    expect(drawn(world)).not.toEqual(before);
  });

  it("draws a drag's view without writing it to the world", () => {
    const world = createEarthWorld({ viewport: VIEWPORT });
    world.goToStop(TOUR_ID, 1);
    const view = world.view();
    const { ctx } = recorder();
    drawMap(ctx, sceneOf(world, { ...view, lon: view.lon + 5 }), VIEWPORT, earth);
    expect(world.view()).toEqual(view);
  });

  it('draws larger names and lines on a narrow screen, and the same shapes', () => {
    const world = createEarthWorld({ viewport: VIEWPORT });
    world.goToStop(TOUR_ID, 3);
    const plain = drawn(world, 1);
    const scaled = drawn(world, 2.4);
    expect(plain.filter((call) => call.startsWith('font='))).toEqual(['font=13px sans-serif']);
    expect(scaled.filter((call) => call.startsWith('font='))).toEqual(['font=31.2px sans-serif']);
    const shapes = (log: string[]): string[] =>
      log.filter((call) => call.startsWith('moveTo') || call.startsWith('lineTo'));
    // The north arrow is drawn larger too; the land and lakes are not moved.
    expect(shapes(scaled).slice(0, 200)).toEqual(shapes(plain).slice(0, 200));
  });

  it('shows space, not sea, past the poles of a flat map zoomed far out', () => {
    const world = createEarthWorld({ viewport: VIEWPORT });
    /** The sea's band: the path traced after the ocean colour is set, up to its fill. */
    const seaBand = (): { top: number; bottom: number; first: string[] } => {
      const log = drawn(world);
      const start = log.indexOf(`fillStyle=${COLORS.ocean}`);
      const end = log.indexOf('fill()', start);
      const ys = log
        .slice(start, end)
        .filter((call) => call.startsWith('moveTo') || call.startsWith('lineTo'))
        .map((call) => Number(/,(-?[\d.]+)\)$/.exec(call)?.[1]));
      return { top: Math.min(...ys), bottom: Math.max(...ys), first: log.slice(0, start) };
    };
    world.setView({ projection: 'equirectangular', lon: -30, lat: 20, widthM: 100_000_000 });
    const far = seaBand();
    // Space fills the frame first, then the sea only between the poles.
    expect(far.first).toContain(`fillStyle=${COLORS.space}`);
    expect(far.first).toContain('fillRect(0,0,960,540)');
    expect(far.top).toBeGreaterThan(0);
    expect(far.bottom).toBeLessThan(VIEWPORT.heightPx);
    // At a stop the band runs past the frame, so the sea fills it as before.
    world.goToStop(TOUR_ID, 1);
    const near = seaBand();
    expect(near.top).toBeLessThan(0);
    expect(near.bottom).toBeGreaterThan(VIEWPORT.heightPx);
  });

  it('fills a layer only while it is shown, at its opacity', () => {
    const world = createEarthWorld({ viewport: VIEWPORT });
    world.goToStop(TOUR_ID, 0);
    expect(drawn(world)).toContain('fillStyle=#e6dcbf');
    world.setLayer('land', { opacity: 0.4 });
    expect(drawn(world)).toContain('globalAlpha=0.4');
    world.setLayer('land', { visible: false });
    expect(drawn(world)).not.toContain('fillStyle=#e6dcbf');
  });
});

/**
 * A capture canvas that draws into a recorder and encodes to
 * `bytesFor(width, quality)` bytes of the asked type, or to what `encode`
 * returns; each encoding is recorded, so a test can follow the fit loop.
 */
function standIn(options: {
  bytesFor?: (width: number, quality: number | undefined) => number;
  encode?: (type: string) => string;
}): { canvas: CaptureCanvas; tries: string[]; log: string[] } {
  const tries: string[] = [];
  const { ctx, log } = recorder();
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
  return { canvas, tries, log };
}

describe('captureMap', () => {
  const world = createEarthWorld({ viewport: VIEWPORT });
  world.goToStop(TOUR_ID, 2);
  const scene = sceneOf(world);

  it('draws at maxWidthPx, never wider than the viewport, and returns bare base64', () => {
    const narrow = standIn({});
    expect(
      captureMap(
        scene,
        earth,
        VIEWPORT,
        { maxWidthPx: 480, format: 'png' },
        65_536,
        () => narrow.canvas,
      ),
    ).toEqual({ mimeType: 'image/png', data: 'AAAA', widthPx: 480, heightPx: 270 });
    const wide = standIn({});
    expect(
      captureMap(
        scene,
        earth,
        VIEWPORT,
        { maxWidthPx: 2048, format: 'png' },
        65_536,
        () => wide.canvas,
      ),
    ).toMatchObject({ widthPx: 960, heightPx: 540 });
    expect(wide.tries).toEqual(['960x540@undefined']);
  });

  it('lowers a JPEG quality first, then draws a fifth narrower, until the picture fits', () => {
    const { canvas, tries } = standIn({
      bytesFor: (width, quality) => (width <= 500 && quality === 0.6 ? 9_000 : 90_000),
    });
    expect(
      captureMap(scene, earth, VIEWPORT, { maxWidthPx: 960, format: 'jpeg' }, 10_000, () => canvas),
    ).toMatchObject({ mimeType: 'image/jpeg', widthPx: 491, heightPx: 276 });
    expect(tries).toEqual([
      '960x540@0.85',
      '960x540@0.6',
      '768x432@0.85',
      '768x432@0.6',
      '614x345@0.85',
      '614x345@0.6',
      '491x276@0.85',
      '491x276@0.6',
    ]);
  });

  it("keeps a PNG just over the cap near the viewport's width, not half of it", () => {
    // The review's stop 1: 960 wide is over the cap, 768 fits.
    const { canvas, tries } = standIn({ bytesFor: (width) => (width > 800 ? 70_000 : 60_000) });
    expect(
      captureMap(scene, earth, VIEWPORT, { maxWidthPx: 1024, format: 'png' }, 65_536, () => canvas),
    ).toMatchObject({ mimeType: 'image/png', widthPx: 768, heightPx: 432 });
    expect(tries).toEqual(['960x540@undefined', '768x432@undefined']);
  });

  it('draws names larger on a narrower capture, up to twice, and at their own size at full width', () => {
    expect(captureLabelScale(960, VIEWPORT)).toBe(1);
    expect(captureLabelScale(768, VIEWPORT)).toBe(1.25);
    expect(captureLabelScale(480, VIEWPORT)).toBe(2);
    expect(captureLabelScale(64, VIEWPORT)).toBe(CAPTURE_MAX_LABEL_SCALE);
    const fonts = (maxWidthPx: number): string[] => {
      const { canvas, log } = standIn({});
      captureMap(scene, earth, VIEWPORT, { maxWidthPx, format: 'png' }, 65_536, () => canvas);
      return log.filter((call) => call.startsWith('font='));
    };
    expect(fonts(960)).toEqual(['font=13px sans-serif']);
    expect(fonts(768)).toEqual(['font=16.25px sans-serif']);
    expect(fonts(480)).toEqual(['font=26px sans-serif']);
  });

  it(`gives up at ${String(MAP_MIN_CAPTURE_WIDTH_PX)} pixels wide, saying what to try`, () => {
    const { canvas } = standIn({ bytesFor: () => 1e6 });
    expect(() =>
      captureMap(scene, earth, VIEWPORT, { maxWidthPx: 1024, format: 'png' }, 65_536, () => canvas),
    ).toThrow('the view does not fit in 65536 bytes as png, even 64 pixels wide; try jpeg');
  });

  it('refuses an empty data URL, a type the browser swapped and a missing context', () => {
    const empty = standIn({ encode: () => 'data:,' });
    expect(() =>
      captureMap(
        scene,
        earth,
        VIEWPORT,
        { maxWidthPx: 512, format: 'png' },
        65_536,
        () => empty.canvas,
      ),
    ).toThrow('the map canvas has no size to capture');
    const swapped = standIn({ encode: () => 'data:image/png;base64,AAAA' });
    expect(() =>
      captureMap(
        scene,
        earth,
        VIEWPORT,
        { maxWidthPx: 512, format: 'jpeg' },
        65_536,
        () => swapped.canvas,
      ),
    ).toThrow('this browser cannot encode jpeg; ask for png instead');
    const none = standIn({});
    none.canvas.getContext = () => null;
    expect(() =>
      captureMap(
        scene,
        earth,
        VIEWPORT,
        { maxWidthPx: 512, format: 'png' },
        65_536,
        () => none.canvas,
      ),
    ).toThrow('this browser gives the map no canvas to capture on');
  });
});

describe('statePublisher', () => {
  it('sends the state once per change and never the same state twice', () => {
    const world = createEarthWorld({ viewport: VIEWPORT });
    const sent: unknown[] = [];
    const publish = statePublisher(world, (state) => sent.push(state));
    world.subscribe(publish);
    publish();
    publish();
    expect(sent).toHaveLength(1);
    world.goToStop(TOUR_ID, 1);
    world.goToStop(TOUR_ID, 1);
    expect(sent).toHaveLength(2);
    // Layers and edits are not page state, so they send nothing.
    world.setLayer('graticule', { visible: false });
    world.editStop(TOUR_ID, 1, { text: 'Edited.' });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ walkthrough: { id: TOUR_ID, stopIndex: 1 } });
  });
});

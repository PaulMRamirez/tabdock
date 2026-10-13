// pnpm record:map-demo films the map demo beside a pane of the scripted
// client's calls, with the pairing code kept off camera, writes its take,
// exports and stills into a directory git ignores for a person to look at,
// and copies a take within budget into apps/map-demo/media/: an MP4 and a
// WebM the page plays, the poster it shows first, and a looping GIF for the
// README. This holds the review files ignored, the kept files tracked, each
// of its kind, shape and length and within budget, read from their own
// bytes with no ffmpeg, and the script reachable from the root and from no
// CI workflow. The recording itself runs by hand only, never here or in CI.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../src/doc-files.ts';
import { pngDimensions } from '../src/image-helpers.ts';
import {
  FRAME,
  LOOP,
  MEDIA_BUDGET,
  MEDIA_DIR,
  RECORDING_DIR,
  RECORDING_FILES,
} from '../src/record-map-demo.ts';

/** Whether git ignores a path, whether or not it exists. */
function ignored(path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '--quiet', '--no-index', path], { cwd: ROOT });
    return true;
  } catch {
    return false;
  }
}

/** Whether git tracks a path. */
function tracked(path: string): boolean {
  return (
    execFileSync('git', ['ls-files', '--', path], { cwd: ROOT, encoding: 'utf8' }).trim() === path
  );
}

interface Box {
  type: string;
  start: number;
  end: number;
}

/** The boxes of an ISO media file between two offsets, in order. */
function boxes(bytes: Buffer, from = 0, to = bytes.length): Box[] {
  const found: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    if (size === 1) size = Number(bytes.readBigUInt64BE(at + 8));
    if (size === 0) size = to - at;
    if (size < 8 || at + size > to) throw new Error(`a broken ${type} box`);
    found.push({ type, start: at, end: at + size });
    at += size;
  }
  return found;
}

/** What a player reads first from an MP4: its boxes in order, its length, and its video track. */
function mp4Facts(bytes: Buffer): {
  order: string[];
  seconds: number;
  codec: string;
  profile: number;
  width: number;
  height: number;
} {
  const top = boxes(bytes);
  const moov = top.find((box) => box.type === 'moov');
  if (!moov) throw new Error('no moov box');
  const inner = boxes(bytes, moov.start + 8, moov.end);
  const mvhd = inner.find((box) => box.type === 'mvhd');
  if (!mvhd) throw new Error('no mvhd box');
  const version = bytes[mvhd.start + 8];
  const timescale = bytes.readUInt32BE(mvhd.start + (version === 1 ? 28 : 20));
  const length =
    version === 1
      ? Number(bytes.readBigUInt64BE(mvhd.start + 32))
      : bytes.readUInt32BE(mvhd.start + 24);
  // The sample entry names the codec; avcC's second byte is the profile.
  const header = bytes.subarray(moov.start, moov.end);
  const entry = header.indexOf('avc1', 0, 'latin1');
  const config = header.indexOf('avcC', 0, 'latin1');
  return {
    order: top.map((box) => box.type),
    seconds: length / timescale,
    codec: entry === -1 ? '' : 'avc1',
    profile: config === -1 ? -1 : (header[config + 5] ?? -1),
    width: entry === -1 ? 0 : header.readUInt16BE(entry + 4 + 24),
    height: entry === -1 ? 0 : header.readUInt16BE(entry + 4 + 26),
  };
}

/** A GIF's size, its frames' total delay in seconds, and whether it loops, by walking its blocks. */
function gifFacts(bytes: Buffer): {
  width: number;
  height: number;
  frames: number;
  seconds: number;
  loops: boolean;
} {
  if (bytes.toString('latin1', 0, 6) !== 'GIF89a') throw new Error('not a GIF89a');
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  const table = (packed: number): number =>
    (packed & 0x80) !== 0 ? 3 * 2 ** ((packed & 7) + 1) : 0;
  let at = 13 + table(bytes[10] ?? 0);
  let frames = 0;
  let hundredths = 0;
  let loops = false;
  const skipBlocks = (): void => {
    while ((bytes[at] ?? 0) !== 0) at += (bytes[at] ?? 0) + 1;
    at += 1;
  };
  for (;;) {
    const kind = bytes[at];
    if (kind === 0x3b) break;
    if (kind === 0x21) {
      const label = bytes[at + 1];
      if (label === 0xf9) hundredths += bytes.readUInt16LE(at + 4);
      if (label === 0xff && bytes.toString('latin1', at + 3, at + 14) === 'NETSCAPE2.0')
        loops = true;
      at += 2;
      skipBlocks();
    } else if (kind === 0x2c) {
      frames += 1;
      at += 10 + table(bytes[at + 9] ?? 0) + 1;
      skipBlocks();
    } else {
      throw new Error(`a GIF block of unknown kind at ${String(at)}`);
    }
  }
  return { width, height, frames, seconds: hundredths / 100, loops };
}

describe('pnpm record:map-demo', () => {
  it('writes its take, exports, stills and timing for review only where git ignores them', () => {
    expect(relative(ROOT, RECORDING_DIR)).toBe(join('apps', 'map-demo', 'recording'));
    for (const name of [...Object.values(RECORDING_FILES), 'stills/01-page.png', 'timing.json']) {
      expect(ignored(relative(ROOT, join(RECORDING_DIR, name))), name).toBe(true);
    }
  });

  it('keeps exactly an MP4, a WebM, a poster and a loop in media/, tracked and within budget', () => {
    expect(relative(ROOT, MEDIA_DIR)).toBe(join('apps', 'map-demo', 'media'));
    expect(RECORDING_FILES).toEqual({
      video: 'map-demo.mp4',
      webm: 'map-demo.webm',
      poster: 'poster.png',
      loop: 'map-demo-loop.gif',
    });
    expect(MEDIA_BUDGET).toEqual({
      video: 4_000_000,
      webm: 4_000_000,
      poster: 300_000,
      loop: 3_000_000,
    });
    expect(readdirSync(MEDIA_DIR).sort()).toEqual(Object.values(RECORDING_FILES).sort());
    for (const part of Object.keys(RECORDING_FILES) as (keyof typeof RECORDING_FILES)[]) {
      const path = relative(ROOT, join(MEDIA_DIR, RECORDING_FILES[part]));
      expect(ignored(path), path).toBe(false);
      expect(tracked(path), path).toBe(true);
      expect(readFileSync(join(ROOT, path)).length, path).toBeLessThanOrEqual(MEDIA_BUDGET[part]);
    }
  });

  it('holds an H.264 MP4 a player starts at once, 4:2:0, 1280 by 720, under a minute and a half', () => {
    const facts = mp4Facts(readFileSync(join(MEDIA_DIR, RECORDING_FILES.video)));
    expect(facts.order[0]).toBe('ftyp');
    // Fast start: the index comes before the frames, so a player starts before the download ends.
    expect(facts.order.indexOf('moov')).toBeLessThan(facts.order.indexOf('mdat'));
    expect(facts.codec).toBe('avc1');
    // Baseline, Main or High: profiles that carry 4:2:0 alone, which every player decodes.
    expect([66, 77, 100]).toContain(facts.profile);
    expect([facts.width, facts.height]).toEqual([FRAME.width, FRAME.height]);
    expect(facts.seconds).toBeGreaterThan(40);
    expect(facts.seconds).toBeLessThan(90);
  });

  it('holds a WebM beside it and a 1280 by 720 PNG poster', () => {
    const webm = readFileSync(join(MEDIA_DIR, RECORDING_FILES.webm));
    // An EBML header naming the webm document type.
    expect([...webm.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    expect(webm.subarray(0, 64).includes(Buffer.from('webm'))).toBe(true);
    const poster = readFileSync(join(MEDIA_DIR, RECORDING_FILES.poster));
    expect(pngDimensions(new Uint8Array(poster))).toEqual(FRAME);
  });

  it('holds a looping GIF the README shows whole, six to ten seconds long', () => {
    const facts = gifFacts(readFileSync(join(MEDIA_DIR, RECORDING_FILES.loop)));
    expect(LOOP).toEqual({ maxWidth: 800, minSeconds: 6, maxSeconds: 10 });
    expect(facts.width).toBeLessThanOrEqual(LOOP.maxWidth);
    // The take's shape, scaled down whole.
    expect(Math.abs(facts.width / facts.height - FRAME.width / FRAME.height)).toBeLessThan(0.01);
    expect(facts.loops).toBe(true);
    expect(facts.frames).toBeGreaterThan(10);
    expect(facts.seconds).toBeGreaterThanOrEqual(LOOP.minSeconds - 0.5);
    expect(facts.seconds).toBeLessThanOrEqual(LOOP.maxSeconds + 0.5);
  });

  it('runs from the root and from the end-to-end package, and from no CI workflow', () => {
    const scripts = (dir: string): Record<string, string> =>
      (
        JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as {
          scripts: Record<string, string>;
        }
      ).scripts;
    expect(scripts('.')['record:map-demo']).toBe('pnpm --filter @tabdock/e2e record:map-demo');
    expect(scripts('tests/e2e')['record:map-demo']).toBe('node src/record-map-demo.ts');
    const workflows = join(ROOT, '.github', 'workflows');
    for (const workflow of readdirSync(workflows)) {
      const text = readFileSync(join(workflows, workflow), 'utf8');
      expect(text, workflow).not.toContain('record:map-demo');
    }
  });
});

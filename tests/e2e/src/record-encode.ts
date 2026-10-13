// The ffmpeg half of pnpm record:map-demo (record-map-demo.ts), by hand only:
// ffmpeg 6 on the PATH, never in CI. It joins the client pane's video and the
// map page's video side by side, trimmed so both start at the same moment,
// into one lossless master, and makes each file the page and the README use
// from it, stepping a video's quality down until it fits its budget rather
// than ever raising one. Nothing it runs prints a code or a token: its
// inputs are pictures, and it prints nothing but file paths.

import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';

/** A Playwright video's frame rate: it writes every frame 40 ms long (its videoRecorder). */
export const SOURCE_FPS = 25;

/** Threads ffmpeg may take: the machine's CPUs are shared, so not all of them. */
const THREADS = '3';

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const said = stderr.trim().split('\n').slice(-3).join(' ');
        rejectRun(new Error(`${command} failed: ${said === '' ? error.message : said}`));
        return;
      }
      resolveRun(stdout);
    });
  });
}

const ffmpeg = (args: string[]): Promise<string> =>
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args]);

/** Whether ffmpeg and ffprobe answer, checked before a take is filmed so a missing one costs nothing. */
export async function haveFfmpeg(): Promise<boolean> {
  try {
    await run('ffmpeg', ['-hide_banner', '-version']);
    await run('ffprobe', ['-hide_banner', '-version']);
    return true;
  } catch {
    return false;
  }
}

/** How many frames a video holds, counted by decoding it. */
export async function frameCount(file: string): Promise<number> {
  const out = await run('ffprobe', [
    '-v',
    'error',
    '-count_frames',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=nb_read_frames',
    '-of',
    'csv=p=0',
    file,
  ]);
  const frames = Number.parseInt(out.trim(), 10);
  if (!Number.isInteger(frames) || frames <= 0) throw new Error(`no frames in ${file}`);
  return frames;
}

/** A video's length in seconds, as ffprobe reads its container. */
export async function duration(file: string): Promise<number> {
  const out = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    file,
  ]);
  const seconds = Number.parseFloat(out.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`no duration for ${file}`);
  return seconds;
}

export interface Side {
  file: string;
  /** Seconds into this video at which the take begins. */
  from: number;
}

/**
 * The two videos side by side, left then right, each from its own start
 * and for `seconds`, into a lossless master at the sources' frame rate, so
 * every export after it loses only once.
 */
export async function joinSideBySide(
  left: Side,
  right: Side,
  seconds: number,
  out: string,
): Promise<void> {
  const cut = (input: number, side: Side, label: string): string =>
    `[${String(input)}:v]trim=start=${side.from.toFixed(3)}:duration=${seconds.toFixed(3)},setpts=PTS-STARTPTS[${label}]`;
  await ffmpeg([
    '-i',
    left.file,
    '-i',
    right.file,
    '-filter_complex',
    `${cut(0, left, 'l')};${cut(1, right, 'r')};[l][r]hstack=inputs=2,fps=${String(SOURCE_FPS)},format=yuv444p[v]`,
    '-map',
    '[v]',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-qp',
    '0',
    '-threads',
    THREADS,
    out,
  ]);
}

/**
 * Encodes with each quality in turn, best first, until the file fits
 * `budget` bytes; the last one tried stays on disk either way. Returns its
 * size.
 */
async function withinBudget(
  qualities: readonly number[],
  budget: number,
  encode: (quality: number) => Promise<void>,
  out: string,
): Promise<number> {
  let size = Number.POSITIVE_INFINITY;
  for (const quality of qualities) {
    await encode(quality);
    size = statSync(out).size;
    if (size <= budget) return size;
  }
  return size;
}

/** H.264 in an MP4, 4:2:0 for every player, its index first so it plays while it loads. */
export function exportMp4(master: string, out: string, budget: number): Promise<number> {
  return withinBudget(
    [20, 22, 24, 26, 28, 30],
    budget,
    (crf) =>
      ffmpeg([
        '-i',
        master,
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'slow',
        '-tune',
        'stillimage',
        '-crf',
        String(crf),
        '-profile:v',
        'high',
        '-pix_fmt',
        'yuv420p',
        '-g',
        String(SOURCE_FPS * 4),
        '-movflags',
        '+faststart',
        '-threads',
        THREADS,
        out,
      ]).then(() => undefined),
    out,
  );
}

/** VP9 in a WebM, for a browser that plays no H.264. */
export function exportWebm(master: string, out: string, budget: number): Promise<number> {
  return withinBudget(
    [30, 33, 36, 40, 44],
    budget,
    (crf) =>
      ffmpeg([
        '-i',
        master,
        '-an',
        '-c:v',
        'libvpx-vp9',
        '-crf',
        String(crf),
        '-b:v',
        '0',
        '-deadline',
        'good',
        '-cpu-used',
        '3',
        '-row-mt',
        '1',
        '-tile-columns',
        '2',
        '-pix_fmt',
        'yuv420p',
        '-g',
        String(SOURCE_FPS * 4),
        '-threads',
        THREADS,
        out,
      ]).then(() => undefined),
    out,
  );
}

/**
 * A looping GIF of `seconds` from `from` in the master, `width` pixels wide,
 * with one palette made for those frames; fewer frames a second and fewer
 * colours each try until it fits.
 */
export function exportGif(
  master: string,
  from: number,
  seconds: number,
  width: number,
  out: string,
  budget: number,
): Promise<number> {
  const tries = [
    { fps: 12, colours: 192 },
    { fps: 10, colours: 128 },
    { fps: 8, colours: 96 },
  ];
  return withinBudget(
    tries.map((_, index) => index),
    budget,
    (index) => {
      const { fps, colours } = tries[index] ?? { fps: 8, colours: 96 };
      return ffmpeg([
        '-ss',
        from.toFixed(3),
        '-t',
        seconds.toFixed(3),
        '-i',
        master,
        '-filter_complex',
        `fps=${String(fps)},scale=${String(width)}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=${String(colours)}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
        '-loop',
        '0',
        out,
      ]).then(() => undefined);
    },
    out,
  );
}

/**
 * Two screenshots side by side as one PNG, left then right; over `budget`,
 * the same picture again in 256 colours.
 */
export function joinPng(left: string, right: string, out: string, budget: number): Promise<number> {
  return withinBudget(
    [0, 1],
    budget,
    (quantize) =>
      ffmpeg([
        '-i',
        left,
        '-i',
        right,
        '-filter_complex',
        quantize === 0
          ? '[0:v][1:v]hstack=inputs=2,format=rgb24'
          : '[0:v][1:v]hstack=inputs=2,split[a][b];[a]palettegen=max_colors=256:stats_mode=single[p];[b][p]paletteuse=dither=none',
        '-frames:v',
        '1',
        '-compression_level',
        '9',
        out,
      ]).then(() => undefined),
    out,
  );
}

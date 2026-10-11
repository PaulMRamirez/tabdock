// pnpm measure:room: ADR 0044's room measurement (A6.22), run by hand and
// kept out of CI. It needs root (for its cgroups and its own network
// namespace), Playwright's Chromium, and about 75 minutes. It starts main.ts as
// the container image does, under the image's heap flag, inside a 512 MiB
// group held to one CPU (cgroup v1 where it can, decision 31, then cgroup
// v2, a systemd user scope, or the heap flag alone with RSS measured),
// drives a class of 40, a class of 80, and two classes of 40 on two pages
// through each phase of measure-room/room.ts, then joins a class of 40 from
// one address, as behind a campus NAT, and times the projected tab's frames
// under watchers' calls (measure-room/frames.ts). It runs inside a network
// namespace of its own where it can (measure-room/netns.ts), so narrowing
// TCP buffers for the unread phases changes nothing else on the machine. It
// prints each bar with its figure and writes every figure, with the commit,
// the relay's limits and how it ran, to a JSON file beside
// docs/notes/m6/room-measure.md, which reads them. No token, secret, code
// or invite link is printed or written.

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { cpus, release, totalmem } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_LIMITS, DEFAULT_RATE_LIMITS } from '@tabdock/relay';
import { RESPONSE_CEILING_LINE } from '../../../packages/relay/src/response-stalls.ts';
import { type Bar, BARS, barsOf } from './measure-room/bars.ts';
import {
  type Confinement,
  confine,
  pinHarness,
  relayCpu,
  sweepStaleGroups,
} from './measure-room/confine.ts';
import { measureFrames, type FrameRun, LATE_FRAME_MS } from './measure-room/frames.ts';
import { insideOwnNamespace, loopbackUp, runInOwnNamespace } from './measure-room/netns.ts';
import {
  FILL_SPACING_MS,
  imageHeapFlag,
  killRelays,
  MAX_STUDENTS,
  measureRoom,
  type RoomPlan,
  type RoomResult,
} from './measure-room/room.ts';
import { type NarrowScope, restoreSocketBuffers } from './measure-room/sockets.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const RAW = join(ROOT, 'docs/notes/m6/room-measure.raw.json');

const USAGE = `pnpm measure:room [options]

Needs root, for its cgroups and a network namespace of its own, Playwright's
Chromium for the frames, and about 75 minutes, 7 more for each frame repeat.

  --sizes <list>       classes to run, comma separated: n for a class of n on one
                       page, or PxN for P classes of N on P pages (default 40,80,2x40)
  --phase-minutes <n>  the class phase's length; the others scale from it (default 5)
  --quick              a smoke run: a class of 6, 20 s phases, written under test-results
  --skip <list>        any of: rooms, nat, frames
  --frame-repeats <n>  time the frames this many times over, since one tab varies (default 1)
  --out <file>         where the figures go (default docs/notes/m6/room-measure.raw.json)
  --narrow-host-tcp    where no network namespace of its own can be made, narrow the
                       HOST's tcp_rmem and tcp_wmem for the unread phases (every
                       connection on the machine meanwhile), putting them back after;
                       without it those phases run on the buffers as they are
`;

function fail(message: string): never {
  process.stderr.write(`measure:room: ${message}\n`);
  process.exit(1);
}

function readArgs() {
  const given = process.argv.slice(2);
  try {
    return parseArgs({
      args: given[0] === '--' ? given.slice(1) : given,
      options: {
        sizes: { type: 'string' },
        'phase-minutes': { type: 'string' },
        quick: { type: 'boolean', default: false },
        skip: { type: 'string' },
        'frame-repeats': { type: 'string' },
        out: { type: 'string' },
        'narrow-host-tcp': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
  }
}

const values = readArgs();
if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
const quick = values.quick;
const sizes = (values.sizes ?? (quick ? '6' : '40,80,2x40')).split(',').map((text) => {
  const found = /^(?:(\d)x)?(\d{1,3})$/.exec(text);
  const pages = Number(found?.[1] ?? '1');
  const size = Number(found?.[2] ?? NaN);
  if (found === null || size < 1 || size > 100 || pages < 1 || pages * size > MAX_STUDENTS) {
    fail(
      `--sizes takes n (1 to 100) or PxN, comma separated, at most ${String(MAX_STUDENTS)} students a run`,
    );
  }
  return { size, pages };
});
const phaseMinutes =
  values['phase-minutes'] === undefined ? (quick ? 1 / 3 : 5) : Number(values['phase-minutes']);
if (!(phaseMinutes > 0 && phaseMinutes <= 60))
  fail('--phase-minutes takes a number above 0, at most 60');
const skip = new Set((values.skip ?? '').split(',').filter((part) => part !== ''));
for (const part of skip) {
  if (!['rooms', 'nat', 'frames'].includes(part)) fail(`--skip takes rooms, nat or frames`);
}
const frameRepeats = Number(values['frame-repeats'] ?? '1');
if (!Number.isInteger(frameRepeats) || frameRepeats < 1 || frameRepeats > 10) {
  fail('--frame-repeats takes a whole number from 1 to 10');
}
// pnpm runs the script in tests/e2e, so a relative --out is read from where pnpm was run.
const out =
  values.out === undefined
    ? quick
      ? join(ROOT, 'tests/e2e/test-results/room-measure.quick.json')
      : RAW
    : resolve(process.env.INIT_CWD ?? process.cwd(), values.out);

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

// The run goes on inside a namespace of its own where one can be made; this
// process then only waits for it and passes its exit code on.
const outer = await runInOwnNamespace();
if (outer !== null) process.exit(outer);

let narrow: NarrowScope = 'none';
if (insideOwnNamespace()) {
  const down = loopbackUp();
  if (down !== null) fail(`the run's own network namespace has no loopback: ${down}`);
  narrow = 'namespace';
  say('measure:room runs in a network namespace of its own');
} else if (values['narrow-host-tcp']) {
  narrow = 'host';
  say(
    'WARNING: no network namespace of its own could be made, so the unread phases narrow the HOST TCP buffers (--narrow-host-tcp), for every connection on this machine until they end',
  );
} else {
  say(
    'note: no network namespace of its own could be made and --narrow-host-tcp was not given, so the unread phases run on the TCP buffers as they are',
  );
}

/** The groups in use, so an interrupt can stop what runs in them and remove them. */
const active = new Set<Confinement>();
let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  say('measure:room interrupted: stopping relays, removing groups, putting settings back');
  killRelays();
  for (const confinement of active) confinement.killAll();
  restoreSocketBuffers();
  void Promise.allSettled([...active].map((confinement) => confinement.close())).then(() => {
    process.exit(130);
  });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

for (const note of sweepStaleGroups()) say(`note: ${note}`);

function git(args: string[]): string | null {
  const ran = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return ran.status === 0 ? ran.stdout.trim() : null;
}

function settingsFor(size: number, pages: number): Record<string, string> {
  // Past the default seats, a class names its seats; past one class of 40, the
  // pool is named for two sessions a student and a margin, as the guide says.
  const students = size * pages;
  return {
    ...(size <= 40 ? {} : { TABDOCK_MAX_OBSERVERS_PER_PAGE: String(size) }),
    ...(students <= 40
      ? {}
      : { TABDOCK_MAX_INVITEE_SESSIONS: String(Math.max(100, Math.ceil(students * 2.5))) }),
  };
}

function phasePlan(
  size: number,
  pages: number,
  sharedAddress: boolean,
  joinOnly: boolean,
): RoomPlan {
  const ms = phaseMinutes * 60_000;
  return {
    size,
    pages,
    settings: settingsFor(size, pages),
    sharedAddress,
    joinOnly,
    phaseMs: {
      class: ms,
      agents: Math.round(ms * 0.4),
      stalled: Math.round(ms * 0.3),
      ceiling: Math.max(Math.round(ms * 0.5), quick ? 20_000 : size * 2 * FILL_SPACING_MS + 30_000),
    },
    joinSpreadMs: quick ? 5000 : 30_000,
    narrow,
  };
}

const started = new Date();
const harnessCpu = pinHarness(relayCpu());
const machine = {
  date: started.toISOString(),
  commit: git(['rev-parse', 'HEAD']),
  /** Whether the checkout had changes the commit does not hold. */
  uncommitted: (git(['status', '--porcelain']) ?? '') !== '',
  cpu: cpus()[0]?.model ?? 'unknown',
  cpus: cpus().length,
  memoryGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
  kernel: release(),
  node: process.version,
  heapFlag: imageHeapFlag(),
  harnessCpus: harnessCpu,
  network: narrow,
  /** The relay's limits as this checkout ships them; each room's settings add to them. */
  limits: DEFAULT_LIMITS,
  rateLimits: DEFAULT_RATE_LIMITS,
};
say(
  `measure:room on ${machine.cpu}, ${String(machine.cpus)} CPUs, Node ${machine.node}, ${machine.heapFlag}, commit ${String(machine.commit)}${machine.uncommitted ? ' with uncommitted changes' : ''}`,
);

const rooms: { result: RoomResult; bars: Bar[] }[] = [];
let nat: RoomResult | null = null;
let frames: { runs: FrameRun[]; browser: string } | null = null;
/** Each repeat after the first, kept apart so a one-repeat file reads as before. */
const moreFrames: { runs: FrameRun[]; browser: string }[] = [];
const failures: string[] = [];

async function confined<T>(name: string, run: (confinement: Confinement) => Promise<T>) {
  const confinement = confine(`tabdock-measure-${String(process.pid)}-${name}`);
  active.add(confinement);
  try {
    return await run(confinement);
  } finally {
    await confinement.close();
    active.delete(confinement);
  }
}

if (!skip.has('rooms')) {
  for (const { size, pages } of sizes) {
    const label = pages === 1 ? String(size) : `${String(pages)}x${String(size)}`;
    try {
      await confined(label, async (confinement) => {
        say(
          `${pages === 1 ? `room of ${String(size)}` : `${String(pages)} rooms of ${String(size)}`} (${confinement.kind}${confinement.cpu === null ? '' : `, relay on CPU ${String(confinement.cpu)}`})`,
        );
        for (const note of confinement.notes) say(`  note: ${note}`);
        const result = await measureRoom(phasePlan(size, pages, false, false), confinement, say);
        const bars = barsOf(result);
        rooms.push({ result, bars });
        for (const bar of bars) say(`  ${bar.pass ? 'PASS' : 'FAIL'} ${bar.name}: ${bar.value}`);
        for (const reason of result.skipped) say(`  skipped ${reason}`);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`rooms of ${label}: ${message}`);
      say(`  the run failed: ${message}`);
    }
  }
}

if (!skip.has('nat')) {
  const size = quick ? 6 : 40;
  try {
    await confined('nat', async (confinement) => {
      say(`a class of ${String(size)} joining from one address (${confinement.kind})`);
      nat = await measureRoom(phasePlan(size, 1, true, true), confinement, say);
    });
  } catch (error) {
    failures.push(`shared address join: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (!skip.has('frames')) {
  for (let repeat = 1; repeat <= frameRepeats; repeat += 1) {
    say(
      `frames on the canvas map page under watchers' calls (${String(repeat)} of ${String(frameRepeats)})`,
    );
    try {
      const timed = await measureFrames(quick ? 5 : 40, say);
      if (frames === null) frames = timed;
      else moreFrames.push(timed);
    } catch (error) {
      failures.push(`frames: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

writeFileSync(
  out,
  `${JSON.stringify(
    {
      machine,
      phaseMinutes,
      bars: BARS,
      lateFrameMs: LATE_FRAME_MS,
      ceilingLine: RESPONSE_CEILING_LINE,
      rooms: rooms.map(({ result, bars }) => ({ ...result, bars })),
      sharedAddressJoin: nat,
      frames,
      ...(moreFrames.length === 0 ? {} : { moreFrames }),
      failures,
    },
    null,
    2,
  )}\n`,
);
say(`figures written to ${out.startsWith(ROOT) ? relative(ROOT, out) : out}`);
const failed = failures.length > 0 || rooms.some(({ bars }) => bars.some((bar) => !bar.pass));
if (failures.length > 0) for (const failure of failures) say(`FAILED ${failure}`);
// The SDK clients and the provider may leave a keep-alive timer behind; the run is over.
process.exit(failed ? 1 : 0);

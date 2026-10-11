// pnpm measure:room: ADR 0044's room measurement (A6.22), run by hand and
// kept out of CI. It starts main.ts as the container image does, under the
// image's heap flag, inside a 512 MiB group held to one CPU (cgroup v1 where
// it can, decision 31, then cgroup v2, a systemd user scope, or the heap flag
// alone with RSS measured), drives a class of 40 and then 80 watchers on one
// page through each phase of measure-room/room.ts, then joins a class of 40
// from one address, as behind a campus NAT, and times the projected tab's
// frames under watchers' calls (measure-room/frames.ts). It prints each bar
// with its figure and writes every figure to a JSON file beside
// docs/notes/m6/room-measure.md, which reads them. No token, secret, code or
// invite link is printed or written.

import { writeFileSync } from 'node:fs';
import { cpus, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { RESPONSE_CEILING_LINE } from '../../../packages/relay/src/response-stalls.ts';
import { confine, pinHarness, relayCpu } from './measure-room/confine.ts';
import { measureFrames, type FrameRun, LATE_FRAME_MS } from './measure-room/frames.ts';
import { imageHeapFlag, measureRoom, type RoomPlan, type RoomResult } from './measure-room/room.ts';
import { MIB } from './measure-room/stats.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const RAW = join(ROOT, 'docs/notes/m6/room-measure.raw.json');

const USAGE = `pnpm measure:room [options]

  --sizes <n,n>        classes to run on one page (default 40,80)
  --phase-minutes <n>  the class phase's length; the others scale from it (default 5)
  --quick              a smoke run: a class of 6, 20 s phases, written under test-results
  --skip <list>        any of: rooms, nat, frames
  --out <file>         where the figures go (default docs/notes/m6/room-measure.raw.json)
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
        out: { type: 'string' },
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
const sizes = (values.sizes ?? (quick ? '6' : '40,80')).split(',').map((text) => {
  if (!/^\d{1,3}$/.test(text) || Number(text) < 1 || Number(text) > 100) {
    fail('--sizes takes whole numbers from 1 to 100, comma separated');
  }
  return Number(text);
});
const phaseMinutes =
  values['phase-minutes'] === undefined ? (quick ? 1 / 3 : 5) : Number(values['phase-minutes']);
if (!(phaseMinutes > 0 && phaseMinutes <= 60))
  fail('--phase-minutes takes a number above 0, at most 60');
const skip = new Set((values.skip ?? '').split(',').filter((part) => part !== ''));
for (const part of skip) {
  if (!['rooms', 'nat', 'frames'].includes(part)) fail(`--skip takes rooms, nat or frames`);
}
const out =
  values.out ?? (quick ? join(ROOT, 'tests/e2e/test-results/room-measure.quick.json') : RAW);

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** The bars ADR 0044's design sets, each against what the run measured. */
export const BARS = {
  /** 400 MB of the reference host's 512 MB, in MiB. */
  rssMiB: (400 * 1000 * 1000) / MIB,
  heapAfterGcMiB: 150,
  eventLoopP99Ms: 50,
  teacherP95Ms: 250,
} as const;

interface Bar {
  name: string;
  value: string;
  pass: boolean;
}

function barsOf(room: RoomResult): Bar[] {
  const burst = room.phases.filter((phase) => phase.quotaUs === null || phase.quotaUs >= 80_000);
  const max = (
    pick: (phase: RoomResult['phases'][number]) => number | null,
    phases = room.phases,
  ): number | null =>
    phases.reduce<number | null>((top, phase) => {
      const value = pick(phase);
      return value === null ? top : top === null ? value : Math.max(top, value);
    }, null);
  const rss = max((phase) => phase.peaks.vmHwmMiB ?? phase.peaks.vmRssMiB);
  const heap = max((phase) => phase.heapAfterGcMiB);
  const loop = max((phase) => phase.eventLoopMs.p99, burst);
  const teacher = max((phase) => phase.calls['teacher set_view']?.latency.p95 ?? null, burst);
  const guest503 =
    room.join.sessionRefusals +
    room.phases.reduce((sum, phase) => sum + (phase.statuses['http 503'] ?? 0), 0);
  // At the baseline quota the relay is meant to fall behind, so only burst phases hold the teacher to an answer.
  const teacherFailed = burst.reduce((sum, phase) => {
    const outcomes = phase.calls['teacher set_view']?.outcomes ?? {};
    return (
      sum +
      Object.entries(outcomes).reduce(
        (n, [outcome, count]) => n + (outcome === 'ok' ? 0 : count),
        0,
      )
    );
  }, 0);
  const memberCuts = room.phases.reduce(
    (sum, phase) =>
      sum +
      Object.entries(phase.logLines)
        .filter(([line]) => line.includes('cut off') && line.endsWith('(teacher)'))
        .reduce((n, [, count]) => n + count, 0),
    0,
  );
  const oom = max((phase) => phase.oomKills);
  const text = (value: number | null, unit: string): string =>
    value === null ? 'not measured' : `${String(value)} ${unit}`;
  return [
    {
      name: 'peak RSS at most 400 MB',
      value: text(rss, 'MiB'),
      pass: rss !== null && rss <= BARS.rssMiB,
    },
    {
      name: 'heap after GC at most 150 MiB',
      value: text(heap, 'MiB'),
      pass: heap !== null && heap <= BARS.heapAfterGcMiB,
    },
    {
      name: 'event loop p99 at most 50 ms at the burst quota',
      value: text(loop, 'ms'),
      pass: loop !== null && loop <= BARS.eventLoopP99Ms,
    },
    {
      name: "teacher's set_view p95 at most 250 ms at the burst quota",
      value: text(teacher, 'ms'),
      pass: teacher !== null && teacher <= BARS.teacherP95Ms,
    },
    { name: 'no guest 503', value: String(guest503), pass: guest503 === 0 },
    {
      name: 'no member cut, and every teacher call answered at the burst quota',
      value: `${String(memberCuts)} cut, ${String(teacherFailed)} failed`,
      pass: memberCuts === 0 && teacherFailed === 0,
    },
    {
      name: 'no OOM kill in the group',
      value: oom === null ? 'no group' : String(oom),
      pass: oom === null || oom === 0,
    },
  ];
}

function settingsFor(size: number): Record<string, string> {
  // A class past the default seats names the seats and a pool for two sessions each and a margin.
  return size <= 40
    ? {}
    : {
        TABDOCK_MAX_OBSERVERS_PER_PAGE: String(size),
        TABDOCK_MAX_INVITEE_SESSIONS: String(Math.max(100, Math.ceil(size * 2.5))),
      };
}

function phasePlan(size: number, sharedAddress: boolean, joinOnly: boolean): RoomPlan {
  const ms = phaseMinutes * 60_000;
  return {
    size,
    settings: settingsFor(size),
    sharedAddress,
    joinOnly,
    phaseMs: {
      class: ms,
      agents: Math.round(ms * 0.4),
      stalled: Math.round(ms * 0.3),
      ceiling: Math.max(Math.round(ms * 0.5), quick ? 20_000 : size * 2 * 520 + 30_000),
    },
    joinSpreadMs: quick ? 5000 : 30_000,
  };
}

const started = new Date();
const harnessCpu = pinHarness(relayCpu());
const machine = {
  date: started.toISOString(),
  cpu: cpus()[0]?.model ?? 'unknown',
  cpus: cpus().length,
  memoryGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
  kernel: release(),
  node: process.version,
  heapFlag: imageHeapFlag(),
  harnessCpus: harnessCpu,
};
say(
  `measure:room on ${machine.cpu}, ${String(machine.cpus)} CPUs, Node ${machine.node}, ${machine.heapFlag}`,
);

const rooms: { result: RoomResult; bars: Bar[] }[] = [];
let nat: RoomResult | null = null;
let frames: { runs: FrameRun[]; browser: string } | null = null;
const failures: string[] = [];

if (!skip.has('rooms')) {
  for (const size of sizes) {
    const confinement = confine(`tabdock-measure-${String(process.pid)}-${String(size)}`);
    say(
      `room of ${String(size)} (${confinement.kind}${confinement.cpu === null ? '' : `, relay on CPU ${String(confinement.cpu)}`})`,
    );
    for (const note of confinement.notes) say(`  note: ${note}`);
    try {
      const result = await measureRoom(phasePlan(size, false, false), confinement, say);
      const bars = barsOf(result);
      rooms.push({ result, bars });
      for (const bar of bars) say(`  ${bar.pass ? 'PASS' : 'FAIL'} ${bar.name}: ${bar.value}`);
    } catch (error) {
      failures.push(
        `room of ${String(size)}: ${error instanceof Error ? error.message : String(error)}`,
      );
      say(`  the run failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await confinement.close();
    }
  }
}

if (!skip.has('nat')) {
  const size = quick ? 6 : 40;
  const confinement = confine(`tabdock-measure-${String(process.pid)}-nat`);
  say(`a class of ${String(size)} joining from one address (${confinement.kind})`);
  try {
    nat = await measureRoom(phasePlan(size, true, true), confinement, say);
  } catch (error) {
    failures.push(`shared address join: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await confinement.close();
  }
}

if (!skip.has('frames')) {
  say("frames on the canvas map page under watchers' calls");
  try {
    frames = await measureFrames(quick ? 5 : 40, say);
  } catch (error) {
    failures.push(`frames: ${error instanceof Error ? error.message : String(error)}`);
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
      failures,
    },
    null,
    2,
  )}\n`,
);
say(`figures written to ${out.startsWith(ROOT) ? out.slice(ROOT.length) : out}`);
const failed = failures.length > 0 || rooms.some(({ bars }) => bars.some((bar) => !bar.pass));
if (failures.length > 0) for (const failure of failures) say(`FAILED ${failure}`);
// The SDK clients and the provider may leave a keep-alive timer behind; the run is over.
process.exit(failed ? 1 : 0);

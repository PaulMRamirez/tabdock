// The bars ADR 0044's design sets for a room (A6.22), each scored from what
// the run saw for itself: memory and the loop from the probe inside the
// relay, the teacher's calls and held answers from the teacher's own client,
// and refusals from the status of every answer. A member's cut is judged by
// the teacher's answers left unread through the ceiling phase, each of which
// must end whole, since a log line about a cut names its user only the first
// time in a window (repeated-lines.ts).

import { MIB } from './stats.ts';

/** One whole CPU per period: phases at or above it, or with no quota at all, are burst phases. */
const BURST_QUOTA_US = 80_000;

export const BARS = {
  /** 400 MB of the reference host's 512 MB, in MiB. */
  rssMiB: (400 * 1000 * 1000) / MIB,
  heapAfterGcMiB: 150,
  eventLoopP99Ms: 50,
  teacherP95Ms: 250,
} as const;

export interface Bar {
  name: string;
  value: string;
  pass: boolean;
}

/** What scoring reads of a phase; room.ts's PhaseResult has all of it. */
export interface ScoredPhase {
  quotaUs: number | null;
  peaks: { vmHwmMiB: number | null; vmRssMiB: number | null };
  heapAfterGcUnderLoadMiB: number | null;
  eventLoopMs: { p99: number | null };
  calls: Record<string, { latency: { p95: number | null }; outcomes: Record<string, number> }>;
  statuses: Record<string, number>;
  oomKills: number | null;
  memberHeld: { asked: number; outcomes: Record<string, number> };
}

export interface ScoredRoom {
  join: { sessionRefusals: number };
  phases: readonly ScoredPhase[];
}

export function barsOf(room: ScoredRoom): Bar[] {
  const burst = room.phases.filter(
    (phase) => phase.quotaUs === null || phase.quotaUs >= BURST_QUOTA_US,
  );
  const max = (
    pick: (phase: ScoredPhase) => number | null,
    phases: readonly ScoredPhase[] = room.phases,
  ): number | null =>
    phases.reduce<number | null>((top, phase) => {
      const value = pick(phase);
      return value === null ? top : top === null ? value : Math.max(top, value);
    }, null);
  const rss = max((phase) => phase.peaks.vmHwmMiB ?? phase.peaks.vmRssMiB);
  const heap = max((phase) => phase.heapAfterGcUnderLoadMiB);
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
  const held = room.phases.reduce((sum, phase) => sum + phase.memberHeld.asked, 0);
  const heldCut = room.phases.reduce((sum, phase) => sum + (phase.memberHeld.outcomes.cut ?? 0), 0);
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
      name: 'heap after GC, taken under load, at most 150 MiB',
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
      // A run whose teacher held nothing unread could not see a member's cut, so it fails.
      name: "no member cut: the teacher's unread answers all end whole",
      value: `${String(held)} held, ${String(heldCut)} cut`,
      pass: held > 0 && heldCut === 0,
    },
    {
      name: 'every teacher call answered at the burst quota',
      value: `${String(teacherFailed)} failed`,
      pass: teacherFailed === 0,
    },
    {
      name: 'no OOM kill in the group',
      value: oom === null ? 'no group' : String(oom),
      pass: oom === null || oom === 0,
    },
  ];
}

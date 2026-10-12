// A6.22's record (ADR 0044). pnpm measure:room needs root, cgroups and about
// 75 minutes, so no CI job runs it; what the suite can hold is the run it
// wrote, docs/notes/m6/room-measure.raw.json, against the code as it stands.
// Every room's figures must pass the bars bars.ts scores today, the class of
// 40 must have run on the shipped defaults with no setting named, the limits
// and rates the run recorded must be the ones config.ts ships now, and the
// relay must have run as the image runs it. A default changed later, a bar
// moved, or a heap flag the Dockerfile no longer uses fails here until
// pnpm measure:room is run again and its file committed, so the audit's
// claim that the shipped defaults pass the bars cannot go stale unseen.

import { DEFAULT_LIMITS, DEFAULT_RATE_LIMITS } from '@tabdock/relay';
import { describe, expect, it } from 'vitest';
import { readRepo } from '../src/doc-files.ts';
import { type Bar, BARS, barsOf, type ScoredPhase } from '../src/measure-room/bars.ts';
import { type ConfinementKind, MEMORY_LIMIT_BYTES } from '../src/measure-room/confine.ts';
import { imageHeapFlag } from '../src/measure-room/room.ts';

const RAW = 'docs/notes/m6/room-measure.raw.json';

/** The settings the guide tells a larger room to name (guide page 14); nothing else may differ. */
const ROOM_SETTINGS = ['TABDOCK_MAX_OBSERVERS_PER_PAGE', 'TABDOCK_MAX_INVITEE_SESSIONS'];

/** Groups that hold the relay to a memory limit and a CPU quota; anything else is a fallback. */
const CGROUPS: readonly ConfinementKind[] = ['cgroup-v1', 'cgroup-v2'];

interface RecordedRoom {
  size: number;
  pages: number;
  settings: Record<string, string>;
  sharedAddress: boolean;
  confinement: { kind: string; cpu: number | null; notes: string[] };
  join: { students: number; joined: number; sessionRefusals: number };
  phases: (ScoredPhase & { name: string })[];
  skipped: string[];
  relayExit: string;
}

interface RoomRecord {
  machine: {
    commit: string | null;
    uncommitted: boolean;
    heapFlag: string;
    limits: Record<string, number>;
    rateLimits: Record<string, number>;
  };
  bars: Record<string, number>;
  rooms: (RecordedRoom & { bars: Bar[] })[];
  sharedAddressJoin: RecordedRoom | null;
  failures: string[];
}

// The file is the harness's own output, read back; each test checks the fields it relies on.
const record = JSON.parse(readRepo(RAW)) as RoomRecord;

function label(room: RecordedRoom): string {
  if (room.sharedAddress) return `the class of ${String(room.size)} behind one address`;
  return room.pages === 1
    ? `the room of ${String(room.size)}`
    : `${String(room.pages)} rooms of ${String(room.size)}`;
}

/** Each key whose value differs between what the run recorded and what the code ships now. */
function changed(recorded: Record<string, number>, shipped: object): string[] {
  const now = shipped as Record<string, unknown>;
  const keys = new Set([...Object.keys(recorded), ...Object.keys(now)]);
  return [...keys].filter((key) => recorded[key] !== now[key]).sort();
}

describe("the room measurement's record (A6.22, ADR 0044)", () => {
  it('was made at a commit with nothing uncommitted, and nothing in it failed', () => {
    expect(record.machine.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(record.machine.uncommitted).toBe(false);
    expect(record.failures).toEqual([]);
  });

  it('holds the planned rooms, 40 and 80 watchers, every class all in and every phase run', () => {
    const shapes = record.rooms.map((room) => `${String(room.pages)}x${String(room.size)}`);
    expect(shapes).toContain('1x40');
    expect(shapes).toContain('1x80');
    const joins = [
      ...record.rooms,
      ...(record.sharedAddressJoin === null ? [] : [record.sharedAddressJoin]),
    ];
    // Guide page 15 cites the class behind one address, so its join must be on record too.
    expect(record.sharedAddressJoin, 'the join from one address').not.toBeNull();
    for (const room of joins) {
      expect(room.join.students, label(room)).toBe(room.size * room.pages);
      expect(room.join.joined, label(room)).toBe(room.join.students);
      expect(room.skipped, label(room)).toEqual([]);
      expect(room.relayExit, label(room)).toBe('code 0');
    }
  });

  it('passes every bar in every room, scored again by bars.ts as it stands', () => {
    expect(record.bars, 'the bars the run was held to').toEqual(BARS);
    for (const room of record.rooms) {
      const scored = barsOf(room);
      expect(scored, `${label(room)}: the recorded verdicts are today's`).toEqual(room.bars);
      expect(
        scored.filter((bar) => !bar.pass).map((bar) => `${bar.name}: ${bar.value}`),
        label(room),
      ).toEqual([]);
    }
  });

  it('ran the class of 40 on the shipped defaults, and the larger rooms named only their seats and pool', () => {
    const forty = record.rooms.find((room) => room.size === 40 && room.pages === 1);
    expect(forty?.settings, 'the class of 40 names no setting').toEqual({});
    for (const room of record.rooms) {
      expect(
        Object.keys(room.settings).filter((name) => !ROOM_SETTINGS.includes(name)),
        label(room),
      ).toEqual([]);
    }
  });

  it('recorded the limits and rates config.ts ships now, so a default changed since needs the run again', () => {
    expect(
      changed(record.machine.limits, DEFAULT_LIMITS),
      'DEFAULT_LIMITS changed since the run: run pnpm measure:room again',
    ).toEqual([]);
    expect(
      changed(record.machine.rateLimits, DEFAULT_RATE_LIMITS),
      'DEFAULT_RATE_LIMITS changed since the run: run pnpm measure:room again',
    ).toEqual([]);
  });

  it("ran the relay as the image does, under the Dockerfile's heap flag in a 512 MiB group with a CPU quota", () => {
    expect(record.machine.heapFlag).toBe(imageHeapFlag());
    expect(MEMORY_LIMIT_BYTES).toBe(512 * 1024 * 1024);
    for (const room of record.rooms) {
      const { kind, notes } = room.confinement;
      if (CGROUPS.some((cgroup) => cgroup === kind)) {
        // Every phase set its quota, so its figures are the quota-limited ones the bars read.
        expect(
          room.phases.filter((phase) => phase.quotaUs === null).map((phase) => phase.name),
          label(room),
        ).toEqual([]);
      } else {
        // Where no cgroup could be made, the run must say which fallback it used and why.
        expect(notes.length, `${label(room)} ran under ${kind} with no note why`).toBeGreaterThan(
          0,
        );
      }
    }
  });
});

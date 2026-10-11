// Where the room measurement's relay runs (ADR 0044, decision 31): inside a
// group that holds it to the reference host's 512 MiB and to one CPU, Fly's
// shared-cpu-1x, whose quota is 6.25% of each 80 ms period once its burst
// balance is spent. Cgroup v1 memory and cpu groups come first, as decision 31
// says and as this sandbox offers; then a writable cgroup v2 directory with
// both controllers; then a systemd user scope; and only then nothing, where
// the relay runs pinned with taskset under the image's heap flag and its RSS
// is all that is measured. Each step that could not be taken is noted, so the
// report says which confinement the figures came from and why.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';

export const MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;
export const CPU_PERIOD_US = 80_000;
/** One whole CPU: the burst a shared-cpu-1x machine runs at while its balance lasts. */
export const BURST_QUOTA_US = 80_000;
/** Fly's documented baseline for shared-cpu-1x, 5 ms of each 80 ms period. */
export const BASELINE_QUOTA_US = 5_000;

export type ConfinementKind = 'cgroup-v1' | 'cgroup-v2' | 'systemd-run' | 'none';

export interface GroupStats {
  /** Bytes charged to the group now, and the most it held since the last resetPeak. */
  usageBytes: number;
  peakBytes: number | null;
  /** Times the group hit its limit, and processes the kernel killed for it. */
  limitHits: number | null;
  oomKills: number | null;
  /** Periods the CPU quota throttled, and for how long in all. */
  throttledPeriods: number | null;
  throttledMs: number | null;
}

export interface Confinement {
  readonly kind: ConfinementKind;
  /** Why each stronger confinement was not used, and anything else a reader should know. */
  readonly notes: readonly string[];
  /** The CPU the relay is pinned to, or null where taskset is missing. */
  readonly cpu: number | null;
  /** The command that starts `argv` inside the confinement before node runs any code. */
  wrap(argv: readonly string[]): { command: string; args: string[] };
  /** Sets the CPU quota per CPU_PERIOD_US period; false where it cannot. */
  setQuota(quotaUs: number): boolean;
  /** Starts the peak counter afresh, where the group keeps one that can be reset. */
  resetPeak(): void;
  stats(): GroupStats | null;
  /** Removes the groups once the relay is gone, trying again while the kernel lets go of it. */
  close(): Promise<void>;
}

function readNumber(path: string): number | null {
  try {
    const value = Number(readFileSync(path, 'utf8').trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** One `key value` line of a cgroup stat file. */
function statLine(path: string, key: string): number | null {
  try {
    const found = new RegExp(`^${key} (\\d+)$`, 'm').exec(readFileSync(path, 'utf8'));
    return found ? Number(found[1]) : null;
  } catch {
    return null;
  }
}

/** rmdir each group, again for a second or two while the kernel still counts the exited relay. */
async function removeGroups(dirs: readonly string[]): Promise<void> {
  for (const dir of dirs) {
    for (let attempt = 0; attempt < 40 && existsSync(dir); attempt += 1) {
      try {
        rmdirSync(dir);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
}

function hasCommand(name: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' }).status === 0;
}

/** The last CPU, for the relay, leaving the others to the harness and its clients. */
export function relayCpu(): number | null {
  if (!hasCommand('taskset')) return null;
  const count = cpus().length;
  return count >= 2 ? count - 1 : 0;
}

/** Keeps the harness, and every thread it starts, off the relay's CPU. */
export function pinHarness(cpu: number | null): string | null {
  if (cpu === null || cpus().length < 2) return null;
  const others = cpu === 0 ? `1-${String(cpus().length - 1)}` : `0-${String(cpu - 1)}`;
  const pinned = spawnSync('taskset', ['-a', '-p', '-c', others, String(process.pid)], {
    stdio: 'ignore',
  });
  return pinned.status === 0 ? others : null;
}

function pinned(cpu: number | null, argv: readonly string[]): string[] {
  return cpu === null ? [...argv] : ['taskset', '-c', String(cpu), ...argv];
}

/** The script that moves its own shell into each group, then becomes the command. */
const ENTER = 'while [ "$1" != -- ]; do echo $$ > "$1" || exit 97; shift; done; shift; exec "$@"';

function cgroupV1(name: string, cpu: number | null, notes: string[]): Confinement | null {
  const memory = `/sys/fs/cgroup/memory/${name}`;
  const cpuGroup = `/sys/fs/cgroup/cpu/${name}`;
  if (!existsSync('/sys/fs/cgroup/memory/cgroup.procs') || !existsSync('/sys/fs/cgroup/cpu')) {
    notes.push('cgroup v1: no memory and cpu hierarchies under /sys/fs/cgroup');
    return null;
  }
  try {
    mkdirSync(memory);
    mkdirSync(cpuGroup);
    writeFileSync(join(memory, 'memory.limit_in_bytes'), String(MEMORY_LIMIT_BYTES));
    // Swap would let the group past its limit; the reference host has none.
    if (existsSync(join(memory, 'memory.memsw.limit_in_bytes'))) {
      writeFileSync(join(memory, 'memory.memsw.limit_in_bytes'), String(MEMORY_LIMIT_BYTES));
    }
    writeFileSync(join(cpuGroup, 'cpu.cfs_period_us'), String(CPU_PERIOD_US));
    writeFileSync(join(cpuGroup, 'cpu.cfs_quota_us'), String(BURST_QUOTA_US));
  } catch (error) {
    notes.push(`cgroup v1: ${error instanceof Error ? error.message : String(error)}`);
    for (const dir of [memory, cpuGroup]) {
      try {
        rmdirSync(dir);
      } catch {
        // Not made, or already gone.
      }
    }
    return null;
  }
  return {
    kind: 'cgroup-v1',
    notes,
    cpu,
    wrap(argv) {
      const procs = [join(memory, 'cgroup.procs'), join(cpuGroup, 'cgroup.procs')];
      return {
        command: 'sh',
        args: ['-c', ENTER, 'sh', ...procs, '--', ...pinned(cpu, argv)],
      };
    },
    setQuota(quotaUs) {
      try {
        writeFileSync(join(cpuGroup, 'cpu.cfs_quota_us'), String(quotaUs));
        return true;
      } catch {
        return false;
      }
    },
    resetPeak() {
      try {
        writeFileSync(join(memory, 'memory.max_usage_in_bytes'), '0');
      } catch {
        // The peak then runs from the start.
      }
    },
    stats() {
      const usage = readNumber(join(memory, 'memory.usage_in_bytes'));
      if (usage === null) return null;
      const throttled = statLine(join(cpuGroup, 'cpu.stat'), 'throttled_time');
      return {
        usageBytes: usage,
        peakBytes: readNumber(join(memory, 'memory.max_usage_in_bytes')),
        limitHits: readNumber(join(memory, 'memory.failcnt')),
        oomKills: statLine(join(memory, 'memory.oom_control'), 'oom_kill'),
        throttledPeriods: statLine(join(cpuGroup, 'cpu.stat'), 'nr_throttled'),
        throttledMs: throttled === null ? null : throttled / 1e6,
      };
    },
    close() {
      return removeGroups([memory, cpuGroup]);
    },
  };
}

/** The cgroup v2 mount, if any, from /proc/mounts. */
function cgroupV2Root(): string | null {
  try {
    const line = readFileSync('/proc/mounts', 'utf8')
      .split('\n')
      .find((entry) => entry.split(' ')[2] === 'cgroup2');
    return line?.split(' ')[1] ?? null;
  } catch {
    return null;
  }
}

function cgroupV2(name: string, cpu: number | null, notes: string[]): Confinement | null {
  const root = cgroupV2Root();
  if (root === null) {
    notes.push('cgroup v2: not mounted');
    return null;
  }
  const controllers = (() => {
    try {
      return readFileSync(join(root, 'cgroup.subtree_control'), 'utf8').trim().split(/\s+/);
    } catch {
      return [];
    }
  })();
  if (!controllers.includes('memory') || !controllers.includes('cpu')) {
    notes.push(`cgroup v2: ${root} does not hand its children the memory and cpu controllers`);
    return null;
  }
  const group = join(root, name);
  try {
    mkdirSync(group);
    writeFileSync(join(group, 'memory.max'), String(MEMORY_LIMIT_BYTES));
    if (existsSync(join(group, 'memory.swap.max')))
      writeFileSync(join(group, 'memory.swap.max'), '0');
    writeFileSync(join(group, 'cpu.max'), `${String(BURST_QUOTA_US)} ${String(CPU_PERIOD_US)}`);
  } catch (error) {
    notes.push(`cgroup v2: ${error instanceof Error ? error.message : String(error)}`);
    try {
      rmdirSync(group);
    } catch {
      // Not made.
    }
    return null;
  }
  return {
    kind: 'cgroup-v2',
    notes,
    cpu,
    wrap(argv) {
      return {
        command: 'sh',
        args: ['-c', ENTER, 'sh', join(group, 'cgroup.procs'), '--', ...pinned(cpu, argv)],
      };
    },
    setQuota(quotaUs) {
      try {
        writeFileSync(join(group, 'cpu.max'), `${String(quotaUs)} ${String(CPU_PERIOD_US)}`);
        return true;
      } catch {
        return false;
      }
    },
    resetPeak() {
      // memory.peak resets only on kernels that let it be written; otherwise it runs from the start.
      try {
        writeFileSync(join(group, 'memory.peak'), '0');
      } catch {
        // Kept as it is.
      }
    },
    stats() {
      const usage = readNumber(join(group, 'memory.current'));
      if (usage === null) return null;
      const throttled = statLine(join(group, 'cpu.stat'), 'throttled_usec');
      return {
        usageBytes: usage,
        peakBytes: readNumber(join(group, 'memory.peak')),
        limitHits: statLine(join(group, 'memory.events'), 'max'),
        oomKills: statLine(join(group, 'memory.events'), 'oom_kill'),
        throttledPeriods: statLine(join(group, 'cpu.stat'), 'nr_throttled'),
        throttledMs: throttled === null ? null : throttled / 1000,
      };
    },
    close() {
      return removeGroups([group]);
    },
  };
}

function systemdScope(name: string, cpu: number | null, notes: string[]): Confinement | null {
  if (!hasCommand('systemd-run')) {
    notes.push('systemd-run: not installed');
    return null;
  }
  const probe = spawnSync('systemd-run', ['--user', '--scope', '--quiet', 'true'], {
    stdio: 'ignore',
    timeout: 10_000,
  });
  if (probe.status !== 0) {
    notes.push('systemd-run --user --scope: no user manager to make a scope');
    return null;
  }
  const unit = `${name}.scope`;
  return {
    kind: 'systemd-run',
    notes: [...notes, 'systemd-run: peak memory is read as the relay process RSS, not the scope'],
    cpu,
    wrap(argv) {
      return {
        command: 'systemd-run',
        args: [
          '--user',
          '--scope',
          '--quiet',
          `--unit=${name}`,
          '-p',
          `MemoryMax=${String(MEMORY_LIMIT_BYTES)}`,
          '-p',
          'MemorySwapMax=0',
          '-p',
          'CPUQuota=100%',
          ...pinned(cpu, argv),
        ],
      };
    },
    setQuota(quotaUs) {
      const percent = (quotaUs / CPU_PERIOD_US) * 100;
      return (
        spawnSync(
          'systemctl',
          ['--user', 'set-property', '--runtime', unit, `CPUQuota=${String(percent)}%`],
          {
            stdio: 'ignore',
          },
        ).status === 0
      );
    },
    resetPeak() {
      // A scope's peak is not read here.
    },
    stats() {
      return null;
    },
    close() {
      // The scope goes with its last process.
      return Promise.resolve();
    },
  };
}

/**
 * The strongest confinement this machine allows, in decision 31's order.
 * `name` names the groups, so two runs never share one.
 */
export function confine(name: string): Confinement {
  const notes: string[] = [];
  const cpu = relayCpu();
  if (cpu === null) notes.push('taskset: not installed, so the relay is not pinned to one CPU');
  const found =
    cgroupV1(name, cpu, notes) ?? cgroupV2(name, cpu, notes) ?? systemdScope(name, cpu, notes);
  if (found !== null) return found;
  notes.push(
    'no group could be made: the relay runs under the image heap flag alone, pinned with taskset where it exists, its RSS measured against the 512 MiB budget and no CPU quota applied',
  );
  return {
    kind: 'none',
    notes,
    cpu,
    wrap(argv) {
      const [command = 'node', ...args] = pinned(cpu, argv);
      return { command, args };
    },
    setQuota() {
      return false;
    },
    resetPeak() {
      // Nothing keeps a peak but the process itself (VmHWM).
    },
    stats() {
      return null;
    },
    close() {
      // Nothing was made.
      return Promise.resolve();
    },
  };
}

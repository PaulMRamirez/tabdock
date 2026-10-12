// Loaded into the measured relay with `node --import` (ADR 0044, A6.22), so
// main.ts runs as the image runs it and nothing the relay does changes for
// the measurement. It reads what only the relay's own process can: the event
// loop's delay, its heap, its CPU time and what its answers waiting to be
// read hold as the response ceiling counts them (ResponseStalls.heldBytes,
// read-only). It speaks only over the IPC channel the harness opened,
// answers only the requests below, and sends nothing a request did not ask
// for. Without a channel it does nothing; when its harness goes, by any end
// at all, it asks the relay to stop as a host's SIGTERM would, so no relay
// outlives the run that started it.

import { readFileSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { ResponseStalls } from '../../../../packages/relay/src/response-stalls.ts';

const NS_PER_MS = 1e6;

/**
 * The histogram's sampling interval. Node records the time between two of
 * its timer's turns, interval included, so an idle loop reads about this
 * much; every figure the probe reports has it taken off, leaving the delay.
 */
export const LOOP_RESOLUTION_MS = 10;

/** A whole histogram per phase: `mark` starts one, `read` reports it. */
const delay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
let cpuAtMark = process.cpuUsage();
let markedAt = performance.now();

/**
 * The relay's response watchers, noted the first time each watches an
 * answer. main.ts imports the same module this file does (one URL, one
 * class), so the note is the only thing added to what the relay runs.
 */
const watchers = new Set<ResponseStalls>();

/** VmRSS and VmHWM from the kernel, in bytes; the peak the process ever touched. */
function vm(): { rss: number; hwm: number } {
  const status = readFileSync('/proc/self/status', 'utf8');
  const kb = (name: string): number => {
    const found = new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(status);
    return found ? Number(found[1]) * 1024 : 0;
  };
  return { rss: kb('VmRSS'), hwm: kb('VmHWM') };
}

function memory(): Record<string, number> {
  const usage = process.memoryUsage();
  const { rss, hwm } = vm();
  let held = 0;
  for (const watcher of watchers) held += watcher.heldBytes;
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    vmRss: rss,
    vmHwm: hwm,
    responsesHeld: held,
  };
}

/** A recorded figure less the sampling interval, never below nothing. */
function lessResolution(ns: number): number {
  return Math.max(0, ns / NS_PER_MS - LOOP_RESOLUTION_MS);
}

function eventLoop(): Record<string, number> {
  return {
    p50: lessResolution(delay.percentile(50)),
    p99: lessResolution(delay.percentile(99)),
    max: lessResolution(delay.max),
    mean: lessResolution(delay.mean),
    count: delay.count,
    resolutionMs: LOOP_RESOLUTION_MS,
  };
}

/** gc is there only with --expose-gc, which the harness passes. */
function collected(): number | null {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined) return null;
  gc();
  return process.memoryUsage().heapUsed;
}

function answer(id: unknown, body: Record<string, unknown>): void {
  process.send?.({ id, ...body });
}

if (process.send !== undefined) {
  delay.enable();
  const track = Object.getOwnPropertyDescriptor(ResponseStalls.prototype, 'track')?.value as
    ResponseStalls['track'] | undefined;
  if (track !== undefined) {
    ResponseStalls.prototype.track = function noted(this: ResponseStalls, ...args) {
      watchers.add(this);
      track.apply(this, args);
    };
  }
  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null) return;
    const { id, t } = message as { id?: unknown; t?: unknown };
    if (typeof id !== 'number') return;
    if (t === 'sample') {
      answer(id, { memory: memory() });
    } else if (t === 'mark') {
      delay.reset();
      cpuAtMark = process.cpuUsage();
      markedAt = performance.now();
      answer(id, {});
    } else if (t === 'gc') {
      // While the phase's load still runs, so the heap is what that load keeps.
      answer(id, { heapAfterGc: collected(), memory: memory() });
    } else if (t === 'read') {
      // Read before any collection, so a forced GC never shows in the phase's delay.
      const loop = eventLoop();
      const cpu = process.cpuUsage(cpuAtMark);
      const heapAfterGc = collected();
      answer(id, {
        memory: memory(),
        eventLoop: loop,
        cpuMs: (cpu.user + cpu.system) / 1000,
        wallMs: performance.now() - markedAt,
        heapAfterGc,
      });
    }
  });
  process.once('disconnect', () => {
    process.kill(process.pid, 'SIGTERM');
  });
  // The channel must not keep the relay alive past its own SIGTERM handling.
  process.channel?.unref();
}

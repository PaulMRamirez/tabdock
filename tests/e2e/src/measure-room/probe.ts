// Loaded into the measured relay with `node --import` (ADR 0044, A6.22), so
// main.ts runs as the image runs it and nothing in the relay changes for the
// measurement. It reads what only the relay's own process can: the event
// loop's delay, its heap and its CPU time. It speaks only over the IPC
// channel the harness opened, answers only the three requests below, and
// sends nothing a request did not ask for. Without a channel it does nothing.

import { readFileSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const NS_PER_MS = 1e6;

/** A whole histogram per phase: `mark` starts one, `read` reports it. */
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
let cpuAtMark = process.cpuUsage();
let markedAt = performance.now();

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
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    vmRss: rss,
    vmHwm: hwm,
  };
}

function eventLoop(): Record<string, number> {
  return {
    p50: delay.percentile(50) / NS_PER_MS,
    p99: delay.percentile(99) / NS_PER_MS,
    max: delay.max / NS_PER_MS,
    mean: delay.mean / NS_PER_MS,
    count: delay.count,
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
  // The channel must not keep the relay alive past its own SIGTERM handling.
  process.channel?.unref();
}

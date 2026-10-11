// Answers left unread pile up in the relay only when its peer stops taking
// bytes. On this machine's loopback the kernel's TCP buffers grow to
// megabytes and swallow a whole 0.72 MB answer that nobody reads, so the
// relay would hold nothing and neither the stall rule nor
// TABDOCK_MAX_RESPONSE_BYTES would ever act. A host edge that buffers little
// per connection is the case those bounds exist for, so for the phases that
// leave answers unread the measurement caps TCP buffer autotuning at 64 KiB
// a direction (tcp_rmem and tcp_wmem), and puts the old values back after.
//
// Those settings belong to a network namespace. The run makes one of its own
// (netns.ts), so the change reaches nothing else on the machine and goes with
// the namespace however the run ends. Where it cannot, the run changes the
// host's settings only when told to with --narrow-host-tcp, says so loudly,
// and puts them back when the phases end, when the run fails and when it
// exits or is interrupted (measure-room.ts); otherwise the unread phases run
// on the buffers as they are, and the figures say so.

import { readFileSync, writeFileSync } from 'node:fs';

const SETTINGS = ['/proc/sys/net/ipv4/tcp_rmem', '/proc/sys/net/ipv4/tcp_wmem'] as const;
/** min, default and max, in bytes: autotuning stops at 64 KiB. */
export const NARROW_TCP_BUFFERS = '4096 16384 65536';

/** Whose buffers a narrowing reaches: the run's own namespace, the host's, or none. */
export type NarrowScope = 'namespace' | 'host' | 'none';

export interface Narrowed {
  /** Whether the buffers were narrowed, and if not why. */
  readonly applied: boolean;
  readonly note: string;
  restore(): void;
}

const saved = new Map<string, string>();

/** Puts back whatever a narrowing changed; safe to call at any time, any number of times. */
export function restoreSocketBuffers(): void {
  for (const [path, value] of saved) {
    try {
      writeFileSync(path, value);
    } catch {
      // Nothing more can be done from here; the note printed the old values.
    }
  }
  saved.clear();
}

let hooked = false;

export function narrowSocketBuffers(scope: NarrowScope): Narrowed {
  const nothing = (note: string): Narrowed => ({
    applied: false,
    note,
    restore() {
      // Nothing was changed.
    },
  });
  if (scope === 'none') {
    return nothing(
      'TCP buffers left as they were: the run has no network namespace of its own and was not given --narrow-host-tcp, so the kernel may take unread answers whole',
    );
  }
  const old: [string, string][] = [];
  try {
    for (const path of SETTINGS) old.push([path, readFileSync(path, 'utf8').trim()]);
    if (!hooked) {
      hooked = true;
      process.on('exit', restoreSocketBuffers);
    }
    for (const [path, value] of old) {
      saved.set(path, value);
      writeFileSync(path, NARROW_TCP_BUFFERS);
    }
  } catch (error) {
    restoreSocketBuffers();
    return nothing(
      `TCP buffers left as they were (${error instanceof Error ? error.message : String(error)}), so the kernel may take unread answers whole`,
    );
  }
  const where =
    scope === 'namespace'
      ? "in the run's own network namespace"
      : 'ON THE WHOLE HOST, as --narrow-host-tcp asked, for every connection opened meanwhile';
  return {
    applied: true,
    note: `tcp_rmem and tcp_wmem set to "${NARROW_TCP_BUFFERS}" ${where} for the unread phases, from "${old.map(([, value]) => value.replace(/\s+/g, ' ')).join('" and "')}", and put back after`,
    restore: restoreSocketBuffers,
  };
}

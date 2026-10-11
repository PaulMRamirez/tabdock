// Answers left unread pile up in the relay only when its peer stops taking
// bytes. On this machine's loopback the kernel's TCP buffers grow to
// megabytes and swallow a whole 0.72 MB answer that nobody reads, so the
// relay would hold nothing and neither the stall rule nor
// TABDOCK_MAX_RESPONSE_BYTES would ever act. A host edge that buffers little
// per connection is the case those bounds exist for, so for the phases that
// leave answers unread the measurement caps TCP buffer autotuning at 64 KiB
// a direction, the machine-wide setting, and puts the old values back when
// the phases end, when the run fails and when the process exits or is
// interrupted. Where the settings cannot be written, the run says so and
// the figures show what loopback lets the relay hold.

import { readFileSync, writeFileSync } from 'node:fs';

const SETTINGS = ['/proc/sys/net/ipv4/tcp_rmem', '/proc/sys/net/ipv4/tcp_wmem'] as const;
/** min, default and max, in bytes: autotuning stops at 64 KiB. */
export const NARROW_TCP_BUFFERS = '4096 16384 65536';

export interface Narrowed {
  /** Whether the buffers were narrowed, and if not why. */
  readonly applied: boolean;
  readonly note: string;
  restore(): void;
}

const saved = new Map<string, string>();

function restoreAll(): void {
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

function hookExit(): void {
  if (hooked) return;
  hooked = true;
  process.on('exit', restoreAll);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      restoreAll();
      process.exit(130);
    });
  }
}

export function narrowSocketBuffers(): Narrowed {
  const old: [string, string][] = [];
  try {
    for (const path of SETTINGS) old.push([path, readFileSync(path, 'utf8').trim()]);
    hookExit();
    for (const [path, value] of old) {
      saved.set(path, value);
      writeFileSync(path, NARROW_TCP_BUFFERS);
    }
  } catch (error) {
    restoreAll();
    return {
      applied: false,
      note: `TCP buffers left as they were (${error instanceof Error ? error.message : String(error)}), so the kernel may take unread answers whole`,
      restore() {
        // Nothing was changed.
      },
    };
  }
  return {
    applied: true,
    note: `tcp_rmem and tcp_wmem set to "${NARROW_TCP_BUFFERS}" for the unread phases, from "${old.map(([, value]) => value.replace(/\s+/g, ' ')).join('" and "')}", and put back after`,
    restore: restoreAll,
  };
}

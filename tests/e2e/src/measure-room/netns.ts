// The run's own network namespace. The unread phases narrow TCP buffers
// (sockets.ts), and those settings are a namespace's, so measure:room starts
// itself again inside a fresh one with `unshare --net` when it can: the
// relay, every client, the stand-in provider and Chromium all speak on that
// namespace's loopback, nothing outside it changes, and whatever it set
// goes with it when the last process in it ends, however the run ends. A
// fresh namespace's loopback starts down, so the run brings it up first,
// with iproute2's `ip` where it is installed, or else one SIOCSIFFLAGS
// ioctl from perl, which most systems carry even when iproute2 is missing.

import { spawn, spawnSync } from 'node:child_process';

/** Set in the run started inside the namespace, so it never starts itself again. */
export const NETNS_MARK = 'TABDOCK_MEASURE_NETNS';

/** SIOCGIFFLAGS and SIOCSIFFLAGS on lo, setting IFF_UP. */
const LOOPBACK_UP_PERL = [
  'use Socket;',
  'socket(my $s, AF_INET, SOCK_DGRAM, 0) or die "socket: $!";',
  'my $req = pack("a16 x24", "lo");',
  'ioctl($s, 0x8913, $req) or die "SIOCGIFFLAGS: $!";',
  'my $flags = unpack("x16 s", $req);',
  'ioctl($s, 0x8914, pack("a16 s x22", "lo", $flags | 1)) or die "SIOCSIFFLAGS: $!";',
].join(' ');

/** Whether this process is the run started inside a namespace of its own. */
export function insideOwnNamespace(): boolean {
  return process.env[NETNS_MARK] === '1';
}

/** Brings the namespace's loopback up, or says why it could not. */
export function loopbackUp(): string | null {
  const ip = spawnSync('ip', ['link', 'set', 'lo', 'up'], { stdio: 'ignore' });
  if (ip.status === 0) return null;
  const perl = spawnSync('perl', ['-e', LOOPBACK_UP_PERL], { encoding: 'utf8' });
  if (perl.status === 0) return null;
  return `neither ip nor perl brought loopback up (${(perl.stderr || perl.error?.message || '').trim()})`;
}

/** Whether `unshare --net` works here: root, or a user allowed new namespaces. */
function canUnshare(): boolean {
  const probe = spawnSync('unshare', ['--net', 'true'], { stdio: 'ignore', timeout: 10_000 });
  return probe.status === 0;
}

/**
 * Starts this same command again inside a network namespace of its own and
 * resolves with its exit code, passing each interrupt on so it can clean up;
 * or resolves null where no namespace can be made, for the run to go on here.
 */
export async function runInOwnNamespace(): Promise<number | null> {
  if (insideOwnNamespace() || !canUnshare()) return null;
  const child = spawn(
    'unshare',
    ['--net', '--', process.execPath, ...process.execArgv, ...process.argv.slice(1)],
    { stdio: 'inherit', env: { ...process.env, [NETNS_MARK]: '1' } },
  );
  const forward = (signal: NodeJS.Signals): void => {
    // A terminal's Ctrl-C reaches the run itself too; it cleans up once either way.
    child.kill(signal);
  };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      resolve(code ?? (signal === null ? 1 : 130));
    });
    child.once('error', () => {
      resolve(null);
    });
  });
}

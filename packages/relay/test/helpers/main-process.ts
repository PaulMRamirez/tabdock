// main.ts as a child process, started the way the image starts it: node with
// its own flags and only the environment a host would give it. It listens on
// a port of its own choosing (TABDOCK_PORT=0) and the port is read from its
// "relay listening" line, so no other test can take a port between a probe
// and the bind. main.ts loads the repo-root .env when there is one, and the
// environment wins over it even when blank, so every setting .env.example
// names is passed blank unless a test sets it: a developer's .env cannot turn
// the child into another mode. Its output is kept, for a failed expectation
// to show.

import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MAIN = resolve(import.meta.dirname, '../../src/main.ts');
const ENV_EXAMPLE = resolve(import.meta.dirname, '../../../../.env.example');

/** Every relay setting .env.example names, blank. */
function blankSettings(): Record<string, string> {
  const names = readFileSync(ENV_EXAMPLE, 'utf8').match(/\bTABDOCK_[A-Z0-9_]+/g) ?? [];
  return Object.fromEntries(names.map((name) => [name, '']));
}

export interface MainProcess {
  readonly child: ChildProcess;
  /** Everything it wrote to stdout and stderr so far. */
  output(): string;
  /**
   * The port it listens on, once its "relay listening" line and its banner are
   * out, so a SIGTERM closes it cleanly; rejects if it exits first.
   */
  readonly port: Promise<number>;
  /** How it ended: its exit code, or the signal that ended it. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** The first words of the banner main.ts prints once the relay is up and takes SIGTERM. */
const BANNER = 'Tabdock relay on ';

/** The port in a "relay listening" log line's bound address. */
const LISTENING = /"msg":"relay listening".*?"bound":"[^"]*:(\d+)"/;

export function startMain(
  env: Record<string, string>,
  nodeFlags: readonly string[] = [],
  timeoutMs = 20_000,
): MainProcess {
  const child = spawn(process.execPath, [...nodeFlags, MAIN], {
    // Only what the image's environment would hold; nothing inherited matters.
    env: { ...blankSettings(), PATH: process.env.PATH ?? '', TABDOCK_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks: string[] = [];
  const output = (): string => chunks.join('');
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      child.once('exit', (code, signal) => {
        resolveExit({ code, signal });
      });
    },
  );
  const port = new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`main.ts did not listen within ${String(timeoutMs)} ms:\n${output()}`));
    }, timeoutMs);
    const look = (chunk: Buffer): void => {
      chunks.push(chunk.toString('utf8'));
      const found = LISTENING.exec(output());
      // The banner comes after main.ts takes SIGTERM, so a test may stop it from then on.
      if (found !== null && output().includes(BANNER)) {
        clearTimeout(timer);
        resolvePort(Number(found[1]));
      }
    };
    child.stdout.on('data', look);
    child.stderr.on('data', look);
    void exited.then((how) => {
      clearTimeout(timer);
      reject(new Error(`main.ts exited (${JSON.stringify(how)}) before listening:\n${output()}`));
    });
  });
  // A test that never reads the port must not leave an unhandled rejection behind.
  port.catch(() => undefined);
  return { child, output, port, exited };
}

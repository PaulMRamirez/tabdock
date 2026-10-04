// Runs root commands such as `pnpm relay` and `pnpm dev` as children, the way
// the owner runs them, for local mode's tests and the Claude Code check (ADR
// 0022): an environment cleared of every Tabdock setting, pnpm in a process
// group of its own so one signal stops it and the relay together, and the
// banner read back from what it printed.

import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The current environment without any TABDOCK_ variable, and with every
 * setting .env.example names set blank, so an .env on this machine (which the
 * scripts load, but which never overrides a variable already set) cannot
 * change what a run sees.
 */
export function blankEnv(): NodeJS.ProcessEnv {
  const names = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8')
    .split('\n')
    .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('TABDOCK_') && name !== 'DEMO_PORT') env[name] = value;
  }
  for (const name of names) env[name] = '';
  // pnpm need not look for a newer pnpm while a test waits on it.
  env.npm_config_update_notifier = 'false';
  return env;
}

export interface Run {
  child: ChildProcess;
  stdout(): string;
  stderr(): string;
  exited: Promise<number | null>;
  /** Waits until stdout holds `text`, failing if the command exits or the time runs out. */
  waitFor(text: string, timeoutMs?: number): Promise<void>;
  /** Ctrl-C to the whole group, as a terminal sends it; then waits for every output to close. */
  stop(): Promise<void>;
}

/**
 * pnpm as `pnpm test` itself was run, when it was (npm_execpath names its
 * script), so no shim such as corepack has to find it again under a
 * throwaway HOME; else whatever `pnpm` is on the PATH.
 */
function pnpmCommand(): { command: string; prefix: string[] } {
  const execPath = process.env.npm_execpath ?? '';
  if (basename(execPath).startsWith('pnpm'))
    return { command: process.execPath, prefix: [execPath] };
  return { command: 'pnpm', prefix: [] };
}

export function runPnpm(args: string[], env: NodeJS.ProcessEnv): Run {
  const { command, prefix } = pnpmCommand();
  const group = process.platform !== 'win32';
  const child = spawn(command, [...prefix, ...args], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: group,
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
  // close, not exit: it fires once the relay, which shares the pipes, has gone too.
  const exited = new Promise<number | null>((resolve) => {
    child.on('close', (code) => {
      resolve(code);
    });
  });
  let closed = false;
  void exited.then(() => {
    closed = true;
  });
  const signal = (name: NodeJS.Signals): void => {
    if (closed || child.pid === undefined) return;
    try {
      if (group) process.kill(-child.pid, name);
      else child.kill(name);
    } catch {
      // Already gone.
    }
  };
  return {
    child,
    stdout: () => out,
    stderr: () => err,
    exited,
    async waitFor(text, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (!out.includes(text)) {
        if (closed || Date.now() > deadline) {
          throw new Error(
            `pnpm ${args.join(' ')} ${closed ? 'exited' : 'timed out'} before printing "${text}"; it said:\n${err.slice(-2000)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    async stop() {
      signal('SIGINT');
      const timer = setTimeout(() => {
        signal('SIGKILL');
      }, 10_000);
      await exited;
      clearTimeout(timer);
    },
  };
}

/**
 * Whether a `claude mcp list` line shows its server connected. Claude Code
 * 2.1.288 draws the mark from the terminal's capabilities: a heavy check mark
 * (U+2714) under TERM=xterm-256color, a square root sign (U+221A) under
 * TERM=linux; the light check mark (U+2713) is allowed too, so the check
 * holds whatever TERM it runs under.
 */
export function listsConnected(line: string): boolean {
  return /[\u2713\u2714\u221a] Connected/u.test(line);
}

export interface PrintedBanner {
  mcpUrl: string;
  pageUrl: string;
  tokenPath: string;
  created: boolean;
  /** The `claude mcp add` line, exactly as printed. */
  command: string;
}

/** Local mode's banner, read back from what pnpm relay or pnpm dev printed. */
export function readBanner(stdout: string): PrintedBanner {
  const pick = (pattern: RegExp, what: string): string => {
    const found = pattern.exec(stdout)?.[1];
    if (found === undefined) throw new Error(`the banner names no ${what}`);
    return found;
  };
  const token = /^ {2}Owner token: +(.+) \((created just now|kept from an earlier start)\)$/m.exec(
    stdout,
  );
  if (token?.[1] === undefined) throw new Error('the banner names no owner token');
  return {
    mcpUrl: pick(/^ {2}MCP endpoint: +(\S+)$/m, 'MCP endpoint'),
    pageUrl: pick(/^ {2}Page socket: +(\S+)$/m, 'page socket'),
    tokenPath: token[1],
    created: token[2] === 'created just now',
    command: pick(/^ {2}(claude mcp add .+)$/m, 'claude mcp add line'),
  };
}

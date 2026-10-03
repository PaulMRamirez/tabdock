// Chromium driven over the raw DevTools protocol, for the M3 soak (A3.3). Not
// Playwright: Page.setWebLifecycleState froze a page only over a plain CDP
// socket (docs/notes/m3/tunnel-qr-spike.md). The cause, found while building
// this: Playwright turns on Emulation.setFocusEmulationEnabled for every page
// it controls, which keeps the page visible and focused, and a page that stays
// visible is not frozen. A browser Playwright is merely connected to behaves
// the same, and so does a raw session that turns the emulation on itself. So
// this launches the browser itself (Playwright's own Chromium binary, or
// CHROMIUM_EXECUTABLE), with --remote-debugging-port, and speaks CDP over `ws`.

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import WebSocket from 'ws';
import { ensurePlaywrightChromium } from '../harness.ts';

export interface Chrome {
  /** http://127.0.0.1:<port>, the DevTools HTTP endpoint. */
  readonly http: string;
  close(): Promise<void>;
}

export interface LaunchOptions {
  headless?: boolean;
}

/** The browser the soak runs: CHROMIUM_EXECUTABLE, or Playwright's Chromium, installed once if missing. */
async function executable(): Promise<string> {
  const given = process.env.CHROMIUM_EXECUTABLE;
  if (given) return given;
  const path = chromium.executablePath();
  if (!existsSync(path)) await ensurePlaywrightChromium();
  return path;
}

export async function launchChrome(options: LaunchOptions = {}): Promise<Chrome> {
  const profile = await mkdtemp(join(tmpdir(), 'tabdock-soak-'));
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-features=WebMCPTesting',
    // As Playwright launches its Chromium for every other test (chromiumSandbox
    // is off by default): the sandbox will not start as root in a container, nor
    // on Ubuntu 24.04 runners, and this browser only ever opens the local demo.
    '--no-sandbox',
    ...(options.headless === false ? [] : ['--headless=new']),
    'about:blank',
  ];
  const child: ChildProcess = spawn(await executable(), args, {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });
  const cleanUp = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let seen = '';
      const timer = setTimeout(() => {
        reject(new Error('Chromium did not open its DevTools port within 30 s'));
      }, 30_000);
      child.stderr?.on('data', (chunk: Buffer) => {
        seen += chunk.toString('utf8');
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
        if (match?.[1]) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Chromium exited with ${String(code)} before it was ready`));
      });
    });
    const { port } = new URL(endpoint);
    return { http: `http://127.0.0.1:${port}`, close: cleanUp };
  } catch (error) {
    await cleanUp();
    throw error;
  }
}

interface CdpReply {
  id?: number;
  result?: unknown;
  error?: { message: string };
}

interface Target {
  id: string;
  type: string;
  webSocketDebuggerUrl?: string;
}

/** One page over its own DevTools socket. */
export class CdpPage {
  readonly #ws: WebSocket;
  readonly #pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  #next = 0;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on('message', (data: Buffer) => {
      const reply = JSON.parse(data.toString('utf8')) as CdpReply;
      if (reply.id === undefined) return;
      const waiter = this.#pending.get(reply.id);
      if (!waiter) return;
      this.#pending.delete(reply.id);
      if (reply.error) waiter.reject(new Error(`CDP: ${reply.error.message}`));
      else waiter.resolve(reply.result);
    });
    ws.on('close', () => {
      for (const waiter of this.#pending.values()) waiter.reject(new Error('CDP socket closed'));
      this.#pending.clear();
    });
  }

  /** Opens a new tab at `url` and attaches to it. */
  static async open(chrome: Chrome, url: string): Promise<CdpPage> {
    const created = await fetch(`${chrome.http}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT',
    });
    const target = (await created.json()) as Target;
    if (!target.webSocketDebuggerUrl) throw new Error('the new tab has no DevTools socket');
    const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        resolve();
      });
      ws.once('error', reject);
    });
    return new CdpPage(ws);
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    this.#next += 1;
    const id = this.#next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP ${method} got no answer within ${String(timeoutMs)} ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Runs an expression in the page and returns its value as JSON; promises are awaited. A frozen page never answers. */
  async evaluate(expression: string): Promise<unknown> {
    const answer = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
    if (answer.exceptionDetails) {
      throw new Error(`page script failed: ${answer.exceptionDetails.text ?? 'exception'}`);
    }
    return answer.result?.value;
  }

  /** Freezes the page as Chrome does a background tab: hidden, timers stopped, sockets failed. */
  async freeze(): Promise<void> {
    await this.send('Page.setWebLifecycleState', { state: 'frozen' });
  }

  /** Thaws it; the page stays hidden, as a background tab would. */
  async resume(): Promise<void> {
    await this.send('Page.setWebLifecycleState', { state: 'active' });
  }

  close(): void {
    this.#ws.close();
  }
}

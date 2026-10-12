// What the legs of pnpm demo:m6 share: the classroom, the browser, the
// teacher's tab and Claude, and small readers for the audit log and the
// map's published state.

import type { Client } from '@modelcontextprotocol/client';
import type { Browser } from '@playwright/test';
import type { AuditLine, PageStateResult } from '@tabdock/protocol';
import { readAuditLines } from '@tabdock/relay';
import { type MapPageState, MapPageStateSchema } from '@tabdock/sim-page/map';
import type { Classroom } from './classroom.ts';
import type { Narrator } from './narrator.ts';
import type { OperatorTab } from './operator.ts';

/** What every leg has from the start. */
export interface Stage {
  readonly narrator: Narrator;
  readonly room: Classroom;
  readonly browser: Browser;
  /** A private directory for the run's files, removed at the end. */
  readonly scratch: string;
  readonly startedAt: number;
  /** Every line the run's browser pages wrote to their consoles. */
  readonly pageConsole: string[];
}

/** What the legs after the first share: the projected tab and the teacher's Claude on it. */
export interface Lesson extends Stage {
  readonly operator: OperatorTab;
  readonly pageId: string;
  /** Alice's Claude; a restart keeps no MCP session, so the restart leg replaces it. */
  alice: Client;
  /** The accepted proposal's run, which the record leg finds again in the log and the record. */
  proposalRun: { proposalId: string; callId: string } | null;
}

/** Every record the audit directory holds, in order. */
export function auditLines(dir: string): AuditLine[] {
  return [...readAuditLines(dir)].flatMap((line) => (line.record === null ? [] : [line.record]));
}

/** The map's published state in a state answer, or null for anything else. */
export function mapState(body: PageStateResult): MapPageState | null {
  const parsed = MapPageStateSchema.safeParse(body.value);
  return parsed.success ? parsed.data : null;
}

/** A view as the narration gives it: the body, the projection and the centre. */
export function centre(state: MapPageState | null): string {
  if (state === null) return '(no map state)';
  const { view } = state;
  return `${view.body}, ${view.projection}, centre lat ${view.lat.toFixed(2)} lon ${view.lon.toFixed(2)}`;
}

/** Polls `read` until it returns something, failing with `what` past the deadline. */
export async function until<T>(
  read: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  what: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await read();
    if (found !== null && found !== undefined && found !== false) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A call a leg leaves running while it takes a step that may throw, such as
 * a click in the widget. If that step throws, the demo's cleanup closes the
 * clients, which rejects the call; with nothing yet awaiting it, Node would
 * end the process on that unhandled rejection before the cleanup removed
 * the run's private directory. The quiet handler marks it handled, and the
 * leg still awaits the promise returned and sees its error as before.
 */
export function inFlight<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => undefined);
  return promise;
}

/**
 * Waits on the page's state from `first` until `test` passes, each wait at
 * most 5 s, and fails with `what` past the deadline rather than looping for
 * as long as a page that never publishes what the leg expects keeps quiet.
 */
export async function stateWhere(
  first: PageStateResult,
  next: (after: number, waitMs: number) => Promise<PageStateResult>,
  test: (body: PageStateResult) => boolean,
  what: string,
  timeoutMs = 15_000,
): Promise<PageStateResult> {
  const deadline = Date.now() + timeoutMs;
  let body = first;
  while (!test(body)) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`timed out waiting for ${what}`);
    body = await next(body.version, Math.min(5_000, left));
  }
  return body;
}

/** say and check as plain functions, so a leg reads as narration. */
export function bind(narrator: Narrator): {
  say: (text: string) => void;
  check: (ok: boolean, what: string) => void;
} {
  return {
    say: (text) => {
      narrator.say(text);
    },
    check: (ok, what) => {
      narrator.check(ok, what);
    },
  };
}

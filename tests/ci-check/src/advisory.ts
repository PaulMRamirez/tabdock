// Running headless Claude Code for the advisory walk (ADR 0041, A6.9), held
// to the four Tabdock tools a walk needs and nothing else, since the model
// reads untrusted page text and images. It gets no built-in tool (--tools
// ""), no MCP server but the relay (--strict-mcp-config), none of the
// caller's settings files, whose allow rules, hooks and plugins would
// otherwise apply (--setting-sources project, from a scratch directory that
// holds no project settings), and no prompt (--permission-mode dontAsk
// denies what is not pre-approved). The caller's HOME stays, so a signed-in
// owner stays signed in. The flags are not taken on trust: Claude Code's
// init event lists the tools the model is given, and a run offered any other
// tool, or one whose model starts before it says, is stopped at once. A run
// is stopped too when the test ends early, so it never goes on spending
// turns.

import { type ChildProcess, spawn } from 'node:child_process';
import { z } from 'zod';

/** What every tool the relay gives Claude Code is called there: `mcp__<server>__<tool>`. */
const TABDOCK_PREFIX = 'mcp__tabdock__';
export const ADVISORY_TOOLS: readonly string[] = [
  'list_pages',
  'list_page_tools',
  'call_page_tool',
  'get_page_state',
].map((name) => `${TABDOCK_PREFIX}${name}`);

/** How long a stopped run may take to end before it is killed outright. */
const STOP_GRACE_MS = 5_000;
const VERDICT = /^VERDICT ([A-Za-z0-9_.:-]{1,64}) (\d{1,4}) (ok|doubt)\b/;

/** The arguments of `claude` for one advisory walk. */
export function claudeArgs(prompt: string, mcpConfig: string, maxTurns: number): string[] {
  return [
    // The prompt follows -p directly: the options after it take lists, which would take it too.
    '-p',
    prompt,
    '--mcp-config',
    mcpConfig,
    '--strict-mcp-config',
    '--tools',
    '',
    '--setting-sources',
    'project',
    '--allowedTools',
    ...ADVISORY_TOOLS,
    '--permission-mode',
    'dontAsk',
    '--max-turns',
    String(maxTurns),
    // stream-json, which needs --verbose with -p, carries the init event the run is held to.
    '--output-format',
    'stream-json',
    '--verbose',
  ];
}

/** The part of Claude Code's init event this check reads. */
const InitSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('init'),
  tools: z.array(z.string()),
  mcp_servers: z.array(z.object({ name: z.string() })).optional(),
  permissionMode: z.string(),
});
/** The last event of a run: the model's final answer, and whether the run failed. */
const ResultSchema = z.object({
  type: z.literal('result'),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
});
const EventSchema = z.object({ type: z.string(), subtype: z.string().optional() });
/** Events that show the model or a tool at work: none may come before the init event. */
const MODEL_EVENTS = new Set(['assistant', 'user', 'stream_event', 'tool_progress', 'result']);

/** Names for a refusal: tool and server names as they are, a few at most, and never other text. */
function named(names: readonly string[]): string {
  const shown = names
    .slice(0, 6)
    .map((name) => (/^[A-Za-z0-9_.:-]{1,64}$/.test(name) ? name : '?'));
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${String(more)} more` : shown.join(', ');
}

/** What Claude Code's init event shows it was given beyond the walk's tools, or null when nothing. */
export function containmentProblem(event: unknown): string | null {
  const init = InitSchema.safeParse(event);
  if (!init.success) return 'its init event is not in the shape this check reads';
  const { tools, mcp_servers: servers = [], permissionMode } = init.data;
  const others = tools.filter((tool) => !tool.startsWith(TABDOCK_PREFIX));
  if (others.length > 0) return `it was given tools beyond the relay's: ${named(others)}`;
  const strangers = servers.map((server) => server.name).filter((name) => name !== 'tabdock');
  if (strangers.length > 0) return `it was given MCP servers beyond tabdock: ${named(strangers)}`;
  const missing = ADVISORY_TOOLS.filter((tool) => !tools.includes(tool));
  if (missing.length > 0) return `it lacks the relay's ${named(missing)}`;
  if (permissionMode !== 'dontAsk') return 'its permission mode is not dontAsk';
  return null;
}

/** Each verdict line of the model's answer as ids, a number and ok or doubt, never its words. */
export function verdictsIn(answer: string): string[] {
  return answer
    .split('\n')
    .map((line) => VERDICT.exec(line.trim()))
    .filter((match) => match !== null)
    .map(([, walkthrough, stop, verdict]) => `${walkthrough ?? ''} ${stop ?? ''} ${verdict ?? ''}`);
}

export interface ClaudeOutcome {
  readonly code: number | null;
  /** The model's final answer, or null when the run ended without one. */
  readonly answer: string | null;
  readonly isError: boolean;
}

export interface ClaudeRun {
  /** The run's end; rejects when the run was not held to the walk's tools. */
  readonly done: Promise<ClaudeOutcome>;
  /** Ends the run if it is still going, and waits until it has. */
  stop(): Promise<void>;
}

/** Starts `command args` (Claude Code, or a stand-in) in `cwd` and holds it to its init event. */
export function runClaude(command: string, args: readonly string[], cwd: string): ClaudeRun {
  const child: ChildProcess = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let problem: string | null = null;
  let initSeen = false;
  let result: z.infer<typeof ResultSchema> | null = null;
  let pending = '';

  let started = true;
  const closed = new Promise<number | null>((resolve) => {
    child.on('close', (code) => {
      resolve(code);
    });
    // A command that cannot be started reports only this.
    child.on('error', () => {
      if (child.pid !== undefined) return;
      started = false;
      resolve(null);
    });
  });
  /** Asks the run to end, and ends it outright if it has not within the grace. */
  const end = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
    await closed;
    clearTimeout(timer);
  };
  // And if this process ends first, the run ends with it rather than going on alone.
  const orphaned = (): void => {
    child.kill('SIGKILL');
  };
  process.once('exit', orphaned);
  void closed.then(() => process.off('exit', orphaned));
  const refuse = (why: string): void => {
    if (problem !== null) return;
    problem = why;
    void end();
  };
  const take = (line: string): void => {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    const kind = EventSchema.safeParse(event);
    if (!kind.success) return;
    if (!initSeen) {
      // Hooks and other notices may come before init; the model's turns and tools' results may not.
      if (kind.data.type === 'system' && kind.data.subtype === 'init') {
        initSeen = true;
        const why = containmentProblem(event);
        if (why !== null) refuse(why);
      } else if (MODEL_EVENTS.has(kind.data.type)) {
        refuse(`it began (${named([kind.data.type])}) before saying which tools it has`);
      }
      return;
    }
    const ended = ResultSchema.safeParse(event);
    if (ended.success) result = ended.data;
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) take(line);
  });
  // Its own words may quote the page, so they are drained and never shown.
  child.stderr?.resume();
  const done = closed.then((code): ClaudeOutcome => {
    if (!started) throw new Error('Claude Code could not be started');
    if (pending !== '') take(pending);
    if (problem === null && !initSeen) problem = 'it never said which tools it has';
    if (problem !== null) {
      throw new Error(`the advisory walk stopped Claude Code: ${problem} (ADR 0041)`);
    }
    const ended: z.infer<typeof ResultSchema> | null = result;
    return {
      code,
      answer: ended?.result ?? null,
      isError: ended === null || ended.is_error === true,
    };
  });
  // The test reads done; this keeps an early stop from counting as unhandled.
  done.catch(() => undefined);

  return { done, stop: end };
}

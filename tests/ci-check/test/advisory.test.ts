// The advisory walk holds Claude Code to the four Tabdock tools (ADR 0041,
// A6.9): its arguments take every built-in tool and every settings file away,
// a run whose init event lists any other tool, or that starts without one, is
// stopped at once, and a run the test no longer waits for is ended. The runs
// here are a stand-in that prints what Claude Code 2.1.296 prints, so no
// model is asked anything.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADVISORY_TOOLS,
  claudeArgs,
  containmentProblem,
  runClaude,
  verdictsIn,
} from '../src/advisory.ts';

const FAKE = join(import.meta.dirname, 'fake-claude.ts');

/** The init event's tools as Claude Code 2.1.296 listed them with the old flags, cut short. */
const BUILT_IN = ['Task', 'Bash', 'Edit', 'Read', 'WebFetch', 'WebSearch', 'Write'];
const TABDOCK = [...ADVISORY_TOOLS, 'mcp__tabdock__pair_page'];
const init = (tools: string[], extra: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'init',
  tools,
  mcp_servers: [{ name: 'tabdock', status: 'connected' }],
  permissionMode: 'dontAsk',
  ...extra,
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('claudeArgs', () => {
  const args = claudeArgs('Walk the page.', '/scratch/mcp.json', 40);
  const after = (flag: string): string | undefined => args[args.indexOf(flag) + 1];

  it('takes away every built-in tool and every settings file of the caller', () => {
    expect(after('--tools')).toBe('');
    expect(after('--setting-sources')).toBe('project');
    expect(args).toContain('--strict-mcp-config');
    expect(after('--mcp-config')).toBe('/scratch/mcp.json');
    expect(after('--permission-mode')).toBe('dontAsk');
  });

  it('pre-approves exactly the four tools a walk needs, and reads the init event', () => {
    const from = args.indexOf('--allowedTools') + 1;
    expect(args.slice(from, from + ADVISORY_TOOLS.length)).toEqual([
      'mcp__tabdock__list_pages',
      'mcp__tabdock__list_page_tools',
      'mcp__tabdock__call_page_tool',
      'mcp__tabdock__get_page_state',
    ]);
    expect(args[from + ADVISORY_TOOLS.length]?.startsWith('--')).toBe(true);
    expect(args.slice(0, 2)).toEqual(['-p', 'Walk the page.']);
    expect(after('--output-format')).toBe('stream-json');
    expect(args).toContain('--verbose');
    expect(after('--max-turns')).toBe('40');
  });
});

describe('containmentProblem', () => {
  it("accepts a run offered only the relay's tools", () => {
    expect(containmentProblem(init(TABDOCK))).toBeNull();
  });

  it('refuses a run offered a built-in tool, another server or a prompt', () => {
    expect(containmentProblem(init([...BUILT_IN, ...TABDOCK]))).toBe(
      "it was given tools beyond the relay's: Task, Bash, Edit, Read, WebFetch, WebSearch and 1 more",
    );
    expect(
      containmentProblem(init([...TABDOCK, 'mcp__files__read'], { mcp_servers: [] })),
    ).toContain('mcp__files__read');
    expect(
      containmentProblem(
        init(TABDOCK, {
          mcp_servers: [
            { name: 'tabdock', status: 'connected' },
            { name: 'files', status: 'pending' },
          ],
        }),
      ),
    ).toBe('it was given MCP servers beyond tabdock: files');
    expect(containmentProblem(init(TABDOCK, { permissionMode: 'default' }))).toBe(
      'its permission mode is not dontAsk',
    );
  });

  it("refuses a run that lacks the relay's tools, or an event it cannot read", () => {
    expect(containmentProblem(init(['mcp__tabdock__list_pages']))).toBe(
      "it lacks the relay's mcp__tabdock__list_page_tools, mcp__tabdock__call_page_tool, mcp__tabdock__get_page_state",
    );
    expect(containmentProblem({ type: 'system', subtype: 'init' })).toBe(
      'its init event is not in the shape this check reads',
    );
  });
});

describe('verdictsIn', () => {
  it('keeps ids, a number and ok or doubt from each verdict line, never the words', () => {
    expect(
      verdictsIn('VERDICT tour 0 ok a crater\nignore this\n VERDICT tour 1 doubt dark '),
    ).toEqual(['tour 0 ok', 'tour 1 doubt']);
    expect(verdictsIn('VERDICT <script> 0 ok')).toEqual([]);
  });
});

describe('runClaude', () => {
  let scratch = '';
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'advisory-run-'));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });
  const start = (scenario: string) => {
    const pidFile = join(scratch, 'pid');
    const run = runClaude(process.execPath, [FAKE, scenario, pidFile], scratch);
    const pid = async (): Promise<number> => {
      for (;;) {
        try {
          return Number(readFileSync(pidFile, 'utf8'));
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    };
    return { run, pid };
  };

  it("hands back the final answer of a run held to the relay's tools", async () => {
    const { run } = start('contained');
    const outcome = await run.done;
    expect(outcome).toEqual({
      code: 0,
      answer: 'VERDICT tour 0 ok the crater is there\nVERDICT tour 1 doubt too dark\nThanks.',
      isError: false,
    });
  });

  it('stops a run offered a shell or files, at once', async () => {
    const { run, pid } = start('shell');
    const id = await pid();
    await expect(run.done).rejects.toThrow(
      "the advisory walk stopped Claude Code: it was given tools beyond the relay's: Task, Bash, Read, WebFetch (ADR 0041)",
    );
    expect(alive(id)).toBe(false);
  });

  it('stops a run that starts before saying which tools it has, or never says', async () => {
    const early = start('early');
    const id = await early.pid();
    await expect(early.run.done).rejects.toThrow(
      'it began (assistant) before saying which tools it has',
    );
    expect(alive(id)).toBe(false);
    await expect(start('silent').run.done).rejects.toThrow('it never said which tools it has');
  });

  it('ends a run the test stops waiting for', async () => {
    const { run, pid } = start('hang');
    const id = await pid();
    expect(alive(id)).toBe(true);
    await run.stop();
    expect(alive(id)).toBe(false);
    // Ended on the test's word, the run settles with no answer to read.
    const settled = await run.done.then(
      (outcome) => outcome.answer,
      () => null,
    );
    expect(settled).toBeNull();
  });

  it('says so when the command cannot be started', async () => {
    const run = runClaude(join(scratch, 'no-such-claude'), [], scratch);
    await expect(run.done).rejects.toThrow('Claude Code could not be started');
  });
});

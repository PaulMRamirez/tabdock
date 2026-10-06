// Every command a doc tells someone to type must exist (ADR 0035): each
// `pnpm <x>` in a code span or a shell block resolves to a root script, a
// pnpm built-in, or after --filter or --dir that package's own script; each
// flag given to the relay's command is one cli.ts takes, and each given to
// the audit reader one it takes; and every root script is listed in
// docs/develop.md's Every command block, which `pnpm conformance` was once
// missing from. The Claude Code line the quick start shows is the one local
// mode prints, and the older `claude mcp add ... tabdock-local` line, which
// keeps a copy of the token, appears only where the docs speak of PowerShell.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIT_CLI_USAGE } from '../../../packages/relay/src/audit-cli.ts';
import { parseCommand } from '../../../packages/relay/src/cli.ts';
import { claudeCommandFor, localModeLines } from '../../../packages/relay/src/local-banner.ts';
import {
  codeBlocks,
  codeSpans,
  markdownIn,
  packageReadmes,
  readRepo,
  ROOT,
} from '../src/doc-files.ts';

const DOCS = [
  'README.md',
  'CLAUDE.md',
  ...markdownIn('docs'),
  ...markdownIn('docs/guide'),
  ...markdownIn('docs/tour'),
  ...markdownIn('docs/checklists'),
  ...packageReadmes(),
];
const SHELL_LANGS = new Set(['', 'sh', 'bash', 'shell', 'console', 'zsh', 'powershell']);
/** pnpm's own commands the docs use, which run whatever the scripts say. */
const BUILT_INS = new Set(['install', 'i', 'exec', 'add', 'dlx', 'run', 'audit', 'why', 'list']);
/** pnpm flags that take the next word as their value. */
const VALUE_FLAGS = new Set(['--filter', '-F', '--dir', '-C']);

interface Named {
  readonly where: string;
  readonly command: string;
}

/** The text after `pnpm ` in each command a doc gives, with where it is. */
function pnpmCommands(): Named[] {
  const found: Named[] = [];
  const take = (where: string, text: string): void => {
    for (const segment of text.split(/&&|\|\||;|\|/)) {
      const match = /(?:^|\s)pnpm\s+(.+)$/.exec(segment.replace(/\s#.*$/, '').trim());
      if (match?.[1] !== undefined) found.push({ where, command: match[1].trim() });
    }
  };
  for (const doc of DOCS) {
    const text = readRepo(doc);
    for (const { span, line } of codeSpans(text)) {
      if (/^(?:[A-Z_]+=\S*\s+)*pnpm\s/.test(span)) take(`${doc}:${String(line)}`, span);
    }
    for (const block of codeBlocks(text).filter((candidate) => SHELL_LANGS.has(candidate.lang))) {
      block.body.split('\n').forEach((line, index) => {
        take(`${doc}:${String(block.line + index + 1)}`, line.replace(/^\s*\$\s+/, ''));
      });
    }
  }
  return found;
}

function scriptsOf(packageJson: string): Set<string> {
  const parsed = JSON.parse(readFileSync(join(ROOT, packageJson), 'utf8')) as {
    name?: string;
    scripts?: Record<string, string>;
  };
  return new Set(Object.keys(parsed.scripts ?? {}));
}

/** Each workspace package's scripts by name, and by directory. */
function packageScripts(): { byName: Map<string, Set<string>>; byDir: Map<string, Set<string>> } {
  const byName = new Map<string, Set<string>>();
  const byDir = new Map<string, Set<string>>();
  for (const group of ['packages', 'apps', 'tests']) {
    for (const entry of readdirSync(join(ROOT, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = `${group}/${entry.name}`;
      let parsed: { name?: string };
      try {
        parsed = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as {
          name?: string;
        };
      } catch {
        continue;
      }
      const scripts = scriptsOf(`${dir}/package.json`);
      byDir.set(dir, scripts);
      if (parsed.name !== undefined) byName.set(parsed.name, scripts);
    }
  }
  return { byName, byDir };
}

const ROOT_SCRIPTS = scriptsOf('package.json');
const PACKAGES = packageScripts();

/** A script name, where demo:mN stands for any milestone's demo. */
function hasScript(scripts: ReadonlySet<string>, name: string): boolean {
  if (scripts.has(name)) return true;
  if (!name.includes('N')) return false;
  const pattern = new RegExp(
    `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('N', '\\d+')}$`,
  );
  return [...scripts].some((script) => pattern.test(script));
}

/** Why `pnpm <command>` names nothing that exists, or null when it resolves. */
function commandProblem(command: string): string | null {
  const words = command.split(/\s+/).filter((word) => word !== '');
  // A placeholder such as <script> stands for any of them.
  if (words.some((word) => word.includes('<') || word === '...')) return null;
  let scripts: ReadonlySet<string> = ROOT_SCRIPTS;
  let scope = 'the root package.json';
  let index = 0;
  for (; index < words.length; index += 1) {
    const word = words[index] ?? '';
    if (!word.startsWith('-')) break;
    const [flag, inline] = word.split('=', 2) as [string, string | undefined];
    if (!VALUE_FLAGS.has(flag)) continue;
    const value = inline ?? words[(index += 1)];
    if (value === undefined) continue;
    const target =
      flag === '--filter' || flag === '-F'
        ? PACKAGES.byName.get(value)
        : PACKAGES.byDir.get(value.replace(/\/$/, ''));
    if (target === undefined) return `${flag} ${value} names no workspace package`;
    scripts = target;
    scope = `${value}'s package.json`;
  }
  let name = words[index];
  if (name === undefined) return null;
  if (name === 'run') name = words.slice(index + 1).find((word) => !word.startsWith('-'));
  else if (BUILT_INS.has(name)) return null;
  if (name === undefined) return null;
  return hasScript(scripts, name) ? null : `${name} is no script in ${scope} and no pnpm built-in`;
}

/** The --flags AUDIT_CLI_USAGE lists. */
const AUDIT_FLAGS = new Set(
  [...AUDIT_CLI_USAGE.matchAll(/^\s+(--[a-z-]+)/gm)].map((match) => match[1]),
);

/** Why the arguments after the relay's command are not ones it takes, or null. */
function relayArgumentsProblem(args: readonly string[]): string | null {
  const shown = args.filter((word) => !word.startsWith('<'));
  if (shown[0] === 'audit') return auditArgumentsProblem(shown.slice(1));
  const flags = shown.filter((word) => word.startsWith('-'));
  if (flags.length === 0) return null;
  const parsed = parseCommand(flags);
  return parsed.kind === 'refused' ? parsed.reason : null;
}

function auditArgumentsProblem(args: readonly string[]): string | null {
  const unknown = args.filter(
    (word) => word.startsWith('--') && !AUDIT_FLAGS.has(word.split('=')[0]),
  );
  return unknown.length === 0 ? null : `the audit reader takes no ${unknown.join(', ')}`;
}

/** Each relay command a doc gives, with the words after it. */
function relayInvocations(): { where: string; args: string[] }[] {
  const found: { where: string; args: string[] }[] = [];
  const pattern =
    /(?:pnpm relay|pnpm audit:log|tabdock-relay|npx(?: --yes)? @tabdock\/relay)((?:\s+[^\s`;&|#]+)*)/g;
  for (const doc of DOCS) {
    const text = readRepo(doc);
    const lines = [
      ...codeSpans(text).map(({ span, line }) => ({ text: span, line })),
      ...codeBlocks(text)
        .filter((block) => SHELL_LANGS.has(block.lang))
        .flatMap((block) =>
          block.body.split('\n').map((line, index) => ({
            text: line.replace(/\s#.*$/, ''),
            line: block.line + index + 1,
          })),
        ),
    ];
    for (const { text: line, line: number } of lines) {
      for (const match of line.matchAll(pattern)) {
        const audit = match[0].startsWith('pnpm audit:log') ? ['audit'] : [];
        const args = (match[1] ?? '')
          .trim()
          .split(/\s+/)
          .filter((word) => word !== '');
        // Only flags and the audit subcommand are the command's; prose words after a span are not.
        const own = args.filter((word) => word.startsWith('-') || word === 'audit');
        found.push({ where: `${doc}:${String(number)}`, args: [...audit, ...own] });
      }
    }
  }
  return found;
}

describe('pnpm commands in the docs', () => {
  const commands = pnpmCommands();

  it('are found in code spans and shell blocks', () => {
    expect(commands.length).toBeGreaterThan(50);
    expect(commands.map((named) => named.command)).toEqual(
      expect.arrayContaining(['dev', 'relay --new-token', 'site:build']),
    );
  });

  it('each name a script or a pnpm built-in', () => {
    const problems = commands.flatMap(({ where, command }) => {
      const problem = commandProblem(command);
      return problem === null ? [] : [`${where}: pnpm ${command}: ${problem}`];
    });
    expect(problems).toEqual([]);
  });

  it('would be refused when they name no script', () => {
    expect(commandProblem('demo:m9')).not.toBeNull();
    expect(commandProblem('--filter @tabdock/e2e check:claude-code:m9')).not.toBeNull();
    expect(commandProblem('--filter @tabdock/nothing build')).not.toBeNull();
    expect(commandProblem('--dir apps/site run check')).toBeNull();
    expect(commandProblem('demo:mN')).toBeNull();
  });
});

describe("the relay's flags in the docs", () => {
  it('are each one the command takes', () => {
    const invocations = relayInvocations();
    expect(invocations.length).toBeGreaterThan(10);
    const problems = invocations.flatMap(({ where, args }) => {
      const problem = relayArgumentsProblem(args);
      return problem === null ? [] : [`${where}: ${problem}`];
    });
    expect(problems).toEqual([]);
    expect(relayArgumentsProblem(['--new-tokens'])).not.toBeNull();
    expect(relayArgumentsProblem(['audit', '--verfy'])).not.toBeNull();
  });
});

describe("docs/develop.md's Every command block", () => {
  it('lists every root script', () => {
    const text = readRepo('docs/develop.md');
    const section = text.slice(text.indexOf('## Every command'));
    const block = codeBlocks(section)[0]?.body ?? '';
    const listed = new Set([...block.matchAll(/^pnpm ([^\s#]+)/gm)].map((match) => match[1] ?? ''));
    expect([...ROOT_SCRIPTS].filter((script) => !listed.has(script))).toEqual([]);
  });
});

describe('the Claude Code line local mode prints', () => {
  it('is the one the quick start shows, for a sample path', () => {
    const tokenPath = '/home/you/.config/tabdock/owner-token';
    const mcpUrl = 'http://127.0.0.1:8787/mcp';
    const { line, helper } = claudeCommandFor('posix', mcpUrl, tokenPath);
    expect(helper).toBe(true);
    const printed = localModeLines({
      mcpUrl,
      pageUrl: 'ws://127.0.0.1:8787/page',
      tokenPath,
      created: true,
      shell: 'posix',
    });
    expect(printed).toContain(`  ${line}`);
    expect(readRepo('docs/guide/02-quick-start.md')).toContain(line);
  });

  it('is the only form shown for tabdock-local, but where PowerShell is named', () => {
    const problems = DOCS.flatMap((doc) => {
      const paragraphs = readRepo(doc).split(/\n\s*\n/);
      return paragraphs.flatMap((paragraph, index) =>
        /claude mcp add (?!-json)[^\n`]*tabdock-local/.test(paragraph) &&
        !/PowerShell/.test(`${paragraphs[index - 1] ?? ''}\n${paragraph}`)
          ? [`${doc}: ${paragraph.slice(0, 120)}`]
          : [],
      );
    });
    expect(problems).toEqual([]);
  });
});

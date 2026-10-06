// What an MCP client meets, as the guide and the spec describe it (ADR
// 0035): every error code the relay returns has a row in the guide's
// troubleshooting table, and no row names a code nothing sends; SPEC.md
// section 7 lists the same codes; the guide's table of fixed tools names
// each tool the relay serves with each of its inputs, as the golden capture
// of the relay's tools/list holds them; and the untrusted label the guide
// quotes is the one the relay writes.

import { ERROR_CODES, PAGE_ERROR_CODES, untrustedHeader } from '@tabdock/protocol';
import { describe, expect, it } from 'vitest';
import { markdownIn, readRepo, type Table, tables } from '../src/doc-files.ts';

const TROUBLESHOOTING = 'docs/guide/11-troubleshooting.md';
const CLIENTS = 'docs/guide/05-connect-clients.md';

function tableHeaded(path: string, first: string): Table {
  const table = tables(readRepo(path)).find((candidate) => candidate.header[0] === first);
  if (table === undefined) throw new Error(`${path} has no table headed ${first}`);
  return table;
}

/** A first cell holding one backticked word: `not_attached` gives not_attached. */
function codeOf(cell: string): string | null {
  return /^`([a-z_]+)`$/.exec(cell.trim())?.[1] ?? null;
}

interface GoldenTool {
  name: string;
  inputSchema?: { properties?: Record<string, unknown> };
}

/** The fixed tools in the golden capture's tools/list, for both protocol eras. */
function goldenTools(): Map<string, string[]> {
  const golden = JSON.parse(
    readRepo('packages/relay/test/fixtures/fixed-tools.golden.json'),
  ) as Record<string, { toolsList?: { result?: { tools?: GoldenTool[] } } }>;
  const tools = new Map<string, string[]>();
  for (const era of ['legacy', 'modern']) {
    const listed = golden[era]?.toolsList?.result?.tools ?? [];
    expect(listed.length, era).toBeGreaterThan(0);
    for (const tool of listed) {
      tools.set(tool.name, Object.keys(tool.inputSchema?.properties ?? {}));
    }
  }
  return tools;
}

describe('error codes', () => {
  const rows = tableHeaded(TROUBLESHOOTING, 'Code').rows.map((row) => codeOf(row.values[0] ?? ''));

  it('each have a row in the troubleshooting table', () => {
    expect(ERROR_CODES.filter((code) => !rows.includes(code))).toEqual([]);
  });

  it('are the only codes the table names, besides the page codes', () => {
    const known = new Set<string>([...ERROR_CODES, ...PAGE_ERROR_CODES]);
    expect(rows.filter((code) => code === null || !known.has(code))).toEqual([]);
  });

  it('are listed in SPEC.md section 7, and only those', () => {
    const spec = readRepo('SPEC.md');
    const section = spec.slice(spec.indexOf('## 7.'), spec.indexOf('## 8.'));
    const sentence = /with one of these codes in the text: ([^.]+)\./.exec(section)?.[1] ?? '';
    const listed = [...sentence.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]);
    expect(listed).toEqual([...ERROR_CODES]);
  });
});

describe('the fixed tools', () => {
  it('each appear in the guide with every input they take, and no other tool does', () => {
    const golden = goldenTools();
    const table = tableHeaded(CLIENTS, 'Tool');
    const documented = new Map(
      table.rows.map((row) => [
        codeOf(row.values[0] ?? '') ?? row.values[0] ?? '',
        row.cells.Input ?? '',
      ]),
    );
    expect([...documented.keys()].sort()).toEqual([...golden.keys()].sort());
    const missing = [...golden].flatMap(([tool, inputs]) =>
      inputs
        .filter((input) => !(documented.get(tool) ?? '').includes(`\`${input}\``))
        .map((input) => `${tool} takes ${input}`),
    );
    expect(missing).toEqual([]);
  });
});

describe('the untrusted label', () => {
  it('is quoted in the guide exactly as the relay writes it', () => {
    const quoted = markdownIn('docs/guide').flatMap((path) =>
      [...readRepo(path).matchAll(/`(\[tabdock: untrusted[^`]*)`/g)].map((match) => ({
        path,
        label: match[1] ?? '',
      })),
    );
    expect(quoted.map(({ label }) => label)).toContain(untrustedHeader('<origin>', '<name>'));
    // A placeholder or a real origin and tool, but always the whole label.
    const wrong = quoted.filter(({ label }) => {
      const shown = /^\[tabdock: untrusted content from (\S+), tool (\S+)\]$/.exec(label);
      return shown === null || label !== untrustedHeader(shown[1] ?? '', shown[2] ?? '');
    });
    expect(wrong).toEqual([]);
  });
});

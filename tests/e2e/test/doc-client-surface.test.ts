// What an MCP client meets, as the guide and the spec describe it (ADR
// 0035): every error code the relay returns has a heading of its own on the
// guide's troubleshooting page, so a reader can link to it, and no heading
// there names a code nothing sends; SPEC.md
// section 7 lists the same codes; the guide's table of fixed tools names
// each tool the relay serves with each of its inputs, as the golden capture
// of the relay's tools/list holds them; and the untrusted label the guide
// quotes is the one the relay writes.

import {
  AGENT_PATH,
  AttachAgentSchema,
  AttachInviteSchema,
  ERROR_CODES,
  PAGE_ERROR_CODES,
  untrustedHeader,
} from '@tabdock/protocol';
import { describe, expect, it } from 'vitest';
import { markdownIn, readRepo, type Table, tables, withoutCodeBlocks } from '../src/doc-files.ts';

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

/** The headings under a page's `## Error codes`, each as its code, or null when it names none. */
function codeHeadings(path: string): (string | null)[] {
  const text = withoutCodeBlocks(readRepo(path));
  const start = text.indexOf('\n## Error codes\n');
  if (start < 0) throw new Error(`${path} has no Error codes section`);
  const rest = text.slice(start + 1);
  const end = rest.indexOf('\n## ', 1);
  const section = end < 0 ? rest : rest.slice(0, end);
  return [...section.matchAll(/^### (.+)$/gm)].map((match) => codeOf(match[1] ?? ''));
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
  const rows = codeHeadings(TROUBLESHOOTING);

  it('each have a heading on the troubleshooting page', () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(ERROR_CODES.filter((code) => !rows.includes(code))).toEqual([]);
  });

  it('are the only codes its headings name, besides the page codes', () => {
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

// Where a credential travels and what guards the routes that take one, as
// SPEC says it (ADR 0044's notes): the attach_request row names every field
// of an invite's and an agent's part of the frame, the secret each carries to
// the page included; S11 says the relay puts an agent token in each prompt it
// raises for the token, to the page that minted it alone, and the threat
// model, the guide and the relay README say the same, never that it crosses
// once (the A6.28 review: the adapter checks the token on every prompt, so
// the relay must send it with each); S12 holds /g/mcp to the Host and Origin
// checks /mcp has; and section 7's 404 for a token that closes mid-body
// comes after the body.
describe('credentials on the page link and the MCP routes', () => {
  const spec = readRepo('SPEC.md');

  it("SPEC's attach_request row names every field the invite and agent parts carry", () => {
    const row = tables(spec)
      .flatMap((table) => table.rows)
      .find((candidate) => candidate.values[1] === '`attach_request`');
    if (row === undefined) throw new Error('SPEC.md has no attach_request row');
    const payload = row.values[2] ?? '';
    for (const [part, schema] of [
      ['invite', AttachInviteSchema],
      ['agent', AttachAgentSchema],
    ] as const) {
      const fields = Object.keys(schema.shape)
        .map((key) => `\`${key}\``)
        .join(', ');
      expect(payload, part).toContain(`\`${part}?\` (${fields})`);
    }
  });

  it('S11 says the relay passes an agent token to its page in each prompt, and S12 guards /g/mcp as /mcp', () => {
    const rule = (name: string): string => {
      const line = spec.split('\n').find((text) => text.includes(` ${name}. `));
      if (line === undefined) throw new Error(`SPEC.md has no ${name}`);
      return line;
    };
    const s11 = rule('S11');
    expect(s11).toContain(
      'sent by its client only in an `Authorization` header, and by the relay inside each `attach_request` it raises for the token',
    );
    expect(s11).toContain('always and only to the page that minted it');
    const s12 = rule('S12');
    expect(s12).toContain(`\`/mcp\`, \`${AGENT_PATH}\`, \`/pair\``);
    expect(s12).toContain(`\`/mcp\` and \`${AGENT_PATH}\` answer 403`);
  });

  it('every page that says where an agent token travels has it in each prompt, never once', () => {
    // How the old wording read: "carries the token once", "sent ... once by the relay".
    const ONCE = /\b(?:carr(?:y|ies|ied)|sen(?:d|ds|t))\b[^.;]{0,60}\bonce\b/;
    for (const [path, says] of [
      ['SPEC.md', 'inside each `attach_request` it raises for the token'],
      ['docs/threat-model.md', 'in each `attach_request` the relay raises for it'],
      ['docs/guide/10-security.md', 'in each prompt it raises for the token'],
      ['packages/relay/README.md', 'in each `attach_request` it raises for the token'],
    ] as const) {
      const text = withoutCodeBlocks(readRepo(path)).replace(/\s+/g, ' ');
      expect(text, path).toContain(says);
      const once = text
        .split(/(?<=\.) /)
        .filter((sentence) => /token/.test(sentence) && ONCE.test(sentence));
      expect(once, path).toEqual([]);
    }
  });

  it('section 7 answers a token that closes while its body arrives after the body, as the relay does', () => {
    expect(spec).toContain(
      'gets 404 before the body is read, or after it for a token that closes while its body arrives',
    );
  });
});

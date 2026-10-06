// The guide's limits table (docs/guide/11-troubleshooting.md, ADR 0035)
// names the constant behind each number it states and the file that holds
// it, so this holds each stated value and unit to the constant itself: a
// timer or a cap changed in code fails here until the page says the new
// number. Times must be in s, min or h, character caps in characters and
// byte caps in bytes, and the named file must export the constant.

import * as protocol from '@tabdock/protocol';
import { dirname, join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as adapterCore from '../../../packages/adapter/src/core.ts';
import * as auth from '../../../packages/relay/src/auth.ts';
import * as config from '../../../packages/relay/src/config.ts';
import * as confirm from '../../../packages/relay/src/confirm.ts';
import { readRepo, type TableRow, tables } from '../src/doc-files.ts';

const PAGE = 'docs/guide/11-troubleshooting.md';
/** The constants the plan for the guide requires the table to state, at least. */
const REQUIRED = [
  'PAIRING_TTL_MS',
  'ATTACH_REQUEST_TTL_MS',
  'PAIR_WAIT_MS',
  'DEFAULT_CALL_DEADLINE_MS',
  'RESUME_WINDOW_MS',
  'MAX_RESULT_CHARS',
  'MAX_DESCRIPTION_CHARS',
  'MAX_TOOLS_PER_PAGE',
  'MAX_INVITE_USES',
  'MAX_LIVE_INVITES_PER_PAGE',
  'MAX_INVITE_LIFETIME_MS',
  'MAX_FIRST_CLASS_NAME_CHARS',
  'ATTACHMENT_IDLE_MS',
];
const MODULES: readonly Readonly<Record<string, unknown>>[] = [
  protocol,
  config,
  confirm,
  auth,
  adapterCore,
];
const TIME_UNITS: Readonly<Record<string, number>> = { s: 1000, min: 60_000, h: 3_600_000 };
const WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function constantValue(name: string): number | undefined {
  for (const module of MODULES) {
    const value = module[name];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

/** "1,048,576 bytes" as 1048576 and bytes; "four at once" as 4 and at. */
function parsePart(part: string): { number: number; unit: string } | null {
  const match = /^(?:at least\s+)?([\d,]+|[a-z]+)\s+(\S+)/.exec(part.trim());
  if (match === null) return null;
  const [, amount = '', unit = ''] = match;
  const number = /^[\d,]+$/.test(amount) ? Number(amount.replaceAll(',', '')) : WORDS[amount];
  return number === undefined ? null : { number, unit };
}

/** What is wrong with a stated part for a constant, or null. */
function partProblem(constant: string, part: string): string | null {
  const value = constantValue(constant);
  if (value === undefined) return `${constant} is exported by none of the modules the table names`;
  const parsed = parsePart(part);
  if (parsed === null) return `"${part}" states no number`;
  const { number, unit } = parsed;
  if (constant.endsWith('_MS')) {
    const scale = TIME_UNITS[unit];
    if (scale === undefined) return `"${part}" gives ${constant} in ${unit}, not s, min or h`;
    return number * scale === value ? null : `"${part}" is not ${constant}, ${String(value)} ms`;
  }
  if (constant.endsWith('_CHARS') && unit !== 'characters') {
    return `"${part}" gives ${constant} in ${unit}, not characters`;
  }
  if (constant.endsWith('_BYTES') && unit !== 'bytes') {
    return `"${part}" gives ${constant} in ${unit}, not bytes`;
  }
  if (unit in TIME_UNITS) return `"${part}" gives ${constant}, a count, in ${unit}`;
  return number === value ? null : `"${part}" is not ${constant}, ${String(value)}`;
}

/** The file a row's In cell names: its link, or the last link with that name above. */
function filesByRow(rows: readonly TableRow[]): (string | null)[] {
  const seen = new Map<string, string>();
  return rows.map((row) => {
    const cell = row.cells.In ?? '';
    const link = /\[([^\]]+)\]\(([^)]+)\)/.exec(cell);
    if (link !== null) {
      const path = normalize(join(dirname(PAGE), link[2] ?? ''));
      seen.set(link[1] ?? '', path);
      return path;
    }
    return seen.get(cell.trim()) ?? null;
  });
}

function rowProblems(row: TableRow, file: string | null): string[] {
  const where = `${PAGE}:${String(row.line)}`;
  const constants = [...(row.cells.Constant ?? '').matchAll(/`([A-Z0-9_]+)`/g)].map(
    (match) => match[1] ?? '',
  );
  const parts = (row.cells.Value ?? '').split(/,\s+/);
  if (constants.length === 0) return [`${where}: names no constant`];
  if (parts.length !== constants.length) {
    return [
      `${where}: states ${String(parts.length)} values for ${String(constants.length)} constants`,
    ];
  }
  const problems = constants.flatMap((constant, index) => {
    const problem = partProblem(constant, parts[index] ?? '');
    return problem === null ? [] : [`${where}: ${problem}`];
  });
  if (file === null) return [...problems, `${where}: names no file`];
  const source = readRepo(file);
  return [
    ...problems,
    ...constants
      .filter((constant) => !new RegExp(`export const ${constant}\\b`).test(source))
      .map((constant) => `${where}: ${file} does not export ${constant}`),
  ];
}

describe("the troubleshooting page's limits table", () => {
  const table = tables(readRepo(PAGE)).find((candidate) => candidate.header[0] === 'Limit');
  const rows = table?.rows ?? [];

  it('states every limit the guide promises', () => {
    const named = rows.flatMap((row) =>
      [...(row.cells.Constant ?? '').matchAll(/`([A-Z0-9_]+)`/g)].map((match) => match[1]),
    );
    expect(REQUIRED.filter((constant) => !named.includes(constant))).toEqual([]);
  });

  it('states each value in its unit, as the named file exports it', () => {
    const files = filesByRow(rows);
    expect(rows.flatMap((row, index) => rowProblems(row, files[index] ?? null))).toEqual([]);
  });

  it('would fail a stale number or a wrong unit', () => {
    expect(partProblem('PAIRING_TTL_MS', '90 s')).not.toBeNull();
    expect(partProblem('PAIRING_TTL_MS', '2 min')).toBeNull();
    expect(partProblem('MAX_FRAME_BYTES', '1 MiB')).not.toBeNull();
    expect(partProblem('MAX_RESULT_CHARS', '120,000 bytes')).not.toBeNull();
    expect(partProblem('MAX_PENDING_CONFIRMATIONS', 'four at once per user')).toBeNull();
  });
});

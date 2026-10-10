// The guide's limits tables (docs/guide/12-setup-and-limits.md, ADR 0035,
// and from M6 15-limits-for-rooms.md, which took the limits for rooms,
// images and state so neither page passes its length cap) name the constant
// behind each number they state and the file that holds it, so this holds
// each stated value and unit to the constant itself: a timer or a cap
// changed in code fails here until the page says the new number. Times must
// be in ms (for a spacing under a second), s, min or h, character caps in
// characters and byte caps in bytes, and the named file must export the
// constant.

import * as protocol from '@tabdock/protocol';
import { dirname, join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as adapterCore from '../../../packages/adapter/src/core.ts';
import * as auth from '../../../packages/relay/src/auth.ts';
import * as config from '../../../packages/relay/src/config.ts';
import * as confirm from '../../../packages/relay/src/confirm.ts';
import { readRepo, type TableRow, tables } from '../src/doc-files.ts';

const PAGE = 'docs/guide/12-setup-and-limits.md';
const ROOMS_PAGE = 'docs/guide/15-limits-for-rooms.md';
/** The constants the plan for the guide requires the tables to state, at least. */
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
  // From M6 (ADRs 0039 to 0045), on the second page.
  'MAX_IMAGE_BYTES',
  'DEFAULT_IMAGE_BYTES',
  'MAX_IMAGE_TEXT_CHARS',
  'MAX_IMAGE_SIDE',
  'MAX_IMAGE_PIXELS',
  'IMAGE_CALL_SPACING_MS',
  'MAX_WAITING_IMAGE_CALLS',
  'MAX_STATE_BYTES',
  'MAX_STATE_FRAME_BYTES',
  'STATE_MIN_INTERVAL_MS',
  'DEFAULT_STATE_WAIT_MS',
  'MAX_WAIT_MS',
  'MAX_WAITS_PER_USER',
  'STATE_BYTES',
  'PROPOSAL_TTL_MS',
  'MAX_PENDING_PROPOSALS_PER_USER',
  'MAX_PENDING_PROPOSALS_PER_PAGE',
  'MAX_PROPOSAL_ARGUMENT_BYTES',
  'MAX_PROPOSAL_ARGUMENT_NODES',
  'ACCEPTED_PROPOSAL_RUN_MS',
  'PROPOSAL_OUTCOME_KEEP_MS',
  'MAX_SETTLED_PROPOSALS_PER_PAGE',
  'MAX_PROPOSAL_RESULT_CHARS',
  'PROPOSAL_BYTES',
  'MIN_SESSION_MS',
  'MAX_SESSION_MS',
  'SESSION_LENGTH_UNIT_MS',
  'SESSION_EXTEND_MS',
  'SESSION_END_GRACE_MS',
  'MAX_MEMBERS',
  'MAX_MEMBERS_FILE_BYTES',
  'MEMBERS_POLL_MS',
  'MAX_USERS_PER_PAGE',
  'MAX_OBSERVERS_PER_PAGE',
  'OBSERVERS_PER_PAGE',
  'MEMBER_RESERVED_SEATS',
  'MAX_ROSTER_CLIENTS_PER_INVITEE',
  'INVITEE_SESSIONS',
  'MIN_INVITEE_SESSIONS',
  'RESPONSE_BYTES',
  'MIN_RESPONSE_BYTES',
  'AGENT_TOKEN_BYTES',
  'AGENT_TOKEN_CHARS',
  'DEFAULT_AGENT_LIFETIME_MS',
  'MAX_AGENT_LIFETIME_MS',
  'MAX_LIVE_AGENTS_PER_PAGE',
  'AGENT_BURN_TIMEOUTS',
  'SESSION_RECORD_MAX_CALLS',
  'SESSION_RECORD_MAX_ATTACHMENTS',
  'SESSION_RECORD_MAX_PROPOSALS',
  'SESSION_RECORD_MAX_PAGE_IDS',
  'SESSION_RECORD_MAX_ROLE_CHANGES',
  'SESSION_RECORD_MAX_DROPPED_USERS',
  'SESSION_RECORD_MAX_BYTES',
];
const MODULES: readonly Readonly<Record<string, unknown>>[] = [
  protocol,
  config,
  confirm,
  auth,
  adapterCore,
];
const TIME_UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  min: 60_000,
  h: 3_600_000,
};
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
    if (scale === undefined) return `"${part}" gives ${constant} in ${unit}, not ms, s, min or h`;
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

/** The file a row's In cell names: its link, or the last link with that name above on its page. */
function filesByRow(rows: readonly TableRow[], page = PAGE): (string | null)[] {
  const seen = new Map<string, string>();
  return rows.map((row) => {
    const cell = row.cells.In ?? '';
    const link = /\[([^\]]+)\]\(([^)]+)\)/.exec(cell);
    if (link !== null) {
      const path = normalize(join(dirname(page), link[2] ?? ''));
      seen.set(link[1] ?? '', path);
      return path;
    }
    return seen.get(cell.trim()) ?? null;
  });
}

function rowProblems(row: TableRow, file: string | null, page = PAGE): string[] {
  const where = `${page}:${String(row.line)}`;
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

describe("the guide's limits tables", () => {
  const pages = [PAGE, ROOMS_PAGE].map((page) => {
    const table = tables(readRepo(page)).find((candidate) => candidate.header[0] === 'Limit');
    return { page, rows: table?.rows ?? [] };
  });

  it('are on both pages', () => {
    expect(pages.map(({ rows }) => rows.length > 0)).toEqual([true, true]);
  });

  it('state every limit the guide promises, each once', () => {
    const named = pages.flatMap(({ rows }) =>
      rows.flatMap((row) =>
        [...(row.cells.Constant ?? '').matchAll(/`([A-Z0-9_]+)`/g)].map((match) => match[1]),
      ),
    );
    expect(REQUIRED.filter((constant) => !named.includes(constant))).toEqual([]);
    expect(named.filter((constant, index) => named.indexOf(constant) !== index)).toEqual([]);
  });

  it('state each value in its unit, as the named file exports it', () => {
    const problems = pages.flatMap(({ page, rows }) => {
      const files = filesByRow(rows, page);
      return rows.flatMap((row, index) => rowProblems(row, files[index] ?? null, page));
    });
    expect(problems).toEqual([]);
  });

  it('would fail a stale number or a wrong unit', () => {
    expect(partProblem('PAIRING_TTL_MS', '90 s')).not.toBeNull();
    expect(partProblem('PAIRING_TTL_MS', '2 min')).toBeNull();
    expect(partProblem('STATE_MIN_INTERVAL_MS', '500 ms')).toBeNull();
    expect(partProblem('STATE_MIN_INTERVAL_MS', '5 s')).not.toBeNull();
    expect(partProblem('MAX_FRAME_BYTES', '1 MiB')).not.toBeNull();
    expect(partProblem('MAX_RESULT_CHARS', '120,000 bytes')).not.toBeNull();
    expect(partProblem('MAX_PENDING_CONFIRMATIONS', 'four at once per user')).toBeNull();
  });
});

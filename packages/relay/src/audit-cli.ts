// pnpm audit:log (node packages/relay/src/audit-cli.ts): reads the persistent
// audit log (ADR 0019). pnpm's own `audit` command shadows that name, so the
// script is audit:log. It filters by user, page, type, outcome and time,
// checks the hash chain with --verify (and a checkpoint from the platform's
// logs with --checkpoint), names each audit_gap and each start that followed
// no relay_stop, validates every line against the protocol's schema
// and prints nothing a line holds without escaping control and bidirectional
// characters, so a hostile client id cannot rewrite the operator's terminal.
// On a host it runs inside the container with the image's node, since the
// runtime image has no pnpm or shell: on the reference deployment,
// fly ssh console -C "/nodejs/bin/node /app/packages/relay/src/audit-cli.ts --verify"
// (docs/deploy.md, "Reading the audit log"). It reads files and writes to
// stdout only; it never changes the log. The published command runs it as
// `tabdock-relay audit` (cli.ts, ADR 0028), its usage naming that command, and
// there it reads no .env file: settings come from the environment alone.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { AUDIT_EVENT_TYPES, type AuditLine } from '@tabdock/protocol';
import { namedArgument } from './argument-names.ts';
import {
  type AuditCheckpoint,
  readAuditLines,
  type ReadLine,
  verifyAuditLines,
} from './audit-file.ts';
import { LOCAL_AUDIT_DIR } from './config.ts';
import { ownerTokenDirectory } from './local-token.ts';
import { PACKAGED } from './packaged.ts';

/** How a checkout runs the reader; the published command is `tabdock-relay audit`. */
export const CHECKOUT_AUDIT_COMMAND = 'pnpm audit:log';

/** The reader's usage, naming the command it runs under. */
export function auditCliUsage(command: string): string {
  return AUDIT_CLI_USAGE.replace(`Usage: ${CHECKOUT_AUDIT_COMMAND} `, `Usage: ${command} `);
}

export const AUDIT_CLI_USAGE = `Usage: ${CHECKOUT_AUDIT_COMMAND} [options]

Reads the relay's audit log (ADR 0019) and prints its records, oldest first.

  --dir <path>         the audit directory; default TABDOCK_AUDIT_DIR, else local
                       mode's audit/ beside its owner token
  --user <id>          records naming this user (as userId, sponsor or in a summary)
  --page <id>          records about this page
  --type <type>        records of this type; repeat or separate with commas
  --outcome <outcome>  records with this outcome
  --since <time>       records at or after this time (ISO 8601, or 15m, 24h, 7d ago)
  --until <time>       records before this time
  --json               print each record as one JSON line
  --verify             check every line, the sequence and the hash chain; exit 1 on a break
  --checkpoint <seq>:<head>:<first>
                       with --verify, also check the line with that seq against the
                       newest checkpoint in the platform's logs, and that the log
                       still starts at its first (which may be left off)
  --help               this text`;

/**
 * Characters a terminal would act on rather than show: C0 and C1 controls,
 * DEL, the line and paragraph separators, and the bidirectional marks and
 * overrides that can make text read in an order other than the bytes'.
 */
const UNSAFE =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** Text a line holds, with every character a terminal would act on written as a \u escape. */
export function escapeForTerminal(text: string): string {
  return text.replace(
    UNSAFE,
    (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`,
  );
}

export interface AuditFilter {
  users: string[];
  pages: string[];
  types: string[];
  outcomes: string[];
  since: number | null;
  until: number | null;
}

/** Whether a record names a user anywhere a reader would look for them. */
function namesUser(record: AuditLine, userId: string): boolean {
  if ('userId' in record && record.userId === userId) return true;
  if ('sponsor' in record && record.sponsor === userId) return true;
  if (record.type === 'refused_summary') {
    const scope = record.scope;
    return scope.kind === 'user'
      ? scope.userId === userId
      : scope.busiest.some((entry) => entry.userId === userId);
  }
  return false;
}

export function matches(record: AuditLine, filter: AuditFilter): boolean {
  if (filter.types.length > 0 && !filter.types.includes(record.type)) return false;
  if (filter.users.length > 0 && !filter.users.some((user) => namesUser(record, user))) {
    return false;
  }
  if (filter.pages.length > 0) {
    const pageId = 'pageId' in record ? record.pageId : null;
    if (pageId === null || !filter.pages.includes(pageId)) return false;
  }
  if (filter.outcomes.length > 0) {
    const outcome = 'outcome' in record ? record.outcome : null;
    if (outcome === null || !filter.outcomes.includes(outcome)) return false;
  }
  if (filter.since !== null && record.at < filter.since) return false;
  if (filter.until !== null && record.at >= filter.until) return false;
  return true;
}

/** A time as the options take it: ISO 8601, or a span ago such as 15m, 24h or 7d. */
export function parseTime(text: string, now: number): number {
  const span = /^(\d{1,6})([smhd])$/.exec(text.trim());
  if (span !== null) {
    const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
      span[2] as 's' | 'm' | 'h' | 'd'
    ];
    return now - Number(span[1]) * unit;
  }
  const at = Date.parse(text);
  if (Number.isNaN(at)) throw new UsageError(`not a time: use ISO 8601 or a span such as 24h`);
  return at;
}

/** What every line carries, shown up front or not at all. */
const LINE_FIELDS: ReadonlySet<string> = new Set(['v', 'seq', 'at', 'type', 'prev']);

/** One record as a person reads it: seq, time, type, then each field as compact JSON. */
export function formatRecord(record: AuditLine): string {
  const { seq, at, type } = record;
  const parts = Object.entries(record)
    .filter(([key]) => !LINE_FIELDS.has(key))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return escapeForTerminal([String(seq), new Date(at).toISOString(), type, ...parts].join(' '));
}

class UsageError extends Error {}

function list(values: string[] | undefined): string[] {
  return (values ?? []).flatMap((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== ''),
  );
}

/** The directory to read: --dir, then TABDOCK_AUDIT_DIR, then local mode's beside its token. */
function auditDir(given: string | undefined, env: NodeJS.ProcessEnv): string {
  if (given !== undefined) return resolve(given);
  const fromEnv = env.TABDOCK_AUDIT_DIR?.trim() ?? '';
  if (fromEnv !== '') return fromEnv;
  return join(ownerTokenDirectory(env), LOCAL_AUDIT_DIR);
}

const AUDIT_OPTIONS = {
  dir: { type: 'string' },
  user: { type: 'string', multiple: true },
  page: { type: 'string', multiple: true },
  type: { type: 'string', multiple: true },
  outcome: { type: 'string', multiple: true },
  since: { type: 'string' },
  until: { type: 'string' },
  json: { type: 'boolean' },
  verify: { type: 'boolean' },
  checkpoint: { type: 'string' },
  help: { type: 'boolean' },
} as const satisfies ParseArgsOptionsConfig;

/**
 * Why the arguments are refused, or null when node's strict parse will take
 * them. Node's own messages quote the argument they stumble on, so the
 * arguments are walked here first and each refusal names a flag by its name
 * and anything else only by its place, as cli.ts does (ADR 0028): a token
 * pasted in the wrong place is still a token. Values are never named.
 */
function refusalOf(argv: readonly string[]): string | null {
  const { tokens } = parseArgs({
    args: [...argv],
    options: AUDIT_OPTIONS,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === 'option-terminator') continue;
    if (token.kind === 'positional') {
      return `${namedArgument(argv[token.index] ?? '', token.index + 1)} is not one this reader takes: it takes options only`;
    }
    const known = Object.hasOwn(AUDIT_OPTIONS, token.name)
      ? AUDIT_OPTIONS[token.name as keyof typeof AUDIT_OPTIONS]
      : undefined;
    // Matched by its spelling too, so --Dir or a short form is not taken as --dir.
    if (known === undefined || token.rawName !== `--${token.name}`) {
      return `${namedArgument(argv[token.index] ?? '', token.index + 1)} is not one this reader takes`;
    }
    if (known.type === 'boolean' && token.value !== undefined) {
      return `the option ${token.rawName} takes no value`;
    }
    // Node refuses a separate value that starts with a dash as ambiguous; --dir=-x passes.
    if (
      known.type === 'string' &&
      (token.value === undefined || (!token.inlineValue && token.value.startsWith('-')))
    ) {
      return `the option ${token.rawName} needs a value`;
    }
  }
  return null;
}

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

/**
 * Runs the reader with these arguments; returns the exit code (0 fine, 1 a
 * broken log, 2 a usage error). `command` is what the usage calls it.
 */
export function runAuditCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
  now: number = Date.now(),
  command: string = CHECKOUT_AUDIT_COMMAND,
): number {
  const usage = auditCliUsage(command);
  const refused = refusalOf(argv);
  if (refused !== null) {
    io.err(refused);
    io.err(usage);
    return 2;
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: AUDIT_OPTIONS,
    }));
  } catch {
    // refusalOf names every case node's parser refuses; its own message
    // would repeat the argument, which may be a token pasted in the wrong place.
    io.err('the arguments are not ones this reader takes');
    io.err(usage);
    return 2;
  }
  if (values.help === true) {
    io.out(usage);
    return 0;
  }
  let filter: AuditFilter;
  let checkpoint: AuditCheckpoint | undefined;
  let dir: string;
  try {
    const types = list(values.type);
    const unknown = types.find((type) => !(AUDIT_EVENT_TYPES as readonly string[]).includes(type));
    if (unknown !== undefined) {
      throw new UsageError(`unknown record type; one of ${AUDIT_EVENT_TYPES.join(', ')}`);
    }
    filter = {
      users: list(values.user),
      pages: list(values.page),
      types,
      outcomes: list(values.outcome),
      since: values.since === undefined ? null : parseTime(values.since, now),
      until: values.until === undefined ? null : parseTime(values.until, now),
    };
    if (values.checkpoint !== undefined) {
      const match = /^(\d{1,15}):([0-9a-f]{64})(?::(\d{1,15}))?$/.exec(values.checkpoint.trim());
      if (match === null) {
        throw new UsageError('--checkpoint takes <seq>:<64 hex characters>:<first>');
      }
      if (values.verify !== true) throw new UsageError('--checkpoint needs --verify');
      const seq = Number(match[1]);
      const first = match[3] === undefined ? undefined : Number(match[3]);
      if (first !== undefined && first > seq) {
        throw new UsageError("--checkpoint's first cannot come after its seq");
      }
      checkpoint = { seq, head: match[2] ?? '', first };
    }
    dir = auditDir(values.dir, env);
  } catch (error) {
    io.err(escapeForTerminal(error instanceof Error ? error.message : String(error)));
    return 2;
  }
  if (!existsSync(dir)) {
    io.err(escapeForTerminal(`no audit directory at ${dir}; give --dir or TABDOCK_AUDIT_DIR`));
    return 2;
  }

  const lines: ReadLine[] = [];
  try {
    for (const line of readAuditLines(dir)) lines.push(line);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'error';
    io.err(escapeForTerminal(`cannot read the audit directory ${dir} (${code})`));
    return 2;
  }

  for (const line of lines) {
    if (line.record === null) {
      // A torn or damaged line is named, never printed: its text is no record.
      io.err(
        escapeForTerminal(
          `${line.file} line ${String(line.lineNumber)}: ${line.problem === 'not_json' ? 'torn or damaged line, not JSON' : 'not a valid audit record'}`,
        ),
      );
      continue;
    }
    if (!matches(line.record, filter)) continue;
    io.out(
      values.json === true
        ? escapeForTerminal(JSON.stringify(line.record))
        : formatRecord(line.record),
    );
  }

  if (values.verify !== true) return 0;
  const report = verifyAuditLines(lines, checkpoint);
  for (const problem of report.problems) {
    io.err(
      escapeForTerminal(`${problem.file} line ${String(problem.lineNumber)}: ${problem.problem}`),
    );
  }
  // Not breaks, since ADR 0019 fails open, but holes the operator must know of.
  for (const gap of report.gaps) {
    io.err(
      escapeForTerminal(
        `${gap.file} line ${String(gap.lineNumber)}: audit_gap: the file missed ${String(gap.lost)} records from ${new Date(gap.firstAt).toISOString()} to ${new Date(gap.lastAt).toISOString()}; their copies reached only stderr`,
      ),
    );
  }
  for (const stop of report.uncleanStops) {
    io.err(
      escapeForTerminal(
        stop.afterGap
          ? `${stop.file} line ${String(stop.lineNumber)}: relay_start follows an audit_gap, not a relay_stop: the run before lost records to a failing disk, perhaps its relay_stop among them; the audit_gap counts those lost before it was written, and any lost after it are counted only in the platform's logs, which keep their copies and the count a stopping relay logs as an error`
          : `${stop.file} line ${String(stop.lineNumber)}: relay_start follows no relay_stop: the relay before stopped without one (a crash, a kill or a failing disk), so its last records may be missing here, uncounted; the platform's logs keep their copies`,
      ),
    );
  }
  const missed = report.gaps.reduce((sum, gap) => sum + gap.lost, 0);
  const summary = [
    `${String(report.records)} records in ${String(report.files)} files`,
    report.firstSeq === null
      ? 'no records'
      : `seq ${String(report.firstSeq)} to ${String(report.lastSeq)}`,
    report.head === null ? null : `head ${report.head}`,
    report.torn.length === 0 ? null : `${String(report.torn.length)} torn lines skipped`,
    report.gaps.length === 0
      ? null
      : `${String(report.gaps.length)} audit_gap records counting ${String(missed)} missed records`,
    report.uncleanStops.length === 0
      ? null
      : `${String(report.uncleanStops.length)} starts after no relay_stop`,
  ]
    .filter((part) => part !== null)
    .join(', ');
  if (report.problems.length > 0) {
    io.err(`verify: BROKEN, ${String(report.problems.length)} problems; ${summary}`);
    return 1;
  }
  io.err(`verify: chain intact; ${summary}`);
  return 0;
}

// Run as a script in a checkout: the root .env, when there is one, may name
// TABDOCK_AUDIT_DIR, as main.ts reads it. Never in the bundle, where every
// module shares the entry's import.meta and cli.ts runs the reader itself.
if (!PACKAGED && import.meta.main) {
  const envFile = resolve(import.meta.dirname, '../../../.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  process.exitCode = runAuditCli(process.argv.slice(2), process.env, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}

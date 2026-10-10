// `tabdock-relay audit --match` (ADR 0045): holds a session record the
// operator saved from the widget to the hash-chained audit log, call by call,
// joined on the invoke's callId, which the page and the relay both saw and
// the relay writes into a call line exactly when the invoke went out. A call
// the record holds with no line, two lines with one callId, a field that
// differs, or a line the record should hold and lacks fails the match; the
// races a genuine record meets (a result after the relay answered timeout,
// the link going with an invoke in flight, the record's own caps and edges)
// are notes. A match shows the file agrees with the log, not that the log is
// complete or the relay honest: the log only says what the relay wrote.

import type { AuditLine, SessionRecord } from '@tabdock/protocol';

type CallLine = Extract<AuditLine, { type: 'call' }>;
type RecordCall = SessionRecord['calls'][number];
type Person = RecordCall['user'];

/**
 * How far a call's arrival on the page may sit from where the median skew
 * puts it without either being a different call: the skew is a median of
 * delays that are mostly milliseconds, so this covers its error.
 */
const PLACE_SLACK_MS = 5_000;
/** A matched call whose own skew is this far from the median gets a note: one clock moved. */
const SKEW_NOTE_MS = 60_000;

/**
 * Outcomes the relay writes when it answered a call itself, which leave the
 * page's own outcome free to be anything: a result that came after the relay
 * answered timeout, an invoke in flight when the link went, a revoke.
 */
const RELAY_ANSWERED: ReadonlySet<string> = new Set([
  'cancelled',
  'timeout',
  'not_attached',
  'page_asleep',
  'page_gone',
  'relay_error',
]);

/** Outcomes of an invoke that may never have arrived, so its page kept nothing of it. */
const MAY_NOT_ARRIVE: ReadonlySet<string> = new Set(['page_asleep', 'page_gone']);

export interface MatchFinding {
  /** A fail makes the match fail; a note is a difference a genuine record meets. */
  readonly level: 'fail' | 'note';
  readonly kind:
    | 'missing'
    | 'duplicate'
    | 'conflict'
    | 'unrecorded'
    | 'explained'
    | 'outcome'
    | 'running'
    | 'skew'
    | 'edge'
    | 'unplaced'
    | 'attachment';
  /** The call or proposal the finding is about, when one is. */
  readonly id: string | null;
  readonly text: string;
}

export interface MatchReport {
  readonly findings: readonly MatchFinding[];
  readonly matched: number;
  readonly missing: number;
  readonly conflicts: number;
  readonly unrecorded: number;
  /** Lines the record lacks inside its dropped span: the caps pushed them out. */
  readonly withinDropped: number;
  /** Lines the record lacks whose invoke may never have arrived. */
  readonly unreached: number;
  /** The median of the page's clock less the relay's over matched calls; null when none matched. */
  readonly skewMs: number | null;
  readonly failed: boolean;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Whether a log line's user is the record's person: a member by id, an
 * invitee by the `g_` and short id the record keeps instead of the full
 * account key, whatever ~n the record added to keep two apart.
 */
function samePerson(person: Person, userId: string): boolean {
  return person.kind === 'invitee'
    ? userId.startsWith(person.id.slice(0, 10)) && userId.length > 10
    : userId === person.id;
}

function named(person: Person): string {
  return `${person.name} (${person.id})`;
}

const iso = (at: number): string => new Date(at).toISOString();

/** The fields a record call and its line must agree on; empty when they do. */
function differences(call: RecordCall, line: CallLine): string[] {
  const differ: string[] = [];
  if (line.pageId !== call.pageId) differ.push('page');
  if (!samePerson(call.user, line.userId)) differ.push('user');
  if (line.tool !== call.tool) differ.push('tool');
  // The log credits a client and only a client (ADR 0026); the page's own Allow is absent there.
  if ((call.confirmedBy === 'client') !== (line.confirmedBy === 'client'))
    differ.push('confirmedBy');
  if ((call.proposalId ?? undefined) !== line.proposalId) differ.push('proposalId');
  if (
    call.outcome !== 'running' &&
    call.outcome !== line.outcome &&
    !RELAY_ANSWERED.has(line.outcome) &&
    // The relay refused the page's image after the page answered ok (ADR 0039).
    !(call.outcome === 'ok' && line.imageRefused !== undefined)
  ) {
    differ.push('outcome');
  }
  return differ;
}

/**
 * Matches a parsed session record against the log's valid records, oldest
 * first. Nothing is read or written here; the reader prints the findings.
 */
export function matchSessionRecord(
  record: SessionRecord,
  lines: readonly AuditLine[],
): MatchReport {
  const findings: MatchFinding[] = [];
  const fail = (kind: MatchFinding['kind'], id: string | null, text: string): void => {
    findings.push({ level: 'fail', kind, id, text });
  };
  const note = (kind: MatchFinding['kind'], id: string | null, text: string): void => {
    findings.push({ level: 'note', kind, id, text });
  };

  const callLines = lines.filter((line): line is CallLine => line.type === 'call');
  const byCallId = new Map<string, CallLine[]>();
  for (const line of callLines) {
    if (line.callId === undefined) continue;
    byCallId.set(line.callId, [...(byCallId.get(line.callId) ?? []), line]);
  }
  const gaps = lines.flatMap((line) => (line.type === 'audit_gap' ? [line] : []));
  const logStart = lines[0]?.at ?? null;

  const skew = median(
    record.calls.flatMap((call) => {
      const found = byCallId.get(call.callId);
      return found?.length === 1 && found[0] !== undefined ? [call.at - found[0].at] : [];
    }),
  );
  /** Where on the relay's clock the page's `at` falls. */
  const onRelay = (at: number): number => at - (skew ?? 0);
  /** Why the log may lack a line from this time: a gap it counted, or a time before its first record. */
  const logHole = (at: number): string | null => {
    const relayAt = onRelay(at);
    if (
      gaps.some(
        (gap) => relayAt >= gap.firstAt - PLACE_SLACK_MS && relayAt <= gap.lastAt + PLACE_SLACK_MS,
      )
    ) {
      return 'inside an audit_gap, whose records reached only stderr';
    }
    return logStart !== null && relayAt < logStart ? "before the log's first record" : null;
  };

  let matched = 0;
  let missing = 0;
  let conflicts = 0;
  for (const call of record.calls) {
    const found = byCallId.get(call.callId) ?? [];
    const what = `call ${call.callId} (${call.tool} by ${named(call.user)} at ${iso(call.at)})`;
    const [line] = found;
    if (found.length > 1) {
      conflicts++;
      fail(
        'duplicate',
        call.callId,
        `${what}: ${String(found.length)} call lines carry its callId`,
      );
      continue;
    }
    if (line === undefined) {
      const hole = logHole(call.at);
      if (call.outcome === 'running') {
        note(
          'running',
          call.callId,
          `${what} was running when the record was saved and has no line yet`,
        );
      } else if (hole !== null) {
        note('explained', call.callId, `${what} has no line: it falls ${hole}`);
      } else {
        missing++;
        fail(
          'missing',
          call.callId,
          `${what} is in the record, and no call line carries its callId`,
        );
      }
      continue;
    }
    const differ = differences(call, line);
    if (differ.length > 0) {
      conflicts++;
      fail('conflict', call.callId, `${what}: its line differs in ${differ.join(', ')}`);
      continue;
    }
    matched++;
    if (call.outcome === 'running') {
      note(
        'running',
        call.callId,
        `${what} was running when the record was saved; its line says ${line.outcome}`,
      );
    } else if (call.outcome !== line.outcome) {
      note(
        'outcome',
        call.callId,
        `${what}: the page saw ${call.outcome}, the relay answered ${line.outcome}`,
      );
    }
    if (skew !== null && Math.abs(call.at - line.at - skew) > SKEW_NOTE_MS) {
      note('skew', call.callId, `${what}: its clocks differ from the median by over a minute`);
    }
  }

  // Lines for the record's pages that it should hold and does not.
  const inRecord = new Set(record.calls.map((call) => call.callId));
  const strays = callLines.filter(
    (line) =>
      line.callId !== undefined &&
      !inRecord.has(line.callId) &&
      record.pageIds.includes(line.pageId),
  );
  let unrecorded = 0;
  let withinDropped = 0;
  let unreached = 0;
  const { dropped } = record;
  if (skew === null && strays.length > 0) {
    note(
      'unplaced',
      null,
      `no call in the record has a line, so ${String(strays.length)} call lines for its pages cannot be placed on the page's clock`,
    );
  }
  for (const line of skew === null ? [] : strays) {
    // When the invoke could have reached the page: no earlier than the
    // median puts it, no later than the call's end.
    const earliest = line.at + (skew ?? 0) - PLACE_SLACK_MS;
    const latest = line.at + (skew ?? 0) + line.durationMs + PLACE_SLACK_MS;
    const what = `call ${String(line.callId)} (${line.tool} by ${line.userId} at ${iso(line.at)} on the relay's clock)`;
    if (latest < record.from || earliest > record.to) continue;
    if (earliest < record.from || latest > record.to) {
      note(
        'edge',
        line.callId ?? null,
        `${what} may have reached the page just outside the record`,
      );
    } else if (
      dropped.firstAt !== null &&
      dropped.lastAt !== null &&
      earliest <= dropped.lastAt &&
      latest >= dropped.firstAt
    ) {
      withinDropped++;
      note(
        'explained',
        line.callId ?? null,
        `${what} falls within the calls the record's cap dropped`,
      );
    } else if (MAY_NOT_ARRIVE.has(line.outcome)) {
      unreached++;
      note(
        'explained',
        line.callId ?? null,
        `${what} ended ${line.outcome}, so its invoke may never have arrived`,
      );
    } else {
      unrecorded++;
      fail(
        'unrecorded',
        line.callId ?? null,
        `${what} is in the log within the record's span, and not in the record`,
      );
    }
  }

  // Proposals (ADR 0042): the line that made each, and the run of an accepted one.
  for (const proposal of record.proposals) {
    const made = callLines.filter(
      (line) => line.proposalId === proposal.proposalId && line.outcome === 'proposed',
    );
    const what = `proposal ${proposal.proposalId} (${proposal.tool} by ${named(proposal.user)} at ${iso(proposal.at)})`;
    const [line] = made;
    if (made.length > 1) {
      conflicts++;
      fail('duplicate', proposal.proposalId, `${what}: ${String(made.length)} lines made it`);
    } else if (line === undefined) {
      const hole = logHole(proposal.at);
      if (hole === null) {
        missing++;
        fail('missing', proposal.proposalId, `${what} is in the record, and no line made it`);
      } else {
        note('explained', proposal.proposalId, `${what} has no line: it falls ${hole}`);
      }
    } else if (
      line.pageId !== proposal.pageId ||
      line.tool !== proposal.tool ||
      !samePerson(proposal.user, line.userId)
    ) {
      conflicts++;
      fail(
        'conflict',
        proposal.proposalId,
        `${what}: the line that made it names another page, tool or user`,
      );
    }
    if (proposal.callId !== null) {
      const run = byCallId.get(proposal.callId)?.[0];
      if (
        run !== undefined &&
        (run.proposalId !== proposal.proposalId || run.acceptedOnPage !== true)
      ) {
        conflicts++;
        fail(
          'conflict',
          proposal.proposalId,
          `${what}: its run's line is not that proposal's accepted run`,
        );
      }
    }
  }

  // Joins are notes: the page names who it listed, the log who attached, each by its own clock.
  for (const span of record.attachments) {
    if (span.before) continue;
    const attached = lines.some(
      (line) =>
        line.type === 'attach' && line.pageId === span.pageId && samePerson(span.user, line.userId),
    );
    if (!attached) {
      note(
        'attachment',
        span.pageId,
        `${named(span.user)}, who joined at ${iso(span.joinedAt)}, has no attach line on that page`,
      );
    }
  }

  return {
    findings,
    matched,
    missing,
    conflicts,
    unrecorded,
    withinDropped,
    unreached,
    skewMs: skew,
    failed: findings.some((finding) => finding.level === 'fail'),
  };
}

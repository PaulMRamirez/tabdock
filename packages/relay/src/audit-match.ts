// `tabdock-relay audit --match` (ADR 0045): holds a session record the
// operator saved from the widget to the hash-chained audit log, call by call,
// joined on the invoke's callId, which the page and the relay both saw and
// the relay writes into a call line exactly when the invoke went out. A call
// the record holds with no line, two lines with one callId, a field that
// differs, a line the record should hold and lacks, or a record whose own
// ids and times disagree fails the match; the races a genuine record meets
// (a result after the relay answered timeout, the link going with an invoke
// in flight, the record's own caps and edges) are notes. A match shows the
// file agrees with the log within the span it claims, not that the log is
// complete or the relay honest: the log only says what the relay wrote, and
// a record cut short at either end matches as a shorter record would.

import {
  type AuditLine,
  DEFAULT_CALL_DEADLINE_MS,
  SESSION_RECORD_MAX_CALLS,
  SESSION_RECORD_MAX_PROPOSALS,
  type SessionRecord,
} from '@tabdock/protocol';
import { CALL_DEADLINE_GRACE_MS } from './config.ts';

type CallLine = Extract<AuditLine, { type: 'call' }>;
type ClosedLine = Extract<AuditLine, { type: 'proposal_closed' }>;
type RecordCall = SessionRecord['calls'][number];
type RecordProposal = SessionRecord['proposals'][number];
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
 * The relay answers every call within its deadline and grace from when it
 * took the call, and writes the call's line then; two slacks cover the
 * skew's error and a busy relay. A call still running on the page longer
 * ago than this, in a log that goes on past it, has a line or never existed.
 */
const ANSWERED_WITHIN_MS = DEFAULT_CALL_DEADLINE_MS + CALL_DEADLINE_GRACE_MS + 2 * PLACE_SLACK_MS;

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

/**
 * How a proposal closed in the log that only the page's own decision makes:
 * the operator's Dismiss, or the page refusing it as it arrived. A record
 * that says otherwise was changed, while the relay's own ends (expired,
 * cancelled, withdrawn) can race the page's and are notes.
 */
const PAGE_DECIDED: ReadonlySet<string> = new Set(['dismissed', 'refused']);

export interface MatchFinding {
  /** A fail makes the match fail; a note is a difference a genuine record meets. */
  readonly level: 'fail' | 'note';
  readonly kind:
    | 'missing'
    | 'duplicate'
    | 'repeated'
    | 'window'
    | 'conflict'
    | 'unrecorded'
    | 'explained'
    | 'outcome'
    | 'running'
    | 'skew'
    | 'edge'
    | 'unplaced'
    | 'attachment'
    | 'session';
  /** The call or proposal the finding is about, when one is. */
  readonly id: string | null;
  readonly text: string;
}

export interface MatchReport {
  readonly findings: readonly MatchFinding[];
  readonly matched: number;
  readonly missing: number;
  /** Lines that differ from the record, and records that disagree with themselves. */
  readonly conflicts: number;
  readonly unrecorded: number;
  /** Lines the record lacks inside its dropped span: the caps pushed them out. */
  readonly withinDropped: number;
  /** Lines the record lacks whose invoke may never have arrived. */
  readonly unreached: number;
  /** Lines for the record's pages that no matched call or proposal lets the reader place on the page's clock. */
  readonly unplaced: number;
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
 * Whether a log line's user is the record's person, by the id the record
 * names them with: a member by id, an invitee by the `g_` and short id the
 * record keeps instead of the full account key, whatever ~n the record added
 * to keep two apart.
 */
function samePerson(personId: string, userId: string): boolean {
  return personId.startsWith('g_')
    ? userId.startsWith(personId.slice(0, 10)) && userId.length > 10
    : userId === personId;
}

function named(person: Person): string {
  return `${person.name} (${person.id})`;
}

/** A time as the findings print it; a record may carry one past what a Date holds. */
function iso(at: number): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? `${String(at)} ms` : date.toISOString();
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/** The fields a record call and its line must agree on; empty when they do. */
function differences(call: RecordCall, line: CallLine): string[] {
  const differ: string[] = [];
  if (line.pageId !== call.pageId) differ.push('page');
  if (!samePerson(call.user.id, line.userId)) differ.push('user');
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
  let matched = 0;
  let missing = 0;
  let conflicts = 0;

  // The log, indexed once: call lines by callId, and a proposal's lines by its id.
  const callLines: CallLine[] = [];
  const byCallId = new Map<string, CallLine[]>();
  const madeBy = new Map<string, CallLine[]>();
  const ranBy = new Map<string, CallLine[]>();
  const closedBy = new Map<string, ClosedLine[]>();
  let logEnd: number | null = null;
  for (const line of lines) {
    logEnd = Math.max(logEnd ?? line.at, line.at);
    if (line.type === 'proposal_closed') push(closedBy, line.proposalId, line);
    if (line.type !== 'call') continue;
    callLines.push(line);
    if (line.callId !== undefined) push(byCallId, line.callId, line);
    // The audit's rule: a line naming a proposal either made it or ran it.
    if (line.proposalId !== undefined) {
      push(line.outcome === 'proposed' ? madeBy : ranBy, line.proposalId, line);
    }
  }
  const gaps = lines.flatMap((line) => (line.type === 'audit_gap' ? [line] : []));
  const logStart = lines[0]?.at ?? null;

  // The record against itself: an id is listed once, and every time lies in
  // the span it claims, so narrowing that span cannot hide a line between
  // entries it kept. A carried proposal was made before the span began.
  const inside = (at: number): boolean => at >= record.from && at <= record.to;
  const inconsistent = (id: string | null, text: string): void => {
    conflicts++;
    fail('window', id, text);
  };
  for (const [ids, what] of [
    [record.calls.map((call) => call.callId), 'call'],
    [record.proposals.map((proposal) => proposal.proposalId), 'proposal'],
  ] as const) {
    const seen = new Set<string>();
    const twice = new Set<string>();
    for (const id of ids) (seen.has(id) ? twice : seen).add(id);
    for (const id of twice) {
      conflicts++;
      fail('repeated', id, `${what} ${id} is listed more than once in the record`);
    }
  }
  if (
    record.sealed
      ? record.to > record.exportedAt
      : record.to !== Math.max(record.exportedAt, record.from)
  ) {
    inconsistent(null, "the record's span does not end where its export says it does");
  }
  for (const call of record.calls) {
    if (!inside(call.at)) {
      inconsistent(
        call.callId,
        `call ${call.callId} at ${iso(call.at)} lies outside the record's span`,
      );
    }
  }
  for (const span of record.attachments) {
    if (
      !inside(span.joinedAt) ||
      (span.leftAt !== null && (span.leftAt < span.joinedAt || span.leftAt > record.to)) ||
      span.roles.some((role) => role.at < span.joinedAt || role.at > record.to)
    ) {
      inconsistent(
        span.pageId,
        `${named(span.user)}, who joined at ${iso(span.joinedAt)}, has times outside the record's span`,
      );
    }
  }
  for (const proposal of record.proposals) {
    if (
      proposal.at > record.to ||
      (proposal.decidedAt !== null &&
        (proposal.decidedAt < proposal.at || !inside(proposal.decidedAt)))
    ) {
      inconsistent(
        proposal.proposalId,
        `proposal ${proposal.proposalId} at ${iso(proposal.at)} has times outside the record's span`,
      );
    }
  }
  const { dropped } = record;
  if (
    (dropped.firstAt === null) !== (dropped.lastAt === null) ||
    (dropped.firstAt !== null &&
      dropped.lastAt !== null &&
      (dropped.firstAt > dropped.lastAt || !inside(dropped.firstAt) || !inside(dropped.lastAt)))
  ) {
    inconsistent(null, "the calls the record's cap dropped have times outside its span");
  }

  // The clocks, from every call and proposal that has exactly one line.
  const callLine = (call: RecordCall): CallLine | undefined => {
    const found = byCallId.get(call.callId);
    return found?.length === 1 ? found[0] : undefined;
  };
  const madeLine = (proposal: RecordProposal): CallLine | undefined => {
    const found = madeBy.get(proposal.proposalId);
    return found?.length === 1 ? found[0] : undefined;
  };
  const pairs: [number, CallLine][] = [
    ...record.calls.flatMap((call): [number, CallLine][] => {
      const line = callLine(call);
      return line === undefined ? [] : [[call.at, line]];
    }),
    ...record.proposals.flatMap((proposal): [number, CallLine][] => {
      const line = madeLine(proposal);
      return line === undefined ? [] : [[proposal.at, line]];
    }),
  ];
  const skew = median(pairs.map(([at, line]) => at - line.at));
  /**
   * Where on the relay's clock the page's `at` falls; null when nothing
   * matched, so nothing can be placed and no hole can explain anything.
   */
  const onRelay = (at: number): number | null => (skew === null ? null : at - skew);
  /** Why the log may lack a line from this time: a gap it counted, or a time before its first record. */
  const logHole = (at: number): string | null => {
    const relayAt = onRelay(at);
    const fromAt = onRelay(record.from);
    if (relayAt === null || fromAt === null) return null;
    if (
      gaps.some(
        (gap) => relayAt >= gap.firstAt - PLACE_SLACK_MS && relayAt <= gap.lastAt + PLACE_SLACK_MS,
      )
    ) {
      return 'inside an audit_gap, whose records reached only stderr';
    }
    // The record must start before the log does too, or the time is no hole the log left.
    return logStart !== null && relayAt < logStart && fromAt < logStart
      ? "before the log's first record"
      : null;
  };

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
      const relayAt = onRelay(call.at);
      if (hole !== null) {
        note('explained', call.callId, `${what} has no line: it falls ${hole}`);
      } else if (
        call.outcome === 'running' &&
        relayAt !== null &&
        (logEnd === null || logEnd <= relayAt + ANSWERED_WITHIN_MS)
      ) {
        note(
          'running',
          call.callId,
          `${what} was running when the record was saved and has no line yet`,
        );
      } else {
        // The relay writes every call's line once it answers it, by its deadline at the latest.
        missing++;
        fail(
          'missing',
          call.callId,
          call.outcome === 'running'
            ? `${what} was running when the record was saved, and no call line carries its callId although the log goes on past when the relay must have answered it`
            : `${what} is in the record, and no call line carries its callId`,
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

  // Proposals (ADR 0042): the line that made each, and how the log says it ended.
  const proposals = new Map(record.proposals.map((proposal) => [proposal.proposalId, proposal]));
  for (const proposal of record.proposals) {
    const id = proposal.proposalId;
    const what = `proposal ${id} (${proposal.tool} by ${named(proposal.user)} at ${iso(proposal.at)})`;
    const conflict = (text: string): void => {
      conflicts++;
      fail('conflict', id, `${what}: ${text}`);
    };
    const made = madeBy.get(id) ?? [];
    const ran = ranBy.get(id) ?? [];
    const closed = closedBy.get(id) ?? [];
    const names = (line: CallLine | ClosedLine): boolean =>
      line.pageId === proposal.pageId &&
      line.tool === proposal.tool &&
      samePerson(proposal.user.id, line.userId);
    if (made.length > 1) {
      conflicts++;
      fail('duplicate', id, `${what}: ${String(made.length)} lines made it`);
    } else if (made[0] === undefined) {
      const hole = logHole(proposal.at);
      if (hole === null) {
        missing++;
        fail('missing', id, `${what} is in the record, and no line made it`);
      } else {
        note('explained', id, `${what} has no line: it falls ${hole}`);
      }
    } else if (!names(made[0])) {
      conflict('the line that made it names another page, tool or user');
    }
    if (ran.length + closed.length > 1) {
      conflicts++;
      fail('duplicate', id, `${what}: ${String(ran.length + closed.length)} lines ended it`);
      continue;
    }
    const [run] = ran;
    const [shut] = closed;
    const end = run ?? shut;
    if (end !== undefined && !names(end)) {
      conflict('the line that ended it names another page, tool or user');
      continue;
    }
    const { status } = proposal;
    // Pending says nothing: it ended after the record was saved, or in a later record.
    if (status === 'pending') continue;
    if (status === 'accepted') {
      if (run !== undefined) {
        if ((run.callId ?? null) !== proposal.callId) {
          conflict("the line that ran it carries another callId than the record's");
        }
      } else if (shut !== undefined) {
        conflict(`the record has it accepted, and the log closed it as ${shut.reason}`);
      } else {
        const hole = logHole(proposal.decidedAt ?? proposal.at);
        if (hole === null) {
          missing++;
          fail('missing', id, `${what} is accepted in the record, and no line ran it`);
        } else {
          note('explained', id, `${what} has no line that ran it: it falls ${hole}`);
        }
      }
      continue;
    }
    if (run !== undefined) {
      // Only an Accept makes a run, and a run the page carried out is one it
      // bound to its acceptance. An acceptance that never bound (not_run), or
      // that the link lost (cancelled), leaves a run the page refused or the
      // relay answered itself.
      const ranOnPage =
        run.callId !== undefined && (run.outcome === 'ok' || run.outcome === 'tool_error');
      if (ranOnPage || (status !== 'not_run' && status !== 'cancelled')) {
        conflict(`the record has it ${status}, and the log ran it`);
      } else if (status === 'cancelled') {
        note(
          'outcome',
          id,
          `${what}: the page saw cancelled, the relay ran it and answered ${run.outcome}`,
        );
      }
      continue;
    }
    if (shut === undefined) {
      // A relay that stops writes no close for what was pending, and the record's end may be the page's own.
      note('outcome', id, `${what} is ${status} in the record, and no line ended it`);
    } else if (shut.reason !== status) {
      // The page learns of a withdrawal only from the relay, which wrote it as one.
      if (PAGE_DECIDED.has(shut.reason) || status === 'withdrawn') {
        conflict(`the record has it ${status}, and the log closed it as ${shut.reason}`);
      } else {
        note(
          'outcome',
          id,
          `${what}: the page saw ${status}, the relay closed it as ${shut.reason}`,
        );
      }
    }
  }
  // A call that ran a proposal is that proposal's one accepted run.
  for (const call of record.calls) {
    const proposal = call.proposalId === null ? undefined : proposals.get(call.proposalId);
    if (proposal === undefined || proposal.status === 'pending') continue;
    if (
      proposal.status !== 'accepted' ||
      (proposal.callId !== null && proposal.callId !== call.callId)
    ) {
      conflicts++;
      fail(
        'conflict',
        call.callId,
        `call ${call.callId} ran proposal ${proposal.proposalId}, which the record has ${proposal.status === 'accepted' ? 'run by another call' : proposal.status}`,
      );
    }
  }

  // Lines for the record's pages that it should hold and does not: call
  // lines whose invoke went out, and the lines that made proposals.
  const inRecord = new Set(record.calls.map((call) => call.callId));
  const strays = callLines.filter((line) =>
    !record.pageIds.includes(line.pageId)
      ? false
      : line.outcome === 'proposed'
        ? line.proposalId !== undefined && !proposals.has(line.proposalId)
        : line.callId !== undefined && !inRecord.has(line.callId),
  );
  // Between two lines the record holds, by the relay's clock alone: an
  // invoke sent after one the page got and before another went down the same
  // ordered link, whatever times the record gives its own entries.
  const held = pairs.map(([, line]) => line);
  const after = Math.min(...held.map((line) => line.at + line.durationMs));
  const before = Math.max(...held.map((line) => line.at));
  interface Stray {
    line: CallLine;
    proposalId: string | null;
    earliest: number;
    latest: number;
    /** Where the line falls against the record, before any cap is spent on it. */
    verdict: 'outside' | 'edge' | 'unreached' | 'refused' | 'held';
    credited: boolean;
  }
  const placed: Stray[] = [];
  for (const line of skew === null ? [] : strays) {
    const proposalId = line.outcome === 'proposed' ? (line.proposalId ?? null) : null;
    // When the invoke or proposal could have reached the page: no earlier
    // than the median puts it, no later than the relay's answer.
    const earliest = line.at + (skew ?? 0) - PLACE_SLACK_MS;
    const latest = line.at + (skew ?? 0) + line.durationMs + PLACE_SLACK_MS;
    const between = after < line.at && line.at + line.durationMs < before;
    const closedAs = proposalId === null ? undefined : closedBy.get(proposalId)?.[0]?.reason;
    let verdict: Stray['verdict'] = 'held';
    if (!between && (latest < record.from || earliest > record.to)) verdict = 'outside';
    else if (!between && (earliest < record.from || latest > record.to)) verdict = 'edge';
    else if (proposalId === null ? MAY_NOT_ARRIVE.has(line.outcome) : closedAs === 'cancelled') {
      verdict = 'unreached';
    } else if (closedAs === 'refused') verdict = 'refused';
    placed.push({ line, proposalId, earliest, latest, verdict, credited: false });
  }
  // The caps' counts go first to lines that fit the fewest of them, so a
  // line the relay answered itself, which fits any outcome, never takes a
  // count a stricter line needed.
  const credit = droppedCredit(record);
  for (const strict of [true, false]) {
    for (const stray of placed) {
      if (stray.verdict !== 'held' || RELAY_ANSWERED.has(stray.line.outcome) === strict) continue;
      stray.credited =
        stray.proposalId === null
          ? credit.call(stray.line, stray.earliest, stray.latest)
          : credit.proposal();
    }
  }
  let unrecorded = 0;
  let withinDropped = 0;
  let unreached = 0;
  for (const { line, proposalId, verdict, credited } of placed) {
    const id = proposalId ?? line.callId ?? null;
    const what = `${proposalId === null ? 'call' : 'proposal'} ${String(id)} (${line.tool} by ${line.userId} at ${iso(line.at)} on the relay's clock)`;
    if (verdict === 'outside') continue;
    if (verdict === 'edge') {
      note('edge', id, `${what} may have reached the page just outside the record`);
    } else if (verdict === 'unreached') {
      unreached++;
      note(
        'explained',
        id,
        `${what} ended ${proposalId === null ? line.outcome : 'cancelled'}, so ${proposalId === null ? 'its invoke' : 'it'} may never have arrived`,
      );
    } else if (verdict === 'refused') {
      note('explained', id, `${what} was refused by the page as it arrived`);
    } else if (credited) {
      withinDropped++;
      note(
        'explained',
        id,
        `${what} falls within the ${proposalId === null ? 'calls' : 'proposals'} the record's cap dropped`,
      );
    } else {
      unrecorded++;
      fail(
        'unrecorded',
        id,
        `${what} is in the log within the record's span, and not in the record`,
      );
    }
  }
  const unplaced = skew === null ? strays.length : 0;
  if (unplaced > 0) {
    // With no clock to place them by, a record emptied of its calls would pass for one that never had any.
    fail(
      'unplaced',
      null,
      `no call or proposal in the record has a line, so ${String(unplaced)} lines for its pages cannot be placed on the page's clock, and the record cannot be shown to hold them`,
    );
  }

  // Joins are notes: the page names who it listed, the log who attached, each by its own clock.
  for (const span of record.attachments) {
    if (span.before) continue;
    const attached = lines.some(
      (line) =>
        line.type === 'attach' &&
        line.pageId === span.pageId &&
        samePerson(span.user.id, line.userId),
    );
    if (!attached) {
      note(
        'attachment',
        span.pageId,
        `${named(span.user)}, who joined at ${iso(span.joinedAt)}, has no attach line on that page`,
      );
    }
  }

  // How a time-boxed session ended, as the page and the relay each saw it:
  // a note, since either clock may end it first, and the log says only what
  // the page told the relay (ADR 0043's notes). 'relay' is the page's word
  // for a new page session, which the log has no reason for.
  const { scope } = record;
  if (scope.kind === 'session' && scope.endedBy !== null && scope.endedBy !== 'relay') {
    for (const line of lines) {
      if (line.type !== 'session_end' || line.sessionId !== scope.sessionId) continue;
      if (line.reason !== scope.endedBy) {
        note(
          'session',
          scope.sessionId,
          `session ${scope.sessionId} ended by ${scope.endedBy} in the record and by ${line.reason} in the log`,
        );
      }
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
    unplaced,
    skewMs: skew,
    failed: findings.some((finding) => finding.level === 'fail'),
  };
}

/**
 * What the record's caps can explain, spent as lines are explained, so the
 * counts a record gives cannot cover more lines than they count. The calls
 * ring drops the oldest first and only once full, so dropped calls are older
 * than every call kept and each is counted under its user and the outcome
 * the page saw then; proposals past the cap are counted only.
 */
function droppedCredit(record: SessionRecord): {
  call: (line: CallLine, earliest: number, latest: number) => boolean;
  proposal: () => boolean;
} {
  const { dropped, calls } = record;
  const first = calls[0];
  const ring =
    calls.length === SESSION_RECORD_MAX_CALLS &&
    first !== undefined &&
    dropped.firstAt !== null &&
    dropped.lastAt !== null &&
    dropped.lastAt <= first.at;
  let callsLeft = ring ? dropped.calls : 0;
  let others = dropped.otherCalls;
  const byUser = dropped.byUser.map((entry) => ({ user: entry.user, counts: { ...entry.counts } }));
  let proposalsLeft =
    record.proposals.length === SESSION_RECORD_MAX_PROPOSALS ? dropped.proposals : 0;
  return {
    call(line, earliest, latest) {
      if (callsLeft === 0 || dropped.firstAt === null || dropped.lastAt === null) return false;
      if (earliest > dropped.lastAt || latest < dropped.firstAt) return false;
      const mine = byUser.filter((entry) => samePerson(entry.user, line.userId));
      if (mine.length === 0) {
        // Past SESSION_RECORD_MAX_DROPPED_USERS users the rest are counted together.
        if (others === 0) return false;
        others--;
        callsLeft--;
        return true;
      }
      // The page saw this outcome, or the call was still running when it was
      // dropped, or the relay answered it whatever the page saw. Running
      // fits every line, so it is spent last.
      const fits = (outcome: string): boolean =>
        outcome === line.outcome ||
        outcome === 'running' ||
        (outcome === 'ok' && line.imageRefused !== undefined) ||
        RELAY_ANSWERED.has(line.outcome);
      for (const entry of mine) {
        const counts: Record<string, number | undefined> = entry.counts;
        const outcome =
          [
            line.outcome,
            ...Object.keys(counts).filter((name) => name !== 'running'),
            'running',
          ].find((name) => (counts[name] ?? 0) > 0 && fits(name)) ?? null;
        if (outcome === null) continue;
        counts[outcome] = (counts[outcome] ?? 0) - 1;
        callsLeft--;
        return true;
      }
      return false;
    },
    proposal() {
      if (proposalsLeft === 0) return false;
      proposalsLeft--;
      return true;
    },
  };
}

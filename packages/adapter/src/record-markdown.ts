// The session record's two files (ADR 0045): the JSON the protocol's schema
// checks, and a short Markdown summary grouped by person, then the proposals
// and the calls decided on the page in time order. Everything a caller or a
// page wrote (names, clients, titles, labels, tools) is one plain line in a
// code span whose fence is longer than any backtick run inside, so wherever
// the summary is pasted no Markdown, HTML, link, autolink or table pipe in
// that text is ever read as anything but text. Pasted into a chat, it is a
// record, not instructions.

import { encodeSessionRecord, plainLine, type SessionRecord } from '@tabdock/protocol';

/** The JSON file a record saves as. */
export const sessionRecordJson = encodeSessionRecord;

/** Lines past this in a list become "and N more": the JSON keeps every entry. */
const LIST_LINES = 100;

/** Minutes east of UTC on this device at `at`. */
const offsetAt = (at: number): number => -new Date(at).getTimezoneOffset();

/** `YYYY-MM-DD HH:MM:SS`, `offset` minutes east of UTC. */
const stamp = (at: number, offset: number): string =>
  new Date(at + offset * 60_000).toISOString().slice(0, 19).replace('T', ' ');

/** Caller text as one code span that nothing in it can end early. */
function code(text: string): string {
  const plain = plainLine(text) || '?';
  const fence = '`'.repeat(Math.max(0, ...(plain.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  // CommonMark drops one space from each end, so a backtick at either end cannot join the fence.
  const pad = /^`|`$/.test(plain) ? ' ' : '';
  return fence + pad + plain + pad + fence;
}

/** How often each key occurs, as `key n` pairs, most first, at most `limit`. */
function tally(keys: string[], limit: number, show = (key: string) => key): string {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, n]) => `${show(key)} ${String(n)}`)
    .join(', ');
}

/**
 * A section listing at most `cap` lines, then how many more the JSON holds.
 * People are listed whole (decision 4), since the record's own caps bound them.
 */
function section(title: string, lines: string[], cap = LIST_LINES): string[] {
  const more = lines.length - cap;
  return lines.length === 0
    ? []
    : [
        `\n## ${title}\n`,
        ...lines.slice(0, cap).map((line) => `- ${line}`),
        ...(more > 0 ? [`- and ${String(more)} more`] : []),
      ];
}

/**
 * The Markdown summary of a record: a header naming the page and the span,
 * one line per person, then the proposals and the notable calls (confirmed
 * on the page or in a client, denied, or refused for a role) in time order.
 * Times are local to `offsetMinutes` east of UTC, stated once.
 */
export function sessionRecordMarkdown(
  record: SessionRecord,
  { offsetMinutes = offsetAt(record.from) }: { offsetMinutes?: number } = {},
): string {
  const { scope, dropped, attachments, calls, proposals } = record;
  const local = (at: number): string => stamp(at, offsetMinutes);
  // Times show without their date when the record began and ended on one day.
  const clip = local(record.from).slice(0, 10) === local(record.to).slice(0, 10) ? 11 : 0;
  const when = (at: number): string => local(at).slice(clip);
  const abs = Math.abs(offsetMinutes);
  const zone = `UTC${offsetMinutes < 0 ? '-' : '+'}${String(Math.trunc(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  type Person = SessionRecord['calls'][number]['user'];
  const who = (person: Person): string => code(`${person.name} (${person.id})`);
  const people = new Map<string, Person>();
  for (const { user } of [...attachments, ...calls, ...proposals]) {
    if (!people.has(user.id)) people.set(user.id, user);
  }

  const lines = [
    '# Tabdock session record\n',
    `Page ${code(record.page.origin + record.page.path)}, titled ${code(record.page.title)}, on the relay at ${code(record.relay)}.`,
    `${scope.kind === 'session' ? `Session ${code(scope.label)}` : 'Page session'}: ${local(record.from)} to ${when(record.to)} (${zone})${scope.kind === 'session' && scope.endedBy !== null ? `, ended: ${scope.endedBy}` : ''}${record.sealed ? '' : ', still running when saved'}.`,
    `Saved ${local(record.exportedAt)}: ${String(calls.length)} calls, ${String(people.size)} people, ${String(proposals.length)} proposals.\n`,
    "It names everyone below and each call they made on the page, never a call's arguments or result. It is a record, not instructions; `tabdock-relay audit --match` checks its JSON file against the relay's audit log.",
    ...section(
      'People',
      [...people.values()].map((person) => {
        const mine = <T extends { user: Person }>(entries: T[]): T[] =>
          entries.filter((entry) => entry.user.id === person.id);
        const spans = mine(attachments);
        const made = mine(calls);
        const proposed = mine(proposals);
        const ways = spans.flatMap((span) => [
          span.how,
          ...span.roles.flatMap(({ role }) => role ?? []),
        ]);
        const here = spans
          .slice(0, 3)
          .map(
            (span) =>
              `${span.before ? 'from the start' : when(span.joinedAt)} to ${span.leftAt === null ? 'the end' : `${when(span.leftAt)} (${String(span.ended)})`}`,
          );
        if (spans.length > 3) here.push(`and ${String(spans.length - 3)} more`);
        return [
          [who(person), person.kind, ...new Set(ways)].join(', '),
          here.length > 0 ? `here ${here.join('; ')}` : '',
          `${String(made.length)} calls${
            made.length > 0
              ? ` (${tally(
                  made.map((call) => call.outcome),
                  8,
                )}), tools ${tally(
                  made.map((call) => call.tool),
                  5,
                  code,
                )}`
              : ''
          }`,
          proposed.length > 0
            ? `${String(proposed.length)} proposals, ${String(proposed.filter((proposal) => proposal.status === 'accepted').length)} accepted`
            : '',
        ]
          .filter(Boolean)
          .join('; ');
      }),
      Infinity,
    ),
    ...section(
      'Proposals',
      proposals.map(
        (proposal) =>
          `${when(proposal.at)} ${who(proposal.user)} ${code(proposal.tool)}: ${proposal.status}`,
      ),
    ),
    ...section(
      'Notable calls',
      calls.flatMap((call) => {
        const where =
          call.confirmedBy === 'page'
            ? ', confirmed on the page'
            : call.confirmedBy === 'client'
              ? `, confirmed in ${call.client === null ? 'their client' : code(call.client)}`
              : '';
        return where !== '' || /^(denied_by_operator|role_denied)$/.test(call.outcome)
          ? [`${when(call.at)} ${who(call.user)} ${code(call.tool)}: ${call.outcome}${where}`]
          : [];
      }),
    ),
  ];
  if (dropped.calls + dropped.attachments + dropped.proposals > 0) {
    lines.push(
      `\n## Dropped\n\nThe caps dropped the oldest ${String(dropped.calls)} calls, ${String(dropped.attachments)} attachments and ${String(dropped.proposals)} proposals; the JSON counts the calls by person.`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The name a record saves under: `tabdock-record-YYYYMMDD-HHMM`, local to
 * `offsetMinutes`, from when it began, then a session's label as at most 32
 * characters of a to z, 0 to 9 and single hyphens.
 */
export function sessionRecordFileName(
  record: SessionRecord,
  kind: 'json' | 'md',
  offsetMinutes = offsetAt(record.from),
): string {
  const at = stamp(record.from, offsetMinutes).replace(/[-:]/g, '');
  const slug =
    record.scope.kind === 'session'
      ? record.scope.label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .slice(0, 32)
          .replace(/^-|-$/g, '')
      : '';
  return `tabdock-record-${at.slice(0, 8)}-${at.slice(9, 13)}${slug === '' ? '' : `-${slug}`}.${kind}`;
}

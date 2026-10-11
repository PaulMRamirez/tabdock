// The session record's Markdown summary and file names (ADR 0045): every
// name, client, title, label and tool lands in one code span that CommonMark
// closes only where the summary meant it to, so no HTML, link, autolink or
// table pipe a caller wrote is read as anything but text, whatever it holds;
// no line holds an en or em dash; every person gets a line with their counts; the
// time-ordered lists stop at 100 lines and say how many more the JSON keeps;
// and a record saves under a name built from its start and its label alone.

import {
  encodeSessionRecord,
  parseSessionRecord,
  plainLine,
  type SessionRecord,
  SessionRecordSchema,
} from '@tabdock/protocol';
import { describe, expect, it } from 'vitest';
import {
  sessionRecordFileName,
  sessionRecordJson,
  sessionRecordMarkdown,
} from '../src/record-markdown.ts';

/** 09:41 UTC on 10 October 2026. */
const START = Date.UTC(2026, 9, 10, 9, 41);
const MINUTE = 60_000;

type Person = SessionRecord['calls'][number]['user'];
type Call = SessionRecord['calls'][number];

const alice: Person = { id: 'alice', name: 'Alice', kind: 'member' };
const guest: Person = { id: 'g_0123abcd', name: 'guest@example.com', kind: 'invitee' };

function call(n: number, user: Person, more: Partial<Call> = {}): Call {
  return {
    callId: `c_${String(n)}`,
    pageId: 'pg_1',
    at: START + n * MINUTE,
    user,
    client: 'claude-code 2.1.288',
    tool: 'set_view',
    outcome: 'ok',
    durationMs: 10,
    confirmedBy: null,
    proposalId: null,
    ...more,
  };
}

function record(more: Partial<SessionRecord> = {}): SessionRecord {
  return SessionRecordSchema.parse({
    format: 'tabdock.session-record',
    v: 1,
    adapterVersion: '0.1.0',
    exportedAt: START + 50 * MINUTE,
    page: { origin: 'https://board.example', path: '/lesson', title: 'Board' },
    relay: 'relay.example',
    policy: {},
    pageIds: ['pg_1'],
    scope: { kind: 'page' },
    from: START,
    to: START + 49 * MINUTE,
    sealed: true,
    attachments: [],
    calls: [],
    proposals: [],
    dropped: {
      calls: 0,
      attachments: 0,
      proposals: 0,
      firstAt: null,
      lastAt: null,
      byUser: [],
      otherCalls: 0,
    },
    ...more,
  });
}

/**
 * The code spans in one line as CommonMark 0.31.2 reads them (section 6.1):
 * a run of backticks opens one that the next run of exactly that length
 * closes, one space comes off each end when both ends have one, and a run
 * with no closer is literal text. Everything else is the text outside.
 */
function codeSpans(line: string): { spans: string[]; outside: string } {
  const spans: string[] = [];
  let outside = '';
  let at = 0;
  const runAt = (index: number): number => {
    let length = 0;
    while (line[index + length] === '`') length++;
    return length;
  };
  while (at < line.length) {
    if (line[at] !== '`') {
      outside += line.charAt(at);
      at++;
      continue;
    }
    const open = runAt(at);
    let close = -1;
    for (let index = at + open; index < line.length;) {
      const run = runAt(index);
      if (run === open) {
        close = index;
        break;
      }
      index += Math.max(run, 1);
    }
    if (close === -1) {
      outside += line.slice(at, at + open);
      at += open;
      continue;
    }
    let content = line.slice(at + open, close);
    if (content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') {
      content = content.slice(1, -1);
    }
    spans.push(content);
    at = close + open;
  }
  return { spans, outside };
}

const HOSTILE = [
  'tick`in`side',
  '`leading',
  'trailing`',
  '``',
  '<script>alert(1)</script>',
  '[x](javascript:alert(1))',
  '<https://evil.example>',
  'www.evil.example and https://evil.example',
  'a | b | c',
  'first\u2028# Heading\n- item',
  '**bold** _em_ \\` \u202eright to left',
] as const;

describe('the session record summary', () => {
  it('sets every name, client, title, label and tool a caller or page wrote in one code span on one line', () => {
    const people = HOSTILE.map((name, n): Person => ({
      id: `u${String(n)}`,
      name,
      kind: 'member',
    }));
    const hostile = record({
      page: { origin: 'https://board.example', path: '/`board`<b>', title: HOSTILE[4] },
      relay: 'relay.example',
      scope: {
        kind: 'session',
        sessionId: 'ss_1',
        label: 'Period `3` [x](javascript:)',
        startedAt: START,
        endsAt: START + 60 * MINUTE,
        endedAt: START + 49 * MINUTE,
        endedBy: 'operator',
        maxDrivers: 1,
        proposals: 'all',
        observers: 2,
        invites: 1,
      },
      calls: people.map((user, n) =>
        call(n, user, {
          client: HOSTILE[(n + 3) % HOSTILE.length] ?? null,
          confirmedBy: 'client',
          tool: 'wipe',
        }),
      ),
    });
    const markdown = sessionRecordMarkdown(hostile, { offsetMinutes: 0 });
    const lines = markdown.split('\n');
    const allSpans: string[] = [];
    for (const line of lines) {
      const { spans, outside } = codeSpans(line);
      allSpans.push(...spans);
      for (const unsafe of ['<', '](', '|', 'http', 'www.', 'javascript', '**', '\u202e']) {
        expect(outside, line).not.toContain(unsafe);
      }
      // Nothing a caller wrote starts a heading, a list item or anything else of its own.
      expect(/^(#{1,2} |- |$)/.test(line) || /^[A-Z]/.test(line), line).toBe(true);
    }
    for (const text of HOSTILE) {
      expect(allSpans, text).toContain(`${plainLine(text)} (u${String(HOSTILE.indexOf(text))})`);
      expect(allSpans, text).toContain(plainLine(text));
    }
    expect(allSpans).toContain('https://board.example/`board`<b>');
    expect(allSpans).toContain('Period `3` [x](javascript:)');
    expect(allSpans).toContain('wipe');
    expect(markdown).not.toMatch(/[\u2013\u2014\u2028\u2029]/);
  });

  it('opens with the page, the span in local time and the counts, and says what the file is', () => {
    const markdown = sessionRecordMarkdown(
      record({
        sealed: false,
        attachments: [
          {
            user: alice,
            pageId: 'pg_1',
            how: 'approved',
            inviteId: null,
            before: true,
            joinedAt: START,
            leftAt: null,
            ended: null,
            roles: [{ at: START, role: 'driver' }],
            rolesDropped: 0,
          },
        ],
        calls: [call(1, alice)],
      }),
      { offsetMinutes: 120 },
    );
    const [title, , page, span, saved, , notice] = markdown.split('\n');
    expect(title).toBe('# Tabdock session record');
    expect(page).toBe(
      'Page `https://board.example/lesson`, titled `Board`, on the relay at `relay.example`.',
    );
    expect(span).toBe(
      'Page session: 2026-10-10 11:41:00 to 12:30:00 (UTC+02:00), still running when saved.',
    );
    expect(saved).toBe('Saved 2026-10-10 12:31:00: 1 calls, 1 people, 0 proposals.');
    expect(notice).toContain('never a call');
    expect(notice).toContain('`tabdock-relay audit --match`');
    expect(sessionRecordMarkdown(record(), { offsetMinutes: -330 })).toContain(
      '2026-10-10 04:11:00 to 05:00:00 (UTC-05:30).',
    );
  });

  it('groups by person: how they came in, their roles and spans, calls by outcome, top tools and proposals', () => {
    const span = (joinedAt: number, leftAt: number | null) => ({
      user: guest,
      pageId: 'pg_1',
      how: 'invite' as const,
      inviteId: 'inv_1',
      before: false,
      joinedAt: START + joinedAt * MINUTE,
      leftAt: leftAt === null ? null : START + leftAt * MINUTE,
      ended: leftAt === null ? null : ('left' as const),
      roles: [{ at: START + joinedAt * MINUTE, role: 'observer' as const }],
      rolesDropped: 0,
    });
    const markdown = sessionRecordMarkdown(
      record({
        attachments: [span(1, 2), span(3, 4), span(5, 6), span(7, null)],
        calls: [
          call(1, alice),
          call(2, alice, { tool: 'wipe', outcome: 'denied_by_operator' }),
          call(3, alice),
          call(4, guest, { tool: 'get_view' }),
        ],
        proposals: [
          {
            proposalId: 'pr_1',
            pageId: 'pg_1',
            at: START + 5 * MINUTE,
            user: guest,
            tool: 'go_to_stop',
            status: 'accepted',
            decidedAt: START + 6 * MINUTE,
            callId: 'c_9',
          },
          {
            proposalId: 'pr_2',
            pageId: 'pg_1',
            at: START + 7 * MINUTE,
            user: guest,
            tool: 'go_to_stop',
            status: 'dismissed',
            decidedAt: START + 8 * MINUTE,
            callId: null,
          },
        ],
      }),
      { offsetMinutes: 0 },
    );
    expect(markdown).toContain(
      '- `guest@example.com (g_0123abcd)`, invitee, invite, observer; here 09:42:00 to 09:43:00 (left); 09:44:00 to 09:45:00 (left); 09:46:00 to 09:47:00 (left); and 1 more; 1 calls (ok 1), tools `get_view` 1; 2 proposals, 1 accepted',
    );
    expect(markdown).toContain(
      '- `Alice (alice)`, member; 3 calls (ok 2, denied_by_operator 1), tools `set_view` 2, `wipe` 1',
    );
    expect(markdown).toContain(
      '\n## Proposals\n\n- 09:46:00 `guest@example.com (g_0123abcd)` `go_to_stop`: accepted\n',
    );
    expect(markdown).toContain(
      '\n## Notable calls\n\n- 09:43:00 `Alice (alice)` `wipe`: denied_by_operator\n',
    );
    expect(markdown).not.toContain('## Dropped');
  });

  it('lists calls confirmed on the page or in a client, denied or refused for a role, and no others', () => {
    const markdown = sessionRecordMarkdown(
      record({
        calls: [
          call(1, alice, { confirmedBy: 'page', tool: 'wipe' }),
          call(2, alice, { confirmedBy: 'client', tool: 'wipe' }),
          call(3, alice, { confirmedBy: 'client', client: null, tool: 'wipe' }),
          call(4, guest, { outcome: 'role_denied' }),
          call(5, alice, { tool: 'quiet' }),
        ],
      }),
      { offsetMinutes: 0 },
    );
    const notable = markdown.split('## Notable calls\n\n')[1]?.trim().split('\n');
    expect(notable).toEqual([
      '- 09:42:00 `Alice (alice)` `wipe`: ok, confirmed on the page',
      '- 09:43:00 `Alice (alice)` `wipe`: ok, confirmed in `claude-code 2.1.288`',
      '- 09:44:00 `Alice (alice)` `wipe`: ok, confirmed in their client',
      '- 09:45:00 `guest@example.com (g_0123abcd)` `set_view`: role_denied',
    ]);
  });

  it('stops each list at 100 lines and says how many more the JSON keeps', () => {
    const calls = Array.from({ length: 130 }, (_, n) =>
      call(n, alice, { outcome: 'denied_by_operator' }),
    );
    const markdown = sessionRecordMarkdown(record({ to: START + 200 * MINUTE, calls }), {
      offsetMinutes: 0,
    });
    const notable = markdown.split('## Notable calls\n\n')[1]?.trim().split('\n') ?? [];
    expect(notable).toHaveLength(101);
    expect(notable.at(-1)).toBe('- and 30 more');
  });

  it('lists every person, one line each, however many there are', () => {
    const calls = Array.from({ length: 130 }, (_, n) =>
      call(n, { id: `u${String(n)}`, name: `User ${String(n)}`, kind: 'member' }),
    );
    const markdown = sessionRecordMarkdown(record({ to: START + 200 * MINUTE, calls }), {
      offsetMinutes: 0,
    });
    const people = markdown.split('## People\n\n')[1]?.split('\n\n')[0]?.trim().split('\n') ?? [];
    expect(people).toHaveLength(130);
    expect(people.at(-1)).toMatch(/^- `User 129 \(u129\)`, member; 1 calls/);
  });

  it('gives full dates when the record runs past midnight, and says what the caps dropped', () => {
    const markdown = sessionRecordMarkdown(
      record({
        to: START + 15 * 60 * MINUTE,
        calls: [call(1, alice, { outcome: 'role_denied' })],
        dropped: {
          calls: 7,
          attachments: 1,
          proposals: 0,
          firstAt: START,
          lastAt: START + MINUTE,
          byUser: [{ user: 'alice', counts: { ok: 7 } }],
          otherCalls: 0,
        },
      }),
      { offsetMinutes: 0 },
    );
    expect(markdown).toContain('2026-10-10 09:41:00 to 2026-10-11 00:41:00 (UTC+00:00)');
    expect(markdown).toContain('- 2026-10-10 09:42:00 `Alice (alice)`');
    expect(markdown).toContain('dropped the oldest 7 calls, 1 attachments and 0 proposals');
  });
});

describe('the session record files', () => {
  it('saves the JSON as the protocol encodes it, which reads back as the same record', () => {
    const saved = record({ calls: [call(1, alice)] });
    const json = sessionRecordJson(saved);
    expect(json).toBe(encodeSessionRecord(saved));
    expect(json).toContain('\n  "format": "tabdock.session-record"');
    expect(parseSessionRecord(json)).toEqual({ ok: true, record: saved });
  });

  it('names a file by its local start and a session label of a to z, 0 to 9 and single hyphens', () => {
    expect(sessionRecordFileName(record(), 'json', 0)).toBe('tabdock-record-20261010-0941.json');
    expect(sessionRecordFileName(record(), 'md', 120)).toBe('tabdock-record-20261010-1141.md');
    const labelled = (label: string) =>
      record({
        scope: {
          kind: 'session',
          sessionId: 'ss_1',
          label,
          startedAt: START,
          endsAt: START + 30 * MINUTE,
          endedAt: null,
          endedBy: null,
          maxDrivers: 1,
          proposals: 'off',
          observers: 0,
          invites: 0,
        },
      });
    expect(sessionRecordFileName(labelled('Period 3: Maps & Globes!'), 'json', 0)).toBe(
      'tabdock-record-20261010-0941-period-3-maps-globes.json',
    );
    expect(sessionRecordFileName(labelled('../../etc/passwd'), 'md', 0)).toBe(
      'tabdock-record-20261010-0941-etc-passwd.md',
    );
    expect(sessionRecordFileName(labelled('???'), 'md', 0)).toBe('tabdock-record-20261010-0941.md');
    const long = sessionRecordFileName(labelled('a'.repeat(31) + ' b c d e f'), 'json', 0);
    expect(long).toBe(`tabdock-record-20261010-0941-${'a'.repeat(31)}.json`);
  });
});

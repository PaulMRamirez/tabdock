// The pure half of confirmation in the caller's client (ADR 0026, confirm.ts):
// when the relay asks, the question it writes, the one answer that confirms,
// the digest that binds a confirmation to its arguments, the records and
// waiting questions with their bounds and expiry, and the rewrite of a
// requestState the SDK would refuse before any handler ran. The call flow on
// both revisions is held by confirm-calls.test.ts and, against the sim page,
// by tests/e2e/test/confirm-in-client.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  argumentsDigest,
  asksClient,
  canonicalJson,
  type ConfirmationRecord,
  confirmQuestion,
  confirms,
  FORGED_REQUEST_STATE,
  MAX_PENDING_CONFIRMATIONS,
  MAX_QUESTION_ARGUMENT_CHARS,
  type NewRecord,
  PendingConfirmations,
  shownArguments,
  withStringRequestState,
} from '../src/confirm.ts';

afterEach(() => {
  vi.useRealTimers();
});

const DRIVER = { kind: 'member', role: 'driver', inviteId: null } as const;
const OPTED_IN = { consequential: 'confirm', confirmVia: 'client' } as const;
const MARKED = { consequential: true };

describe('asksClient', () => {
  it('asks only a member driver on an attachment no invite made, for a marked tool, on a page that opted in', () => {
    expect(asksClient(OPTED_IN, MARKED, { account: 'member', attachment: DRIVER })).toBe(true);
    // S6: every other case keeps the page prompt.
    const others: [string, boolean][] = [
      [
        'a page that kept confirmVia page',
        asksClient({ consequential: 'confirm', confirmVia: 'page' }, MARKED, {
          account: 'member',
          attachment: DRIVER,
        }),
      ],
      [
        'a page that allows consequential calls',
        asksClient({ consequential: 'allow', confirmVia: 'client' }, MARKED, {
          account: 'member',
          attachment: DRIVER,
        }),
      ],
      [
        'a tool the adapter did not mark',
        asksClient(OPTED_IN, {}, { account: 'member', attachment: DRIVER }),
      ],
      [
        'a tool marked false',
        asksClient(OPTED_IN, { consequential: false }, { account: 'member', attachment: DRIVER }),
      ],
      [
        'an invitee',
        asksClient(OPTED_IN, MARKED, {
          account: 'invitee',
          attachment: { ...DRIVER, kind: 'invitee', inviteId: 'inv_1' },
        }),
      ],
      [
        'an observer',
        asksClient(OPTED_IN, MARKED, {
          account: 'member',
          attachment: { ...DRIVER, role: 'observer' },
        }),
      ],
      [
        "a member's attachment an invite made",
        asksClient(OPTED_IN, MARKED, {
          account: 'member',
          attachment: { ...DRIVER, inviteId: 'inv_1' },
        }),
      ],
      [
        'an attachment recorded as an invitee for a member account',
        asksClient(OPTED_IN, MARKED, {
          account: 'member',
          attachment: { ...DRIVER, kind: 'invitee' },
        }),
      ],
    ];
    for (const [label, asked] of others) expect(asked, label).toBe(false);
  });
});

describe('the arguments digest', () => {
  it('reads the same arguments the same whatever order their keys came in, and any change otherwise', () => {
    const a = { b: 1, a: { d: [1, { y: 2, x: 1 }], c: 'é' } };
    const b = { a: { c: 'é', d: [1, { x: 1, y: 2 }] }, b: 1 };
    expect(canonicalJson(a)).toBe('{"a":{"c":"é","d":[1,{"x":1,"y":2}]},"b":1}');
    expect(argumentsDigest(a)).toBe(argumentsDigest(b));
    expect(argumentsDigest(a)).toMatch(/^[0-9a-f]{64}$/);
    for (const changed of [
      { ...b, b: 2 },
      { ...b, b: '1' },
      { a: { c: 'é', d: [{ x: 1, y: 2 }, 1] }, b: 1 },
      { ...b, extra: null },
    ]) {
      expect(argumentsDigest(changed), JSON.stringify(changed)).not.toBe(argumentsDigest(a));
    }
  });

  it('keeps a key named __proto__ as an ordinary key', () => {
    const parsed = JSON.parse('{"__proto__":{"admin":true},"a":1}') as Record<string, unknown>;
    expect(canonicalJson(parsed)).toBe('{"__proto__":{"admin":true},"a":1}');
    expect(argumentsDigest(parsed)).not.toBe(argumentsDigest({ a: 1 }));
  });
});

describe('the question', () => {
  const base = {
    tool: 'board.clear',
    pageId: 'pg_0123456789',
    origin: 'https://board.example:8443',
  };

  it("names the tool, the page id, the host and the arguments, in the relay's own words", () => {
    const question = confirmQuestion({ ...base, args: { reason: 'tidy' } });
    expect(question.message).toContain('Page: pg_0123456789 at board.example:8443');
    expect(question.message).toContain('Tool: "board.clear" (a name the page chose)');
    expect(question.message).toContain('Arguments (JSON): {"reason":"tidy"}');
    expect(question.message).not.toContain('https://');
    // One boolean field, false by default, and it is required.
    expect(question.requestedSchema).toEqual({
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          title: 'Run this call',
          description: 'True runs the call on the page now; anything else refuses it.',
          default: false,
        },
      },
      required: ['confirm'],
    });
  });

  it('cuts the arguments at 500 characters and says how many it left out', () => {
    const args = { text: 'x'.repeat(1000) };
    const whole = JSON.stringify(args);
    const shown = shownArguments(args);
    expect(shown).toBe(
      `${whole.slice(0, MAX_QUESTION_ARGUMENT_CHARS)}... (${String(whole.length - MAX_QUESTION_ARGUMENT_CHARS)} more characters not shown)`,
    );
    expect(shown.endsWith('... (511 more characters not shown)')).toBe(true);
    // Up to the cap nothing is cut or marked.
    const fits = { t: 'y'.repeat(MAX_QUESTION_ARGUMENT_CHARS - 8) };
    expect(JSON.stringify(fits)).toHaveLength(MAX_QUESTION_ARGUMENT_CHARS);
    expect(shownArguments(fits)).toBe(JSON.stringify(fits));
  });

  it('never splits a surrogate pair at the cut', () => {
    // '{"t":"' is 6 characters, so the emoji's first half would be the 500th.
    const args = { t: `${'a'.repeat(MAX_QUESTION_ARGUMENT_CHARS - 7)}\u{1F600}tail` };
    const shown = shownArguments(args);
    expect(shown.startsWith(`{"t":"${'a'.repeat(MAX_QUESTION_ARGUMENT_CHARS - 7)}...`)).toBe(true);
    expect(shown).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
  });

  it('shows what would not read as written escaped, so arguments cannot reorder or hide its words', () => {
    const question = confirmQuestion({
      ...base,
      args: { note: 'pay\u{202e}eulav\u{2066} \u{200b}\u{2028}end\u{e0041}' },
    });
    expect(question.message).toContain('pay\\u202eeulav\\u2066 \\u200b\\u2028end\\u{e0041}');
    expect(question.message).not.toMatch(/[\u{202e}\u{2066}\u{200b}\u{2028}]/u);
    expect(question.message.split('\n')).toHaveLength(5);
  });

  it("caps a long tool name and labels it as the page's", () => {
    const question = confirmQuestion({ ...base, tool: 'a'.repeat(128), args: {} });
    expect(question.message).toContain(`Tool: "${'a'.repeat(64)}..." (a name the page chose)`);
  });
});

describe('the answer that confirms', () => {
  it('is accept with confirm exactly true, and nothing else', () => {
    expect(confirms({ action: 'accept', content: { confirm: true } })).toBe(true);
    for (const answer of [
      { action: 'accept', content: { confirm: false } },
      { action: 'accept', content: { confirm: 'true' } },
      { action: 'accept', content: { confirm: 1 } },
      { action: 'accept', content: {} },
      { action: 'accept' },
      { action: 'decline', content: { confirm: true } },
      { action: 'cancel' },
      { result: { action: 'accept', content: { confirm: true } } },
      { method: 'elicitation/create', result: { action: 'accept', content: { confirm: true } } },
      'accept',
      true,
      null,
      undefined,
    ]) {
      expect(confirms(answer), JSON.stringify(answer)).toBe(false);
    }
  });
});

function fields(userId = 'alice', pageId = 'pg_0123456789'): NewRecord {
  return {
    userId,
    pageId,
    calledAs: 'call_page_tool',
    pageTool: 'wipe',
    digest: '0'.repeat(64),
    grantedAt: 0,
    origin: 'http://localhost:5173',
    client: null,
  };
}

describe('the records and the questions waiting', () => {
  it('holds at most four a user across both revisions, and frees a place as each ends', () => {
    const expired: ConfirmationRecord[] = [];
    const pending = new PendingConfirmations({
      ttlMs: 60_000,
      perUser: MAX_PENDING_CONFIRMATIONS,
      onExpired: (record) => expired.push(record),
    });
    const first = pending.add(fields());
    const second = pending.add(fields());
    const waiting = pending.wait('alice', 'pg_0123456789');
    const fourth = pending.add(fields());
    expect([first, second, waiting, fourth].every((held) => held !== null)).toBe(true);
    expect(pending.add(fields())).toBeNull();
    expect(pending.wait('alice', 'pg_0123456789')).toBeNull();
    // Another user has room of their own.
    expect(pending.add(fields('bob'))).not.toBeNull();
    waiting?.done();
    expect(pending.add(fields())).not.toBeNull();
    expect(pending.take(first?.id ?? '')).not.toBeNull();
    expect(pending.heldBy('alice')).toBe(3);
    pending.close({ code: 'page_asleep', message: 'shutting down' });
    expect(expired).toEqual([]);
  });

  it('gives a record up once, and never one past its time', () => {
    vi.useFakeTimers();
    const expired: ConfirmationRecord[] = [];
    const pending = new PendingConfirmations({
      ttlMs: 120_000,
      perUser: 4,
      onExpired: (record) => expired.push(record),
    });
    const record = pending.add(fields());
    if (record === null) throw new Error('no record');
    expect(record.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(record.expiresAt - record.askedAt).toBe(120_000);
    expect(pending.take(record.id)).toEqual(record);
    expect(pending.take(record.id)).toBeNull();

    // Past its time a record is refused even before the sweep reaches it, with no expiry line.
    const late = pending.add(fields());
    if (late === null) throw new Error('no record');
    vi.setSystemTime(late.expiresAt);
    expect(pending.take(late.id)).toBeNull();
    expect(expired).toEqual([]);
  });

  it("writes the sweep's line for a record nobody retried, and only for it", () => {
    vi.useFakeTimers();
    const expired: ConfirmationRecord[] = [];
    const pending = new PendingConfirmations({
      ttlMs: 120_000,
      perUser: 4,
      onExpired: (record) => expired.push(record),
    });
    const kept = pending.add(fields());
    const taken = pending.add(fields());
    pending.take(taken?.id ?? '');
    vi.advanceTimersByTime(119_999);
    expect(expired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(expired).toEqual([kept]);
    expect(pending.size).toBe(0);
    expect(pending.heldBy('alice')).toBe(0);
  });

  it("drops a user's records and waiting questions for a page at once, and nobody else's", () => {
    const pending = new PendingConfirmations({ ttlMs: 60_000, perUser: 4, onExpired: () => {} });
    const alicesOnPage = pending.add(fields('alice', 'pg_AAAAAAAAAA'));
    const alicesElsewhere = pending.add(fields('alice', 'pg_BBBBBBBBBB'));
    const bobsOnPage = pending.add(fields('bob', 'pg_AAAAAAAAAA'));
    const waiting = pending.wait('alice', 'pg_AAAAAAAAAA');
    const answer = {
      code: 'not_attached',
      message: 'the page operator revoked your attachment',
    } as const;
    pending.drop('pg_AAAAAAAAAA', new Set(['alice']), answer);
    expect(waiting?.signal.aborted).toBe(true);
    expect(waiting?.dropped).toEqual(answer);
    expect(pending.take(alicesOnPage?.id ?? '')).toBeNull();
    expect(pending.take(alicesElsewhere?.id ?? '')).not.toBeNull();
    expect(pending.heldBy('alice')).toBe(0);

    // The page's end drops everyone's.
    pending.drop('pg_AAAAAAAAAA', null, { code: 'page_gone', message: 'gone' });
    expect(pending.take(bobsOnPage?.id ?? '')).toBeNull();
    // A question already answered frees nothing twice.
    waiting?.done();
    expect(pending.heldBy('alice')).toBe(0);
  });
});

describe('a requestState the SDK would refuse before any handler', () => {
  const isPageCall = (name: string): boolean => name === 'call_page_tool';
  const call = (params: Record<string, unknown>): Record<string, unknown> => ({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params,
  });

  it('becomes a string the codec refuses on a call to a page tool, and nothing else changes', () => {
    for (const state of [5, null, true, { forged: 1 }, ['x']]) {
      const message = call({ name: 'call_page_tool', arguments: {}, requestState: state });
      expect(withStringRequestState(message, isPageCall)).toEqual(
        call({ name: 'call_page_tool', arguments: {}, requestState: FORGED_REQUEST_STATE }),
      );
    }
    for (const message of [
      call({ name: 'call_page_tool', arguments: {}, requestState: 'v1.abc.def' }),
      call({ name: 'call_page_tool', arguments: {} }),
      call({ name: 'list_pages', arguments: {}, requestState: 5 }),
      { jsonrpc: '2.0', id: 7, method: 'tools/list', params: { requestState: 5 } },
      [call({ name: 'call_page_tool', requestState: 5 })],
      'not a message',
    ]) {
      expect(withStringRequestState(message, isPageCall)).toBe(message);
    }
  });
});

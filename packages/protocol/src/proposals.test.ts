// ADR 0042's protocol pieces: the page's proposal policy and who it admits,
// never an agent token's caller (C13); the canonical JSON that binds an
// accepted proposal (and a client's confirmation) to its exact arguments; the
// escaping both the relay and the widget show arguments with; and the
// argument caps. Each case would pass a cap off by one or a default flipped.

import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_PROPOSAL_RUN_MS,
  canonicalJson,
  DEFAULT_CALL_DEADLINE_MS,
  escapeUnseen,
  type JsonObject,
  MAX_PENDING_PROPOSALS_PER_PAGE,
  MAX_PENDING_PROPOSALS_PER_USER,
  MAX_PROPOSAL_ARGUMENT_BYTES,
  MAX_PROPOSAL_ARGUMENT_NODES,
  MAX_PROPOSAL_RESULT_CHARS,
  MAX_SETTLED_PROPOSALS_PER_PAGE,
  MAX_WAIT_MS,
  MAX_WAITS_PER_USER,
  PolicySchema,
  PROPOSAL_OUTCOME_KEEP_MS,
  PROPOSAL_TTL_MS,
  proposalArgumentProblem,
  proposalsAdmit,
} from './index.ts';

describe('the proposal policy', () => {
  it("is off unless a page opts in, so an older adapter's hello takes none", () => {
    expect(PolicySchema.parse({}).proposals).toBe('off');
    expect(PolicySchema.parse({ proposals: 'members' }).proposals).toBe('members');
  });

  it('admits members under members, everyone but agents under all and nobody under off', () => {
    const member = { kind: 'member', agent: false } as const;
    const invitee = { kind: 'invitee', agent: false } as const;
    expect(proposalsAdmit('off', member)).toBe(false);
    expect(proposalsAdmit('off', invitee)).toBe(false);
    expect(proposalsAdmit('members', member)).toBe(true);
    expect(proposalsAdmit('members', invitee)).toBe(false);
    expect(proposalsAdmit('all', member)).toBe(true);
    expect(proposalsAdmit('all', invitee)).toBe(true);
  });

  it('never admits an agent token, though it is an invitee by kind and id (C13)', () => {
    for (const policy of ['off', 'members', 'all'] as const) {
      expect(proposalsAdmit(policy, { kind: 'invitee', agent: true }), policy).toBe(false);
      // Should a layer ever name an agent a member, it is still refused.
      expect(proposalsAdmit(policy, { kind: 'member', agent: true }), policy).toBe(false);
    }
  });

  // Literal values, so a change to a bound fails here rather than slipping through.
  it("keeps ADR 0042's numbers", () => {
    expect(PROPOSAL_TTL_MS).toBe(600_000);
    expect(MAX_PENDING_PROPOSALS_PER_USER).toBe(3);
    expect(MAX_PENDING_PROPOSALS_PER_PAGE).toBe(20);
    expect(MAX_PROPOSAL_ARGUMENT_BYTES).toBe(16_384);
    expect(MAX_PROPOSAL_ARGUMENT_NODES).toBe(1_000);
    expect(ACCEPTED_PROPOSAL_RUN_MS).toBe(60_000);
    expect(ACCEPTED_PROPOSAL_RUN_MS).toBe(DEFAULT_CALL_DEADLINE_MS + 15_000);
    expect(PROPOSAL_OUTCOME_KEEP_MS).toBe(600_000);
    expect(MAX_SETTLED_PROPOSALS_PER_PAGE).toBe(40);
    expect(MAX_PROPOSAL_RESULT_CHARS).toBe(20_000);
    // A waiting get_proposal stays under the call deadline and Claude Code's 60 s first byte.
    expect(MAX_WAIT_MS).toBe(40_000);
    expect(MAX_WAIT_MS).toBeLessThan(DEFAULT_CALL_DEADLINE_MS);
    expect(MAX_WAITS_PER_USER).toBe(2);
  });
});

describe('canonicalJson', () => {
  it('gives one text for the same arguments whatever order their keys came in', () => {
    const a = { b: 1, a: { d: [1, { y: 2, x: 1 }], c: 'é' } };
    const b = { a: { c: 'é', d: [1, { x: 1, y: 2 }] }, b: 1 };
    expect(canonicalJson(a)).toBe('{"a":{"c":"é","d":[1,{"x":1,"y":2}]},"b":1}');
    expect(canonicalJson(b)).toBe(canonicalJson(a));
    expect(canonicalJson({ ...a, b: 2 })).not.toBe(canonicalJson(a));
  });

  it('keeps a __proto__ key an ordinary key, as JSON.parse made it', () => {
    const parsed = JSON.parse('{"a":1,"__proto__":{"admin":true}}') as JsonObject;
    expect(canonicalJson(parsed)).toBe('{"__proto__":{"admin":true},"a":1}');
  });

  it('is null for what JSON cannot write', () => {
    const cycle: JsonObject = {};
    cycle.self = cycle;
    expect(canonicalJson(cycle)).toBeNull();
    expect(canonicalJson({ big: 1n })).toBeNull();
  });

  it('uses the JSON.stringify it took at load, never one a later page script put in place', () => {
    const original = JSON.stringify;
    let calls = 0;
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      calls += 1;
      return original(...args);
    }) as typeof JSON.stringify;
    try {
      expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    } finally {
      JSON.stringify = original;
    }
    expect(calls).toBe(0);
  });
});

describe('escapeUnseen', () => {
  it('shows each character that would not read as written as its escape', () => {
    expect(escapeUnseen('pay ‮evil')).toBe('pay \\u202eevil');
    expect(escapeUnseen('a​b')).toBe('a\\u200bb');
    expect(escapeUnseen('one two\nthree')).toBe('one\\u2028two\\u000athree');
    expect(escapeUnseen('tag \u{E0041}')).toBe('tag \\u{e0041}');
  });

  it('leaves plain text, other scripts and emoji as they are, and drops nothing', () => {
    for (const text of ['Move the walkthrough to stop 3', 'Größe 12', '東京', 'ok 👍']) {
      expect(escapeUnseen(text)).toBe(text);
    }
  });
});

describe('proposalArgumentProblem', () => {
  /** `{"a":"<n characters>"}`: 8 bytes of JSON around the string. */
  const sized = (bytes: number, unit = 'x', unitBytes = 1): JsonObject => ({
    a: unit.repeat((bytes - 8) / unitBytes),
  });

  it('takes 16,384 bytes of canonical JSON and refuses one more', () => {
    expect(canonicalJson(sized(16_384))).toHaveLength(16_384);
    expect(proposalArgumentProblem(sized(16_384))).toBeNull();
    expect(proposalArgumentProblem(sized(16_385))).toBe('bytes');
  });

  it('counts UTF-8 bytes, not characters', () => {
    // é is two bytes and one character; 😀 four bytes and two characters.
    expect(proposalArgumentProblem(sized(16_384, 'é', 2))).toBeNull();
    expect(proposalArgumentProblem({ a: 'é'.repeat(8_189) })).toBe('bytes');
    expect(proposalArgumentProblem(sized(16_384, '😀', 4))).toBeNull();
    expect(proposalArgumentProblem({ a: '😀'.repeat(4_095) })).toBe('bytes');
    // JSON writes a lone surrogate as a six-character escape, and that is what is counted.
    expect(canonicalJson({ a: '\uD800' })).toBe('{"a":"\\ud800"}');
    expect(proposalArgumentProblem({ a: `${'x'.repeat(16_370)}\uD800` })).toBeNull();
    expect(proposalArgumentProblem({ a: `${'x'.repeat(16_371)}\uD800` })).toBe('bytes');
  });

  it('takes 1,000 values and keys and refuses one more', () => {
    // The object, its one key and the array are three; the items make up the rest.
    const items = (count: number): JsonObject => ({ a: new Array<number>(count).fill(0) });
    expect(proposalArgumentProblem(items(997))).toBeNull();
    expect(proposalArgumentProblem(items(998))).toBe('nodes');
    // Each key counts beside its value.
    const keys = (count: number): JsonObject =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${String(i)}`, 0]));
    expect(proposalArgumentProblem(keys(499))).toBeNull();
    expect(proposalArgumentProblem(keys(500))).toBe('nodes');
    expect(proposalArgumentProblem({})).toBeNull();
  });

  it('stops counting at the cap, so a deep or wide value costs no more than that', () => {
    let deep: unknown = 0;
    for (let i = 0; i < 100_000; i += 1) deep = [deep];
    expect(proposalArgumentProblem({ a: deep })).toBe('nodes');
    expect(proposalArgumentProblem({ a: new Array<number>(1_000_000).fill(1) })).toBe('nodes');
  });

  it('refuses as too large what JSON cannot write', () => {
    expect(proposalArgumentProblem({ big: 1n })).toBe('bytes');
  });
});

import * as z from 'zod/mini';
import { describe, expect, it } from 'vitest';
import {
  encodeFrame,
  InvokeFrameSchema,
  MAX_FRAME_BYTES,
  PAGE_FRAME_TYPES,
  PageStateResultSchema,
  PairingCodeSchema,
  PairingSchema,
  parsePageFrame,
  parseRelayFrame,
  PolicySchema,
  RELAY_FRAME_TYPES,
  WelcomeFrameSchema,
} from './index.ts';

const hello = {
  t: 'hello',
  v: 1,
  title: 'Demo',
  url: 'http://127.0.0.1:5173/',
  adapterVersion: '0.0.0',
  policy: {},
};

describe('parsePageFrame', () => {
  it('accepts a hello and fills in policy defaults', () => {
    const parsed = parsePageFrame(JSON.stringify(hello));
    expect(parsed).toMatchObject({
      kind: 'ok',
      frame: {
        t: 'hello',
        policy: {
          autoApprove: 'none',
          maxDrivers: 1,
          consequential: 'confirm',
          consequentialTools: [],
        },
      },
    });
  });

  it('ignores unknown types instead of failing (SPEC section 6)', () => {
    expect(parsePageFrame('{"t":"future_thing","x":1}')).toEqual({
      kind: 'unknown',
      type: 'future_thing',
    });
  });

  it('rejects malformed frames of a known type, without echoing values', () => {
    const parsed = parsePageFrame(
      JSON.stringify({ ...hello, v: 2, resumeToken: 'secret-token-value' }),
    );
    expect(parsed.kind).toBe('invalid');
    expect(JSON.stringify(parsed)).not.toContain('secret-token-value');
  });

  it('rejects non-JSON, non-objects and missing types', () => {
    expect(parsePageFrame('nope').kind).toBe('invalid');
    expect(parsePageFrame('[1]').kind).toBe('invalid');
    expect(parsePageFrame('{"x":1}').kind).toBe('invalid');
  });

  it('requires content on ok results and an error on failed ones', () => {
    expect(parsePageFrame('{"t":"result","callId":"c1","ok":true,"content":"{}"}').kind).toBe('ok');
    expect(parsePageFrame('{"t":"result","callId":"c1","ok":true}').kind).toBe('invalid');
    expect(
      parsePageFrame(
        '{"t":"result","callId":"c1","ok":false,"error":{"code":"tool_error","message":"boom"}}',
      ).kind,
    ).toBe('ok');
    expect(parsePageFrame('{"t":"result","callId":"c1","ok":false}').kind).toBe('invalid');
  });

  it('enforces the WebMCP tool name rule and drops unknown annotation keys', () => {
    const bad = { t: 'tools', tools: [{ name: 'has space', description: 'd', inputSchema: {} }] };
    expect(parsePageFrame(JSON.stringify(bad)).kind).toBe('invalid');
    const good = {
      t: 'tools',
      tools: [
        {
          name: 'a.b-c_d',
          description: 'd',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true, madeUpHint: true },
        },
      ],
    };
    const parsed = parsePageFrame(JSON.stringify(good));
    expect(parsed).toMatchObject({ kind: 'ok' });
    if (parsed.kind === 'ok' && parsed.frame.t === 'tools') {
      expect(parsed.frame.tools[0]?.annotations).toEqual({ readOnlyHint: true });
    }
  });

  it('accepts revoke for one user or everyone', () => {
    expect(parsePageFrame('{"t":"revoke","userId":"*"}').kind).toBe('ok');
    expect(parsePageFrame('{"t":"revoke","userId":"alice"}').kind).toBe('ok');
    expect(parsePageFrame('{"t":"revoke","userId":"a b"}').kind).toBe('invalid');
  });
});

describe('parseRelayFrame', () => {
  it('round-trips an invoke frame', () => {
    const invoke = {
      t: 'invoke' as const,
      callId: 'c1',
      tool: 'get_view',
      arguments: {},
      caller: { userId: 'alice', displayName: 'Alice', client: null, role: 'driver' as const },
      deadlineMs: 45_000,
    };
    expect(parseRelayFrame(encodeFrame(invoke))).toEqual({ kind: 'ok', frame: invoke });
  });

  it('does not accept page-only frames from the relay', () => {
    expect(parseRelayFrame(JSON.stringify(hello)).kind).toBe('unknown');
  });
});

describe('PolicySchema', () => {
  it('bounds maxDrivers', () => {
    expect(PolicySchema.safeParse({ maxDrivers: 0 }).success).toBe(false);
    expect(PolicySchema.parse({ maxDrivers: 3 }).maxDrivers).toBe(3);
  });
});

// M6 (ADRs 0039 to 0044): new frames and fields, all parsed by the existing
// unions, all optional or defaulted so a peer from 0.1.0 still parses.

/** A welcome exactly as a 0.1.0 relay sends it: limits without any M6 field. */
const welcome010 = {
  t: 'welcome',
  pageId: 'pg_0123456789',
  resumeToken: 'rt_secret_value',
  resumed: false,
  pairing: { code: 'ABCD-1234', expiresAt: 1 },
  roster: [],
  limits: {
    maxFrameBytes: 1_048_576,
    maxResultChars: 120_000,
    maxDescriptionChars: 1000,
    pingIntervalMs: 15_000,
    idleTimeoutMs: 30_000,
    resumeWindowMs: 600_000,
    attachRequestTtlMs: 60_000,
  },
};

const caller = { userId: 'alice', displayName: 'Alice', client: null, role: 'observer' as const };

const invoke = {
  t: 'invoke' as const,
  callId: 'c1',
  tool: 'add_item',
  arguments: { label: 'x' },
  caller: { ...caller, role: 'driver' as const },
  deadlineMs: 45_000,
};

const ok = { t: 'result', callId: 'c1', ok: true, content: 'Board view' };
const image = { mimeType: 'image/png', data: 'iVBORw0KGgo=' };

describe('the M6 frames', () => {
  it('are in both type lists, so neither side reads one as unknown', () => {
    for (const type of [
      'state',
      'proposal_decision',
      'session_start',
      'session_extend',
      'session_end',
      'agent_create',
      'agent_cancel',
    ]) {
      expect(PAGE_FRAME_TYPES, type).toContain(type);
    }
    for (const type of ['proposal', 'proposal_end', 'session', 'agents']) {
      expect(RELAY_FRAME_TYPES, type).toContain(type);
    }
    expect(new Set(PAGE_FRAME_TYPES).size).toBe(PAGE_FRAME_TYPES.length);
    expect(new Set(RELAY_FRAME_TYPES).size).toBe(RELAY_FRAME_TYPES.length);
    // A type neither side knows is still ignored, never refused (SPEC section 6).
    expect(parsePageFrame('{"t":"proposal_vote","x":1}').kind).toBe('unknown');
    expect(parseRelayFrame('{"t":"proposal_vote","x":1}').kind).toBe('unknown');
  });

  it('leave a 0.1.0 welcome parsing, with no limit an M6 relay adds', () => {
    const parsed = parseRelayFrame(JSON.stringify(welcome010));
    expect(parsed).toEqual({ kind: 'ok', frame: welcome010 });
    const m6 = {
      ...welcome010,
      limits: {
        ...welcome010.limits,
        maxImageBytes: 65_536,
        maxStateBytes: 16_384,
        usersPerPage: 10,
        observersPerPage: 40,
      },
    };
    expect(parseRelayFrame(JSON.stringify(m6))).toEqual({ kind: 'ok', frame: m6 });
    // 0 says the relay takes no images; nothing above is capped, since the adapter clamps.
    const none = { ...m6, limits: { ...m6.limits, maxImageBytes: 0, observersPerPage: 0 } };
    expect(parseRelayFrame(JSON.stringify(none)).kind).toBe('ok');
    const huge = { ...m6, limits: { ...m6.limits, maxImageBytes: 2 ** 31 } };
    expect(parseRelayFrame(JSON.stringify(huge)).kind).toBe('ok');
    for (const bad of [
      { maxImageBytes: -1 },
      { maxImageBytes: 1.5 },
      { maxStateBytes: 0 },
      { usersPerPage: 0 },
      { observersPerPage: -1 },
    ]) {
      const frame = { ...welcome010, limits: { ...welcome010.limits, ...bad } };
      expect(WelcomeFrameSchema.safeParse(frame).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('image results (ADR 0039)', () => {
  it('carry an image only beside ok', () => {
    expect(parsePageFrame(JSON.stringify({ ...ok, image })).kind).toBe('ok');
    const failed = {
      t: 'result',
      callId: 'c1',
      ok: false,
      error: { code: 'tool_error', message: 'boom' },
      image,
    };
    expect(parsePageFrame(JSON.stringify(failed))).toEqual({
      kind: 'invalid',
      reason: 'bad result frame: (root): only an ok result carries an image',
    });
  });

  it('take image data up to the frame cap, structurally only', () => {
    const svg = { ...ok, image: { mimeType: 'image/svg+xml', data: '<svg/>' } };
    expect(parsePageFrame(JSON.stringify(svg)).kind).toBe('ok');
    const over = { ...ok, image: { ...image, data: 'A'.repeat(MAX_FRAME_BYTES + 1) } };
    expect(parsePageFrame(JSON.stringify(over)).kind).toBe('invalid');
  });

  it('refuse an image holding other fields without naming them', () => {
    const extra = { ...ok, image: { ...image, secretmarker: 'x' } };
    const parsed = parsePageFrame(JSON.stringify(extra));
    expect(parsed.kind).toBe('invalid');
    expect(JSON.stringify(parsed)).not.toContain('secretmarker');
  });

  it('default imageTools to none and cap it at 128 names', () => {
    expect(PolicySchema.parse({}).imageTools).toEqual([]);
    const names = (count: number): string[] =>
      Array.from({ length: count }, (_, i) => `t${String(i)}`);
    expect(PolicySchema.safeParse({ imageTools: names(128) }).success).toBe(true);
    expect(PolicySchema.safeParse({ imageTools: names(129) }).success).toBe(false);
    expect(PolicySchema.safeParse({ imageTools: ['has space'] }).success).toBe(false);
  });
});

describe('page state (ADR 0040)', () => {
  it('is a JSON object or null, and nothing else', () => {
    expect(parsePageFrame('{"t":"state","value":{"a":1}}').kind).toBe('ok');
    expect(parsePageFrame('{"t":"state","value":null}').kind).toBe('ok');
    for (const value of ['[]', '"x"', '3', 'true']) {
      expect(parsePageFrame(`{"t":"state","value":${value}}`).kind, value).toBe('invalid');
    }
    expect(parsePageFrame('{"t":"state"}').kind).toBe('invalid');
  });

  it('reads back as a result whose version 0 has nothing published', () => {
    const result = {
      page: 'pg_0123456789',
      origin: 'https://app.example',
      version: 3,
      publishedAt: 10,
      heardAt: 12,
      value: { view: { x: 1 } },
      changed: true,
    };
    expect(PageStateResultSchema.parse(result)).toEqual(result);
    const empty = { ...result, version: 0, publishedAt: null, value: null, changed: undefined };
    expect(PageStateResultSchema.safeParse(empty).success).toBe(true);
    expect(PageStateResultSchema.safeParse({ ...empty, value: { a: 1 } }).success).toBe(false);
    expect(PageStateResultSchema.safeParse({ ...empty, publishedAt: 1 }).success).toBe(false);
    expect(PageStateResultSchema.safeParse({ ...result, version: -1 }).success).toBe(false);
    expect(PageStateResultSchema.safeParse({ ...result, origin: '' }).success).toBe(false);
  });
});

describe('proposals (ADR 0042)', () => {
  const proposal = {
    t: 'proposal',
    proposalId: 'pr_1',
    tool: 'add_item',
    arguments: { label: 'x' },
    proposer: caller,
    expiresAt: 600_000,
  };

  it('travel as proposal, proposal_end and proposal_decision frames', () => {
    expect(parseRelayFrame(JSON.stringify(proposal))).toEqual({ kind: 'ok', frame: proposal });
    for (const reason of ['withdrawn', 'expired', 'attachment_ended', 'policy', 'not_run']) {
      const end = { t: 'proposal_end', proposalId: 'pr_1', reason };
      expect(parseRelayFrame(JSON.stringify(end)).kind, reason).toBe('ok');
    }
    expect(
      parseRelayFrame('{"t":"proposal_end","proposalId":"pr_1","reason":"dismissed"}').kind,
    ).toBe('invalid');
    const accept = { t: 'proposal_decision', proposalId: 'pr_1', accept: true };
    const dismiss = { ...accept, accept: false };
    const refuse = { ...dismiss, refused: 'consequential' };
    for (const frame of [accept, dismiss, refuse]) {
      expect(parsePageFrame(JSON.stringify(frame)).kind).toBe('ok');
    }
  });

  it('refuse an accepting decision that also refuses', () => {
    const both = { t: 'proposal_decision', proposalId: 'pr_1', accept: true, refused: 'policy' };
    expect(parsePageFrame(JSON.stringify(both))).toEqual({
      kind: 'invalid',
      reason: 'bad proposal_decision frame: (root): an accepted proposal is not refused',
    });
  });

  it('run through an invoke that names its proposal, never one also confirmed in a client', () => {
    const run = { ...invoke, proposal: { proposalId: 'pr_1' } };
    expect(parseRelayFrame(encodeFrame(run))).toEqual({ kind: 'ok', frame: run });
    const confirmation = { by: 'client', confirmationId: 'cf_1', at: 5 };
    expect(parseRelayFrame(JSON.stringify({ ...run, confirmation }))).toEqual({
      kind: 'invalid',
      reason:
        'bad invoke frame: (root): an invoke is confirmed in a client or accepted as a proposal, never both',
    });
    expect(parseRelayFrame(JSON.stringify({ ...invoke, confirmation })).kind).toBe('ok');
  });

  it('are dropped by an adapter older than M6, which then refuses the call as before', () => {
    // The invoke an M5 adapter knew: today's shape without the proposal key.
    const older = z.omit(z.object(InvokeFrameSchema.shape), { proposal: true });
    expect(older.parse({ ...invoke, proposal: { proposalId: 'pr_1' } })).toEqual(invoke);
  });

  it("default the page's policy to off", () => {
    expect(PolicySchema.parse({}).proposals).toBe('off');
    expect(PolicySchema.safeParse({ proposals: 'everyone' }).success).toBe(false);
  });
});

describe('time-boxed sessions (ADR 0043)', () => {
  const start = {
    t: 'session_start',
    sessionId: 'ss_1',
    lengthMs: 50 * 60_000,
    policy: { maxDrivers: 2, proposals: 'all' },
  };

  it('last whole minutes from 30 to 240', () => {
    for (const minutes of [30, 31, 240]) {
      const frame = { ...start, lengthMs: minutes * 60_000 };
      expect(parsePageFrame(JSON.stringify(frame)).kind, String(minutes)).toBe('ok');
    }
    for (const minutes of [29, 241, 90.5, 0, -30]) {
      const frame = { ...start, lengthMs: minutes * 60_000 };
      expect(parsePageFrame(JSON.stringify(frame)).kind, String(minutes)).toBe('invalid');
    }
    expect(parsePageFrame(JSON.stringify({ ...start, lengthMs: 1_800_001 })).kind).toBe('invalid');
  });

  it('set only seats and proposals, within their ranges', () => {
    for (const policy of [
      { maxDrivers: 0, proposals: 'off' },
      { maxDrivers: 101, proposals: 'off' },
      { maxDrivers: 1, proposals: 'some' },
      { maxDrivers: 1 },
      { maxDrivers: 1, proposals: 'off', consequential: 'allow' },
    ]) {
      const frame = { ...start, policy };
      expect(parsePageFrame(JSON.stringify(frame)).kind, JSON.stringify(policy)).toBe('invalid');
    }
    const strict = parsePageFrame(
      JSON.stringify({ ...start, policy: { ...start.policy, secretmarker: 1 } }),
    );
    expect(JSON.stringify(strict)).not.toContain('secretmarker');
  });

  it('extend by a new total and end by id', () => {
    const extend = { t: 'session_extend', sessionId: 'ss_1', lengthMs: 65 * 60_000 };
    expect(parsePageFrame(JSON.stringify(extend)).kind).toBe('ok');
    expect(parsePageFrame('{"t":"session_end","sessionId":"ss_1"}').kind).toBe('ok');
    expect(parsePageFrame('{"t":"session_end"}').kind).toBe('invalid');
  });

  it('come back in a session frame with what remains, how one ended or why one was refused', () => {
    const session = {
      t: 'session',
      session: {
        sessionId: 'ss_1',
        lengthMs: 3_000_000,
        remainingMs: 120_000,
        policy: start.policy,
      },
    };
    expect(parseRelayFrame(JSON.stringify(session)).kind).toBe('ok');
    const ended = { t: 'session', session: null, ended: { sessionId: 'ss_1', reason: 'operator' } };
    expect(parseRelayFrame(JSON.stringify(ended)).kind).toBe('ok');
    const refused = {
      t: 'session',
      session: null,
      refused: { sessionId: 'ss_2', reason: 'active' },
    };
    expect(parseRelayFrame(JSON.stringify(refused)).kind).toBe('ok');
    for (const bad of [
      { ...session, session: { ...session.session, remainingMs: -1 } },
      { ...session, session: { ...session.session, remainingMs: 14_400_001 } },
      { ...ended, ended: { sessionId: 'ss_1', reason: 'ended' } },
      { ...refused, refused: { sessionId: 'ss_2', reason: 'busy' } },
    ]) {
      expect(parseRelayFrame(JSON.stringify(bad)).kind, JSON.stringify(bad)).toBe('invalid');
    }
  });
});

describe('the pairing code (ADR 0041)', () => {
  it('has its own schema, which the pairing uses unchanged', () => {
    expect(PairingCodeSchema.safeParse('ABCD-1234').success).toBe(true);
    expect(PairingCodeSchema.safeParse('').success).toBe(false);
    expect(PairingCodeSchema.safeParse('x'.repeat(33)).success).toBe(false);
    expect(PairingSchema.shape.code).toBe(PairingCodeSchema);
  });
});

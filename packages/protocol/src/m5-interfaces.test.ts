// M5's protocol before workstreams A and B build on it (docs/plans/M5.md,
// step 1): the schemas on zod/mini with English messages (ADR 0028), ADR
// 0026's additive fields for confirmation in the caller's client, and ADR
// 0025's first-class numbers. Every addition is optional, so a frame from a
// peer older than M5 parses as it did, and such a peer drops what it does not
// know and keeps its old behaviour.

import * as z from 'zod/mini';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuditEventSchema,
  AuditLineSchema,
  AuditOutcomeSchema,
  ConfirmationSchema,
  encodeFrame,
  ERROR_CODES,
  FIRST_CLASS_LIST_TTL_MS,
  FIRST_CLASS_NOTIFY_INTERVAL_MS,
  HelloFrameSchema,
  IdSchema,
  InvokeFrameSchema,
  isErrorCode,
  MAX_CONFIRMATION_FRAME_BYTES,
  MAX_FIRST_CLASS_CHARS_PER_USER,
  MAX_FIRST_CLASS_DESCRIPTION_CHARS,
  MAX_FIRST_CLASS_NAME_CHARS,
  MAX_FIRST_CLASS_ORIGIN_CHARS,
  MAX_FIRST_CLASS_TITLE_CHARS,
  MAX_FIRST_CLASS_TOOLS_PER_USER,
  PageToolSchema,
  parsePageFrame,
  parseRelayFrame,
  PolicySchema,
  ToolsFrameSchema,
} from './index.ts';
import * as exported from './index.ts';

const hello = {
  t: 'hello',
  v: 1,
  title: 'Demo',
  url: 'http://127.0.0.1:5173/',
  adapterVersion: '0.0.0',
  policy: {},
};

const tool = { name: 'add_item', description: 'Adds an item', inputSchema: { type: 'object' } };

const invoke = {
  t: 'invoke' as const,
  callId: 'c1',
  tool: 'add_item',
  arguments: { label: 'x' },
  caller: { userId: 'alice', displayName: 'Alice', client: null, role: 'driver' as const },
  deadlineMs: 45_000,
};

const confirmation = {
  by: 'client' as const,
  confirmationId: 'cf_0123456789',
  at: 1_759_600_000_000,
};

const call = {
  v: 1,
  type: 'call',
  at: 1,
  pageId: 'pg_0123456789',
  origin: 'https://app.example',
  userId: 'alice',
  client: { name: 'claude-code', version: '2.1.289' },
  tool: 'add_item',
  outcome: 'ok',
  durationMs: 12,
} as const;

describe('the protocol on zod/mini (ADR 0028)', () => {
  it('exports only zod/mini schemas, which carry no classic methods', () => {
    const values: Record<string, unknown> = exported;
    const schemas = Object.entries(values).filter(
      (entry): entry is [string, object] =>
        typeof entry[1] === 'object' && entry[1] !== null && 'safeParse' in entry[1],
    );
    expect(schemas.length).toBeGreaterThan(50);
    for (const [name, schema] of schemas) {
      expect('optional' in schema, name).toBe(false);
      expect('refine' in schema, name).toBe(false);
    }
  });

  it('reports problems in English, as classic zod did', () => {
    expect(parsePageFrame(JSON.stringify({ ...hello, v: 2 }))).toEqual({
      kind: 'invalid',
      reason: 'bad hello frame: v: Invalid input: expected 1',
    });
    expect(IdSchema.safeParse(7).error?.issues[0]?.message).toBe(
      'Invalid input: expected string, received number',
    );
    expect(PolicySchema.safeParse({ maxDrivers: 0 }).error?.issues[0]?.message).toBe(
      'Too small: expected number to be >=1',
    );
  });

  describe('the locale', () => {
    const config = z.config();
    const english = config.localeError;
    afterEach(() => {
      z.config({ localeError: english });
      vi.resetModules();
    });

    it('is set to English where none is set', async () => {
      z.config({ localeError: undefined });
      vi.resetModules();
      await import('./zod-config.ts');
      expect(z.config().localeError).toBeTypeOf('function');
      expect(z.string().safeParse(1).error?.issues[0]?.message).toBe(
        'Invalid input: expected string, received number',
      );
    });

    it('is left alone where a page chose its own', async () => {
      const chosen = (): string => 'Ungültige Eingabe';
      z.config({ localeError: chosen });
      vi.resetModules();
      await import('./zod-config.ts');
      expect(z.config().localeError).toBe(chosen);
      expect(z.string().safeParse(1).error?.issues[0]?.message).toBe('Ungültige Eingabe');
    });

    it('keeps jitless on either way', async () => {
      z.config({ jitless: false });
      vi.resetModules();
      await import('./zod-config.ts');
      expect(z.config().jitless).toBe(true);
    });
  });
});

describe('policy.confirmVia (ADR 0026)', () => {
  it("defaults to 'page', so a hello from an adapter older than M5 means what it meant", () => {
    const parsed = parsePageFrame(JSON.stringify(hello));
    expect(parsed).toMatchObject({ kind: 'ok', frame: { policy: { confirmVia: 'page' } } });
    expect(PolicySchema.parse({}).confirmVia).toBe('page');
  });

  it("takes 'page' or 'client' and nothing else", () => {
    expect(PolicySchema.parse({ confirmVia: 'client' }).confirmVia).toBe('client');
    expect(PolicySchema.parse({ confirmVia: 'page' }).confirmVia).toBe('page');
    for (const confirmVia of ['Client', 'both', '', null, true, 1]) {
      expect(PolicySchema.safeParse({ confirmVia }).success, String(confirmVia)).toBe(false);
    }
  });

  it('is dropped by a relay older than M5, which then never asks a client', () => {
    const olderPolicy = z.omit(PolicySchema, { confirmVia: true });
    const older = z.extend(z.omit(HelloFrameSchema, { policy: true }), { policy: olderPolicy });
    const parsed = older.parse({ ...hello, policy: { confirmVia: 'client' } });
    expect(parsed.policy).not.toHaveProperty('confirmVia');
  });
});

describe("the tools frame's consequential mark (ADR 0026)", () => {
  it('is optional: a tool an older adapter lists parses without it', () => {
    const parsed = parsePageFrame(JSON.stringify({ t: 'tools', tools: [tool] }));
    expect(parsed.kind).toBe('ok');
    if (parsed.kind === 'ok' && parsed.frame.t === 'tools') {
      expect(parsed.frame.tools[0]).not.toHaveProperty('consequential');
    }
  });

  it('is a boolean when present', () => {
    expect(PageToolSchema.parse({ ...tool, consequential: true }).consequential).toBe(true);
    expect(PageToolSchema.parse({ ...tool, consequential: false }).consequential).toBe(false);
    for (const consequential of ['true', 1, null]) {
      const frame = { t: 'tools', tools: [{ ...tool, consequential }] };
      expect(ToolsFrameSchema.safeParse(frame).success, String(consequential)).toBe(false);
    }
  });

  it('is dropped by a relay older than M5, which then never asks a client', () => {
    const older = z.omit(PageToolSchema, { consequential: true });
    expect(older.parse({ ...tool, consequential: true })).not.toHaveProperty('consequential');
  });
});

describe("the invoke frame's confirmation (ADR 0026)", () => {
  it('is optional: an invoke without it round-trips as before', () => {
    expect(parseRelayFrame(encodeFrame(invoke))).toEqual({ kind: 'ok', frame: invoke });
  });

  it('round-trips by client, with a relay id and the time the answer arrived', () => {
    const frame = { ...invoke, confirmation };
    expect(parseRelayFrame(encodeFrame(frame))).toEqual({ kind: 'ok', frame });
  });

  it.each<[string, unknown]>([
    ['another confirmer', { ...confirmation, by: 'page' }],
    ['no confirmer', { confirmationId: 'cf_1', at: 1 }],
    ['no id', { by: 'client', at: 1 }],
    ['an id too long', { ...confirmation, confirmationId: 'x'.repeat(65) }],
    ['an empty id', { ...confirmation, confirmationId: '' }],
    ['an id with other characters', { ...confirmation, confirmationId: 'cf 1' }],
    ['no time', { by: 'client', confirmationId: 'cf_1' }],
    ['a negative time', { ...confirmation, at: -1 }],
    ['a fractional time', { ...confirmation, at: 1.5 }],
    ['a time as text', { ...confirmation, at: '1' }],
    ['a bare true', true],
    ['null', null],
  ])('refuses %s', (_name, value) => {
    const parsed = parseRelayFrame(JSON.stringify({ ...invoke, confirmation: value }));
    expect(parsed.kind).toBe('invalid');
  });

  it('drops keys it does not know, as every frame object does', () => {
    expect(ConfirmationSchema.parse({ ...confirmation, record: 'r_1' })).toEqual(confirmation);
  });

  it('adds at most MAX_CONFIRMATION_FRAME_BYTES to an encoded invoke, the room the relay keeps for it (ADR 0032)', () => {
    // Every character here is ASCII, so each is one byte on the wire.
    const bytes = (text: string): number => text.length;
    // The longest id, whose characters JSON never escapes, and the most digits a time may have.
    const longest = {
      by: 'client' as const,
      confirmationId: 'x'.repeat(64),
      at: Number.MAX_SAFE_INTEGER,
    };
    expect(ConfirmationSchema.safeParse(longest).success).toBe(true);
    expect(
      bytes(encodeFrame({ ...invoke, confirmation: longest })) - bytes(encodeFrame(invoke)),
    ).toBe(MAX_CONFIRMATION_FRAME_BYTES);
    for (const longer of [
      { ...longest, confirmationId: 'x'.repeat(65) },
      { ...longest, confirmationId: `${'x'.repeat(63)}"` },
      { ...longest, at: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(ConfirmationSchema.safeParse(longer).success).toBe(false);
    }
  });

  it('is dropped by an adapter older than M5, which then prompts as it always has', () => {
    const older = z.omit(InvokeFrameSchema, { confirmation: true });
    expect(older.parse({ ...invoke, confirmation })).toEqual(invoke);
  });
});

describe('not_confirmed and confirmedBy (ADR 0026)', () => {
  it('adds not_confirmed to the error codes and the audit outcomes', () => {
    expect(ERROR_CODES).toContain('not_confirmed');
    expect(isErrorCode('not_confirmed')).toBe(true);
    expect(AuditOutcomeSchema.parse('not_confirmed')).toBe('not_confirmed');
  });

  it('records a call confirmed in its client, within audit format version 1', () => {
    const confirmed = { ...call, confirmedBy: 'client' };
    expect(AuditEventSchema.parse(confirmed)).toEqual(confirmed);
    const line = { ...confirmed, seq: 4, prev: 'a'.repeat(64) };
    expect(AuditLineSchema.parse(line)).toEqual(line);
    const refused = { ...call, outcome: 'not_confirmed' };
    expect(AuditEventSchema.parse(refused)).toEqual(refused);
  });

  it('refuses a call refused for its confirmation that credits a client with it, as event and as line (ADR 0032)', () => {
    const contradictory = { ...call, outcome: 'not_confirmed', confirmedBy: 'client' };
    const event = AuditEventSchema.safeParse(contradictory);
    expect(event.success).toBe(false);
    expect(event.error?.issues[0]?.message).toBe(
      'a call refused for its confirmation went out unconfirmed, so no client confirmed it',
    );
    expect(
      AuditLineSchema.safeParse({ ...contradictory, seq: 4, prev: 'a'.repeat(64) }).success,
    ).toBe(false);
    // Every other outcome may carry it, a confirmed call that then timed out among them.
    expect(
      AuditEventSchema.safeParse({ ...call, outcome: 'timeout', confirmedBy: 'client' }).success,
    ).toBe(true);
  });

  it('keeps a call line without it as it was, and refuses any other confirmer', () => {
    expect(AuditEventSchema.parse(call)).toEqual(call);
    for (const confirmedBy of ['page', 'operator', true, null]) {
      expect(AuditEventSchema.safeParse({ ...call, confirmedBy }).success).toBe(false);
    }
  });

  it('stays on call records alone, since every record type is strict', () => {
    const detach = {
      v: 1,
      type: 'detach',
      at: 1,
      pageId: 'pg_0123456789',
      origin: 'https://app.example',
      userId: 'alice',
    };
    expect(AuditEventSchema.safeParse(detach).success).toBe(true);
    expect(AuditEventSchema.safeParse({ ...detach, confirmedBy: 'client' }).success).toBe(false);
  });
});

describe("ADR 0025's first-class numbers", () => {
  // Literal values, so a change to a security bound fails here rather than slipping through.
  it('match SPEC section 7 and S9', () => {
    expect(MAX_FIRST_CLASS_NAME_CHARS).toBe(64);
    expect(MAX_FIRST_CLASS_TOOLS_PER_USER).toBe(64);
    expect(MAX_FIRST_CLASS_CHARS_PER_USER).toBe(100_000);
    expect(MAX_FIRST_CLASS_DESCRIPTION_CHARS).toBe(500);
    expect(MAX_FIRST_CLASS_TITLE_CHARS).toBe(120);
    expect(MAX_FIRST_CLASS_ORIGIN_CHARS).toBe(100);
    expect(FIRST_CLASS_LIST_TTL_MS).toBe(10_000);
    expect(FIRST_CLASS_NOTIFY_INTERVAL_MS).toBe(10_000);
    // A client that lists again on each change lists no more often than the list's cache allows.
    expect(FIRST_CLASS_NOTIFY_INTERVAL_MS).toBeGreaterThanOrEqual(FIRST_CLASS_LIST_TTL_MS);
  });
});

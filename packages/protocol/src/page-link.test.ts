import { describe, expect, it } from 'vitest';
import { encodeFrame, parsePageFrame, parseRelayFrame, PolicySchema } from './index.ts';

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

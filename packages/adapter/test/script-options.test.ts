import { describe, expect, it } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };
import { readScriptOptions } from '../src/script-options.ts';
import { ADAPTER_VERSION } from '../src/version.ts';

describe('readScriptOptions', () => {
  it('requires data-relay', () => {
    expect(readScriptOptions({})).toMatchObject({ ok: false, error: /data-relay/ });
    expect(readScriptOptions({ relay: '  ' })).toMatchObject({ ok: false });
  });

  it('reads every policy attribute', () => {
    expect(
      readScriptOptions({
        relay: ' wss://relay.example/page ',
        autoApprove: 'observer',
        maxDrivers: '2',
        consequential: 'deny',
        consequentialTools: 'clear_board, wipe,,',
        invites: ' all ',
        confirmVia: ' client ',
      }),
    ).toEqual({
      ok: true,
      relay: 'wss://relay.example/page',
      policy: {
        autoApprove: 'observer',
        maxDrivers: 2,
        consequential: 'deny',
        consequentialTools: ['clear_board', 'wipe'],
        invites: 'all',
        confirmVia: 'client',
      },
    });
  });

  it('reads data-confirm-via as page or client, and leaves it out when absent (ADR 0026)', () => {
    const relay = 'ws://127.0.0.1:8787/page';
    for (const confirmVia of ['page', 'client'] as const) {
      expect(readScriptOptions({ relay, confirmVia })).toEqual({
        ok: true,
        relay,
        policy: { confirmVia },
      });
    }
    // Absent, attach() fills in 'page': the operator confirms, as before M5.
    expect(readScriptOptions({ relay })).toMatchObject({ ok: true, policy: {} });
    for (const confirmVia of ['Client', 'both', '', 'operator']) {
      expect(readScriptOptions({ relay, confirmVia })).toEqual({
        ok: false,
        error: 'invalid data attributes for confirmVia',
      });
    }
  });

  it('leaves absent attributes out, and reads a tool list that names no tool as an empty one', () => {
    const relay = 'ws://127.0.0.1:8787/page';
    expect(readScriptOptions({ relay })).toEqual({ ok: true, relay, policy: {} });
    // An empty list names none, so like an absent one it leaves ADR 0002's
    // fallback on; core.test.ts runs these through attach() (ADR 0034).
    for (const consequentialTools of ['', ' ', ' , ', ',,']) {
      expect(readScriptOptions({ relay, consequentialTools })).toEqual({
        ok: true,
        relay,
        policy: { consequentialTools: [] },
      });
    }
  });

  it('names the bad attribute without echoing its value', () => {
    for (const data of [
      { maxDrivers: 'two' },
      { maxDrivers: '' },
      { consequential: 'sometimes' },
      { consequentialTools: 'has space' },
      { invites: 'everyone' },
      { confirmVia: 'whoever' },
    ]) {
      const result = readScriptOptions({ relay: 'ws://127.0.0.1:8787/page', ...data });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        for (const value of Object.values(data)) {
          if (value) expect(result.error).not.toContain(value);
        }
      }
    }
  });
});

describe('ADAPTER_VERSION', () => {
  it('matches package.json', () => {
    expect(ADAPTER_VERSION).toBe(packageJson.version);
  });
});

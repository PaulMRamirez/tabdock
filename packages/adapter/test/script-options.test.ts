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
      }),
    ).toEqual({
      ok: true,
      relay: 'wss://relay.example/page',
      policy: {
        autoApprove: 'observer',
        maxDrivers: 2,
        consequential: 'deny',
        consequentialTools: ['clear_board', 'wipe'],
      },
    });
  });

  it('leaves absent attributes out, so "no list given" stays distinguishable (ADR 0002)', () => {
    expect(readScriptOptions({ relay: 'ws://127.0.0.1:8787/page' })).toEqual({
      ok: true,
      relay: 'ws://127.0.0.1:8787/page',
      policy: {},
    });
    expect(
      readScriptOptions({ relay: 'ws://127.0.0.1:8787/page', consequentialTools: '' }),
    ).toMatchObject({ ok: true, policy: { consequentialTools: [] } });
  });

  it('names the bad attribute without echoing its value', () => {
    for (const data of [
      { maxDrivers: 'two' },
      { maxDrivers: '' },
      { consequential: 'sometimes' },
      { consequentialTools: 'has space' },
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

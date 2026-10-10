import { MAX_TOOLS_PER_PAGE } from '@tabdock/protocol';
import { describe, expect, it } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };
import { readScriptOptions } from '../src/script-options.ts';
import { ADAPTER_VERSION } from '../src/version.ts';

describe('readScriptOptions', () => {
  it('requires data-relay', () => {
    expect(readScriptOptions({})).toMatchObject({ ok: false, error: /data-relay/ });
    expect(readScriptOptions({ relay: '  ' })).toMatchObject({ ok: false });
  });

  it('refuses a data-relay that is not a ws: or wss: URL, without repeating it', () => {
    const refused = {
      ok: false,
      error: 'data-relay must be a ws: or wss: URL, for example ws://127.0.0.1:8787/page',
    };
    for (const relay of [
      'http://127.0.0.1:8787/page',
      'https://relay.example/page?token=SeCrEt9',
      'relay.example/page',
      '/page',
      'ws//127.0.0.1:8787/page',
    ]) {
      const read = readScriptOptions({ relay });
      expect(read, relay).toEqual(refused);
      expect(JSON.stringify(read)).not.toContain('SeCrEt9');
    }
    expect(readScriptOptions({ relay: 'WSS://Relay.Example/page' })).toMatchObject({ ok: true });
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
        imageTools: ' capture_board ,, snapshot ',
        proposals: ' members ',
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
        imageTools: ['capture_board', 'snapshot'],
        proposals: 'members',
      },
    });
  });

  it('reads data-image-tools as a list of tool names, and refuses a bad name by its place (ADR 0039)', () => {
    const relay = 'ws://127.0.0.1:8787/page';
    expect(readScriptOptions({ relay, imageTools: 'capture_view' })).toEqual({
      ok: true,
      relay,
      policy: { imageTools: ['capture_view'] },
    });
    // A list that names no tool lets no result carry an image, as an absent one does.
    for (const imageTools of ['', ' ', ' , ', ',,']) {
      expect(readScriptOptions({ relay, imageTools })).toEqual({
        ok: true,
        relay,
        policy: { imageTools: [] },
      });
    }
    expect(readScriptOptions({ relay, imageTools: 'has space' })).toEqual({
      ok: false,
      error: 'invalid data attributes for imageTools.0',
    });
    expect(readScriptOptions({ relay, imageTools: 'capture_view, not/a/tool' })).toEqual({
      ok: false,
      error: 'invalid data attributes for imageTools.1',
    });
    const tooMany = Array.from({ length: MAX_TOOLS_PER_PAGE + 1 }, (_, i) => `t${i}`).join(',');
    expect(readScriptOptions({ relay, imageTools: tooMany })).toEqual({
      ok: false,
      error: 'invalid data attributes for imageTools',
    });
  });

  it('reads data-proposals as off, members or all, and leaves it out when absent (ADR 0042)', () => {
    const relay = 'ws://127.0.0.1:8787/page';
    for (const proposals of ['off', 'members', 'all'] as const) {
      expect(readScriptOptions({ relay, proposals: ` ${proposals} ` })).toEqual({
        ok: true,
        relay,
        policy: { proposals },
      });
    }
    // Absent, attach() fills in 'off': observers' writes are refused, as before M6.
    expect(readScriptOptions({ relay })).toEqual({ ok: true, relay, policy: {} });
    for (const proposals of ['Members', 'everyone', '', 'on']) {
      expect(readScriptOptions({ relay, proposals })).toEqual({
        ok: false,
        error: 'invalid data attributes for proposals',
      });
    }
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
      { imageTools: 'has space' },
      { proposals: 'everyone' },
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

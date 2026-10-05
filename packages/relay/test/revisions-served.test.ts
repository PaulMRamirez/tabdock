// The answer to a revision /mcp does not serve (ADR 0027). 2026-07-28 says a
// server MUST answer an unsupported version with an error listing the
// versions it supports, and the SDK's strict leg names only its own,
// 2026-07-28, though the same endpoint serves the 2025 revisions on a
// session. The relay rewrites that answer's data.supported to every revision
// it serves, 2024-11-05 included, newest first, and changes nothing else,
// on a listen as on any other request; every other answer passes untouched.

import { afterEach, describe, expect, it } from 'vitest';
import { SERVED_REVISIONS } from '../src/relay.ts';
import { ALICE, startRelay, type TestRelay } from './helpers/relay.ts';
import { modernExchange } from './helpers/wire.ts';

let current: TestRelay | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

describe('an unsupported revision on the strict leg', () => {
  it('lists every revision /mcp serves, and changes nothing else', async () => {
    current = await startRelay();
    expect(SERVED_REVISIONS).toEqual([
      '2026-07-28',
      '2025-11-25',
      '2025-06-18',
      '2025-03-26',
      '2024-11-05',
    ]);
    for (const method of ['tools/list', 'server/discover', 'subscriptions/listen']) {
      for (const version of ['2027-01-01', '2025-11-25', 'garbage']) {
        const answer = await modernExchange(current.relay, ALICE, method, {}, { version });
        expect(answer.status, `${method} ${version}`).toBe(400);
        expect(answer.message?.error, `${method} ${version}`).toEqual({
          code: -32022,
          message: `Unsupported protocol version: ${version}`,
          data: { supported: [...SERVED_REVISIONS], requested: version },
        });
      }
    }
  });

  it('leaves every other refusal as the SDK wrote it', async () => {
    current = await startRelay();
    const response = await fetch(current.relay.mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ALICE.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Protocol-Version': '2026-07-28',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: number; data?: unknown } };
    expect(body.error.code).toBe(-32602);
    expect(JSON.stringify(body)).not.toContain('supported');
  });
});

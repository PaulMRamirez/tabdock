// The `mcp client` line (ADR 0027): which MCP revision each client speaks and
// whether it declared form elicitation, the way the owner reads hosted
// Claude's off the reference deployment. One info line per user, client name
// and leg an hour: a 2025-era session's when its initialize completes, with
// the negotiated version; a 2026-07-28 client's with its first request in the
// hour, with the envelope's. It goes through a budget of its own, at most 256
// keys an hour and no summary line, so a client that renames itself on every
// request fills only that budget; and it carries the user id, the client's
// name and version as parseClientInfo caps them, the leg and the revision,
// never a token, a session id or an argument.

import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/index.ts';
import {
  CLIENT_LINE_WINDOW_MS,
  createClientLines,
  declaresFormElicitation,
  MAX_CLIENT_LINE_KEYS,
  MAX_CLIENT_LINE_KEYS_PER_USER,
} from '../src/mcp.ts';
import { ALICE, BOB, startRelay, type TestRelay } from './helpers/relay.ts';
import { legacyExchange, legacyInitialize, modernExchange } from './helpers/wire.ts';

let current: TestRelay | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

function clientLines(lines: string[]): Record<string, unknown>[] {
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.msg === 'mcp client');
}

describe('the mcp client line', () => {
  it("names a 2025-era session's client, leg, negotiated revision and form elicitation once initialize completes", async () => {
    current = await startRelay({ logLevel: 'info' });
    const opened = await legacyInitialize(
      current.relay,
      ALICE,
      { elicitation: { form: {} } },
      'claude-code',
    );
    expect(opened.sessionId).not.toBeNull();
    expect(clientLines(current.lines)).toEqual([
      expect.objectContaining({
        level: 'info',
        userId: 'alice',
        client: 'claude-code',
        clientVersion: '1.0.0',
        leg: 'session',
        revision: '2025-11-25',
        formElicitation: true,
      }),
    ]);
    // The session's later requests, and a second session of the same client, add nothing this hour.
    await legacyExchange(current.relay, ALICE, opened.sessionId ?? '', 'tools/list');
    await legacyInitialize(current.relay, ALICE, {}, 'claude-code');
    expect(clientLines(current.lines)).toHaveLength(1);
    // Another client, or another user, is a line of its own.
    await legacyInitialize(current.relay, ALICE, { elicitation: { url: {} } }, 'inspector');
    await legacyInitialize(current.relay, BOB, {}, 'claude-code');
    expect(
      clientLines(current.lines).map((line) => [line.userId, line.client, line.formElicitation]),
    ).toEqual([
      ['alice', 'claude-code', true],
      ['alice', 'inspector', false],
      ['bob', 'claude-code', false],
    ]);
  });

  it('names a 2026-07-28 client with its first request in the hour, from its envelope', async () => {
    current = await startRelay({ logLevel: 'info' });
    await modernExchange(
      current.relay,
      ALICE,
      'server/discover',
      {},
      {
        client: 'claude-code',
        capabilities: { elicitation: {} },
      },
    );
    await modernExchange(current.relay, ALICE, 'tools/list', {}, { client: 'claude-code' });
    await modernExchange(
      current.relay,
      ALICE,
      'tools/call',
      { name: 'list_pages', arguments: {} },
      {
        client: 'claude-code',
      },
    );
    expect(clientLines(current.lines)).toEqual([
      expect.objectContaining({
        userId: 'alice',
        client: 'claude-code',
        clientVersion: '1.0.0',
        leg: 'strict',
        revision: '2026-07-28',
        formElicitation: true,
      }),
    ]);
    // The same name on the session leg is another key.
    await legacyInitialize(current.relay, ALICE, {}, 'claude-code');
    expect(clientLines(current.lines).map((line) => line.leg)).toEqual(['strict', 'session']);
  });

  it('is written only for a request that paid, and one account renaming its client cannot hide another user', async () => {
    current = await startRelay({ logLevel: 'info', rateLimits: { requestsPerUser: 3 } });
    const statuses: number[] = [];
    for (let index = 0; index < 40; index += 1) {
      const answer = await modernExchange(
        current.relay,
        ALICE,
        'tools/list',
        {},
        { client: `renamed-${String(index)}` },
      );
      statuses.push(answer.status);
    }
    expect(statuses.filter((status) => status === 200)).toHaveLength(3);
    expect(statuses.filter((status) => status === 429)).toHaveLength(37);
    // The three that paid named their clients; the 37 refused past the budget wrote nothing.
    expect(clientLines(current.lines).map((line) => line.client)).toEqual([
      'renamed-0',
      'renamed-1',
      'renamed-2',
    ]);
    const bob = await modernExchange(current.relay, BOB, 'tools/list', {}, { client: 'claude-ai' });
    expect(bob.status).toBe(200);
    expect(clientLines(current.lines).at(-1)).toMatchObject({ userId: 'bob', client: 'claude-ai' });
  });

  it(`writes at most ${String(MAX_CLIENT_LINE_KEYS_PER_USER)} lines an hour for one account, on both legs together`, async () => {
    current = await startRelay({ logLevel: 'info' });
    for (let index = 0; index < 12; index += 1) {
      const answer = await modernExchange(
        current.relay,
        ALICE,
        'tools/list',
        {},
        { client: `renamed-${String(index)}` },
      );
      expect(answer.status).toBe(200);
    }
    // A 2025-era session's initialize is not budgeted, so only the share bounds it.
    for (let index = 0; index < 4; index += 1) {
      await legacyInitialize(current.relay, ALICE, {}, `session-${String(index)}`);
    }
    expect(clientLines(current.lines).filter((line) => line.userId === 'alice')).toHaveLength(
      MAX_CLIENT_LINE_KEYS_PER_USER,
    );
    await legacyInitialize(current.relay, BOB, {}, 'claude-ai');
    expect(clientLines(current.lines).at(-1)).toMatchObject({ userId: 'bob', leg: 'session' });
  });

  it('carries no token, session id or argument', async () => {
    current = await startRelay({ logLevel: 'info' });
    const opened = await legacyInitialize(current.relay, ALICE, {}, 'claude-code');
    const secret = 'argument-value-6f1c';
    await modernExchange(current.relay, ALICE, 'tools/call', {
      name: 'call_page_tool',
      arguments: { page: 'pg_0000000000', tool: 't', arguments: { secret } },
    });
    const written = JSON.stringify(clientLines(current.lines));
    expect(clientLines(current.lines)).toHaveLength(2);
    expect(written).not.toContain(ALICE.token);
    expect(written).not.toContain(opened.sessionId ?? 'no session');
    expect(written).not.toContain(secret);
    for (const line of clientLines(current.lines)) {
      expect(Object.keys(line).sort()).toEqual([
        'client',
        'clientVersion',
        'formElicitation',
        'leg',
        'level',
        'msg',
        'revision',
        'ts',
        'userId',
      ]);
    }
  });
});

describe('the client line budget', () => {
  function written(): { lines: string[]; write: ReturnType<typeof createClientLines>['write'] } {
    const lines: string[] = [];
    const log = createLogger({ sink: (line) => lines.push(line) });
    const budget = createClientLines(log);
    return {
      lines,
      write: (fields, now) => {
        budget.write(fields, now);
      },
    };
  }

  it('writes one line per user, client name and leg an hour', () => {
    const { lines, write } = written();
    const hour = Math.floor(Date.now() / CLIENT_LINE_WINDOW_MS) * CLIENT_LINE_WINDOW_MS;
    const fields = {
      userId: 'alice',
      client: { name: 'claude-code', version: '2.1.289' },
      leg: 'strict' as const,
      revision: '2026-07-28',
      capabilities: {},
    };
    write(fields, hour);
    write(fields, hour + 1000);
    write({ ...fields, client: { name: 'claude-code', version: '2.1.290' } }, hour + 2000);
    write(fields, hour + CLIENT_LINE_WINDOW_MS - 1);
    expect(lines).toHaveLength(1);
    // The next hour, the same client is written again.
    write(fields, hour + CLIENT_LINE_WINDOW_MS);
    expect(lines).toHaveLength(2);
  });

  it(`writes at most ${String(MAX_CLIENT_LINE_KEYS)} lines an hour, and no summary of the rest`, () => {
    const { lines, write } = written();
    const hour = Math.floor(Date.now() / CLIENT_LINE_WINDOW_MS) * CLIENT_LINE_WINDOW_MS;
    // Many accounts, each within its own share, renaming their clients.
    for (let index = 0; index < MAX_CLIENT_LINE_KEYS + 100; index += 1) {
      write(
        {
          userId: `user-${String(Math.floor(index / 2))}`,
          client: { name: `renamed-${String(index)}`, version: '1' },
          leg: 'strict',
          revision: '2026-07-28',
          capabilities: {},
        },
        hour + index,
      );
    }
    expect(lines).toHaveLength(MAX_CLIENT_LINE_KEYS);
    // A new hour starts the count again, and writes nothing about the last one.
    write(
      { userId: 'alice', client: null, leg: 'session', revision: null, capabilities: undefined },
      hour + CLIENT_LINE_WINDOW_MS,
    );
    expect(lines).toHaveLength(MAX_CLIENT_LINE_KEYS + 1);
    expect(lines.every((line) => line.includes('"msg":"mcp client"'))).toBe(true);
  });

  it(`gives one user at most ${String(MAX_CLIENT_LINE_KEYS_PER_USER)} of them an hour, so one account cannot hide another's line`, () => {
    const { lines, write } = written();
    const hour = Math.floor(Date.now() / CLIENT_LINE_WINDOW_MS) * CLIENT_LINE_WINDOW_MS;
    const line = (userId: string, name: string, at: number): void => {
      write(
        {
          userId,
          client: { name, version: '1' },
          leg: 'strict',
          revision: '2026-07-28',
          capabilities: {},
        },
        hour + at,
      );
    };
    for (let index = 0; index < MAX_CLIENT_LINE_KEYS + 100; index += 1) {
      line('alice', `renamed-${String(index)}`, index);
    }
    expect(lines).toHaveLength(MAX_CLIENT_LINE_KEYS_PER_USER);
    line('bob', 'claude-ai', 1000);
    expect(lines).toHaveLength(MAX_CLIENT_LINE_KEYS_PER_USER + 1);
    expect(lines.at(-1)).toContain('"userId":"bob"');
    // A name already written is no new key, and spends nothing of the share.
    line('bob', 'claude-ai', 1001);
    expect(lines).toHaveLength(MAX_CLIENT_LINE_KEYS_PER_USER + 1);
    // The next hour each user has a share again.
    line('alice', 'claude-code', CLIENT_LINE_WINDOW_MS);
    expect(lines).toHaveLength(MAX_CLIENT_LINE_KEYS_PER_USER + 2);
  });

  it('reads form elicitation as a capability that is empty or names form', () => {
    expect(declaresFormElicitation({ elicitation: {} })).toBe(true);
    expect(declaresFormElicitation({ elicitation: { form: {} } })).toBe(true);
    expect(declaresFormElicitation({ elicitation: { form: {}, url: {} } })).toBe(true);
    expect(declaresFormElicitation({ elicitation: { url: {} } })).toBe(false);
    expect(declaresFormElicitation({ elicitation: [] })).toBe(false);
    expect(declaresFormElicitation({ elicitation: true })).toBe(false);
    expect(declaresFormElicitation({})).toBe(false);
    expect(declaresFormElicitation(undefined)).toBe(false);
  });
});

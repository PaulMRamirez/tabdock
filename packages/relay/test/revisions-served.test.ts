// The revisions /mcp serves, probed by hand on the wire (ADR 0027, A5.2).
//
// The sessionful leg answers initialize with each 2025-era revision the relay
// claims, 2024-11-05 as best effort, and with 2025-11-25 to anything else,
// 2026-07-28 and an unknown date included, as the 2025 lifecycle requires; on
// a session a missing MCP-Protocol-Version passes, as 2025-06-18 allows for a
// client of an earlier revision, while 2026-07-28 or an unknown one gets 400.
// The strict leg answers a header that disagrees with the envelope with
// -32020, and a revision it does not serve with -32022, whose data.supported
// the relay rewrites to every revision /mcp serves, newest first, since
// 2026-07-28 says a server MUST list the versions it supports and the same
// endpoint serves the 2025 ones on a session; the rewrite changes nothing
// else, on a listen as on any other request, and every other answer passes
// untouched. server/discover lists the same revisions, so every one a -32022
// names is one discover names too (ADR 0027's Step 3 review notes); the
// golden test holds the rest of discover's answer as M4 sent it. This file,
// not the conformance suite, guards the -32022 list: the suite only asks
// that the list name nothing discover does not.

import { afterEach, describe, expect, it } from 'vitest';
import type { DevTokenUser, Relay } from '../src/index.ts';
import { SERVED_REVISIONS } from '../src/relay.ts';
import { openSession } from './helpers/raw-mcp.ts';
import { ALICE, startRelay, type TestRelay } from './helpers/relay.ts';
import { modernExchange } from './helpers/wire.ts';

let current: TestRelay | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

/** The 2025-era revisions the relay claims on a session, and the best-effort one. */
const SESSION_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** The JSON-RPC message with this id, from a JSON body or an event stream's data lines. */
function messageWithId(body: string, id: number): Record<string, unknown> | null {
  const texts = [body, ...body.split('\n').map((line) => line.replace(/^data: ?/, ''))];
  for (const text of texts) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed.id === id) return parsed;
    } catch {
      // Not this one.
    }
  }
  return null;
}

let nextId = 9000;

/** An initialize asking for `version`: what it answered, and the session it opened. */
async function initializeAt(
  relay: Relay,
  user: DevTokenUser,
  version: string,
): Promise<{ status: number; negotiated: unknown; sessionId: string | null }> {
  nextId += 1;
  const id = nextId;
  const response = await fetch(relay.mcpUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: 'revision-probe', version: '1.0.0' },
      },
    }),
  });
  const body = await response.text();
  const result = messageWithId(body, id)?.result as { protocolVersion?: unknown } | undefined;
  return {
    status: response.status,
    negotiated: result?.protocolVersion,
    sessionId: response.headers.get('mcp-session-id'),
  };
}

/** One tools/list on a session, with this MCP-Protocol-Version header, or none for null. */
async function onSession(
  relay: Relay,
  user: DevTokenUser,
  sessionId: string,
  header: string | null,
): Promise<{ status: number; listed: boolean }> {
  nextId += 1;
  const id = nextId;
  const response = await fetch(relay.mcpUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId,
      ...(header === null ? {} : { 'Mcp-Protocol-Version': header }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} }),
  });
  const body = await response.text();
  const result = messageWithId(body, id)?.result as { tools?: unknown[] } | undefined;
  return { status: response.status, listed: Array.isArray(result?.tools) };
}

async function endSession(relay: Relay, user: DevTokenUser, sessionId: string): Promise<void> {
  const response = await fetch(relay.mcpUrl, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${user.token}`, 'Mcp-Session-Id': sessionId },
  });
  await response.body?.cancel();
}

describe('initialize on the sessionful leg', () => {
  it('echoes each 2025-era revision the relay claims, 2024-11-05 included, on a session of its own', async () => {
    current = await startRelay();
    const opened = new Set<string>();
    for (const version of SESSION_REVISIONS) {
      const answer = await initializeAt(current.relay, ALICE, version);
      expect(answer.status, version).toBe(200);
      expect(answer.negotiated, version).toBe(version);
      expect(answer.sessionId, version).not.toBeNull();
      if (answer.sessionId !== null) opened.add(answer.sessionId);
    }
    expect(opened.size).toBe(SESSION_REVISIONS.length);
    for (const id of opened) await endSession(current.relay, ALICE, id);
  });

  it('answers 2025-11-25 to 2026-07-28, to an unknown date and to garbage, as the 2025 lifecycle says', async () => {
    current = await startRelay();
    for (const version of ['2026-07-28', '2027-01-01', '1900-01-01', 'garbage']) {
      const answer = await initializeAt(current.relay, ALICE, version);
      expect(answer.status, version).toBe(200);
      expect(answer.negotiated, version).toBe('2025-11-25');
      expect(answer.sessionId, version).not.toBeNull();
      if (answer.sessionId !== null) await endSession(current.relay, ALICE, answer.sessionId);
    }
  });
});

describe('MCP-Protocol-Version on a session', () => {
  it('passes a missing header and each claimed 2025-era revision, and refuses 2026-07-28 and unknown ones 400', async () => {
    current = await startRelay();
    const session = await openSession(current.relay, ALICE);
    for (const header of [null, ...SESSION_REVISIONS]) {
      const answer = await onSession(current.relay, ALICE, session, header);
      expect(answer, String(header)).toEqual({ status: 200, listed: true });
    }
    for (const header of ['2026-07-28', '2027-01-01', 'garbage']) {
      const answer = await onSession(current.relay, ALICE, session, header);
      expect(answer, header).toEqual({ status: 400, listed: false });
    }
    // The refusals left the session as it was.
    expect(await onSession(current.relay, ALICE, session, '2025-11-25')).toEqual({
      status: 200,
      listed: true,
    });
  });
});

describe('the strict leg', () => {
  it('answers server/discover with every revision /mcp serves, the -32022 list, and the tools capability', async () => {
    current = await startRelay();
    const answer = await modernExchange(current.relay, ALICE, 'server/discover');
    expect(answer.status).toBe(200);
    expect(answer.message?.result).toMatchObject({
      supportedVersions: [...SERVED_REVISIONS],
      capabilities: { tools: { listChanged: true } },
    });
    // A client may read the refusal's list against discover's, as the
    // conformance suite does: every revision a -32022 names is in discover.
    const refused = await modernExchange(
      current.relay,
      ALICE,
      'tools/list',
      {},
      {
        version: '2027-01-01',
      },
    );
    const supported = (refused.message?.error as { data?: { supported?: unknown } } | undefined)
      ?.data?.supported;
    expect(supported).toEqual(
      (answer.message?.result as { supportedVersions?: unknown }).supportedVersions,
    );
  });

  it('answers a header that disagrees with the envelope 400 with -32020', async () => {
    current = await startRelay();
    for (const [header, envelope] of [
      ['2026-07-28', '2027-01-01'],
      ['2027-01-01', '2026-07-28'],
    ] as const) {
      nextId += 1;
      const response = await fetch(current.relay.mcpUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ALICE.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Protocol-Version': header,
          'Mcp-Method': 'tools/list',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: nextId,
          method: 'tools/list',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': envelope,
              'io.modelcontextprotocol/clientInfo': { name: 'revision-probe', version: '1.0.0' },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      });
      const body = (await response.json()) as { error?: { code?: number } };
      expect(response.status, `${header} over ${envelope}`).toBe(400);
      expect(body.error?.code, `${header} over ${envelope}`).toBe(-32020);
    }
  });
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

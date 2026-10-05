// The five fixed tools as clients receive them, held to what M4 sent (ADR
// 0025). M5 moves the whole tool surface from McpServer.registerTool to the
// SDK's low-level Server, which answers tools/list and dispatches tools/call
// in the relay's own code, so nothing but this test says the fixed tools'
// wire entries stayed as they were: name, title, description, input schema,
// annotations and _meta, on both eras, with first-class tools off and on.
// The fixture was captured from the relay before the move (its _comment says
// where); <RELAY_VERSION> stands for the version the release bumps. Beside
// the lists, initialize and server/discover keep their answers (discover's
// supportedVersions now naming every revision /mcp serves, ADR 0027's Step 3
// review notes), a name the relay does not serve keeps M4's JSON-RPC error,
// and a handler that throws still answers an isError result in the thrown
// message, as McpServer did.

import { readFileSync } from 'node:fs';
import { type AuthInfo, createMcpHandler } from '@modelcontextprotocol/server';
import { FIRST_CLASS_LIST_TTL_MS } from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.ts';
import type { PageHub } from '../src/hub.ts';
import { createDevTokenAuth } from '../src/index.ts';
import { createMcpFactory, RELAY_VERSION } from '../src/mcp.ts';
import { SERVED_REVISIONS } from '../src/relay.ts';
import { connectPage, type TestPage, TOOLS } from './helpers/page-client.ts';
import {
  ALICE,
  connectClient,
  pairAndApprove,
  startRelay,
  type TestRelay,
} from './helpers/relay.ts';
import {
  legacyExchange,
  legacyInitialize,
  modernExchange,
  type WireAnswer,
} from './helpers/wire.ts';

interface Golden {
  legacy: { initialize: unknown; toolsList: unknown; unknownTool: unknown };
  modern: { discover: unknown; toolsList: unknown; unknownTool: unknown };
}

const GOLDEN = JSON.parse(
  readFileSync(new URL('./fixtures/fixed-tools.golden.json', import.meta.url), 'utf8'),
) as Golden;

/** The JSON-RPC answer without its id, with the relay's version as the fixture writes it. */
function asCaptured(answer: WireAnswer): unknown {
  if (answer.message === null) throw new Error(`no answer: ${answer.body}`);
  const rest = { ...answer.message };
  delete rest.id;
  return JSON.parse(
    JSON.stringify(rest).replaceAll(`"${RELAY_VERSION}"`, '"<RELAY_VERSION>"'),
  ) as unknown;
}

/** Equal, and equal as text, so a key that moved shows too: the wire is the text. */
function expectWire(actual: unknown, expected: unknown): void {
  expect(actual).toEqual(expected);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

function toolsOf(result: unknown): unknown[] {
  return (result as { result: { tools: unknown[] } }).result.tools;
}

let current: TestRelay | undefined;
const pages: TestPage[] = [];

afterEach(async () => {
  for (const page of pages.splice(0)) page.ws.terminate();
  await current?.close();
  current = undefined;
});

describe('the five fixed tools stay as M4 sent them', () => {
  for (const firstClassTools of [false, true]) {
    describe(firstClassTools ? 'with first-class tools on' : 'with first-class tools off', () => {
      it('on a 2025-era session: initialize, tools/list and an unknown name', async () => {
        current = await startRelay({ firstClassTools });
        const init = await legacyInitialize(current.relay, ALICE);
        expectWire(asCaptured(init), GOLDEN.legacy.initialize);
        const list = await legacyExchange(current.relay, ALICE, init.sessionId ?? '', 'tools/list');
        expectWire(asCaptured(list), GOLDEN.legacy.toolsList);
        const unknown = await legacyExchange(
          current.relay,
          ALICE,
          init.sessionId ?? '',
          'tools/call',
          {
            name: 'nope',
            arguments: {},
          },
        );
        expectWire(asCaptured(unknown), GOLDEN.legacy.unknownTool);
      });

      it('on 2026-07-28: server/discover, tools/list and an unknown name', async () => {
        current = await startRelay({ firstClassTools });
        const discover = await modernExchange(current.relay, ALICE, 'server/discover');
        const captured = GOLDEN.modern.discover as { result: Record<string, unknown> };
        // The one change to discover since M4: it lists every revision /mcp
        // serves, as -32022 does (ADR 0027's Step 3 review notes), in place.
        expectWire(asCaptured(discover), {
          ...captured,
          result: { ...captured.result, supportedVersions: [...SERVED_REVISIONS] },
        });
        const list = await modernExchange(current.relay, ALICE, 'tools/list');
        const expected = GOLDEN.modern.toolsList as { result: Record<string, unknown> };
        // The one difference the flag makes to an empty list: ADR 0025's cache hint.
        expectWire(
          asCaptured(list),
          firstClassTools
            ? { ...expected, result: { ...expected.result, ttlMs: FIRST_CLASS_LIST_TTL_MS } }
            : expected,
        );
        const unknown = await modernExchange(current.relay, ALICE, 'tools/call', {
          name: 'nope',
          arguments: {},
        });
        expectWire(asCaptured(unknown), GOLDEN.modern.unknownTool);
      });
    });
  }

  it('lead the list unchanged, on both eras, once a page adds first-class tools after them', async () => {
    current = await startRelay({ firstClassTools: true });
    const page = await connectPage(current.relay.pageUrl, { tools: TOOLS });
    pages.push(page);
    const client = await connectClient(current.relay, ALICE);
    await pairAndApprove(client, page);
    await client.close();
    const init = await legacyInitialize(current.relay, ALICE);
    const legacy = toolsOf(
      asCaptured(await legacyExchange(current.relay, ALICE, init.sessionId ?? '', 'tools/list')),
    );
    const modern = toolsOf(asCaptured(await modernExchange(current.relay, ALICE, 'tools/list')));
    const fixed = toolsOf(GOLDEN.legacy.toolsList);
    for (const tools of [legacy, modern]) {
      // The page's tools follow, so the list is longer than the five.
      expect(tools.length).toBeGreaterThan(fixed.length);
      expectWire(tools.slice(0, fixed.length), fixed);
    }
  });
});

const AUTH: AuthInfo = {
  token: '',
  clientId: 'alice',
  scopes: [],
  extra: {
    userId: 'alice',
    displayName: 'Alice',
    kind: 'member',
    email: null,
    oauthClientId: null,
  },
};

/** A hub every one of whose methods throws, naming the method. */
const THROWING_HUB = new Proxy(
  {},
  {
    get(_target, key) {
      if (key === 'then') return undefined;
      return () => {
        throw new Error(`boom from ${String(key)}`);
      };
    },
  },
) as unknown as PageHub;

function callRequest(name: string, args: Record<string, unknown>, modern: boolean): Request {
  const params = modern
    ? {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'x', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      }
    : { name, arguments: args };
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Protocol-Version': modern ? '2026-07-28' : '2025-11-25',
      ...(modern ? { 'Mcp-Method': 'tools/call', 'Mcp-Name': name } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
  });
}

/** The JSON-RPC result in a JSON body or an event stream's data line. */
function resultOf(body: string): unknown {
  const line = body.split('\n').find((each) => each.startsWith('data: '));
  const message = JSON.parse(line === undefined ? body : line.slice(6)) as { result?: unknown };
  return message.result;
}

describe('a fixed tool whose handler throws', () => {
  for (const [name, args, method] of [
    ['list_pages', {}, 'listPages'],
    ['call_page_tool', { page: 'pg_x', tool: 't', arguments: {} }, 'callPageTool'],
    ['detach_page', { page: 'pg_x' }, 'detachPage'],
  ] as const) {
    it(`answers ${name} with an isError result in the thrown words on both eras`, async () => {
      const config = resolveConfig({ auth: createDevTokenAuth([ALICE]) });
      // The stateless legacy fallback serves the 2025 request from the same factory.
      const handler = createMcpHandler(createMcpFactory(THROWING_HUB, config));
      try {
        for (const modern of [false, true]) {
          const response = await handler.fetch(callRequest(name, args, modern), { authInfo: AUTH });
          expect(response.status).toBe(200);
          expect(resultOf(await response.text())).toMatchObject({
            content: [{ type: 'text', text: `boom from ${method}` }],
            isError: true,
          });
        }
      } finally {
        await handler.close();
      }
    });
  }
});

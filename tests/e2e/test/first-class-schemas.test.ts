// First-class entries every SDK client takes (ADR 0025). A client of either
// era rejects a whole tools/list, the five fixed tools included, over one
// entry whose input schema it does not take, so a page's schema must never
// reach a member's list unless each client the relay serves takes it. Here
// a sim page offers one plain tool beside one tool for each root shape some
// client refuses, and every client of the matrix lists the five fixed tools
// and the plain tool alone: the v1 SDK at the four versions the matrix pins,
// and 2.3.1 on a 2025-era session and on 2026-07-28. A later client that
// adds a rule fails here on upgrade.

import type { FakeToolDefinition } from '@tabdock/sim-page';
import { afterEach, describe, expect, it } from 'vitest';
import { attachAs, startWorld, type World } from './helpers.ts';

let world: World | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

const FIXED = [
  'list_pages',
  'pair_page',
  'list_page_tools',
  'call_page_tool',
  'detach_page',
  'get_page_state',
  'wait_for_page_state',
  'get_proposal',
  'withdraw_proposal',
];

/** Roots a client of some era rejects the whole list over, by the tool that offers each. */
const REJECTED: Record<string, Record<string, unknown>> = {
  required_text: { type: 'object', required: 'label' },
  required_numbers: { type: 'object', required: [1] },
  properties_number: { type: 'object', properties: 5 },
  properties_list: { type: 'object', properties: ['a'] },
  property_number: { type: 'object', properties: { a: 5 } },
  property_boolean: { type: 'object', properties: { a: true } },
  schema_number: { type: 'object', $schema: 5 },
};

function tools(): FakeToolDefinition[] {
  const plain: FakeToolDefinition = {
    name: 'plain',
    description: 'A tool every client takes.',
    inputSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
    annotations: { readOnlyHint: true },
    execute: () => ({ ok: true }),
  };
  return [
    plain,
    ...Object.entries(REJECTED).map(([name, inputSchema]) => ({
      name,
      description: `Offers a root some client rejects: ${name}.`,
      inputSchema,
      annotations: { readOnlyHint: true },
      execute: () => ({ ok: true }),
    })),
  ];
}

/** What the test needs of a v1 client, whose types differ from version to version. */
interface V1Client {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: { name: string }[] }>;
  close(): Promise<void>;
}

type V1ClientClass = new (info: { name: string; version: string }) => V1Client;
type V1TransportClass = new (
  url: URL,
  options: { requestInit: { headers: Record<string, string> } },
) => unknown;

/** The v1 SDK at the versions the client matrix pins (tests/e2e/package.json). */
const V1_SDKS: [string, () => Promise<[V1ClientClass, V1TransportClass]>][] = [
  [
    '1.10.2',
    async () => [
      (await import('mcp-sdk-1.10.2/client/index.js')).Client,
      (await import('mcp-sdk-1.10.2/client/streamableHttp.js')).StreamableHTTPClientTransport,
    ],
  ],
  [
    '1.12.3',
    async () => [
      (await import('mcp-sdk-1.12.3/client/index.js')).Client,
      (await import('mcp-sdk-1.12.3/client/streamableHttp.js')).StreamableHTTPClientTransport,
    ],
  ],
  [
    '1.24.0',
    async () => [
      (await import('mcp-sdk-1.24.0/client/index.js')).Client,
      (await import('mcp-sdk-1.24.0/client/streamableHttp.js')).StreamableHTTPClientTransport,
    ],
  ],
  [
    '1.32.0',
    async () => [
      (await import('mcp-sdk-1.32.0/client/index.js')).Client,
      (await import('mcp-sdk-1.32.0/client/streamableHttp.js')).StreamableHTTPClientTransport,
    ],
  ],
];

describe('first-class entries (ADR 0025)', () => {
  it('reach every client of the matrix in a list it takes, a schema some client rejects left off', async () => {
    world = await startWorld({ firstClassTools: true });
    const sim = await world.page({ tools: () => tools() });
    const alice = await world.client(world.alice);
    const pageId = await attachAs(alice, sim, 'driver');
    const expected = [...FIXED, `${pageId}__plain`];

    for (const modern of [false, true]) {
      const client = await world.client(world.alice, 'matrix-2.3.1', { modern });
      const { tools: listed } = await client.listTools();
      expect(
        listed.map((tool) => tool.name),
        `2.3.1 ${modern ? '2026-07-28' : 'legacy'}`,
      ).toEqual(expected);
    }

    for (const [version, load] of V1_SDKS) {
      const [ClientClass, TransportClass] = await load();
      const client = new ClientClass({ name: `matrix-${version}`, version });
      await client.connect(
        new TransportClass(new URL(world.relay.mcpUrl), {
          requestInit: { headers: { Authorization: `Bearer ${world.alice.token}` } },
        }),
      );
      try {
        const { tools: listed } = await client.listTools();
        expect(
          listed.map((tool) => tool.name),
          version,
        ).toEqual(expected);
      } finally {
        await client.close();
      }
    }
  });
});

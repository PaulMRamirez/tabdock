// Page state end to end (ADR 0040, A6.6): the real adapter core on the sim
// page publishes through publishState, or from its store after each call
// with stateFrom, the real relay keeps it, and SDK clients of every
// generation the relay claims read it with get_page_state and follow it
// with wait_for_page_state, behind the page state label as text alone,
// while the page runs no tool for any of it and its activity log stays
// empty. A reload drops the value and comes back at a higher version.

import { Client as ClientV2, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { pageStateHeader, PageStateResultSchema } from '@tabdock/protocol';
import { DEFAULT_SIM_ORIGIN } from '@tabdock/sim-page';
import { Client as Client1102 } from 'mcp-sdk-1.10.2/client/index.js';
import { StreamableHTTPClientTransport as Http1102 } from 'mcp-sdk-1.10.2/client/streamableHttp.js';
import { Client as Client1240 } from 'mcp-sdk-1.24.0/client/index.js';
import { StreamableHTTPClientTransport as Http1240 } from 'mcp-sdk-1.24.0/client/streamableHttp.js';
import { Client as Client1320 } from 'mcp-sdk-1.32.0/client/index.js';
import { StreamableHTTPClientTransport as Http1320 } from 'mcp-sdk-1.32.0/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { labelledAlone, readPageState, stateBody, waitPageState } from '../src/state-helpers.ts';
import { attachAs, callTool, startWorld, type World } from './helpers.ts';

let world: World | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

async function open(): Promise<World> {
  world = await startWorld();
  return world;
}

describe('a sim page publishing its state (ADR 0040)', () => {
  it.each([
    ['2025-era', false],
    ['2026-07-28', true],
  ] as const)(
    'reaches a driver and an observer on the %s leg behind its label, running nothing on the page',
    async (_, modern) => {
      const w = await open();
      const sim = await w.page();
      const alice = await w.client(w.alice, 'state-alice', { modern });
      const bob = await w.client(w.bob, 'state-bob', { modern });
      const pageId = await attachAs(alice, sim, 'driver');
      await attachAs(bob, sim, 'observer');
      expect(sim.publishState({ view: { zoom: 2 }, stop: 1 })).toEqual({ ok: true });
      await sim.waitFor((state) => state.published === 'shared');
      for (const who of [alice, bob]) {
        const followed = await waitPageState(who, pageId, 0, 5000);
        expect(labelledAlone(followed, DEFAULT_SIM_ORIGIN)).toBe(true);
        expect(stateBody(followed)).toMatchObject({
          version: 1,
          value: { view: { zoom: 2 }, stop: 1 },
          changed: true,
        });
      }
      for (let n = 0; n < 50; n += 1) {
        for (const who of [alice, bob]) {
          expect(stateBody(await readPageState(who, pageId)).version).toBe(1);
        }
      }
      // A hundred reads, and the page ran nothing and logged nothing.
      expect(sim.activity).toEqual([]);
      expect(sim.store.calls).toEqual([]);
    },
  );

  it('follows a page that publishes from its store after each call (stateFrom)', async () => {
    const w = await open();
    const sim = await w.page({ stateFrom: (store) => ({ value: store.value }) });
    const alice = await w.client(w.alice, 'state-follower');
    const pageId = await attachAs(alice, sim, 'driver');
    const first = stateBody(await waitPageState(alice, pageId, 0, 5000));
    expect(first.value).toEqual({ value: null });
    const following = waitPageState(alice, pageId, first.version, 5000);
    const set = await callTool(alice, 'call_page_tool', {
      page: pageId,
      tool: 'set_value',
      arguments: { value: 'north' },
    });
    expect(set.isError, set.text).toBe(false);
    const next = stateBody(await following);
    expect(next).toMatchObject({
      version: first.version + 1,
      value: { value: 'north' },
      changed: true,
    });
  });

  it('drops the value when the page reloads, and comes back at a higher version', async () => {
    const w = await open();
    const sim = await w.page();
    const alice = await w.client(w.alice, 'state-reload');
    const pageId = await attachAs(alice, sim, 'driver');
    sim.publishState({ stop: 1 });
    const before = stateBody(await waitPageState(alice, pageId, 0, 5000));
    await sim.reload();
    await sim.waitFor((state) => state.link === 'linked');
    // A reload is a new document, which publishes again, as a real page would.
    sim.publishState({ stop: 1 });
    let after = stateBody(await waitPageState(alice, pageId, before.version, 5000));
    if (after.value === null)
      after = stateBody(await waitPageState(alice, pageId, after.version, 5000));
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.value).toEqual({ stop: 1 });
  });
});

/** One client generation, reduced to listing and calling. */
interface Matrixed {
  names(): Promise<string[]>;
  call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean; structured: boolean }>;
  close(): Promise<void>;
}

interface V1Client {
  connect(transport: unknown): Promise<void>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  listTools(): Promise<{ tools: { name: string }[] }>;
  close(): Promise<void>;
}

function shaped(result: unknown): { text: string; isError: boolean; structured: boolean } {
  const fields = result as {
    content?: { type?: string; text?: string }[];
    isError?: boolean;
    structuredContent?: unknown;
  };
  return {
    text: (fields.content ?? [])
      .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
      .join('\n'),
    isError: fields.isError === true,
    structured: fields.structuredContent !== undefined,
  };
}

const V1 = {
  '1.10.2': [Client1102, Http1102],
  '1.24.0': [Client1240, Http1240],
  '1.32.0': [Client1320, Http1320],
} as const;

async function v1(version: keyof typeof V1, url: string, token: string): Promise<Matrixed> {
  const [ClientClass, TransportClass] = V1[version];
  const client = new (
    ClientClass as unknown as new (
      info: { name: string; version: string },
      options: { capabilities: Record<string, unknown> },
    ) => V1Client
  )({ name: `state-sdk-${version}`, version: '0.0.0' }, { capabilities: {} });
  await client.connect(
    new (
      TransportClass as unknown as new (url: URL, options: { requestInit: RequestInit }) => unknown
    )(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return {
    names: async () => (await client.listTools()).tools.map((tool) => tool.name),
    call: async (name, args) => shaped(await client.callTool({ name, arguments: args })),
    close: () => client.close(),
  };
}

async function v2(pinned: boolean, url: string, token: string): Promise<Matrixed> {
  const client = new ClientV2(
    { name: `state-client-${pinned ? 'pinned' : 'legacy'}`, version: '0.0.0' },
    pinned ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return {
    names: async () => (await client.listTools()).tools.map((tool) => tool.name),
    call: async (name, args) => shaped(await client.callTool({ name, arguments: args })),
    close: () => client.close(),
  };
}

const ROWS: [string, (url: string, token: string) => Promise<Matrixed>][] = [
  ['@modelcontextprotocol/sdk 1.10.2', (url, token) => v1('1.10.2', url, token)],
  ['@modelcontextprotocol/sdk 1.24.0', (url, token) => v1('1.24.0', url, token)],
  ['@modelcontextprotocol/sdk 1.32.0', (url, token) => v1('1.32.0', url, token)],
  ['@modelcontextprotocol/client 2.3.1, legacy', (url, token) => v2(false, url, token)],
  ['@modelcontextprotocol/client 2.3.1, pinned', (url, token) => v2(true, url, token)],
];

describe('every client generation the relay claims (ADR 0027)', () => {
  it.each(ROWS)(
    '%s lists both state tools and reads and waits behind the label',
    async (_, connect) => {
      const w = await open();
      const sim = await w.page();
      const alice = await w.client(w.alice, 'state-matrix-setup');
      const pageId = await attachAs(alice, sim, 'driver');
      sim.publishState({ stop: 7 });
      await waitPageState(alice, pageId, 0, 5000);
      const client = await connect(w.relay.mcpUrl, w.alice.token);
      try {
        const names = await client.names();
        expect(names).toContain('get_page_state');
        expect(names).toContain('wait_for_page_state');
        for (const [name, args] of [
          ['get_page_state', { page: pageId }],
          ['wait_for_page_state', { page: pageId, after: 0, timeoutMs: 1000 }],
        ] as const) {
          const answer = await client.call(name, args);
          expect(answer.isError, answer.text).toBe(false);
          expect(answer.structured).toBe(false);
          const [label, ...rest] = answer.text.split('\n');
          expect(label).toBe(pageStateHeader(DEFAULT_SIM_ORIGIN));
          expect(PageStateResultSchema.parse(JSON.parse(rest.join('\n')))).toMatchObject({
            version: 1,
            value: { stop: 7 },
          });
        }
      } finally {
        await client.close();
      }
    },
  );
});

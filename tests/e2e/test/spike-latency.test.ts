// The latency spike's arithmetic and its whole run against a local relay with
// the spike flag on: pairing through the operator, warm-up and measured calls,
// and a report that splits the round trip with the relay's timestamps.

import { createOAuthAuth, createRelay } from '@tabdock/relay';
import { describe, expect, it } from 'vitest';
// The relay's own stand-ins for an identity provider and a tunnel, so the
// script's sign-in runs exactly as the relay's OAuth tests run Claude Code's.
import { MOCK_SUBJECT, startProvider } from '../../../packages/relay/test/helpers/provider.ts';
import {
  PUBLIC_MCP_URL,
  PUBLIC_ORIGIN,
  tunnelFetch,
} from '../../../packages/relay/test/helpers/tunnel.ts';
import {
  choosePage,
  connectWithBearer,
  connectWithOAuth,
  latencyReport,
  measureCalls,
} from '../src/spike/latency.ts';
import { markdownTable, nearestRank, summarise } from '../src/spike/stats.ts';
import { linked, pairingCode, startWorld } from './helpers.ts';

describe('nearest-rank percentiles', () => {
  it('takes the 25th and 48th of 50 sorted values for p50 and p95', () => {
    // 1 to 50 in a scrambled order.
    const values = Array.from({ length: 50 }, (_, i) => ((i * 17) % 50) + 1);
    const summary = summarise(values);
    expect(summary).toEqual({ n: 50, p50: 25, p95: 48, min: 1, max: 50 });
  });

  it('never interpolates, and handles small and empty samples', () => {
    expect(nearestRank([10, 20], 50)).toBe(10);
    expect(nearestRank([10, 20], 95)).toBe(20);
    expect(nearestRank([7], 50)).toBe(7);
    expect(summarise([])).toBeNull();
    expect(() => nearestRank([], 50)).toThrow();
    expect(() => nearestRank([1], 0)).toThrow();
  });

  it('prints a markdown table with every measure on its own row', () => {
    const table = markdownTable([
      { label: 'Round trip', summary: summarise([1.234, 2.5, 120.4]) },
      { label: 'Page', summary: null },
    ]);
    expect(table.split('\n')).toEqual([
      '| Measure (ms) | n | p50 | p95 | min | max |',
      '| --- | --- | --- | --- | --- | --- |',
      '| Round trip | 3 | 2.5 | 120 | 1.2 | 120 |',
      '| Page | 0 | n/a | n/a | n/a | n/a |',
    ]);
  });
});

describe('the latency run', () => {
  it('pairs, times warm-up and measured calls, and splits them with the relay timestamps', async () => {
    const world = await startWorld({ spike: true });
    try {
      const sim = await world.page();
      await linked(sim);
      const client = await connectWithBearer(world.relay.mcpUrl, world.alice.token);
      try {
        // The operator approves as soon as the request shows on the page.
        const code = await pairingCode(sim);
        const approved = sim
          .waitFor((state) => state.pendingRequests.length > 0)
          .then((state) => {
            const request = state.pendingRequests[0];
            if (request) sim.dock.approve(request.requestId, 'observer');
          });
        const page = await choosePage(client, { code });
        await approved;
        expect(page).toBe(sim.state.pageId);
        // Reusing the attachment needs neither: the one awake page is chosen.
        expect(await choosePage(client, {})).toBe(page);

        const seen: number[] = [];
        const samples = await measureCalls(client, {
          page,
          tool: 'get_value',
          warmup: 2,
          calls: 10,
          onCall: (index) => seen.push(index),
        });
        expect(seen).toEqual(Array.from({ length: 12 }, (_, i) => i));
        expect(samples).toHaveLength(10);
        for (const sample of samples) {
          expect(sample.ok).toBe(true);
          const timing = sample.timing;
          if (!timing) throw new Error('the relay sent no timestamps');
          expect(timing.pageMs).not.toBeNull();
          expect(timing.relayMs).toBeLessThanOrEqual(sample.roundTripMs);
        }
        // Twelve calls reached the page: the warm-up ones too.
        expect(sim.store.calls.filter((call) => call.tool === 'get_value')).toHaveLength(12);

        const report = latencyReport(samples, {
          url: world.relay.mcpUrl,
          tool: 'get_value',
          warmup: 2,
          era: '2025-11-25',
        });
        expect(report).toContain('| Round trip at the client | 10 |');
        expect(report).toContain('| Page link and page handler | 10 |');
        expect(report).toContain('| Tunnel, network and client (round trip minus relay) | 10 |');
        expect(report).toContain('Every call succeeded.');
        expect(report).not.toContain(world.alice.token);
      } finally {
        await client.close();
      }
    } finally {
      await world.close();
    }
  });

  it('reports only the round trip when the relay has no spike flag', async () => {
    const world = await startWorld();
    try {
      const sim = await world.page();
      await linked(sim);
      const client = await connectWithBearer(world.relay.mcpUrl, world.alice.token, {
        modern: true,
      });
      try {
        const code = await pairingCode(sim);
        const approved = sim
          .waitFor((state) => state.pendingRequests.length > 0)
          .then((state) => {
            const request = state.pendingRequests[0];
            if (request) sim.dock.approve(request.requestId, 'observer');
          });
        const page = await choosePage(client, { code });
        await approved;
        const samples = await measureCalls(client, {
          page,
          tool: 'get_value',
          warmup: 1,
          calls: 3,
        });
        expect(samples.every((sample) => sample.timing === null && sample.ok)).toBe(true);
        const report = latencyReport(samples, {
          url: world.relay.mcpUrl,
          tool: 'get_value',
          warmup: 1,
          era: '2026-07-28',
        });
        expect(report).toContain('| Round trip at the client | 3 |');
        expect(report).toContain('| Page link and page handler | 0 | n/a');
        expect(report).toContain('spike flag is off');
      } finally {
        await client.close();
      }
    } finally {
      await world.close();
    }
  });
});

async function startPublicRelay(): Promise<{
  relayUrl: string;
  issuer: string;
  close: () => Promise<void>;
}> {
  const provider = await startProvider();
  const relay = await createRelay({
    auth: createOAuthAuth({
      issuer: provider.issuer,
      resource: PUBLIC_MCP_URL,
      users: [{ sub: MOCK_SUBJECT, userId: 'john', displayName: 'John' }],
    }),
    publicUrl: PUBLIC_ORIGIN,
    allowedOrigins: ['http://localhost:5173'],
    port: 0,
    spike: true,
    logSink: () => undefined,
  });
  return {
    relayUrl: relay.url,
    issuer: provider.issuer,
    close: async () => {
      await relay.close();
      await provider.stop();
    },
  };
}

describe("the latency run's sign-in", () => {
  it('follows the challenge, waits for the browser on loopback and connects with the token', async () => {
    const world = await startPublicRelay();
    try {
      const shown: URL[] = [];
      // Plays the owner's browser: the provider signs John in and redirects to the loopback callback.
      const browser = async (url: URL): Promise<void> => {
        const redirect = await fetch(url, { redirect: 'manual' });
        const location = redirect.headers.get('location');
        if (location === null) throw new Error('the provider did not redirect');
        const back = await fetch(location);
        expect(back.status).toBe(200);
        expect(await back.text()).toMatch(/Signed in/);
      };
      let browsed: Promise<void> = Promise.resolve();
      const client = await connectWithOAuth(PUBLIC_MCP_URL, {
        clientId: 'tabdock-spike-test',
        fetch: tunnelFetch(world.relayUrl),
        showSignIn: (url) => {
          shown.push(url);
          browsed = browser(url);
        },
      });
      try {
        await browsed;
        expect(shown).toHaveLength(1);
        const signIn = shown[0];
        expect(signIn?.origin).toBe(new URL(world.issuer).origin);
        expect(signIn?.searchParams.get('resource')).toBe(PUBLIC_MCP_URL);
        expect(signIn?.searchParams.get('code_challenge_method')).toBe('S256');
        expect(signIn?.searchParams.get('redirect_uri')).toMatch(
          /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
        );
        const listed = await client.callTool({ name: 'list_pages', arguments: {} });
        expect(listed.isError ?? false).toBe(false);
      } finally {
        await client.close();
      }
    } finally {
      await world.close();
    }
  });

  it('refuses a callback whose state does not match, and gives up when nobody signs in', async () => {
    const world = await startPublicRelay();
    try {
      let forged: Promise<number> = Promise.resolve(0);
      await expect(
        connectWithOAuth(PUBLIC_MCP_URL, {
          clientId: 'tabdock-spike-test',
          fetch: tunnelFetch(world.relayUrl),
          timeoutMs: 1500,
          showSignIn: (url) => {
            const callback = new URL(url.searchParams.get('redirect_uri') ?? '');
            callback.searchParams.set('code', 'forged');
            callback.searchParams.set('state', 'not-the-state');
            forged = fetch(callback).then((answer) => answer.status);
          },
        }),
      ).rejects.toThrow(/no sign-in came back/);
      expect(await forged).toBe(400);
    } finally {
      await world.close();
    }
  });
});

// A5.3 against the sim page, on both revisions (ADR 0026): the real adapter
// core on a page that chose confirmVia 'client', the real relay, and the SDK
// client 2.3.1 with its own elicitation handler. A member driver whose client
// declares form elicitation confirms a consequential call there and the page
// raises no prompt; a declined, dismissed, expired, replayed, forged or
// mismatched confirmation, or one from another account or OAuth client,
// answers not_confirmed and the page never hears of the call; a revoke while
// a question waits answers not_attached at once; a fifth question waiting
// answers rate_limited, and a restart voids every pending one. A page that
// did not opt in, an observer, an invitee, a member whose attachment an
// invite made and a client without the capability all get the page's own
// prompt and are never asked. The relay's frames, records and logs are held
// in packages/relay/test/confirm-calls.test.ts.

import { randomBytes } from 'node:crypto';
import {
  Client,
  type ElicitRequestFormParams,
  type ElicitResult,
  type FetchLike,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { PolicyInput } from '@tabdock/protocol';
import {
  createDevTokenAuth,
  createMemoryStore,
  createOAuthAuth,
  createRelay,
  type DevTokenUser,
  EMAIL_CLAIM,
  EMAIL_VERIFIED_CLAIM,
  type Relay,
  type RelayOptions,
} from '@tabdock/relay';
import { PAIR_CLIENT, startProvider, type TestProvider } from '@tabdock/relay/test/provider';
import { PUBLIC_MCP_URL, PUBLIC_ORIGIN, tunnelFetch } from '@tabdock/relay/test/tunnel';
import {
  createDefaultTools,
  DEFAULT_SIM_ORIGIN,
  type FakeToolDefinition,
  type SimPage,
  startSimPage,
} from '@tabdock/sim-page';
import { afterEach, describe, expect, it } from 'vitest';
import { callTool, deferred, delay, errorCode, type ToolOutcome } from './helpers.ts';

const OPTED_IN: PolicyInput = { consequential: 'confirm', confirmVia: 'client' };
const ACCEPT: ElicitResult = { action: 'accept', content: { confirm: true } };
const DECLINE: ElicitResult = { action: 'decline' };
const CANCEL: ElicitResult = { action: 'cancel' };

const ERAS = [
  ['a 2025-era session', false],
  ['2026-07-28', true],
] as const;

/** A consequential tool with arguments, so a confirmation can be given for other ones. */
function payTool(paid: { amount: number }[]): FakeToolDefinition {
  return {
    name: 'pay',
    title: 'Pay',
    description: 'Send money. This cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: { amount: { type: 'number' } },
      required: ['amount'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, consequentialHint: true },
    execute: (input) => {
      const amount = (input as { amount: number }).amount;
      paid.push({ amount });
      return { paid: amount };
    },
  };
}

function devUser(userId: string, displayName: string): DevTokenUser {
  return { userId, displayName, token: `${userId}-${randomBytes(24).toString('base64url')}` };
}

/** How a client reaches the relay: a dev token's bearer header, or OAuth tokens through the stand-in tunnel. */
interface Reach {
  url: string;
  authorization: () => Promise<string>;
  fetch?: FetchLike;
}

interface Asking {
  client: Client;
  asked: ElicitRequestFormParams[];
}

interface Bench {
  relay: Relay;
  reach(user: DevTokenUser): Reach;
  close(): Promise<void>;
}

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
});

const alice = devUser('alice', 'Alice');
const bob = devUser('bob', 'Bob');

async function devRelay(options: Partial<RelayOptions> = {}): Promise<Bench> {
  const relay = await createRelay({
    auth: createDevTokenAuth([alice, bob]),
    port: 0,
    allowMissingOrigin: false,
    logSink: () => undefined,
    firstClassTools: true,
    ...options,
  });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await relay.close();
  };
  closers.push(close);
  return {
    relay,
    reach: (user) => ({
      url: relay.mcpUrl,
      authorization: () => Promise.resolve(`Bearer ${user.token}`),
    }),
    close,
  };
}

async function page(
  relay: Relay,
  policy: PolicyInput = OPTED_IN,
  paid: { amount: number }[] = [],
): Promise<SimPage> {
  const sim = await startSimPage({
    relayUrl: relay.pageUrl,
    policy,
    tools: (store) => [...createDefaultTools(store), payTool(paid)],
  });
  closers.push(() => sim.close());
  await sim.waitFor((state) => state.link === 'linked' && state.pairing !== null);
  return sim;
}

/**
 * The SDK client 2.3.1, declaring form elicitation unless `capable` is
 * false, its handler answering every question with `answer`.
 */
async function asking(
  reach: Reach,
  modern: boolean,
  answer: (params: ElicitRequestFormParams) => ElicitResult | Promise<ElicitResult>,
  capable = true,
  name = 'claude-code',
): Promise<Asking> {
  const asked: ElicitRequestFormParams[] = [];
  const client = new Client(
    { name, version: '2.1.289' },
    {
      capabilities: capable ? { elicitation: { form: {} } } : {},
      ...(modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}),
    },
  );
  if (capable) {
    client.setRequestHandler('elicitation/create', async (request) => {
      const params = request.params as ElicitRequestFormParams;
      asked.push(params);
      return answer(params);
    });
  }
  await client.connect(
    new StreamableHTTPClientTransport(new URL(reach.url), {
      authProvider: { token: async () => (await reach.authorization()).slice('Bearer '.length) },
      ...(reach.fetch === undefined ? {} : { fetch: reach.fetch }),
    }),
  );
  closers.push(() => client.close());
  return { client, asked };
}

/** pair_page by the page's code, approved by the operator through the page's own handle. */
async function attach(client: Client, sim: SimPage, role: 'driver' | 'observer'): Promise<string> {
  const code = sim.state.pairing?.code ?? '';
  const pending = callTool(client, 'pair_page', { code });
  const state = await sim.waitFor((s) => s.pendingRequests.length > 0);
  const request = state.pendingRequests[0];
  if (!request) throw new Error('no attach request');
  expect(sim.dock.approve(request.requestId, role)).toBe(true);
  const outcome = await pending;
  expect(outcome.isError, outcome.text).toBe(false);
  await sim.waitFor((s) => s.pairing !== null && s.pairing.code !== code);
  return (outcome.structured as { page: string }).page;
}

function pay(client: Client, pageId: string, amount: number): Promise<ToolOutcome> {
  return callTool(client, 'call_page_tool', { page: pageId, tool: 'pay', arguments: { amount } });
}

/** What the page shows for a call: whether it prompted, and its activity entry for the tool. */
function onPage(sim: SimPage, tool: string): { prompted: boolean; confirmedBy: string | null } {
  const entry = sim.activity.find((each) => each.tool === tool);
  return {
    prompted: sim.prompts.some((prompt) => prompt.tool === tool),
    confirmedBy: entry?.confirmedBy ?? null,
  };
}

// Raw 2026-07-28 rounds, where a test must hold, replay or forge a requestState.

let nextId = 0;

interface RawAnswer {
  result?: {
    resultType?: string;
    requestState?: string;
    content?: { text?: string }[];
    isError?: boolean;
  };
}

async function rawCall(reach: Reach, params: Record<string, unknown>): Promise<RawAnswer> {
  nextId += 1;
  const send = reach.fetch ?? fetch;
  const response = await send(reach.url, {
    method: 'POST',
    headers: {
      Authorization: await reach.authorization(),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': String(params.name),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: nextId,
      method: 'tools/call',
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
        },
      },
    }),
  });
  return JSON.parse(await response.text()) as RawAnswer;
}

function rawCode(answer: RawAnswer): string | null {
  if (answer.result?.isError !== true) return null;
  return answer.result.content?.[0]?.text?.split(':', 1)[0] ?? null;
}

function payParams(pageId: string, amount: number): Record<string, unknown> {
  return {
    name: 'call_page_tool',
    arguments: { page: pageId, tool: 'pay', arguments: { amount } },
  };
}

async function firstRound(reach: Reach, params: Record<string, unknown>): Promise<string> {
  const answer = await rawCall(reach, params);
  expect(answer.result?.resultType, JSON.stringify(answer)).toBe('input_required');
  return answer.result?.requestState ?? '';
}

/**
 * The first Date.now() at which the SDK's codec refuses a state as expired.
 * The codec signs and does not encrypt, so the body is readable: its exp is
 * in whole Unix seconds, and verify refuses once the current second is past it.
 */
function codecRefusesFrom(state: string): number {
  const body = JSON.parse(Buffer.from(state.split('.')[1] ?? '', 'base64url').toString()) as {
    exp: number;
  };
  return (body.exp + 1) * 1000;
}

function retry(
  reach: Reach,
  params: Record<string, unknown>,
  requestState: unknown,
  answer: ElicitResult = ACCEPT,
): Promise<RawAnswer> {
  return rawCall(reach, { ...params, requestState, inputResponses: { confirm: answer } });
}

/**
 * The state with its MAC's first character changed, so it always carries
 * another MAC. Changing the last characters may not: base64url decoding
 * drops the last one's two low bits, and one MAC in 1,024 already ends in AA.
 */
function tampered(state: string): string {
  const dot = state.lastIndexOf('.');
  const mac = state.slice(dot + 1);
  return `${state.slice(0, dot + 1)}${mac.startsWith('A') ? 'B' : 'A'}${mac.slice(1)}`;
}

describe.each(ERAS)('A5.3 against the sim page (%s)', (_label, modern) => {
  it('runs a call the member driver confirmed in the client, with no page prompt, and the page shows it confirmed in the client', async () => {
    const bench = await devRelay();
    const paid: { amount: number }[] = [];
    const sim = await page(bench.relay, OPTED_IN, paid);
    const you = await asking(bench.reach(alice), modern, () => ACCEPT);
    const pageId = await attach(you.client, sim, 'driver');

    const outcome = await pay(you.client, pageId, 12);
    expect(outcome.isError, outcome.text).toBe(false);
    expect(outcome.structured).toEqual({ paid: 12 });
    expect(you.asked).toHaveLength(1);
    expect(paid).toEqual([{ amount: 12 }]);
    expect(onPage(sim, 'pay')).toEqual({ prompted: false, confirmedBy: 'client' });
    expect(bench.relay.audit.records().at(-1)).toMatchObject({
      tool: 'pay',
      outcome: 'ok',
      confirmedBy: 'client',
    });
  });

  it.each([
    ['declined', DECLINE],
    ['cancelled', CANCEL],
  ])(
    'answers a question %s not_confirmed, and the page neither prompts nor runs the call',
    async (_how, answer) => {
      const bench = await devRelay();
      const paid: { amount: number }[] = [];
      const sim = await page(bench.relay, OPTED_IN, paid);
      const you = await asking(bench.reach(alice), modern, () => answer);
      const pageId = await attach(you.client, sim, 'driver');
      const outcome = await pay(you.client, pageId, 5);
      expect(errorCode(outcome), outcome.text).toBe('not_confirmed');
      expect(paid).toEqual([]);
      expect(sim.prompts).toEqual([]);
      expect(sim.activity).toEqual([]);
    },
  );

  it('answers a question nobody answers in time not_confirmed', async () => {
    // On the 2026-07-28 leg what this proves is the record's own expiry, so
    // the late retry must carry a state the SDK codec still accepts: the
    // codec would otherwise refuse it first, with the same not_confirmed,
    // and a relay that kept expired records would pass. The codec counts
    // whole seconds from the second a state was minted in, its TTL the
    // record's rounded up, so it accepts a state for more than
    // ceil(ttl / 1000) * 1000 ms. A TTL just past a whole second leaves the
    // most room between the two: 1001 ms for the record, more than 2000 ms
    // for its state. The 2025-era question waits the same TTL either way.
    const ttlMs = 1001;
    const bench = await devRelay({ timings: { confirmationTtlMs: ttlMs } });
    const paid: { amount: number }[] = [];
    const sim = await page(bench.relay, OPTED_IN, paid);
    const held = deferred<ElicitResult>();
    const you = await asking(bench.reach(alice), false, () => held.promise);
    const pageId = await attach(you.client, sim, 'driver');
    let outcome: string | null;
    if (modern) {
      const reach = bench.reach(alice);
      const state = await firstRound(reach, payParams(pageId, 5));
      // Past the record's TTL counted from after the record was made, which
      // the first round's answer follows.
      await delay(ttlMs + 10);
      const late = await retry(reach, payParams(pageId, 5), state);
      // The bound this relies on: from the state's minting, the first round's
      // answer, the wait's lateness and the whole retry have more than
      // 2000 - 1011 = 989 ms to come back before the codec would refuse the
      // state. Past that this run could not tell the two expiries apart, so
      // it fails rather than pass on the codec's refusal.
      expect(
        Date.now(),
        'the retry must come back before the codec expires its state',
      ).toBeLessThan(codecRefusesFrom(state));
      outcome = rawCode(late);
    } else {
      outcome = errorCode(await pay(you.client, pageId, 5));
    }
    held.resolve(ACCEPT);
    expect(outcome).toBe('not_confirmed');
    expect(paid).toEqual([]);
    expect(sim.prompts).toEqual([]);
  });

  it('answers a call waiting on its question not_attached at once when the operator revokes', async () => {
    const bench = await devRelay();
    const paid: { amount: number }[] = [];
    const sim = await page(bench.relay, OPTED_IN, paid);
    const held = deferred<ElicitResult>();
    const you = await asking(bench.reach(alice), modern, () => held.promise);
    const pageId = await attach(you.client, sim, 'driver');
    let outcome: string | null;
    if (modern) {
      const reach = bench.reach(alice);
      const state = await firstRound(reach, payParams(pageId, 5));
      expect(sim.revoke('alice')).toBe(true);
      await sim.waitFor((s) => s.roster.length === 0);
      outcome = rawCode(await retry(reach, payParams(pageId, 5), state));
    } else {
      const pending = pay(you.client, pageId, 5);
      while (you.asked.length === 0) await delay(10);
      const started = performance.now();
      expect(sim.revoke('alice')).toBe(true);
      outcome = errorCode(await pending);
      expect(performance.now() - started).toBeLessThan(5000);
    }
    held.resolve(ACCEPT);
    expect(outcome).toBe('not_attached');
    expect(paid).toEqual([]);
    expect(sim.prompts).toEqual([]);
  });

  it('answers a fifth question waiting for one user rate_limited', async () => {
    const bench = await devRelay();
    const paid: { amount: number }[] = [];
    const sim = await page(bench.relay, OPTED_IN, paid);
    const held = deferred<ElicitResult>();
    const you = await asking(bench.reach(alice), modern, () => held.promise);
    const pageId = await attach(you.client, sim, 'driver');
    const reach = bench.reach(alice);
    const waiting: Promise<unknown>[] = [];
    for (let amount = 1; amount <= 4; amount += 1) {
      if (modern) await firstRound(reach, payParams(pageId, amount));
      else waiting.push(pay(you.client, pageId, amount));
    }
    if (!modern) while (you.asked.length < 4) await delay(10);
    const fifth = modern
      ? rawCode(await rawCall(reach, payParams(pageId, 5)))
      : errorCode(await pay(you.client, pageId, 5));
    expect(fifth).toBe('rate_limited');
    held.resolve(DECLINE);
    await Promise.all(waiting);
    expect(paid).toEqual([]);
    expect(sim.prompts).toEqual([]);
  });

  it.each([
    ['a page that did not opt in', 'page'],
    ['an observer', 'observer'],
    ['a client without form elicitation', 'incapable'],
  ] as const)('gives %s the page prompt and never asks the client', async (_who, kind) => {
    const bench = await devRelay();
    const paid: { amount: number }[] = [];
    const policy: PolicyInput =
      kind === 'page' ? { consequential: 'confirm', confirmVia: 'page' } : OPTED_IN;
    // The observer calls a read-only tool the page names consequential, which an observer may call.
    const sim = await startSimPage({
      relayUrl: bench.relay.pageUrl,
      policy: { ...policy, consequentialTools: ['get_value'] },
      tools: (store) => [...createDefaultTools(store), payTool(paid)],
    });
    closers.push(() => sim.close());
    await sim.waitFor((state) => state.link === 'linked' && state.pairing !== null);
    const you = await asking(bench.reach(alice), modern, () => ACCEPT, kind !== 'incapable');
    const pageId = await attach(you.client, sim, kind === 'observer' ? 'observer' : 'driver');
    const tool = kind === 'observer' ? 'get_value' : 'pay';
    const pending = callTool(you.client, 'call_page_tool', {
      page: pageId,
      tool,
      arguments: tool === 'pay' ? { amount: 3 } : {},
    });
    const state = await sim.waitFor((s) => s.pendingConfirms.length > 0);
    const [prompt] = state.pendingConfirms;
    if (!prompt) throw new Error('no prompt');
    expect(prompt.tool).toBe(tool);
    expect(sim.dock.confirm(prompt.callId, true)).toBe(true);
    const outcome = await pending;
    expect(outcome.isError, outcome.text).toBe(false);
    expect(you.asked).toEqual([]);
    expect(onPage(sim, tool)).toEqual({ prompted: true, confirmedBy: null });
    expect(bench.relay.audit.records().at(-1)).not.toHaveProperty('confirmedBy');
  });
});

describe('A5.3: a 2026-07-28 retry against the sim page', () => {
  async function opened(): Promise<{
    bench: Bench;
    sim: SimPage;
    pageId: string;
    paid: { amount: number }[];
  }> {
    const bench = await devRelay();
    const paid: { amount: number }[] = [];
    const sim = await page(bench.relay, OPTED_IN, paid);
    const you = await asking(bench.reach(alice), false, () => DECLINE, false);
    const pageId = await attach(you.client, sim, 'driver');
    return { bench, sim, pageId, paid };
  }

  it('answers a replay, a forged requestState, another user and changed arguments not_confirmed, and the page never hears of them', async () => {
    const { bench, sim, pageId, paid } = await opened();
    const bobs = await asking(bench.reach(bob), false, () => DECLINE, false);
    await attach(bobs.client, sim, 'driver');
    const reach = bench.reach(alice);

    const confirmed = await firstRound(reach, payParams(pageId, 1));
    expect(rawCode(await retry(reach, payParams(pageId, 1), confirmed))).toBeNull();
    expect(paid).toEqual([{ amount: 1 }]);
    // Replayed: the record went with the first retry.
    expect(rawCode(await retry(reach, payParams(pageId, 1), confirmed))).toBe('not_confirmed');

    const state = await firstRound(reach, payParams(pageId, 2));
    expect(rawCode(await retry(reach, payParams(pageId, 2), tampered(state)))).toBe(
      'not_confirmed',
    );
    expect(rawCode(await retry(reach, payParams(pageId, 2), 7))).toBe('not_confirmed');
    expect(rawCode(await retry(bench.reach(bob), payParams(pageId, 2), state))).toBe(
      'not_confirmed',
    );
    expect(rawCode(await retry(reach, payParams(pageId, 2000), state))).toBe('not_confirmed');

    expect(paid).toEqual([{ amount: 1 }]);
    expect(sim.prompts).toEqual([]);
  });

  it('answers a state from before a restart not_confirmed, once the page has resumed', async () => {
    const store = createMemoryStore();
    const first = await devRelay({ store });
    const paid: { amount: number }[] = [];
    const sim = await page(first.relay, OPTED_IN, paid);
    const you = await asking(first.reach(alice), false, () => DECLINE, false);
    const pageId = await attach(you.client, sim, 'driver');
    const state = await firstRound(first.reach(alice), payParams(pageId, 9));
    const port = Number(new URL(first.relay.url).port);
    await first.close();
    const second = await devRelay({ store, port });
    // The adapter reconnects with its resume token and keeps its page id and attachments.
    await sim.waitFor((s) => s.link === 'linked' && s.pageId === pageId, 20_000);
    const after = await retry(second.reach(alice), payParams(pageId, 9), state);
    expect(rawCode(after), JSON.stringify(after)).toBe('not_confirmed');
    expect(paid).toEqual([]);
    expect(sim.prompts).toEqual([]);
  });
});

describe('A5.3 with OAuth sign-in and invites, against the sim page', () => {
  interface PublicBench {
    relay: Relay;
    provider: TestProvider;
    reach(sub: string, clientId?: string, email?: string): Reach;
  }

  async function publicRelay(): Promise<PublicBench> {
    const provider = await startProvider();
    closers.push(() => provider.stop());
    const relay = await createRelay({
      auth: createOAuthAuth({
        issuer: provider.issuer,
        resource: PUBLIC_MCP_URL,
        users: [
          { sub: 'sub-alice', userId: 'alice', displayName: 'Alice' },
          { sub: 'sub-bob', userId: 'bob', displayName: 'Bob' },
        ],
      }),
      publicUrl: PUBLIC_ORIGIN,
      pairClient: PAIR_CLIENT,
      allowedOrigins: [DEFAULT_SIM_ORIGIN],
      invites: true,
      firstClassTools: true,
      port: 0,
      logSink: () => undefined,
    });
    closers.push(() => relay.close());
    const tunnel = tunnelFetch(relay.url);
    return {
      relay,
      provider,
      reach: (sub, clientId = 'https://claude.ai/oauth/mcp-client', email) => ({
        url: PUBLIC_MCP_URL,
        fetch: tunnel,
        authorization: async () =>
          `Bearer ${await provider.token({
            sub,
            aud: PUBLIC_MCP_URL,
            client_id: clientId,
            ...(email === undefined ? {} : { [EMAIL_CLAIM]: email, [EMAIL_VERIFIED_CLAIM]: true }),
          })}`,
      }),
    };
  }

  /** A Can control invite minted on the page, redeemed by `client` and approved as driver. */
  async function joinByInvite(sim: SimPage, client: Client): Promise<void> {
    const minted = await sim.invite({ label: 'Pair session', role: 'driver' });
    if (!minted.ok) throw new Error(`no invite: ${JSON.stringify(minted)}`);
    const pending = callTool(client, 'pair_page', { invite: minted.link });
    const state = await sim.waitFor((s) => s.pendingRequests.length > 0);
    const request = state.pendingRequests[0];
    if (!request) throw new Error('no attach request');
    expect(sim.dock.approve(request.requestId, 'driver')).toBe(true);
    const outcome = await pending;
    expect(outcome.isError, outcome.text).toBe(false);
  }

  it('answers a retry from another OAuth client of the same account not_confirmed', async () => {
    const bench = await publicRelay();
    const paid: { amount: number }[] = [];
    const sim = await page(bench.relay, OPTED_IN, paid);
    const you = await asking(bench.reach('sub-alice'), false, () => DECLINE, false);
    const pageId = await attach(you.client, sim, 'driver');
    const claude = bench.reach('sub-alice');
    const other = bench.reach('sub-alice', 'https://other.example/client');
    const state = await firstRound(claude, payParams(pageId, 4));
    expect(rawCode(await retry(other, payParams(pageId, 4), state))).toBe('not_confirmed');
    expect(paid).toEqual([]);
    expect(sim.prompts).toEqual([]);
  });

  it.each(ERAS)(
    'gives an invitee and a member whose attachment an invite made the page prompt, and never asks them (%s)',
    async (_label, modern) => {
      const bench = await publicRelay();
      const paid: { amount: number }[] = [];
      const sim = await page(bench.relay, { ...OPTED_IN, invites: 'all', maxDrivers: 3 }, paid);
      const owner = await asking(bench.reach('sub-alice'), false, () => DECLINE, false);
      await attach(owner.client, sim, 'driver');
      const guest = await asking(
        bench.reach('sub-guest', undefined, 'guest@example.com'),
        modern,
        () => ACCEPT,
        true,
        'guest-client',
      );
      const member = await asking(bench.reach('sub-bob'), modern, () => ACCEPT, true, 'bob-client');
      await joinByInvite(sim, guest.client);
      await joinByInvite(sim, member.client);
      const pageId = sim.state.pageId ?? '';
      for (const [index, caller] of [guest, member].entries()) {
        const pending = pay(caller.client, pageId, index + 1);
        const state = await sim.waitFor((s) => s.pendingConfirms.length > 0);
        const [prompt] = state.pendingConfirms;
        if (!prompt) throw new Error('no prompt');
        expect(sim.dock.confirm(prompt.callId, true)).toBe(true);
        const outcome = await pending;
        expect(outcome.isError, outcome.text).toBe(false);
      }
      expect(guest.asked).toEqual([]);
      expect(member.asked).toEqual([]);
      expect(paid).toEqual([{ amount: 1 }, { amount: 2 }]);
      expect(sim.prompts.map((prompt) => prompt.tool)).toEqual(['pay', 'pay']);
      expect(sim.activity.every((entry) => entry.confirmedBy === null)).toBe(true);
    },
  );
});

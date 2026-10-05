// Lines a signed-in account can make /mcp write at will (A4.3, second pass).
// Sign-up is open, so any stranger has an account, and requests the SDK
// refuses, initializes the relay refuses or makes room for, and sessions
// opened and dropped in a loop spend no request budget. Each wrote a line, and
// the SDK's refusals quote the request's own method, version and headers, so
// one account wrote 40 MB to stderr in two seconds: the copy that carries the
// audit checkpoints and, while the audit disk fails, the records themselves
// (ADR 0019). Now such lines are written once per kind a window, with the
// rest counted, an error's message is cut short, and a 2026-07-28 request the
// SDK refuses costs one request of its caller's budget. The final pass found
// three such kinds no test held (refused listens, proxied requests, the Node
// adapter's errors), a call its client abandons charged twice by a mutation
// no test caught, and the S13 line for a stolen session id sharing the
// per-kind budget, so a decoy could leave a real presenter unnamed. The last
// M4 hunt found the 2026-07-28 requests the SDK serves, tools/list and
// server/discover among them, and a tools/call it answers with an error in a
// 200, still free: each builds a server of its own, and 50 tools/list passed a
// budget of 3. Now every 2026-07-28 request spends once, as it arrives, but a
// listen, which spends where it lands (ADR 0030); the review of M5 Step 1
// found a tools/call with an unknown name or a requestState that is not a
// string still free, and now every tools/call spends as it arrives too, a
// fixed tool spending nothing more (ADR 0032).

import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createDevTokenAuth, DEFAULT_RATE_LIMITS, type DevTokenUser } from '../src/index.ts';
import { connectPage, type TestPage, TOOLS } from './helpers/page-client.ts';
import {
  initializeBody,
  openListen,
  openSession,
  openStream,
  type OpenStream,
  rawPost,
} from './helpers/raw-mcp.ts';
import {
  ALICE,
  atWindowStart,
  BOB,
  CAROL,
  callTool,
  connectClient,
  delay,
  eventually,
  pairAndApprove,
  startRelay,
  type TestRelay,
} from './helpers/relay.ts';
import { rawRequest } from './helpers/tunnel.ts';

function invitee(n: number): DevTokenUser {
  return {
    userId: `g_${n.toString(16).padStart(32, '0')}`,
    displayName: 'ignored',
    token: `invitee-${String(n)}-dev-token-5a8c1e7f2b9d4063`,
    kind: 'invitee',
  };
}
const G1 = invitee(1);
const G2 = invitee(2);

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'flood', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

let current: TestRelay | undefined;
const streams: OpenStream[] = [];
const clients: Client[] = [];
const pages: TestPage[] = [];

afterEach(async () => {
  for (const stream of streams.splice(0)) stream.close();
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const page of pages.splice(0)) page.ws.terminate();
  await current?.close();
  current = undefined;
});

async function setup(options: Parameters<typeof startRelay>[0] = {}): Promise<TestRelay> {
  // The tests here count what one window wrote, and the window is the clock's
  // own minute, so each starts one: one ending mid-test would write a second
  // first line and split the count.
  atWindowStart();
  current = await startRelay({
    auth: createDevTokenAuth([ALICE, G1, G2]),
    invites: true,
    // The production default.
    logLevel: 'info',
    ...options,
  });
  return current;
}

/** A 2026-07-28 POST as G1, with these headers over the usual ones; its status. */
async function modernPost(
  user: DevTokenUser,
  headers: Record<string, string>,
  body: string,
): Promise<number> {
  if (!current) throw new Error('no relay');
  const response = await fetch(current.relay.mcpUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Protocol-Version': '2026-07-28',
      ...headers,
    },
    body,
  });
  await response.text();
  return response.status;
}

/**
 * A well-formed 2026-07-28 request as G1 or another user, its headers as the
 * SDK client sends them; its status and the body's text.
 */
async function modernRequest(
  user: DevTokenUser,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ status: number; text: string }> {
  if (!current) throw new Error('no relay');
  const name = typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {};
  const response = await fetch(current.relay.mcpUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Protocol-Version': '2026-07-28',
      'Mcp-Method': method,
      ...name,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: META } }),
  });
  return { status: response.status, text: await response.text() };
}

interface Entry {
  msg: string;
  repeated?: number;
  [field: string]: unknown;
}

function entries(lines: readonly string[]): Entry[] {
  return lines.map((line) => JSON.parse(line) as Entry);
}

/** Lines written in full under this message, and the count the summaries carry for it. */
function tally(lines: readonly string[], message: string): { written: number; repeated: number } {
  const all = entries(lines);
  return {
    written: all.filter((entry) => entry.msg === message).length,
    repeated: all
      .filter((entry) => entry.msg.startsWith(message) && entry.msg.endsWith(', repeated'))
      .reduce((sum, entry) => sum + (entry.repeated ?? 0), 0),
  };
}

describe('lines a signed-in account can make /mcp write (A4.3)', () => {
  // A timeout of its own: thirty bodies of 2 MB, each sent, read and parsed
  // before the SDK refuses it, take about 2 s alone and went past vitest's
  // default 5 s beside two other runs of this package's tests on four cores.
  it('writes the SDK refusals of large requests once a window, cut short, and counts the rest', async () => {
    const { lines } = await setup();
    const before = lines.length;
    const big = 'A'.repeat(2 * 1024 * 1024 - 1000);
    const cases: [Record<string, string>, string][] = [
      // A method name that disagrees with Mcp-Method.
      [
        { 'Mcp-Method': 'x' },
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: big, params: { _meta: META } }),
      ],
      // A protocol version that disagrees with the header.
      [
        {},
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: { _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': big } },
        }),
      ],
      // A method with no Mcp-Method header at all.
      [{}, JSON.stringify({ jsonrpc: '2.0', id: 1, method: big, params: { _meta: META } })],
    ];
    for (const [headers, body] of cases) {
      for (let i = 0; i < 10; i += 1) expect(await modernPost(G1, headers, body)).toBe(400);
    }
    const flood = lines.slice(before);
    // About 40 MB before; a few short lines now.
    expect(flood.join('\n').length).toBeLessThan(4096);
    for (const line of flood) expect(line.length).toBeLessThan(1024);
    await current?.close();
    const { written, repeated } = tally(lines.slice(before), 'mcp handler error');
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThanOrEqual(cases.length);
    // Every refusal is either written or counted.
    expect(written + repeated).toBe(30);
  }, 30_000);

  it('writes small SDK refusals once a window too, however many come, and those past the budget never reach it', async () => {
    const { lines } = await setup();
    const before = lines.length;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: META },
    });
    const statuses = await Promise.all(
      Array.from({ length: 200 }, () => modernPost(G1, { 'Mcp-Method': 'x' }, body)),
    );
    // Each spends a request as it arrives (ADR 0030): an invitee's minute
    // reaches the SDK, which refuses each, and the relay refuses the rest.
    const { requestsPerInvitee } = DEFAULT_RATE_LIMITS;
    expect(statuses.filter((status) => status === 400)).toHaveLength(requestsPerInvitee);
    expect(statuses.filter((status) => status === 429)).toHaveLength(200 - requestsPerInvitee);
    expect(tally(lines.slice(before), 'mcp handler error').written).toBe(1);
    await current?.close();
    expect(tally(lines.slice(before), 'mcp handler error')).toEqual({
      written: 1,
      repeated: requestsPerInvitee - 1,
    });
    expect(tally(lines.slice(before), 'mcp request refused: past the request budget')).toEqual({
      written: 1,
      repeated: 200 - requestsPerInvitee - 1,
    });
  });

  it("counts each 2026-07-28 request the SDK refuses against its caller's request budget, once", async () => {
    const relay = await setup({ rateLimits: { requestsPerInvitee: 3 } });
    const request = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: META },
    });
    // One request, spent as it arrives, that the SDK then refuses: once, not twice.
    expect(await modernPost(G1, { 'Mcp-Method': 'x' }, request)).toBe(400);
    // A batch and a refused Content-Type are no one request: they spend
    // nothing as they arrive, and one each when the SDK refuses them.
    expect(await modernPost(G1, {}, `[${request}]`)).toBe(400);
    expect(await modernPost(G1, { 'Content-Type': 'text/plain' }, request)).toBe(415);
    const listed = await modernRequest(G1, 2, 'tools/call', { name: 'list_pages', arguments: {} });
    expect(listed.status).toBe(200);
    expect(listed.text).toMatch(/rate_limited: more than 3 requests/);
    // Another account's budget is its own.
    const g2 = await connectClient(relay.relay, G2, { modern: true });
    clients.push(g2);
    expect((await callTool(g2, 'list_pages')).isError).toBe(false);
  });

  it('spends a request of the budget on every 2026-07-28 tools/list and refuses those past it 429 (ADR 0030)', async () => {
    const relay = await setup({ rateLimits: { requestsPerUser: 3 } });
    const before = relay.lines.length;
    const answers = [];
    for (let id = 1; id <= 50; id += 1) answers.push(await modernRequest(ALICE, id, 'tools/list'));
    // Three answered with the list, as M4 answered all fifty.
    for (const answer of answers.slice(0, 3)) {
      expect(answer.status).toBe(200);
      expect(answer.text).toContain('"list_pages"');
    }
    // The rest refused before the SDK saw them, in the budget's own words, each with its own id.
    answers.slice(3).forEach((answer, index) => {
      expect(answer.status).toBe(429);
      expect(JSON.parse(answer.text)).toEqual({
        jsonrpc: '2.0',
        id: index + 4,
        error: {
          code: -32000,
          message: 'more than 3 requests to this relay in 1 minute; wait and try again',
        },
      });
    });
    // So list_pages, which still answered in M4, is refused too.
    const listed = await modernRequest(ALICE, 51, 'tools/call', {
      name: 'list_pages',
      arguments: {},
    });
    expect(listed.text).toMatch(/rate_limited: more than 3 requests/);
    // They asked nothing of a page, so they leave no audit record, only list_pages its own
    // refusal; and one line a window.
    expect(relay.relay.audit.events()).toEqual([
      expect.objectContaining({ type: 'request_refused', tool: 'list_pages' }),
    ]);
    const message = 'mcp request refused: past the request budget';
    expect(tally(relay.lines.slice(before), message).written).toBe(1);
    await current?.close();
    expect(tally(relay.lines.slice(before), message)).toEqual({ written: 1, repeated: 46 });
  });

  it('spends a request on a 2026-07-28 tools/call the SDK refuses before any tool runs, as on server/discover (ADR 0030)', async () => {
    const relay = await setup({ rateLimits: { requestsPerUser: 3 } });
    // server/discover, as a client sends it on connecting, and the SDK serves it.
    expect((await modernRequest(ALICE, 1, 'server/discover')).status).toBe(200);
    // A tools/call with no name: the SDK answers it an error in a 200, and in M4 it cost nothing.
    const nameless = [];
    for (let id = 2; id <= 6; id += 1) {
      nameless.push(await modernRequest(ALICE, id, 'tools/call', { arguments: {} }));
    }
    expect(nameless.map((answer) => answer.status)).toEqual([200, 200, 429, 429, 429]);
    expect(nameless[0]?.text).toMatch(/Invalid tools\/call request/);
    expect(nameless[2]?.text).toMatch(/more than 3 requests to this relay/);
    const listed = await modernRequest(ALICE, 7, 'tools/call', {
      name: 'list_pages',
      arguments: {},
    });
    expect(listed.text).toMatch(/rate_limited: more than 3 requests/);
    expect(relay.relay.audit.events()).toEqual([
      expect.objectContaining({ type: 'request_refused', tool: 'list_pages' }),
    ]);
  });

  it('spends a request on a 2026-07-28 tools/call naming a tool the relay does not serve, and refuses those past the budget (ADR 0030)', async () => {
    const relay = await setup({ rateLimits: { requestsPerUser: 3 } });
    const unknown = [];
    for (let id = 1; id <= 6; id += 1) {
      unknown.push(await modernRequest(ALICE, id, 'tools/call', { name: 'nope', arguments: {} }));
    }
    // The SDK answers an unknown name with an error in a 200, which in Step 1
    // cost nothing, so twenty passed a budget of 3.
    expect(unknown.map((answer) => answer.status)).toEqual([200, 200, 200, 429, 429, 429]);
    expect(unknown[0]?.text).toMatch(/Tool nope not found/);
    expect(unknown[3]?.text).toMatch(/more than 3 requests to this relay/);
    const listed = await modernRequest(ALICE, 7, 'tools/call', {
      name: 'list_pages',
      arguments: {},
    });
    expect(listed.status).toBe(200);
    expect(listed.text).toMatch(/rate_limited: more than 3 requests/);
    // list_pages, refused in its own tool, keeps its record; the unknown names asked nothing of a page.
    expect(relay.relay.audit.events()).toEqual([
      expect.objectContaining({ type: 'request_refused', tool: 'list_pages' }),
    ]);
  });

  it('spends one request, not two, on a 2026-07-28 call to a fixed tool, which refuses one past the budget in its own words and with its record', async () => {
    const relay = await setup({ rateLimits: { requestsPerUser: 3 } });
    const answers = [];
    for (let id = 1; id <= 4; id += 1) {
      answers.push(
        await modernRequest(ALICE, id, 'tools/call', { name: 'list_pages', arguments: {} }),
      );
    }
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 200]);
    for (const answer of answers.slice(0, 3)) expect(answer.text).not.toMatch(/rate_limited/);
    expect(answers[3]?.text).toMatch(/rate_limited: more than 3 requests/);
    expect(relay.relay.audit.events()).toEqual([
      expect.objectContaining({ type: 'request_refused', tool: 'list_pages' }),
    ]);
  });

  it('spends a request on a 2026-07-28 tools/call whose requestState is not a string, which the SDK refuses before any tool runs (ADR 0030)', async () => {
    await setup({ rateLimits: { requestsPerUser: 3 } });
    const answers = [];
    for (const [id, requestState] of [
      [1, 5],
      [2, null],
      [3, 5],
      [4, null],
    ] as const) {
      answers.push(
        await modernRequest(ALICE, id, 'tools/call', {
          name: 'list_pages',
          arguments: {},
          requestState,
        }),
      );
    }
    // The SDK refuses each with a frozen -32602 in a 200, before list_pages runs and spends.
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 429]);
    expect(answers[0]?.text).toMatch(/Invalid or expired requestState/);
    expect(answers[1]?.text).toMatch(/Invalid or expired requestState/);
    const listed = await modernRequest(ALICE, 5, 'tools/call', {
      name: 'list_pages',
      arguments: {},
    });
    expect(listed.text).toMatch(/rate_limited: more than 3 requests/);
  });

  it('writes refused 2025-era initializes once per reason a window, and counts the rest', async () => {
    const { relay, lines } = await setup({
      limits: { inviteeSessions: 1 },
      // So the listening stream's headers go out at once.
      timings: { sseKeepAliveMs: 50 },
    });
    // One stranger holds the pool's one session, busy with its listening stream.
    const held = await openSession(relay, G1);
    streams.push(await openStream(relay, G1, held));
    const before = lines.length;
    for (let i = 0; i < 50; i += 1) {
      const response = await rawPost(relay, G2, initializeBody());
      await response.text();
      expect(response.status).toBe(503);
    }
    const message = 'MCP session refused: invitees hold the most sessions allowed';
    expect(tally(lines.slice(before), message).written).toBe(1);
    await current?.close();
    expect(tally(lines.slice(before), message)).toEqual({ written: 1, repeated: 49 });
  });

  it('writes the sessions a loop of initializes opens and drops once per reason a window', async () => {
    const { relay, lines } = await setup({ limits: { sessionsPerUser: 1 } });
    const before = lines.length;
    // Each new session of one user ends that user's idle one, which used to write a line.
    for (let i = 0; i < 40; i += 1) await openSession(relay, ALICE);
    const message = 'MCP session closed';
    expect(tally(lines.slice(before), message).written).toBe(1);
    await current?.close();
    // The 39 the loop ended, and the last one at shutdown.
    expect(tally(lines.slice(before), message)).toEqual({ written: 2, repeated: 38 });
  });

  it('writes listens refused past the request budget once a window, and counts the rest', async () => {
    const { relay, lines } = await setup({ rateLimits: { requestsPerInvitee: 1 } });
    const served = await openListen(relay, G1);
    streams.push(served);
    expect(served.streaming).toBe(true);
    const before = lines.length;
    for (let i = 0; i < 50; i += 1) {
      const refused = await openListen(relay, G1);
      streams.push(refused);
      expect(refused.text).toMatch(/more than 1 requests to this relay/);
    }
    const message = 'listen stream refused: past the request budget';
    expect(tally(lines.slice(before), message).written).toBe(1);
    await current?.close();
    expect(tally(lines.slice(before), message)).toEqual({ written: 1, repeated: 49 });
  });

  it('writes the refusals of requests made through a proxy once a window, and counts the rest', async () => {
    const { relay, lines } = await setup();
    const before = lines.length;
    for (let i = 0; i < 40; i += 1) {
      const answer = await rawRequest(relay.url, '/mcp', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ALICE.token}`,
          'Content-Type': 'application/json',
          'X-Forwarded-For': `203.0.113.${String(i)}`,
        },
        body: JSON.stringify(initializeBody()),
      });
      expect(answer.status).toBe(403);
    }
    const message = 'mcp request refused: not made on this machine';
    expect(tally(lines.slice(before), message).written).toBe(1);
    await current?.close();
    expect(tally(lines.slice(before), message)).toEqual({ written: 1, repeated: 39 });
  });

  it("writes the Node adapter's errors once a window, and counts the rest", async () => {
    const { relay, lines } = await setup();
    const before = lines.length;
    // TRACE passes sign-in, and then the SDK's adapter cannot make a web Request of it.
    for (let i = 0; i < 30; i += 1) {
      const answer = await rawRequest(relay.url, '/mcp', {
        method: 'TRACE',
        headers: { Authorization: `Bearer ${ALICE.token}` },
      });
      expect(answer.status).toBe(500);
    }
    const message = 'mcp adapter error';
    expect(tally(lines.slice(before), message).written).toBe(1);
    await current?.close();
    expect(tally(lines.slice(before), message)).toEqual({ written: 1, repeated: 29 });
  });

  it('charges a 2026-07-28 call its client abandons one request, as the tool did, and no more', async () => {
    const relay = await setup({
      rateLimits: { requestsPerUser: 5 },
      timings: { callDeadlineMs: 10_000 },
    });
    // The page holds every call, so only the client's leaving ends this one.
    const page = await connectPage(relay.relay.pageUrl, { tools: TOOLS });
    pages.push(page);
    // The first request: the client's server/discover as it connects (ADR 0030).
    const alice = await connectClient(relay.relay, ALICE, { modern: true });
    clients.push(alice);
    // The second.
    await pairAndApprove(alice, page);
    const abort = new AbortController();
    // The third, which the SDK answers 499 once its client has gone.
    const abandoned = alice
      .callTool(
        { name: 'call_page_tool', arguments: { page: page.pageId, tool: 'get_view' } },
        { signal: abort.signal },
      )
      .then(
        () => 'answered',
        () => 'rejected',
      );
    await page.next('invoke');
    abort.abort();
    expect(await abandoned).toBe('rejected');
    await page.next('cancel');
    await eventually(() => relay.relay.audit.records().length === 1);
    // Room for the 499 to come back through the relay before the next requests.
    await delay(200);
    // The fourth and the fifth: had the 499 cost one more, the fifth would be refused.
    expect((await callTool(alice, 'list_pages')).isError).toBe(false);
    const fourth = await callTool(alice, 'list_pages');
    expect(fourth.text).not.toMatch(/^rate_limited: /);
    expect(fourth.isError).toBe(false);
  });

  it("names each user who presents another user's session id, however many others do (S13)", async () => {
    const { relay, lines } = await setup({
      auth: createDevTokenAuth([ALICE, BOB, CAROL, G1, G2]),
    });
    const decoy = await openSession(relay, G1);
    const alices = await openSession(relay, ALICE);
    const before = lines.length;
    const present = async (user: DevTokenUser, sessionId: string, times: number): Promise<void> => {
      for (let i = 0; i < times; i += 1) {
        const response = await rawPost(
          relay,
          user,
          { jsonrpc: '2.0', id: 1, method: 'tools/list' },
          { sessionId },
        );
        await response.text();
        // The same answer as for an unknown id (S13).
        expect(response.status).toBe(404);
      }
    };
    // A decoy pair of accounts first, which used to spend the minute's only line.
    await present(G2, decoy, 5);
    await present(BOB, alices, 5);
    await present(CAROL, alices, 3);
    const message = 'MCP session id presented by another user';
    const named = (userId: string): number =>
      entries(lines.slice(before)).filter(
        (entry) => entry.msg === message && entry.userId === userId,
      ).length;
    expect(named(G2.userId)).toBe(3);
    expect(named(BOB.userId)).toBe(3);
    expect(named(CAROL.userId)).toBe(3);
    await current?.close();
    // The rest are counted by user, so every presenter is named in a line of its own.
    expect(
      entries(lines.slice(before))
        .filter((entry) => entry.msg === `${message}, repeated`)
        .map(({ userId, repeated }) => ({ userId, repeated })),
    ).toEqual([
      { userId: G2.userId, repeated: 2 },
      { userId: BOB.userId, repeated: 2 },
    ]);
  });
});

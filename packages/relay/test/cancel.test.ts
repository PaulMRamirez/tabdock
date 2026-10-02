// A client's cancellation reaches the page as cancel with reason client on both
// protocol eras, and a revoke (S8) answers the client's call with not_attached
// without closing its MCP session.

import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { connectPage, type TestPage, TOOLS } from './helpers/page-client.ts';
import {
  ALICE,
  callTool,
  connectClient,
  type ClientOptions,
  eventually,
  pairAndApprove,
  sessionIdOf,
  startRelay,
  type TestRelay,
} from './helpers/relay.ts';

let current: TestRelay | undefined;
const pages: TestPage[] = [];
const clients: Client[] = [];

async function setup(): Promise<{ relay: TestRelay; opened: TestPage }> {
  current = await startRelay({ timings: { callDeadlineMs: 10_000 } });
  // The page holds every call, so only a cancel or a revoke ends one.
  const opened = await connectPage(current.relay.pageUrl, { tools: TOOLS });
  pages.push(opened);
  return { relay: current, opened };
}

async function client(options: ClientOptions = {}): Promise<Client> {
  if (!current) throw new Error('no relay');
  const connected = await connectClient(current.relay, ALICE, options);
  clients.push(connected);
  return connected;
}

afterEach(async () => {
  for (const connected of clients.splice(0)) await connected.close();
  for (const opened of pages.splice(0)) opened.ws.terminate();
  await current?.close();
  current = undefined;
});

describe('cancellation reaches the page', () => {
  it.each([
    ['a 2025-era session client (notifications/cancelled)', false],
    ['a 2026-07-28 client (it drops its request stream)', true],
  ])('from %s', async (_label, modern) => {
    const { relay, opened } = await setup();
    const alice = await client({ modern, name: modern ? 'modern' : 'legacy' });
    await pairAndApprove(alice, opened);
    const abort = new AbortController();
    const pending = alice
      .callTool(
        { name: 'call_page_tool', arguments: { page: opened.pageId, tool: 'get_view' } },
        { signal: abort.signal },
      )
      .then(
        () => 'answered',
        () => 'rejected',
      );
    const invoke = await opened.next('invoke');
    abort.abort();
    expect(await pending).toBe('rejected');
    expect(await opened.next('cancel')).toEqual({
      t: 'cancel',
      callId: invoke.callId,
      reason: 'client',
    });
    await eventually(() => relay.relay.audit.records().length === 1);
    expect(relay.relay.audit.records()[0]).toMatchObject({
      tool: 'get_view',
      outcome: 'cancelled',
      client: { name: modern ? 'modern' : 'legacy', version: '1.0.0' },
    });
    // The client carries on as before.
    expect((await callTool(alice, 'list_pages')).isError).toBe(false);
  });
});

describe('revocation (S8) on a 2025-era session', () => {
  it("answers the client's call with not_attached and leaves its session open", async () => {
    const { opened } = await setup();
    const alice = await client();
    await pairAndApprove(alice, opened);
    const session = sessionIdOf(alice);
    expect(session).toBeDefined();
    const pending = callTool(alice, 'call_page_tool', { page: opened.pageId, tool: 'get_view' });
    const invoke = await opened.next('invoke');
    opened.send({ t: 'revoke', userId: 'alice' });
    expect(await pending).toMatchObject({
      isError: true,
      text: 'not_attached: the page operator revoked your attachment',
    });
    expect(await opened.next('cancel')).toEqual({
      t: 'cancel',
      callId: invoke.callId,
      reason: 'revoked',
    });
    // Same session, still answering.
    expect(sessionIdOf(alice)).toBe(session);
    expect((await callTool(alice, 'list_pages')).structured).toEqual({ pages: [] });
    expect(
      (await callTool(alice, 'call_page_tool', { page: opened.pageId, tool: 'get_view' })).text,
    ).toMatch(/^not_attached: /);
  });
});

describe('pair_page on a 2025-era session', () => {
  it('a client that stops waiting leaves the request open, and a later approval still attaches', async () => {
    const { opened } = await setup();
    const alice = await client();
    const abort = new AbortController();
    const pending = alice
      .callTool({ name: 'pair_page', arguments: { code: opened.code } }, { signal: abort.signal })
      .then(
        () => 'answered',
        () => 'rejected',
      );
    const request = await opened.next('attach_request');
    abort.abort();
    expect(await pending).toBe('rejected');
    opened.send({
      t: 'attach_decision',
      requestId: request.requestId,
      allow: true,
      role: 'driver',
    });
    await opened.next('roster');
    expect((await callTool(alice, 'list_pages')).structured).toMatchObject({
      pages: [{ page: opened.pageId, role: 'driver' }],
    });
  });
});

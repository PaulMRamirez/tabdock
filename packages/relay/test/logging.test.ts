import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { type AuthPlugin, createDevTokenAuth, createLogger, redact } from '../src/index.ts';
import { connectPage, type TestPage, TOOLS } from './helpers/page-client.ts';
import {
  ALICE,
  BOB,
  callTool,
  connectClient,
  pairAndApprove,
  sessionIdOf,
  startRelay,
  type TestRelay,
} from './helpers/relay.ts';

describe('the logger', () => {
  it('writes one JSON object per line with ts, level and msg first', () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (line) => lines.push(line), level: 'info' });
    log.debug('hidden');
    log.info('shown', { pageId: 'pg_1', msg: 'cannot override', level: 'nope' });
    log.error('failed', { error: new Error('boom') });
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(Object.keys(first).slice(0, 3)).toEqual(['ts', 'level', 'msg']);
    expect(first).toMatchObject({ level: 'info', msg: 'shown', pageId: 'pg_1' });
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({
      level: 'error',
      error: { name: 'Error', message: 'boom' },
    });
  });

  it('redacts secret field names at any depth and in any case', () => {
    expect(
      redact({
        token: 't',
        Authorization: 'Bearer x',
        nested: { code: 'ABCDE-12345', list: [{ resumeToken: 'r' }, { RESUMETOKEN: 'r2' }] },
        arguments: { label: 'secret' },
        keep: 'visible',
        bytes: Buffer.from('raw'),
      }),
    ).toEqual({
      token: '[redacted]',
      Authorization: '[redacted]',
      nested: {
        code: '[redacted]',
        list: [{ resumeToken: '[redacted]' }, { RESUMETOKEN: '[redacted]' }],
      },
      arguments: '[redacted]',
      keep: 'visible',
      bytes: '[bytes]',
    });
  });

  it('survives a sink that throws and cyclic values', () => {
    const log = createLogger({
      sink: () => {
        throw new Error('disk full');
      },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => {
      log.info('still fine', { cyclic });
    }).not.toThrow();
  });
});

describe('secrets never reach the logs (S11)', () => {
  let current: TestRelay | undefined;
  const pages: TestPage[] = [];
  const clients: Client[] = [];

  afterEach(async () => {
    for (const connected of clients.splice(0)) await connected.close();
    for (const opened of pages.splice(0)) opened.ws.terminate();
    await current?.close();
    current = undefined;
  });

  it('a full pairing, calls, a resume and refused attempts leave no code, token or argument in any line', async () => {
    current = await startRelay({ logLevel: 'debug' });
    const { relay, lines } = current;
    const marker = 'argument-marker-5f2c9d';
    const opened = await connectPage(relay.pageUrl, {
      tools: TOOLS,
      onInvoke: (frame) => ({ ok: true, content: JSON.stringify({ echoed: frame.arguments }) }),
    });
    pages.push(opened);
    const alice = await connectClient(relay, ALICE, { modern: true });
    const bob = await connectClient(relay, BOB);
    clients.push(alice, bob);

    // Refused attempts carry secrets too: a wrong code and a bad bearer token.
    const wrongCode = 'QQQQQ-QQQQQ';
    await callTool(bob, 'pair_page', { code: wrongCode });
    const badToken = 'not-a-real-token-but-still-secret-1234';
    await fetch(relay.mcpUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${badToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    });

    await pairAndApprove(alice, opened, 'driver');
    await callTool(alice, 'call_page_tool', {
      page: opened.pageId,
      tool: 'add_item',
      arguments: { label: marker },
    });
    // A refused resume (wrong origin) logs its reason; the token must not come with it.
    const firstToken = opened.welcome?.resumeToken ?? '';
    await opened.close();
    const thief = await connectPage(relay.pageUrl, {
      origin: 'http://127.0.0.1:9999',
      resumeToken: firstToken,
    });
    pages.push(thief);
    const back = await connectPage(relay.pageUrl, { resumeToken: firstToken, tools: TOOLS });
    pages.push(back);
    back.send({ t: 'rotate_pairing' });
    await back.next('pairing');
    await callTool(alice, 'list_page_tools', { page: back.pageId });
    // Bob is a 2025-era client, so he holds an MCP session; its id stays out of the logs too.
    const bobSession = sessionIdOf(bob) ?? '';
    expect(bobSession).not.toBe('');
    await current.close();
    current = undefined;

    const codes = new Set<string>([wrongCode]);
    const resumeTokens = new Set<string>();
    for (const page of [opened, thief, back]) {
      for (const frame of page.received) {
        if (frame.t === 'welcome') {
          codes.add(frame.pairing.code);
          resumeTokens.add(frame.resumeToken);
        }
        if (frame.t === 'pairing') codes.add(frame.code);
      }
    }
    expect(codes.size).toBeGreaterThanOrEqual(5);
    expect(resumeTokens.size).toBe(3);
    const secrets = [
      ...[...codes].flatMap((code) => [code, code.replace('-', '')]),
      ...resumeTokens,
      ALICE.token,
      BOB.token,
      badToken,
      marker,
      bobSession,
    ];
    const all = lines.join('\n');
    expect(lines.length).toBeGreaterThan(15);
    for (const secret of secrets) expect(all, secret).not.toContain(secret);
    // The events themselves are still there, so the absence above means something.
    for (const msg of [
      'pairing refused: no live code matched',
      'mcp request refused: not authenticated',
      'attach request sent',
      'attached',
      '"msg":"call"',
      'resume refused; starting a new page session',
      'pairing code rotated',
    ]) {
      expect(all, msg).toContain(msg);
    }
  });

  it('logs a request by its route, never by its raw path or query (ADR 0016)', async () => {
    // A plugin route that fails, so the relay's own catch has something to log.
    const plugin: AuthPlugin = {
      ...createDevTokenAuth([ALICE, BOB]),
      routes: new Map([
        [
          '/broken',
          () => {
            throw new Error('the route failed');
          },
        ],
      ]),
    };
    current = await startRelay({ auth: plugin, logLevel: 'debug' });
    const { relay, lines } = current;
    const secret = 'q3Zf0_Wn-8xLr2TmB9cKpA';
    expect((await fetch(`${relay.url}/broken?nonce=${secret}`)).status).toBe(500);
    expect((await fetch(`${relay.url}/broken/${secret}`)).status).toBe(404);
    expect((await fetch(`${relay.url}/pair?nonce=${secret}`)).status).toBe(404);
    const refused = await fetch(`${relay.mcpUrl}?code=${secret}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(refused.status).toBe(401);
    const failed = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.msg === 'request failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ route: '/broken' });
    expect(failed[0]).not.toHaveProperty('path');
    expect(lines.join('\n')).not.toContain(secret);
  });
});

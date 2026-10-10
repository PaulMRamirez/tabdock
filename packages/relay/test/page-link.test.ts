import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ATTACH_REQUEST_TTL_MS,
  DEFAULT_IMAGE_BYTES,
  IDLE_TIMEOUT_MS,
  MAX_DESCRIPTION_CHARS,
  MAX_FRAME_BYTES,
  MAX_RESULT_CHARS,
  MAX_STATE_BYTES,
  PAIRING_TTL_MS,
  PING_INTERVAL_MS,
  RESUME_WINDOW_MS,
  SUBPROTOCOL,
} from '@tabdock/protocol';
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createDevTokenAuth, createRelay } from '../src/index.ts';
import { CROCKFORD_ALPHABET } from '../src/secrets.ts';
import {
  connectionOf,
  connectPage,
  openSocket,
  PAGE_ORIGIN,
  TestPage,
  TOOLS,
  UpgradeRefused,
} from './helpers/page-client.ts';
import {
  ALICE,
  callTool,
  connectClient,
  delay,
  pairAndApprove,
  startRelay,
  type TestRelay,
} from './helpers/relay.ts';

const SYMBOL = `[${CROCKFORD_ALPHABET}]`;

let current: TestRelay | undefined;
const pages: TestPage[] = [];
const clients: Client[] = [];

async function relayWith(options: Parameters<typeof startRelay>[0] = {}): Promise<TestRelay> {
  current = await startRelay(options);
  return current;
}

async function page(...args: Parameters<typeof connectPage>): Promise<TestPage> {
  const opened = await connectPage(...args);
  pages.push(opened);
  return opened;
}

async function refusal(url: string, options: Parameters<typeof openSocket>[1]): Promise<number> {
  try {
    const ws = await openSocket(url, options);
    ws.terminate();
    return 101;
  } catch (error) {
    if (error instanceof UpgradeRefused) return error.status;
    throw error;
  }
}

function hello(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    t: 'hello',
    v: 1,
    title: 'Raw',
    url: `${PAGE_ORIGIN}/`,
    adapterVersion: 'test',
    policy: {},
    ...extra,
  };
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const opened of pages.splice(0)) opened.ws.terminate();
  await current?.close();
  current = undefined;
});

describe('who may open /page (S1, S2)', () => {
  it('refuses a socket without an Origin header', async () => {
    const { relay, lines } = await relayWith();
    expect(await refusal(relay.pageUrl, { origin: null })).toBe(403);
    expect(lines.some((line) => line.includes('no Origin header'))).toBe(true);
  });

  it('refuses an origin that is not on the allowlist', async () => {
    const { relay } = await relayWith();
    for (const origin of [
      'https://evil.example',
      'null',
      'http://localhost.evil.example:5173',
      'http://localhost:5173/',
    ]) {
      expect(await refusal(relay.pageUrl, { origin }), origin).toBe(403);
    }
  });

  it('accepts localhost, 127.0.0.1 and [::1] origins at any port by default in development', async () => {
    const { relay } = await relayWith();
    for (const origin of ['http://localhost:5173', 'https://127.0.0.1:8443', 'http://[::1]:3000']) {
      expect(await refusal(relay.pageUrl, { origin }), origin).toBe(101);
    }
  });

  it('uses only the explicit list when one is given', async () => {
    const { relay } = await relayWith({ allowedOrigins: ['https://app.example'] });
    expect(await refusal(relay.pageUrl, { origin: 'https://app.example' })).toBe(101);
    expect(await refusal(relay.pageUrl, { origin: PAGE_ORIGIN })).toBe(403);
  });

  it('lets a header-less socket in only under the development flag, recorded as having no origin', async () => {
    const { relay } = await relayWith({ allowMissingOrigin: true });
    const opened = await page(relay.pageUrl, { origin: null });
    expect(opened.welcome?.resumed).toBe(false);
    // A header-less socket can never pass as an allowed origin it merely claims in hello.
    expect(await refusal(relay.pageUrl, { origin: 'https://evil.example' })).toBe(403);
  });

  it('serves production with an explicit list and still refuses missing origins', async () => {
    // Production keeps its audit log on disk (ADR 0019), so it gets a directory of its own.
    const scratch = mkdtempSync(join(tmpdir(), 'tabdock-page-link-'));
    try {
      const { relay } = await relayWith({
        env: 'production',
        allowedOrigins: ['https://app.example'],
        audit: { dir: join(scratch, 'audit') },
      });
      expect(await refusal(relay.pageUrl, { origin: null })).toBe(403);
      expect(await refusal(relay.pageUrl, { origin: 'https://app.example' })).toBe(101);
      await current?.close();
      current = undefined;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('upgrade rules', () => {
  it('requires the tabdock.v1 subprotocol', async () => {
    const { relay } = await relayWith();
    expect(await refusal(relay.pageUrl, { protocols: [] })).toBe(400);
    expect(await refusal(relay.pageUrl, { protocols: ['tabdock.v2'] })).toBe(400);
    const ws = await openSocket(relay.pageUrl, { protocols: ['other', SUBPROTOCOL] });
    expect(ws.protocol).toBe(SUBPROTOCOL);
    ws.terminate();
  });

  it('upgrades only /page', async () => {
    const { relay } = await relayWith();
    expect(await refusal(relay.pageUrl.replace('/page', '/mcp'), {})).toBe(404);
    expect(await refusal(relay.pageUrl.replace('/page', '/'), {})).toBe(404);
  });

  it('answers plain HTTP on /page with 426 and unknown paths with 404', async () => {
    const { relay } = await relayWith();
    expect((await fetch(`${relay.url}/page`)).status).toBe(426);
    expect((await fetch(`${relay.url}/nope`)).status).toBe(404);
    expect((await fetch(`${relay.url}/healthz`, { method: 'POST' })).status).toBe(405);
  });

  it('answers a malformed request target with 400', async () => {
    const { relay } = await relayWith();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${relay.url}/healthz`, { path: '//evil' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(400);
  });
});

describe('hello', () => {
  it('welcomes a page with an id, a pairing code, a resume token and the limits', async () => {
    const { relay } = await relayWith();
    const opened = await page(relay.pageUrl, { tools: TOOLS });
    const welcome = opened.welcome;
    expect(welcome?.pageId).toMatch(new RegExp(`^pg_${SYMBOL}{10}$`));
    expect(welcome?.resumed).toBe(false);
    expect(welcome?.resumeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(welcome?.pairing.code).toMatch(new RegExp(`^${SYMBOL}{5}-${SYMBOL}{5}$`));
    expect(welcome?.pairing.expiresAt).toBeGreaterThan(Date.now());
    expect(welcome?.roster).toEqual([]);
    expect(welcome?.limits).toEqual({
      maxFrameBytes: MAX_FRAME_BYTES,
      maxResultChars: MAX_RESULT_CHARS,
      maxDescriptionChars: MAX_DESCRIPTION_CHARS,
      pingIntervalMs: 5000,
      idleTimeoutMs: 10_000,
      resumeWindowMs: 5000,
      attachRequestTtlMs: 5000,
      // M6: images up to the relay's setting (ADR 0039), page state (ADR
      // 0040), and the page's people with no watching seats, invites off
      // (ADR 0044).
      maxImageBytes: DEFAULT_IMAGE_BYTES,
      maxStateBytes: MAX_STATE_BYTES,
      usersPerPage: 10,
      observersPerPage: 0,
    });
  });

  it('tells the page its watching seats and image size as set, with invites on', async () => {
    const { relay } = await relayWith({
      invites: true,
      limits: { observersPerPage: 25, usersPerPage: 6, imageBytes: 0 },
    });
    const opened = await page(relay.pageUrl, { tools: TOOLS });
    expect(opened.welcome?.limits).toMatchObject({
      maxImageBytes: 0,
      maxStateBytes: MAX_STATE_BYTES,
      usersPerPage: 6,
      observersPerPage: 25,
    });
  });

  it('advertises the protocol defaults when no timings are overridden', async () => {
    const relay = await createRelay({
      auth: createDevTokenAuth([ALICE]),
      logSink: () => undefined,
    });
    try {
      const opened = await page(relay.pageUrl);
      expect(opened.welcome?.limits).toMatchObject({
        pingIntervalMs: PING_INTERVAL_MS,
        idleTimeoutMs: IDLE_TIMEOUT_MS,
        resumeWindowMs: RESUME_WINDOW_MS,
        attachRequestTtlMs: ATTACH_REQUEST_TTL_MS,
      });
      expect((opened.welcome?.pairing.expiresAt ?? 0) - Date.now()).toBeGreaterThan(
        PAIRING_TTL_MS - 5000,
      );
    } finally {
      for (const opened of pages.splice(0)) opened.ws.terminate();
      await relay.close();
    }
  });

  it('closes with 1008 when no hello arrives in time', async () => {
    const helloTimeoutMs = 150;
    const { relay } = await relayWith({ timings: { helloTimeoutMs } });
    // The relay arms its hello timer as it answers the upgrade (ws calls back
    // straight after writing the 101), before this side has read that answer.
    // So the clock starts before the socket is asked for: started after
    // openSocket resolved, it ran late by however long the 101 took to be
    // read, which on a loaded machine has been tens of milliseconds.
    const started = performance.now();
    const opened = new TestPage(await openSocket(relay.pageUrl));
    pages.push(opened);
    expect((await opened.closed).code).toBe(1008);
    // Node counts a timer from the whole millisecond of libuv's loop clock,
    // which libuv reads from CLOCK_MONOTONIC_COARSE where that ticks at 1 ms or
    // finer. So the relay may close up to 1 ms (the truncation) plus 1 ms (the
    // coarse clock's lag) short of helloTimeoutMs after the instant it armed;
    // performance.now() reads CLOCK_MONOTONIC, the same clock, so no wall
    // clock step or rounding needs any further allowance.
    expect(performance.now() - started).toBeGreaterThanOrEqual(helloTimeoutMs - 2);
  });

  it('closes with 1008 when the first frame is not hello', async () => {
    const { relay } = await relayWith();
    const opened = new TestPage(await openSocket(relay.pageUrl));
    pages.push(opened);
    opened.send({ t: 'ping' });
    expect((await opened.closed).code).toBe(1008);
  });

  it('closes with 1008 on a second hello', async () => {
    const { relay } = await relayWith();
    const opened = await page(relay.pageUrl);
    opened.send(hello());
    expect((await opened.closed).code).toBe(1008);
  });
});

describe('frames', () => {
  it.each([
    ['not JSON', 'nope'],
    ['an array', '[1,2]'],
    ['no type', '{"x":1}'],
    ['a hello with the wrong version', JSON.stringify(hello({ v: 2 }))],
    [
      'a tools frame with a bad tool name',
      '{"t":"tools","tools":[{"name":"a b","description":"","inputSchema":{}}]}',
    ],
    ['a result without content', '{"t":"result","callId":"cl_1","ok":true}'],
  ])('closes with 1008 on %s', async (_label, text) => {
    const { relay, lines } = await relayWith();
    const opened = await page(relay.pageUrl);
    opened.sendRaw(text);
    expect((await opened.closed).code).toBe(1008);
    expect(lines.some((line) => line.includes('malformed frame'))).toBe(true);
  });

  it('closes with 1008 on a binary frame', async () => {
    const { relay } = await relayWith();
    const opened = await page(relay.pageUrl);
    opened.sendRaw(Buffer.from('{"t":"ping"}'), true);
    expect((await opened.closed).code).toBe(1008);
  });

  it('ignores and logs an unknown frame type, and keeps the socket open', async () => {
    const { relay, lines } = await relayWith();
    const opened = await page(relay.pageUrl);
    opened.send({ t: 'future_thing', anything: [1, 2, 3] });
    await opened.sync();
    expect(opened.ws.readyState).toBe(opened.ws.OPEN);
    expect(
      lines.some((line) => line.includes('unknown type') && line.includes('future_thing')),
    ).toBe(true);
  });

  it('closes a socket that sends a frame over 1 MB (1009)', async () => {
    const { relay } = await relayWith();
    const opened = await page(relay.pageUrl);
    opened.sendRaw(`{"t":"ping","pad":"${'x'.repeat(MAX_FRAME_BYTES)}"}`);
    expect((await opened.closed).code).toBe(1009);
  });

  it('accepts a frame just under 1 MB', async () => {
    const { relay } = await relayWith();
    const opened = await page(relay.pageUrl);
    const frame = JSON.stringify({ t: 'future_thing', pad: '' });
    opened.sendRaw(
      frame.replace('"pad":""', `"pad":"${'x'.repeat(MAX_FRAME_BYTES - frame.length)}"`),
    );
    await opened.sync();
    expect(opened.ws.readyState).toBe(opened.ws.OPEN);
  });
});

describe('heartbeat', () => {
  it('pings on the interval and keeps a page that answers', async () => {
    const { relay } = await relayWith({ timings: { pingIntervalMs: 50, idleTimeoutMs: 200 } });
    const opened = await page(relay.pageUrl);
    await delay(500);
    expect(opened.all('ping').length).toBeGreaterThanOrEqual(5);
    expect(opened.ws.readyState).toBe(opened.ws.OPEN);
  });

  it('closes a page that stays silent past the idle timeout', async () => {
    const idleTimeoutMs = 200;
    const { relay } = await relayWith({ timings: { pingIntervalMs: 50, idleTimeoutMs } });
    // The relay arms its idle timer as it sends the welcome (hub.ts,
    // #startHeartbeat), before this side has read that welcome. So the clock
    // starts before the socket is asked for: started once page() resolved, it
    // ran late by however long the welcome took to be read, which on a
    // loaded machine has outrun the 50 ms this test once allowed for it.
    const started = performance.now();
    const opened = await page(relay.pageUrl, { autoPong: false });
    const closed = await opened.closed;
    expect(closed.code).toBe(1001);
    // As for the hello timer: Node counts a timer from the whole millisecond
    // of libuv's loop clock, read from CLOCK_MONOTONIC_COARSE where that ticks
    // at 1 ms or finer, so the relay may close up to 2 ms short of
    // idleTimeoutMs after the instant it armed; performance.now() reads the
    // same monotonic clock, so nothing else needs an allowance.
    expect(performance.now() - started).toBeGreaterThanOrEqual(idleTimeoutMs - 2);
  });

  it('answers a page ping with pong', async () => {
    const { relay } = await relayWith();
    const opened = await page(relay.pageUrl);
    opened.send({ t: 'ping' });
    expect((await opened.next('pong')).t).toBe('pong');
  });
});

describe('pairing tickets', () => {
  it('rotate on expiry and on request, each time with a new code and a later expiry', async () => {
    const { relay } = await relayWith({ timings: { pairingTtlMs: 150 } });
    const opened = await page(relay.pageUrl);
    const first = opened.welcome?.pairing;
    const rotated = await opened.next('pairing', 1000);
    expect(rotated.code).not.toBe(first?.code);
    expect(rotated.expiresAt).toBeGreaterThan(first?.expiresAt ?? 0);
    opened.send({ t: 'rotate_pairing' });
    const asked = await opened.next('pairing', 1000);
    expect(asked.code).not.toBe(rotated.code);
    expect(asked.code).toMatch(new RegExp(`^${SYMBOL}{5}-${SYMBOL}{5}$`));
  });
});

describe('a socket the page has begun to close (ADR 0030)', () => {
  it('answers a call page_asleep at once, recorded as never having reached the page', async () => {
    const { relay } = await relayWith();
    const opened = await page(relay.pageUrl, {
      tools: TOOLS,
      onInvoke: () => ({ ok: true, content: 'too late' }),
    });
    const client = await connectClient(relay, ALICE);
    clients.push(client);
    await pairAndApprove(client, opened);
    // The page sends its close frame and then reads nothing and keeps TCP
    // open, so ws on the relay holds the socket CLOSING, up to its 30 s
    // closeTimeout, without reporting a close.
    connectionOf(opened.ws).pause();
    opened.ws.close(1000, 'leaving');
    await delay(200);
    const started = Date.now();
    const answer = await callTool(client, 'call_page_tool', {
      page: opened.pageId,
      tool: 'get_view',
    });
    expect(answer.text).toMatch(/^page_asleep: /);
    // Well inside the call's 3 s deadline, which it used to wait out.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(relay.audit.records().filter((record) => record.tool === 'get_view')).toEqual([
      expect.objectContaining({ outcome: 'page_asleep' }),
    ]);
  });
});

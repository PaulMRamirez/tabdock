// The M3 spike flag (ADR 0014, spike.ts): off by default, refused in
// production, and when on a marker tool the relay's own terminal adds and
// removes, announced to 2025-era sessions with list_changed and to 2026-07-28
// clients through subscriptions/listen; a log line for every tools/list and
// every stream a client opens; timestamps on each call_page_tool; and pairing
// milestones. None of it ever logs a token or a session id.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.ts';
import { createLogger } from '../src/log.ts';
import { Spike } from '../src/spike.ts';
import {
  attachSpikeConsole,
  createDevTokenAuth,
  createOAuthAuth,
  createRelay,
  loadConfigFromEnv,
  markerToolName,
  SPIKE_TIMING_META_KEY,
  SpikeTimingSchema,
} from '../src/index.ts';
import { connectPage, READ_TOOL, type TestPage, TOOLS } from './helpers/page-client.ts';
import { PAIR_CLIENT } from './helpers/provider.ts';
import {
  ALICE,
  BOB,
  connectClient,
  eventually,
  pairAndApprove,
  sessionIdOf,
  startRelay,
  type TestRelay,
} from './helpers/relay.ts';

const FIXED = ['call_page_tool', 'detach_page', 'list_page_tools', 'list_pages', 'pair_page'];

let current: TestRelay | undefined;
const clients: Client[] = [];
const pages: TestPage[] = [];

async function setup(spike: boolean): Promise<TestRelay> {
  current = await startRelay({ spike });
  return current;
}

async function client(user = ALICE, modern = false): Promise<Client> {
  if (!current) throw new Error('no relay');
  const connected = await connectClient(current.relay, user, { name: 'spike-test', modern });
  clients.push(connected);
  return connected;
}

async function page(): Promise<TestPage> {
  if (!current) throw new Error('no relay');
  const opened = await connectPage(current.relay.pageUrl, {
    tools: TOOLS,
    onInvoke: (frame) => ({ ok: true, content: JSON.stringify({ tool: frame.tool }) }),
  });
  pages.push(opened);
  return opened;
}

async function toolNames(connected: Client): Promise<string[]> {
  const { tools } = await connected.listTools(undefined, { cacheMode: 'refresh' });
  return tools.map((tool) => tool.name).sort();
}

interface Line {
  msg: string;
  [field: string]: unknown;
}

function logLines(): Line[] {
  return (current?.lines ?? []).map((line) => JSON.parse(line) as Line);
}

function spikeLines(msg: string): Line[] {
  return logLines().filter((line) => line.msg === msg);
}

/** Resolves on the next tools list_changed notification this client hears. */
function nextListChanged(connected: Client): Promise<void> {
  return new Promise((resolve) => {
    connected.setNotificationHandler('notifications/tools/list_changed', () => {
      resolve();
    });
  });
}

afterEach(async () => {
  for (const connected of clients.splice(0)) await connected.close();
  for (const opened of pages.splice(0)) opened.ws.terminate();
  await current?.close();
  current = undefined;
});

describe('the spike flag', () => {
  it('is off by default: no control, five tools, no timestamps and no spike log lines', async () => {
    const { relay, lines } = await setup(false);
    expect(relay.spike).toBeNull();
    expect(loadConfigFromEnv({ TABDOCK_DEV_TOKENS: `alice=${ALICE.token}` }).spike).toBe(false);
    const alice = await client();
    expect(await toolNames(alice)).toEqual(FIXED);
    const opened = await page();
    await pairAndApprove(alice, opened);
    const result = await alice.callTool({
      name: 'call_page_tool',
      arguments: { page: opened.pageId, tool: READ_TOOL.name, arguments: {} },
    });
    expect(result.isError ?? false).toBe(false);
    expect(result._meta?.[SPIKE_TIMING_META_KEY]).toBeUndefined();
    expect(logLines().filter((line) => line.msg.startsWith('spike'))).toEqual([]);
    expect(lines.length).toBeGreaterThan(0);
    // No HTTP route reaches it either way.
    for (const path of ['/spike', '/spike/marker', '/marker']) {
      const response = await fetch(`${relay.url}${path}`, { method: 'POST' });
      expect(response.status).toBe(404);
    }
  });

  it('is refused in production, from options and from the environment', async () => {
    const auth = createDevTokenAuth([ALICE]);
    const production = {
      auth,
      env: 'production' as const,
      allowedOrigins: ['https://app.example'],
      spike: true,
    };
    expect(() => resolveConfig(production)).toThrow(/TABDOCK_SPIKE.*production refuses/);
    await expect(createRelay({ ...production, logSink: () => undefined })).rejects.toThrow(
      /production refuses/,
    );
    const env = {
      TABDOCK_DEV_TOKENS: `alice=${ALICE.token}`,
      TABDOCK_ENV: 'production',
      TABDOCK_ALLOWED_ORIGINS: 'https://app.example',
      TABDOCK_SPIKE: '1',
    };
    const options = loadConfigFromEnv(env);
    expect(options.spike).toBe(true);
    expect(() => resolveConfig(options)).toThrow(/production refuses/);
    expect(() => loadConfigFromEnv({ ...env, TABDOCK_SPIKE: 'yes' })).toThrow(/TABDOCK_SPIKE/);
    expect(resolveConfig({ ...production, env: 'development' }).spike).toBe(true);
  });

  it('works in public URL mode, which is where hosted Claude reaches it', () => {
    // Construction alone fetches nothing; resolveConfig only reads the plugin's shape.
    const oauth = createOAuthAuth({
      issuer: 'https://idp.example',
      resource: 'https://relay.example/mcp',
      users: [{ sub: 'sub-alice', userId: 'alice', displayName: 'Alice' }],
    });
    const config = resolveConfig({
      auth: oauth,
      publicUrl: 'https://relay.example',
      pairClient: PAIR_CLIENT,
      allowedOrigins: ['http://localhost:5173'],
      spike: true,
    });
    expect(config.spike).toBe(true);
  });
});

describe('the marker tool', () => {
  it('reaches an open 2025 session as list_changed, and its next list shows the marker', async () => {
    const { relay } = await setup(true);
    const control = relay.spike;
    if (!control) throw new Error('the spike flag did not give a control');
    const alice = await client();
    expect(sessionIdOf(alice)).toBeDefined();
    expect(await toolNames(alice)).toEqual(FIXED);
    // The SDK client opens its listening GET stream after initialize.
    await eventually(() => spikeLines('spike: client opened a stream').length > 0);

    const heard = nextListChanged(alice);
    const added = control.addMarker();
    expect(added).toEqual({ changed: true, marker: markerToolName(1), sessions: 1 });
    await heard;
    expect(await toolNames(alice)).toEqual([...FIXED, markerToolName(1)].sort());
    const called = await alice.callTool({ name: markerToolName(1), arguments: {} });
    expect(called.isError ?? false).toBe(false);
    expect(JSON.stringify(called.content)).toMatch(/Tabdock spike marker 1, added at/);
    // Adding twice changes nothing.
    expect(control.addMarker()).toEqual({ changed: false, marker: markerToolName(1), sessions: 0 });

    // A session opened while the marker is listed sees it at once.
    const bob = await client(BOB);
    expect(await toolNames(bob)).toContain(markerToolName(1));

    const removed = nextListChanged(alice);
    expect(control.removeMarker()).toEqual({ changed: true, marker: null, sessions: 2 });
    await removed;
    expect(await toolNames(alice)).toEqual(FIXED);
    expect(await toolNames(bob)).toEqual(FIXED);

    // A new marker is numbered, so a client still showing the old one is caught out.
    const again = nextListChanged(alice);
    expect(control.addMarker().marker).toBe(markerToolName(2));
    await again;
    expect(await toolNames(alice)).toContain(markerToolName(2));
    expect(spikeLines('spike: marker tool added').map((line) => line.tool)).toEqual([
      markerToolName(1),
      markerToolName(2),
    ]);
  });

  it('reaches a 2026-07-28 client through subscriptions/listen', async () => {
    const { relay } = await setup(true);
    const alice = await client(ALICE, true);
    expect(sessionIdOf(alice)).toBeUndefined();
    const heard = nextListChanged(alice);
    const subscription = await alice.listen({ toolsListChanged: true });
    expect(subscription.honoredFilter.toolsListChanged).toBe(true);
    relay.spike?.addMarker();
    await heard;
    expect(await toolNames(alice)).toContain(markerToolName(1));
    await subscription.close();
    await eventually(() => spikeLines('spike: client stream ended').length > 0);
  });

  it('is added and removed from the relay terminal, and anything else prints the help', async () => {
    const { relay } = await setup(true);
    const control = relay.spike;
    if (!control) throw new Error('no control');
    const input = new PassThrough();
    const printed: string[] = [];
    const stop = attachSpikeConsole(control, input, (line) => printed.push(line));
    input.write('marker add\n');
    await eventually(() => control.marker !== null);
    input.write('status\nremove\nremove\nwhat\n');
    await eventually(() => printed.length === 5);
    stop();
    expect(control.marker).toBeNull();
    expect(printed[0]).toMatch(/added tabdock_spike_marker_1/);
    expect(printed[1]).toBe('spike: tabdock_spike_marker_1 is listed');
    expect(printed[2]).toMatch(/removed the marker/);
    expect(printed[3]).toBe('spike: no marker is listed');
    expect(printed[4]).toMatch(/Commands:/);
  });
});

describe('the relay command', () => {
  it('reads the marker commands from its own stdin when TABDOCK_SPIKE=1', async () => {
    const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
    // Every setting given here, so a .env the owner keeps beside the repo cannot change the run.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      TABDOCK_DEV_TOKENS: `alice=${ALICE.token}`,
      TABDOCK_PUBLIC_URL: '',
      TABDOCK_OAUTH_ISSUER: '',
      TABDOCK_OAUTH_USERS: '',
      TABDOCK_ENV: 'development',
      TABDOCK_HOST: '127.0.0.1',
      TABDOCK_PORT: '0',
      TABDOCK_ALLOWED_ORIGINS: '',
      TABDOCK_SPIKE: '1',
    };
    const child = spawn(process.execPath, [main], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr.resume();
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        resolve(code);
      });
    });
    try {
      await eventually(() => out.includes('Commands:'), 10_000);
      child.stdin.write('add\n');
      await eventually(() => out.includes('added tabdock_spike_marker_1'), 5000);
      child.stdin.write('status\n');
      await eventually(() => out.includes('tabdock_spike_marker_1 is listed'), 5000);
    } finally {
      child.kill('SIGTERM');
      await exited;
    }
    expect(out).not.toContain(ALICE.token);
  }, 20_000);
});

describe('what the spike logs', () => {
  it('every tools/list and stream, with the client name and a session label, never a token or session id', async () => {
    const { lines } = await setup(true);
    const legacy = await client();
    await toolNames(legacy);
    const modern = await client(ALICE, true);
    await toolNames(modern);
    const subscription = await modern.listen({ toolsListChanged: true });
    await eventually(() => spikeLines('spike: client opened a stream').length >= 2);
    await subscription.close();

    const lists = spikeLines('spike: tools/list');
    expect(lists).toHaveLength(2);
    expect(lists[0]).toMatchObject({
      userId: 'alice',
      era: '2025',
      session: 's1',
      client: { name: 'spike-test', version: '1.0.0' },
    });
    expect(lists[1]).toMatchObject({
      userId: 'alice',
      era: '2026-07-28',
      client: { name: 'spike-test', version: '1.0.0' },
    });
    expect(lists[1]?.session).toBeUndefined();
    expect(typeof lists[0]?.ts).toBe('string');
    const streams = spikeLines('spike: client opened a stream');
    expect(streams.map((line) => line.kind).sort()).toEqual(['GET', 'subscriptions/listen']);
    expect(streams.find((line) => line.kind === 'subscriptions/listen')).toMatchObject({
      toolsListChanged: true,
      client: { name: 'spike-test' },
    });
    expect(spikeLines('spike: session opened')).toHaveLength(1);

    const sessionId = sessionIdOf(legacy) ?? '';
    expect(sessionId).not.toBe('');
    for (const line of lines) {
      expect(line).not.toContain(ALICE.token);
      expect(line).not.toContain(sessionId);
    }
  });

  it('call timestamps in the result and the log, and pairing milestones up to the first call', async () => {
    const { lines } = await setup(true);
    const alice = await client();
    const opened = await page();
    await pairAndApprove(alice, opened);
    const result = await alice.callTool({
      name: 'call_page_tool',
      arguments: { page: opened.pageId, tool: READ_TOOL.name, arguments: {} },
    });
    expect(result.isError ?? false).toBe(false);
    const timing = SpikeTimingSchema.parse(result._meta?.[SPIKE_TIMING_META_KEY]);
    const { handlerIn, invokeOut, resultIn, responseOut, pageMs, relayMs } = timing;
    expect(handlerIn).toBeGreaterThanOrEqual(0);
    expect(invokeOut).not.toBeNull();
    expect(resultIn).not.toBeNull();
    expect(invokeOut ?? -1).toBeGreaterThanOrEqual(handlerIn);
    expect(resultIn ?? -1).toBeGreaterThanOrEqual(invokeOut ?? Infinity);
    expect(responseOut).toBeGreaterThanOrEqual(resultIn ?? Infinity);
    expect(pageMs).toBeCloseTo((resultIn ?? 0) - (invokeOut ?? 0), 1);
    expect(relayMs).toBe(responseOut);
    const logged = spikeLines('spike: call timing');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ userId: 'alice', pageId: opened.pageId, tool: 'get_view' });

    const stages = spikeLines('spike: pairing milestone')
      .filter((line) => line.pageId === opened.pageId && line.userId === 'alice')
      .map((line) => line.stage);
    expect(stages).toEqual(['claimed', 'approved', 'first_call']);
    // Timed from the welcome's ticket, the one the code came from, not from its replacement.
    const milestones = spikeLines('spike: pairing milestone');
    const welcomed = milestones.find((line) => line.stage === 'issued');
    const claimed = milestones.find((line) => line.stage === 'claimed');
    expect(welcomed?.trace).toMatch(/^tr_[0-9A-Z]{10}$/);
    expect(claimed?.trace).toBe(welcomed?.trace);
    const first = spikeLines('spike: pairing milestone').find(
      (line) => line.stage === 'first_call',
    );
    expect(first).toMatchObject({ via: 'code', outcome: 'ok' });
    expect(typeof first?.sinceClaimedMs).toBe('number');
    // A second call is no longer a first call.
    await alice.callTool({
      name: 'call_page_tool',
      arguments: { page: opened.pageId, tool: READ_TOOL.name, arguments: {} },
    });
    expect(
      spikeLines('spike: pairing milestone').filter((l) => l.stage === 'first_call'),
    ).toHaveLength(1);
    // The pairing code never reaches the log.
    for (const line of lines) expect(line).not.toContain(opened.code);
  });
});

describe('the pairing milestones, which /pair reports through the hub', () => {
  it('time a scan through claim and approval to the first call, under one trace per ticket', async () => {
    const lines: string[] = [];
    const spike = new Spike(
      createLogger({ sink: (line) => lines.push(line), level: 'debug' }),
      1024,
    );
    spike.pairingIssued('pg_page');
    spike.pairingScanned('pg_page');
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The page looks again after sign-in; that is no second scan.
    spike.pairingScanned('pg_page');
    spike.pairingClaimed('pg_page', 'alice', 'qr');
    // The hub replaces the spent ticket after the claim; the claim keeps the old one's trace.
    spike.pairingIssued('pg_page');
    spike.pairingDecided('pg_page', 'alice', true);
    // Someone else's call, and a call before any approval, are not this pairing's first call.
    spike.callFinished('pg_page', 'bob', 'ok');
    spike.callFinished('pg_page', 'alice', 'ok');
    spike.callFinished('pg_page', 'alice', 'ok');
    const stages = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === 'spike: pairing milestone');
    expect(stages.map((line) => line.stage)).toEqual([
      'issued',
      'scanned',
      'claimed',
      'issued',
      'approved',
      'first_call',
    ]);
    const trace = stages[0]?.trace;
    expect(trace).toMatch(/^tr_[0-9A-Z]{10}$/);
    expect(stages.filter((line) => line.trace === trace).map((line) => line.stage)).toEqual([
      'issued',
      'scanned',
      'claimed',
      'approved',
      'first_call',
    ]);
    expect(stages[3]?.trace).not.toBe(trace);
    const first = stages[5];
    expect(first).toMatchObject({ via: 'qr', userId: 'alice', outcome: 'ok' });
    expect(first?.sinceScannedMs).toBeGreaterThanOrEqual(20);
    expect(first?.sinceIssuedMs).toBeGreaterThanOrEqual(20);

    // A code claim is timed from the ticket that matched, and a scan of an earlier ticket is not its scan.
    spike.pairingScanned('pg_page');
    await new Promise((resolve) => setTimeout(resolve, 20));
    spike.pairingClaimed('pg_page', 'carol', 'code');
    // A refusal closes the record, so a later call is no first call either.
    spike.pairingDecided('pg_page', 'carol', false);
    spike.callFinished('pg_page', 'carol', 'not_attached');
    const after = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(after.filter((line) => line.stage === 'first_call')).toHaveLength(1);
    const carol = after.filter((line) => line.userId === 'carol');
    expect(carol.map((line) => line.stage)).toEqual(['claimed', 'refused']);
    expect(carol[0]).toMatchObject({ via: 'code', trace: stages[3]?.trace, sinceScannedMs: null });
    expect(carol[0]?.sinceIssuedMs).toBeGreaterThanOrEqual(20);
    expect(after.at(-1)).toMatchObject({ stage: 'refused', via: 'code' });
  });
});

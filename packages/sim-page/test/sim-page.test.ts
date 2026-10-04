// The sim page against a scripted stand-in relay on a real ws server: the
// Origin header and subprotocol arrive, the adapter core speaks the page link
// on every profile, and reload() and close() look to a relay the way a
// browser's reload and an explicit detach do.

import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import {
  ATTACH_REQUEST_TTL_MS,
  CLOSE_DETACH,
  encodeFrame,
  IDLE_TIMEOUT_MS,
  inviteSecretOf,
  MAX_DESCRIPTION_CHARS,
  MAX_FRAME_BYTES,
  MAX_RESULT_CHARS,
  type PageFrame,
  parsePageFrame,
  PING_INTERVAL_MS,
  type RelayFrame,
  RESUME_WINDOW_MS,
} from '@tabdock/protocol';
import { type CryptoLike, storageKey } from '@tabdock/adapter/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { DEFAULT_SIM_ORIGIN, RUNTIME_PROFILES, startSimPage, type SimPage } from '../src/index.ts';

interface Connection {
  readonly ws: WebSocket;
  readonly origin: string | undefined;
  readonly protocol: string;
  readonly frames: PageFrame[];
  closed: { code: number; reason: string } | null;
}

function text(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.isBuffer(data)
    ? data.toString('utf8')
    : Buffer.from(new Uint8Array(data)).toString('utf8');
}

async function startScriptedRelay() {
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    handleProtocols: (protocols) => (protocols.has('tabdock.v1') ? 'tabdock.v1' : false),
  });
  await once(server, 'listening');
  const connections: Connection[] = [];
  server.on('connection', (ws, request) => {
    const connection: Connection = {
      ws,
      origin: request.headers.origin,
      protocol: ws.protocol,
      frames: [],
      closed: null,
    };
    ws.on('message', (data) => {
      const parsed = parsePageFrame(text(data));
      if (parsed.kind !== 'ok') throw new Error(`the page sent a ${parsed.kind} frame`);
      connection.frames.push(parsed.frame);
    });
    ws.on('close', (code, reason) => {
      connection.closed = { code, reason: reason.toString() };
    });
    connections.push(connection);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/page`,
    connections,
    async connection(index: number): Promise<Connection> {
      return vi.waitFor(() => {
        const found = connections[index];
        if (!found) throw new Error(`waiting for connection ${index}`);
        return found;
      });
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => {
          resolve();
        });
      }),
  };
}

function send(connection: Connection, frame: RelayFrame): void {
  connection.ws.send(encodeFrame(frame));
}

async function frameOf<T extends PageFrame['t']>(
  connection: Connection,
  type: T,
  index = 0,
): Promise<Extract<PageFrame, { t: T }>> {
  return vi.waitFor(() => {
    const found = connection.frames.filter(
      (frame): frame is Extract<PageFrame, { t: T }> => frame.t === type,
    )[index];
    if (!found) throw new Error(`waiting for ${type} frame ${index}`);
    return found;
  });
}

function welcome(token: string, resumed = false): RelayFrame {
  return {
    t: 'welcome',
    pageId: 'page-1',
    resumeToken: token,
    resumed,
    pairing: { code: 'ABCDE-FGHJK', expiresAt: Date.now() + 120_000 },
    roster: [],
    limits: {
      maxFrameBytes: MAX_FRAME_BYTES,
      maxResultChars: MAX_RESULT_CHARS,
      maxDescriptionChars: MAX_DESCRIPTION_CHARS,
      pingIntervalMs: PING_INTERVAL_MS,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      resumeWindowMs: RESUME_WINDOW_MS,
      attachRequestTtlMs: ATTACH_REQUEST_TTL_MS,
    },
  };
}

const alice = { userId: 'alice', displayName: 'Alice', client: null, role: 'driver' as const };

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

async function setup(options: Partial<Parameters<typeof startSimPage>[0]> = {}) {
  const relay = await startScriptedRelay();
  const sim: SimPage = await startSimPage({ relayUrl: relay.url, ...options });
  cleanups.push(
    () => relay.close(),
    () => sim.close(),
  );
  return { relay, sim };
}

async function linked(options: Partial<Parameters<typeof startSimPage>[0]> = {}) {
  const { relay, sim } = await setup(options);
  const connection = await relay.connection(0);
  await frameOf(connection, 'hello');
  send(connection, welcome('token-1'));
  await sim.waitFor((state) => state.link === 'linked');
  return { relay, sim, connection };
}

/**
 * The operator approves Alice through the handle and the relay lists her, as
 * on a real page: the core refuses callers nobody approved, and callers the
 * relay does not list as attached (S5).
 */
async function approveAlice(sim: SimPage, connection: Connection): Promise<void> {
  send(connection, {
    t: 'attach_request',
    requestId: 'r-alice',
    user: { userId: 'alice', displayName: 'Alice' },
    account: { kind: 'member', verified: true },
    via: 'code',
    client: null,
    expiresAt: Date.now() + 60_000,
  });
  await sim.waitFor((state) => state.pendingRequests.some((r) => r.requestId === 'r-alice'));
  expect(sim.dock.approve('r-alice', 'driver')).toBe(true);
  send(connection, {
    t: 'roster',
    attachments: [
      {
        userId: 'alice',
        displayName: 'Alice',
        kind: 'member',
        role: 'driver',
        grantedAt: Date.now(),
        lastUsedAt: null,
        expiresAt: null,
        clients: [],
        inviteId: null,
        endsAt: null,
      },
    ],
  });
  await sim.waitFor((state) => state.roster.some((a) => a.userId === 'alice'));
}

describe.each(RUNTIME_PROFILES)('the sim page as %s', (profile) => {
  it('links with an Origin header and the subprotocol, and shares its tools', async () => {
    const { relay, sim, connection } = await linked({ profile });
    expect(connection.origin).toBe(DEFAULT_SIM_ORIGIN);
    expect(connection.protocol).toBe('tabdock.v1');
    const hello = await frameOf(connection, 'hello');
    expect(hello).toMatchObject({ v: 1, url: `${DEFAULT_SIM_ORIGIN}/`, title: 'Sim page' });
    expect(hello.resumeToken).toBeUndefined();
    expect(sim.storage.getItem(storageKey('resume', relay.url, sim.url))).toBe('token-1');

    const tools = await frameOf(connection, 'tools');
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'echo',
      'fail',
      'get_value',
      'set_value',
      'slow',
      'wipe',
    ]);
    const wipe = tools.tools.find((tool) => tool.name === 'wipe');
    expect(wipe?.inputSchema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
    expect(wipe?.annotations?.consequentialHint).toBe(
      profile === 'polyfill-5.1' ? undefined : true,
    );
  });

  it('runs calls in the runtime input form and reports handler errors', async () => {
    const { sim, connection } = await linked({
      profile,
      // On the polyfill the hint is lost, so set_value needs the operator too (ADR 0002).
      operator: { askConfirm: () => true },
    });
    await approveAlice(sim, connection);
    send(connection, {
      t: 'invoke',
      callId: 'c1',
      tool: 'set_value',
      arguments: { value: 'hi' },
      caller: alice,
      deadlineMs: 5000,
    });
    expect(await frameOf(connection, 'result')).toEqual({
      t: 'result',
      callId: 'c1',
      ok: true,
      content: '{"value":"hi"}',
    });
    expect(sim.store.value).toBe('hi');

    send(connection, {
      t: 'invoke',
      callId: 'c2',
      tool: 'fail',
      arguments: { message: 'boom' },
      caller: alice,
      deadlineMs: 5000,
    });
    const failed = await frameOf(connection, 'result', 1);
    expect(failed.error?.code).toBe('tool_error');
    expect(failed.error?.message.endsWith(': boom')).toBe(profile === 'polyfill-5.1');
    expect(sim.state.notice !== null).toBe(profile === 'polyfill-5.1');
  });
});

describe('startSimPage', () => {
  it("passes the operator's Invite form to the current page's handle (ADR 0017)", async () => {
    const { sim } = await linked({ policy: { invites: 'all' } });
    // Nothing to cancel before invites exist; Revoke takes closeInvite all the same.
    expect(sim.cancelInvite('inv_1')).toBe(false);
    expect(sim.state).toMatchObject({ invites: [], invitesOffered: null });
    // A relay that sends no invites frame offers none, so the answer is unavailable, after the checks.
    expect(await sim.invite({ label: 'Friends', role: 'observer', uses: 3 })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(await sim.invite({ label: '', role: 'observer' })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('passes its crypto option to the core: one without subtle, as outside a secure context, mints nothing', async () => {
    const insecure = {
      getRandomValues: <T extends Uint8Array<ArrayBuffer>>(array: T): T =>
        globalThis.crypto.getRandomValues(array),
    } as unknown as CryptoLike;
    const { sim, connection } = await linked({ policy: { invites: 'all' }, crypto: insecure });
    send(connection, { t: 'invites', linkBase: 'https://relay.example/i', invites: [] });
    await sim.waitFor((state) => state.invitesOffered !== null);
    expect(await sim.invite({ label: 'Friends', role: 'observer' })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    // A ping and its pong: everything the page sent before it has arrived.
    send(connection, { t: 'ping' });
    await frameOf(connection, 'pong');
    expect(connection.frames.filter((frame) => frame.t === 'invite_create')).toEqual([]);
  });

  it("mints with Node's WebCrypto, keeps the record across a reload, and asks the operator about a Can control redemption", async () => {
    const asked: string[] = [];
    const { relay, sim, connection } = await linked({
      policy: { invites: 'all' },
      operator: {
        askAttach: (request) => {
          asked.push(`${request.via} ${request.invite?.label ?? ''}`);
          return 'driver';
        },
      },
    });
    const listing = (create: Extract<PageFrame, { t: 'invite_create' }>) => ({
      inviteId: create.inviteId,
      role: create.role,
      label: create.label,
      uses: create.uses,
      expiresAt: create.expiresAt,
      usesLeft: create.uses,
      sponsor: { userId: 'alice', displayName: 'Alice' },
      pending: false,
      refusals: 0,
    });
    send(connection, { t: 'invites', linkBase: 'https://relay.example/i', invites: [] });
    await sim.waitFor((state) => state.invitesOffered !== null);
    const minting = sim.invite({ label: 'Help', role: 'driver' });
    const create = await frameOf(connection, 'invite_create');
    send(connection, {
      t: 'invites',
      linkBase: 'https://relay.example/i',
      invites: [listing(create)],
    });
    const minted = await minting;
    if (!minted.ok) throw new Error(minted.reason);
    const secret = inviteSecretOf(minted.link) ?? '';
    expect(create.secretHash).toBe(createHash('sha256').update(secret, 'utf8').digest('hex'));

    // A reload into the same session keeps the record, never the secret.
    await sim.reload();
    const next = await relay.connection(1);
    expect(await frameOf(next, 'hello')).toMatchObject({ resumeToken: 'token-1' });
    send(next, welcome('token-2', true));
    send(next, { t: 'invites', linkBase: 'https://relay.example/i', invites: [listing(create)] });
    await sim.waitFor((state) => state.invites.length === 1);
    for (const value of [...sim.logs, JSON.stringify(sim.state)]) {
      expect(value).not.toContain(secret);
    }
    send(next, {
      t: 'attach_request',
      requestId: 'redeem',
      user: { userId: `g_${'ab'.repeat(16)}`, displayName: 'guest@example.com' },
      account: { kind: 'invitee', verified: true },
      via: 'invite',
      invite: { inviteId: create.inviteId, secret, label: 'Help' },
      client: null,
      expiresAt: Date.now() + 60_000,
    });
    expect(await frameOf(next, 'attach_decision')).toEqual({
      t: 'attach_decision',
      requestId: 'redeem',
      allow: true,
      role: 'driver',
    });
    expect(asked).toEqual(['invite Help']);
  });

  it('lets a scripted operator answer attach requests', async () => {
    const { connection } = await linked({ operator: { askAttach: () => 'observer' } });
    send(connection, {
      t: 'attach_request',
      requestId: 'r1',
      user: { userId: 'bob', displayName: 'Bob' },
      account: { kind: 'member', verified: true },
      via: 'code',
      client: { name: 'claude-code', version: '2.1.287' },
      expiresAt: Date.now() + 60_000,
    });
    expect(await frameOf(connection, 'attach_decision')).toEqual({
      t: 'attach_decision',
      requestId: 'r1',
      allow: true,
      role: 'observer',
    });
  });

  it('leaves prompts to the handle when there is no operator', async () => {
    const { sim, connection } = await linked();
    send(connection, {
      t: 'attach_request',
      requestId: 'r1',
      user: { userId: 'bob', displayName: 'Bob' },
      account: { kind: 'member', verified: true },
      via: 'code',
      client: null,
      expiresAt: Date.now() + 60_000,
    });
    const state = await sim.waitFor((current) => current.pendingRequests.length === 1);
    expect(sim.dock.approve(state.pendingRequests[0]?.requestId ?? '', 'driver')).toBe(true);
    expect(await frameOf(connection, 'attach_decision')).toMatchObject({
      allow: true,
      role: 'driver',
    });
  });

  it('cancels a running call and stops the handler on Chrome', async () => {
    const { sim, connection } = await linked({ profile: 'chrome-156' });
    await approveAlice(sim, connection);
    send(connection, {
      t: 'invoke',
      callId: 'c1',
      tool: 'slow',
      arguments: { ms: 10_000 },
      caller: alice,
      deadlineMs: 20_000,
    });
    await vi.waitFor(() => {
      expect(sim.store.calls.map((call) => call.tool)).toContain('slow');
    });
    send(connection, { t: 'cancel', callId: 'c1' });
    expect(await frameOf(connection, 'result')).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    });
  });

  it('reloads like a browser: going away, then resuming with the stored token', async () => {
    const { relay, sim, connection } = await linked();
    const firstContext = sim.context;
    await sim.reload();
    await vi.waitFor(() => {
      expect(connection.closed?.code).toBe(1001);
    });
    const second = await relay.connection(1);
    expect((await frameOf(second, 'hello')).resumeToken).toBe('token-1');
    expect(sim.context).not.toBe(firstContext);
    send(second, welcome('token-2', true));
    await sim.waitFor((state) => state.link === 'linked');
    expect(sim.storage.getItem(storageKey('resume', relay.url, sim.url))).toBe('token-2');
    expect(sim.connections).toBe(2);
  });

  it("navigates like a browser: the next page has its own session, and going back finds the first page's", async () => {
    const { relay, sim, connection } = await linked({ path: '/board' });
    expect(sim.url).toBe(`${DEFAULT_SIM_ORIGIN}/board`);
    await sim.navigate('/settings');
    await vi.waitFor(() => {
      expect(connection.closed?.code).toBe(1001);
    });
    expect(sim.url).toBe(`${DEFAULT_SIM_ORIGIN}/settings`);
    const second = await relay.connection(1);
    const hello = await frameOf(second, 'hello');
    expect(hello.url).toBe(`${DEFAULT_SIM_ORIGIN}/settings`);
    expect(hello.resumeToken).toBeUndefined();
    send(second, welcome('token-2'));
    await sim.waitFor((state) => state.link === 'linked');

    await sim.navigate('/board');
    const third = await relay.connection(2);
    expect(await frameOf(third, 'hello')).toMatchObject({
      url: `${DEFAULT_SIM_ORIGIN}/board`,
      resumeToken: 'token-1',
    });
  });

  it('detaches on close: CLOSE_DETACH and no token left behind', async () => {
    const { relay, sim, connection } = await linked();
    await sim.close();
    await vi.waitFor(() => {
      expect(connection.closed?.code).toBe(CLOSE_DETACH);
    });
    expect(sim.storage.getItem(storageKey('resume', relay.url, sim.url))).toBeNull();
    expect(sim.state.link).toBe('closed');
  });

  it('sends no Origin header when origin is null', async () => {
    const { relay } = await setup({ origin: null });
    const connection = await relay.connection(0);
    expect(connection.origin).toBeUndefined();
  });

  it('never logs the resume token, the pairing code or call arguments', async () => {
    const { sim, connection } = await linked();
    await approveAlice(sim, connection);
    send(connection, {
      t: 'invoke',
      callId: 'c1',
      tool: 'echo',
      arguments: { secret: 'argument-value-xyz' },
      caller: alice,
      deadlineMs: 5000,
    });
    expect(await frameOf(connection, 'result')).toMatchObject({ ok: true });
    const logs = sim.logs.join('\n');
    expect(logs).toContain('call c1 echo by Alice (driver): ok');
    for (const secret of ['token-1', 'ABCDE-FGHJK', 'argument-value-xyz']) {
      expect(logs).not.toContain(secret);
    }
  });
});

describe("the sim page's operator controls", () => {
  it('records calls in the activity log and sends set_role and revoke', async () => {
    const { sim, connection } = await linked();
    await approveAlice(sim, connection);
    send(connection, {
      t: 'invoke',
      callId: 'c1',
      tool: 'get_value',
      arguments: {},
      caller: { ...alice, client: { name: 'claude-code', version: '2.1.287' } },
      deadlineMs: 5000,
    });
    expect(await frameOf(connection, 'result')).toMatchObject({ callId: 'c1', ok: true });
    expect(sim.activity).toMatchObject([
      {
        callId: 'c1',
        user: { userId: 'alice', displayName: 'Alice' },
        client: { name: 'claude-code', version: '2.1.287' },
        tool: 'get_value',
        outcome: 'ok',
      },
    ]);

    expect(sim.setRole('alice', 'observer')).toBe(true);
    expect(await frameOf(connection, 'set_role')).toEqual({
      t: 'set_role',
      userId: 'alice',
      role: 'observer',
    });
    expect(sim.revoke('alice')).toBe(true);
    expect(await frameOf(connection, 'revoke')).toEqual({ t: 'revoke', userId: 'alice' });
  });

  it('pauses with page_busy and stays paused across a reload', async () => {
    const { relay, sim, connection } = await linked();
    await approveAlice(sim, connection);
    sim.pause(true);
    send(connection, {
      t: 'invoke',
      callId: 'c1',
      tool: 'get_value',
      arguments: {},
      caller: alice,
      deadlineMs: 5000,
    });
    expect(await frameOf(connection, 'result')).toMatchObject({
      callId: 'c1',
      ok: false,
      error: { code: 'page_busy' },
    });

    await sim.reload();
    const second = await relay.connection(1);
    await frameOf(second, 'hello');
    send(second, welcome('token-2', true));
    await sim.waitFor((state) => state.link === 'linked');
    expect(sim.state.paused).toBe(true);
    send(second, {
      t: 'invoke',
      callId: 'c2',
      tool: 'get_value',
      arguments: {},
      caller: alice,
      deadlineMs: 5000,
    });
    expect(await frameOf(second, 'result')).toMatchObject({ error: { code: 'page_busy' } });
    sim.pause(false);
    expect(sim.state.paused).toBe(false);
  });
});

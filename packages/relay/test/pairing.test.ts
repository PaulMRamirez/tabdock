import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { connectPage, type TestPage, TOOLS } from './helpers/page-client.ts';
import {
  ALICE,
  BOB,
  CAROL,
  callTool,
  connectClient,
  delay,
  pairAndApprove,
  startRelay,
  type TestRelay,
} from './helpers/relay.ts';

let current: TestRelay | undefined;
const pages: TestPage[] = [];
const clients: Client[] = [];

async function setup(options: Parameters<typeof startRelay>[0] = {}): Promise<TestRelay> {
  current = await startRelay(options);
  return current;
}

async function page(options: Parameters<typeof connectPage>[1] = {}): Promise<TestPage> {
  if (!current) throw new Error('no relay');
  const opened = await connectPage(current.relay.pageUrl, { tools: TOOLS, ...options });
  pages.push(opened);
  return opened;
}

async function client(user = ALICE): Promise<Client> {
  if (!current) throw new Error('no relay');
  const connected = await connectClient(current.relay, user);
  clients.push(connected);
  return connected;
}

afterEach(async () => {
  for (const connected of clients.splice(0)) await connected.close();
  for (const opened of pages.splice(0)) opened.ws.terminate();
  await current?.close();
  current = undefined;
});

const EXPIRED = 'pairing_expired: code is invalid or expired';

describe('pair_page (A1.4, S3, S4)', () => {
  it('a wrong code and a malformed code both give pairing_expired', async () => {
    await setup();
    const opened = await page();
    const alice = await client();
    const wrong = opened.code.startsWith('0')
      ? `1${opened.code.slice(1)}`
      : `0${opened.code.slice(1)}`;
    for (const code of [wrong, 'hello', 'ABCDE-FGHU2', '']) {
      const outcome = await callTool(alice, 'pair_page', { code });
      expect(outcome.isError, code).toBe(true);
      if (code !== '') expect(outcome.text).toBe(EXPIRED);
    }
    expect(opened.all('attach_request')).toHaveLength(0);
  });

  it('an expired code gives the same pairing_expired, and the page already shows a new one', async () => {
    await setup({ timings: { pairingTtlMs: 150 } });
    const opened = await page();
    const alice = await client();
    const old = opened.code;
    await opened.next('pairing', 1000);
    const outcome = await callTool(alice, 'pair_page', { code: old });
    expect(outcome).toMatchObject({ isError: true, text: EXPIRED });
    expect(opened.code).not.toBe(old);
  });

  it('accepts the code as people retype it', async () => {
    await setup();
    const opened = await page({ policy: { autoApprove: 'observer' } });
    const alice = await client();
    const typed = ` ${opened.code.toLowerCase().replace('-', ' ').replaceAll('0', 'o').replaceAll('1', 'l')} `;
    const outcome = await callTool(alice, 'pair_page', { code: typed });
    expect(outcome.isError, outcome.text).toBe(false);
  });

  it('a code works once, and the page gets a fresh one the moment it is used', async () => {
    await setup();
    const opened = await page({ policy: { autoApprove: 'observer' } });
    const alice = await client();
    const bob = await client(BOB);
    const code = opened.code;
    expect((await callTool(alice, 'pair_page', { code })).isError).toBe(false);
    const fresh = await opened.next('pairing');
    expect(fresh.code).not.toBe(code);
    expect(await callTool(bob, 'pair_page', { code })).toMatchObject({
      isError: true,
      text: EXPIRED,
    });
    expect((await callTool(bob, 'pair_page', { code: fresh.code })).isError).toBe(false);
  });

  it('sends an attach request and attaches with the role the operator picks', async () => {
    await setup();
    const opened = await page({ title: 'Board' });
    const alice = await client();
    const pending = callTool(alice, 'pair_page', { code: opened.code });
    const request = await opened.next('attach_request');
    expect(request).toMatchObject({
      user: { userId: 'alice', displayName: 'Alice' },
      via: 'code',
      client: null,
    });
    expect(request.requestId).toMatch(/^rq_/);
    expect(request.expiresAt).toBeGreaterThan(Date.now());
    // Nothing exists until the operator answers (S4).
    expect((await callTool(alice, 'list_pages')).structured).toEqual({ pages: [] });
    opened.send({
      t: 'attach_decision',
      requestId: request.requestId,
      allow: true,
      role: 'driver',
    });
    const outcome = await pending;
    expect(outcome.text).toBe(
      `Attached to page ${opened.pageId} (http://localhost:5173) as driver.`,
    );
    expect(outcome.structured).toEqual({
      page: opened.pageId,
      origin: 'http://localhost:5173',
      role: 'driver',
    });
    const roster = await opened.next('roster');
    expect(roster.attachments).toMatchObject([
      { userId: 'alice', displayName: 'Alice', role: 'driver', lastUsedAt: null, expiresAt: null },
    ]);
  });

  it('an approval without a role attaches as observer', async () => {
    await setup();
    const opened = await page();
    const outcome = await pairAndApprove(await client(), opened, null);
    expect(outcome.structured).toMatchObject({ role: 'observer' });
  });

  it('a denial gives denied_by_operator and no attachment', async () => {
    await setup();
    const opened = await page();
    const alice = await client();
    const pending = callTool(alice, 'pair_page', { code: opened.code });
    const request = await opened.next('attach_request');
    opened.send({ t: 'attach_decision', requestId: request.requestId, allow: false });
    expect(await pending).toMatchObject({
      isError: true,
      text: 'denied_by_operator: the page operator denied the attach request',
    });
    expect((await callTool(alice, 'list_pages')).structured).toEqual({ pages: [] });
  });

  it('autoApprove observer attaches at once without asking the operator', async () => {
    await setup();
    const opened = await page({ policy: { autoApprove: 'observer' } });
    const alice = await client();
    const outcome = await callTool(alice, 'pair_page', { code: opened.code });
    expect(outcome.structured).toMatchObject({ role: 'observer' });
    expect(opened.all('attach_request')).toHaveLength(0);
    expect((await opened.next('roster')).attachments).toHaveLength(1);
  });

  it('pairing again while attached returns the existing attachment', async () => {
    await setup();
    const opened = await page();
    const alice = await client();
    await pairAndApprove(alice, opened, 'driver');
    const again = await callTool(alice, 'pair_page', { code: opened.code });
    expect(again.text).toContain('as driver. You were already attached.');
    expect(opened.all('attach_request')).toHaveLength(1);
  });

  it('stops waiting with timeout, and a later approval still shows up in list_pages', async () => {
    await setup({ timings: { pairWaitMs: 200, attachRequestTtlMs: 5000 } });
    const opened = await page();
    const alice = await client();
    const outcome = await callTool(alice, 'pair_page', { code: opened.code });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/^timeout: the operator has not answered yet/);
    expect(outcome.text).toContain('stays open on the page');
    expect(outcome.text).toContain('list_pages');
    const request = await opened.next('attach_request');
    opened.send({
      t: 'attach_decision',
      requestId: request.requestId,
      allow: true,
      role: 'driver',
    });
    await opened.next('roster');
    expect((await callTool(alice, 'list_pages')).structured).toMatchObject({
      pages: [{ page: opened.pageId, role: 'driver', state: 'awake' }],
    });
  });

  it('silence past the request lifetime means deny, and a late decision is ignored', async () => {
    await setup({ timings: { pairWaitMs: 2000, attachRequestTtlMs: 150 } });
    const opened = await page();
    const alice = await client();
    const outcome = await callTool(alice, 'pair_page', { code: opened.code });
    expect(outcome.text).toBe(
      'timeout: the operator did not answer in time, so the request was denied',
    );
    const request = await opened.next('attach_request');
    opened.send({
      t: 'attach_decision',
      requestId: request.requestId,
      allow: true,
      role: 'driver',
    });
    await opened.sync();
    expect((await callTool(alice, 'list_pages')).structured).toEqual({ pages: [] });
  });

  it("a page cannot answer another page's attach request", async () => {
    await setup();
    const target = await page();
    const other = await page();
    const alice = await client();
    const pending = callTool(alice, 'pair_page', { code: target.code });
    const request = await target.next('attach_request');
    other.send({ t: 'attach_decision', requestId: request.requestId, allow: true, role: 'driver' });
    await other.sync();
    target.send({ t: 'attach_decision', requestId: request.requestId, allow: false });
    expect((await pending).text).toMatch(/^denied_by_operator/);
  });

  it('a page that drops while the operator decides fails the wait with page_asleep', async () => {
    await setup();
    const opened = await page();
    const alice = await client();
    const pending = callTool(alice, 'pair_page', { code: opened.code });
    await opened.next('attach_request');
    opened.ws.terminate();
    expect((await pending).text).toMatch(/^page_asleep: /);
  });

  it('a reload that replaces the socket ends requests the new page never saw', async () => {
    await setup();
    const opened = await page();
    const alice = await client();
    const pending = callTool(alice, 'pair_page', { code: opened.code });
    await opened.next('attach_request');
    const reloaded = await page({ resumeToken: opened.welcome?.resumeToken ?? '' });
    expect(reloaded.welcome?.resumed).toBe(true);
    expect((await pending).text).toMatch(/^page_asleep: /);
  });

  it('maxDrivers counts users: a driver grant beyond it becomes observer', async () => {
    await setup();
    const opened = await page({ policy: { maxDrivers: 1 } });
    await pairAndApprove(await client(), opened, 'driver');
    const bob = await pairAndApprove(await client(BOB), opened, 'driver');
    expect(bob.structured).toMatchObject({ role: 'observer' });
    // Alice's second client is the same user, so she keeps her one driver seat.
    const second = await callTool(await client(ALICE), 'pair_page', { code: opened.code });
    expect(second.structured).toMatchObject({ role: 'driver' });
  });
});

describe('pairing rate limits (S3)', () => {
  it('limit attempts per user', async () => {
    await setup({ rateLimits: { pairAttemptsPerUser: 3, pairAttemptsPerAddress: 100 } });
    const opened = await page({ policy: { autoApprove: 'observer' } });
    const alice = await client();
    for (let i = 0; i < 3; i += 1) {
      expect((await callTool(alice, 'pair_page', { code: 'ZZZZZ-ZZZZZ' })).text).toBe(EXPIRED);
    }
    // Even the right code is refused once the user is over the limit.
    expect(await callTool(alice, 'pair_page', { code: opened.code })).toMatchObject({
      isError: true,
      text: 'rate_limited: too many pairing attempts; wait a minute and try again',
    });
    expect((await callTool(await client(BOB), 'pair_page', { code: opened.code })).isError).toBe(
      false,
    );
  });

  it('limit attempts per client address across users', async () => {
    await setup({ rateLimits: { pairAttemptsPerUser: 100, pairAttemptsPerAddress: 4 } });
    const alice = await client();
    const bob = await client(BOB);
    for (const who of [alice, alice, bob, bob]) {
      expect((await callTool(who, 'pair_page', { code: 'ZZZZZ-ZZZZZ' })).text).toBe(EXPIRED);
    }
    expect(
      (await callTool(await client(CAROL), 'pair_page', { code: 'ZZZZZ-ZZZZZ' })).text,
    ).toMatch(/^rate_limited: /);
  });

  it('let attempts through again once the window has passed', async () => {
    await setup({ rateLimits: { pairAttemptsPerUser: 1, windowMs: 200 } });
    const alice = await client();
    expect((await callTool(alice, 'pair_page', { code: 'ZZZZZ-ZZZZZ' })).text).toBe(EXPIRED);
    expect((await callTool(alice, 'pair_page', { code: 'ZZZZZ-ZZZZZ' })).text).toMatch(
      /^rate_limited/,
    );
    await delay(250);
    expect((await callTool(alice, 'pair_page', { code: 'ZZZZZ-ZZZZZ' })).text).toBe(EXPIRED);
  });
});

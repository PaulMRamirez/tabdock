// Attachment idle expiry (ADR 0009): an attachment ends a set time after its
// grant or last call, like a revoke, and each call moves that time.

import type { Client } from '@modelcontextprotocol/client';
import type { JsonObject, PageTool } from '@tabdock/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDuration } from '../src/hub.ts';
import {
  connectPage,
  type InvokeFrame,
  type PageOptions,
  type TestPage,
  TOOLS,
} from './helpers/page-client.ts';
import {
  ALICE,
  BOB,
  callTool,
  connectClient,
  delay,
  eventually,
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

async function page(options: PageOptions = {}): Promise<TestPage> {
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
  vi.restoreAllMocks();
  for (const connected of clients.splice(0)) await connected.close();
  for (const opened of pages.splice(0)) opened.ws.terminate();
  await current?.close();
  current = undefined;
});

const getView = (who: Client, pageId: string) =>
  callTool(who, 'call_page_tool', { page: pageId, tool: 'get_view' });

describe('attachment idle expiry', () => {
  it('starts at the grant, moves with every call, and the roster carries it', async () => {
    await setup({ timings: { attachmentIdleMs: 2000 } });
    const opened = await page({ onInvoke: () => ({ ok: true, content: '{}' }) });
    const alice = await client();
    await pairAndApprove(alice, opened);
    const granted = opened.all('roster').at(-1)?.attachments[0];
    expect(granted?.lastUsedAt).toBeNull();
    expect(granted?.expiresAt).toBe((granted?.grantedAt ?? 0) + 2000);
    // Past the roster refresh step (a tenth of the idle time here), a call re-sends it.
    await delay(250);
    const before = opened.all('roster').length;
    expect((await getView(alice, opened.pageId)).isError).toBe(false);
    await opened.sync();
    expect(opened.all('roster').length).toBe(before + 1);
    const moved = opened.all('roster').at(-1)?.attachments[0];
    expect(moved?.lastUsedAt).toBeGreaterThan(granted?.grantedAt ?? 0);
    expect(moved?.expiresAt).toBe((moved?.lastUsedAt ?? 0) + 2000);
    // Right after, another call moves the expiry without another roster.
    expect((await getView(alice, opened.pageId)).isError).toBe(false);
    await opened.sync();
    expect(opened.all('roster').length).toBe(before + 1);
  });

  it('ends an unused attachment like a revoke: roster updated, calls refused, nothing audited', async () => {
    const { relay, lines } = await setup({ timings: { attachmentIdleMs: 200 } });
    const opened = await page();
    const alice = await client();
    const bob = await client(BOB);
    await pairAndApprove(alice, opened);
    await delay(100);
    await pairAndApprove(bob, opened, 'observer');
    // Alice's expiry leaves Bob alone on the roster; he expires a little later himself.
    await eventually(() =>
      opened
        .all('roster')
        .some((roster) => JSON.stringify(roster.attachments.map((a) => a.userId)) === '["bob"]'),
    );
    await eventually(() => lines.some((line) => line.includes('"msg":"attachment expired"')));
    expect((await callTool(alice, 'list_pages')).structured).toEqual({ pages: [] });
    expect((await getView(alice, opened.pageId)).text).toBe(
      `not_attached: you are not attached to page ${opened.pageId}`,
    );
    expect(relay.audit.records().map((record) => [record.userId, record.outcome])).toEqual([
      ['alice', 'not_attached'],
    ]);
  });

  it('keeps an attachment that is used more often than its idle time', async () => {
    await setup({ timings: { attachmentIdleMs: 500 } });
    const opened = await page({ onInvoke: () => ({ ok: true, content: '{}' }) });
    const alice = await client();
    await pairAndApprove(alice, opened);
    for (let i = 0; i < 6; i += 1) {
      await delay(150);
      expect((await getView(alice, opened.pageId)).isError).toBe(false);
    }
  });

  it("cancels the user's running call and drops the queued one when it expires", async () => {
    await setup({ timings: { attachmentIdleMs: 300, callDeadlineMs: 5000 } });
    const held: InvokeFrame[] = [];
    const opened = await page({
      onInvoke: (frame) => {
        held.push(frame);
        return undefined;
      },
    });
    const alice = await client();
    await pairAndApprove(alice, opened);
    const write = (label: string) =>
      callTool(alice, 'call_page_tool', {
        page: opened.pageId,
        tool: 'add_item',
        arguments: { label },
      });
    const running = write('a');
    const queued = write('b');
    const expired = `not_attached: your attachment expired after ${formatDuration(300)} without a call; pair again to use the page`;
    expect((await running).text).toBe(expired);
    expect((await queued).text).toBe(expired);
    expect(held).toHaveLength(1);
    expect(opened.all('cancel')).toEqual([
      { t: 'cancel', callId: held[0]?.callId, reason: 'revoked' },
    ]);
  });

  it('checks the expiry on every access, even before its timer fires', async () => {
    await setup();
    const opened = await page({ onInvoke: () => ({ ok: true, content: '{}' }) });
    const alice = await client();
    await pairAndApprove(alice, opened);
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 8 * 60 * 60_000 + 1000);
    expect((await getView(alice, opened.pageId)).text).toMatch(/^not_attached: /);
    expect(opened.all('invoke')).toHaveLength(0);
  });

  it('names a client only once its call passes every check', async () => {
    // A generous check budget, so the invalid call below is refused by its
    // check however loaded the test run is, rather than let through unchecked.
    const { relay, lines } = await setup({
      limits: { queueDepth: 1 },
      timings: { argumentCheckMs: 2000 },
    });
    const held: InvokeFrame[] = [];
    const opened = await page({
      policy: { maxDrivers: 2 },
      onInvoke: (frame) => {
        if (frame.tool === 'get_view') return { ok: true, content: '{}' };
        held.push(frame);
        return undefined;
      },
    });
    await pairAndApprove(await client(), opened, 'observer');
    const bob = await client(BOB);
    await pairAndApprove(bob, opened, 'driver');
    const write = (who: Client) =>
      callTool(who, 'call_page_tool', {
        page: opened.pageId,
        tool: 'add_item',
        arguments: { label: 'x' },
      });
    // Bob fills the queue: one write on the page and one waiting behind it.
    const writes = [write(bob), write(bob)];
    await eventually(
      () =>
        held.length === 1 && lines.filter((line) => line.includes('"call queued"')).length === 2,
    );
    await opened.sync();
    const before = opened.all('roster').length;
    for (const [user, name, tool, args] of [
      [ALICE, 'stranger-missing', 'no_such_tool', {}],
      [ALICE, 'stranger-write', 'add_item', { label: 'x' }],
      [ALICE, 'stranger-invalid', 'get_view', { label: 'x' }],
      [BOB, 'stranger-busy', 'add_item', { label: 'x' }],
    ] as const) {
      const renamed = await connectClient(relay, user, { name, modern: true });
      clients.push(renamed);
      const refused = await callTool(renamed, 'call_page_tool', {
        page: opened.pageId,
        tool,
        arguments: args,
      });
      expect(refused.text).toMatch(/^(tool_not_found|role_denied|invalid_arguments|page_busy): /);
    }
    expect(
      relay.audit
        .records()
        .slice(-4)
        .map((record) => record.outcome),
    ).toEqual(['tool_not_found', 'role_denied', 'invalid_arguments', 'page_busy']);
    await opened.sync();
    // Nothing the operator sees changed: no roster went out, and none names the refused clients.
    expect(opened.all('roster')).toHaveLength(before);
    expect(JSON.stringify(opened.all('roster'))).not.toContain('stranger');
    const reader = await connectClient(relay, ALICE, { name: 'reader', modern: true });
    clients.push(reader);
    expect((await getView(reader, opened.pageId)).isError).toBe(false);
    await opened.sync();
    expect(
      opened
        .all('roster')
        .at(-1)
        ?.attachments.find((entry) => entry.userId === 'alice')
        ?.clients.map((c) => c.name),
    ).toEqual(['reader', 'relay-test']);
    for (let i = 0; i < 2; i += 1) {
      await eventually(() => held.length === i + 1);
      opened.send({ t: 'result', callId: held[i]?.callId ?? '', ok: true, content: '{}' });
    }
    for (const outcome of await Promise.all(writes)) expect(outcome.isError).toBe(false);
    expect(JSON.stringify(opened.all('roster'))).not.toContain('stranger');
  });

  it('sends at most one roster per refresh step for new clients, and a trailing one carries the rest', async () => {
    // A tenth of the idle time: a 1.5 s refresh step.
    const { relay } = await setup({ timings: { attachmentIdleMs: 15_000 } });
    const opened = await page({ onInvoke: () => ({ ok: true, content: '{}' }) });
    await pairAndApprove(await client(), opened);
    await opened.sync();
    const before = opened.all('roster').length;
    const started = Date.now();
    for (let i = 1; i <= 8; i += 1) {
      const renamed = await connectClient(relay, ALICE, { name: `c${String(i)}`, modern: true });
      clients.push(renamed);
      expect((await getView(renamed, opened.pageId)).isError).toBe(false);
    }
    await opened.sync();
    // The burst fits well inside one step, so only the first new client went out at once.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(opened.all('roster')).toHaveLength(before + 1);
    expect(opened.all('roster').at(-1)?.attachments[0]?.clients[0]?.name).toBe('c1');
    // The held-back changes still arrive, together, one step after that roster.
    await eventually(() => opened.all('roster').length === before + 2, 3000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
    expect(
      opened
        .all('roster')
        .at(-1)
        ?.attachments[0]?.clients.map((c) => c.name)
        .slice(0, 8),
    ).toEqual(['c8', 'c7', 'c6', 'c5', 'c4', 'c3', 'c2', 'c1']);
    await delay(300);
    expect(opened.all('roster')).toHaveLength(before + 2);
  });

  it('names a new client in the roster its own call sends after a quiet step, for a read and for a write', async () => {
    // A tenth of the idle time: a 1 s refresh step.
    const { relay } = await setup({ timings: { attachmentIdleMs: 10_000 } });
    const opened = await page({ onInvoke: () => ({ ok: true, content: '{}' }) });
    await pairAndApprove(await client(), opened);
    for (const [name, tool, args] of [
      ['phone', 'get_view', {}],
      ['tablet', 'add_item', { label: 'x' }],
    ] as const) {
      const renamed = await connectClient(relay, ALICE, { name, modern: true });
      clients.push(renamed);
      // A quiet step: the roster the page shows is a step old, so the call's arrival sends one.
      await delay(1100);
      await opened.sync();
      const before = opened.all('roster').length;
      const outcome = await callTool(renamed, 'call_page_tool', {
        page: opened.pageId,
        tool,
        arguments: args,
      });
      expect(outcome.isError, outcome.text).toBe(false);
      await opened.sync();
      // The arrival's roster could not name a client whose call was not yet
      // checked, so one naming it follows at once rather than a step later.
      expect(opened.all('roster')).toHaveLength(before + 2);
      expect(opened.all('roster').at(-1)?.attachments[0]?.clients[0]?.name).toBe(name);
    }
  });

  it('holds a late name to the trailing roster when another call sent the last one, so a slow check adds no third roster to a step', async () => {
    // Each level references the next twice, so the check runs its whole budget and gives up.
    const $defs: Record<string, unknown> = {};
    for (let level = 0; level < 24; level += 1) {
      const next = { $ref: `#/$defs/d${String(level + 1)}` };
      $defs[`d${String(level)}`] = { anyOf: [next, next] };
    }
    $defs.d24 = { type: 'object' };
    const slowRead: PageTool = {
      name: 'slow_read',
      description: 'A read whose argument check runs its whole budget.',
      inputSchema: { type: 'object', $defs, $ref: '#/$defs/d0' },
      annotations: { readOnlyHint: true },
    };
    // Nested past what the relay prepares for a check, so its calls skip the worker entirely.
    let deep: JsonObject = { type: 'string' };
    for (let level = 0; level < 40; level += 1) {
      deep = { type: 'object', properties: { a: deep } };
    }
    const quickRead: PageTool = {
      name: 'quick_read',
      description: 'A read whose schema is too deep to check, so it never waits on the worker.',
      inputSchema: deep,
      annotations: { readOnlyHint: true },
    };
    // A 1 s refresh step, and a check that outlasts it.
    const { relay } = await setup({
      timings: { attachmentIdleMs: 10_000, argumentCheckMs: 1500, callDeadlineMs: 10_000 },
    });
    const opened = await page({
      tools: [...TOOLS, slowRead, quickRead],
      onInvoke: () => ({ ok: true, content: '{}' }),
    });
    await pairAndApprove(await client(), opened);
    const slow = await connectClient(relay, ALICE, { name: 'slow', modern: true });
    const quick = await connectClient(relay, ALICE, { name: 'quick', modern: true });
    clients.push(slow, quick);
    await delay(1100);
    await opened.sync();
    const before = opened.all('roster').length;

    // The slow call's arrival sends a roster; its name waits on its check.
    const slowCall = callTool(slow, 'call_page_tool', {
      page: opened.pageId,
      tool: 'slow_read',
      arguments: {},
    });
    await delay(1100);
    // A step later the quick call's arrival sends one, and its name follows at once.
    const quickCall = await callTool(quick, 'call_page_tool', {
      page: opened.pageId,
      tool: 'quick_read',
      arguments: {},
    });
    expect(quickCall.isError, quickCall.text).toBe(false);
    await opened.sync();
    expect(opened.all('roster')).toHaveLength(before + 3);
    const quickNamed = Date.now();

    // The slow check gives up inside that step. Its name must wait for the
    // trailing roster, or the step would carry a third roster.
    expect((await slowCall).isError).toBe(false);
    await opened.sync();
    expect(Date.now() - quickNamed).toBeLessThan(900);
    expect(opened.all('roster')).toHaveLength(before + 3);
    await eventually(() => opened.all('roster').length === before + 4, 3000);
    expect(opened.all('roster').at(-1)?.attachments[0]?.clients[0]?.name).toBe('slow');
  });

  it('after a quiet step, a burst of new clients sends the arrival roster and the first name at once, and one trailing roster for the rest', async () => {
    // A tenth of the idle time: a 1.5 s refresh step.
    const { relay } = await setup({ timings: { attachmentIdleMs: 15_000 } });
    const opened = await page({ onInvoke: () => ({ ok: true, content: '{}' }) });
    await pairAndApprove(await client(), opened);
    const renamed: Client[] = [];
    for (let i = 1; i <= 6; i += 1) {
      renamed.push(await connectClient(relay, ALICE, { name: `r${String(i)}`, modern: true }));
    }
    clients.push(...renamed);
    await delay(1600);
    await opened.sync();
    const before = opened.all('roster').length;
    const started = Date.now();
    for (const each of renamed) expect((await getView(each, opened.pageId)).isError).toBe(false);
    await opened.sync();
    // The burst fits well inside one step, so a client renaming itself on
    // every call adds one roster to the arrival's, and no more, until the step ends.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(opened.all('roster')).toHaveLength(before + 2);
    expect(opened.all('roster').at(-1)?.attachments[0]?.clients[0]?.name).toBe('r1');
    await eventually(() => opened.all('roster').length === before + 3, 3000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
    expect(
      opened
        .all('roster')
        .at(-1)
        ?.attachments[0]?.clients.map((c) => c.name)
        .slice(0, 6),
    ).toEqual(['r6', 'r5', 'r4', 'r3', 'r2', 'r1']);
    await delay(300);
    expect(opened.all('roster')).toHaveLength(before + 3);
  });

  it('formats idle times in the unit that divides them', () => {
    expect(formatDuration(8 * 60 * 60_000)).toBe('8 hours');
    expect(formatDuration(60 * 60_000)).toBe('1 hour');
    expect(formatDuration(30 * 60_000)).toBe('30 minutes');
    expect(formatDuration(2000)).toBe('2 seconds');
    expect(formatDuration(300)).toBe('300 ms');
  });
});

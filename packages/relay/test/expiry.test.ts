// Attachment idle expiry (ADR 0009): an attachment ends a set time after its
// grant or last call, like a revoke, and each call moves that time.

import type { Client } from '@modelcontextprotocol/client';
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

  it('formats idle times in the unit that divides them', () => {
    expect(formatDuration(8 * 60 * 60_000)).toBe('8 hours');
    expect(formatDuration(60 * 60_000)).toBe('1 hour');
    expect(formatDuration(30 * 60_000)).toBe('30 minutes');
    expect(formatDuration(2000)).toBe('2 seconds');
    expect(formatDuration(300)).toBe('300 ms');
  });
});

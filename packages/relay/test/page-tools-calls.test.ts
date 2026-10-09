// A call by a first-class name (ADR 0025, A5.1) runs the very path
// call_page_tool takes: one hub function, so the same checks, queue, audit
// records, cancellation and errors, word for word, on both eras. The tests
// hold the two routes side by side: identical results and call lines for
// every outcome, one write queue in arrival order across both, S5 for an
// observer who calls a name its list never showed, S8 for a call the
// operator revokes and the stale name after it, an invitee and an attachment
// an invite made answered tool_not_found with a call line, and the request
// budget spent and refused for a first-class call as for call_page_tool.
// Refusals that come before the hub looks the tool up run with a dotted
// name too: a record names the page tool whenever the relay holds the
// page's tools, and only otherwise the whole first-class name as called,
// never the mapped part (SPEC section 7, ADR 0025's notes).

import type { Client } from '@modelcontextprotocol/client';
import type { AuditCallEvent, PageTool } from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { DevTokenUser } from '../src/index.ts';
import {
  attachMember,
  call,
  mintOk,
  redeem,
  startInviteRelay,
  type InviteRelay,
} from './helpers/invites.ts';
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
  type ToolOutcome,
} from './helpers/relay.ts';
import { modernExchange } from './helpers/wire.ts';

let current: TestRelay | undefined;
let invites: InviteRelay | undefined;
const pages: TestPage[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const page of pages.splice(0)) page.ws.terminate();
  await current?.close();
  current = undefined;
  await invites?.close();
  invites = undefined;
});

async function setup(options: Parameters<typeof startRelay>[0] = {}): Promise<TestRelay> {
  current = await startRelay({ firstClassTools: true, ...options });
  return current;
}

async function page(options: PageOptions = {}): Promise<TestPage> {
  if (!current) throw new Error('no relay');
  const opened = await connectPage(current.relay.pageUrl, { tools: TOOLS, ...options });
  pages.push(opened);
  return opened;
}

async function client(user: DevTokenUser = ALICE, modern = false): Promise<Client> {
  if (!current) throw new Error('no relay');
  const connected = await connectClient(current.relay, user, { modern });
  clients.push(connected);
  return connected;
}

/** A call record without the two fields a second call cannot share. */
type CallLine = Omit<AuditCallEvent, 'at' | 'durationMs'>;

/** The newest call record, without the two fields a second call cannot share. */
function lastRecord(): CallLine {
  const record = current?.relay.audit.records().at(-1);
  if (!record) throw new Error('no call record');
  const rest: Partial<AuditCallEvent> = { ...record };
  delete rest.at;
  delete rest.durationMs;
  return rest as CallLine;
}

function recordCount(): number {
  return current?.relay.audit.records().length ?? 0;
}

/**
 * One call by each route, and the result and call line each left; each
 * must leave a line of its own, so an older one is never compared.
 */
async function bothRoutes(
  alice: Client,
  pageId: string,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<{
  fixed: ToolOutcome;
  named: ToolOutcome;
  fixedRecord: CallLine;
  namedRecord: CallLine;
}> {
  const before = recordCount();
  const fixed = await callTool(alice, 'call_page_tool', { page: pageId, tool, arguments: args });
  expect(recordCount(), `${tool}: call_page_tool left no call line`).toBe(before + 1);
  const fixedRecord = lastRecord();
  const named = await callTool(alice, `${pageId}__${tool.replaceAll('.', '_')}`, args);
  expect(recordCount(), `${tool}: the first-class call left no call line`).toBe(before + 2);
  const namedRecord = lastRecord();
  return { fixed, named, fixedRecord, namedRecord };
}

/** The fixed tools, the whole list an invitee or an invite-made attachment sees. */
const FIXED_TOOLS = ['list_pages', 'pair_page', 'list_page_tools', 'call_page_tool', 'detach_page'];

/** An invoke frame without the two fields each call has its own of. */
function samePerCall(frame: InvokeFrame): Omit<InvokeFrame, 'callId' | 'deadlineMs'> {
  const rest: Partial<InvokeFrame> = { ...frame };
  delete rest.callId;
  delete rest.deadlineMs;
  return rest as Omit<InvokeFrame, 'callId' | 'deadlineMs'>;
}

/**
 * A record the relay can name only by what it was called: on a page whose
 * tools it no longer holds (unknown, asleep or gone), or for a name no one
 * tool maps to, a first-class name with a `.` mapped to `_` cannot be
 * mapped back, so the record keeps the whole first-class name, never the
 * mapped part, which could name another tool (SPEC section 7, ADR 0025's
 * notes).
 */
function asCalled(record: CallLine, pageId: string, tool: string): CallLine {
  return { ...record, tool: `${pageId}__${tool.replaceAll('.', '_')}` };
}

const DOTTED: PageTool = {
  name: 'board.add',
  title: 'Add',
  description: 'Adds.',
  inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
  annotations: { readOnlyHint: false },
};

describe('a first-class call and call_page_tool', () => {
  for (const modern of [false, true]) {
    describe(modern ? 'on 2026-07-28' : 'on a 2025-era session', () => {
      it('answer every outcome in the same words and leave the same call line', async () => {
        // A generous check budget, so the invalid board.add below is refused
        // by its check however loaded the test run is. At the default 50 ms,
        // beside two full suites, a first check (a compile in the worker)
        // took 20 to over 50 ms, and one that ran out of time let board.add
        // through unchecked, as ADR 0010 allows. The two routes, not the
        // budget, are under test.
        await setup({ timings: { argumentCheckMs: 2000 } });
        const opened = await page({
          tools: [...TOOLS, DOTTED],
          onInvoke: (frame) =>
            frame.tool === 'clear_board'
              ? { ok: false, error: { code: 'tool_error', message: 'the board is locked' } }
              : { ok: true, content: JSON.stringify({ ran: frame.tool, args: frame.arguments }) },
        });
        const alice = await client(ALICE, modern);
        await pairAndApprove(alice, opened);
        // The last field says whether the call reaches the page.
        const cases: [string, Record<string, unknown>, RegExp, boolean][] = [
          ['get_view', {}, /^\[tabdock: untrusted content from/, true],
          ['board.add', { label: 'x' }, /"ran":"board.add"/, true],
          ['clear_board', {}, /the board is locked/, true],
          ['board.add', { label: 5 }, /^invalid_arguments: /, false],
          ['nope', {}, /^tool_not_found: /, false],
        ];
        for (const [tool, args, expected, reaches] of cases) {
          const invoked = opened.all('invoke').length;
          const { fixed, named, fixedRecord, namedRecord } = await bothRoutes(
            alice,
            opened.pageId,
            tool,
            args,
          );
          expect(fixed.text, tool).toMatch(expected);
          expect(named, tool).toEqual(fixed);
          // A name no tool of the page maps to is recorded as the client named it.
          expect(namedRecord, tool).toEqual(
            tool === 'nope' ? asCalled(fixedRecord, opened.pageId, tool) : fixedRecord,
          );
          // What the page is handed decides its prompts (the adapter's
          // consequential rule reads the tool, arguments, caller and role),
          // so both routes must hand it the same frame, but for the call's
          // own id and deadline.
          await opened.sync();
          const frames = opened.all('invoke').slice(invoked).map(samePerCall);
          expect(frames, tool).toHaveLength(reaches ? 2 : 0);
          if (reaches) {
            expect(frames[0], tool).toMatchObject({ tool, arguments: args });
            expect(frames[1], tool).toEqual(frames[0]);
          }
        }
      });
    });
  }

  it('answer not_attached, page_asleep and page_gone alike, each with its call line', async () => {
    // A resume window short enough to see the page go, and room for every
    // refusal's own line.
    await setup({
      timings: { resumeWindowMs: 1000 },
      rateLimits: { auditRefusalsPerUser: 100 },
    });
    const opened = await page({
      tools: [...TOOLS, DOTTED],
      onInvoke: () => ({ ok: true, content: 'ok' }),
    });
    const alice = await client();
    for (const tool of ['get_view', DOTTED.name]) {
      // A live page Alice does not hold: the relay holds its tools, so both
      // records name the page tool.
      const live = await bothRoutes(alice, opened.pageId, tool);
      expect(live.fixed.text, tool).toMatch(/^not_attached: /);
      expect(live.named, tool).toEqual(live.fixed);
      expect(live.namedRecord, tool).toEqual(live.fixedRecord);
      expect(live.namedRecord, tool).toMatchObject({ tool, outcome: 'not_attached' });
      // A page id nobody holds: not_attached, by the same words either way. The
      // relay holds no tool there to name, so the line names what the client did.
      const stranger = await bothRoutes(alice, 'pg_ZZZZZZZZZZ', tool);
      expect(stranger.fixed.text, tool).toMatch(/^not_attached: /);
      expect(stranger.named, tool).toEqual(stranger.fixed);
      expect(stranger.namedRecord, tool).toEqual(
        asCalled(stranger.fixedRecord, 'pg_ZZZZZZZZZZ', tool),
      );
    }
    await pairAndApprove(alice, opened);
    opened.ws.terminate();
    await opened.closed;
    await eventually(async () =>
      (await callTool(alice, 'list_pages')).text.includes('"state":"asleep"'),
    );
    // An asleep page's tools are not held (S9), so the same holds for it and
    // a gone page: the name stays as called.
    for (const tool of ['get_view', DOTTED.name]) {
      const asleep = await bothRoutes(alice, opened.pageId, tool);
      expect(asleep.fixed.text, tool).toMatch(/^page_asleep: /);
      expect(asleep.named, tool).toEqual(asleep.fixed);
      expect(asleep.namedRecord, tool).toEqual(asCalled(asleep.fixedRecord, opened.pageId, tool));
    }
    // The resume window ends and the page is gone.
    await eventually(
      async () => (await callTool(alice, 'list_pages')).text.includes('"state":"gone"'),
      3000,
    );
    for (const tool of ['get_view', DOTTED.name]) {
      const gone = await bothRoutes(alice, opened.pageId, tool);
      expect(gone.fixed.text, tool).toMatch(/^page_gone: /);
      expect(gone.named, tool).toEqual(gone.fixed);
      expect(gone.namedRecord, tool).toEqual(asCalled(gone.fixedRecord, opened.pageId, tool));
    }
  });

  it('record a dotted tool under its own name by either route, refused before the call resolves it too (S7)', async () => {
    await setup({ rateLimits: { requestsPerUser: 6 } });
    const opened = await page({
      tools: [...TOOLS, { ...DOTTED, name: 'doc.save' }],
      onInvoke: () => ({ ok: true, content: 'ok' }),
    });
    // Alice holds the page; Bob does not, and spends his own budget.
    await pairAndApprove(await client(), opened);
    const bob = await client(BOB);
    const records: CallLine[] = [];
    for (let index = 0; index < 4; index += 1) {
      const route = await bothRoutes(bob, opened.pageId, 'doc.save', { label: 'x' });
      expect(route.named).toEqual(route.fixed);
      expect(route.namedRecord).toEqual(route.fixedRecord);
      records.push(route.namedRecord);
    }
    // not_attached at first, then past Bob's budget of 6: every line names doc.save.
    expect(records.map((record) => record.outcome)).toEqual([
      'not_attached',
      'not_attached',
      'not_attached',
      'rate_limited',
    ]);
    for (const record of records) {
      expect(record).toMatchObject({ userId: 'bob', tool: 'doc.save' });
    }
  });

  it('record a name two tools map to as the client named it, never as one of the two', async () => {
    await setup();
    const opened = await page({
      tools: [...TOOLS, { ...DOTTED, name: 'doc.save' }, { ...DOTTED, name: 'doc_save' }],
    });
    const bob = await client(BOB);
    const fixed = await callTool(bob, 'call_page_tool', { page: opened.pageId, tool: 'doc_save' });
    expect(fixed.text).toMatch(/^not_attached: /);
    expect(lastRecord()).toMatchObject({ userId: 'bob', tool: 'doc_save' });
    const named = await callTool(bob, `${opened.pageId}__doc_save`, { label: 'x' });
    expect(named).toEqual(fixed);
    expect(lastRecord()).toMatchObject({
      userId: 'bob',
      tool: `${opened.pageId}__doc_save`,
      outcome: 'not_attached',
    });
  });

  it('share one write queue, in arrival order across both routes (A2.3)', async () => {
    await setup();
    const held: { frame: InvokeFrame; release: () => void }[] = [];
    const opened = await page({
      onInvoke: (frame) =>
        new Promise((resolve) => {
          held.push({
            frame,
            release: () => {
              resolve({ ok: true, content: 'done' });
            },
          });
        }),
    });
    const alice = await client();
    await pairAndApprove(alice, opened);
    const pending: Promise<ToolOutcome>[] = [];
    for (let index = 1; index <= 4; index += 1) {
      const args = { label: String(index) };
      pending.push(
        index % 2 === 1
          ? callTool(alice, `${opened.pageId}__add_item`, args)
          : callTool(alice, 'call_page_tool', {
              page: opened.pageId,
              tool: 'add_item',
              arguments: args,
            }),
      );
      // Each arrives before the next is sent.
      await delay(50);
    }
    const seen: string[] = [];
    for (let index = 1; index <= 4; index += 1) {
      await eventually(() => held.length === index);
      // One write at a time: the next waits until this one answers.
      await delay(50);
      expect(held).toHaveLength(index);
      const next = held[index - 1];
      seen.push(String(next?.frame.arguments.label));
      next?.release();
    }
    expect(seen).toEqual(['1', '2', '3', '4']);
    for (const outcome of await Promise.all(pending)) expect(outcome.isError).toBe(false);
  });

  it('refuses an observer who calls a mutating tool by a name its list never showed (S5)', async () => {
    await setup();
    const opened = await page({ onInvoke: () => ({ ok: true, content: 'ran' }) });
    const alice = await client();
    await pairAndApprove(alice, opened, 'observer');
    const listed = (await alice.listTools()).tools.map((tool) => tool.name);
    expect(listed).not.toContain(`${opened.pageId}__add_item`);
    const { fixed, named, fixedRecord, namedRecord } = await bothRoutes(
      alice,
      opened.pageId,
      'add_item',
      { label: 'x' },
    );
    expect(fixed.text).toMatch(/^role_denied: /);
    expect(named).toEqual(fixed);
    expect(namedRecord).toEqual(fixedRecord);
    await opened.sync();
    expect(opened.all('invoke')).toHaveLength(0);
  });

  for (const modern of [false, true]) {
    it(`ends a call the operator revokes, then answers its stale name not_attached (S8, ${modern ? '2026-07-28' : '2025'})`, async () => {
      await setup();
      const opened = await page({ onInvoke: () => undefined });
      const alice = await client(ALICE, modern);
      await pairAndApprove(alice, opened);
      const name = `${opened.pageId}__add_item`;
      const running = callTool(alice, name, { label: 'x' });
      await opened.next('invoke');
      opened.send({ t: 'revoke', userId: 'alice' });
      const ended = await running;
      expect(ended).toMatchObject({
        isError: true,
        text: 'not_attached: the page operator revoked your attachment',
      });
      const cancel = await opened.next('cancel');
      expect(cancel.reason).toBe('revoked');
      const stale = await callTool(alice, name, { label: 'y' });
      expect(stale.text).toMatch(/^not_attached: /);
      expect(lastRecord()).toMatchObject({
        userId: 'alice',
        tool: 'add_item',
        outcome: 'not_attached',
      });
    });
  }

  it("spends the request budget, and past it refuses with call_page_tool's record on a session", async () => {
    await setup({ rateLimits: { requestsPerUser: 3 } });
    const opened = await page({
      tools: [...TOOLS, DOTTED],
      onInvoke: () => ({ ok: true, content: 'ok' }),
    });
    // Bob pairs, so Alice's budget is all hers.
    const bob = await client(BOB);
    await pairAndApprove(bob, opened);
    const alice = await client();
    const name = `${opened.pageId}__get_view`;
    const answers: ToolOutcome[] = [];
    for (let index = 0; index < 4; index += 1) answers.push(await callTool(alice, name));
    for (const answer of answers.slice(0, 3)) expect(answer.text).toMatch(/^not_attached: /);
    expect(answers[3]?.text).toMatch(/^rate_limited: more than 3 requests/);
    expect(lastRecord()).toMatchObject({
      userId: 'alice',
      pageId: opened.pageId,
      tool: 'get_view',
      outcome: 'rate_limited',
    });
    // A dotted page tool past the budget: both routes name the page tool.
    const dotted = await bothRoutes(alice, opened.pageId, DOTTED.name, { label: 'x' });
    expect(dotted.fixed.text).toMatch(/^rate_limited: /);
    expect(dotted.named).toEqual(dotted.fixed);
    expect(dotted.namedRecord).toEqual(dotted.fixedRecord);
    expect(dotted.namedRecord).toMatchObject({ tool: DOTTED.name, outcome: 'rate_limited' });
    // And the budget holds for call_page_tool after it.
    expect((await callTool(alice, 'list_pages')).text).toMatch(/^rate_limited: /);
  });

  it('past the budget on 2026-07-28 too, refuses as call_page_tool does, with its record', async () => {
    const relay = await setup({ rateLimits: { requestsPerUser: 2 } });
    const opened = await page({ tools: [...TOOLS, DOTTED] });
    const name = `${opened.pageId}__get_view`;
    const answers = [];
    for (let index = 0; index < 3; index += 1) {
      answers.push(await modernExchange(relay.relay, ALICE, 'tools/call', { name, arguments: {} }));
    }
    // Every request spent as it arrived; the third, past the budget, still reaches the dispatcher.
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
    const texts = answers.map(
      (answer) =>
        (answer.message?.result as { content?: { text?: string }[] } | undefined)?.content?.[0]
          ?.text,
    );
    expect(texts[0]).toMatch(/^not_attached: /);
    expect(texts[2]).toMatch(/^rate_limited: more than 2 requests/);
    expect(lastRecord()).toMatchObject({
      userId: 'alice',
      pageId: opened.pageId,
      tool: 'get_view',
      outcome: 'rate_limited',
    });
    // call_page_tool past the budget answers in the same words.
    const fixed = await modernExchange(relay.relay, ALICE, 'tools/call', {
      name: 'call_page_tool',
      arguments: { page: opened.pageId, tool: 'get_view' },
    });
    expect(
      (fixed.message?.result as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text,
    ).toBe(texts[2]);
    // A dotted page tool past the budget: both routes leave one record, naming the page tool.
    const fixedRecord = lastRecord();
    const named = await modernExchange(relay.relay, ALICE, 'tools/call', {
      name: `${opened.pageId}__board_add`,
      arguments: { label: 'x' },
    });
    expect(
      (named.message?.result as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text,
    ).toBe(texts[2]);
    const namedRecord = lastRecord();
    const dotted = await modernExchange(relay.relay, ALICE, 'tools/call', {
      name: 'call_page_tool',
      arguments: { page: opened.pageId, tool: DOTTED.name, arguments: { label: 'x' } },
    });
    expect(dotted.message?.result).toEqual(named.message?.result);
    expect(namedRecord).toEqual(lastRecord());
    expect(namedRecord).toMatchObject({ tool: DOTTED.name, outcome: 'rate_limited' });
    expect(fixedRecord).toMatchObject({ tool: 'get_view' });
  });
});

describe('an invitee and an attachment an invite made', () => {
  for (const modern of [false, true]) {
    it(`are answered tool_not_found for a first-class name, with a call line, and the page hears nothing (${modern ? '2026-07-28' : '2025'})`, async () => {
      invites = await startInviteRelay({ firstClassTools: true });
      const opened = await invites.page();
      const alice = await invites.claude('sub-alice', null, true, undefined, modern);
      await attachMember(alice, opened);
      const guestLink = await mintOk(opened);
      const guest = await invites.claude('sub-guest', 'guest@example.com', true, undefined, modern);
      expect((await redeem(guest, opened, guestLink.link)).outcome.isError).toBe(false);
      const bobLink = await mintOk(opened);
      const bob = await invites.claude('sub-bob', null, true, undefined, modern);
      expect((await redeem(bob, opened, bobLink.link)).outcome.isError).toBe(false);
      await opened.sync();
      const invoked = opened.all('invoke').length;
      // The member's own list shows the page's tools, so the flag is on.
      const members = (await alice.listTools()).tools.map((tool) => tool.name);
      expect(members).toContain(`${opened.pageId}__get_view`);

      const name = `${opened.pageId}__get_view`;
      for (const each of [guest, bob]) {
        // Exactly the five fixed tools, and nothing beside them (A5.1).
        const listed = (await each.listTools()).tools.map((tool) => tool.name).sort();
        expect(listed).toEqual([...FIXED_TOOLS].sort());
        const answer = await call(each, name);
        expect(answer.isError).toBe(true);
        expect(answer.text).toMatch(/^tool_not_found: .*invite/);
        // call_page_tool still reaches the tool, as ADR 0016 keeps it.
        const fixed = await call(each, 'call_page_tool', { page: opened.pageId, tool: 'get_view' });
        expect(fixed.isError, fixed.text).toBe(false);
      }
      await opened.sync();
      // Only the two call_page_tool calls reached the page.
      expect(opened.all('invoke').length - invoked).toBe(2);
      const refused = invites.relay.audit
        .records()
        .filter((record) => record.outcome === 'tool_not_found');
      expect(refused).toHaveLength(2);
      for (const record of refused)
        expect(record).toMatchObject({ pageId: opened.pageId, tool: 'get_view' });
      expect(refused.map((record) => record.userId)).toContain('bob');
      // Each client spoke the leg this test names, by the relay's own line.
      const legs = invites
        .events()
        .filter((line) => line.msg === 'mcp client' && line.client === 'claude-sub-guest');
      expect(legs.map((line) => line.leg)).toEqual([modern ? 'strict' : 'session']);
    });
  }
});

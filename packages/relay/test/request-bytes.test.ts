// What requests waiting on a page may hold (S9, ADR 0018's notes). A call
// waits for its page's answer and a pairing for the operator, each keeping
// its body and what was parsed from it, and the request budget bounded only
// how many a user sent in a minute: one member held 237 MiB with 120 calls
// of 1 MB, past the image's 192 MiB heap. Now each such request is charged
// what its body is measured to hold (request-heap.ts) while it waits, within
// a share per user and a total for the relay, on both MCP legs, and
// invitees' requests together within a quarter of that total (ADR 0030).
// call-heap.test.ts measures the charge against the heap and runs the
// image's relay against it.

import {
  Client,
  type FetchLike,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { PageTool } from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { MIN_REQUEST_BYTES } from '../src/config.ts';
import {
  CONTAINER_HEAP_BYTES,
  INDEX_KEY_HEAP_BYTES,
  PROPERTY_HEAP_BYTES,
  REQUEST_HEAP_BYTES,
  requestHeapBytes,
  STRING_HEAP_BYTES,
  VALUE_HEAP_BYTES,
} from '../src/request-heap.ts';
import {
  call as inviteCall,
  attachMember,
  type InviteRelay,
  mintOk,
  redeem,
  startInviteRelay,
} from './helpers/invites.ts';
import { connectPage, type TestPage } from './helpers/page-client.ts';
import {
  ALICE,
  BOB,
  callTool,
  connectClient,
  pairAndApprove,
  startRelay,
  type TestRelay,
} from './helpers/relay.ts';

const SEARCH: PageTool = {
  name: 'search',
  description: 'Search the given text.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  annotations: { readOnlyHint: true },
};
const MIB = 1024 * 1024;

const relays: TestRelay[] = [];
const pages: TestPage[] = [];
const closers: (() => Promise<unknown>)[] = [];
let inviteRelay: InviteRelay | undefined;

afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => undefined);
  for (const page of pages.splice(0)) page.ws.terminate();
  for (const relay of relays.splice(0)) await relay.close();
  await inviteRelay?.close();
  inviteRelay = undefined;
});

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * What the charge stands for, counted on the parsed value itself: the root's
 * slot, each object, each array with its first value's slot, each further
 * value's slot in an array, each property, and more for one whose key is
 * digits alone, and each string with two bytes a character, a key's included.
 */
function parsedCharge(value: unknown, root = true): number {
  let charge = root ? VALUE_HEAP_BYTES : 0;
  if (typeof value === 'string') return charge + STRING_HEAP_BYTES + 2 * value.length;
  if (Array.isArray(value)) {
    charge += CONTAINER_HEAP_BYTES + VALUE_HEAP_BYTES * Math.max(1, value.length);
    for (const item of value) charge += parsedCharge(item, false);
    return charge;
  }
  if (typeof value !== 'object' || value === null) return charge;
  const entries = Object.entries(value);
  charge += CONTAINER_HEAP_BYTES + VALUE_HEAP_BYTES * Math.max(0, entries.length - 1);
  for (const [key, item] of entries) {
    charge += STRING_HEAP_BYTES + 2 * key.length + PROPERTY_HEAP_BYTES + parsedCharge(item, false);
    if (/^[0-9]+$/.test(key)) charge += INDEX_KEY_HEAP_BYTES;
  }
  return charge;
}

describe('requestHeapBytes', () => {
  const bodies: [string, string][] = [
    ['an empty object', '{}'],
    ['a number', '7'],
    ['arrays of numbers', '[[0],[0,1],[0,1,2],[]]'],
    ['empty objects', `[${Array(1000).fill('{}').join(',')}]`],
    ['unique keys', `{${Array.from({ length: 500 }, (_, n) => `"k${String(n)}":0`).join(',')}}`],
    [
      'keys of digits alone',
      `{"4294967294":0,${Array.from({ length: 500 }, (_, n) => `"${String(n)}":0`).join(',')}}`,
    ],
    ['escapes', JSON.stringify({ text: 'a"b\\c\nd\u4e00'.repeat(50) })],
    ['two-byte text', JSON.stringify({ text: '\u4e00'.repeat(1000) })],
    ['nested values', JSON.stringify({ a: [1, 'two', { three: [null, true, 4.5] }], b: {} })],
    [
      'a tools/call',
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'call_page_tool', arguments: { page: 'p', tool: 't', arguments: {} } },
      }),
    ],
  ];

  it.each(bodies)(
    'charges %s at least its body and what each value, key and character it parses to costs',
    (_, text) => {
      const body = utf8(text);
      expect(requestHeapBytes(body)).toBeGreaterThanOrEqual(
        REQUEST_HEAP_BYTES + body.length + parsedCharge(JSON.parse(text)),
      );
    },
  );

  it('charges a body that is not all ASCII two bytes a byte for the body itself', () => {
    const ascii = requestHeapBytes(utf8('"aaaa"'));
    const wide = requestHeapBytes(utf8('"\u00e9aa"'));
    // Both are one string of six bytes on the wire; the second is held at two bytes a character.
    expect(wide - ascii).toBe(6);
  });

  it('charges a property more when its key is digits alone, and only then (ADR 0030)', () => {
    const charge = (text: string): number => requestHeapBytes(utf8(text));
    expect(charge('{"12":0}') - charge('{"ab":0}')).toBe(INDEX_KEY_HEAP_BYTES);
    expect(charge('{"12" : 0}') - charge('{"ab" : 0}')).toBe(INDEX_KEY_HEAP_BYTES);
    // A value of digits, an empty key, and keys with anything else in them are not index keys.
    expect(charge('{"a":"12"}')).toBe(charge('{"a":"ab"}'));
    // One byte less on the wire and two less held for the character, no surcharge.
    expect(charge('{"":0}')).toBe(charge('{"a":0}') - 3);
    for (const key of ['1a', '-1', '1.5', '1e3']) {
      expect(charge(`{"${key}":0}`), key).toBe(charge(`{"${'a'.repeat(key.length)}":0}`));
    }
    // An escape may stand for a digit ("\\u0031" parses to "1"), so a key of
    // digits and escapes counts as one, which can only overstate.
    expect(charge('{"\\u0031":0}') - charge('{"aaaaaa":0}')).toBe(INDEX_KEY_HEAP_BYTES);
    expect(charge('{"1\\"":0}')).toBe(charge('{"aaa":0}'));
    // Each such key counts, not only the first.
    expect(charge('{"1":0,"2":0,"3":0}') - charge('{"a":0,"b":0,"c":0}')).toBe(
      3 * INDEX_KEY_HEAP_BYTES,
    );
  });

  it('charges whitespace only as the body it is', () => {
    expect(requestHeapBytes(utf8(`{${' '.repeat(10_000)}}`))).toBe(
      REQUEST_HEAP_BYTES + 10_002 + VALUE_HEAP_BYTES + CONTAINER_HEAP_BYTES,
    );
  });
});

/** A relay whose share per user is the least allowed, and its total `shares` of them. */
async function tightRelay(shares = 2): Promise<TestRelay> {
  const relay = await startRelay({
    limits: { requestBytesPerUser: MIN_REQUEST_BYTES, requestBytes: shares * MIN_REQUEST_BYTES },
    timings: { callDeadlineMs: 20_000 },
  });
  relays.push(relay);
  return relay;
}

/** A page that holds every call until let go, then answers it. */
async function holdingPage(relay: TestRelay): Promise<{ page: TestPage; release: () => void }> {
  const waiting: (() => void)[] = [];
  const page = await connectPage(relay.relay.pageUrl, {
    tools: [SEARCH],
    onInvoke: () =>
      new Promise((resolve) => {
        waiting.push(() => {
          resolve({ ok: true, content: 'found' });
        });
      }),
  });
  pages.push(page);
  return {
    page,
    release: () => {
      for (const answer of waiting.splice(0)) answer();
    },
  };
}

/** A fetch that pads every tools/call body with this many spaces, which the SDK itself never would. */
function padding(spaces: number, base: FetchLike = fetch): FetchLike {
  return (input, init) => {
    const body = init?.body;
    if (typeof body !== 'string' || !body.includes('"tools/call"')) return base(input, init);
    return base(input, { ...init, body: `${body.slice(0, -1)}${' '.repeat(spaces)}}` });
  };
}

describe('what requests waiting on a page may hold', () => {
  it.each([
    ['2025-era', false],
    ['2026-07-28', true],
  ])(
    'refuses a %s call rate_limited once the caller would pass its share, and takes calls again once one ends',
    async (_, modern) => {
      const relay = await tightRelay();
      const { page, release } = await holdingPage(relay);
      // Each call is charged its body, padded to 1.25 MiB, and a fixed quarter
      // MiB, so two fit in the 4 MiB share and a third does not.
      const client = await connectClient(relay.relay, ALICE, {
        modern,
        fetch: padding(1.25 * MIB),
      });
      closers.push(() => client.close());
      await pairAndApprove(client, page);
      const call = (): ReturnType<typeof callTool> =>
        callTool(client, 'call_page_tool', {
          page: page.pageId,
          tool: SEARCH.name,
          arguments: { text: 'x' },
        });
      const first = call();
      const second = call();
      while (page.all('invoke').length < 2) await page.next('invoke', 10_000);
      const third = await call();
      expect(third.isError).toBe(true);
      expect(third.text).toMatch(/^rate_limited: your requests waiting on pages already hold/);
      expect(page.all('invoke')).toHaveLength(2);
      release();
      for (const outcome of await Promise.all([first, second])) expect(outcome.isError).toBe(false);
      // What they held is back: the next call goes to the page.
      const fourth = call();
      while (page.all('invoke').length < 3) await page.next('invoke', 10_000);
      release();
      expect((await fourth).isError).toBe(false);
    },
    60_000,
  );

  it('refuses a call page_busy once the relay total is full, though its caller holds nothing', async () => {
    // The total is one share, so Alice's two calls fill it for everyone.
    const relay = await tightRelay(1);
    const { page, release } = await holdingPage(relay);
    const [alice, bob] = await Promise.all(
      [ALICE, BOB].map((user) => connectClient(relay.relay, user, { fetch: padding(1.25 * MIB) })),
    );
    if (alice === undefined || bob === undefined) throw new Error('no clients');
    closers.push(
      () => alice.close(),
      () => bob.close(),
    );
    await pairAndApprove(alice, page);
    await pairAndApprove(bob, page);
    const call = (client: typeof alice): ReturnType<typeof callTool> =>
      callTool(client, 'call_page_tool', {
        page: page.pageId,
        tool: SEARCH.name,
        arguments: { text: 'x' },
      });
    const held = [call(alice), call(alice)];
    while (page.all('invoke').length < 2) await page.next('invoke', 10_000);
    const refused = await call(bob);
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^page_busy: requests waiting on pages hold as much/);
    expect(page.all('invoke')).toHaveLength(2);
    release();
    await Promise.all(held);
    const later = call(bob);
    while (page.all('invoke').length < 3) await page.next('invoke', 10_000);
    release();
    expect((await later).isError).toBe(false);
  }, 60_000);

  it('refuses a pairing rate_limited before its code is used once the share is full', async () => {
    const relay = await tightRelay();
    const { page, release } = await holdingPage(relay);
    const client = await connectClient(relay.relay, ALICE, { fetch: padding(1.25 * MIB) });
    closers.push(() => client.close());
    await pairAndApprove(client, page);
    const held = [0, 1].map(() =>
      callTool(client, 'call_page_tool', {
        page: page.pageId,
        tool: SEARCH.name,
        arguments: { text: 'x' },
      }),
    );
    while (page.all('invoke').length < 2) await page.next('invoke', 10_000);
    // A second page whose code Alice tries while her share is full.
    const other = await connectPage(relay.relay.pageUrl, { tools: [SEARCH] });
    pages.push(other);
    const code = other.code;
    const pairing = await callTool(client, 'pair_page', { code });
    expect(pairing.isError).toBe(true);
    expect(pairing.text).toMatch(/^rate_limited:/);
    await other.sync();
    expect(other.all('attach_request')).toHaveLength(0);
    release();
    await Promise.all(held);
    // The code was never looked at, so it still works.
    const later = callTool(client, 'pair_page', { code });
    const request = await other.next('attach_request');
    other.send({ t: 'attach_decision', requestId: request.requestId, allow: true, role: 'driver' });
    expect((await later).isError).toBe(false);
  }, 60_000);

  it('holds a 2025-era call charged while its question waits in the client, from before it asks until it ends (ADR 0026)', async () => {
    const relay = await tightRelay();
    const wipe: PageTool = {
      name: 'wipe',
      description: 'Clear everything.',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: false },
      consequential: true,
    };
    const page = await connectPage(relay.relay.pageUrl, {
      policy: { consequential: 'confirm', confirmVia: 'client' },
      tools: [SEARCH, wipe],
      onInvoke: () => ({ ok: true, content: 'done' }),
    });
    pages.push(page);
    // A 2025-era client whose questions wait until let go, every call padded as above.
    const answers: ((result: { action: 'decline' }) => void)[] = [];
    const client = new Client(
      { name: 'asked', version: '1.0.0' },
      { capabilities: { elicitation: { form: {} } } },
    );
    client.setRequestHandler(
      'elicitation/create',
      () =>
        new Promise((resolve) => {
          answers.push(resolve);
        }),
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(relay.relay.mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${ALICE.token}` } },
        fetch: padding(1.25 * MIB),
      }),
    );
    closers.push(() => client.close());
    await pairAndApprove(client, page);
    const asked = [0, 1].map(() =>
      callTool(client, 'call_page_tool', { page: page.pageId, tool: 'wipe', arguments: {} }),
    );
    while (answers.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    // Two questions waiting hold the 4 MiB share, so a third call is refused for it.
    const third = await callTool(client, 'call_page_tool', {
      page: page.pageId,
      tool: SEARCH.name,
      arguments: { text: 'x' },
    });
    expect(third.text).toMatch(/^rate_limited: your requests waiting on pages already hold/);
    for (const answer of answers.splice(0)) answer({ action: 'decline' });
    for (const outcome of await Promise.all(asked)) expect(outcome.text).toMatch(/^not_confirmed:/);
    // Answered, they hold nothing: the next call goes to the page.
    const after = await callTool(client, 'call_page_tool', {
      page: page.pageId,
      tool: SEARCH.name,
      arguments: { text: 'x' },
    });
    expect(after.isError, after.text).toBe(false);
    await page.sync();
    expect(page.all('invoke').map((frame) => frame.tool)).toEqual(['search']);
  }, 60_000);

  it.each([
    ['2025-era', false],
    ['2026-07-28', true],
  ])(
    'answers a %s request 413 before either leg parses it when it alone would pass a user share, at a request of the budget',
    async (_, modern) => {
      const relay = await startRelay({ rateLimits: { requestsPerUser: 3 } });
      relays.push(relay);
      const page = await connectPage(relay.relay.pageUrl, { tools: [SEARCH] });
      pages.push(page);
      let oversized = false;
      // 300,000 empty objects in the request's _meta: under a megabyte on the
      // wire, about 46 MiB as the relay charges it, and about 20 MiB parsed.
      const pad = `"pad":[${Array<string>(300_000).fill('{}').join(',')}]`;
      const client = await connectClient(relay.relay, ALICE, {
        modern,
        fetch: (input, init) => {
          const body = init?.body;
          if (!oversized || typeof body !== 'string' || !body.includes('"tools/call"')) {
            return fetch(input, init);
          }
          const message = JSON.parse(body) as { params: { _meta?: Record<string, unknown> } };
          const meta = JSON.stringify(message.params._meta ?? {});
          const padded = `${meta.slice(0, -1)}${meta === '{}' ? '' : ','}${pad}}`;
          const shaped = body.replace(`"_meta":${meta}`, `"_meta":${padded}`);
          return fetch(input, {
            ...init,
            body: shaped === body ? `${body.slice(0, -1)},"_meta":{${pad}}}` : shaped,
          });
        },
      });
      closers.push(() => client.close());
      // One request of the budget: the pairing.
      await pairAndApprove(client, page);
      oversized = true;
      for (let n = 0; n < 2; n += 1) {
        const refused = await callTool(client, 'call_page_tool', {
          page: page.pageId,
          tool: SEARCH.name,
          arguments: { text: 'x' },
        }).then(
          (outcome) => outcome.text,
          (error: unknown) => String(error),
        );
        expect(refused).toMatch(/413|Payload Too Large/);
      }
      await page.sync();
      expect(page.all('invoke')).toHaveLength(0);
      // One line for both, as for any refusal a signed-in client can cause at will.
      expect(
        relay.lines.filter((line) =>
          line.includes('mcp request refused: it would hold more than one user may'),
        ),
      ).toHaveLength(1);
      // Both refusals spent the budget, so the next small request is refused for it.
      oversized = false;
      const after = await callTool(client, 'list_pages');
      expect(after.isError).toBe(true);
      expect(after.text).toMatch(/^rate_limited:/);
    },
    60_000,
  );
});

describe('what invitees together may hold while their requests wait (S9, ADRs 0030 and 0032)', () => {
  it('refuses a guest past a quarter of the total, a call page_busy and a redemption rate_limited, and still holds a member', async () => {
    // Shares of 8 MiB and a total of 32 MiB, so invitees may hold 8 MiB
    // together, twice what the least setting allows, so the quarter, not
    // the floor, is what binds, and each invitee 4 MiB of it.
    const relay = await startInviteRelay({
      limits: { requestBytesPerUser: 2 * MIN_REQUEST_BYTES, requestBytes: 8 * MIN_REQUEST_BYTES },
      timings: { callDeadlineMs: 20_000 },
    });
    inviteRelay = relay;
    const waiting: (() => void)[] = [];
    const page = await relay.page({
      tools: [SEARCH],
      onInvoke: () =>
        new Promise((resolve) => {
          waiting.push(() => {
            resolve({ ok: true, content: 'found' });
          });
        }),
    });
    const release = (): void => {
      for (const answer of waiting.splice(0)) answer();
    };
    // Every tools/call body padded to 1.25 MiB, which the relay charges about
    // 1.5 MiB with its fixed quarter MiB: two fit in one guest's 4 MiB, five
    // in the guests' 8 MiB, and a sixth does not.
    const padded = (base: FetchLike): FetchLike => padding(1.25 * MIB, base);
    const alice = await relay.claude('sub-alice', null, true, padded);
    await attachMember(alice, page);
    const guests = [];
    for (const n of [1, 2, 3, 4]) {
      const guest = await relay.claude(
        `sub-guest-${String(n)}`,
        `guest${String(n)}@example.com`,
        true,
        padded,
      );
      const { link } = await mintOk(page);
      expect((await redeem(guest, page, link)).outcome.isError).toBe(false);
      guests.push(guest);
    }
    const [first, second, third, fourth] = guests;
    if (!first || !second || !third || !fourth) throw new Error('no guests');
    const search = (client: typeof alice) =>
      inviteCall(client, 'call_page_tool', {
        page: page.pageId,
        tool: SEARCH.name,
        arguments: { text: 'x' },
      });
    // Three guests' five calls hold about 7.5 MiB, more than the least
    // setting (4 MiB) and within each guest's share and the quarter.
    const held = [first, first, second, second, third].map((guest) => search(guest));
    while (page.all('invoke').length < 5) await page.next('invoke', 10_000);
    const refused = await search(fourth);
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^page_busy: requests from invited accounts already hold all/);
    // A redemption waits for the operator too, so it is held to the same
    // quarter, before anything of its invite is spent.
    const fifth = await relay.claude('sub-guest-5', 'guest5@example.com', true, padded);
    const { link, inviteId } = await mintOk(page);
    const redemption = await inviteCall(fifth, 'pair_page', { invite: link });
    expect(redemption.text).toMatch(
      /^rate_limited: requests from invited accounts already hold all/,
    );
    expect(relay.store.invites.get(page.pageId, inviteId)?.usesLeft).toBe(1);
    // A member ranks above them and may still use the rest of the total.
    const member = search(alice);
    while (page.all('invoke').length < 6) await page.next('invoke', 10_000);
    release();
    for (const outcome of await Promise.all([...held, member])) {
      expect(outcome.isError, outcome.text).toBe(false);
    }
    // What the guests held is back, so the fourth guest's call now waits on the page.
    const later = search(fourth);
    while (page.all('invoke').length < 7) await page.next('invoke', 10_000);
    release();
    expect((await later).isError).toBe(false);
  }, 60_000);

  it("refuses an invitee past a share of the pool of its own, so one guest on a page that holds calls leaves room for another page's guests", async () => {
    // The default limits: 64 MiB in all, invitees 16 MiB together, each 4 MiB.
    const relay = await startInviteRelay({ timings: { callDeadlineMs: 20_000 } });
    inviteRelay = relay;
    // Alice's page holds every call, as a frozen tab would; Bob's answers at once.
    const waiting: (() => void)[] = [];
    const frozen = await relay.page({
      tools: [SEARCH],
      onInvoke: () =>
        new Promise((resolve) => {
          waiting.push(() => {
            resolve({ ok: true, content: 'found' });
          });
        }),
    });
    const answering = await relay.page({
      tools: [SEARCH],
      onInvoke: () => ({ ok: true, content: 'found' }),
    });
    const alice = await relay.claude('sub-alice');
    await attachMember(alice, frozen);
    const bob = await relay.claude('sub-bob');
    await attachMember(bob, answering);
    // Mallory watches Alice's page and pads every call to 1.5 MiB, charged
    // about 1.75 MiB; Carol watches Bob's.
    const mallory = await relay.claude('sub-mallory', 'mallory@example.com', true, (base) =>
      padding(1.5 * MIB, base),
    );
    const carol = await relay.claude('sub-carol', 'carol@example.com');
    expect((await redeem(mallory, frozen, (await mintOk(frozen)).link)).outcome.isError).toBe(
      false,
    );
    expect((await redeem(carol, answering, (await mintOk(answering)).link)).outcome.isError).toBe(
      false,
    );
    const search = (client: typeof alice, page: TestPage) =>
      inviteCall(client, 'call_page_tool', {
        page: page.pageId,
        tool: SEARCH.name,
        arguments: { text: 'x' },
      });
    // Mallory calls until the relay refuses her: before, nine waited and
    // filled the invitees' 16 MiB alone.
    const held = [];
    let refused: Awaited<ReturnType<typeof search>> | undefined;
    for (let n = 0; n < 12 && refused === undefined; n += 1) {
      const pending = search(mallory, frozen);
      const outcome = await Promise.race([
        pending,
        frozen.next('invoke', 10_000).then(
          () => null,
          () => null,
        ),
      ]);
      if (outcome === null) held.push(pending);
      else refused = outcome;
    }
    expect(held).toHaveLength(2);
    expect(refused?.isError).toBe(true);
    expect(refused?.text).toMatch(
      /^rate_limited: your requests waiting on pages already hold 3\.\d MiB of the relay's memory, and one invited account's may hold 4\.0 MiB/,
    );
    // Carol's call on another page, and Bob's, are still served.
    const carols = await search(carol, answering);
    expect(carols.isError, carols.text).toBe(false);
    expect((await search(bob, answering)).isError).toBe(false);
    for (const answer of waiting.splice(0)) answer();
    for (const outcome of await Promise.all(held)) expect(outcome.isError).toBe(false);
  }, 60_000);
});

// What the M6 foundation holds on the relay's side before any wave fills a
// seam (plan section 2.1), so a seam left half built fails here rather than
// shipping quietly: a result carrying an image is refused whole, never passed
// on as plain text with the image dropped (ADR 0039); a reload never widens
// the policy a live time-boxed session narrowed (S5, ADR 0043); and every
// setting the relay accepts is either read by the code that enforces it or
// carries the seam marker on its default, so the Wave 3 gate sees each one
// that is not (A6.26); and the first-class prefix is SPEC section 7's, or
// marked until W1-B rewords it.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import type { ImageRefusal, PolicyInput } from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, DEFAULT_RATE_LIMITS, DEFAULT_TIMINGS } from '../src/config.ts';
import { createMemoryStore, type RelayStore } from '../src/index.ts';
import {
  connectPage,
  type InvokeFrame,
  type PageOptions,
  READ_TOOL,
  type TestPage,
  TOOLS,
} from './helpers/page-client.ts';
import {
  ALICE,
  callTool,
  connectClient,
  pairAndApprove,
  startRelay,
  type TestRelay,
} from './helpers/relay.ts';

const relays: TestRelay[] = [];
const pages: TestPage[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const page of pages.splice(0)) page.ws.terminate();
  for (const relay of relays.splice(0)) await relay.close();
});

/** A 1 by 1 PNG, as a declared image tool would send it once W1-B passes images on. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

async function world(options: PageOptions = {}, store?: RelayStore) {
  const relay = await startRelay(store === undefined ? {} : { store });
  relays.push(relay);
  const page = await connectPage(relay.relay.pageUrl, { tools: TOOLS, ...options });
  pages.push(page);
  const alice = await connectClient(relay.relay, ALICE);
  clients.push(alice);
  await pairAndApprove(alice, page);
  return { relay, page, alice };
}

/** Answers every invoke with words and an image, as a page whose tool returns an envelope would. */
function answerWithImage(page: TestPage): void {
  page.onInvoke = (frame: InvokeFrame) => {
    page.send({
      t: 'result',
      callId: frame.callId,
      ok: true,
      content: 'the view as a picture',
      image: { mimeType: 'image/png', data: PNG },
    });
    return undefined;
  };
}

describe('a result carrying an image (ADR 0039)', () => {
  // M6 seam: not built. W1-B passes a declared tool's checked image on, and
  // turns the declared case below into one that reaches the client.
  const cases: [string, PolicyInput, ImageRefusal, string][] = [
    [
      'from a tool the hello did not declare',
      {},
      'undeclared',
      "tabdock refused this tool's image: the page did not declare this tool an image tool",
    ],
    [
      'from a declared tool, while this relay passes none',
      { imageTools: [READ_TOOL.name] },
      'off',
      "tabdock refused this tool's image: this relay passes no images",
    ],
  ];
  for (const [what, policy, reason, words] of cases) {
    it(`is refused whole ${what}, never answered ok without it`, async () => {
      const { relay, page, alice } = await world({ policy });
      answerWithImage(page);
      const result = await alice.callTool({
        name: 'call_page_tool',
        arguments: { page: page.pageId, tool: READ_TOOL.name, arguments: {} },
      });
      expect(result.isError).toBe(true);
      expect(result.content.map((block) => block.type)).toEqual(['text']);
      const [block] = result.content;
      const text = block?.type === 'text' ? block.text : '';
      expect(text).toContain(words);
      // Relay words alone: neither the page's words nor its data reach the client.
      expect(text).not.toContain('the view as a picture');
      expect(text).not.toContain(PNG.slice(0, 32));
      expect(result.structuredContent).toBeUndefined();
      const [record] = relay.relay.audit.records();
      expect(record).toMatchObject({ outcome: 'tool_error', imageRefused: reason });
      expect(record).not.toHaveProperty('image');
      // The link stays open: the next call is answered as usual.
      page.onInvoke = () => ({ ok: true, content: 'words only' });
      const next = await callTool(alice, 'call_page_tool', {
        page: page.pageId,
        tool: READ_TOOL.name,
        arguments: {},
      });
      expect(next.isError, next.text).toBe(false);
      expect(next.text).toContain('words only');
    });
  }
});

describe('a reload during a time-boxed session (S5, ADR 0043)', () => {
  it('keeps the policy the session narrowed, taking the new hello as the ceiling', async () => {
    const store = createMemoryStore();
    const wide = { maxDrivers: 3, proposals: 'all' } as const;
    const { page } = await world({ policy: wide }, store);
    const pageId = page.pageId;
    const record = store.pages.get(pageId);
    if (record === undefined) throw new Error('no page record');
    // W2-B starts sessions; here one is put in place as #sessionFrame will.
    const now = Date.now();
    const session = { maxDrivers: 1, proposals: 'members' } as const;
    store.pages.put({
      ...record,
      policy: { ...record.policy, ...session },
      timedSession: {
        sessionId: 'ss_test',
        startedAt: now,
        endsAt: now + 1_800_000,
        lengthMs: 1_800_000,
        policy: session,
      },
    });
    const token = page.welcome?.resumeToken ?? '';
    page.ws.terminate();
    await page.closed;
    const reloaded = await connectPage(page.ws.url, { resumeToken: token, policy: wide });
    pages.push(reloaded);
    expect(reloaded.welcome?.resumed).toBe(true);
    const after = store.pages.get(pageId);
    expect(after?.ceiling).toMatchObject(wide);
    expect(after?.policy).toMatchObject(session);
    // A ceiling narrower than the session narrows it again, field by field.
    const token2 = reloaded.welcome?.resumeToken ?? '';
    reloaded.ws.terminate();
    await reloaded.closed;
    const narrower = { maxDrivers: 2, proposals: 'off' } as const;
    const third = await connectPage(page.ws.url, { resumeToken: token2, policy: narrower });
    pages.push(third);
    expect(store.pages.get(pageId)?.policy).toMatchObject({ maxDrivers: 1, proposals: 'off' });
  });
});

/** The relay's sources but config.ts, without comments, so a field named only in prose is not read. */
function codeOutsideConfig(): string {
  const dir = join(import.meta.dirname, '..', 'src');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && name !== 'config.ts')
    .map((name) =>
      readFileSync(join(dir, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, ''),
    )
    .join('\n');
}

/** Whether code reads the field, as a property or by destructuring. */
function reads(code: string, field: string): boolean {
  return new RegExp(`\\.${field}\\b|\\{[^}]*\\b${field}\\b[^}]*\\}\\s*=`).test(code);
}

/** The line that gives the field its default in one of config.ts's DEFAULT_ objects. */
function defaultLine(config: string, object: string, field: string): string {
  const start = config.indexOf(`export const ${object}`);
  const body = config.slice(start, config.indexOf('\n};', start));
  const line = body.split('\n').find((text) => text.trimStart().startsWith(`${field}:`));
  if (line === undefined) throw new Error(`${object} gives ${field} no default`);
  return line;
}

describe('the settings the relay accepts (plan section 2.1, A6.26)', () => {
  const config = readFileSync(join(import.meta.dirname, '..', 'src', 'config.ts'), 'utf8');
  const code = codeOutsideConfig();
  const objects = {
    DEFAULT_TIMINGS,
    DEFAULT_RATE_LIMITS,
    DEFAULT_LIMITS,
  } as const;

  it('are each read where they are enforced, or marked as a seam on their default, never both', () => {
    const wrong: string[] = [];
    for (const [object, defaults] of Object.entries(objects)) {
      for (const field of Object.keys(defaults)) {
        const marked = defaultLine(config, object, field).includes('// M6 seam: not built');
        if (reads(code, field) === marked) {
          wrong.push(`${object}.${field}: ${marked ? 'read and still marked' : 'never read'}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('would catch a field read nowhere and unmarked, and one read and still marked', () => {
    expect(reads('const x = config.limits.toolBytes;', 'toolBytes')).toBe(true);
    expect(reads('const { usersPerPage, queueDepth } = config.limits;', 'queueDepth')).toBe(true);
    expect(reads('const toolBytes = 1;', 'toolBytes')).toBe(false);
    expect(codeOutsideConfig()).not.toContain('// ');
  });
});

describe('what SPEC says ahead of the code (docs/plans/M6.md)', () => {
  it("gives first-class tools section 7's prefix, or marks the prefix as a seam", () => {
    const spec = readFileSync(join(import.meta.dirname, '..', '..', '..', 'SPEC.md'), 'utf8');
    const promised =
      /description is the prefix `\[tabdock: tool <name> of page <page id> at <origin>; ([^`\]]+)\]`/.exec(
        spec,
      )?.[1];
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'first-class.ts'), 'utf8');
    const built = /; (this tool's [^\]]+)\] Page description: `/.exec(source)?.[1];
    expect(promised).toMatch(/^this tool's /);
    expect(built).toMatch(/^this tool's /);
    const before = source
      .slice(0, source.indexOf(built ?? ''))
      .split('\n')
      .slice(-4)
      .join('\n');
    // Equal, or the seam marker sits just above the prefix: never different and unmarked.
    expect(built === promised || before.includes('// M6 seam: not built')).toBe(true);
  });
});

// ADR 0030 sized what waiting /mcp answers may hold on a text answer of
// MAX_RESULT_CHARS, about 0.72 MB on the wire at worst, and responses carry
// no byte charge of their own, so an image answer must never be larger
// (ADR 0039, decision 25, A6.5). This measures the HTTP body of each, as a
// client receives it, on the 2025-11-25 leg (an event stream on a session)
// and the 2026-07-28 leg (JSON), with an image at MAX_IMAGE_BYTES beside
// MAX_IMAGE_TEXT_CHARS of the characters JSON escapes longest, and past them
// as much more text as the frame holds, so the relay's truncation marker, with
// the most digits it can carry, is in the answer too: should either constant
// or the marker grow past that sizing, this fails before the memory bound moves.
// The figures are in docs/notes/m6/image-answers.md. Last, an animated PNG
// or WebP is answered tool_error in relay words and recorded as such, since
// ADR 0039 promises one still image (its note of 12 October).

import type { Client } from '@modelcontextprotocol/client';
import {
  base64Chars,
  MAX_FRAME_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_TEXT_CHARS,
  MAX_RESULT_CHARS,
  untrustedHeader,
} from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { answerWithImage, base64, CAPTURE_TOOL, padTo, pngHeader } from './helpers/images.ts';
import { connectPage, PAGE_ORIGIN, READ_TOOL, type TestPage } from './helpers/page-client.ts';
import { openSession, rawCall } from './helpers/raw-mcp.ts';
import {
  ALICE,
  callTool,
  connectClient,
  pairAndApprove,
  startRelay,
  type TestRelay,
} from './helpers/relay.ts';
import { modernExchange } from './helpers/wire.ts';

let relay: TestRelay | undefined;
const pages: TestPage[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const page of pages.splice(0)) page.ws.terminate();
  await relay?.close();
  relay = undefined;
});

/**
 * A control character: JSON writes each as a six-byte escape, the most any
 * one UTF-16 unit takes in a JSON answer (a lone surrogate takes the same).
 */
const WORST = '\u0001';

describe('an image answer on the wire (ADR 0030 re-measured for ADR 0039)', () => {
  it('is no larger than a text answer of MAX_RESULT_CHARS, on either leg', async () => {
    relay = await startRelay({
      limits: { imageBytes: MAX_IMAGE_BYTES },
      timings: { callDeadlineMs: 20_000 },
    });
    const page = await connectPage(relay.relay.pageUrl, {
      tools: [CAPTURE_TOOL, READ_TOOL],
      policy: { imageTools: [CAPTURE_TOOL.name] },
    });
    pages.push(page);
    const alice = await connectClient(relay.relay, ALICE);
    clients.push(alice);
    await pairAndApprove(alice, page);
    const image = padTo(pngHeader(2048, 2048), MAX_IMAGE_BYTES);
    const data = base64(image);
    expect(data.length).toBe(base64Chars(MAX_IMAGE_BYTES));
    // The kept characters at their longest, then plain text filling the frame
    // (a callId of 64 characters leaves room for any the relay mints), so the
    // marker names the largest counts a page can make it name.
    const kept = WORST.repeat(MAX_IMAGE_TEXT_CHARS);
    const room = (content: string): number =>
      MAX_FRAME_BYTES -
      Buffer.byteLength(
        JSON.stringify({
          t: 'result',
          callId: 'c'.repeat(64),
          ok: true,
          content,
          image: { mimeType: 'image/png', data },
        }),
      );
    const words = kept + 'a'.repeat(room(kept));
    expect(room(words)).toBeGreaterThanOrEqual(0);
    const answer = answerWithImage(page, { mimeType: 'image/png', data }, words);
    const capture = { page: page.pageId, tool: CAPTURE_TOOL.name, arguments: {} };
    const text = { page: page.pageId, tool: READ_TOOL.name, arguments: {} };
    const sessionId = await openSession(relay.relay, ALICE);

    const legacyImage = await rawCall(relay.relay, ALICE, sessionId, 'call_page_tool', capture);
    const modernImage = await modernExchange(relay.relay, ALICE, 'tools/call', {
      name: 'call_page_tool',
      arguments: capture,
    });
    expect(answer.invokes).toHaveLength(2);
    page.onInvoke = () => ({ ok: true, content: WORST.repeat(MAX_RESULT_CHARS) });
    const legacyText = await rawCall(relay.relay, ALICE, sessionId, 'call_page_tool', text);
    const modernText = await modernExchange(relay.relay, ALICE, 'tools/call', {
      name: 'call_page_tool',
      arguments: text,
    });

    // Each answer is what it claims: the image whole beside the cut words
    // and their marker, the text uncut.
    const marker = `[tabdock: truncated, ${String(words.length - MAX_IMAGE_TEXT_CHARS)} of ${String(words.length)} characters removed]`;
    expect(String(words.length - MAX_IMAGE_TEXT_CHARS)).toHaveLength(6);
    for (const body of [legacyImage.body, modernImage.body]) {
      expect(body).toContain(data);
      expect(body).toContain(marker);
      expect(body).not.toContain('a'.repeat(32));
    }
    expect(legacyText.result?.isError).toBeFalsy();
    expect(modernText.message?.result?.isError).toBeFalsy();
    expect(legacyText.body).not.toContain('[tabdock: truncated');
    expect(modernText.body).not.toContain('[tabdock: truncated');

    const bytes = {
      legacyImage: Buffer.byteLength(legacyImage.body),
      legacyText: Buffer.byteLength(legacyText.body),
      modernImage: Buffer.byteLength(modernImage.body),
      modernText: Buffer.byteLength(modernText.body),
    };
    process.stderr.write(`image answers on the wire, in bytes: ${JSON.stringify(bytes)}\n`);
    expect(bytes.legacyImage).toBeLessThanOrEqual(bytes.legacyText);
    expect(bytes.modernImage).toBeLessThanOrEqual(bytes.modernText);
    // ADR 0030's figure for the text answer still holds.
    expect(bytes.legacyText).toBeLessThan(730_000);
    expect(bytes.modernText).toBeLessThan(730_000);
  }, 60_000);
});

function ascii(text: string): number[] {
  return Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
}

function u32(value: number, little = false): number[] {
  const big = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  return little ? big.reverse() : big;
}

/** An APNG: the header, then acTL (two frames, played forever) before the first IDAT. */
const APNG = new Uint8Array([
  ...pngHeader(64, 64),
  ...[...u32(8), ...ascii('acTL'), ...u32(2), ...u32(0), ...u32(0)],
  ...[...u32(1), ...ascii('IDAT'), 0, ...u32(0)],
]);

/** An extended WebP of 64 by 64 whose VP8X flags byte sets the animation bit. */
const ANIMATED_WEBP = new Uint8Array([
  ...ascii('RIFF'),
  ...u32(22, true),
  ...ascii('WEBP'),
  ...ascii('VP8X'),
  ...u32(10, true),
  ...[0x02, 0, 0, 0, 63, 0, 0, 63, 0, 0],
]);

describe('an animated image (ADR 0039, its note of 12 October)', () => {
  for (const [what, mimeType, bytes] of [
    ['an APNG', 'image/png', APNG],
    ['a WebP with the animation flag', 'image/webp', ANIMATED_WEBP],
  ] as const) {
    it(`answers ${what} with tool_error in relay words and records imageRefused animated`, async () => {
      relay = await startRelay({ limits: { imageBytes: MAX_IMAGE_BYTES } });
      const page = await connectPage(relay.relay.pageUrl, {
        tools: [CAPTURE_TOOL, READ_TOOL],
        policy: { imageTools: [CAPTURE_TOOL.name] },
      });
      pages.push(page);
      const alice = await connectClient(relay.relay, ALICE);
      clients.push(alice);
      await pairAndApprove(alice, page);
      answerWithImage(page, { mimeType, data: base64(bytes) }, 'two frames of the board');
      const result = await alice.callTool({
        name: 'call_page_tool',
        arguments: { page: page.pageId, tool: CAPTURE_TOOL.name, arguments: {} },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: 'text',
          text: `${untrustedHeader(PAGE_ORIGIN, CAPTURE_TOOL.name)}\ntabdock refused this tool's image: the image is animated; only a still image passes`,
        },
      ]);
      const [record] = relay.relay.audit.records();
      expect(record).toMatchObject({ outcome: 'tool_error', imageRefused: 'animated' });
      expect(record).not.toHaveProperty('image');
      // The link stays open for the next call.
      page.onInvoke = () => ({ ok: true, content: 'words only' });
      const next = await callTool(alice, 'call_page_tool', {
        page: page.pageId,
        tool: READ_TOOL.name,
        arguments: {},
      });
      expect(next.isError, next.text).toBe(false);
    });
  }
});

// Crafted image bytes for the relay's image tests (ADR 0039). The relay reads
// only an image's first bytes and header, never its pixels, so a header with
// filler after it is all a check sees; the same shapes as the protocol's own
// tests, plus the base64 and data URL forms a page might send, a tool that
// declares itself an image tool, and a page answer carrying an image.

import { createHash } from 'node:crypto';
import type { PageTool } from '@tabdock/protocol';
import type { InvokeFrame, TestPage } from './page-client.ts';

function ascii(text: string): number[] {
  return Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u16be(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function u24le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/** A PNG's signature and IHDR chunk, CRC left zero: only the header is ever read. */
export function pngHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ...u32be(13),
    ...ascii('IHDR'),
    ...u32be(width),
    ...u32be(height),
    ...[8, 6, 0, 0, 0],
    ...u32be(0),
  ]);
}

/** SOI, an APP1 segment of `appBytes`, then a baseline frame header and the scan's start. */
export function jpegWithSof(width: number, height: number, appBytes = 16): Uint8Array {
  return new Uint8Array([
    ...[0xff, 0xd8, 0xff, 0xe1],
    ...u16be(appBytes + 2),
    ...new Array<number>(appBytes).fill(0x45),
    ...[0xff, 0xc0],
    ...u16be(17),
    8,
    ...u16be(height),
    ...u16be(width),
    ...[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
    ...[0xff, 0xda],
  ]);
}

function riff(chunk: string, body: number[]): Uint8Array {
  const payload = [...ascii(chunk), ...u32le(body.length), ...body];
  return new Uint8Array([
    ...ascii('RIFF'),
    ...u32le(payload.length + 4),
    ...ascii('WEBP'),
    ...payload,
  ]);
}

/** The extended WebP format's canvas size, each side stored less one. */
export function webpVp8x(width: number, height: number): Uint8Array {
  return riff('VP8X', [0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]);
}

/** `bytes` followed by filler up to exactly `size` bytes. */
export function padTo(bytes: Uint8Array, size: number): Uint8Array {
  const padded = new Uint8Array(size).fill(0x5a);
  padded.set(bytes.subarray(0, size));
  return padded;
}

export function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A GIF's first bytes: a type no check lets through. */
export const GIF = new Uint8Array([...ascii('GIF89a'), 1, 0, 1, 0, 0, 0, 0]);

/** An SVG, which is text that can carry script. */
export const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);

/** A read-only tool a page declares in policy.imageTools. */
export const CAPTURE_TOOL: PageTool = {
  name: 'capture_view',
  title: 'Capture view',
  description: 'Return the view as an image.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
};

export interface PageImage {
  mimeType: string;
  data: string;
}

/**
 * Answers every invoke with `content` and `image` in one ok result frame, as
 * the adapter sends a declared image tool's envelope; a test changes either
 * through the returned object between calls.
 */
export function answerWithImage(
  page: TestPage,
  image: PageImage,
  content = 'the view as a picture',
): { image: PageImage; content: string; invokes: InvokeFrame[] } {
  const answer = { image, content, invokes: [] as InvokeFrame[] };
  page.onInvoke = (frame: InvokeFrame) => {
    answer.invokes.push(frame);
    page.send({
      t: 'result',
      callId: frame.callId,
      ok: true,
      content: answer.content,
      image: answer.image,
    });
    return undefined;
  };
  return answer;
}

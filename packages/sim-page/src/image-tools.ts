// Image tools for tests (ADR 0039), opt-in so the six default tools, which
// many tests count, stay as they are. pngImage builds a real PNG, which any
// decoder opens, at an exact size when a limit test needs one; the tools
// return it in the envelope a declared image tool's handler returns, as an
// object and as a JSON string, and image_raw returns whatever a test hands
// it, so a crafted envelope crosses the real adapter. A page names these in
// policy.imageTools; none of them is consequential.

import { crc32, deflateSync } from 'node:zlib';
import type { FakeToolDefinition } from './fake-model-context.ts';

export interface PngOptions {
  width: number;
  height: number;
  /** One colour for every pixel, as [red, green, blue]; mid grey by default. */
  rgb?: readonly [number, number, number];
  /**
   * The file's exact size in bytes: an ancillary chunk of random bytes, which
   * decoders skip, fills it out. Must leave room for the chunk's 12 bytes.
   */
  padToBytes?: number;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A truecolour PNG of one colour, with valid chunk CRCs and zlib data. */
export function pngImage(options: PngOptions): Uint8Array {
  const { width, height } = options;
  const [red, green, blue] = options.rgb ?? [128, 128, 128];
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  // Bit depth 8, colour type 2 (truecolour), then default compression, filter and interlace.
  header.set([8, 2, 0, 0, 0], 8);
  const row = 1 + width * 3;
  const pixels = new Uint8Array(row * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) pixels.set([red, green, blue], y * row + 1 + x * 3);
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', new Uint8Array()),
  ];
  if (options.padToBytes !== undefined) {
    const fill = options.padToBytes - concat(parts).length - 12;
    if (fill < 0) throw new Error(`a ${String(width)} by ${String(height)} PNG is already larger`);
    // Random, so the bytes do not compress and no slice of their base64 repeats.
    const noise = Uint8Array.from({ length: fill }, () => Math.floor(Math.random() * 256));
    // A private ancillary chunk: lower-case first letter, so a decoder skips it.
    parts.splice(2, 0, chunk('tdPd', noise));
  }
  return concat(parts);
}

export function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export interface ImageToolsOptions {
  /** What image_raw returns, read at each call; undefined by default. */
  raw?: () => unknown;
}

const READ_ONLY = { readOnlyHint: true };

const CAPTURE_INPUT = {
  type: 'object',
  properties: {
    width: { type: 'integer', minimum: 1, maximum: 8192 },
    height: { type: 'integer', minimum: 1, maximum: 8192 },
    bytes: { type: 'integer', minimum: 100, maximum: 1048576 },
  },
  additionalProperties: false,
};

function captured(input: unknown): { image: { mimeType: string; data: string }; text: string } {
  const given = (typeof input === 'object' && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const width = typeof given.width === 'number' ? given.width : 64;
  const height = typeof given.height === 'number' ? given.height : 48;
  const png = pngImage({
    width,
    height,
    ...(typeof given.bytes === 'number' ? { padToBytes: given.bytes } : {}),
  });
  return {
    image: { mimeType: 'image/png', data: base64Of(png) },
    text: `A ${String(width)} by ${String(height)} test card`,
  };
}

/**
 * capture returns the envelope as an object, capture_string as JSON text (which
 * MCP-B 6 quotes once more), and image_raw returns `raw()`. All are read-only.
 */
export function createImageTools(options: ImageToolsOptions = {}): FakeToolDefinition[] {
  return [
    {
      name: 'capture',
      title: 'Capture',
      description: 'Return a test card as a PNG image, with a line of text.',
      inputSchema: CAPTURE_INPUT,
      annotations: READ_ONLY,
      execute: (input) => captured(input),
    },
    {
      name: 'capture_string',
      title: 'Capture as text',
      description: 'Return the same test card, the envelope written as JSON text.',
      inputSchema: CAPTURE_INPUT,
      annotations: READ_ONLY,
      execute: (input) => JSON.stringify(captured(input)),
    },
    {
      name: 'image_raw',
      title: 'Raw image result',
      description: 'Return whatever the test set, as a declared image tool.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: READ_ONLY,
      execute: () => options.raw?.(),
    },
  ];
}

/** The names a page lists in policy.imageTools for these tools. */
export const IMAGE_TOOL_NAMES = ['capture', 'capture_string', 'image_raw'] as const;

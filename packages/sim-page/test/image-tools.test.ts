// The sim page's opt-in image tools (ADR 0039): pngImage writes a PNG that
// passes the protocol's checks and decodes to its pixels, at an exact size
// when asked, and the tools hand it back in the envelope a declared image
// tool returns, as an object and as JSON text.

import { inflateSync } from 'node:zlib';
import { checkImage, MAX_IMAGE_BYTES, parseImageEnvelope } from '@tabdock/protocol';
import { describe, expect, it } from 'vitest';
import { base64Of, createImageTools, FakeModelContext, pngImage } from '../src/index.ts';

describe('pngImage', () => {
  it('writes a PNG the protocol passes, whose pixels decode to the colour asked for', () => {
    const png = pngImage({ width: 3, height: 2, rgb: [10, 20, 30] });
    const checked = checkImage({ mimeType: 'image/png', data: base64Of(png) }, 65_536);
    expect(checked).toMatchObject({ ok: true, width: 3, height: 2 });
    // IDAT starts after the signature (8) and IHDR (25): length, type, data, CRC.
    const length = new DataView(png.buffer, png.byteOffset).getUint32(33);
    const pixels = inflateSync(png.subarray(41, 41 + length));
    expect(Array.from(pixels)).toEqual([
      0, 10, 20, 30, 10, 20, 30, 10, 20, 30, 0, 10, 20, 30, 10, 20, 30, 10, 20, 30,
    ]);
  });

  it('pads to an exact size with a chunk decoders skip', () => {
    for (const size of [1_000, 65_536, MAX_IMAGE_BYTES]) {
      const png = pngImage({ width: 8, height: 8, padToBytes: size });
      expect(png.length).toBe(size);
      expect(checkImage({ mimeType: 'image/png', data: base64Of(png) }, MAX_IMAGE_BYTES).ok).toBe(
        true,
      );
    }
    expect(() => pngImage({ width: 8, height: 8, padToBytes: 20 })).toThrow('already larger');
  });
});

describe('createImageTools', () => {
  it('returns the envelope as an object and as text, and image_raw whatever the test sets', async () => {
    let raw: unknown = 'words';
    const mc = new FakeModelContext({ profile: 'chrome-156' });
    for (const tool of createImageTools({ raw: () => raw })) await mc.registerTool(tool);
    const tools = await mc.getTools();
    const run = async (name: string, input: object = {}) => {
      const tool = tools.find((each) => each.name === name);
      if (!tool) throw new Error(`no ${name}`);
      return mc.executeTool(tool, input);
    };
    for (const name of ['capture', 'capture_string']) {
      const envelope = parseImageEnvelope(await run(name, { width: 20, height: 10 }));
      expect(envelope).toMatchObject({
        kind: 'image',
        image: { mimeType: 'image/png' },
        text: 'A 20 by 10 test card',
      });
    }
    expect(await run('image_raw')).toBe('words');
    raw = { image: { mimeType: 'image/svg+xml', data: 'PHN2Zy8+' } };
    expect(parseImageEnvelope(await run('image_raw'))).toMatchObject({ kind: 'image' });
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
  });
});

// ADR 0039's image checks, shared by the adapter and the relay: crafted PNG,
// JPEG and WebP headers at and past every bound, the types and encodings
// that must never pass, and the envelope a declared image tool returns. Each
// case would pass a check that was missing or off by one.

import { describe, expect, it } from 'vitest';
import {
  base64Chars,
  type CheckedImage,
  checkImage,
  decodeBase64,
  decodedLength,
  IMAGE_MIME_TYPES,
  imageSize,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIDE,
  parseImageEnvelope,
  WireImageSchema,
} from './index.ts';

/** Node's Buffer, which the protocol's own types leave out since its code runs in browsers too. */
const { Buffer } = globalThis as unknown as {
  Buffer: {
    from(data: Uint8Array): { toString(encoding: 'base64'): string };
    from(data: string, encoding: 'base64'): Uint8Array;
  };
};

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

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
function pngHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32be(13),
    ...ascii('IHDR'),
    ...u32be(width),
    ...u32be(height),
    8,
    6,
    0,
    0,
    0,
    ...u32be(0),
  ]);
}

/** SOI, an APP1 segment of `appBytes`, then a baseline frame header and the scan's start. */
function jpegWithSof(width: number, height: number, appBytes = 16): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe1,
    ...u16be(appBytes + 2),
    ...new Array<number>(appBytes).fill(0x45),
    0xff,
    0xc0,
    ...u16be(17),
    8,
    ...u16be(height),
    ...u16be(width),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
    0xff,
    0xda,
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

/** The extended format's canvas size, each side stored less one. */
function webpVp8x(width: number, height: number): Uint8Array {
  return riff('VP8X', [0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]);
}

/** A lossy key frame: its tag, start code and 14-bit sides. */
function webpVp8(width: number, height: number): Uint8Array {
  return riff('VP8 ', [
    0x10,
    0x02,
    0x00,
    0x9d,
    0x01,
    0x2a,
    width & 0xff,
    (width >>> 8) & 0x3f,
    height & 0xff,
    (height >>> 8) & 0x3f,
  ]);
}

/** A lossless image: its signature byte, then both sides less one packed in 14 bits each. */
function webpVp8l(width: number, height: number): Uint8Array {
  return riff('VP8L', [0x2f, ...u32le(((width - 1) | ((height - 1) << 14)) >>> 0)]);
}

/** `bytes` followed by filler up to exactly `size` bytes. */
function padTo(bytes: Uint8Array, size: number): Uint8Array {
  const padded = new Uint8Array(size).fill(0x5a);
  padded.set(bytes.subarray(0, size));
  return padded;
}

function wire(mimeType: string, bytes: Uint8Array): { mimeType: string; data: string } {
  return { mimeType, data: base64(bytes) };
}

function reason(result: CheckedImage): string | null {
  return result.ok ? null : result.reason;
}

const CAP = 1_000;

const SAMPLES: readonly [string, string, Uint8Array][] = [
  ['PNG', 'image/png', pngHeader(640, 480)],
  ['JPEG', 'image/jpeg', jpegWithSof(640, 480)],
  ['WebP VP8X', 'image/webp', webpVp8x(640, 480)],
  ['WebP VP8', 'image/webp', webpVp8(640, 480)],
  ['WebP VP8L', 'image/webp', webpVp8l(640, 480)],
];

describe('checkImage', () => {
  it.each(SAMPLES)(
    'passes a %s of exactly the cap and refuses one byte more',
    (_, type, header) => {
      const exact = checkImage(wire(type, padTo(header, CAP)), CAP);
      expect(exact).toMatchObject({ ok: true, mimeType: type, width: 640, height: 480 });
      if (exact.ok) expect(exact.bytes).toHaveLength(CAP);
      // 1,001 bytes take as many base64 characters as 1,000, so the decoded length refuses it.
      expect(base64Chars(CAP + 1)).toBe(base64Chars(CAP));
      expect(checkImage(wire(type, padTo(header, CAP + 1)), CAP)).toEqual({
        ok: false,
        reason: 'size',
        message: 'the image is 1001 bytes, over the cap of 1000 bytes',
      });
    },
  );

  it('refuses by base64 length before any scan, so an oversized image costs no decoding', () => {
    const tooLong = 'A'.repeat(base64Chars(CAP) + 4);
    expect(reason(checkImage({ mimeType: 'image/png', data: tooLong }, CAP))).toBe('size');
    // Not base64 at all, yet refused for its size first.
    const notBase64 = '!'.repeat(base64Chars(CAP) + 4);
    expect(reason(checkImage({ mimeType: 'image/png', data: notBase64 }, CAP))).toBe('size');
    expect(checkImage(wire('image/png', padTo(pngHeader(1, 1), CAP + 3)), CAP)).toMatchObject({
      reason: 'size',
      message: 'the image is over the cap of 1000 bytes',
    });
  });

  it('takes the three raster types by their exact names only', () => {
    expect(IMAGE_MIME_TYPES).toEqual(['image/png', 'image/jpeg', 'image/webp']);
    const png = padTo(pngHeader(4, 4), 64);
    for (const type of [
      'image/svg+xml',
      'image/gif',
      'image/avif',
      'IMAGE/PNG',
      'image/png ',
      'image/jpg',
      'text/html',
    ]) {
      const result = checkImage(wire(type, png), CAP);
      expect(result, type).toEqual({
        ok: false,
        reason: 'type',
        message: 'the image is not PNG, JPEG or WebP',
      });
    }
  });

  it('refuses whatever is not canonical base64', () => {
    const data = base64(padTo(pngHeader(4, 4), 64));
    for (const [what, bad] of [
      ['a space', `${data.slice(0, 8)} ${data.slice(9)}`],
      ['a line break', `${data.slice(0, 8)}\n${data.slice(9)}`],
      ['base64url minus', `${data.slice(0, 8)}-${data.slice(9)}`],
      ['base64url underscore', `${data.slice(0, 8)}_${data.slice(9)}`],
      ['missing padding', base64(padTo(pngHeader(4, 4), 65)).replace(/=+$/, '')],
      ['a length that is not a multiple of 4', `${data}A`],
      ['empty data', ''],
      ['padding in the middle', `${data.slice(0, 6)}==${data.slice(8)}`],
    ] as const) {
      expect(reason(checkImage({ mimeType: 'image/png', data: bad }, CAP)), what).toBe('encoding');
    }
  });

  it("refuses an image whose first bytes are not its type's", () => {
    const png = padTo(pngHeader(4, 4), 64);
    const wave = new Uint8Array([
      ...ascii('RIFF'),
      ...u32le(56),
      ...ascii('WAVEfmt '),
      ...new Array<number>(48).fill(0),
    ]);
    const html = new Uint8Array(ascii('<html><body><script>alert(1)</script></body></html>'));
    for (const [type, bytes] of [
      ['image/jpeg', png],
      ['image/webp', wave],
      ['image/png', html],
      ['image/webp', png],
      ['image/png', jpegWithSof(4, 4)],
    ] as const) {
      expect(checkImage(wire(type, bytes), CAP), type).toEqual({
        ok: false,
        reason: 'signature',
        message: "the image's first bytes are not those of its type",
      });
    }
  });

  it('refuses a header that declares too many pixels, a zero side or none it can read', () => {
    const app = 30_000;
    const big = app + 64;
    for (const [what, type, bytes] of [
      [
        'a 64-byte PNG claiming 50,000 by 50,000',
        'image/png',
        padTo(pngHeader(50_000, 50_000), 64),
      ],
      ['a JPEG 9,000 wide after a 30 KB APP1', 'image/jpeg', jpegWithSof(9_000, 10, app)],
      ['a VP8X one pixel past the side', 'image/webp', webpVp8x(MAX_IMAGE_SIDE + 1, 1)],
      ['a VP8 with height 0', 'image/webp', webpVp8(640, 0)],
      ['a PNG with width 0', 'image/png', padTo(pngHeader(0, 10), 64)],
      ['a truncated JPEG segment', 'image/jpeg', jpegWithSof(10, 10, 40).subarray(0, 30)],
      [
        'a JPEG whose scan starts before any frame',
        'image/jpeg',
        new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0]),
      ],
      ['a WebP with an unknown chunk', 'image/webp', riff('ALPH', [0, 0, 0, 0])],
      [
        'a PNG over the area within its sides',
        'image/png',
        padTo(pngHeader(MAX_IMAGE_SIDE, 2_049), 64),
      ],
    ] as const) {
      const result = checkImage(wire(type, bytes), big);
      expect(result.ok, what).toBe(false);
      if (!result.ok) expect(result.reason, what).toBe('dimensions');
    }
    // At the bounds exactly, a capture passes.
    expect(checkImage(wire('image/png', padTo(pngHeader(MAX_IMAGE_SIDE, 2_048), 64)), CAP).ok).toBe(
      true,
    );
    expect(checkImage(wire('image/png', padTo(pngHeader(4_096, 4_096), 64)), CAP).ok).toBe(true);
    expect(MAX_IMAGE_SIDE * 2_048).toBe(MAX_IMAGE_PIXELS);
  });

  it('names sizes in numbers and never repeats the type or data the page wrote', () => {
    const result = checkImage(wire('image/png', padTo(pngHeader(50_000, 50_000), 64)), CAP);
    expect(result).toEqual({
      ok: false,
      reason: 'dimensions',
      message: 'the image is 50000 by 50000 pixels; at most 8192 a side and 16777216 in all',
    });
    const typed = checkImage({ mimeType: 'image/svg+xml<b>marker</b>', data: 'AAAA' }, CAP);
    expect(JSON.stringify(typed)).not.toContain('marker');
    expect(JSON.stringify(typed)).not.toContain('svg');
  });

  it('refuses every image with the cap at 0, and holds any cap to the ceiling', () => {
    const png = wire('image/png', padTo(pngHeader(4, 4), 64));
    expect(checkImage(png, 0)).toEqual({
      ok: false,
      reason: 'off',
      message: 'image results are off here (a cap of 0 bytes)',
    });
    expect(reason(checkImage(png, Number.NaN))).toBe('off');
    const overCeiling = wire('image/png', padTo(pngHeader(4, 4), MAX_IMAGE_BYTES + 1));
    expect(reason(checkImage(overCeiling, 2 ** 31))).toBe('size');
    expect(checkImage(wire('image/png', padTo(pngHeader(4, 4), MAX_IMAGE_BYTES)), 2 ** 31).ok).toBe(
      true,
    );
  });
});

describe('imageSize', () => {
  it('reads each header as written', () => {
    expect(imageSize(pngHeader(1920, 1080), 'image/png')).toEqual({ width: 1920, height: 1080 });
    expect(imageSize(jpegWithSof(1600, 900), 'image/jpeg')).toEqual({ width: 1600, height: 900 });
    expect(imageSize(webpVp8x(16_384, 3), 'image/webp')).toEqual({ width: 16_384, height: 3 });
    expect(imageSize(webpVp8(16_383, 2), 'image/webp')).toEqual({ width: 16_383, height: 2 });
    expect(imageSize(webpVp8l(16_384, 16_384), 'image/webp')).toEqual({
      width: 16_384,
      height: 16_384,
    });
  });

  it('walks fill bytes and standalone markers, and gives up after 1,000 segments', () => {
    const sof = jpegWithSof(32, 24).subarray(2);
    const withFill = new Uint8Array([0xff, 0xd8, 0xff, 0xff, 0xff, 0xd0, ...sof]);
    expect(imageSize(withFill, 'image/jpeg')).toEqual({ width: 32, height: 24 });
    // SOI, APP1's 4 header and 16 payload bytes, then the frame header alone.
    const frame = jpegWithSof(32, 24, 16).subarray(22);
    expect(frame[1]).toBe(0xc0);
    const segments = (count: number): Uint8Array =>
      new Uint8Array([
        0xff,
        0xd8,
        ...Array.from({ length: count }, () => [0xff, 0xe2, 0, 2]).flat(),
        ...frame,
      ]);
    // The frame header is the 1,000th segment, then the 1,001st.
    expect(imageSize(segments(999), 'image/jpeg')).toEqual({ width: 32, height: 24 });
    expect(imageSize(segments(1_000), 'image/jpeg')).toBeNull();
  });

  it('skips the markers that are not frame headers', () => {
    // DHT (C4) laid out like a frame header must not be read as one.
    const dht = [
      0xff,
      0xc4,
      ...u16be(17),
      8,
      ...u16be(7),
      ...u16be(7),
      ...new Array<number>(10).fill(0),
    ];
    const bytes = new Uint8Array([0xff, 0xd8, ...dht, ...jpegWithSof(32, 24).subarray(2)]);
    expect(imageSize(bytes, 'image/jpeg')).toEqual({ width: 32, height: 24 });
  });

  it('reads nothing short of a whole header', () => {
    expect(imageSize(pngHeader(4, 4).subarray(0, 23), 'image/png')).toBeNull();
    expect(imageSize(webpVp8x(4, 4).subarray(0, 29), 'image/webp')).toBeNull();
    expect(imageSize(webpVp8l(4, 4).subarray(0, 24), 'image/webp')).toBeNull();
    expect(imageSize(new Uint8Array(), 'image/jpeg')).toBeNull();
  });
});

describe('decodeBase64', () => {
  /** A small seeded generator, so a failure names inputs that recur. */
  function generator(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
  }

  it('equals Buffer on 2,000 random canonical inputs', () => {
    const next = generator(39);
    for (let round = 0; round < 2_000; round += 1) {
      const bytes = new Uint8Array(next() % 300).map(() => next() & 0xff);
      const text = base64(bytes);
      const decoded = decodeBase64(text);
      expect(decoded, text).not.toBeNull();
      expect(Array.from(decoded ?? []), text).toEqual(Array.from(Buffer.from(text, 'base64')));
      expect(decodedLength(text) ?? 0).toBe(text === '' ? 0 : bytes.length);
    }
  });

  it('refuses what a lenient decoder forgives', () => {
    for (const text of [
      'QQ',
      'QQ=',
      'QQ===',
      'Q===',
      'QR==',
      'QUJ=',
      ' QUJD',
      'QU JD',
      'QUJD\n',
      '=QUJ',
      'QU=D',
      'QUJDé===',
      'QUJ\u0000',
    ]) {
      expect(decodeBase64(text), JSON.stringify(text)).toBeNull();
    }
    expect(Array.from(decodeBase64('QQ==') ?? [])).toEqual([0x41]);
    expect(Array.from(decodeBase64('QUI=') ?? [])).toEqual([0x41, 0x42]);
    expect(Array.from(decodeBase64('QUJD') ?? [])).toEqual([0x41, 0x42, 0x43]);
    expect(decodedLength('QUJDQQ==')).toBe(4);
    expect(decodedLength('QUJ')).toBeNull();
    expect(decodedLength('Q===')).toBeNull();
  });
});

describe('WireImageSchema', () => {
  it('is structural only, so a frame with an SVG or bad base64 still parses for the relay to refuse', () => {
    expect(WireImageSchema.safeParse({ mimeType: 'image/svg+xml', data: '<svg/>' }).success).toBe(
      true,
    );
    expect(WireImageSchema.safeParse({ mimeType: '', data: 'AAAA' }).success).toBe(false);
    expect(WireImageSchema.safeParse({ mimeType: 'image/png', data: '' }).success).toBe(false);
    expect(WireImageSchema.safeParse({ mimeType: 'x'.repeat(101), data: 'AAAA' }).success).toBe(
      false,
    );
    expect(
      WireImageSchema.safeParse({ mimeType: 'image/png', data: 'AAAA', width: 4 }).success,
    ).toBe(false);
  });
});

describe('parseImageEnvelope', () => {
  const data = base64(padTo(pngHeader(4, 4), 64));
  const envelope = { image: { mimeType: 'image/png', data }, text: 'Board view' };
  const image = { kind: 'image', image: { mimeType: 'image/png', data }, text: 'Board view' };

  it('reads an object, and a string once more as MCP-B 6 quotes it', () => {
    expect(parseImageEnvelope(JSON.stringify(envelope))).toEqual(image);
    expect(parseImageEnvelope(JSON.stringify(JSON.stringify(envelope)))).toEqual(image);
    expect(parseImageEnvelope(JSON.stringify({ image: envelope.image }))).toEqual({
      ...image,
      text: '',
    });
  });

  it('reads anything else as text, a thrice-encoded envelope included', () => {
    const thrice = JSON.stringify(JSON.stringify(JSON.stringify(envelope)));
    for (const text of [
      thrice,
      'Board view: nothing to show',
      JSON.stringify('words'),
      JSON.stringify({ view: { x: 1 } }),
      JSON.stringify([envelope]),
      'null',
      '{"image"',
    ]) {
      expect(parseImageEnvelope(text), text).toEqual({ kind: 'text' });
    }
  });

  it('strips a data URL, whose type is then the image type', () => {
    const url = { image: { data: `data:image/webp;base64,${data}` } };
    expect(parseImageEnvelope(JSON.stringify(url))).toEqual({
      kind: 'image',
      image: { mimeType: 'image/webp', data },
      text: '',
    });
    const both = { image: { mimeType: 'image/webp', data: `data:image/webp;base64,${data}` } };
    expect(parseImageEnvelope(JSON.stringify(both)).kind).toBe('image');
  });

  it('refuses extra keys, a type the data URL contradicts and bare base64 with no type, naming fields only', () => {
    for (const [what, value] of [
      ['an extra key', { ...envelope, structuredContent: { secretmarker: 1 } }],
      ['an extra image key', { image: { ...envelope.image, secretmarker: 'x' } }],
      [
        'a contradicting type',
        { image: { mimeType: 'image/png', data: `data:image/webp;base64,${data}` } },
      ],
      ['bare base64 without a type', { image: { data } }],
      ['a data URL that is not base64', { image: { data: `data:image/png,${data}` } }],
      [
        'a data URL with parameters',
        { image: { data: `data:image/png;charset=x;base64,${data}` } },
      ],
      ['image that is no object', { image: 'secretmarker' }],
      ['text that is no text', { image: envelope.image, text: 42 }],
      ['empty data', { image: { mimeType: 'image/png', data: '' } }],
    ] as const) {
      const parsed = parseImageEnvelope(JSON.stringify(value));
      expect(parsed.kind, what).toBe('invalid');
      expect(JSON.stringify(parsed), what).not.toContain('secretmarker');
      expect(JSON.stringify(parsed), what).not.toContain(data.slice(0, 12));
    }
  });

  it('uses the JSON.parse it took at load, never one a later page script put in place', () => {
    const original = JSON.parse;
    let calls = 0;
    JSON.parse = ((text: string) => {
      calls += 1;
      return original(text) as unknown;
    }) as typeof JSON.parse;
    try {
      expect(parseImageEnvelope(JSON.stringify(envelope))).toEqual(image);
    } finally {
      JSON.parse = original;
    }
    expect(calls).toBe(0);
  });
});

// Image results (ADR 0039). A page names its image tools in policy.imageTools;
// for those tools only, the adapter reads a handler's result as an envelope
// { image: { mimeType?, data }, text? }, checks the image and sends it in the
// result frame's `image` field; the relay checks it again before any client
// sees it. Both sides run the same checks from this module, so they refuse
// exactly the same inputs: one strict base64 decoder (Buffer and atob skip or
// forgive characters, so two decoders could disagree on what a page sent),
// the type allowlist, the first bytes and the header dimensions. Nothing here
// draws, decodes pixels or re-encodes an image, and no message repeats
// anything the page wrote, its declared type included.

// First, before zod builds anything: no eval probe on Trusted Types pages.
import './zod-config.ts';
import * as z from 'zod/mini';
import { MAX_FRAME_BYTES, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE } from './constants.ts';

/**
 * The only image types that pass, as exact lower-case names: no SVG (text
 * that can carry script), no GIF (animation and decoder history, and no
 * canvas encodes it), no AVIF (not on Claude Code's list).
 */
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

/**
 * Why an image was refused. undeclared: the hello's policy.imageTools does not
 * name the tool (the relay's check); off: the cap is 0; type: not one of
 * IMAGE_MIME_TYPES; encoding: not canonical base64; size: over the cap;
 * signature: the first bytes are not its type's; dimensions: the header
 * cannot be read or declares too many pixels.
 */
export const ImageRefusalSchema = z.enum([
  'undeclared',
  'off',
  'type',
  'encoding',
  'size',
  'signature',
  'dimensions',
]);
export type ImageRefusal = z.infer<typeof ImageRefusalSchema>;

/**
 * An image as a result frame carries it. Structural only: a frame whose image
 * is SVG or bad base64 still parses, so the relay can answer that one call
 * tool_error in its own words instead of closing the socket with 1008 and
 * failing every call in flight on the page; checkImage does the rest.
 */
export const WireImageSchema = z.strictObject({
  mimeType: z.string().check(z.minLength(1), z.maxLength(100)),
  data: z.string().check(z.minLength(1), z.maxLength(MAX_FRAME_BYTES)),
});
export type WireImage = z.infer<typeof WireImageSchema>;

/** Characters of canonical base64 that `bytes` bytes take, padding included. */
export function base64Chars(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

/**
 * The bytes canonical base64 of this length decodes to, read from its length
 * and padding alone, or null when no canonical text has that shape. It looks
 * at no other character, so decodeBase64 still decides whether the text is
 * base64 at all.
 */
export function decodedLength(text: string): number | null {
  if (text.length === 0 || text.length % 4 !== 0) return null;
  let padding = 0;
  if (text.endsWith('==')) padding = 2;
  else if (text.endsWith('=')) padding = 1;
  if (text.endsWith('===')) return null;
  return (text.length / 4) * 3 - padding;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const PAD = 0x3d;
/** Each character code's value in the standard alphabet, -1 for any other, '=' among them. */
const SEXTETS = new Int8Array(256).fill(-1);
for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
  SEXTETS[BASE64_ALPHABET.charCodeAt(index)] = index;
}

function sextet(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return code < 256 ? (SEXTETS[code] ?? -1) : -1;
}

/**
 * Strict base64: the standard alphabet only, `=` padding required, a length
 * that is a multiple of 4, no white space, and the bits a padded group leaves
 * over all zero, so every byte string has exactly one text that decodes to
 * it. null for anything else. A character-code loop over a table, with no
 * atob or Buffer, so a browser and Node refuse alike and a page script that
 * replaced atob is never handed an image.
 */
export function decodeBase64(text: string): Uint8Array | null {
  const length = text.length;
  if (length % 4 !== 0) return null;
  let padding = 0;
  if (length > 0 && text.charCodeAt(length - 1) === PAD) {
    padding = text.charCodeAt(length - 2) === PAD ? 2 : 1;
  }
  const bytes = new Uint8Array((length / 4) * 3 - padding);
  let out = 0;
  for (let index = 0; index < length; index += 4) {
    const a = sextet(text, index);
    const b = sextet(text, index + 1);
    if (a < 0 || b < 0) return null;
    if (index + 4 === length && padding === 2) {
      if ((b & 0x0f) !== 0) return null;
      bytes[out] = (a << 2) | (b >> 4);
      return bytes;
    }
    const c = sextet(text, index + 2);
    if (c < 0) return null;
    if (index + 4 === length && padding === 1) {
      if ((c & 0x03) !== 0) return null;
      bytes[out] = (a << 2) | (b >> 4);
      bytes[out + 1] = ((b & 0x0f) << 4) | (c >> 2);
      return bytes;
    }
    const d = sextet(text, index + 3);
    if (d < 0) return null;
    bytes[out] = (a << 2) | (b >> 4);
    bytes[out + 1] = ((b & 0x0f) << 4) | (c >> 2);
    bytes[out + 2] = ((c & 0x03) << 6) | d;
    out += 3;
  }
  return bytes;
}

// Reading headers. Every read is checked against the buffer's length first.

function byteAt(bytes: Uint8Array, index: number): number {
  return bytes[index] ?? 0;
}

function bigEndian16(bytes: Uint8Array, index: number): number {
  return (byteAt(bytes, index) << 8) | byteAt(bytes, index + 1);
}

function bigEndian32(bytes: Uint8Array, index: number): number {
  return (
    ((byteAt(bytes, index) << 24) |
      (byteAt(bytes, index + 1) << 16) |
      (byteAt(bytes, index + 2) << 8) |
      byteAt(bytes, index + 3)) >>>
    0
  );
}

function littleEndian24(bytes: Uint8Array, index: number): number {
  return byteAt(bytes, index) | (byteAt(bytes, index + 1) << 8) | (byteAt(bytes, index + 2) << 16);
}

function littleEndian32(bytes: Uint8Array, index: number): number {
  return (littleEndian24(bytes, index) | (byteAt(bytes, index + 3) << 24)) >>> 0;
}

/** Whether `text`, in ASCII, sits at `index`. */
function hasAscii(bytes: Uint8Array, index: number, text: string): boolean {
  if (index + text.length > bytes.length) return false;
  for (let offset = 0; offset < text.length; offset += 1) {
    if (bytes[index + offset] !== text.charCodeAt(offset)) return false;
  }
  return true;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function isPng(bytes: Uint8Array): boolean {
  return (
    PNG_SIGNATURE.every((value, index) => bytes[index] === value) && hasAscii(bytes, 12, 'IHDR')
  );
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isWebp(bytes: Uint8Array): boolean {
  return hasAscii(bytes, 0, 'RIFF') && hasAscii(bytes, 8, 'WEBP');
}

/** The first bytes each type must start with. */
function hasSignature(bytes: Uint8Array, type: ImageMimeType): boolean {
  if (type === 'image/png') return isPng(bytes);
  if (type === 'image/jpeg') return isJpeg(bytes);
  return isWebp(bytes);
}

/** Segments a JPEG walk reads before it gives up, so no crafted file makes it long. */
const MAX_JPEG_SEGMENTS = 1_000;

/**
 * A start-of-frame marker: C0 to CF, except C4 (Huffman tables), C8 (reserved
 * for extensions) and CC (arithmetic coding conditioning).
 */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2;
  for (let segments = 0; segments < MAX_JPEG_SEGMENTS; segments += 1) {
    if (offset >= bytes.length || bytes[offset] !== 0xff) return null;
    // A marker may follow any number of 0xFF fill bytes.
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = byteAt(bytes, offset);
    offset += 1;
    // TEM and the restart markers stand alone, with no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    // The image data or its end came before any frame header.
    if (marker === 0xd8 || marker === 0xd9 || marker === 0xda) return null;
    if (offset + 2 > bytes.length) return null;
    const length = bigEndian16(bytes, offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (isStartOfFrame(marker)) {
      // Length, precision, then height and width, each two bytes big-endian.
      if (length < 7) return null;
      return { width: bigEndian16(bytes, offset + 5), height: bigEndian16(bytes, offset + 3) };
    }
    offset += length;
  }
  return null;
}

function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (hasAscii(bytes, 12, 'VP8X')) {
    if (bytes.length < 30) return null;
    return { width: littleEndian24(bytes, 24) + 1, height: littleEndian24(bytes, 27) + 1 };
  }
  if (hasAscii(bytes, 12, 'VP8 ')) {
    if (bytes.length < 30) return null;
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return {
      width: (byteAt(bytes, 26) | (byteAt(bytes, 27) << 8)) & 0x3fff,
      height: (byteAt(bytes, 28) | (byteAt(bytes, 29) << 8)) & 0x3fff,
    };
  }
  if (hasAscii(bytes, 12, 'VP8L')) {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
    const bits = littleEndian32(bytes, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

/**
 * An image's width and height in pixels as its header declares them, or null
 * when the header cannot be read: PNG from IHDR, JPEG by walking segments to
 * the first frame header (at most MAX_JPEG_SEGMENTS), WebP from its VP8X, VP8
 * or VP8L header. Only the header is read, never the pixels.
 */
export function imageSize(
  bytes: Uint8Array,
  type: ImageMimeType,
): { width: number; height: number } | null {
  if (type === 'image/png') {
    if (bytes.length < 24 || !isPng(bytes)) return null;
    return { width: bigEndian32(bytes, 16), height: bigEndian32(bytes, 20) };
  }
  if (type === 'image/jpeg') return isJpeg(bytes) ? jpegSize(bytes) : null;
  return isWebp(bytes) ? webpSize(bytes) : null;
}

export type CheckedImage =
  | { ok: true; mimeType: ImageMimeType; bytes: Uint8Array; width: number; height: number }
  | { ok: false; reason: ImageRefusal; message: string };

function refused(reason: ImageRefusal, message: string): CheckedImage {
  return { ok: false, reason, message };
}

function isImageMimeType(type: string): type is ImageMimeType {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(type);
}

/**
 * Checks one image against a cap of `maxBytes` decoded bytes, never more than
 * MAX_IMAGE_BYTES, in a fixed order: off, type, size by base64 length (before
 * any scan, so an oversized image costs no decoding), encoding, size by
 * decoded length, first bytes, then the header's dimensions. Its messages are
 * fixed words with numbers; none repeats the page's type or data.
 */
export function checkImage(image: WireImage, maxBytes: number): CheckedImage {
  const cap = Math.min(maxBytes, MAX_IMAGE_BYTES);
  if (!(cap > 0)) return refused('off', 'image results are off here (a cap of 0 bytes)');
  if (!isImageMimeType(image.mimeType)) {
    return refused('type', 'the image is not PNG, JPEG or WebP');
  }
  const mimeType = image.mimeType;
  const over = `the image is over the cap of ${String(cap)} bytes`;
  if (image.data.length > base64Chars(cap)) return refused('size', over);
  const bytes = decodeBase64(image.data);
  if (bytes === null || bytes.length === 0) {
    return refused('encoding', 'the image data is not canonical base64');
  }
  if (bytes.length > cap) {
    return refused(
      'size',
      `the image is ${String(bytes.length)} bytes, over the cap of ${String(cap)} bytes`,
    );
  }
  if (!hasSignature(bytes, mimeType)) {
    return refused('signature', "the image's first bytes are not those of its type");
  }
  const size = imageSize(bytes, mimeType);
  if (size === null) {
    return refused('dimensions', "the image's width and height cannot be read from its header");
  }
  const { width, height } = size;
  if (
    width === 0 ||
    height === 0 ||
    width > MAX_IMAGE_SIDE ||
    height > MAX_IMAGE_SIDE ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    return refused(
      'dimensions',
      `the image is ${String(width)} by ${String(height)} pixels; at most ${String(MAX_IMAGE_SIDE)} a side and ${String(MAX_IMAGE_PIXELS)} in all`,
    );
  }
  return { ok: true, mimeType, bytes, width, height };
}

// The envelope a declared image tool's handler returns.

/**
 * JSON.parse as it was when this module loaded, which in the adapter's bundle
 * is before attach(): a page script that replaced it later would otherwise be
 * handed every image result (page-link.ts says the same of frames).
 */
const parseJson = JSON.parse;

const EnvelopeImageSchema = z.strictObject({
  mimeType: z.optional(z.string().check(z.minLength(1), z.maxLength(100))),
  data: z.string().check(z.minLength(1)),
});
const ImageEnvelopeSchema = z.strictObject({
  image: EnvelopeImageSchema,
  text: z.optional(z.string()),
});

/**
 * `data:<type>;base64,` and nothing else: a canvas writes exactly this, and
 * any other parameter is refused rather than read.
 */
const DATA_URL = /^data:([^,;]{1,100});base64,/;

export type ImageEnvelope =
  | { kind: 'image'; image: { mimeType: string; data: string }; text: string }
  | { kind: 'text' }
  | { kind: 'invalid'; message: string };

/** What is wrong with the envelope, naming fields only: a key or value the page wrote never appears. */
function envelopeProblem(issue: z.core.$ZodIssue | undefined): string {
  const where = issue === undefined ? '' : issue.path.map(String).join('.');
  const field = where === '' ? 'the image envelope' : where;
  if (issue?.code === 'unrecognized_keys') {
    return `${field} holds fields an image envelope does not take`;
  }
  return `${field} is missing or not of its kind`;
}

/**
 * Reads a declared image tool's result text. The handler's value arrives as
 * JSON (an object as its JSON on every runtime; a string returned by the
 * handler quoted once more on MCP-B 6), so it is parsed once, and once again
 * when that gives a string. Only an object with an own `image` key is an
 * envelope; anything else is ordinary text, so a declared image tool can
 * still answer in words. An envelope takes strict keys: `image` with `data`
 * (bare base64, or a `data:<type>;base64,` URL whose type is the image's) and
 * `mimeType` (required with bare base64, and equal to the URL's type when
 * both are given), and an optional `text`.
 */
export function parseImageEnvelope(text: string): ImageEnvelope {
  let value: unknown;
  try {
    value = parseJson(text);
    if (typeof value === 'string') value = parseJson(value);
  } catch {
    return { kind: 'text' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { kind: 'text' };
  if (!Object.keys(value).includes('image')) return { kind: 'text' };
  const parsed = ImageEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    return { kind: 'invalid', message: envelopeProblem(parsed.error.issues[0]) };
  }
  const { image } = parsed.data;
  let data = image.data;
  let mimeType = image.mimeType;
  if (data.startsWith('data:')) {
    const url = DATA_URL.exec(data);
    if (url === null) {
      return { kind: 'invalid', message: 'image.data is a data URL that is not base64' };
    }
    const urlType = url[1] ?? '';
    if (mimeType !== undefined && mimeType !== urlType) {
      return {
        kind: 'invalid',
        message: 'image.mimeType differs from the type its data URL names',
      };
    }
    mimeType = urlType;
    data = data.slice(url[0].length);
  } else if (mimeType === undefined) {
    return { kind: 'invalid', message: 'image.mimeType is required beside bare base64 data' };
  }
  return { kind: 'image', image: { mimeType, data }, text: parsed.data.text ?? '' };
}

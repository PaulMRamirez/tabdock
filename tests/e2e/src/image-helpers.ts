// Reading image results as a client receives them (ADR 0039): the text block
// with the label and the relay's image line, the image part after it, and
// the width and height a PNG's own header gives, so a test can tell a real
// picture from bytes that merely passed through.

/** A tools/call result's content, as either SDK era hands it back. */
export interface ResultContent {
  content: readonly { type: string; text?: string; data?: string; mimeType?: string }[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface ImagePart {
  mimeType: string;
  data: string;
}

/** The first block's text, where the label and the page's words are. */
export function firstText(result: ResultContent): string {
  const [block] = result.content;
  return block?.type === 'text' ? (block.text ?? '') : '';
}

/** The result's one image part, or null; throws when it has more than one, which no answer may. */
export function imagePart(result: ResultContent): ImagePart | null {
  const images = result.content.filter((block) => block.type === 'image');
  if (images.length > 1) throw new Error('a result carried more than one image');
  const [image] = images;
  if (image === undefined) return null;
  return { mimeType: image.mimeType ?? '', data: image.data ?? '' };
}

/** The image's bytes; base64 in Node is lenient, so a test checks the text is canonical first. */
export function imageBytes(image: ImagePart): Uint8Array {
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.toString('base64') !== image.data) throw new Error('the image is not canonical base64');
  return new Uint8Array(bytes);
}

/**
 * Every 32-character slice of `data`, taken every `step` characters, that
 * `text` holds: empty when no log line carries any of a picture (S7, A6.5).
 */
export function leakedSlices(data: string, text: string, step = 101): string[] {
  const found: string[] = [];
  for (let offset = 0; offset + 32 <= data.length; offset += step) {
    const slice = data.slice(offset, offset + 32);
    if (text.includes(slice)) found.push(slice);
  }
  return found;
}

/** Width and height from a PNG's IHDR chunk, or null for anything that is not a PNG. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value)) return null;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

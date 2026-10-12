// Reading a Tabdock result as a careful client does. Page content reaches a
// client only behind the relay's label line, never as structured content
// (SPEC S10), so the walk takes a page's JSON from the text after that line,
// and after the relay's line for an image where there is one, and counts
// anything else as a finding: a result with no label is one a client could
// not tell from the relay's own words.

/** A tools/call result as an SDK client hands it back. */
export interface ResultLike {
  readonly content: readonly {
    readonly type: string;
    readonly text?: string;
    readonly data?: string;
    readonly mimeType?: string;
  }[];
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
}

/** Why a result could not be read; relay words only, never the page's. */
export type Unreadable =
  'no label' | 'not JSON' | 'structured content' | 'more than one image' | `error ${string}`;

export interface Read {
  /** The page's JSON after the label. */
  readonly body: unknown;
  /** The image after the text, if the result carries one. */
  readonly image: { readonly mimeType: string; readonly data: string } | null;
}

/** The label line every page result and page state answer starts with. */
const LABEL = /^\[tabdock: [^\n]*\]$/;
/** The relay's line between the label and the page's words in an image result (ADR 0039). */
const IMAGE_LINE = /^\[tabdock: the image after this text [^\n]*\]$/;
/** A relay refusal's code, which comes first in its words. */
const ERROR_CODE = /^([a-z_]+): /;

/**
 * The JSON a labelled text holds: its first line must be the relay's label,
 * and the rest, after the relay's image line where there is one, must parse.
 */
export function labelledJson(
  text: string,
): { ok: true; body: unknown } | { ok: false; why: Unreadable } {
  const lines = text.split('\n');
  if (!LABEL.test(lines[0] ?? '')) return { ok: false, why: 'no label' };
  const rest = IMAGE_LINE.test(lines[1] ?? '') ? lines.slice(2) : lines.slice(1);
  try {
    return { ok: true, body: JSON.parse(rest.join('\n')) as unknown };
  } catch {
    return { ok: false, why: 'not JSON' };
  }
}

/**
 * A result's page JSON and its one image, or why there is none. A refusal is
 * named by the relay's code where it gives one, and as tool_error where the
 * page threw, whose words are the page's and stay out of a finding.
 */
export function readResult(
  result: ResultLike,
): { ok: true; read: Read } | { ok: false; why: Unreadable } {
  const first = result.content[0];
  const text = first?.type === 'text' ? (first.text ?? '') : '';
  if (result.isError === true) {
    const code = ERROR_CODE.exec(text)?.[1];
    return {
      ok: false,
      why: `error ${code ?? (LABEL.test(text.split('\n')[0] ?? '') ? 'tool_error' : 'unknown')}`,
    };
  }
  if (result.structuredContent !== undefined) return { ok: false, why: 'structured content' };
  const images = result.content.filter((block) => block.type === 'image');
  if (images.length > 1) return { ok: false, why: 'more than one image' };
  const parsed = labelledJson(text);
  if (!parsed.ok) return parsed;
  const [image] = images;
  return {
    ok: true,
    read: {
      body: parsed.body,
      image:
        image === undefined ? null : { mimeType: image.mimeType ?? '', data: image.data ?? '' },
    },
  };
}

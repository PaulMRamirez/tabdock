// What a tool result carries, as the relay's own tests and the e2e suites
// read it. Page text travels only in labelled text content, never as
// structuredContent (ADR 0025's notes from the A5.6 review), so the JSON
// body of a page result, a tool list or a page list is read from the text
// after its [tabdock: ...] line; a result with no page text in it (pair_page,
// detach_page, an empty list_pages) still sends its structured copy.

/** The JSON object a line of text holds, or undefined. */
function objectIn(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The JSON object a result carries: its structured content where the relay
 * sends one, or else the JSON after the label of its text, the whole rest or,
 * for a tool list with a closing line, the line after the label. Undefined
 * for anything else, a cut result or plain text among them.
 */
export function resultJson(text: string, structuredContent: unknown): unknown {
  if (structuredContent !== undefined) return structuredContent;
  if (!text.startsWith('[tabdock: ')) return undefined;
  const lines = text.split('\n');
  return objectIn(lines.slice(1).join('\n')) ?? objectIn(lines[1] ?? '');
}

/** A result as an SDK client returns it. */
export interface RawResult {
  content?: readonly { type: string; text?: string }[];
  structuredContent?: unknown;
}

/** resultJson for a result as an SDK client returns it. */
export function bodyOf(result: RawResult): unknown {
  const text = (result.content ?? [])
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .join('\n');
  return resultJson(text, result.structuredContent);
}

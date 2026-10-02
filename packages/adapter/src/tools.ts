// Turns what a WebMCP runtime's getTools() returns into the protocol's PageTool
// shape. Runtimes disagree (docs/notes/baseline.md): Chrome 153 and 154 return
// inputSchema as a JSON string, Chrome includes same-origin iframe tools, and
// the MCP-B polyfill 5.1 and Chrome 153 drop consequentialHint. Everything here
// is page-supplied data, so it is checked before it reaches the relay.

import {
  JsonObjectSchema,
  MAX_TOOLS_PER_PAGE,
  PageToolSchema,
  ToolNameSchema,
  type Policy,
  type ToolAnnotations,
  type PageTool,
} from '@tabdock/protocol';

/**
 * One getTools() entry as a runtime hands it over. Only name is relied on
 * before checking; every other field is read as unknown because runtimes vary.
 */
export interface RuntimeTool {
  readonly name: string;
  readonly title?: unknown;
  readonly description?: unknown;
  readonly inputSchema?: unknown;
  readonly annotations?: unknown;
  readonly origin?: unknown;
  readonly window?: unknown;
}

/**
 * Whether the runtime can report consequentialHint (ADR 0002). 'missing' means
 * tools carry annotations but none has the key, which is how the polyfill 5.1
 * and Chrome 153 look; 'unknown' means no tool carries annotations at all.
 */
export type HintSupport = 'reported' | 'missing' | 'unknown';

export interface NormalisedTool {
  /** What the relay sees. */
  readonly page: PageTool;
  /** The runtime's own entry, which executeTool needs back unchanged. */
  readonly runtime: RuntimeTool;
}

export interface ToolSnapshot {
  readonly tools: readonly NormalisedTool[];
  readonly byName: ReadonlyMap<string, NormalisedTool>;
  readonly hintSupport: HintSupport;
  /** Why tools were left out, for one log line each. */
  readonly problems: readonly string[];
}

const ANNOTATION_KEYS = [
  'readOnlyHint',
  'consequentialHint',
  'untrustedContentHint',
  'debugging',
] as const satisfies readonly (keyof ToolAnnotations)[];

/** Protocol caps on page-supplied text; cutting keeps a long description from costing the whole tool. */
const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_WIRE_CHARS = 10_000;

/** WebMCP lets a tool omit inputSchema; the wire wants an object, and this is what "no arguments" means. */
const EMPTY_SCHEMA = { type: 'object', properties: {} };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Names in problems are cut so a hostile name cannot flood the log. */
function shortName(name: unknown): string {
  return typeof name === 'string' ? JSON.stringify(name.slice(0, 64)) : 'a tool with no name';
}

function readSchema(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return { ...EMPTY_SCHEMA, properties: {} };
  let candidate: unknown;
  try {
    // A JSON round trip also drops anything that is not plain data and copies
    // the object, so later page changes cannot alter what was checked.
    candidate = JSON.parse(typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    return null;
  }
  const parsed = JsonObjectSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function readAnnotations(value: unknown): ToolAnnotations | undefined {
  if (!isPlainObject(value)) return undefined;
  const annotations: ToolAnnotations = {};
  for (const key of ANNOTATION_KEYS) {
    const hint = value[key];
    if (typeof hint === 'boolean') annotations[key] = hint;
  }
  return annotations;
}

/**
 * Reads a getTools() list. When ownWindow is given, entries that carry a window
 * other than it are dropped, because Chrome lists same-origin iframe tools too.
 */
export function normaliseTools(list: readonly RuntimeTool[], ownWindow: unknown): ToolSnapshot {
  const tools: NormalisedTool[] = [];
  const byName = new Map<string, NormalisedTool>();
  const problems: string[] = [];
  let sawAnnotations = false;
  let sawConsequentialKey = false;

  for (const entry of list) {
    if (!isPlainObject(entry)) {
      problems.push('skipped a getTools() entry that is not an object');
      continue;
    }
    if (ownWindow !== undefined && 'window' in entry && entry.window !== ownWindow) continue;

    const name = ToolNameSchema.safeParse(entry.name);
    if (!name.success) {
      problems.push(`skipped ${shortName(entry.name)}: its name breaks the WebMCP naming rule`);
      continue;
    }
    if (byName.has(name.data)) {
      problems.push(`skipped a second tool named ${shortName(name.data)}`);
      continue;
    }
    const inputSchema = readSchema(entry.inputSchema);
    if (inputSchema === null) {
      problems.push(`skipped ${shortName(name.data)}: its inputSchema is not a JSON object`);
      continue;
    }
    if (isPlainObject(entry.annotations)) {
      sawAnnotations = true;
      if ('consequentialHint' in entry.annotations) sawConsequentialKey = true;
    }
    const annotations = readAnnotations(entry.annotations);
    const title =
      typeof entry.title === 'string' && entry.title !== ''
        ? entry.title.slice(0, MAX_TITLE_CHARS)
        : undefined;
    const description =
      typeof entry.description === 'string'
        ? entry.description.slice(0, MAX_DESCRIPTION_WIRE_CHARS)
        : '';
    const checked = PageToolSchema.safeParse({
      name: name.data,
      description,
      inputSchema,
      ...(title === undefined ? {} : { title }),
      ...(annotations === undefined ? {} : { annotations }),
    });
    if (!checked.success) {
      const where = checked.error.issues[0]?.path.join('.') ?? '';
      problems.push(`skipped ${shortName(name.data)}: invalid ${where || 'tool'}`);
      continue;
    }
    if (tools.length >= MAX_TOOLS_PER_PAGE) {
      problems.push(`shared only the first ${MAX_TOOLS_PER_PAGE} tools`);
      break;
    }
    const tool: NormalisedTool = { page: checked.data, runtime: entry };
    tools.push(tool);
    byName.set(tool.page.name, tool);
  }

  const hintSupport: HintSupport = sawConsequentialKey
    ? 'reported'
    : sawAnnotations
      ? 'missing'
      : 'unknown';
  return { tools, byName, hintSupport, problems };
}

/**
 * ADR 0002 option C. A tool is consequential when its hint or the page's list
 * says so. When the runtime evidently drops the hint and the page gave no list,
 * every tool that is not read-only counts, so S6 fails safe.
 */
export function isConsequential(
  tool: PageTool,
  hintSupport: HintSupport,
  policy: Policy,
  pageListedTools: boolean,
): boolean {
  if (tool.annotations?.consequentialHint === true) return true;
  if (policy.consequentialTools.includes(tool.name)) return true;
  return hintSupport === 'missing' && !pageListedTools && tool.annotations?.readOnlyHint !== true;
}

/** True when the hint fallback is what decides, so the operator should be told how to fix it. */
export function needsHintNotice(
  hintSupport: HintSupport,
  policy: Policy,
  pageListedTools: boolean,
): boolean {
  return hintSupport === 'missing' && !pageListedTools && policy.consequential !== 'allow';
}

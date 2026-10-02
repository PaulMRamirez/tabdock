// Argument checks against a page tool's inputSchema (ADR 0008). One check is
// compiled per tool from the page's own schema when its tools frame arrives,
// with the SDK's CfWorker validator; never Ajv, which crashes on an $async
// schema, shares validators between schemas with one $id and never shrinks its
// cache. Before compiling, every regex the page wrote is removed: a pattern such
// as ^(a+)+$ backtracks exponentially, and so does CfWorker's own url format on
// a long string, so format goes too. Removing a rule can tighten a schema where
// it sits under not, if, oneOf or maxContains, or beside additionalProperties and
// unevaluated keywords, so those are loosened in turn: the relay never refuses
// arguments the page's own schema accepts. Failures are described in the
// relay's words only, because CfWorker's messages quote the schema (enum values,
// required names, types).

import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';
import type { JsonObject } from '@tabdock/protocol';

export type ArgumentCheck =
  | { kind: 'valid' }
  | { kind: 'invalid'; message: string }
  /** The validator itself failed on these arguments, so they go on unchecked. */
  | { kind: 'unchecked' };

export type CheckArguments = (args: JsonObject) => ArgumentCheck;

/**
 * Nesting past this is not checked. Both our walk and CfWorker's recurse, and a
 * schema deeper than this is also too deep for clients to be shown (hub.ts).
 */
export const MAX_CHECKED_SCHEMA_DEPTH = 64;

/** Keywords that run a regex: pattern and patternProperties directly, format through CfWorker's checks. */
const REGEX_KEYWORDS = new Set(['pattern', 'patternProperties', 'format']);
/** Without patternProperties beside them, these would refuse the properties it allowed. */
const PATTERN_PROPERTIES_SIBLINGS = new Set(['additionalProperties', 'unevaluatedProperties']);
/**
 * No effect on validation. Dropped so the check keeps no page prose, and so no
 * object hidden in them can serve as a $ref target that still holds a regex.
 */
const ANNOTATION_KEYWORDS = new Set([
  'title',
  'description',
  '$comment',
  'examples',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
]);
/** Instance data or plain values, kept exactly. CfWorker never reads a schema in them. */
const DATA_KEYWORDS = new Set(['enum', 'const', 'required', 'type', '$vocabulary']);
/** Keys are names and values are schemas; a name is never mistaken for a keyword. */
const NAME_MAPS = new Set(['properties', '$defs', 'definitions', 'dependentSchemas']);
/**
 * Name maps that CfWorker also indexes as schemas, so a $ref into one reads its
 * names as keywords: an entry named like a regex keyword is removed.
 */
const KEYWORD_NAME_MAPS = new Set(['dependencies', 'dependentRequired']);
/** A reference may land on a loosened schema anywhere, so it counts as loosened itself. */
const REFERENCES = new Set(['$ref', '$dynamicRef', '$recursiveRef']);

type Position = 'schema' | 'names' | 'keywordNames';

class SchemaTooDeep extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positionUnder(key: string): Position | 'data' {
  if (DATA_KEYWORDS.has(key)) return 'data';
  if (NAME_MAPS.has(key)) return 'names';
  if (KEYWORD_NAME_MAPS.has(key)) return 'keywordNames';
  return 'schema';
}

interface Stripped {
  value: unknown;
  /** Accepts at least what it accepted before, and possibly more. */
  loosened: boolean;
}

class Stripper {
  removedRegex = false;
  /** Set when an evaluation source went away, which unevaluated keywords anywhere could feel. */
  shrankEvaluation = false;
  readonly #refsLoosen: boolean;

  constructor(refsLoosen: boolean) {
    this.#refsLoosen = refsLoosen;
  }

  value(value: unknown, position: Position, depth: number): Stripped {
    if (depth > MAX_CHECKED_SCHEMA_DEPTH) throw new SchemaTooDeep();
    if (Array.isArray(value)) {
      let loosened = false;
      const items = value.map((item) => {
        const stripped = this.value(item, 'schema', depth + 1);
        loosened ||= stripped.loosened;
        return stripped.value;
      });
      return { value: items, loosened };
    }
    if (!isObject(value)) return { value, loosened: false };
    return position === 'schema'
      ? this.#schema(value, depth)
      : this.#names(value, position === 'keywordNames', depth);
  }

  #names(map: Record<string, unknown>, keywordNames: boolean, depth: number): Stripped {
    let loosened = false;
    const entries: [string, unknown][] = [];
    for (const [name, item] of Object.entries(map)) {
      if (keywordNames && REGEX_KEYWORDS.has(name)) {
        this.removedRegex = true;
        loosened = true;
        continue;
      }
      const stripped = this.value(item, 'schema', depth + 1);
      loosened ||= stripped.loosened;
      entries.push([name, stripped.value]);
    }
    // fromEntries defines own properties, so a "__proto__" name stays a plain key.
    return { value: Object.fromEntries(entries), loosened };
  }

  #schema(schema: Record<string, unknown>, depth: number): Stripped {
    const hadPatternProperties = Object.hasOwn(schema, 'patternProperties');
    let loosened = false;
    const loosenedKeys = new Set<string>();
    const kept = new Map<string, unknown>();
    for (const [key, item] of Object.entries(schema)) {
      if (REGEX_KEYWORDS.has(key)) {
        this.removedRegex = true;
        loosened = true;
        continue;
      }
      if (ANNOTATION_KEYWORDS.has(key)) continue;
      if (hadPatternProperties && PATTERN_PROPERTIES_SIBLINGS.has(key)) continue;
      if (REFERENCES.has(key) && this.#refsLoosen) loosened = true;
      const position = positionUnder(key);
      if (position === 'data') {
        kept.set(key, item);
        continue;
      }
      const stripped = this.value(item, position, depth + 1);
      if (stripped.loosened) {
        loosened = true;
        loosenedKeys.add(key);
      }
      kept.set(key, stripped.value);
    }
    if (hadPatternProperties) this.shrankEvaluation = true;

    // Where loosening a part would tighten the whole, the whole is loosened instead.
    if (loosenedKeys.has('not')) kept.delete('not');
    if (loosenedKeys.has('if')) {
      kept.delete('if');
      kept.delete('then');
      kept.delete('else');
      // if marks what it evaluated, so unevaluated keywords could now refuse more.
      this.shrankEvaluation = true;
    }
    if (loosenedKeys.has('oneOf')) {
      // More branches may match now; anyOf accepts everything oneOf did.
      const branches = kept.get('oneOf');
      kept.delete('oneOf');
      const allOf = kept.get('allOf');
      if (!kept.has('anyOf')) kept.set('anyOf', branches);
      else if (allOf === undefined || Array.isArray(allOf)) {
        kept.set('allOf', [...((allOf as unknown[] | undefined) ?? []), { anyOf: branches }]);
      }
    }
    // More items may match contains now, so only an upper bound could tighten.
    if (loosenedKeys.has('contains')) kept.delete('maxContains');
    return { value: Object.fromEntries(kept), loosened };
  }
}

function withoutUnevaluated(value: unknown, position: Position): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutUnevaluated(item, 'schema'));
  if (!isObject(value)) return value;
  const entries: [string, unknown][] = [];
  for (const [key, item] of Object.entries(value)) {
    if (position === 'schema') {
      if (key === 'unevaluatedProperties' || key === 'unevaluatedItems') continue;
      const under = positionUnder(key);
      entries.push([key, under === 'data' ? item : withoutUnevaluated(item, under)]);
    } else {
      entries.push([key, withoutUnevaluated(item, 'schema')]);
    }
  }
  return Object.fromEntries(entries);
}

/**
 * The page's schema with every regex removed and every rule the removal could
 * have tightened loosened. Throws when the schema is nested too deep to check.
 */
export function prepareSchema(schema: JsonObject): JsonObject {
  // References only matter once something was removed; without that, nothing is loosened.
  let stripper = new Stripper(false);
  let prepared = stripper.value(schema, 'schema', 0).value;
  if (stripper.removedRegex) {
    stripper = new Stripper(true);
    prepared = stripper.value(schema, 'schema', 0).value;
  }
  if (stripper.shrankEvaluation) prepared = withoutUnevaluated(prepared, 'schema');
  return prepared as JsonObject;
}

// Describing a failure without the schema's words

/** Where CfWorker's message says each error is: "<instance pointer>: <text>", joined by "; ". */
const ERROR_LOCATION = /(?:^|; )(#[^ ]*): /g;
const MAX_SHOWN_POINTER = 200;

/** Errors that only say a part below failed; the part's own error says more. */
const WRAPPERS = [
  /^A subschema had errors\./,
  /^Items did not match schema\./,
  /^Property ".*" does not match schema\.$/s,
];

/**
 * CfWorker's error texts, recognised by their fixed wording and described in
 * ours. Only the keyword names and descriptions here ever reach a client.
 */
const RULES: [RegExp, string, string][] = [
  [/^Instance type "/, 'type', 'has the wrong type'],
  [/^Instance does not match any of /, 'enum', 'is not one of the allowed values'],
  [/^Instance does not match any subschemas\./, 'anyOf', 'matches none of the allowed forms'],
  [/^Instance does not match every subschema\./, 'allOf', 'does not match every required form'],
  [/^Instance does not match exactly one subschema/, 'oneOf', 'does not match exactly one form'],
  [/^Instance does not match "(then|else)" schema\./, 'if', 'fails a conditional rule'],
  [/^Instance does not match /, 'const', 'is not the allowed value'],
  [/^Instance matched "not" schema\./, 'not', 'matches a form it must not match'],
  [/^Instance does not have required property /, 'required', 'is missing a required property'],
  [/^Instance does not have at least /, 'minProperties', 'has too few or too many properties'],
  [/^Property name "/, 'propertyNames', 'has a property name that is not allowed'],
  [
    /^Instance has ".*" but does not have "/s,
    'dependentRequired',
    'is missing a property that another one requires',
  ],
  [
    /^Instance has ".*" but does not match dependant schema\./s,
    'dependentSchemas',
    'fails a rule that one of its properties brings in',
  ],
  [
    /^Property ".*" does not match additional properties schema\./s,
    'additionalProperties',
    'has a property that is not allowed',
  ],
  [
    /^Property ".*" does not match unevaluated properties schema\./s,
    'unevaluatedProperties',
    'has a property that is not allowed',
  ],
  [/^Property "/, 'properties', 'has a property that does not match its schema'],
  [/^Array has too many items/, 'maxItems', 'has too many items'],
  [/^Array has too few items/, 'minItems', 'has too few items'],
  [/^Items did not match additional items schema\./, 'additionalItems', 'has an extra item'],
  [/^Items did not match unevaluated items schema\./, 'unevaluatedItems', 'has an extra item'],
  [/^Items did not match schema\./, 'items', 'has an item that does not match its schema'],
  [/^Array (is empty|does not contain|must contain|has less)/, 'contains', 'lacks a required item'],
  [/^Array may contain at most /, 'maxContains', 'has too many matching items'],
  [/^Duplicate items at indexes /, 'uniqueItems', 'has duplicate items'],
  [/^\S+ is less than /, 'minimum', 'is below the allowed range'],
  [/^\S+ is greater than /, 'maximum', 'is above the allowed range'],
  [/^\S+ is not a multiple of /, 'multipleOf', 'is not a multiple of the required step'],
  [/^String is too short/, 'minLength', 'is too short'],
  [/^String is too long/, 'maxLength', 'is too long'],
  [/^False boolean schema\./, 'false', 'is not allowed'],
];

/** CfWorker's own pointer encoding: escape ~ and /, then encodeURI. */
function encodeSegment(key: string): string {
  return encodeURI(key.replaceAll('~', '~0').replaceAll('/', '~1'));
}

/**
 * The keys a pointer from the message names, or null unless every one of them
 * is really there in the caller's arguments. A pointer that resolves holds only
 * the caller's own keys, so no schema text can pass as a location.
 */
function resolvePointer(args: JsonObject, pointer: string): string[] | null {
  if (pointer === '#') return [];
  if (!pointer.startsWith('#/')) return null;
  const keys: string[] = [];
  let current: unknown = args;
  for (const segment of pointer.slice(2).split('/')) {
    let key: string;
    try {
      key = decodeURI(segment).replaceAll('~1', '/').replaceAll('~0', '~');
    } catch {
      return null;
    }
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d{0,8})$/.test(key) || Number(key) >= current.length) return null;
      current = current[Number(key)];
    } else if (isObject(current) && Object.hasOwn(current, key)) {
      current = current[key];
    } else {
      return null;
    }
    keys.push(key);
  }
  return keys;
}

interface Located {
  keys: string[];
  text: string;
}

function locatedErrors(args: JsonObject, message: string): Located[] {
  const found: { pointer: string; start: number; end: number }[] = [];
  for (const match of message.matchAll(ERROR_LOCATION)) {
    const pointer = match[1] ?? '';
    found.push({ pointer, start: match.index, end: match.index + match[0].length });
  }
  const located: Located[] = [];
  found.forEach((entry, index) => {
    const keys = resolvePointer(args, entry.pointer);
    if (keys === null) return;
    const text = message.slice(entry.end, found[index + 1]?.start ?? message.length);
    located.push({ keys, text });
  });
  return located;
}

/** "the arguments for tool t do not match its inputSchema: arguments/label has the wrong type (rule "type")". */
export function describeFailure(tool: string, args: JsonObject, message: string): string {
  const located = locatedErrors(args, message);
  // A page can repeat "; #: " in an enum value any number of times, so no spread here.
  const deepest = located.reduce((most, entry) => Math.max(most, entry.keys.length), 0);
  const atDeepest = located.filter((entry) => entry.keys.length === deepest);
  const chosen =
    atDeepest.find((entry) => !WRAPPERS.some((wrapper) => wrapper.test(entry.text))) ??
    atDeepest[0];
  const prefix = `the arguments for tool ${tool} do not match its inputSchema`;
  if (!chosen) return prefix;
  let where = 'the arguments object';
  if (chosen.keys.length > 0) {
    let pointer: string;
    try {
      pointer = chosen.keys.map((key) => `/${encodeSegment(key)}`).join('');
    } catch {
      pointer = '/...';
    }
    if (pointer.length > MAX_SHOWN_POINTER) pointer = `${pointer.slice(0, MAX_SHOWN_POINTER)}...`;
    where = `arguments${pointer}`;
  }
  const rule = RULES.find(([pattern]) => pattern.test(chosen.text));
  const [, keyword, description] = rule ?? [null, 'schema', 'fails a schema rule'];
  return `${prefix}: ${where} ${description} (rule "${keyword}")`;
}

const provider = new CfWorkerJsonSchemaValidator();

/**
 * One tool's check, or null when its schema cannot be checked (too deep, a
 * dialect CfWorker refuses, a reference it cannot resolve); calls to that tool
 * then go on unchecked, as they did before M2. Nothing here throws.
 */
export function compileArgumentCheck(tool: string, schema: JsonObject): CheckArguments | null {
  let validate: (input: unknown) => { valid: boolean; errorMessage?: string | undefined };
  try {
    // CfWorker annotates the schema object it is given, so it gets our own copy.
    validate = provider.getValidator(prepareSchema(schema));
  } catch {
    return null;
  }
  return (args) => {
    let result: ReturnType<typeof validate>;
    try {
      result = validate(args);
    } catch {
      return { kind: 'unchecked' };
    }
    if (result.valid) return { kind: 'valid' };
    return { kind: 'invalid', message: describeFailure(tool, args, result.errorMessage ?? '') };
  };
}

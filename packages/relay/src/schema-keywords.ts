// Where a value sits in a page's JSON Schema, so keyword rules apply only
// where keys are keywords. hub.ts cuts a page's schema by these positions
// (S9, S10) and first-class.ts copies the cut schema into a first-class
// entry by the same ones (ADR 0025), so a key the cut read as a property
// name is never read as prose by the entry, or the reverse.

/**
 * Schema keywords that clients show as prose. A string there is cut like any
 * other; anything else is replaced, because an array or object there would put
 * several capped strings into what a client shows as one description (S10).
 */
export const SCHEMA_TEXT_KEYS: ReadonlySet<string> = new Set(['description', 'title']);

/**
 * Keywords whose value maps names (property names, definition names, patterns)
 * to schemas: a "title" key in there is a property called title, not prose, and
 * must keep its schema.
 */
const SCHEMA_NAME_MAP_KEYS: ReadonlySet<string> = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependentRequired',
  'dependencies',
]);

/** Keywords whose value is instance data, where keys mean nothing to JSON Schema. */
const SCHEMA_DATA_KEYS: ReadonlySet<string> = new Set(['enum', 'const', 'default', 'examples']);

/** What a value is to JSON Schema: a schema, a map from names to schemas, or instance data. */
export type SchemaPosition = 'schema' | 'names' | 'data';

/** The position of the value under `key` in an object at `position`. */
export function childPosition(key: string, position: SchemaPosition): SchemaPosition {
  if (position === 'names') return 'schema';
  if (position === 'data') return 'data';
  if (SCHEMA_NAME_MAP_KEYS.has(key)) return 'names';
  return SCHEMA_DATA_KEYS.has(key) ? 'data' : 'schema';
}

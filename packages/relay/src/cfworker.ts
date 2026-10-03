// The only module that loads the SDK's CfWorker validator, and it is loaded
// only in the check worker (argument-worker.ts) and in tests: ADR 0010 keeps the
// validator off the relay's main thread, because some schemas and arguments
// cost it exponential or quadratic time. CfWorker rather than Ajv (ADR 0008):
// Ajv crashes on an $async schema, shares validators between schemas with one
// $id and never shrinks its cache.

import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';
import type { JsonObject } from '@tabdock/protocol';
import {
  type ArgumentCheck,
  type CheckArguments,
  describeFailure,
  prepareSchema,
} from './validate.ts';

/** One compiled schema, as CfWorker returns it. */
export type Validate = (input: unknown) => { valid: boolean; errorMessage?: string | undefined };

const provider = new CfWorkerJsonSchemaValidator();

/**
 * Compiles a schema prepareSchema already made safe, or null when CfWorker
 * refuses it (a dialect it does not know, a duplicate $id). Never throws.
 */
export function compilePrepared(prepared: unknown): Validate | null {
  try {
    // CfWorker annotates the schema object it is given, so this must be our own copy.
    return provider.getValidator(prepared as JsonObject);
  } catch {
    return null;
  }
}

/** One check, described in the relay's words. A validator that throws leaves the call unchecked. */
export function runCheck(validate: Validate, tool: string, args: JsonObject): ArgumentCheck {
  let result: ReturnType<Validate>;
  try {
    result = validate(args);
  } catch {
    // A reference CfWorker cannot resolve, arguments nested past its stack, a lone surrogate.
    return { kind: 'unchecked' };
  }
  if (result.valid) return { kind: 'valid' };
  return { kind: 'invalid', message: describeFailure(tool, args, result.errorMessage ?? '') };
}

/**
 * One tool's check straight from the page's schema, or null when it cannot be
 * checked (too deep, or refused by CfWorker). The worker compiles from the text
 * the main thread prepared instead; this is the same path in one step.
 */
export function compileArgumentCheck(tool: string, schema: JsonObject): CheckArguments | null {
  let validate: Validate | null;
  try {
    validate = compilePrepared(prepareSchema(schema));
  } catch {
    return null;
  }
  if (!validate) return null;
  const compiled = validate;
  return (args) => runCheck(compiled, tool, args);
}

export interface CompiledChecksOptions {
  /** Compiled schemas kept at most. */
  maxEntries: number;
  /** Prepared schema text, in characters, that the kept schemas may add up to. */
  maxChars: number;
}

/**
 * Compiled schemas by the hash of their prepared text, least recently used
 * evicted first. A page re-sending the same tools, or many pages sharing one
 * schema, compiles it once; the bounds keep a stream of distinct schemas from
 * growing the worker's memory without end.
 */
export class CompiledChecks {
  readonly #options: CompiledChecksOptions;
  /** Map order is use order: an entry is moved to the end each time it is used. */
  readonly #entries = new Map<string, { validate: Validate | null; chars: number }>();
  #chars = 0;

  constructor(options: CompiledChecksOptions) {
    this.#options = options;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** The compiled schema for this hash, compiling `text` only when it is not kept; null when it cannot compile. */
  get(hash: string, text: string): Validate | null {
    const kept = this.#entries.get(hash);
    if (kept) {
      this.#entries.delete(hash);
      this.#entries.set(hash, kept);
      return kept.validate;
    }
    let schema: unknown;
    try {
      schema = JSON.parse(text);
    } catch {
      schema = undefined;
    }
    const entry = {
      // A schema that cannot compile is remembered too, so it is not tried on every call.
      validate: schema === undefined ? null : compilePrepared(schema),
      chars: text.length,
    };
    this.#entries.set(hash, entry);
    this.#chars += entry.chars;
    for (const [oldest, held] of this.#entries) {
      const over =
        this.#entries.size > this.#options.maxEntries || this.#chars > this.#options.maxChars;
      // The newest entry stays even alone over the bound: it is about to be used.
      if (!over || oldest === hash) break;
      this.#entries.delete(oldest);
      this.#chars -= held.chars;
    }
    return entry.validate;
  }
}

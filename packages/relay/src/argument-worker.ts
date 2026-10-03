// The argument check's own thread (ADR 0010), started by argument-checker.ts.
// Node loads it as it loads the rest of the relay, a .ts file with types
// stripped. It compiles prepared schemas with CfWorker, keeps them by hash, and
// answers one check at a time. Whatever a schema or an argument costs here,
// the main thread only waits for its budget, then terminates this thread and
// starts another.

import { parentPort } from 'node:worker_threads';
import type { JsonObject } from '@tabdock/protocol';
import { CompiledChecks, runCheck } from './cfworker.ts';
import {
  type CheckRequest,
  CheckRequestSchema,
  type CheckResult,
  type WorkerMessage,
} from './check-messages.ts';

/** A busy relay sees far fewer distinct schemas than this between restarts. */
const MAX_COMPILED = 256;
/**
 * About eight full tools frames of schema text. A compiled schema holds several
 * times its text in memory, which this keeps well inside the thread's heap limit.
 */
const MAX_COMPILED_CHARS = 8 * 1024 * 1024;

const port = parentPort;
if (!port) throw new Error('argument-worker.ts runs only as a worker thread');

const compiled = new CompiledChecks({ maxEntries: MAX_COMPILED, maxChars: MAX_COMPILED_CHARS });

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function check(request: CheckRequest): CheckResult {
  const validate = compiled.get(request.hash, request.schema);
  if (!validate) return { kind: 'uncompilable' };
  let args: unknown;
  try {
    args = JSON.parse(request.args);
  } catch {
    return { kind: 'failed' };
  }
  if (!isObject(args)) return { kind: 'failed' };
  const result = runCheck(validate, request.tool, args);
  return result.kind === 'unchecked' ? { kind: 'failed' } : result;
}

port.on('message', (message: unknown) => {
  const parsed = CheckRequestSchema.safeParse(message);
  // Nothing to answer without an id; the main thread's budget ends the wait.
  if (!parsed.success) return;
  const reply: WorkerMessage = { t: 'result', id: parsed.data.id, result: check(parsed.data) };
  port.postMessage(reply);
});

const ready: WorkerMessage = { t: 'ready' };
port.postMessage(ready);

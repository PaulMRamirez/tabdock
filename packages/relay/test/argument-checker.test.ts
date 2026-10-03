// The worker that runs argument checks (ADR 0010), on its own: a time budget
// per check, a busy worker that never makes other checks wait past it, an
// overrunning or crashing worker replaced (with backoff when it keeps failing),
// a bounded cache of compiled schemas, and shutdown that stops the thread.
// Misbehaving workers come from test/fixtures; they load as plain node would
// load them, with type stripping.

import type { JsonObject } from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ArgumentChecker,
  type ArgumentCheckerOptions,
  prepareForCheck,
  type PreparedSchema,
} from '../src/argument-checker.ts';
import { CompiledChecks } from '../src/cfworker.ts';
import { createLogger } from '../src/log.ts';
import { delay } from './helpers/relay.ts';

const BUDGET_MS = 50;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture(name: string): URL {
  return new URL(`./fixtures/${name}`, import.meta.url);
}

function start(options: Partial<ArgumentCheckerOptions> = {}): {
  checker: ArgumentChecker;
  lines: string[];
} {
  const lines: string[] = [];
  const checker = new ArgumentChecker({
    budgetMs: BUDGET_MS,
    log: createLogger({ sink: (line) => lines.push(line), level: 'debug' }),
    ...options,
  });
  cleanups.push(() => checker.close());
  return { checker, lines };
}

function prepared(schema: JsonObject): PreparedSchema {
  const result = prepareForCheck(schema);
  if (!result) throw new Error('could not prepare');
  return result;
}

function fanOut(levels: number): JsonObject {
  const $defs: Record<string, unknown> = {};
  for (let level = 0; level < levels; level += 1) {
    const next = { $ref: `#/$defs/d${String(level + 1)}` };
    $defs[`d${String(level)}`] = { anyOf: [next, next] };
  }
  $defs[`d${String(levels)}`] = { type: 'object' };
  return { type: 'object', $defs, $ref: '#/$defs/d0' };
}

/** 2^30 steps: about 17 minutes on the main thread before ADR 0010. */
const FAN_OUT = prepared(fanOut(30));
const FORM = prepared({
  type: 'object',
  properties: { name: { type: 'string', maxLength: 5 } },
  required: ['name'],
});

function watchLoop(): { stop: () => number } {
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 5);
  return {
    stop: () => {
      clearInterval(timer);
      return Math.max(worst, performance.now() - last);
    },
  };
}

describe('ArgumentChecker', () => {
  it('checks in the worker and describes a failure in the relay words', async () => {
    const { checker } = start();
    expect(await checker.ready()).toBe(true);
    expect(await checker.check('form', FORM, { name: 'Ada' })).toEqual({ kind: 'valid' });
    expect(await checker.check('form', FORM, { name: 'far too long' })).toEqual({
      kind: 'invalid',
      message:
        'the arguments for tool form do not match its inputSchema: arguments/name is too long (rule "maxLength")',
    });
  });

  it('gives up on a 2^30 fan-out schema within the budget, and the main loop never waits on it', async () => {
    const { checker } = start();
    expect(await checker.ready()).toBe(true);
    const loop = watchLoop();
    const started = performance.now();
    expect(await checker.check('fan_out', FAN_OUT, {})).toEqual({
      kind: 'unchecked',
      reason: 'timeout',
    });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(BUDGET_MS - 5);
    expect(elapsed).toBeLessThan(500);
    expect(loop.stop()).toBeLessThan(100);
  });

  it('never makes a check wait behind a slow one for longer than the budget', async () => {
    const { checker } = start();
    expect(await checker.ready()).toBe(true);
    const slow = checker.check('fan_out', FAN_OUT, {});
    const started = performance.now();
    const queued = await checker.check('form', FORM, { name: 'Ada' });
    expect(queued).toEqual({ kind: 'unchecked', reason: 'busy' });
    expect(performance.now() - started).toBeLessThan(BUDGET_MS + 100);
    expect(await slow).toEqual({ kind: 'unchecked', reason: 'timeout' });
  });

  it('replaces an overrunning worker, and the replacement checks later calls as before', async () => {
    const { checker, lines } = start();
    expect(await checker.ready()).toBe(true);
    const before = checker.generation;
    expect(await checker.check('fan_out', FAN_OUT, {})).toMatchObject({ kind: 'unchecked' });
    expect(checker.generation).toBe(before + 1);
    expect(await checker.ready()).toBe(true);
    expect(await checker.check('form', FORM, { name: 7 })).toEqual({
      kind: 'invalid',
      message:
        'the arguments for tool form do not match its inputSchema: arguments/name has the wrong type (rule "type")',
    });
    expect(await checker.check('form', FORM, { name: 'Ada' })).toEqual({ kind: 'valid' });
    expect(lines.join('\n')).not.toContain('d0');
  });

  it('reports a schema CfWorker cannot compile, and a check that throws, without page text', async () => {
    const { checker } = start();
    expect(await checker.ready()).toBe(true);
    const old = prepared({ $schema: 'http://json-schema.org/draft-04/schema#', type: 'object' });
    expect(await checker.check('old', old, {})).toEqual({ kind: 'uncompilable' });
    const broken = prepared({ type: 'object', properties: { a: { $ref: '#/$defs/missing' } } });
    expect(await checker.check('broken', broken, { a: 1 })).toEqual({
      kind: 'unchecked',
      reason: 'failed',
    });
    // Neither failure costs the worker.
    expect(await checker.check('form', FORM, { name: 'Ada' })).toEqual({ kind: 'valid' });
  });

  it('lets checks through unchecked while a worker that fails to start is restarted with backoff', async () => {
    const { checker, lines } = start({ entry: fixture('broken-worker.ts') });
    expect(await checker.ready()).toBe(false);
    const outcome = await checker.check('form', FORM, { name: 'Ada' });
    expect(outcome).toMatchObject({ kind: 'unchecked' });
    await delay(1500);
    // Without backoff a worker that dies while loading is replaced every 50 to 100 ms.
    expect(checker.generation).toBeGreaterThanOrEqual(2);
    expect(checker.generation).toBeLessThanOrEqual(5);
    const quick = performance.now();
    expect(await checker.check('form', FORM, { name: 'Ada' })).toMatchObject({
      kind: 'unchecked',
    });
    expect(performance.now() - quick).toBeLessThan(BUDGET_MS + 100);
    const stopped = lines.filter((line) => line.includes('argument check worker stopped'));
    expect(stopped.length).toBeGreaterThanOrEqual(2);
    expect(lines.join('\n')).not.toContain('broken on purpose');
  });

  it('lets a check through unchecked at once when its worker crashes, and starts another', async () => {
    const { checker } = start({ entry: fixture('crash-worker.ts') });
    expect(await checker.ready()).toBe(true);
    const before = checker.generation;
    const started = performance.now();
    expect(await checker.check('form', FORM, { name: 'Ada' })).toEqual({
      kind: 'unchecked',
      reason: 'failed',
    });
    expect(performance.now() - started).toBeLessThan(BUDGET_MS + 100);
    expect(checker.generation).toBe(before + 1);
  });

  it('treats a reply that fails validation as a failed worker', async () => {
    const { checker } = start({ entry: fixture('garbage-worker.ts') });
    expect(await checker.ready()).toBe(true);
    const before = checker.generation;
    expect(await checker.check('form', FORM, { name: 'Ada' })).toEqual({
      kind: 'unchecked',
      reason: 'failed',
    });
    expect(checker.generation).toBe(before + 1);
  });

  it('terminates the worker on close and answers every later check unchecked', async () => {
    const heard: number[] = [];
    const channel = new BroadcastChannel('tabdock-test-worker-heartbeat');
    channel.onmessage = (event: MessageEvent) => {
      const beat: unknown = event.data;
      if (typeof beat === 'number') heard.push(beat);
    };
    cleanups.push(() => {
      channel.close();
      return Promise.resolve();
    });
    const { checker } = start({ entry: fixture('heartbeat-worker.ts') });
    expect(await checker.ready()).toBe(true);
    expect(await checker.check('form', FORM, { name: 'Ada' })).toEqual({ kind: 'valid' });
    await delay(50);
    expect(heard.length).toBeGreaterThan(0);

    await checker.close();
    const afterClose = heard.length;
    await delay(100);
    expect(heard.length).toBe(afterClose);
    expect(await checker.check('form', FORM, { name: 'Ada' })).toEqual({
      kind: 'unchecked',
      reason: 'unavailable',
    });
  });
});

describe('prepareForCheck', () => {
  it('names a prepared schema by a hash of its text, so the same schema is compiled once', () => {
    const first = prepared({ type: 'object', properties: { a: { type: 'string', pattern: 'x' } } });
    const again = prepared({ type: 'object', properties: { a: { type: 'string', pattern: 'y' } } });
    expect(first.text).toBe('{"type":"object","properties":{"a":{"type":"string"}}}');
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(again).toEqual(first);
    expect(prepared({ type: 'object' }).hash).not.toBe(first.hash);
  });

  it('gives null for a schema too deep to check', () => {
    let schema: JsonObject = { type: 'string' };
    for (let level = 0; level < 100; level += 1) schema = { not: schema };
    expect(prepareForCheck(schema)).toBeNull();
  });
});

describe('CompiledChecks', () => {
  const a = prepared({ type: 'object', properties: { a: { type: 'string' } } });
  const b = prepared({ type: 'object', properties: { b: { type: 'string' } } });
  const c = prepared({ type: 'object', properties: { c: { type: 'string' } } });

  it('compiles each schema once while it stays cached, evicting the least recently used past its count', () => {
    const cache = new CompiledChecks({ maxEntries: 2, maxChars: 1_000_000 });
    const first = cache.get(a.hash, a.text);
    expect(first).not.toBeNull();
    expect(cache.get(a.hash, a.text)).toBe(first);
    cache.get(b.hash, b.text);
    // a was used more recently than b, so c evicts b.
    cache.get(a.hash, a.text);
    cache.get(c.hash, c.text);
    expect(cache.size).toBe(2);
    expect(cache.get(a.hash, a.text)).toBe(first);
    const bAgain = cache.get(b.hash, b.text);
    expect(cache.get(b.hash, b.text)).toBe(bAgain);
  });

  it('bounds the schema text it holds as well as the count', () => {
    const cache = new CompiledChecks({ maxEntries: 100, maxChars: a.text.length + b.text.length });
    cache.get(a.hash, a.text);
    cache.get(b.hash, b.text);
    expect(cache.size).toBe(2);
    cache.get(c.hash, c.text);
    expect(cache.size).toBe(2);
  });

  it('remembers a schema it cannot compile, so it is not tried again', () => {
    const cache = new CompiledChecks({ maxEntries: 2, maxChars: 1_000_000 });
    const old = prepared({ $schema: 'http://json-schema.org/draft-04/schema#' });
    expect(cache.get(old.hash, old.text)).toBeNull();
    expect(cache.size).toBe(1);
  });
});

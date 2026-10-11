// A page call watched for a prompt on the page fails at once when the page
// asks its operator, and a call that fails on its own, such as one the relay
// refuses with a JSON-RPC error, fails once: no second rejection is left
// unhandled beside the walk's own error.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { failOnPrompt, PROMPTED } from '../src/prompt-watch.ts';

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('failOnPrompt', () => {
  const unhandled: unknown[] = [];
  const record = (reason: unknown): void => {
    unhandled.push(reason);
  };
  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', record);
  });
  afterEach(() => {
    process.off('unhandledRejection', record);
  });

  it('fails a call once, leaving no unhandled rejection, when the relay refuses it', async () => {
    const refused = Promise.reject(new Error('rate limited'));
    await expect(failOnPrompt(refused, () => Promise.resolve(false), 5)).rejects.toThrow(
      'rate limited',
    );
    await settle(30);
    expect(unhandled).toEqual([]);
  });

  it('hands back a call that settles before any prompt, and looks no more', async () => {
    let looks = 0;
    const answer = failOnPrompt(
      settle(12).then(() => 'ok'),
      () => {
        looks += 1;
        return Promise.resolve(false);
      },
      5,
    );
    await expect(answer).resolves.toBe('ok');
    const seen = looks;
    expect(seen).toBeGreaterThan(0);
    await settle(30);
    expect(looks).toBe(seen);
  });

  it('fails a call at once when the page prompts for it, or the look fails', async () => {
    const waiting = new Promise<never>(() => undefined);
    await expect(failOnPrompt(waiting, () => Promise.resolve(true), 5)).rejects.toThrow(PROMPTED);
    await expect(
      failOnPrompt(waiting, () => Promise.reject(new Error('two widgets')), 5),
    ).rejects.toThrow('two widgets');
    await settle(30);
    expect(unhandled).toEqual([]);
  });
});

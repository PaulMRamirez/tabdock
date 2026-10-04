// S3 and the dev-token plugin compare secrets in constant time. node:crypto's
// timingSafeEqual is wrapped in a spy for this file only, and each check proves
// the comparison went through it rather than through ===.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDevTokenAuth } from '../src/index.ts';
import { connectPage } from './helpers/page-client.ts';
import { ALICE, callTool, connectClient, startRelay, type TestRelay } from './helpers/relay.ts';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const spy = vi.mocked(timingSafeEqual);

describe('constant-time comparisons', () => {
  let relay: TestRelay | undefined;

  beforeEach(() => {
    spy.mockClear();
  });

  afterEach(async () => {
    await relay?.close();
    relay = undefined;
  });

  it('dev-token auth compares the presented token against every user', async () => {
    const users = ['a', 'b', 'c'].map((id) => ({
      userId: id,
      displayName: id,
      token: `${id}-token-`.padEnd(30, id),
    }));
    const auth = createDevTokenAuth(users);
    spy.mockClear();
    const request = {
      headers: { authorization: `Bearer ${users[1]?.token ?? ''}` },
    } as unknown as IncomingMessage;
    expect(await auth.authenticate(request)).toEqual({
      kind: 'user',
      user: { userId: 'b', displayName: 'b', account: { kind: 'member', email: null } },
      oauthClientId: null,
    });
    // No early exit: the match is in the middle, yet all three digests were compared.
    expect(spy).toHaveBeenCalledTimes(3);
    for (const [a, b] of spy.mock.calls) {
      expect(Buffer.isBuffer(a) && Buffer.isBuffer(b)).toBe(true);
      expect((a as Buffer).length).toBe(32);
    }
  });

  it('a matching pairing code is confirmed with timingSafeEqual on SHA-256 digests', async () => {
    relay = await startRelay();
    const page = await connectPage(relay.relay.pageUrl, { policy: { autoApprove: 'observer' } });
    const client = await connectClient(relay.relay, ALICE);
    try {
      // The page gets a fresh code once this one is used, so keep the one we send.
      const code = page.code;
      spy.mockClear();
      const paired = await callTool(client, 'pair_page', { code });
      expect(paired.isError).toBe(false);
      const codeDigest = createHash('sha256').update(code.replace('-', '')).digest();
      const codeChecks = spy.mock.calls.filter(
        ([a, b]) =>
          Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(codeDigest) && b.equals(codeDigest),
      );
      expect(codeChecks).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});

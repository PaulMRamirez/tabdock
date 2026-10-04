// ADR 0020 sets jose's key cache and cooldown explicitly, at today's
// defaults, so an upgrade of jose cannot change how long a key is trusted,
// or how often an unknown kid fetches the key set, unseen. Values equal to
// the defaults change no behaviour a test could watch, so this one checks
// that they reach jose at all: jose is wrapped here, in this file only, so
// the plugin's call to createRemoteJWKSet is recorded on its way through.

import { afterEach, expect, it, vi } from 'vitest';
import {
  createLogger,
  createOAuthAuth,
  JWKS_CACHE_MAX_AGE_MS,
  JWKS_COOLDOWN_MS,
} from '../src/index.ts';
import { JWKS_TIMEOUT_MS } from '../src/oauth.ts';
import { startProvider, type TestProvider } from './helpers/provider.ts';
import { PUBLIC_MCP_URL } from './helpers/tunnel.ts';

const seen = vi.hoisted(() => ({ calls: [] as unknown[][] }));

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    createRemoteJWKSet: (...args: Parameters<typeof actual.createRemoteJWKSet>) => {
      seen.calls.push(args);
      return actual.createRemoteJWKSet(...args);
    },
  };
});

let provider: TestProvider | undefined;

afterEach(async () => {
  await provider?.stop().catch(() => undefined);
  provider = undefined;
});

it("hands jose the key cache, cooldown and timeout ADR 0020 names, for the provider's key URL", async () => {
  provider = await startProvider();
  const auth = createOAuthAuth({
    issuer: provider.issuer,
    resource: PUBLIC_MCP_URL,
    users: [{ sub: 'sub-alice', userId: 'alice', displayName: 'Alice' }],
  });
  await auth.start?.({ log: createLogger({ sink: () => undefined }) });
  try {
    expect(seen.calls).toHaveLength(1);
    const [url, options] = seen.calls[0] ?? [];
    expect(url).toBeInstanceOf(URL);
    expect(String(url).startsWith(provider.issuer)).toBe(true);
    expect(options).toEqual({
      timeoutDuration: JWKS_TIMEOUT_MS,
      cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
      cooldownDuration: JWKS_COOLDOWN_MS,
    });
  } finally {
    auth.stop?.();
  }
});

// A class on one page (ADR 0044): the relay in public URL mode with invites
// on, against the relay tests' stand-in provider, the demo board on this
// machine, and students who join by watch invites at /i, each signing in
// from a browser played over HTTP (the relay tests' Phone) rather than a
// browser page of their own, so forty can join in seconds. The operator's
// board is the only real browser page.
//
// The page's pairing limit counts every redemption that lands on it, 30 a
// minute by default (S14), so a room joining at once waits a minute for the
// thirty-first; a relay here raises it, and the relay-wide sign-ins at /i,
// so what refuses a student in a spec is the seats and nothing else.

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startDemoServer, type DemoServer } from '@tabdock/demo/server';
import {
  createOAuthAuth,
  createRelay,
  type LogSink,
  type Relay,
  type RelayOptions,
} from '@tabdock/relay';
import { Phone } from '@tabdock/relay/test/phone';
import {
  MOCK_SUBJECT,
  PAIR_CLIENT,
  startProvider,
  type TestProvider,
} from '@tabdock/relay/test/provider';
import { PUBLIC_MCP_URL, PUBLIC_ORIGIN, tunnelFetch } from '@tabdock/relay/test/tunnel';
import { demoPageUrl } from './tabdock-harness.ts';

export const ROOM_MEMBERS = [
  { sub: MOCK_SUBJECT, userId: 'alice', displayName: 'Alice' },
  { sub: 'sub-bob-room', userId: 'bob', displayName: 'Bob' },
  { sub: 'sub-dave-room', userId: 'dave', displayName: 'Dave' },
] as const;

export interface RoomTabdock {
  relay: Relay;
  provider: TestProvider;
  demo: DemoServer;
  /** The demo board linked to this relay over loopback, with the test hook on. */
  pageUrl: string;
  close(): Promise<void>;
}

/**
 * What a student's join and a member's Claude need of a room: its relay and
 * the stand-in provider, so demo:m6's classroom, which starts its own relay,
 * can seat students the same way.
 */
export type RoomRelay = Pick<RoomTabdock, 'relay' | 'provider'>;

export async function startRoomTabdock(
  options: { limits?: RelayOptions['limits']; logSink?: LogSink } = {},
): Promise<RoomTabdock> {
  const provider = await startProvider();
  const demo = await startDemoServer({ e2eHook: true });
  let relay: Relay;
  try {
    relay = await createRelay({
      auth: createOAuthAuth({
        issuer: provider.issuer,
        resource: PUBLIC_MCP_URL,
        users: [...ROOM_MEMBERS],
      }),
      publicUrl: PUBLIC_ORIGIN,
      pairClient: PAIR_CLIENT,
      allowedOrigins: [new URL(demo.url).origin],
      invites: true,
      port: 0,
      logLevel: 'debug',
      logSink: options.logSink ?? (() => undefined),
      rateLimits: { pairAttemptsPerPage: 500, pairSignIns: 500 },
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    });
  } catch (error) {
    await demo.close();
    await provider.stop();
    throw error;
  }
  return {
    relay,
    provider,
    demo,
    pageUrl: demoPageUrl(demo, relay.pageUrl),
    async close() {
      await relay.close();
      await demo.close();
      await provider.stop();
    },
  };
}

/** Claude on a member's account: an MCP client through the stand-in tunnel. */
export async function memberClaude(room: RoomRelay, sub: string, name: string): Promise<Client> {
  const token = await room.provider.token({ sub, aud: PUBLIC_MCP_URL });
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(PUBLIC_MCP_URL), {
      authProvider: { token: () => Promise.resolve(token) },
      fetch: tunnelFetch(room.relay.url),
    }),
  );
  return client;
}

/** A student's provider subject and verified email, by number. */
export function student(index: number): { sub: string; email: string } {
  return { sub: `sub-student-${String(index)}`, email: `student${String(index)}@example.com` };
}

/** A student's browser at /i, signed in with a verified email, as /i's "Sign in" does it. */
export async function studentAtI(room: RoomRelay, index: number): Promise<Phone> {
  const { sub, email } = student(index);
  room.provider.signInSubject = sub;
  room.provider.idTokenClaims = { email, email_verified: true };
  try {
    const phone = new Phone(room.relay.url);
    const { callback } = await phone.signIn('/pair/login?to=i');
    if (callback.headers.get('location') !== '/i') throw new Error('the sign-in did not end at /i');
    return phone;
  } finally {
    room.provider.signInSubject = null;
    room.provider.idTokenClaims = null;
  }
}

/**
 * A student joins by a watch invite's secret at /i and the claim settles:
 * the operator's page honours a watch invite against its own record, with
 * no prompt. Resolves with the claim's last status, or the refusal's
 * status and error when the relay refused the claim outright.
 */
export async function joinAtI(
  room: RoomRelay,
  index: number,
  secret: string,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const phone = await studentAtI(room, index);
  const claimed = await phone.post('/i/claim', { secret });
  if (claimed.status !== 200) return claimed;
  const claim = String(claimed.data.claim);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const answer = await phone.post('/i/status', { claim });
    if (answer.data.status !== 'pending') return answer;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`student ${String(index)}'s claim never settled`);
}

// Invites need a public URL (ADR 0017), so their tests run the relay in public
// URL mode against the stand-in provider, with invites on, two members and as
// many invitees as a test signs in: each account is a subject, and Claude on
// it an MCP client through the stand-in tunnel whose every request carries a
// fresh token, so a test may step the clock past a token's life. A page mints
// with its own secrets, hashed as the adapter hashes them.

import { createHash, randomBytes } from 'node:crypto';
import {
  Client,
  type FetchLike,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { RelayFrame, Role } from '@tabdock/protocol';
import { expect } from 'vitest';
import {
  createMemoryStore,
  createOAuthAuth,
  createRelay,
  EMAIL_CLAIM,
  EMAIL_VERIFIED_CLAIM,
  type OAuthUser,
  type Relay,
  type RelayOptions,
  type RelayStore,
} from '../../src/index.ts';
import { connectPage, PAGE_ORIGIN, type PageOptions, type TestPage, TOOLS } from './page-client.ts';
import { Phone } from './phone.ts';
import { PAIR_CLIENT, startProvider, type TestProvider } from './provider.ts';
import { FAST_TIMINGS } from './relay.ts';
import { resultJson } from './results.ts';
import { PUBLIC_MCP_URL, PUBLIC_ORIGIN, tunnelFetch } from './tunnel.ts';

export const MEMBERS: OAuthUser[] = [
  { sub: 'sub-alice', userId: 'alice', displayName: 'Alice' },
  { sub: 'sub-bob', userId: 'bob', displayName: 'Bob' },
];
export const LINK_BASE = `${PUBLIC_ORIGIN}/i`;

export type InvitesFrame = Extract<RelayFrame, { t: 'invites' }>;
export type AttachRequestFrame = Extract<RelayFrame, { t: 'attach_request' }>;

export interface InviteRelay {
  relay: Relay;
  provider: TestProvider;
  store: RelayStore;
  lines: string[];
  pages: TestPage[];
  clients: Client[];
  /** Every log line, parsed. */
  events(): Record<string, unknown>[];
  page(options?: PageOptions): Promise<TestPage>;
  /**
   * Claude signed in as `sub`, with the namespaced email claims ADR 0020's
   * template adds; `wrap`, if given, wraps the tunnel's fetch, to change what
   * the client sends; `modern` pins the client to 2026-07-28, where without
   * it the SDK's default speaks a 2025 revision on a session.
   */
  claude(
    sub: string,
    email?: string | null,
    verified?: boolean,
    wrap?: (base: FetchLike) => FetchLike,
    modern?: boolean,
  ): Promise<Client>;
  close(): Promise<void>;
}

export interface InviteRelayOptions extends Partial<RelayOptions> {
  users?: OAuthUser[];
  /** Left out: the relay keeps its default, an hour. */
  metadataRefreshMs?: number;
}

/** The claims an access token carries for an email, as ADR 0020's JWT template renders them. */
export function emailClaims(email: string | null, verified = true): Record<string, unknown> {
  return email === null ? {} : { [EMAIL_CLAIM]: email, [EMAIL_VERIFIED_CLAIM]: verified };
}

export async function startInviteRelay(options: InviteRelayOptions = {}): Promise<InviteRelay> {
  const provider = await startProvider();
  const lines: string[] = [];
  const store = options.store ?? createMemoryStore();
  const { users, metadataRefreshMs, ...relayOptions } = options;
  let relay: Relay;
  try {
    relay = await createRelay({
      auth: createOAuthAuth({
        issuer: provider.issuer,
        resource: PUBLIC_MCP_URL,
        users: users ?? MEMBERS,
        ...(metadataRefreshMs === undefined ? {} : { metadataRefreshMs }),
      }),
      publicUrl: PUBLIC_ORIGIN,
      pairClient: PAIR_CLIENT,
      allowedOrigins: [PAGE_ORIGIN],
      invites: true,
      port: 0,
      logLevel: 'debug',
      logSink: (line) => {
        lines.push(line);
      },
      ...relayOptions,
      store,
      timings: { ...FAST_TIMINGS, ...options.timings },
    });
  } catch (error) {
    await provider.stop();
    throw error;
  }
  const pages: TestPage[] = [];
  const clients: Client[] = [];
  let closed = false;
  return {
    relay,
    provider,
    store,
    lines,
    pages,
    clients,
    events: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    async page(pageOptions = {}) {
      const opened = await connectPage(relay.pageUrl, {
        tools: TOOLS,
        title: 'Board',
        onInvoke: (frame) => ({ ok: true, content: JSON.stringify({ tool: frame.tool }) }),
        ...pageOptions,
      });
      pages.push(opened);
      return opened;
    },
    async claude(sub, email = null, verified = true, wrap = (base) => base, modern = false) {
      const client = new Client(
        { name: `claude-${sub}`, version: '1.0.0' },
        modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL(PUBLIC_MCP_URL), {
          authProvider: {
            token: () =>
              provider.token({ sub, aud: PUBLIC_MCP_URL, ...emailClaims(email, verified) }),
          },
          fetch: wrap(tunnelFetch(relay.url)),
        }),
      );
      clients.push(client);
      return client;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const client of clients.splice(0)) await client.close().catch(() => undefined);
      for (const opened of pages.splice(0)) opened.ws.terminate();
      await relay.close();
      await provider.stop().catch(() => undefined);
    },
  };
}

/** A fresh invite secret as the adapter draws one, and the digest the relay keeps. */
export function newSecret(): { secret: string; hash: string } {
  const secret = randomBytes(16).toString('base64url');
  return { secret, hash: createHash('sha256').update(secret, 'utf8').digest('hex') };
}

let nextInvite = 0;

export interface MintOptions {
  role?: Role;
  label?: string;
  uses?: number;
  expiresAt?: number | null;
  inviteId?: string;
}

/**
 * The newest frame of a type once the relay has handled everything the page
 * sent so far. TestPage.next() hands back the oldest unclaimed frame, and a
 * page gets roster and invites frames on every change, so a test reads what
 * holds now this way.
 */
export async function latest<T extends RelayFrame['t']>(
  page: TestPage,
  type: T,
): Promise<Extract<RelayFrame, { t: T }>> {
  await page.sync();
  const frame = page.all(type).at(-1);
  if (frame === undefined) throw new Error(`no ${type} frame yet`);
  return frame;
}

/** Mints an invite on the page and returns its secret, id and the relay's answer. */
export async function mint(
  page: TestPage,
  options: MintOptions = {},
): Promise<{ secret: string; hash: string; inviteId: string; answer: InvitesFrame }> {
  const { secret, hash } = newSecret();
  nextInvite += 1;
  const inviteId = options.inviteId ?? `inv_${String(nextInvite)}`;
  page.send({
    t: 'invite_create',
    inviteId,
    role: options.role ?? 'observer',
    label: options.label ?? 'Friends',
    uses: options.uses ?? 1,
    expiresAt: options.expiresAt === undefined ? Date.now() + 60 * 60_000 : options.expiresAt,
    secretHash: hash,
  });
  // The relay answers an invite_create at once, so its answer is the newest frame.
  const answer = await latest(page, 'invites');
  return { secret, hash, inviteId, answer };
}

/** Mints and fails the test unless the relay listed the invite. */
export async function mintOk(
  page: TestPage,
  options: MintOptions = {},
): Promise<{ secret: string; hash: string; inviteId: string; link: string; answer: InvitesFrame }> {
  const minted = await mint(page, options);
  expect(minted.answer.refused, JSON.stringify(minted.answer.refused)).toBeUndefined();
  expect(minted.answer.invites.map((invite) => invite.inviteId)).toContain(minted.inviteId);
  return { ...minted, link: `${LINK_BASE}#${minted.secret}` };
}

export interface ToolText {
  isError: boolean;
  text: string;
  structured: unknown;
}

export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolText> {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  return {
    isError: result.isError === true,
    text,
    structured: resultJson(text, result.structuredContent),
  };
}

/** A member pairs by code and the page approves with `role`. */
export async function attachMember(
  client: Client,
  page: TestPage,
  role: Role = 'driver',
): Promise<void> {
  const pending = call(client, 'pair_page', { code: page.code });
  const request = await page.next('attach_request');
  page.send({ t: 'attach_decision', requestId: request.requestId, allow: true, role });
  const outcome = await pending;
  expect(outcome.isError, outcome.text).toBe(false);
}

/**
 * A browser signed in through /i's link as `sub`, its ID token carrying the
 * email claims of scope `openid email` when an email is given.
 */
export async function signedInAtI(
  relay: InviteRelay,
  sub: string,
  email: string | null,
  verified = true,
): Promise<Phone> {
  relay.provider.signInSubject = sub;
  relay.provider.idTokenClaims = email === null ? null : { email, email_verified: verified };
  try {
    const phone = new Phone(relay.relay.url);
    const { callback } = await phone.signIn('/pair/login?to=i');
    expect(callback.headers.get('location')).toBe('/i');
    return phone;
  } finally {
    relay.provider.signInSubject = null;
    relay.provider.idTokenClaims = null;
  }
}

/** Polls /i/status until the claim settles. */
export async function settledAtI(phone: Phone, claim: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100; i += 1) {
    const answer = await phone.post('/i/status', { claim });
    if (answer.data.status !== 'pending') return answer.data;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the claim never settled');
}

/**
 * Joins at /i with a signed-in browser, has the page answer, and waits for
 * the claim to settle; any invite, multi-use ones included, since an /i link
 * never leaves the browser's fragment.
 */
export async function joinAtI(
  phone: Phone,
  page: TestPage,
  secret: string,
  answer: { allow: boolean; role?: Role } = { allow: true },
): Promise<{ request: AttachRequestFrame; settled: Record<string, unknown> }> {
  const claimed = await phone.post('/i/claim', { secret });
  expect(claimed.status, JSON.stringify(claimed.data)).toBe(200);
  const request = await page.next('attach_request');
  page.send({
    t: 'attach_decision',
    requestId: request.requestId,
    allow: answer.allow,
    ...(answer.role === undefined ? {} : { role: answer.role }),
  });
  return { request, settled: await settledAtI(phone, String(claimed.data.claim)) };
}

/** Redeems through pair_page and has the page answer; resolves with the tool's answer and the request. */
export async function redeem(
  client: Client,
  page: TestPage,
  link: string,
  answer: { allow: boolean; role?: Role } | null = { allow: true },
): Promise<{ outcome: ToolText; request: AttachRequestFrame }> {
  const pending = call(client, 'pair_page', { invite: link });
  const request = await page.next('attach_request');
  if (answer !== null) {
    page.send({
      t: 'attach_decision',
      requestId: request.requestId,
      allow: answer.allow,
      ...(answer.role === undefined ? {} : { role: answer.role }),
    });
  }
  return { outcome: await pending, request };
}

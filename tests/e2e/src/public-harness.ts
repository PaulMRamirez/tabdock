// Tabdock in public URL mode in a real browser, for the QR flow at /pair and,
// with invites on, the invite page at /i: the relay with the oauth plugin
// against the relay tests' stand-in provider (oauth2-mock-server), the demo
// page on this machine, and a stand-in tunnel for a phone's browser context.
// Any account the provider signs in that is not on the users list is an
// invitee when invites are on (ADR 0017), as a stranger who signs up is.
//
// The tunnel is Playwright request routing: requests for https://relay.test
// go to the loopback relay with the public Host, as ngrok forwards them, so
// the browser sees a real https origin (a secure context that keeps __Host-
// cookies) and nothing needs a certificate or an http allowance in the relay.
// Playwright never routes a request that a redirect produced, though: it
// sends those straight to the network. So the stand-in turns each redirect,
// the relay's 303s and the provider's 302, into a page that navigates on at
// once. Every hop is then a fresh top-level navigation the route sees, and
// the browser still applies its own rules to each: its cookie jar, SameSite
// on the way back from the provider, and Origin on the page's own requests.

import { request as httpRequest } from 'node:http';
import type { BrowserContext, Route } from '@playwright/test';
import { startDemoServer, type DemoServer } from '@tabdock/demo/server';
import { createOAuthAuth, createRelay, type LogSink, type Relay } from '@tabdock/relay';
import {
  MOCK_SUBJECT,
  PAIR_CLIENT,
  startProvider,
  type TestProvider,
} from '@tabdock/relay/test/provider';
import { PUBLIC_MCP_URL, PUBLIC_ORIGIN } from '@tabdock/relay/test/tunnel';
import { demoPageUrl } from './tabdock-harness.ts';

export { MOCK_SUBJECT, PUBLIC_MCP_URL, PUBLIC_ORIGIN };

export interface PublicTabdock {
  relay: Relay;
  provider: TestProvider;
  demo: DemoServer;
  /** The demo page linked to this relay over loopback, with the test hook on. */
  pageUrl: string;
  close(): Promise<void>;
}

export interface PublicTabdockOptions {
  logSink?: LogSink;
  /** The M3 spike's measurements (TABDOCK_SPIKE), for the scan-to-first-call milestones. */
  spike?: boolean;
  /** More accounts the provider may sign in, beside Alice. */
  users?: { sub: string; userId: string; displayName: string }[];
  /** TABDOCK_INVITES: accounts off the list become invitees, and pages mint invites (ADR 0017). */
  invites?: boolean;
  /** TABDOCK_AUDIT_DIR, an absolute path: the persistent audit log instead of the memory ring (ADR 0019). */
  auditDir?: string;
}

/** The mock provider signs in MOCK_SUBJECT, who is Alice here. */
export async function startPublicTabdock(
  options: PublicTabdockOptions = {},
): Promise<PublicTabdock> {
  const provider = await startProvider();
  const demo = await startDemoServer({ e2eHook: true });
  let relay: Relay;
  try {
    relay = await createRelay({
      auth: createOAuthAuth({
        issuer: provider.issuer,
        resource: PUBLIC_MCP_URL,
        users: [
          { sub: MOCK_SUBJECT, userId: 'alice', displayName: 'Alice' },
          ...(options.users ?? []),
        ],
      }),
      publicUrl: PUBLIC_ORIGIN,
      pairClient: PAIR_CLIENT,
      allowedOrigins: [new URL(demo.url).origin],
      port: 0,
      logLevel: 'debug',
      logSink: options.logSink ?? (() => undefined),
      spike: options.spike === true,
      invites: options.invites === true,
      ...(options.auditDir === undefined ? {} : { audit: { dir: options.auditDir } }),
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

/** A page that goes on to `target` at once, standing in for a redirect Playwright would not route. */
function navigateOn(target: string): string {
  const attribute = target
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return `<!doctype html><meta http-equiv="refresh" content="0;url=${attribute}"><title>Redirecting</title>`;
}

/** Response headers as route.fulfill takes them: several Set-Cookie lines joined by newlines. */
function flatHeaders(raw: NodeJS.Dict<string | string[]>): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    flat[name] = Array.isArray(value) ? value.join(name === 'set-cookie' ? '\n' : ', ') : value;
  }
  return flat;
}

interface Forwarded {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function forward(relayUrl: string, route: Route): Promise<Forwarded> {
  const request = route.request();
  const url = new URL(request.url());
  // The browser's own headers, its Cookie and Origin among them, with the public Host.
  const headers: Record<string, string> = { ...request.headers(), host: url.host };
  delete headers['content-length'];
  const body = request.postDataBuffer();
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      new URL(`${url.pathname}${url.search}`, relayUrl),
      { method: request.method(), headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 502,
            headers: flatHeaders(response.headers),
            body: Buffer.concat(chunks),
          });
        });
        response.on('error', reject);
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body ?? undefined);
  });
}

async function answer(route: Route, forwarded: Forwarded, base: string): Promise<void> {
  const location = forwarded.headers.location;
  if (forwarded.status >= 300 && forwarded.status < 400 && location !== undefined) {
    const rest = Object.fromEntries(
      Object.entries(forwarded.headers).filter(([name]) => name !== 'location'),
    );
    await route.fulfill({
      status: 200,
      headers: { ...rest, 'content-type': 'text/html; charset=utf-8' },
      body: navigateOn(new URL(location, base).href),
    });
    return;
  }
  await route.fulfill({
    status: forwarded.status,
    headers: forwarded.headers,
    body: forwarded.body,
  });
}

/**
 * Puts the stand-in tunnel in front of a browser context: https://relay.test
 * reaches the relay, and the provider's sign-in page answers through the same
 * redirect stand-in. Every URL the context asked for is pushed to `requested`.
 */
export async function playTunnel(
  context: BrowserContext,
  tabdock: PublicTabdock,
  requested: string[],
): Promise<void> {
  await context.route(`${PUBLIC_ORIGIN}/**`, async (route) => {
    requested.push(route.request().url());
    await answer(route, await forward(tabdock.relay.url, route), route.request().url());
  });
  await context.route(`${tabdock.provider.issuer}/authorize**`, async (route) => {
    requested.push(route.request().url());
    await answer(route, await forward(tabdock.provider.issuer, route), route.request().url());
  });
}

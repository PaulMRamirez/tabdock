// The map demo (ADR 0050) as the Pages site serves it, beside a real relay:
// its static build from buildMapDemo, put at /map/ of a loopback static host
// that sends no header of ours, so the page runs under its own meta policy
// alone, as a visitor's browser runs it; a relay on a free port with
// throwaway dev tokens whose allowlist names that host's origin, as a
// visitor's TABDOCK_ALLOWED_ORIGINS would; and a scripted stand-in relay for
// specs that only count dials. The page has no test hook in any build, so a
// spec links it as a person does: a trusted click on its Connect bar once
// the bar has armed, then Allow in the widget (src/map-harness.ts).

import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import type { BrowserContext, Page, WebSocketRoute } from '@playwright/test';
import { buildMapDemo } from '@tabdock/map-demo/server';
import {
  ATTACH_REQUEST_TTL_MS,
  encodeFrame,
  MAX_DESCRIPTION_CHARS,
  MAX_FRAME_BYTES,
  MAX_RESULT_CHARS,
  MAX_STATE_BYTES,
  parsePageFrame,
  PING_INTERVAL_MS,
  RESUME_WINDOW_MS,
} from '@tabdock/protocol';
import {
  createDevTokenAuth,
  createRelay,
  type DevTokenUser,
  type LogSink,
  type Relay,
} from '@tabdock/relay';
import { throwawayUser } from './tabdock-harness.ts';

/** Where the site holds the map demo, as apps/site's build puts it. */
export const MAP_DEMO_PATH = '/map/';

export interface MapDemoSite {
  /** The page as a visitor opens it, at /map/ of the static host. */
  url: string;
  /** The static host's origin, the one a visitor's relay must admit. */
  origin: string;
  /** The temporary directory the site is built into, which close() removes; a run ended by a signal removes it itself. */
  root: string;
  close(): Promise<void>;
}

/** Each file's type by its extension, as Pages chooses it. */
const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/**
 * Builds the map demo into a temporary site's map/ directory and serves that
 * site on 127.0.0.1 as a static host would: GET and HEAD only, a directory by
 * its index.html, a directory named without its slash redirected to it, and
 * no Content-Security-Policy or any other header but the type, so the page's
 * meta policy is the only one in force. `media: false` builds it without
 * the recording, as pnpm record:map-demo films it.
 */
export async function serveMapDemoSite(options: { media?: boolean } = {}): Promise<MapDemoSite> {
  const root = mkdtempSync(join(tmpdir(), 'tabdock-map-demo-site-'));
  try {
    await buildMapDemo({
      outDir: join(root, MAP_DEMO_PATH.slice(1, -1)),
      ...(options.media === false ? { media: false } : {}),
    });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  const send = (
    response: ServerResponse,
    status: number,
    type: string,
    body: string | Uint8Array,
    headers: Record<string, string> = {},
  ): void => {
    response.writeHead(status, { 'Content-Type': type, ...headers });
    response.end(response.req.method === 'HEAD' ? undefined : body);
  };

  const answer = async (response: ServerResponse): Promise<void> => {
    const request = response.req;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, 'text/plain; charset=utf-8', 'Method not allowed');
      return;
    }
    const raw = request.url ?? '/';
    const path =
      raw.startsWith('/') && !raw.startsWith('//')
        ? URL.parse(raw, 'http://site.invalid')?.pathname
        : undefined;
    const file = path === undefined ? null : normalize(join(root, path));
    if (path === undefined || file === null || (file !== root && !file.startsWith(root + sep))) {
      send(response, 404, 'text/plain; charset=utf-8', 'Not found');
      return;
    }
    const info = await stat(file).catch(() => null);
    let target = file;
    if (info?.isDirectory()) {
      if (!path.endsWith('/')) {
        send(response, 301, 'text/plain; charset=utf-8', 'Moved', { Location: `${path}/` });
        return;
      }
      target = join(file, 'index.html');
    }
    const body = await readFile(target).catch(() => null);
    if (body === null) {
      send(response, 404, 'text/plain; charset=utf-8', 'Not found');
      return;
    }
    send(response, 200, TYPES[extname(target)] ?? 'application/octet-stream', body);
  };

  const server = createServer((_request, response) => {
    answer(response).catch(() => {
      if (!response.headersSent) send(response, 500, 'text/plain; charset=utf-8', 'Error');
    });
  });
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', resolveListen);
    });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address to serve on');
  const origin = `http://127.0.0.1:${String(address.port)}`;
  return {
    url: `${origin}${MAP_DEMO_PATH}`,
    origin,
    root,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => {
        server.close(() => {
          resolveClose();
        });
      });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface MapDemoRelay {
  relay: Relay;
  users: { alice: DevTokenUser; bob: DevTokenUser };
  close(): Promise<void>;
}

/** A relay that admits page sockets from `origin` alone, as a visitor sets TABDOCK_ALLOWED_ORIGINS. */
export async function startMapDemoRelay(
  origin: string,
  options: { logSink?: LogSink } = {},
): Promise<MapDemoRelay> {
  const users = { alice: throwawayUser('alice', 'Alice'), bob: throwawayUser('bob', 'Bob') };
  const relay = await createRelay({
    auth: createDevTokenAuth([users.alice, users.bob]),
    port: 0,
    allowedOrigins: [origin],
    allowMissingOrigin: false,
    logSink: options.logSink ?? (() => undefined),
  });
  return { relay, users, close: () => relay.close() };
}

/** The map demo at `siteUrl` with ?relay naming `relayPageUrl`, as a shared link would. */
export function mapDemoUrl(siteUrl: string, relayPageUrl: string): string {
  const url = new URL(siteUrl);
  url.searchParams.set('relay', relayPageUrl);
  return url.href;
}

/** Opens the map demo and waits until its tools are registered. */
export async function openMapDemo(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForSelector('html[data-tools="ready"]');
}

/**
 * A person's click on the Connect bar: the button takes a click only once it
 * has held still for half a second in a visible, focused tab (ADR 0029's
 * notes), so this waits for it to arm and then clicks it with trusted input.
 */
export async function clickConnect(page: Page): Promise<void> {
  const armed = '[data-role="connect-bar"] [data-action="connect"][data-armed="true"]';
  await page.waitForSelector(armed);
  await page.locator(armed).click();
}

/** The pairing code the scripted relay shows in the widget. */
export const STAND_IN_CODE = 'ABCDE-FGHJK';

export interface Dialled {
  urls: string[];
}

/**
 * Answers every page socket in the context as a relay would, welcoming each
 * hello with a pairing code and room for page state, and counts the dials.
 * Nothing it answers leaves the machine.
 */
export async function standInRelays(context: BrowserContext): Promise<Dialled> {
  const dialled: Dialled = { urls: [] };
  await context.routeWebSocket(/\/page$/, (ws: WebSocketRoute) => {
    dialled.urls.push(ws.url());
    ws.onMessage((message) => {
      const parsed = parsePageFrame(typeof message === 'string' ? message : message.toString());
      if (parsed.kind !== 'ok' || parsed.frame.t !== 'hello') return;
      ws.send(
        encodeFrame({
          t: 'welcome',
          pageId: 'page-1',
          resumeToken: 'resume-1',
          resumed: false,
          pairing: {
            code: STAND_IN_CODE,
            // Shaped like the relay's, so the widget draws its QR code.
            url: 'https://relay.example/pair#AAAAAAAAAAAAAAAAAAAAAA',
            expiresAt: Date.now() + 120_000,
          },
          roster: [],
          limits: {
            maxFrameBytes: MAX_FRAME_BYTES,
            maxResultChars: MAX_RESULT_CHARS,
            maxDescriptionChars: MAX_DESCRIPTION_CHARS,
            pingIntervalMs: PING_INTERVAL_MS,
            // This relay never pings, so keep the page's silence watchdog out of the way.
            idleTimeoutMs: 600_000,
            resumeWindowMs: RESUME_WINDOW_MS,
            attachRequestTtlMs: ATTACH_REQUEST_TTL_MS,
            maxStateBytes: MAX_STATE_BYTES,
          },
        }),
      );
    });
  });
  return dialled;
}

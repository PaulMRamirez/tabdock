// The canvas map page in a real browser beside a real relay (ADR 0038): the
// relay on a free port with throwaway dev tokens, the map page served from
// memory, and the steps an operator takes. The page offers no handle and no
// URL hook, so a spec connects it through the page's own connect hook and
// pairs it by reading the code and clicking Allow in the widget, as a person
// would. Codes are masked in anything printed (S11).

import type { Client } from '@modelcontextprotocol/client';
import type { Page } from '@playwright/test';
import { type MapPageServer, startMapPageServer } from '@tabdock/map-page/server';
import type { PolicyInput } from '@tabdock/protocol';
import {
  createDevTokenAuth,
  createRelay,
  type DevTokenUser,
  type LogSink,
  type Relay,
} from '@tabdock/relay';
import {
  callTool,
  clickInWidget,
  throwawayUser,
  type ToolOutcome,
  widgetText,
} from './tabdock-harness.ts';

export interface MapTabdock {
  relay: Relay;
  map: MapPageServer;
  users: { alice: DevTokenUser; bob: DevTokenUser };
  close(): Promise<void>;
}

export async function startMapTabdock(options: { logSink?: LogSink } = {}): Promise<MapTabdock> {
  const users = { alice: throwawayUser('alice', 'Alice'), bob: throwawayUser('bob', 'Bob') };
  const map = await startMapPageServer();
  let relay: Relay;
  try {
    relay = await createRelay({
      auth: createDevTokenAuth([users.alice, users.bob]),
      port: 0,
      // A real browser always sends Origin; the dev default allows 127.0.0.1 at any port.
      allowMissingOrigin: false,
      logSink: options.logSink ?? (() => undefined),
    });
  } catch (error) {
    await map.close();
    throw error;
  }
  return {
    relay,
    map,
    users,
    async close() {
      await relay.close();
      await map.close();
    },
  };
}

/** Opens the map page and waits until its sixteen tools are registered. */
export async function openMapPage(page: Page, mapUrl: string): Promise<void> {
  await page.goto(mapUrl);
  await page.waitForSelector('html[data-tools="ready"]');
}

/**
 * Links the open map page to a relay through its own connect hook, the one
 * way besides a person's click; the policy raises the page's defaults for a
 * test that needs it. Returns what the hook answered.
 */
export async function connectMapPage(
  page: Page,
  relayPageUrl: string,
  policy?: PolicyInput,
): Promise<boolean> {
  return page.evaluate(
    ([relay, given]) => {
      const hook = (
        window as unknown as {
          __tabdockMapPage?: { connect(relayUrl: string, policy?: unknown): boolean };
        }
      ).__tabdockMapPage;
      if (!hook) throw new Error('the map page has no connect hook');
      return given === null ? hook.connect(relay) : hook.connect(relay, given);
    },
    [relayPageUrl, policy ?? null] as const,
  );
}

/** The pairing code the widget shows, read through the DevTools protocol as an operator reads it. */
export async function mapPairingCode(page: Page, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const code = (await widgetText(page, 'pairing-code')) ?? '';
    if (/^[A-Z0-9]+-[A-Z0-9]+$/.test(code)) return code;
    if (Date.now() > deadline) throw new Error('the widget showed no pairing code');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * pair_page with the code the widget shows, then a real click on Allow as
 * driver (or as observer) in the widget. Returns the page id.
 */
export async function pairMapPage(
  page: Page,
  client: Client,
  role: 'driver' | 'observer' = 'driver',
): Promise<string> {
  const code = await mapPairingCode(page);
  const pending = callTool(client, 'pair_page', { code });
  await clickInWidget(page, { action: role === 'driver' ? 'approve-driver' : 'approve-observer' });
  const paired = await pending;
  if (paired.isError) throw new Error(`pair_page failed: ${paired.text.split('\n', 1)[0] ?? ''}`);
  return (paired.structured as { page: string }).page;
}

/** One map tool's result through call_page_tool. */
export function callMapTool(
  client: Client,
  pageId: string,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome> {
  return callTool(client, 'call_page_tool', { page: pageId, tool, arguments: args });
}

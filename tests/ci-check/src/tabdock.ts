// The check's fixture (ADR 0041): a page under test linked to a local mode
// relay, and an MCP client paired with it as driver, the way an operator
// pairs one. The relay keeps its owner token in TABDOCK_HOME, which a CI job
// sets to a fresh directory under the runner's temporary directory and
// deletes afterwards; the token is read from that file into this process
// only, sent in one Authorization header, and never printed or passed to a
// command. The pairing code is read from the widget through the DevTools
// protocol, used once, and never printed, and Allow as driver is a trusted
// click that waits out the widget's arming, as a person's would (S3, S4,
// S11).
//
// connectPage() is the one place a copier changes: it is how this page links
// to a relay. The map page links when its own script calls its connect hook,
// and never from its URL (ADR 0038), so a link cannot make it dial.

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { type CDPSession, type Page, test as base } from '@playwright/test';
import { allowAttach, readPairingCode, waitingPrompts } from '@tabdock/adapter/testing';
import { z } from 'zod';
import type { ResultLike } from './labelled.ts';
import { createPacer, PAGE_CALLS_PER_MINUTE, REQUESTS_PER_MINUTE } from './pacer.ts';
import type { Caller } from './walk.ts';

/** What the check's client calls itself: the widget's prompt and the audit log both name it. */
export const CLIENT_NAME = 'tabdock-ci-check';

/**
 * Links the page to the relay. Replace this for your own page: whatever
 * your page offers its own script for linking, called here through
 * page.evaluate. Never give a page a way to link from its URL.
 */
export async function connectPage(page: Page, relayPageUrl: string): Promise<void> {
  const linked = await page.evaluate((relay) => {
    const hook = (window as { __tabdockMapPage?: { connect(relayUrl: string): boolean } })
      .__tabdockMapPage;
    return hook?.connect(relay) ?? false;
  }, relayPageUrl);
  if (!linked) throw new Error('the page did not link to the relay');
}

/** The settings the check runs with, each checked before anything starts. */
export interface CheckSettings {
  readonly home: string;
  readonly port: number;
  readonly pageUrl: string;
}

/**
 * TABDOCK_HOME, TABDOCK_PORT and CI_CHECK_PAGE_URL, refused in words that
 * name the setting and never its value.
 */
export function checkSettings(env: Readonly<Record<string, string | undefined>>): CheckSettings {
  const home = env.TABDOCK_HOME ?? '';
  if (home === '' || !isAbsolute(home)) {
    throw new Error(
      'set TABDOCK_HOME to a fresh absolute directory outside every repository, such as $RUNNER_TEMP/tabdock-ci-check (ADR 0041)',
    );
  }
  const portText = env.TABDOCK_PORT ?? '8787';
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
  if (!(port >= 1 && port <= 65535)) throw new Error('TABDOCK_PORT must be a port from 1 to 65535');
  const pageUrl = URL.parse(env.CI_CHECK_PAGE_URL ?? '');
  // The page must be on loopback, which local mode's origin rule admits as it stands (S2).
  if (
    pageUrl === null ||
    pageUrl.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(pageUrl.hostname)
  ) {
    throw new Error(
      'set CI_CHECK_PAGE_URL to the page under test at http://127.0.0.1 or http://localhost',
    );
  }
  return { home, port, pageUrl: pageUrl.href };
}

/** pair_page's structured answer: it holds no page text, so the relay sends it structured. */
const PairedSchema = z.object({ page: z.string().min(1), role: z.enum(['driver', 'observer']) });

/** How long a write may wait before the check looks for a prompt it would otherwise wait out. */
const PROMPT_CHECK_MS = 1_000;

export interface Tabdock {
  readonly client: Client;
  readonly pageId: string;
  readonly page: Page;
  readonly cdp: CDPSession;
  /** Paced relay calls for the walk, each write watched for a prompt on the page. */
  readonly caller: Caller;
  /** call_page_tool requests made so far: the audit log's call records must number the same. */
  pageCalls(): number;
}

export const test = base.extend<object, { tabdock: Tabdock }>({
  tabdock: [
    async ({ browser }, use) => {
      const settings = checkSettings(process.env);
      // Read once into this process, trimmed, as local mode writes it.
      const token = readFileSync(join(settings.home, 'owner-token'), 'latin1').trim();
      const relayPageUrl = `ws://127.0.0.1:${String(settings.port)}/page`;
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await page.goto(settings.pageUrl);
      await connectPage(page, relayPageUrl);
      const code = await readPairingCode(cdp);

      const client = new Client({ name: CLIENT_NAME, version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${String(settings.port)}/mcp`),
          {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
          },
        ),
      );
      const pairing = client.callTool({ name: 'pair_page', arguments: { code } });
      await allowAttach(cdp, { as: 'driver', client: CLIENT_NAME });
      const paired = await pairing;
      if (paired.isError === true) throw new Error('pair_page was refused');
      const { page: pageId, role } = PairedSchema.parse(paired.structuredContent);
      if (role !== 'driver')
        throw new Error('the page attached this client as observer, not driver');

      const requests = createPacer({ perMinute: REQUESTS_PER_MINUTE });
      const calls = createPacer({ perMinute: PAGE_CALLS_PER_MINUTE });
      let pageCalls = 0;
      const caller: Caller = async (tool, args) => {
        await requests.take();
        if (tool === 'call_page_tool') {
          await calls.take();
          pageCalls += 1;
        }
        const pending = client.callTool({ name: tool, arguments: args }) as Promise<ResultLike>;
        if (tool !== 'call_page_tool') return pending;
        // A write the page asks its operator about would wait out its deadline; fail at once instead.
        let settled = false;
        void pending.finally(() => {
          settled = true;
        });
        const watch = new Promise<never>((_resolve, reject) => {
          const look = async (): Promise<void> => {
            if (settled) return;
            if ((await waitingPrompts(cdp)).confirm.length > 0) {
              reject(
                new Error(
                  'the page prompts for a write; set consequential or consequentialTools (ADR 0034)',
                ),
              );
              return;
            }
            setTimeout(next, PROMPT_CHECK_MS);
          };
          // A look that fails, such as one that finds two widgets, fails the call it watched.
          const next = (): void => {
            look().catch(reject);
          };
          setTimeout(next, PROMPT_CHECK_MS);
        });
        return Promise.race([pending, watch]);
      };

      await use({ client, pageId, page, cdp, caller, pageCalls: () => pageCalls });

      await client
        .callTool({ name: 'detach_page', arguments: { page: pageId } })
        .catch(() => undefined);
      await client.close();
      await context.close();
    },
    { scope: 'worker' },
  ],
});

export { expect } from '@playwright/test';

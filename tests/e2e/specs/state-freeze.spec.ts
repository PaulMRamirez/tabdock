// A frozen tab and the clients following it (ADR 0040, A6.7): the demo
// board publishes its view, a client waits on it, and the tab is frozen as
// Chrome freezes a background tab, over raw CDP (src/spike/cdp.ts), since
// Playwright's own page never freezes. With the relay's idle timeout cut to
// 2.5 s the pending wait answers page_asleep once the relay stops hearing
// the page, and any wait meanwhile at once; after the thaw the page resumes
// and its state comes back at a higher version, the board's view again,
// never the null the sleep left, since the adapter sends state before its
// tools and the relay serves reads only after them. Whether Chrome's own
// Energy Saver freezes a tab that holds the adapter's Web Lock is the
// owner's run (docs/checklists/M6.md), which no headless browser can show.

import { expect, test } from '@playwright/test';
import type { DockState } from '@tabdock/adapter';
import { CdpPage, launchChrome } from '../src/spike/cdp.ts';
import { readPageState, stateBody, waitPageState } from '../src/state-helpers.ts';
import { callTool, connectMcp, startTabdock } from '../src/tabdock-harness.ts';

const IDLE_TIMEOUT_MS = 2500;

async function dock(page: CdpPage): Promise<DockState | null> {
  return (await page.evaluate('window.__tabdockDock?.state ?? null')) as DockState | null;
}

async function until<T>(
  pick: () => Promise<T | null | undefined | false>,
  what: string,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const picked = await pick().catch(() => null);
    if (picked !== null && picked !== undefined && picked !== false) return picked;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${String(timeoutMs)} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('a frozen tab answers waits page_asleep, and its state returns at a higher version after the thaw', async () => {
  test.setTimeout(120_000);
  const tabdock = await startTabdock({
    timings: { pingIntervalMs: 1000, idleTimeoutMs: IDLE_TIMEOUT_MS },
  });
  const chrome = await launchChrome().catch(async (error: unknown) => {
    await tabdock.close();
    throw error;
  });
  const page = await CdpPage.open(chrome, tabdock.pageUrl);
  const client = await connectMcp(tabdock.relay, tabdock.users.alice, 'tabdock-state-freeze');
  try {
    const linked = await until(
      async () => {
        const state = await dock(page);
        return state?.link === 'linked' && state.pairing !== null && state.pageId !== null
          ? { code: state.pairing.code, pageId: state.pageId }
          : null;
      },
      'the board to link',
      30_000,
    );
    const pairing = callTool(client, 'pair_page', { code: linked.code });
    const requestId = await until(
      async () => (await dock(page))?.pendingRequests[0]?.requestId,
      'the attach request',
      10_000,
    );
    await page.evaluate(`window.__tabdockDock.approve(${JSON.stringify(requestId)}, 'driver')`);
    expect((await pairing).isError).toBe(false);
    const pageId = linked.pageId;

    // The board published its view as it linked.
    const before = stateBody(await waitPageState(client, pageId, 0, 10_000));
    expect(before.version).toBeGreaterThan(0);
    expect(before.value).toMatchObject({ view: { x: 0, y: 0, zoom: 1 }, itemCount: 3 });

    // A client follows the board, and the tab freezes under it.
    const waiting = waitPageState(client, pageId, before.version, 30_000);
    const frozeAt = Date.now();
    await page.freeze();
    const asleep = await waiting;
    const answeredMs = Date.now() - frozeAt;
    expect(asleep.ok).toBe(false);
    expect(asleep.ok ? null : asleep.code).toBe('page_asleep');
    // Once the relay stopped hearing the page, not at the wait's own 30 s.
    expect(answeredMs).toBeLessThan(IDLE_TIMEOUT_MS + 5000);
    // A wait while it sleeps answers at once.
    const asleepAgain = await waitPageState(client, pageId, before.version, 30_000);
    expect(asleepAgain.ok ? null : asleepAgain.code).toBe('page_asleep');

    await page.resume();
    // The page finds its socket failed, resumes its session, and publishes again before its tools.
    const back = await until(
      async () => {
        const read = await readPageState(client, pageId);
        return read.ok ? read.body : null;
      },
      'the page to come back',
      90_000,
    );
    expect(back.page).toBe(pageId);
    expect(back.version).toBeGreaterThan(before.version);
    expect(back.value).toEqual(before.value);
    const visibility: unknown = await page.evaluate('document.visibilityState');
    expect(visibility).toBe('hidden');
  } finally {
    page.close();
    await client.close().catch(() => undefined);
    await chrome.close();
    await tabdock.close();
  }
});

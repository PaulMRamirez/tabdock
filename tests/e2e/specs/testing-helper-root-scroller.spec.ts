import { expect, type Page, test } from '@playwright/test';
import {
  allowAttach,
  clickInWidget,
  waitingPrompts,
  widgetButton,
  WidgetTestError,
} from '@tabdock/adapter/testing';
import { startDemoServer, type DemoServer } from '@tabdock/demo/server';
import {
  callTool,
  connectMcp,
  startTabdock,
  type Tabdock,
  waitForDock,
  waitForLink,
} from '../src/tabdock-harness.ts';

// Chrome on Android makes a scrolling element that fills the viewport the
// page's scroller in the document's place (its implicit root scroller, on by
// default there). DevTools then counts that element's scroll in the visual
// viewport's pageY while its hit test does not, so ADR 0041's helper could
// check a spot beside its press and miss an element there that lets clicks
// through to Allow. Desktop Chromium keeps the feature off; this file turns
// it on, as a phone has it, and the helper must refuse rather than press.

const CI = 'tabdock-ci-check';
const executablePath = process.env.CHROMIUM_EXECUTABLE;

test.use({
  launchOptions: {
    args: ['--enable-features=WebMCPTesting', '--enable-blink-features=ImplicitRootScroller'],
    ...(executablePath === undefined ? {} : { executablePath }),
  },
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

let demo: DemoServer;
let tabdock: Tabdock;

test.beforeAll(async () => {
  demo = await startDemoServer({ e2eHook: true });
});
test.afterAll(async () => {
  await demo.close();
});
test.beforeEach(async () => {
  tabdock = await startTabdock({ demo });
});
test.afterEach(async () => {
  await tabdock.close();
});

/** Puts the board under one element that fills the viewport and scrolls, down or across, in the document's place. */
async function scrollerBoard(page: Page, axis: 'down' | 'across'): Promise<void> {
  await page.evaluate((across) => {
    const { documentElement: html, body } = document;
    Object.assign(html.style, { height: '100%', overflow: 'hidden' });
    Object.assign(body.style, { height: '100%', overflow: 'hidden', margin: '0' });
    const scroller = document.createElement('div');
    scroller.id = 'scroller';
    Object.assign(scroller.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '100%',
      height: '100%',
      overflow: 'auto',
    });
    const wide = document.createElement('div');
    Object.assign(wide.style, across ? { width: '4000px', height: '100%' } : { height: '4000px' });
    scroller.append(wide);
    body.append(scroller);
  }, axis === 'across');
}

async function scrollTo(page: Page, axis: 'down' | 'across', by: number): Promise<void> {
  await page.evaluate(
    ([across, px]) => {
      const scroller = document.getElementById('scroller');
      if (scroller === null) throw new Error('no scroller');
      if (across) scroller.scrollLeft = px;
      else scroller.scrollTop = px;
    },
    [axis === 'across', by] as const,
  );
}

for (const axis of ['down', 'across'] as const) {
  test(`refuses to press where an element scrolls ${axis} in the document’s place, and presses once it is back at its start`, async ({
    page,
  }) => {
    await page.goto(tabdock.pageUrl);
    await page.waitForSelector('html[data-tools="ready"]');
    const { code } = await waitForLink(page);
    const cdp = await page.context().newCDPSession(page);
    await scrollerBoard(page, axis);
    const client = await connectMcp(tabdock.relay, tabdock.users.alice, CI);
    try {
      const pending = callTool(client, 'pair_page', { code });
      const requestId = await waitForDock(page, (s) => s.pendingRequests[0]?.requestId);
      const target = { action: 'approve-driver', requestId } as const;
      // At its start the element and the document agree, so the helper finds Allow.
      const at = await widgetButton(cdp, target);

      // Scrolled a few pixels, DevTools counts the element's scroll as the
      // document's: the case this file exists for, or it proves nothing.
      await scrollTo(page, axis, 6);
      await expect
        .poll(async () => {
          const { cssVisualViewport: view, cssLayoutViewport: layout } =
            await cdp.send('Page.getLayoutMetrics');
          return axis === 'down' ? [view.pageY, layout.pageY] : [view.pageX, layout.pageX];
        })
        .toEqual([6, 0]);

      // An element over the centre of Allow that lets clicks through to it.
      await page.evaluate(({ x, y }) => {
        const over = document.createElement('div');
        over.id = 'cover';
        Object.assign(over.style, {
          position: 'fixed',
          left: `${String(x - 2)}px`,
          top: `${String(y - 2)}px`,
          width: '4px',
          height: '4px',
          zIndex: '2147483647',
          pointerEvents: 'none',
        });
        document.documentElement.append(over);
      }, at);
      await expect(clickInWidget(cdp, target, { timeoutMs: 1500 })).rejects.toThrow(
        new WidgetTestError(
          'the page scrolls an element in place of the document (an implicit root scroller), so the helper cannot tell where a press would land',
        ),
      );
      expect((await waitingPrompts(cdp)).attach).toEqual([{ requestId, client: CI }]);

      // Back at its start and uncovered, the helper approves as it would anywhere.
      await page.evaluate(() => document.getElementById('cover')?.remove());
      await scrollTo(page, axis, 0);
      expect(await allowAttach(cdp, { as: 'driver', requestId })).toBe(requestId);
      expect((await pending).structured).toMatchObject({ role: 'driver' });
    } finally {
      await client.close();
      await cdp.detach();
    }
  });
}

// An element scrolled to the very end of a short range, right to left or up
// from the bottom, gives the readings of a document of that kind, so no
// reading tells the two apart, and a press may land where the readings say or
// the range further on. Within a third of the button both fit on it, and the
// helper presses only where both hit-test as Allow, so a cover where the press
// would land stops it. Past a third, the check where the readings say lands
// off the button under such an element (in its padding at first, which a hit
// test counts as the button too), so the helper waits even with nothing over
// Allow.
/** A range past half Allow's content box and within half its border box. */
const IN_PADDING = (content: number, border: number): number => Math.round((content + border) / 2);
for (const [axis, range, size, presses] of [
  ['across', '28 px', () => 28, true],
  ['down', '7 px', () => 7, true],
  ['across', 'a range inside the button’s padding', IN_PADDING, false],
  ['down', 'a range inside the button’s padding', IN_PADDING, false],
] as const) {
  const title = presses
    ? `presses nothing through a cover where the press would land, where an element scrolled ${axis} to the very end of ${range} stands in for the document`
    : `waits, with nothing over Allow, where an element scrolled ${axis} to the very end of ${range} stands in for the document`;
  test(title, async ({ page }) => {
    await page.goto(tabdock.pageUrl);
    await page.waitForSelector('html[data-tools="ready"]');
    const { code } = await waitForLink(page);
    const cdp = await page.context().newCDPSession(page);
    const client = await connectMcp(tabdock.relay, tabdock.users.alice, CI);
    try {
      const pending = callTool(client, 'pair_page', { code });
      const requestId = await waitForDock(page, (s) => s.pendingRequests[0]?.requestId);
      const target = { action: 'approve-driver', requestId } as const;
      const centre = await widgetButton(cdp, target);
      const { model } = await cdp.send('DOM.getBoxModel', {
        backendNodeId: centre.backendNodeId,
      });
      const half = (quad: number[], from: number): number =>
        Math.abs((quad[from + 4] ?? 0) - (quad[from] ?? 0)) / 2;
      const from = axis === 'across' ? 0 : 1;
      const by = size(half(model.content, from), half(model.border, from));

      await page.evaluate(
        ({ across, by }) => {
          const { documentElement: html, body } = document;
          Object.assign(html.style, { height: '100%', overflow: 'hidden' });
          Object.assign(body.style, { height: '100%', overflow: 'hidden', margin: '0' });
          const scroller = document.createElement('div');
          scroller.id = 'scroller';
          if (across) scroller.dir = 'rtl';
          else scroller.style.writingMode = 'sideways-lr';
          Object.assign(scroller.style, {
            position: 'absolute',
            left: '0',
            top: '0',
            width: '100%',
            height: '100%',
            overflow: 'auto',
          });
          const long = document.createElement('div');
          Object.assign(
            long.style,
            across
              ? { width: `calc(100% + ${String(by)}px)`, height: '100%' }
              : { width: '100%', height: `calc(100% + ${String(by)}px)` },
          );
          scroller.append(long);
          body.append(scroller);
          if (across) scroller.scrollLeft = -by;
          else scroller.scrollTop = -by;
        },
        { across: axis === 'across', by },
      );
      // The readings of a document scrolled to its very end, the case this
      // test exists for.
      await expect
        .poll(async () => {
          const metrics = await cdp.send('Page.getLayoutMetrics');
          const { cssVisualViewport: view, cssLayoutViewport: layout } = metrics;
          return axis === 'across'
            ? [view.pageX, layout.pageX, metrics.cssContentSize.width - layout.clientWidth]
            : [view.pageY, layout.pageY, metrics.cssContentSize.height - layout.clientHeight];
        })
        .toEqual([-by, 0, by]);

      if (presses) {
        // Where the helper would press: beside the centre, both places on Allow.
        const aimed = await widgetButton(cdp, target);
        expect(axis === 'across' ? aimed.x : aimed.y).not.toBe(
          axis === 'across' ? centre.x : centre.y,
        );
        await page.evaluate(({ x, y }) => {
          const over = document.createElement('div');
          over.id = 'cover';
          Object.assign(over.style, {
            position: 'fixed',
            left: `${String(x - 2)}px`,
            top: `${String(y - 2)}px`,
            width: '4px',
            height: '4px',
            zIndex: '2147483647',
            pointerEvents: 'none',
          });
          document.documentElement.append(over);
        }, aimed);
      }
      await expect(clickInWidget(cdp, target, { timeoutMs: 1500 })).rejects.toThrow(
        WidgetTestError,
      );
      expect((await waitingPrompts(cdp)).attach).toEqual([{ requestId, client: CI }]);

      // Uncovered at the end of a short range it approves where it stands;
      // past a third it does once the element is back at its start.
      await page.evaluate(() => document.getElementById('cover')?.remove());
      if (!presses) await scrollTo(page, axis, 0);
      expect(await allowAttach(cdp, { as: 'driver', requestId })).toBe(requestId);
      expect((await pending).structured).toMatchObject({ role: 'driver' });
    } finally {
      await client.close();
      await cdp.detach();
    }
  });
}

// A page's line-height on the widget's host reaches its buttons, so Allow's
// border box shrinks to a sliver while its label keeps its height, and a hit
// test on the label still names Allow. Measured on the border box alone, a
// range just past three quarters of it took one check, which landed on the
// label, and the press went to the centre unchecked.
test('presses nothing through a cover where a page squeezes Allow’s box below its label, at the very end of a short range', async ({
  page,
}) => {
  await page.goto(tabdock.pageUrl);
  await page.waitForSelector('html[data-tools="ready"]');
  await page.addStyleTag({ content: 'tabdock-dock { line-height: 0; }' });
  const { code } = await waitForLink(page);
  const cdp = await page.context().newCDPSession(page);
  const client = await connectMcp(tabdock.relay, tabdock.users.alice, CI);
  try {
    const pending = callTool(client, 'pair_page', { code });
    const requestId = await waitForDock(page, (s) => s.pendingRequests[0]?.requestId);
    const target = { action: 'approve-driver', requestId } as const;
    const centre = await widgetButton(cdp, target);
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: centre.backendNodeId });
    const height = Math.abs((model.border[5] ?? 0) - (model.border[1] ?? 0));
    const by = Math.floor(height * 0.75) + 1;
    // The label reaches past the border box, the case this test exists for.
    const label = await page.evaluate(() => {
      const host = document.querySelector('tabdock-dock');
      return host === null ? null : getComputedStyle(host).lineHeight;
    });
    expect(label).toBe('0px');

    await page.evaluate((by) => {
      const { documentElement: html, body } = document;
      Object.assign(html.style, { height: '100%', overflow: 'hidden' });
      Object.assign(body.style, { height: '100%', overflow: 'hidden', margin: '0' });
      const scroller = document.createElement('div');
      scroller.id = 'scroller';
      scroller.style.writingMode = 'sideways-lr';
      Object.assign(scroller.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        width: '100%',
        height: '100%',
        overflow: 'auto',
      });
      const long = document.createElement('div');
      Object.assign(long.style, { width: '100%', height: `calc(100% + ${String(by)}px)` });
      scroller.append(long);
      body.append(scroller);
      scroller.scrollTop = -by;
    }, by);
    await expect
      .poll(async () => {
        const metrics = await cdp.send('Page.getLayoutMetrics');
        const { cssVisualViewport: view, cssLayoutViewport: layout } = metrics;
        return [view.pageY, layout.pageY, metrics.cssContentSize.height - layout.clientHeight];
      })
      .toEqual([-by, 0, by]);

    await page.evaluate(({ x, y }) => {
      const over = document.createElement('div');
      over.id = 'cover';
      Object.assign(over.style, {
        position: 'fixed',
        left: `${String(x - 2)}px`,
        top: `${String(y - 2)}px`,
        width: '4px',
        height: '4px',
        zIndex: '2147483647',
        pointerEvents: 'none',
      });
      document.documentElement.append(over);
    }, centre);
    await expect(clickInWidget(cdp, target, { timeoutMs: 1500 })).rejects.toThrow(WidgetTestError);
    expect((await waitingPrompts(cdp)).attach).toEqual([{ requestId, client: CI }]);

    await page.evaluate(() => document.getElementById('cover')?.remove());
    await scrollTo(page, 'down', 0);
    expect(await allowAttach(cdp, { as: 'driver', requestId })).toBe(requestId);
    expect((await pending).structured).toMatchObject({ role: 'driver' });
  } finally {
    await client.close();
    await cdp.detach();
  }
});

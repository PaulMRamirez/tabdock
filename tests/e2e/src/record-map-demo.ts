// pnpm record:map-demo: a short video of a client driving the map demo, so
// people can see it work. By hand only, never in CI. It builds the page as
// the Pages site holds it, serves it on loopback beside a throwaway relay
// whose allowlist names that origin, opens it in headless Chromium at 1280
// by 720 with Playwright's video on, clicks the Connect bar as a person
// does, pairs an SDK client, clicks Allow as driver in the widget, folds the
// widget, then walks the tour with a capture at each stop and a pause to
// watch. It writes map-demo.webm and poster.png (the globe's canvas alone)
// into apps/map-demo/recording/, which git ignores, and only after the relay
// has closed, so any pairing code on screen in the video is already dead.
// It prints the two files' paths and sizes and nothing the run met: no code,
// token or relay URL (S11).

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@modelcontextprotocol/client';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { launchChromium } from './harness.ts';
import {
  clickConnect,
  type MapDemoRelay,
  type MapDemoSite,
  mapDemoUrl,
  openMapDemo,
  serveMapDemoSite,
  startMapDemoRelay,
} from './map-demo-harness.ts';
import { callMapTool, pairMapPage } from './map-harness.ts';
import { clickInWidget, connectMcp } from './tabdock-harness.ts';

const ROOT = resolve(import.meta.dirname, '../../..');

/** Where the recording goes: ignored by git, so nothing it writes is staged by accident. */
export const RECORDING_DIR = join(ROOT, 'apps/map-demo/recording');
/** The files a run writes there. */
export const RECORDING_FILES = ['map-demo.webm', 'poster.png'] as const;

const SIZE = { width: 1280, height: 720 };
const TOUR = 'earth';
/** How long the video holds each stop, long enough to read its card. */
const STOP_MS = 3_500;

const pause = (ms: number): Promise<void> =>
  new Promise((resolvePause) => {
    setTimeout(resolvePause, ms);
  });

/** One tool call through the relay; a failed call stops the recording rather than filming it. */
async function call(
  client: Client,
  pageId: string,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<void> {
  const outcome = await callMapTool(client, pageId, tool, args);
  if (outcome.isError) throw new Error(`${tool} failed while recording`);
}

/** The scenes: connect and pair, then the tour with a capture at each stop, then a layer and a list. */
async function film(page: Page, site: MapDemoSite, tabdock: MapDemoRelay): Promise<Buffer> {
  await openMapDemo(page, mapDemoUrl(site.url, tabdock.relay.pageUrl));
  await pause(1_500);
  await clickConnect(page);
  await page.waitForSelector('html[data-link="chosen"]');
  await pause(1_000);
  const client = await connectMcp(tabdock.relay, tabdock.users.alice, 'map-demo-recording');
  try {
    const pageId = await pairMapPage(page, client);
    await pause(1_500);
    // Folded, the widget shows only its chip, and the rest of the video only the page.
    await clickInWidget(page, { action: 'toggle' });
    await pause(1_000);
    for (let index = 0; index < 6; index += 1) {
      await call(client, pageId, 'go_to_stop', { walkthroughId: TOUR, index });
      await pause(1_200);
      await call(client, pageId, 'capture_view', { format: 'png', maxWidthPx: 960 });
      await pause(STOP_MS);
    }
    await call(client, pageId, 'set_view', {
      projection: 'equirectangular',
      lon: 20,
      lat: 10,
      widthM: 30_000_000,
    });
    await pause(1_500);
    await call(client, pageId, 'set_layer', { id: 'graticule', visible: false });
    await call(client, pageId, 'features_in_view', { kind: 'lake', limit: 10 });
    await pause(2_500);
    await call(client, pageId, 'go_to_stop', { walkthroughId: TOUR, index: 0 });
    await pause(1_500);
    // The poster is the globe's canvas alone, held in memory until the relay is gone.
    return await page.locator('canvas#map').screenshot();
  } finally {
    await client.close();
  }
}

async function record(): Promise<void> {
  const videoDir = mkdtempSync(join(tmpdir(), 'tabdock-map-demo-video-'));
  let site: MapDemoSite | undefined;
  let tabdock: MapDemoRelay | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    site = await serveMapDemoSite();
    tabdock = await startMapDemoRelay(site.origin);
    browser = await launchChromium(true);
    context = await browser.newContext({
      viewport: SIZE,
      recordVideo: { dir: videoDir, size: SIZE },
    });
    const page = await context.newPage();
    const poster = await film(page, site, tabdock);
    const video = page.video();
    if (!video) throw new Error('Playwright recorded no video');
    // The relay goes first, so the code the widget showed is dead before any file is written.
    await tabdock.close();
    tabdock = undefined;
    await context.close();
    context = undefined;
    mkdirSync(RECORDING_DIR, { recursive: true });
    const [webm, png] = RECORDING_FILES.map((name) => join(RECORDING_DIR, name));
    if (webm === undefined || png === undefined) throw new Error('no file names to write');
    await video.saveAs(webm);
    writeFileSync(png, poster);
    for (const file of [webm, png]) {
      console.log(`${relative(ROOT, file)}: ${statSync(file).size.toLocaleString('en')} bytes`);
    }
  } finally {
    await tabdock?.close();
    await context?.close();
    await browser?.close();
    await site?.close();
    rmSync(videoDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await record();
  } catch (error) {
    // The message only: an error from a tool call or the browser may carry what the run met.
    console.error(
      `record:map-demo failed: ${error instanceof Error ? error.name : 'an error'}; run it again, or the map-demo spec for detail`,
    );
    process.exitCode = 1;
  }
}

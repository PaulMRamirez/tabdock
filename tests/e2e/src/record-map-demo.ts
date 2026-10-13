// pnpm record:map-demo: a short video of a client driving the map demo, so
// people can see what Tabdock does. By hand only, never in CI. It builds the
// page as the Pages site holds it and serves it on loopback, starts `pnpm
// relay` in local mode with a throwaway TABDOCK_HOME whose
// TABDOCK_ALLOWED_ORIGINS names that origin (as a visitor sets it), and
// opens the page in headless Chromium at 1280 by 720 with Playwright's video
// on. A person's part is played as a person plays it: a trusted click on the
// Connect bar, and Allow as driver in the widget. A client on the MCP SDK,
// holding the owner token, then drives the tour as Claude would: it lists the
// walkthrough, goes to each stop with a pause, reads get_page_state and
// calls capture_view once, while a caption bar on the page names each step.
//
// No frame shows the pairing code or its QR code: before the Connect click a
// shade covers the widget's lane, the code's block is hidden inside the
// widget before the shade lifts, and every scene first checks that neither
// has a box on screen, stopping the run if one has. The code is read only
// through the DevTools protocol and handed to pair_page; nothing prints it,
// the token or the relay's output (S11), and the relay is gone before any
// file is written.
//
// It writes the take, its poster and a still of each scene into
// apps/map-demo/recording/, which git ignores, for a person to look at; when
// the take and the poster are within MEDIA_BUDGET it also copies both into
// apps/map-demo/media/, which the page links and the site publishes at
// /map/media/ (ADR 0050's notes). It prints only file paths and sizes.

import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { MAP_DEMO_MEDIA, type MapDemoMedia } from '@tabdock/map-demo/server';
import { privateTempRoot } from '@tabdock/relay/test/private-tmp';
import {
  CaptureImageTextSchema,
  GoToStopResultSchema,
  ListWalkthroughsResultSchema,
  MapPageStateSchema,
  MapStopSchema,
  type MapView,
} from '@tabdock/sim-page/map';
import { launchChromium } from './harness.ts';
import {
  firstText,
  imageBytes,
  imagePart,
  pngDimensions,
  type ResultContent,
} from './image-helpers.ts';
import { blankEnv, readBanner, type Run, runPnpm } from './local-harness.ts';
import {
  clickConnect,
  type MapDemoSite,
  mapDemoUrl,
  openMapDemo,
  serveMapDemoSite,
} from './map-demo-harness.ts';
import { callMapTool, mapPairingCode } from './map-harness.ts';
import { readPageState, stateBody } from './state-helpers.ts';
import {
  callTool,
  clickInWidget,
  type ToolOutcome,
  widgetEvaluate,
  widgetVisible,
} from './tabdock-harness.ts';

const ROOT = resolve(import.meta.dirname, '../../..');

/** The take, its poster and the stills, for a person to look at: git ignores this directory. */
export const RECORDING_DIR = join(ROOT, 'apps/map-demo/recording');
/** Where a take within budget is copied, beside the page that links it. */
export const MEDIA_DIR = join(ROOT, 'apps/map-demo/media');
/** Each file of a take, by its part. */
export const RECORDING_FILES: MapDemoMedia = MAP_DEMO_MEDIA;
/** Bytes a take may hold to be kept: a phone fetches the poster with the page. */
export const MEDIA_BUDGET = { video: 4_000_000, poster: 300_000 } as const;

const SIZE = { width: 1280, height: 720 };
const TOUR = 'earth';
/** What the client calls itself, as the widget's prompt and activity show it. */
const CLIENT_NAME = 'Tour script (MCP SDK)';

const pause = (ms: number): Promise<void> =>
  new Promise((resolvePause) => {
    setTimeout(resolvePause, ms);
  });

/** Secrets the run has met, kept out of anything it prints. */
const secrets: string[] = [];

/** An error's words with every secret the run met, and anything shaped like a code or token, taken out. */
function scrub(text: string): string {
  let out = text;
  for (const secret of secrets) if (secret !== '') out = out.split(secret).join('[hidden]');
  return out
    .replace(/tabdock_[A-Za-z0-9_-]{20,}/g, '[hidden]')
    .replace(/\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/g, '[hidden]');
}

/** One tool call through the relay; a failed call stops the recording rather than filming it. */
async function call(
  client: Client,
  pageId: string,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome> {
  const outcome = await callMapTool(client, pageId, tool, args);
  if (outcome.isError) throw new Error(`${tool} failed while recording`);
  return outcome;
}

/** Longitude and latitude as a caption says them. */
function place(view: Pick<MapView, 'lon' | 'lat'>): string {
  const lon = `${Math.abs(view.lon).toFixed(1)} ${view.lon < 0 ? 'W' : 'E'}`;
  const lat = `${Math.abs(view.lat).toFixed(1)} ${view.lat < 0 ? 'S' : 'N'}`;
  return `${lon}, ${lat}`;
}

function across(view: Pick<MapView, 'widthM'>): string {
  return `${Math.round(view.widthM / 1000).toLocaleString('en')} km across`;
}

// The page's overlay: a caption bar, the shade over the widget's lane and an
// inset for the picture capture_view returned. Each is a manual popover, so
// it sits in the top layer above the widget; none takes pointer events and
// none has a backdrop, so the widget's own hit test still finds its buttons
// uncovered. The styles go in a constructed stylesheet and through the
// CSSOM, which the page's style-src does not govern. Beyond a band of room
// above the page for the caption, nothing here changes what the page or the
// widget does.

interface Overlay {
  caption: { tag: string; text: string } | null;
  shade: boolean;
  inset: { png: string; label: string } | null;
}

const OVERLAY_CSS = `
body { padding-top: 64px; }
[data-recording] { position: fixed; inset: auto; margin: 0; border: 0; padding: 0; width: auto;
  height: auto; box-sizing: border-box; overflow: hidden; pointer-events: none; background: none;
  color: inherit; font-family: system-ui, sans-serif; }
[data-recording]::backdrop { display: none; }
[data-recording]:popover-open { display: flex; }
[data-recording='shade'] { top: 0; right: 0; width: 392px; height: 100vh; padding: 24px;
  align-items: center; justify-content: center; text-align: center; background: #dfe5eb;
  color: #4a5562; font-size: 15px; line-height: 1.5; }
[data-recording='caption'] { top: 0; min-height: 52px; align-items: center; gap: 12px;
  padding: 10px 14px; border-radius: 0 0 10px 10px; background: #111827; color: #fff;
  font-size: 16px; line-height: 1.35; box-shadow: 0 4px 16px rgb(0 0 0 / 0.25); }
[data-recording='caption'] .tag { flex: none; padding: 2px 8px; border-radius: 6px;
  background: #24577f; font: 600 14px/1.4 ui-monospace, monospace; }
[data-recording='inset'] { flex-direction: column; gap: 4px; padding: 8px; border-radius: 10px;
  background: #fff; color: #1d2530; font-size: 13px; line-height: 1.4;
  box-shadow: 0 6px 24px rgb(0 0 0 / 0.35); }
[data-recording='inset'] canvas { display: block; width: 352px; height: 198px; border-radius: 4px; }
`;

async function overlay(page: Page, want: Partial<Overlay>): Promise<void> {
  await page.evaluate(
    ([next, css]) => {
      const marked = (node: CSSStyleSheet): boolean =>
        [...node.cssRules].some((rule) => rule.cssText.startsWith('[data-recording]'));
      if (!document.adoptedStyleSheets.some(marked)) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
      const make = (name: string): HTMLElement => {
        let node = document.querySelector<HTMLElement>(`[data-recording="${name}"]`);
        if (node === null) {
          node = document.createElement('div');
          node.dataset.recording = name;
          node.setAttribute('popover', 'manual');
          document.body.append(node);
        }
        return node;
      };
      const show = (node: HTMLElement, on: boolean): void => {
        if (on) {
          // Shown again, so it comes last in the top layer, above whatever opened since.
          if (node.matches(':popover-open')) node.hidePopover();
          node.showPopover();
        } else if (node.matches(':popover-open')) {
          node.hidePopover();
        }
      };

      if (next.shade !== undefined) {
        const shade = make('shade');
        shade.textContent =
          'The Tabdock panel opens here. Its pairing code stays off camera in this recording.';
        show(shade, next.shade);
      }

      if (next.caption !== undefined) {
        const bar = make('caption');
        if (next.caption === null) {
          show(bar, false);
        } else {
          const main = document.querySelector('main')?.getBoundingClientRect();
          bar.style.left = `${String(main?.left ?? 16)}px`;
          bar.style.width = `${String(main?.width ?? 856)}px`;
          const tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent = next.caption.tag;
          const text = document.createElement('span');
          text.textContent = next.caption.text;
          bar.replaceChildren(tag, text);
          show(bar, true);
        }
      }

      if (next.inset !== undefined) {
        const box = make('inset');
        if (next.inset === null) {
          show(box, false);
        } else {
          const map = document.querySelector('canvas#map')?.getBoundingClientRect();
          box.style.left = `${String((map?.right ?? 860) - 380)}px`;
          box.style.top = `${String((map?.bottom ?? 560) - 252)}px`;
          const picture = document.createElement('canvas');
          picture.width = 352;
          picture.height = 198;
          const label = document.createElement('div');
          label.textContent = next.inset.label;
          box.replaceChildren(picture, label);
          show(box, true);
          // The PNG the client received, drawn from its bytes; no URL is loaded.
          const bytes = Uint8Array.from(atob(next.inset.png), (char) => char.charCodeAt(0));
          void createImageBitmap(new Blob([bytes], { type: 'image/png' })).then((bitmap) => {
            picture.getContext('2d')?.drawImage(bitmap, 0, 0, picture.width, picture.height);
          });
        }
      }
    },
    [want, OVERLAY_CSS] as const,
  );
}

/**
 * Hides the block that holds the pairing code and its QR code, inside the
 * widget's closed shadow root, through the DevTools protocol as an operator's
 * tools reach it; true once done, false while the widget is not mounted yet.
 * The code sits in a text block in a row beside the QR, under the block's
 * label, so the block is three levels up; the guard below checks the result
 * rather than trusting that shape.
 */
async function hidePairingBlock(page: Page): Promise<boolean> {
  const done = await widgetEvaluate(
    page,
    'pairing-code',
    `function () {
      const block = this.parentElement?.parentElement?.parentElement;
      if (!block) return false;
      block.style.setProperty('display', 'none', 'important');
      return true;
    }`,
  );
  return done === true;
}

/** Stops the run unless neither the pairing code nor its QR code has a box on screen. */
async function guard(page: Page): Promise<void> {
  if ((await widgetVisible(page, 'pairing-code')) || (await widgetVisible(page, 'pairing-qr'))) {
    throw new Error('the pairing code would be on screen, so the recording stops');
  }
}

/** Scrolls so the map sits just under the caption bar, its controls and the stop's card below it. */
async function frameTheMap(page: Page): Promise<void> {
  await page.evaluate(() => {
    const top = document.querySelector('canvas#map')?.getBoundingClientRect().top ?? 0;
    window.scrollBy(0, top - 62);
  });
}

interface Still {
  name: string;
  png: Buffer;
}

interface Take {
  stills: Still[];
  poster: Buffer;
}

async function connectClient(mcpUrl: string, token: string): Promise<Client> {
  const client = new Client({ name: CLIENT_NAME, version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

/** The scenes, about 55 seconds: connect, pair, approve, then the tour as a client walks it. */
async function film(page: Page, site: MapDemoSite, relay: Run, token: string): Promise<Take> {
  const banner = readBanner(relay.stdout());
  const stills: Still[] = [];
  /** A scene: the guard, its caption, the guard again, then a still of what the video shows. */
  const scene = async (name: string, tag: string, text: string): Promise<Buffer> => {
    await guard(page);
    await overlay(page, { caption: { tag, text } });
    await pause(250);
    await guard(page);
    const png = await page.screenshot();
    stills.push({ name: `${String(stills.length + 1).padStart(2, '0')}-${name}`, png });
    return png;
  };

  await openMapDemo(page, mapDemoUrl(site.url, banner.pageUrl));
  await overlay(page, { shade: true });
  await scene(
    'page',
    'Tabdock',
    'A map page with 14 WebMCP tools. An MCP client is about to drive it.',
  );
  await pause(3_000);

  await scene(
    'connect',
    'Connect',
    `The visitor clicks Connect to ${new URL(banner.pageUrl).host}, a Tabdock relay on this machine.`,
  );
  await pause(1_200);
  await clickConnect(page);
  await page.waitForSelector('html[data-link="chosen"]');
  // The widget mounts on the click; its code block is hidden before the shade lifts.
  const deadline = Date.now() + 10_000;
  while (!(await hidePairingBlock(page))) {
    if (Date.now() > deadline) throw new Error('the widget did not mount');
    await pause(50);
  }
  const code = await mapPairingCode(page);
  secrets.push(code);
  await guard(page);
  await pause(1_000);

  const client = await connectClient(banner.mcpUrl, token);
  try {
    await scene(
      'pair',
      'pair_page',
      "A script on the MCP SDK, standing in for Claude, pairs with the panel's code.",
    );
    await overlay(page, { shade: false });
    const pending = callTool(client, 'pair_page', { code });
    // Awaited below; a scene failing first must not leave it rejected unheard.
    pending.catch(() => undefined);
    await pause(1_800);
    await scene('approve', 'Allow', 'The person at the tab decides who drives: Allow as driver.');
    await pause(1_500);
    await clickInWidget(page, { action: 'approve-driver' });
    const paired = await pending;
    if (paired.isError) throw new Error('pair_page failed while recording');
    const pageId = (paired.structured as { page?: unknown }).page;
    if (typeof pageId !== 'string') throw new Error('pair_page named no page');
    await pause(1_500);

    await frameTheMap(page);
    const listed = ListWalkthroughsResultSchema.parse(
      (await call(client, pageId, 'list_walkthroughs')).structured,
    );
    const tour = listed.walkthroughs.find((walkthrough) => walkthrough.id === TOUR);
    if (tour === undefined) throw new Error('the page lists no Earth tour');
    await scene(
      'list',
      'list_walkthroughs',
      `One tour, "${tour.title}", ${String(tour.stopCount)} stops. The client takes it.`,
    );
    await pause(3_000);

    for (let index = 0; index < tour.stopCount; index += 1) {
      const stop = MapStopSchema.parse(
        (await call(client, pageId, 'get_stop', { walkthroughId: TOUR, index })).structured,
      );
      const went = GoToStopResultSchema.parse(
        (await call(client, pageId, 'go_to_stop', { walkthroughId: TOUR, index })).structured,
      );
      const shape = went.view.projection === 'globe' ? 'globe' : 'flat map';
      await scene(
        `stop-${String(index + 1)}`,
        'go_to_stop',
        `Stop ${String(index + 1)} of ${String(went.stopCount)}: ${stop.title}, on the ${shape}.`,
      );
      await pause(3_200);

      if (index === 2) {
        // Once, on the globe: the page draws its own map again into a PNG for the client.
        const result = (await client.callTool({
          name: 'call_page_tool',
          arguments: {
            page: pageId,
            tool: 'capture_view',
            arguments: { format: 'png', maxWidthPx: 960 },
          },
        })) as ResultContent;
        const image = imagePart(result);
        if (result.isError === true || image === null) throw new Error('capture_view failed');
        const bytes = imageBytes(image);
        const size = pngDimensions(bytes);
        if (size === null) throw new Error('capture_view returned no PNG');
        const [, , ...words] = firstText(result).split('\n');
        const text = CaptureImageTextSchema.parse(JSON.parse(words.join('\n')));
        const dimensions = `${String(size.width)} by ${String(size.height)}`;
        await overlay(page, {
          inset: {
            png: image.data,
            label: `What the client received: a ${dimensions} PNG of ${place(text.view)}, ${String(Math.round(bytes.length / 1024))} KB`,
          },
        });
        await scene(
          'capture',
          'capture_view',
          `The page draws its map again for the client, never the tab: a ${dimensions} PNG.`,
        );
        await pause(4_000);
        await overlay(page, { inset: null });
      }

      if (index === 3) {
        const state = MapPageStateSchema.parse(
          stateBody(await readPageState(client, pageId)).value,
        );
        await scene(
          'state',
          'get_page_state',
          `The client reads the view the page published: ${place(state.view)}, ${across(state.view)}.`,
        );
        await pause(3_500);
      }
    }

    // Out again to the whole globe, which the poster shows.
    await call(client, pageId, 'set_view', { altitudeM: 20_000_000 });
    await scene('globe', 'set_view', 'Back out to the whole globe.');
    await pause(2_500);
    const poster = await scene(
      'end',
      'Tabdock',
      'A client drove this page through a relay, and the person at the tab let it in.',
    );
    await pause(3_500);
    return { stills, poster };
  } finally {
    await client.close();
  }
}

/** Bytes as a person reads them. */
function bytes(count: number): string {
  return `${count.toLocaleString('en')} bytes`;
}

async function record(): Promise<void> {
  // Local mode refuses a token directory below anything another account can change, /tmp included.
  const scratch = realpathSync(mkdtempSync(join(privateTempRoot(), 'tabdock-map-demo-recording-')));
  const home = join(scratch, 'home');
  const videoDir = join(scratch, 'video');
  let site: MapDemoSite | undefined;
  let relay: Run | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    site = await serveMapDemoSite();
    relay = runPnpm(['relay'], {
      ...blankEnv(),
      TABDOCK_HOME: home,
      TABDOCK_PORT: '0',
      TABDOCK_ALLOWED_ORIGINS: site.origin,
    });
    await relay.waitFor('claude mcp list', 60_000);
    const token = readFileSync(readBanner(relay.stdout()).tokenPath, 'latin1').trim();
    secrets.push(token);

    browser = await launchChromium(true);
    context = await browser.newContext({
      viewport: SIZE,
      recordVideo: { dir: videoDir, size: SIZE },
      // The page's caption font and colours as a light screen shows them.
      colorScheme: 'light',
    });
    const page = await context.newPage();
    const take = await film(page, site, relay, token);
    const video = page.video();
    if (!video) throw new Error('Playwright recorded no video');
    // The relay goes first, so any code it issued is dead before a file is written.
    await relay.stop();
    relay = undefined;
    await context.close();
    context = undefined;

    rmSync(RECORDING_DIR, { recursive: true, force: true });
    mkdirSync(join(RECORDING_DIR, 'stills'), { recursive: true });
    const webm = join(RECORDING_DIR, RECORDING_FILES.video);
    const png = join(RECORDING_DIR, RECORDING_FILES.poster);
    await video.saveAs(webm);
    writeFileSync(png, take.poster);
    for (const still of take.stills) {
      writeFileSync(join(RECORDING_DIR, 'stills', `${still.name}.png`), still.png);
    }
    const sizes = { video: statSync(webm).size, poster: statSync(png).size };
    console.log(`${relative(ROOT, webm)}: ${bytes(sizes.video)}`);
    console.log(`${relative(ROOT, png)}: ${bytes(sizes.poster)}`);
    console.log(
      `${relative(ROOT, join(RECORDING_DIR, 'stills'))}/: ${String(take.stills.length)} stills, one a scene, to look at before committing`,
    );
    if (sizes.video > MEDIA_BUDGET.video || sizes.poster > MEDIA_BUDGET.poster) {
      console.log(
        `Over budget (${bytes(MEDIA_BUDGET.video)} for the video, ${bytes(MEDIA_BUDGET.poster)} for the poster), so ${relative(ROOT, MEDIA_DIR)}/ is left as it was.`,
      );
      process.exitCode = 1;
      return;
    }
    mkdirSync(MEDIA_DIR, { recursive: true });
    copyFileSync(webm, join(MEDIA_DIR, RECORDING_FILES.video));
    copyFileSync(png, join(MEDIA_DIR, RECORDING_FILES.poster));
    console.log(`Within budget, so copied both into ${relative(ROOT, MEDIA_DIR)}/.`);
  } finally {
    await relay?.stop();
    await context?.close();
    await browser?.close();
    await site?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await record();
  } catch (error) {
    // Scrubbed of the code, the token and anything shaped like either (S11).
    const words = error instanceof Error ? `${error.name}: ${error.message}` : 'an error';
    console.error(`record:map-demo failed: ${scrub(words)}`);
    process.exitCode = 1;
  }
}

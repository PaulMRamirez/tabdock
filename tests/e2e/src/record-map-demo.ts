// pnpm record:map-demo: a short video of a client driving the map demo, so
// people can see what Tabdock does. By hand only, never in CI, and it needs
// ffmpeg 6 on the PATH. It builds the page as the Pages site holds it and
// serves it on loopback, starts `pnpm relay` in local mode with a throwaway
// TABDOCK_HOME whose TABDOCK_ALLOWED_ORIGINS names that origin (as a visitor
// sets it), and opens two pages in headless Chromium, each with Playwright's
// video on: the map page as a visitor sees it, 792 by 720, and a client pane
// (record-pane.ts), 488 by 720, that the recorder serves on loopback and
// draws from its own data alone. A person's part is played as a person
// plays it: a trusted click on the Connect bar, Allow as driver in the
// widget, then a click on the widget's badge to fold its panel. A client on
// the MCP SDK, holding the owner token, stands in for Claude: it pairs, lists
// the walkthrough, goes to each stop, captures one view, reads the page's
// state and the features in view, and sets a view of its own. The pane shows
// each of its calls as it goes and the first lines of each answer as the
// relay returned them, under one caption per step saying what a person
// would ask; it never shows a chat, and its head says a script stands in.
//
// Nothing is drawn into the map page but the safeguards below: it is filmed
// as it is, never framed (it refuses frames), and the pane is a page of its
// own. record-encode.ts joins the two videos side by side with ffmpeg,
// trimmed so both start at the same moment: both pages close together, so
// each video's start is the close less its length.
//
// No frame shows the pairing code or its QR code: before the Connect click
// a shade covers the lane where the widget's panel opens, the code's block
// is hidden inside the widget before the shade lifts, and every scene first
// checks that neither has a box on screen and that the pane holds neither
// the code, the token nor anything shaped like either, while a watch runs
// the same checks every 300 ms between scenes; any one stops the run before
// a file is written. The code is read only through the DevTools protocol
// and handed to pair_page, which the pane shows with its code hidden;
// nothing prints the code, the token or the relay's output (S11), and the
// relay is gone before any file is written.
//
// It writes the take as an MP4 and a WebM, a poster, a looping GIF of one
// moment and a still of each scene into apps/map-demo/recording/, which git
// ignores, for a person to look at; when every file is within MEDIA_BUDGET
// it also copies the four into apps/map-demo/media/: the page shows the
// video and its poster, which the site publishes at /map/media/ (ADR
// 0050's notes), and the README plays the GIF. It prints only file paths,
// sizes and lengths.

import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { MAP_DEMO_MEDIA } from '@tabdock/map-demo/server';
import { PageStateResultSchema } from '@tabdock/protocol';
import { privateTempRoot } from '@tabdock/relay/test/private-tmp';
import { bodyOf } from '@tabdock/relay/test/results';
import {
  FeaturesInViewResultSchema,
  ListWalkthroughsResultSchema,
  MapPageStateSchema,
} from '@tabdock/sim-page/map';
import { launchChromium } from './harness.ts';
import { imageBytes, imagePart, pngDimensions, type ResultContent } from './image-helpers.ts';
import { blankEnv, readBanner, type Run, runPnpm } from './local-harness.ts';
import {
  clickConnect,
  type MapDemoSite,
  mapDemoUrl,
  openMapDemo,
  serveMapDemoSite,
} from './map-demo-harness.ts';
import { mapPairingCode } from './map-harness.ts';
import {
  duration,
  exportGif,
  exportMp4,
  exportWebm,
  frameCount,
  haveFfmpeg,
  joinPng,
  joinSideBySide,
  SOURCE_FPS,
} from './record-encode.ts';
import {
  PANE_SIZE,
  type PaneCaption,
  type PaneEntry,
  paneText,
  type PaneServer,
  type PaneState,
  renderPane,
  servePane,
} from './record-pane.ts';
import { clickInWidget, widgetEvaluate, widgetVisible } from './tabdock-harness.ts';

const ROOT = resolve(import.meta.dirname, '../../..');

/** The take, its exports and the stills, for a person to look at: git ignores this directory. */
export const RECORDING_DIR = join(ROOT, 'apps/map-demo/recording');
/** Where a take within budget is copied, beside the page that links it. */
export const MEDIA_DIR = join(ROOT, 'apps/map-demo/media');
/**
 * Each file of a take, by its part: the three the page links and the site
 * publishes (MAP_DEMO_MEDIA), and the loop the README plays, which the site
 * does not carry.
 */
export const RECORDING_FILES = { ...MAP_DEMO_MEDIA, loop: 'map-demo-loop.gif' } as const;
export type RecordingFiles = typeof RECORDING_FILES;
/** Bytes each file may hold to be kept: a phone fetches the poster with the page, and the README the loop. */
export const MEDIA_BUDGET = {
  video: 4_000_000,
  webm: 4_000_000,
  poster: 300_000,
  loop: 3_000_000,
} as const satisfies Record<keyof RecordingFiles, number>;
/** The loop's widest, so the README shows it whole; and its shortest and longest, in seconds. */
export const LOOP = { maxWidth: 800, minSeconds: 6, maxSeconds: 10 } as const;
/** The take's frame: the client pane on the left, the map page on the right. */
export const FRAME = { width: 1280, height: 720 } as const;

const MAP_SIZE = { width: FRAME.width - PANE_SIZE.width, height: FRAME.height };
const TOUR = 'earth';
/** What the client calls itself, as the widget's prompt and activity show it. */
const CLIENT_NAME = 'Tour script (MCP SDK)';
/** Where the finale goes: a lake the page names, on the globe, low enough that no other name sits on the map's edge. */
const FINALE = { name: 'Lago Titicaca', lon: -69.4, lat: -15.9, altitudeM: 6_500_000 } as const;

const pause = (ms: number): Promise<void> =>
  new Promise((resolvePause) => {
    setTimeout(resolvePause, ms);
  });

/** Secrets the run has met, kept out of anything it prints or shows. */
const secrets: string[] = [];

const TOKEN_SHAPE = /tabdock_[A-Za-z0-9_-]{20,}/g;
const CODE_SHAPE = /\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/g;

/** Text with every secret the run met, and anything shaped like a code or token, taken out. */
function scrub(text: string): string {
  let out = text;
  for (const secret of secrets) if (secret !== '') out = out.split(secret).join('[hidden]');
  return out.replace(TOKEN_SHAPE, '[hidden]').replace(CODE_SHAPE, '[hidden]');
}

// The page's one addition: the shade over the lane where the widget's panel
// opens, a manual popover in the top layer above the widget, with no
// backdrop and no pointer events, so the widget's own hit test still finds
// its buttons uncovered. Its style goes in a constructed stylesheet, which
// the page's style-src does not govern. It is up only from just before the
// Connect click until the code's block is hidden, and nothing else is drawn
// into the page.

const SHADE_CSS = `
[data-recording='shade'] { position: fixed; inset: 0 0 0 auto; margin: 0; border: 0; width: 392px;
  height: 100vh; box-sizing: border-box; padding: 24px; overflow: hidden; pointer-events: none;
  align-items: center; justify-content: center; text-align: center; background: #dfe5eb;
  color: #4a5562; font: 15px/1.5 system-ui, sans-serif; }
[data-recording='shade']::backdrop { display: none; }
[data-recording='shade']:popover-open { display: flex; }
`;

async function shade(page: Page, on: boolean): Promise<void> {
  await page.evaluate(
    ([show, css]) => {
      let node = document.querySelector<HTMLElement>('[data-recording="shade"]');
      if (node === null) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        node = document.createElement('div');
        node.dataset.recording = 'shade';
        node.setAttribute('popover', 'manual');
        node.textContent =
          'The Tabdock panel opens here. Its pairing code stays off camera in this recording.';
        document.body.append(node);
      }
      if (show) {
        // Shown again, so it comes last in the top layer, above whatever opened since.
        if (node.matches(':popover-open')) node.hidePopover();
        node.showPopover();
      } else if (node.matches(':popover-open')) {
        node.hidePopover();
      }
    },
    [on, SHADE_CSS] as const,
  );
}

/**
 * Hides the block that holds the pairing code and its QR code, inside the
 * widget's closed shadow root, through the DevTools protocol as an operator's
 * tools reach it; true once done, false while the widget is not mounted yet.
 * The code sits in a text block in a row beside the QR, under the block's
 * label, so the block is three levels up; the guards check the result
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

/** Stops the run unless neither the pairing code nor its QR code has a box on the map page. */
async function guardMap(page: Page): Promise<void> {
  if ((await widgetVisible(page, 'pairing-code')) || (await widgetVisible(page, 'pairing-qr'))) {
    throw new Error('the pairing code would be on screen, so the recording stops');
  }
}

/** Stops the run if the pane holds the code, the token, or anything shaped like either. */
async function guardPane(page: Page): Promise<void> {
  const text = await paneText(page);
  const held =
    secrets.some((secret) => secret !== '' && text.includes(secret)) ||
    new RegExp(TOKEN_SHAPE.source).test(text) ||
    new RegExp(CODE_SHAPE.source).test(text);
  if (held) throw new Error('the client pane would show a code or a token, so the recording stops');
}

/** Both guards, as each scene runs them. */
async function guard(map: Page, pane: Page): Promise<void> {
  await guardMap(map);
  await guardPane(pane);
}

/**
 * Runs the guards every 300 ms until stopped, between the scenes' own
 * checks; the first failure is kept, and the scenes and the end of the run
 * raise it, so no file is written after one.
 */
function watch(map: Page, pane: Page): { failure(): Error | null; stop(): Promise<void> } {
  // An object, so the loop reads what stop() wrote rather than a value narrowed at its start.
  const state: { stopped: boolean; failure: Error | null } = { stopped: false, failure: null };
  const loop = (async () => {
    while (!state.stopped) {
      try {
        await guard(map, pane);
      } catch (error) {
        // The pages stay open until the watch has stopped, so a failure here is a real one.
        state.failure = error instanceof Error ? error : new Error('a guard failed');
        return;
      }
      await pause(300);
    }
  })();
  return {
    failure: () => state.failure,
    async stop() {
      state.stopped = true;
      await loop;
    },
  };
}

/** Scrolls the page as a visitor does, with the wheel, until the map sits 8 pixels from the top. */
async function frameTheMap(page: Page): Promise<void> {
  const top = await page.evaluate(
    () => document.querySelector('canvas#map')?.getBoundingClientRect().top ?? 0,
  );
  // Over the page's left margin, never the map, whose wheel zooms only with Ctrl.
  await page.mouse.move(6, 360);
  await page.mouse.wheel(0, top - 8);
  const deadline = Date.now() + 3_000;
  for (;;) {
    const now = await page.evaluate(
      () => document.querySelector('canvas#map')?.getBoundingClientRect().top ?? 0,
    );
    if (Math.abs(now - 8) <= 1 || Date.now() > deadline) return;
    await pause(50);
  }
}

/** Arguments in a short readable form: key and value, strings quoted, no braces. */
function shortArgs(args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return parts.length === 0 ? '(no arguments)' : parts.join(', ');
}

/** The first lines of an answer's text, as the relay returned them, each at most 400 characters. */
function firstLines(result: ResultContent, count = 4): string[] {
  const text = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
  return text
    .split('\n')
    .slice(0, count)
    .map((line) => scrub(line.length > 400 ? `${line.slice(0, 400)}...` : line));
}

/** The JSON an answer carries, read as the relay's own tests read it. */
function body(result: ResultContent): unknown {
  return bodyOf(result);
}

/** Longitude and latitude as a note says them. */
function place(lon: number, lat: number): string {
  const east = `${Math.abs(lon).toFixed(1)} ${lon < 0 ? 'W' : 'E'}`;
  const north = `${Math.abs(lat).toFixed(1)} ${lat < 0 ? 'S' : 'N'}`;
  return `${east}, ${north}`;
}

interface Shot {
  map: Buffer;
  pane: Buffer;
}

interface Take {
  stills: { name: string; shot: Shot }[];
  poster: Shot;
  /** Wall clock times, in ms, of the moments the take is cut at. */
  marks: { start: number; end: number; loopFrom: number; loopTo: number };
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
async function film(
  map: Page,
  pane: Page,
  site: MapDemoSite,
  relay: Run,
  token: string,
): Promise<Take> {
  const banner = readBanner(relay.stdout());
  const state: PaneState = { caption: null, entries: [] };
  const stills: Take['stills'] = [];
  const show = (): Promise<void> => renderPane(pane, state);

  await openMapDemo(map, mapDemoUrl(site.url, banner.pageUrl));
  await show();
  const watcher = watch(map, pane);
  const checked = async (): Promise<void> => {
    const failure = watcher.failure();
    if (failure) throw failure;
    await guard(map, pane);
  };

  /** A step's caption, after the guards; the pane shows it before the client acts on it. */
  const caption = async (next: PaneCaption): Promise<void> => {
    await checked();
    state.caption = next;
    await show();
    await checked();
  };
  const shoot = async (): Promise<Shot> => {
    const [mapPng, panePng] = await Promise.all([map.screenshot(), pane.screenshot()]);
    return { map: mapPng, pane: panePng };
  };
  /** A still of both pages as the video shows them, after the guards. */
  const still = async (name: string): Promise<Shot> => {
    await checked();
    const shot = await shoot();
    await checked();
    stills.push({ name: `${String(stills.length + 1).padStart(2, '0')}-${name}`, shot });
    return shot;
  };

  let client: Client | undefined;
  let taken: Take;
  let nextId = 1;
  /**
   * One call as the client makes it, in the pane as it goes: the entry
   * appears waiting, then takes the answer's first lines as they came back.
   */
  const traffic = async (
    tool: string,
    args: Record<string, unknown>,
    shown: { pageTool?: string; args: string },
    read?: (result: ResultContent, entry: PaneEntry) => void,
  ): Promise<ResultContent> => {
    if (!client) throw new Error('no client yet');
    const entry: PaneEntry = {
      id: nextId,
      tool,
      pageTool: shown.pageTool ?? null,
      args: scrub(shown.args),
      status: 'waiting',
      answer: [],
      note: null,
      png: null,
      ms: null,
    };
    nextId += 1;
    state.entries.push(entry);
    await show();
    const started = performance.now();
    const result = (await client.callTool({ name: tool, arguments: args })) as ResultContent;
    entry.ms = Math.round(performance.now() - started);
    entry.status = result.isError === true ? 'error' : 'ok';
    entry.answer = firstLines(result);
    if (result.isError === true) {
      await show();
      throw new Error(`${shown.pageTool ?? tool} failed while recording`);
    }
    read?.(result, entry);
    await show();
    return result;
  };
  let pageId = '';
  const pageCall = (
    tool: string,
    args: Record<string, unknown>,
    read?: (result: ResultContent, entry: PaneEntry) => void,
  ): Promise<ResultContent> =>
    traffic(
      'call_page_tool',
      { page: pageId, tool, arguments: args },
      { pageTool: tool, args: shortArgs(args) },
      read,
    );

  try {
    const start = Date.now();
    await caption({ kind: 'tab', text: 'A visitor opens the map demo: Earth on a plain canvas.' });
    await pause(2_600);
    await still('page');

    await caption({
      kind: 'tab',
      text: 'The visitor clicks Connect, and the page dials their own Tabdock relay.',
    });
    await pause(1_400);
    await shade(map, true);
    await pause(300);
    await clickConnect(map);
    await map.waitForSelector('html[data-link="chosen"]');
    // The widget mounts on the click; its code block is hidden before the shade lifts.
    const deadline = Date.now() + 10_000;
    while (!(await hidePairingBlock(map))) {
      if (Date.now() > deadline) throw new Error('the widget did not mount');
      await pause(50);
    }
    const code = await mapPairingCode(map);
    secrets.push(code);
    await checked();
    client = await connectClient(banner.mcpUrl, token);
    await pause(400);
    await checked();
    await shade(map, false);
    await pause(900);
    await still('connect');

    await caption({ kind: 'ask', text: 'Pair with the code in the Tabdock panel.' });
    await pause(700);
    const pending = traffic('pair_page', { code }, { args: 'code: (hidden in this recording)' });
    // Awaited below; a scene failing first must not leave it rejected unheard.
    pending.catch(() => undefined);
    await pause(2_000);
    await still('pair');
    await caption({ kind: 'tab', text: 'The person at the tab allows the client in, as driver.' });
    await pause(1_500);
    await clickInWidget(map, { action: 'approve-driver' });
    const paired = body(await pending) as { page?: unknown };
    if (typeof paired.page !== 'string') throw new Error('pair_page named no page');
    pageId = paired.page;
    await pause(1_600);
    await still('approve');
    // Folded to its badge, as the page's own hint says, so the map is whole for the tour.
    await clickInWidget(map, { action: 'toggle' });
    await pause(500);
    await frameTheMap(map);
    await pause(600);

    await caption({ kind: 'ask', text: 'Take me on the tour.' });
    await pause(700);
    const listed = ListWalkthroughsResultSchema.parse(
      body(await pageCall('list_walkthroughs', {})),
    );
    const tour = listed.walkthroughs.find((walkthrough) => walkthrough.id === TOUR);
    if (tour === undefined) throw new Error('the page lists no Earth tour');
    await pause(1_600);
    await still('list');

    let loopFrom = 0;
    let loopTo = 0;
    let poster: Shot | undefined;
    for (let index = 0; index < tour.stopCount; index += 1) {
      if (index === 2) loopFrom = Date.now() - 300;
      if (index > 0) {
        await caption({ kind: 'ask', text: 'Next stop, please.' });
        await pause(700);
      }
      await pageCall('go_to_stop', { walkthroughId: TOUR, index });
      await pause(2_600);
      await still(`stop-${String(index + 1)}`);

      if (index === 2) {
        // Once, on the globe: the page draws its own map again into a PNG for the client.
        await caption({ kind: 'ask', text: 'Show me a picture of the view.' });
        await pause(700);
        await pageCall('capture_view', { format: 'png', maxWidthPx: 960 }, (result, entry) => {
          const image = imagePart(result);
          if (image === null) throw new Error('capture_view returned no image');
          const bytes = imageBytes(image);
          const size = pngDimensions(bytes);
          if (size === null) throw new Error('capture_view returned no PNG');
          entry.png = image.data;
          entry.note = `${image.mimeType}, ${String(size.width)} by ${String(size.height)}, ${String(Math.round(bytes.length / 1024))} KB`;
        });
        await pause(1_800);
        await still('capture');
        await pause(2_200);
        loopTo = Date.now();
      }

      if (index === 3) {
        await caption({ kind: 'ask', text: 'What are we looking at?' });
        await pause(700);
        await traffic(
          'get_page_state',
          { page: pageId },
          { args: `page: ${JSON.stringify(pageId)}` },
          (result, entry) => {
            const read = PageStateResultSchema.parse(body(result));
            const view = MapPageStateSchema.parse(read.value).view;
            entry.note = `state version ${String(read.version)}: ${view.projection}, ${place(view.lon, view.lat)}`;
          },
        );
        await pause(1_400);
        await pageCall('features_in_view', {}, (result, entry) => {
          const found = FeaturesInViewResultSchema.parse(body(result));
          entry.note = `${String(found.total)} in view: ${found.features
            .slice(0, 3)
            .map((feature) => feature.name)
            .join(', ')}${found.total > 3 ? ', ...' : ''}`;
        });
        await pause(1_200);
        // The poster: mid-tour, the map full of named lakes and the pane full of what was read.
        poster = await still('state');
        await pause(1_600);
      }
    }
    if (poster === undefined || loopTo === 0) {
      throw new Error('the tour never reached its capture and its state');
    }

    await caption({ kind: 'ask', text: `Show me ${FINALE.name} on the globe.` });
    await pause(700);
    await pageCall('set_view', {
      projection: 'globe',
      lon: FINALE.lon,
      lat: FINALE.lat,
      altitudeM: FINALE.altitudeM,
    });
    await pause(2_800);
    await still('finale');
    await caption({
      kind: 'tab',
      text: 'The person at the tab can pause or revoke the client from the Tabdock badge.',
    });
    await pause(3_200);
    await still('end');
    const end = Date.now();
    await checked();
    taken = { stills, poster, marks: { start, end, loopFrom, loopTo } };
  } finally {
    await watcher.stop();
    await client?.close();
  }
  // A failure the watch saw stops the run even when the scenes went on to finish.
  const failure = watcher.failure();
  if (failure) throw failure;
  return taken;
}

/** Bytes as a person reads them. */
function bytes(count: number): string {
  return `${count.toLocaleString('en')} bytes`;
}

/** Seconds as a person reads them. */
function seconds(value: number): string {
  return `${value.toFixed(1)} s`;
}

async function record(): Promise<void> {
  if (!(await haveFfmpeg()))
    throw new Error('record:map-demo needs ffmpeg and ffprobe on the PATH');
  // Local mode refuses a token directory below anything another account can change, /tmp included.
  const scratch = realpathSync(mkdtempSync(join(privateTempRoot(), 'tabdock-map-demo-recording-')));
  const home = join(scratch, 'home');
  let site: MapDemoSite | undefined;
  let paneServer: PaneServer | undefined;
  let relay: Run | undefined;
  let browser: Browser | undefined;
  let mapContext: BrowserContext | undefined;
  let paneContext: BrowserContext | undefined;
  try {
    // Without the recording: the take it films is the one being made.
    site = await serveMapDemoSite({ media: false });
    paneServer = await servePane();
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
    mapContext = await browser.newContext({
      viewport: MAP_SIZE,
      recordVideo: { dir: join(scratch, 'map'), size: MAP_SIZE },
      // The page as a light screen shows it.
      colorScheme: 'light',
    });
    paneContext = await browser.newContext({
      viewport: PANE_SIZE,
      recordVideo: { dir: join(scratch, 'pane'), size: PANE_SIZE },
      colorScheme: 'dark',
    });
    // Started together, so neither video holds much the other lacks.
    const [map, pane] = await Promise.all([mapContext.newPage(), paneContext.newPage()]);
    await pane.goto(paneServer.url);
    const take = await film(map, pane, site, relay, token);
    const mapVideo = map.video();
    const paneVideo = pane.video();
    if (!mapVideo || !paneVideo) throw new Error('Playwright recorded no video');
    // The relay goes first, so any code it issued is dead before a file is written.
    await relay.stop();
    relay = undefined;
    // Both close at once, so both videos end at this moment, and each began its length before it.
    const closed = Date.now();
    await Promise.all([mapContext.close(), paneContext.close()]);
    mapContext = undefined;
    paneContext = undefined;

    const mapRaw = join(scratch, 'map.webm');
    const paneRaw = join(scratch, 'pane.webm');
    await Promise.all([mapVideo.saveAs(mapRaw), paneVideo.saveAs(paneRaw)]);
    const [mapFrames, paneFrames] = await Promise.all([frameCount(mapRaw), frameCount(paneRaw)]);
    const began = {
      map: closed - (mapFrames * 1000) / SOURCE_FPS,
      pane: closed - (paneFrames * 1000) / SOURCE_FPS,
    };
    const length = (take.marks.end - take.marks.start) / 1000;
    const master = join(scratch, 'master.mkv');
    await joinSideBySide(
      { file: paneRaw, from: (take.marks.start - began.pane) / 1000 },
      { file: mapRaw, from: (take.marks.start - began.map) / 1000 },
      length,
      master,
    );

    rmSync(RECORDING_DIR, { recursive: true, force: true });
    mkdirSync(join(RECORDING_DIR, 'stills'), { recursive: true });
    const out = (part: keyof RecordingFiles): string => join(RECORDING_DIR, RECORDING_FILES[part]);
    const shots = join(scratch, 'shots');
    mkdirSync(shots);
    const joinShot = async (shot: Shot, to: string, budget: number): Promise<number> => {
      const left = join(shots, 'pane.png');
      const right = join(shots, 'map.png');
      writeFileSync(left, shot.pane);
      writeFileSync(right, shot.map);
      return joinPng(left, right, to, budget);
    };
    for (const still of take.stills) {
      await joinShot(
        still.shot,
        join(RECORDING_DIR, 'stills', `${still.name}.png`),
        Number.POSITIVE_INFINITY,
      );
    }
    const loopFrom = (take.marks.loopFrom - take.marks.start) / 1000;
    const loopSeconds = Math.min(
      LOOP.maxSeconds,
      Math.max(LOOP.minSeconds, (take.marks.loopTo - take.marks.loopFrom) / 1000),
    );
    const sizes: Record<keyof RecordingFiles, number> = {
      video: await exportMp4(master, out('video'), MEDIA_BUDGET.video),
      webm: await exportWebm(master, out('webm'), MEDIA_BUDGET.webm),
      poster: await joinShot(take.poster, out('poster'), MEDIA_BUDGET.poster),
      loop: await exportGif(
        master,
        loopFrom,
        loopSeconds,
        LOOP.maxWidth,
        out('loop'),
        MEDIA_BUDGET.loop,
      ),
    };
    // For a person checking the cut: how the two videos lined up, no secret in it.
    writeFileSync(
      join(RECORDING_DIR, 'timing.json'),
      `${JSON.stringify(
        {
          videoSeconds: { map: mapFrames / SOURCE_FPS, pane: paneFrames / SOURCE_FPS },
          startGapSeconds: (began.pane - began.map) / 1000,
          takeSeconds: length,
          loop: { fromSeconds: loopFrom, seconds: loopSeconds },
        },
        null,
        2,
      )}\n`,
    );

    const lengths = {
      video: await duration(out('video')),
      webm: await duration(out('webm')),
    };
    for (const part of Object.keys(RECORDING_FILES) as (keyof RecordingFiles)[]) {
      const length = part === 'video' || part === 'webm' ? `, ${seconds(lengths[part])}` : '';
      const loop = part === 'loop' ? `, ${seconds(loopSeconds)}` : '';
      console.log(`${relative(ROOT, out(part))}: ${bytes(sizes[part])}${length}${loop}`);
    }
    console.log(
      `${relative(ROOT, join(RECORDING_DIR, 'stills'))}/: ${String(take.stills.length)} stills, both panes of each scene, to look at before committing`,
    );
    const over = (Object.keys(RECORDING_FILES) as (keyof RecordingFiles)[]).filter(
      (part) => sizes[part] > MEDIA_BUDGET[part],
    );
    if (over.length > 0) {
      console.log(
        `Over budget (${over.map((part) => `${RECORDING_FILES[part]} ${bytes(MEDIA_BUDGET[part])}`).join(', ')}), so ${relative(ROOT, MEDIA_DIR)}/ is left as it was.`,
      );
      process.exitCode = 1;
      return;
    }
    rmSync(MEDIA_DIR, { recursive: true, force: true });
    mkdirSync(MEDIA_DIR, { recursive: true });
    for (const part of Object.keys(RECORDING_FILES) as (keyof RecordingFiles)[]) {
      copyFileSync(out(part), join(MEDIA_DIR, RECORDING_FILES[part]));
    }
    console.log(`Within budget, so copied all four into ${relative(ROOT, MEDIA_DIR)}/.`);
  } finally {
    await relay?.stop();
    await mapContext?.close();
    await paneContext?.close();
    await browser?.close();
    await paneServer?.close();
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

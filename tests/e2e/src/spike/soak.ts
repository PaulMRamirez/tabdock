// The tab-survival half of the M3 spike (A3.3), headless: the demo page with the
// real adapter against a relay in this process (throwaway dev tokens, loopback),
// one MCP client attached, then freeze and thaw cycles through the DevTools
// protocol (cdp.ts) for as long as asked. After each thaw the adapter must
// reconnect and resume: the same page id, the attachment intact on both sides,
// and a call that works. Link drops and resumes are timed from the relay's log
// and from the page's own link state. This tests the adapter's recovery; it
// cannot test whether Chrome would freeze a real background tab, which is the
// owner's manual run (Energy Saver, laptop sleep). scripts/spike/soak.ts is the
// command; tests/e2e/specs/soak.spec.ts runs one quick cycle in CI.

import type { Client } from '@modelcontextprotocol/client';
import type { DockState } from '@tabdock/adapter';
import type { RelayOptions } from '@tabdock/relay';
import { markdownTable, summarise } from './stats.ts';
import { CdpPage, type Chrome, launchChrome } from './cdp.ts';
import { callTool, connectMcp, errorCode, startTabdock, type Tabdock } from '../tabdock-harness.ts';

export interface SoakOptions {
  /** Keep cycling until this long has passed since the first freeze. */
  durationMs: number;
  /** Stop after this many cycles even if time is left. */
  maxCycles?: number;
  /** How long each freeze lasts. Past the relay's idle timeout (30 s by default) the link drops. */
  freezeMs: number;
  /** How long the page runs, still hidden, between a resume and the next freeze. */
  activeMs: number;
  /** How long a thawed page may take to resume. Hidden pages get one timer wake-up a minute. */
  resumeTimeoutMs?: number;
  headless?: boolean;
  /** Relay timings, so a quick run can use a short idle timeout. */
  timings?: RelayOptions['timings'];
  /** ?busy for the page (apps/demo/src/busy.ts). */
  busy?: number;
  /** Receives each narrated line, already timestamped. */
  say?: (line: string) => void;
}

export interface CycleResult {
  cycle: number;
  frozeAt: number;
  thawedAt: number;
  /** When the relay put the page to sleep (its socket closed) during this freeze; null if it never did. */
  relayDroppedAt: number | null;
  /** When the page's link left 'linked' after the thaw, by the page's clock. */
  pageDroppedAt: number | null;
  /** When the relay welcomed the page back. */
  resumedAt: number | null;
  /** Whether that welcome resumed the old session. */
  resumed: boolean;
  samePage: boolean;
  attached: boolean;
  callOk: boolean;
  /** From the thaw to the first successful call. */
  recoveryMs: number | null;
  error: string | null;
}

export interface SoakReport {
  pageId: string;
  cycles: CycleResult[];
  startedAt: number;
  endedAt: number;
  visibility: string | null;
  wasDiscarded: boolean | null;
  ok: boolean;
}

interface RelayEvent {
  at: number;
  msg: string;
  pageId?: string;
  resumed?: boolean;
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dock(page: CdpPage): Promise<DockState | null> {
  return (await page.evaluate('window.__tabdockDock?.state ?? null')) as DockState | null;
}

async function waitFor<T>(
  pick: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  what: string,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const picked = await pick();
    if (picked !== null && picked !== undefined && picked !== false) return picked;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${String(timeoutMs)} ms waiting for ${what}`);
    await delay(100);
  }
}

/** Starts everything, attaches one client as a driver, and returns the pieces for cycling. */
async function setUp(
  options: SoakOptions,
  events: RelayEvent[],
): Promise<{ tabdock: Tabdock; chrome: Chrome; page: CdpPage; client: Client; pageId: string }> {
  const tabdock = await startTabdock({
    logLevel: 'info',
    timings: options.timings,
    logSink: (line) => {
      const entry = JSON.parse(line) as {
        ts: string;
        msg: string;
        pageId?: unknown;
        resumed?: unknown;
      };
      if (entry.msg !== 'page asleep' && entry.msg !== 'page connected') return;
      events.push({
        at: Date.parse(entry.ts),
        msg: entry.msg,
        ...(typeof entry.pageId === 'string' ? { pageId: entry.pageId } : {}),
        ...(typeof entry.resumed === 'boolean' ? { resumed: entry.resumed } : {}),
      });
    },
  });
  let chrome: Chrome | undefined;
  try {
    chrome = await launchChrome({ headless: options.headless ?? true });
    const url = new URL(tabdock.pageUrl);
    if (options.busy !== undefined) url.searchParams.set('busy', String(options.busy));
    const page = await CdpPage.open(chrome, url.href);
    const linked = await waitFor(
      async () => {
        const state = await dock(page).catch(() => null);
        return state?.link === 'linked' && state.pageId !== null && state.pairing !== null
          ? { pageId: state.pageId, code: state.pairing.code }
          : null;
      },
      'the page to link to the relay',
      30_000,
    );
    // From here the page records every link state itself, so a drop that heals between polls is still seen.
    await page.evaluate(
      `(() => { window.__soakLinks = []; window.__tabdockDock.on('state', (s) => window.__soakLinks.push([Date.now(), s.link])); return true; })()`,
    );
    const client = await connectMcp(tabdock.relay, tabdock.users.alice, 'tabdock-spike-soak');
    const pairing = callTool(client, 'pair_page', { code: linked.code });
    const requestId = await waitFor(
      async () => (await dock(page))?.pendingRequests[0]?.requestId,
      'the attach request on the page',
      10_000,
    );
    await page.evaluate(`window.__tabdockDock.approve(${JSON.stringify(requestId)}, 'driver')`);
    const paired = await pairing;
    if (paired.isError) throw new Error(`pairing failed: ${paired.text}`);
    return { tabdock, chrome, page, client, pageId: linked.pageId };
  } catch (error) {
    await chrome?.close();
    await tabdock.close();
    throw error;
  }
}

/** One freeze, one thaw, and the checks that the session came back whole. */
async function cycle(
  index: number,
  ctx: { page: CdpPage; client: Client; pageId: string; events: RelayEvent[] },
  options: SoakOptions,
  say: (line: string) => void,
): Promise<CycleResult> {
  const { page, client, pageId, events } = ctx;
  const resumeTimeoutMs = options.resumeTimeoutMs ?? 150_000;
  await page.evaluate('(window.__soakLinks = [], true)');
  const frozeAt = Date.now();
  await page.freeze();
  say(
    `cycle ${String(index)}: froze the page for ${String(Math.round(options.freezeMs / 1000))} s`,
  );
  await delay(options.freezeMs);
  const thawedAt = Date.now();
  await page.resume();
  const dropped = events.find(
    (event) => event.msg === 'page asleep' && event.pageId === pageId && event.at >= frozeAt,
  );
  say(
    dropped
      ? `cycle ${String(index)}: thawed; the relay had dropped the link at ${iso(dropped.at)}, ${String(Math.round((dropped.at - frozeAt) / 1000))} s into the freeze`
      : `cycle ${String(index)}: thawed; the relay kept the link through the freeze`,
  );

  const result: CycleResult = {
    cycle: index,
    frozeAt,
    thawedAt,
    relayDroppedAt: dropped?.at ?? null,
    pageDroppedAt: null,
    resumedAt: null,
    resumed: false,
    samePage: false,
    attached: false,
    callOk: false,
    recoveryMs: null,
    error: null,
  };
  try {
    const welcomeAfterThaw = (): RelayEvent | undefined =>
      events.find((event) => event.msg === 'page connected' && event.at >= thawedAt);
    const linkedState = (): Promise<DockState> =>
      waitFor(
        async () => {
          const now = await dock(page);
          return now?.link === 'linked' && now.roster.length > 0 ? now : null;
        },
        'the page to show its link and roster',
        resumeTimeoutMs,
      );
    // A dropped link must come back through a welcome after the thaw.
    let welcome = dropped
      ? await waitFor(welcomeAfterThaw, 'the page to reconnect', resumeTimeoutMs)
      : undefined;
    let state = await linkedState();
    const callView = (): ReturnType<typeof callTool> =>
      callTool(client, 'call_page_tool', { page: pageId, tool: 'get_view', arguments: {} });
    let call = await callView();
    // A link the relay kept may still have failed on the page as it thawed;
    // then the page reconnects, and the call is made again once it has.
    if (call.isError && errorCode(call) === 'page_asleep') {
      welcome = await waitFor(welcomeAfterThaw, 'the page to reconnect', resumeTimeoutMs);
      state = await linkedState();
      call = await callView();
    }
    result.callOk = !call.isError;
    if (result.callOk) result.recoveryMs = Date.now() - thawedAt;
    welcome ??= welcomeAfterThaw();
    if (welcome) {
      result.resumedAt = welcome.at;
      result.resumed = welcome.resumed === true;
      say(
        `cycle ${String(index)}: reconnected at ${iso(welcome.at)} (${welcome.resumed === true ? 'resumed' : 'new session'}), ${String(welcome.at - thawedAt)} ms after the thaw`,
      );
    }
    result.samePage =
      state.pageId === pageId && (welcome === undefined || welcome.pageId === pageId);
    const recorded: unknown = await page.evaluate('window.__soakLinks ?? []');
    const links = Array.isArray(recorded) ? (recorded as [number, string][]) : [];
    const drop = links.findIndex(([, link]) => link !== 'linked');
    result.pageDroppedAt = links[drop]?.[0] ?? null;
    const relinked = links.slice(drop + 1).find(([, link]) => link === 'linked');
    if (result.pageDroppedAt !== null) {
      say(
        `cycle ${String(index)}: the page saw its link drop at ${iso(result.pageDroppedAt)} and relinked at ${relinked ? iso(relinked[0]) : 'an unrecorded time'}`,
      );
    }
    const onPage = state.roster.some(
      (entry) => entry.userId === 'alice' && entry.role === 'driver',
    );
    const listed = await callTool(client, 'list_pages');
    const onRelay = listed.text.includes(pageId) && listed.text.includes('"role":"driver"');
    result.attached = onPage && onRelay;
    say(
      `cycle ${String(index)}: page ${result.samePage ? 'kept its id' : 'CHANGED ITS ID'}, attachment ${result.attached ? 'intact' : 'LOST'}, get_view ${result.callOk ? `ok ${String(result.recoveryMs)} ms after the thaw` : `FAILED: ${call.text.slice(0, 120)}`}`,
    );
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    say(`cycle ${String(index)}: FAILED: ${result.error}`);
  }
  return result;
}

export function cycleOk(result: CycleResult): boolean {
  return result.error === null && result.samePage && result.attached && result.callOk;
}

export async function runSoak(options: SoakOptions): Promise<SoakReport> {
  const say = (line: string): void => {
    options.say?.(`${iso(Date.now())}  ${line}`);
  };
  const events: RelayEvent[] = [];
  const { tabdock, chrome, page, client, pageId } = await setUp(options, events);
  const cycles: CycleResult[] = [];
  const startedAt = Date.now();
  try {
    say(
      `attached to ${pageId} as a driver; soaking for ${String(Math.round(options.durationMs / 60_000))} min`,
    );
    const maxCycles = options.maxCycles ?? Number.POSITIVE_INFINITY;
    while (cycles.length < maxCycles) {
      const result = await cycle(cycles.length + 1, { page, client, pageId, events }, options, say);
      cycles.push(result);
      if (!cycleOk(result)) break;
      if (Date.now() + options.activeMs + options.freezeMs - startedAt > options.durationMs) break;
      await delay(options.activeMs);
    }
    const visibility: unknown = await page.evaluate('document.visibilityState').catch(() => null);
    const wasDiscarded: unknown = await page
      .evaluate('document.wasDiscarded === true')
      .catch(() => null);
    return {
      pageId,
      cycles,
      startedAt,
      endedAt: Date.now(),
      visibility: typeof visibility === 'string' ? visibility : null,
      wasDiscarded: typeof wasDiscarded === 'boolean' ? wasDiscarded : null,
      ok: cycles.length > 0 && cycles.every(cycleOk),
    };
  } finally {
    page.close();
    await client.close().catch(() => undefined);
    await chrome.close();
    await tabdock.close();
  }
}

/** The markdown section for docs/notes/spike.md. */
export function soakReport(report: SoakReport, options: SoakOptions): string {
  const recovered = report.cycles.filter((c) => c.recoveryMs !== null);
  const reconnects = report.cycles.filter((c) => c.resumedAt !== null);
  const table = markdownTable([
    {
      label: 'Freeze to relay link drop',
      summary: summarise(
        report.cycles.flatMap((c) =>
          c.relayDroppedAt === null ? [] : [c.relayDroppedAt - c.frozeAt],
        ),
      ),
    },
    {
      label: 'Thaw to relay welcome',
      summary: summarise(reconnects.map((c) => (c.resumedAt ?? 0) - c.thawedAt)),
    },
    {
      label: 'Thaw to first working call',
      summary: summarise(recovered.map((c) => c.recoveryMs ?? 0)),
    },
  ]);
  const minutes = ((report.endedAt - report.startedAt) / 60_000).toFixed(1);
  const failed = report.cycles.filter((c) => !cycleOk(c));
  const lines = [
    `Headless soak ${iso(report.startedAt)} to ${iso(report.endedAt)} (${minutes} min): ${String(report.cycles.length)} cycles of a ${String(Math.round(options.freezeMs / 1000))} s freeze (CDP Page.setWebLifecycleState) and ${String(Math.round(options.activeMs / 1000))} s awake but hidden, demo page with the real adapter${options.busy === undefined ? '' : ` and ?busy=${String(options.busy)}`}, relay in the same process.`,
    `${String(report.cycles.filter((c) => c.relayDroppedAt !== null).length)} freezes dropped the link at the relay; ${String(reconnects.filter((c) => c.resumed && c.samePage).length)} of the reconnects resumed the same page.`,
    failed.length === 0
      ? 'Every cycle came back with the same page id, the attachment intact and a working call.'
      : `Cycle ${String(failed[0]?.cycle ?? 0)} did not come back whole: ${failed[0]?.error ?? 'a check failed'}; the soak stopped there.`,
    `At the end the page was ${report.visibility ?? 'unknown'}${report.wasDiscarded === true ? ' and had been discarded' : ''}.`,
  ];
  return `${table}\n\n${lines.join(' ')}\n`;
}

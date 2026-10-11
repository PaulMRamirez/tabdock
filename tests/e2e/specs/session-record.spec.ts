import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { expect, type Page, test } from '@playwright/test';
import { buildDemo, type DemoServer, startDemoServer } from '@tabdock/demo/server';
import {
  ATTACH_REQUEST_TTL_MS,
  encodeFrame,
  encodeSessionRecord,
  MAX_DESCRIPTION_CHARS,
  MAX_FRAME_BYTES,
  MAX_RESULT_CHARS,
  parsePageFrame,
  parseSessionRecord,
  PING_INTERVAL_MS,
  RESUME_WINDOW_MS,
  type SessionRecord,
} from '@tabdock/protocol';
import {
  type AuditedTabdock,
  auditedCallIds,
  auditMatch,
  openRecordBox,
  saveOfferedRecord,
  saveRecordFromWidget,
  startAuditedTabdock,
} from '../src/record-helpers.ts';
import {
  memberEntry,
  openWithSessionRelay,
  sidewaysScroll,
  startSessionInWidget,
} from '../src/session-helpers.ts';
import {
  callTool,
  clickInWidget,
  connectMcp,
  scriptClickInWidget,
  waitForDock,
  waitForLink,
  widgetButtonNow,
  widgetEvaluate,
  widgetText,
  widgetVisible,
} from '../src/tabdock-harness.ts';

// The session record in a real browser (ADR 0045, A6.25). The operator
// saves it from the widget, as JSON and as a Markdown summary, only with a
// trusted click on a box that held still and said whom the file names; a
// script's click saves nothing. The saved file passes `pnpm audit:log
// --match` against the relay's own audit directory, and fails it once a
// call is taken out. At a phone's width the box fits; a session's end offers
// its record and saves nothing until a click; and the static build saves
// under its own Content Security Policy.

const ARM_DELAY_MS = 500;
const MINUTE = 60_000;

let demo: DemoServer;
let pageErrors: string[];

test.beforeAll(async () => {
  demo = await startDemoServer({ e2eHook: true });
});
test.afterAll(async () => {
  await demo.close();
});
test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
});
test.afterEach(() => {
  expect(pageErrors).toEqual([]);
});

/** Counts every download the page starts from here on. */
function countDownloads(page: Page): { readonly count: number } {
  const seen = { count: 0 };
  page.on('download', () => {
    seen.count += 1;
  });
  return seen;
}

/** pair_page with the code on show, then the operator's click on Allow as `role` in the widget. */
async function pairByClick(
  page: Page,
  client: Client,
  role: 'driver' | 'observer',
): Promise<string> {
  const { code } = await waitForLink(page);
  const pending = callTool(client, 'pair_page', { code });
  const requestId = await waitForDock(page, (state) => state.pendingRequests[0]?.requestId);
  await clickInWidget(page, {
    action: role === 'driver' ? 'approve-driver' : 'approve-observer',
    requestId,
  });
  const paired = await pending;
  expect(paired.isError, paired.text).toBe(false);
  return (paired.structured as { page: string }).page;
}

test.describe('with a relay that keeps an audit directory', () => {
  let tabdock: AuditedTabdock;
  let clients: Client[];

  test.beforeEach(async () => {
    tabdock = await startAuditedTabdock(demo);
    clients = [];
  });
  test.afterEach(async () => {
    for (const client of clients) await client.close();
    await tabdock.close();
  });

  test('saves the record only on a trusted click in an armed box, and audit --match holds it to the log', async ({
    page,
  }) => {
    const alice = await connectMcp(tabdock.relay, tabdock.users.alice, 'record-alice');
    const bob = await connectMcp(tabdock.relay, tabdock.users.bob, 'record-bob');
    clients.push(alice, bob);
    await page.goto(tabdock.pageUrl);
    await page.waitForSelector('html[data-tools="ready"]');
    const pageId = await pairByClick(page, alice, 'driver');
    await pairByClick(page, bob, 'observer');
    await waitForDock(page, (state) => state.roster.length === 2);

    // Three calls: two reads, and a write the operator allows on the page.
    for (const tool of ['get_view', 'list_items']) {
      const read = await callTool(alice, 'call_page_tool', { page: pageId, tool, arguments: {} });
      expect(read.isError, read.text).toBe(false);
    }
    const write = callTool(alice, 'call_page_tool', {
      page: pageId,
      tool: 'clear_board',
      arguments: {},
    });
    const callId = await waitForDock(page, (state) => state.pendingConfirms[0]?.callId);
    await clickInWidget(page, { action: 'confirm-allow', callId });
    expect((await write).isError).toBe(false);
    await waitForDock(page, (state) => state.records[0]?.calls === 3);
    expect(await widgetText(page, 'record-summary')).toMatch(/^3 calls, 2 people since /);

    // The box warns whom the file names, and Save takes no click until it holds still.
    const downloads = countDownloads(page);
    await clickInWidget(page, { action: 'record-open' });
    expect((await widgetButtonNow(page, { action: 'record-save-json' }))?.armed).toBe(false);
    expect(await widgetText(page, 'record-warning')).toBe(
      'This record names 2 people and every call they made on this page, never its arguments or result. Anyone you share the file with can read it.',
    );
    await page.waitForTimeout(ARM_DELAY_MS + 200);
    // A script's click is never a trusted one, so it saves nothing.
    await scriptClickInWidget(page, { action: 'record-save-json' });
    await page.waitForTimeout(1000);
    expect(downloads.count).toBe(0);

    const json = await saveRecordFromWidget(page, 'json');
    expect(json.name).toMatch(/^tabdock-record-\d{8}-\d{4}\.json$/);
    const parsed = parseSessionRecord(json.text);
    if (!parsed.ok) throw new Error(parsed.reason);
    const record: SessionRecord = parsed.record;
    expect(record.calls.map((call) => [call.tool, call.confirmedBy, call.outcome])).toEqual([
      ['get_view', null, 'ok'],
      ['list_items', null, 'ok'],
      ['clear_board', 'page', 'ok'],
    ]);
    expect(record.attachments.map((span) => [span.user.id, span.how])).toEqual([
      ['alice', 'approved'],
      ['bob', 'approved'],
    ]);
    // The very callIds the relay wrote, each once, and no call the page never saw.
    expect(auditedCallIds(tabdock.auditDir)).toEqual(record.calls.map((call) => call.callId));

    const matched = auditMatch(json.path, tabdock.auditDir);
    expect(matched.code, matched.err).toBe(0);
    expect(matched.err).toMatch(/match: agrees with the log; 3 calls matched/);
    // One call taken out, and the log says so.
    const scratch = mkdtempSync(join(tmpdir(), 'tabdock-record-edit-'));
    try {
      const edited = join(scratch, 'edited.json');
      writeFileSync(
        edited,
        encodeSessionRecord({
          ...record,
          calls: record.calls.filter((call) => call.tool !== 'list_items'),
        }),
      );
      const failed = auditMatch(edited, tabdock.auditDir);
      expect(failed.code).toBe(1);
      expect(failed.out).toMatch(/^FAIL unrecorded: call /m);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }

    const summary = await saveRecordFromWidget(page, 'md');
    expect(summary.name).toBe(json.name.replace(/\.json$/, '.md'));
    expect(summary.text).toContain('# Tabdock session record');
    expect(downloads.count).toBe(2);
  });
});

test('fits a phone with the record box open, its warning and buttons wrapping within the panel', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const relay = await openWithSessionRelay(page, demo, {
    roster: [memberEntry('alice', 'Alice'), memberEntry('bob', 'Bob', 'observer')],
  });
  expect(relay.frames.length).toBeGreaterThan(0);
  await openRecordBox(page);
  await expect.poll(() => widgetVisible(page, 'record-warning')).toBe(true);
  const overflow = await widgetEvaluate(
    page,
    'record-box',
    'function () { const panel = this.closest(".panel"); return panel.scrollWidth - panel.clientWidth; }',
  );
  expect(overflow).toBe(0);
  expect(await sidewaysScroll(page)).toBe(0);
});

test("offers a session's record at its end, and saves nothing until the operator clicks", async ({
  page,
}) => {
  const relay = await openWithSessionRelay(page, demo);
  const downloads = countDownloads(page);
  await startSessionInWidget(page, { label: 'Period 3', minutes: 30 });
  // From here the relay says a minute is left, and then nothing more: the page's own clock ends it.
  relay.remainingMs = MINUTE;
  relay.send({
    t: 'session',
    session: {
      sessionId: relay.framesOf('session_start')[0]?.sessionId ?? '',
      lengthMs: 30 * MINUTE,
      remainingMs: MINUTE,
      policy: { maxDrivers: 1, proposals: 'off' },
    },
  });
  await waitForDock(page, (state) => state.session?.endsAt !== undefined);
  relay.silent = true;
  await page.clock.fastForward(MINUTE + 1000);
  await waitForDock(page, (state) => state.records.some((view) => view.which === 'ended'));
  await expect.poll(() => widgetVisible(page, 'record-offer')).toBe(true);
  expect(await widgetText(page, 'record-offer')).toMatch(
    /^Session "Period 3" ended\. Save its record\?This record names 1 person/,
  );
  await page.waitForTimeout(1500);
  expect(downloads.count).toBe(0);

  const saved = await saveOfferedRecord(page, 'json');
  expect(saved.name).toMatch(/^tabdock-record-\d{8}-\d{4}-period-3\.json$/);
  const parsed = parseSessionRecord(saved.text);
  if (!parsed.ok) throw new Error(parsed.reason);
  expect(parsed.record).toMatchObject({
    sealed: true,
    scope: { kind: 'session', label: 'Period 3', endedBy: 'time' },
  });
  expect(downloads.count).toBe(1);
  await clickInWidget(page, { action: 'record-offer-close' });
  await expect.poll(() => widgetVisible(page, 'record-offer')).toBe(false);
});

test("keeps offering the last lesson's record when a session nobody joined ends", async ({
  page,
}) => {
  const relay = await openWithSessionRelay(page, demo);
  const downloads = countDownloads(page);
  /** Ends the running session from the widget, as the operator does. */
  const endInWidget = async (label: string): Promise<void> => {
    await clickInWidget(page, { action: 'session-end' });
    await clickInWidget(page, { action: 'session-end-yes' });
    await waitForDock(page, (state) => state.sessionEnded?.label === label);
  };
  await startSessionInWidget(page, { label: 'Period 3', minutes: 30 });
  await endInWidget('Period 3');
  await expect
    .poll(() => widgetText(page, 'record-offer'))
    .toMatch(/^Session "Period 3" ended\. Save its record\?This record names 1 person/);

  // Alice leaves, and the next lesson starts and ends with nobody in it.
  relay.send({ t: 'roster', attachments: [] });
  await waitForDock(page, (state) => state.roster.length === 0);
  await startSessionInWidget(page, { label: 'Empty', minutes: 30 });
  await endInWidget('Empty');
  await waitForDock(page, (state) => state.session === null);
  expect(
    (await waitForDock(page, (state) => state.records))
      .filter((view) => view.which === 'ended')
      .map((view) => view.label),
  ).toEqual(['Period 3']);
  expect(await widgetText(page, 'record-offer')).toMatch(/^Session "Period 3" ended\./);
  expect(downloads.count).toBe(0);

  const saved = await saveOfferedRecord(page, 'json');
  const parsed = parseSessionRecord(saved.text);
  if (!parsed.ok) throw new Error(parsed.reason);
  expect(parsed.record.scope).toMatchObject({ kind: 'session', label: 'Period 3' });
  expect(parsed.record.attachments.map((span) => span.user.id)).toEqual(['alice']);
});

test('saves from the static build under its own Content Security Policy', async ({ page }) => {
  const outDir = mkdtempSync(join(tmpdir(), 'tabdock-static-record-'));
  try {
    await buildDemo({ outDir });
    const policyErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && message.text().includes('Content Security Policy')) {
        policyErrors.push(message.text());
      }
    });
    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.map': 'application/json',
    };
    await page.route('https://board.example/**', async (route) => {
      const name = new URL(route.request().url()).pathname.slice(1) || 'index.html';
      if (!/^[\w.-]+$/.test(name)) {
        await route.fulfill({ status: 404, body: 'Not found' });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: types[extname(name)] ?? 'application/octet-stream',
        body: readFileSync(join(outDir, name)),
      });
    });
    // A relay that lists Alice from its welcome, so the record names someone.
    await page.context().routeWebSocket(/\/page$/, (ws) => {
      ws.onMessage((message) => {
        const parsed = parsePageFrame(typeof message === 'string' ? message : message.toString());
        if (parsed.kind !== 'ok' || parsed.frame.t !== 'hello') return;
        ws.send(
          encodeFrame({
            t: 'welcome',
            pageId: 'page-1',
            resumeToken: 'resume-1',
            resumed: false,
            pairing: { code: 'ABCDE-FGHJK', expiresAt: Date.now() + 120_000 },
            roster: [memberEntry('alice', 'Alice')],
            limits: {
              maxFrameBytes: MAX_FRAME_BYTES,
              maxResultChars: MAX_RESULT_CHARS,
              maxDescriptionChars: MAX_DESCRIPTION_CHARS,
              pingIntervalMs: PING_INTERVAL_MS,
              idleTimeoutMs: 600_000,
              resumeWindowMs: RESUME_WINDOW_MS,
              attachRequestTtlMs: ATTACH_REQUEST_TTL_MS,
            },
          }),
        );
      });
    });
    const url = new URL('https://board.example/');
    url.searchParams.set('relay', 'wss://relay.example/page');
    await page.goto(url.href);
    await page.waitForSelector('html[data-tools="ready"]');
    await page.getByRole('button', { name: 'Connect to relay.example' }).click();
    await expect
      .poll(() => widgetText(page, 'record-summary'))
      .toMatch(/^0 calls, 1 person since /);
    const saved = await saveRecordFromWidget(page, 'md');
    expect(saved.name).toMatch(/^tabdock-record-\d{8}-\d{4}\.md$/);
    expect(saved.text).toContain('`Alice (alice)`');
    expect(policyErrors).toEqual([]);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// Leg 5 of pnpm demo:m6 (ADR 0043): a time-boxed session on a second map tab,
// "Period 2", whose clock Playwright holds, so the demo can move that page's
// time and nobody else's. The teacher starts a 30 minute session with two
// watching seats from the widget's form; two students scan its link on
// their phones and join at /i, and each one's Claude reads the map. Then the
// tab's clock jumps 30 minutes and the session ends on the page's own clock:
// the page revokes the guests at once, and its two-use link is already used
// up; once its grace has passed it sends session_end, and the relay closes
// whatever the session still held, here nothing, as the record's counts
// say. The widget offers the session's record and saves nothing unasked
// (ADR 0045).

import type { Client } from '@modelcontextprotocol/client';
import { student } from '../room-harness.ts';
import { fillSessionForm, sessionLinkInWidget } from '../session-helpers.ts';
import { callTool, clickInWidget, errorCode } from '../tabdock-harness.ts';
import { auditLines, bind, inFlight, type Lesson, until } from './lesson.ts';
import { maskCode, maskLink, storyLine } from './narrator.ts';
import {
  allowIn,
  linkStatus,
  openOperatorTab,
  openPanel,
  waitLinked,
  widgetTextWhen,
} from './operator.ts';

const MINUTE = 60_000;
/** Students by number, apart from the class of leg 6. */
const GUESTS = [100, 101] as const;

export async function session(lesson: Lesson): Promise<void> {
  const { narrator, room } = lesson;
  const { say, check } = bind(narrator);
  const tab = await openOperatorTab(lesson.browser, narrator, {
    mapUrl: room.map.url,
    relayPageUrl: room.relay.pageUrl,
    console: lesson.pageConsole,
    clock: true,
  });
  try {
    let downloads = 0;
    tab.page.on('download', () => {
      downloads += 1;
    });
    const code = await tab.freshCode();
    say(
      `   A second map tab, "Period 2", whose clock Playwright holds, links; Alice pairs with ${maskCode(code)}.`,
    );
    const pairing = inFlight(callTool(lesson.alice, 'pair_page', { code }));
    await allowIn(tab.page, 'claude-alice', 'driver');
    const paired = await pairing;
    tab.usedUp(code);
    check(!paired.isError, `Alice should pair with the second tab: ${paired.text.slice(0, 120)}`);
    const pageId = (paired.structured as { page?: string } | null)?.page ?? '';

    await openPanel(tab.page);
    await fillSessionForm(tab.page, { label: 'Period 2', minutes: 30, observers: 2 });
    await clickInWidget(tab.page, { action: 'session-start' });
    const countdown = await widgetTextWhen(tab.page, 'session-countdown', (text) =>
      text.startsWith('Ends in'),
    );
    say(
      `   The teacher starts "Period 2" from the widget's form, 30 minutes, 2 watching seats: "${countdown}".`,
    );
    const link = await until(async () => {
      const shown = await sessionLinkInWidget(tab.page);
      return shown.includes('#') ? shown : null;
    }, "the session's link");
    narrator.rememberLink(link);
    say(`   Its watch link, shown beside its QR: ${maskLink(link)}`);
    const started = auditLines(room.auditDir)
      .filter((record) => record.type === 'session_start')
      .at(-1);
    if (started !== undefined) say(`   ${storyLine(started)}`);

    const guests: Client[] = [];
    for (const index of GUESTS) {
      const { sub, email } = student(index);
      const joined = await room.joinAtI(index, link.slice(link.indexOf('#') + 1));
      check(
        joined.data.status === 'approved' && joined.data.role === 'observer',
        `${email} should join by the session link`,
      );
      // Their Claude, signed in as the same account, holds what the phone joined.
      const claude = await room.claude(`claude-student-${String(index)}`, sub, email);
      const read = await callTool(claude, 'call_page_tool', { page: pageId, tool: 'get_view' });
      check(!read.isError, `${email} should read the view`);
      say(
        `   ${email} scans it, joins at /i as observer, and their Claude reads get_view: ${read.isError ? (errorCode(read) ?? 'refused') : 'ok'}`,
      );
      guests.push(claude);
    }

    say(
      "\n   The tab's clock jumps 30 minutes (page.clock.fastForward), as a laptop lid shut that long would:",
    );
    await tab.page.clock.fastForward(30 * MINUTE);
    const ended = await widgetTextWhen(tab.page, 'session-ended', (text) => text !== '');
    say(`   The widget: "${ended}"`);
    check(ended === 'Session "Period 2" ended (time).', 'the session should end on the page clock');
    say(`   The page's link meanwhile: ${(await linkStatus(tab.page)).replace(/^.*?; /, '')}`);
    await waitLinked(tab.page);
    const held = await callTool(lesson.alice, 'list_pages');
    const resumed = ((held.structured as { pages?: { page?: string }[] } | null)?.pages ?? []).some(
      (entry) => entry.page === pageId,
    );
    say(
      `   Its watchdog, having heard nothing for those 30 minutes, reconnected; the page ${resumed ? `resumed its page session, Alice still holding ${pageId}` : 'started a new page session'}.`,
    );
    check(resumed, 'the second tab should resume its page session');
    say(
      "   The guests' grants ended on the page at once; the relay hears of the end once SESSION_END_GRACE_MS has passed.",
    );

    const [first] = guests;
    if (first !== undefined) {
      await until(
        async () => {
          const pages = await callTool(first, 'list_pages');
          const listed = (pages.structured as { pages?: { page?: string }[] } | null)?.pages ?? [];
          return listed.every((entry) => entry.page !== pageId) ? true : null;
        },
        "the relay to close the guests' attachments",
        30_000,
      );
      const after = await callTool(first, 'call_page_tool', { page: pageId, tool: 'get_view' });
      say(
        `   ${student(GUESTS[0]).email}'s Claude calls get_view again: ${errorCode(after) ?? 'ok'}`,
      );
      check(after.isError, "a guest's call after the session's end should be refused");
    }
    // The page tells the relay of its own end after its grace, so the record may come a moment later.
    const end = await until(
      () => auditLines(room.auditDir).find((record) => record.type === 'session_end'),
      "the relay's session_end record",
      20_000,
    );
    const sessionLines = auditLines(room.auditDir).filter(
      (record) =>
        record.seq > (started?.seq ?? 0) &&
        ['revoke', 'expire', 'session_end', 'invite_closed'].includes(record.type),
    );
    say("   The audit log, from the session's start to its end:");
    for (const record of sessionLines) say(`   ${storyLine(record)}`);
    const left = end.attachments + end.invites + end.agents;
    say(
      left === 0
        ? "   The page's own revokes had already let the guests go and the link had closed, so the relay's session_end found nothing left to close."
        : `   The relay's session_end closed what the page had left: ${String(end.attachments)} attachment(s), ${String(end.invites)} invite(s), ${String(end.agents)} agent token(s).`,
    );
    say(
      "   (A session_end the page sends names no reason, so the relay records it as the operator's; its own clock would say time.)",
    );
    const offer = await widgetTextWhen(tab.page, 'record-offer', (text) => text !== '');
    say(`   The widget offers the lesson's record: "${offer.split('?')[0] ?? ''}?"`);
    check(downloads === 0, 'nothing should be saved unasked');
    say(`   Nothing is saved until the teacher clicks: ${String(downloads)} downloads so far.`);
  } finally {
    await tab.close();
  }
}

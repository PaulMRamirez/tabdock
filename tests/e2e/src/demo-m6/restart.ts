// Leg 8 of pnpm demo:m6 (ADR 0046): the relay stops gracefully with
// TABDOCK_RESTART_SNAPSHOT on and starts again on the same port and audit
// directory. The stop writes one snapshot, holding hashes and never a
// secret, and a snapshot_written record with its SHA-256 before relay_stop;
// the start loads it only because the log's last two records say so, and
// the map page, reconnecting by itself, resumes its page session: the same
// page id, Alice still driving, the class still watching. A restart keeps no
// MCP session, so Alice's Claude connects again, with no pairing.

import { callMapTool } from '../map-harness.ts';
import { callTool, errorCode } from '../tabdock-harness.ts';
import { ALICE } from './classroom.ts';
import { auditLines, bind, type Lesson } from './lesson.ts';
import { storyLine } from './narrator.ts';
import { linkStatus, waitLinked, watchingTitle } from './operator.ts';

export async function restart(lesson: Lesson): Promise<void> {
  const { narrator, operator, pageId, room } = lesson;
  const { say, check } = bind(narrator);
  const before = auditLines(room.auditDir).length;
  const stoppedAt = Date.now();
  const restarting = room.restart();
  say(
    '   The relay stops gracefully (as SIGTERM stops `pnpm relay`) and starts again on the same port:',
  );
  await restarting;
  say(
    `   Back in ${String(Date.now() - stoppedAt)} ms; the map page's link: ${(await linkStatus(operator.page)).replace(/^.*?; /, '')}`,
  );
  await waitLinked(operator.page);
  say(
    `   The map page reconnects by itself: ${(await linkStatus(operator.page)).replace(/^.*?; /, '')}`,
  );
  const records = auditLines(room.auditDir).slice(before);
  for (const record of records.filter((line) =>
    ['snapshot_written', 'relay_stop', 'relay_start', 'snapshot_loaded'].includes(line.type),
  )) {
    say(`   ${storyLine(record)}`);
  }
  check(
    records.some((line) => line.type === 'snapshot_loaded'),
    'the start should load the snapshot',
  );

  const old = lesson.alice;
  lesson.alice = await room.claude('claude-alice', ALICE.sub);
  await old.close().catch(() => undefined);
  const pages = await callTool(lesson.alice, 'list_pages');
  const listed =
    (pages.structured as { pages?: { page?: string; role?: string }[] } | null)?.pages ?? [];
  const same = listed.find((entry) => entry.page === pageId);
  say(
    `   Alice's Claude connects again: list_pages names ${pageId}${same === undefined ? ' nowhere' : `, role ${same.role ?? '?'}`}, with no new pairing.`,
  );
  check(same !== undefined, 'the page should resume under the same page id');
  check(same?.role === 'driver', 'Alice should resume as the driver');
  // A write, which an observer would be refused, shows she still drives.
  const moved = await callMapTool(lesson.alice, pageId, 'go_to_stop', {
    walkthroughId: 'flyby',
    index: 0,
  });
  check(!moved.isError, `Alice should drive again at once: ${moved.text.slice(0, 120)}`);
  await watchingTitle(operator.page, 'Watching by invite: 39 of 40');
  say(
    `   go_to_stop flyby 0: ${moved.isError ? (errorCode(moved) ?? 'refused') : 'ok'}, a write, and the widget still reads "Watching by invite: 39 of 40".`,
  );
}

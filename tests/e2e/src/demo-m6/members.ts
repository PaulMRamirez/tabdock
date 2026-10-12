// Leg 4 of pnpm demo:m6 (ADR 0043): the members file changes while the relay
// runs. Bob, signed in but not yet a member, is an invitee, whom a pairing
// code does not let in; a line for him is renamed into the file, the relay
// reads it on its next poll with no restart, and Bob pairs. His Claude then
// waits on the page's state, and when his line goes the wait ends at once,
// every attachment under his id with it, and he sees no page.

import { readPageState, stateBody, waitPageState } from '../state-helpers.ts';
import { callTool, errorCode } from '../tabdock-harness.ts';
import { ALICE, BOB } from './classroom.ts';
import { auditLines, bind, inFlight, type Lesson, sleep, until } from './lesson.ts';
import { maskCode, storyLine } from './narrator.ts';
import { allowIn } from './operator.ts';

const BOB_EMAIL = 'bob@example.com';

/** The next members_reloaded record past the `seen` ones already in the log. */
async function nextReload(
  lesson: Lesson,
  seen: number,
): Promise<ReturnType<typeof auditLines>[number]> {
  return until(
    () =>
      auditLines(lesson.room.auditDir).filter((record) => record.type === 'members_reloaded')[seen],
    'the relay to read the members file again',
    15_000,
  );
}

export async function members(lesson: Lesson): Promise<void> {
  const { narrator, room, operator, pageId } = lesson;
  const { say, check } = bind(narrator);
  const reloads = (): number =>
    auditLines(room.auditDir).filter((record) => record.type === 'members_reloaded').length;

  const stranger = await room.claude('claude-bob', BOB.sub, BOB_EMAIL);
  const code = await operator.freshCode();
  say(
    `tools/call pair_page { code: "${maskCode(code)}" } from claude-bob (Bob, not in the members file)`,
  );
  const refused = await callTool(stranger, 'pair_page', { code });
  say(`   ${refused.text.split('\n', 1)[0] ?? ''}`);
  check(errorCode(refused) === 'invite_required', 'a signed-in non-member should need an invite');

  const seen = reloads();
  room.saveMembers([ALICE, BOB]);
  const savedAt = Date.now();
  say("   The teacher adds Bob's line to the members file, renaming a whole new file over it.");
  const added = await nextReload(lesson, seen);
  say(`   The relay reads it ${String(Date.now() - savedAt)} ms later, with no restart:`);
  say(`   ${storyLine(added)}`);
  check(
    added.type === 'members_reloaded' && added.added.includes('bob'),
    'the reload should add bob',
  );

  const bob = await room.claude('claude-bob', BOB.sub);
  const next = await operator.freshCode();
  say(`tools/call pair_page { code: "${maskCode(next)}" } from claude-bob (now a member)`);
  const pairing = inFlight(callTool(bob, 'pair_page', { code: next }));
  await allowIn(operator.page, 'claude-bob', 'observer');
  const paired = await pairing;
  operator.usedUp(next);
  check(!paired.isError, `Bob should pair: ${paired.text.slice(0, 120)}`);
  say('   The teacher clicks Allow as observer; Bob reads the view:');
  const view = await callTool(bob, 'call_page_tool', { page: pageId, tool: 'get_view' });
  check(!view.isError, 'Bob should read the view');
  say(`   get_view: ${view.isError ? 'refused' : 'ok'}`);

  const version = stateBody(await readPageState(bob, pageId)).version;
  say(
    `   Bob's Claude waits: wait_for_page_state { after: ${String(version)}, timeoutMs: 30000 }.`,
  );
  const waiting = inFlight(waitPageState(bob, pageId, version, 30_000));
  // Long enough for the wait to reach the relay before the file changes again.
  await sleep(500);
  const before = reloads();
  room.saveMembers([ALICE]);
  const removedAt = Date.now();
  say("   The teacher takes Bob's line out of the file again.");
  const ended = await waiting;
  say(
    `   Bob's wait ends ${String(Date.now() - removedAt)} ms later, long before its timeout: ${ended.ok ? 'it answered' : (ended.text.split('\n', 1)[0] ?? '')}`,
  );
  check(!ended.ok && ended.code === 'not_attached', "Bob's wait should end not_attached (S8)");
  const removed = await nextReload(lesson, before);
  say(`   ${storyLine(removed)}`);
  check(
    removed.type === 'members_reloaded' &&
      removed.removed.includes('bob') &&
      removed.attachments === 1,
    'the reload should remove bob and end his attachment',
  );
  const after = await room.claude('claude-bob-again', BOB.sub, BOB_EMAIL);
  const pages = await callTool(after, 'list_pages');
  const listed = (pages.structured as { pages?: unknown[] } | null)?.pages ?? [];
  say(
    `   Signed in again, Bob is an invitee once more, and list_pages shows him ${String(listed.length)} page(s).`,
  );
  check(listed.length === 0, 'a removed member should see no page');
}

// Leg 3 of pnpm demo:m6 (ADR 0042), the one docs/tour/06-classroom.md
// traces: a student joins by a Can watch link, so her Claude is an invited
// observer; its go_to_stop answers proposed with an id instead of running;
// the teacher's widget shows the proposal as a row whose Accept, once it has
// held still, is that call's confirmation; the relay sends the run, the
// adapter binds it to its own record of the proposal, the map moves and
// publishes its state, and the student's waits wake. The audit log holds
// the proposal and its run, the run's line marked acceptedOnPage with the
// callId the page's record will hold too.

import {
  acceptProposalInWidget,
  getProposal,
  propose,
  proposalRow,
  settledProposal,
} from '../proposal-helpers.ts';
import { readPageState, stateBody, waitPageState } from '../state-helpers.ts';
import { callTool } from '../tabdock-harness.ts';
import { auditLines, bind, centre, type Lesson, mapState, until } from './lesson.ts';
import { maskLink, storyLine } from './narrator.ts';
import { mintWatchLink, openPanel } from './operator.ts';

export const CAROL = { sub: 'sub-carol-student', email: 'carol@example.com' };

export async function proposal(lesson: Lesson): Promise<void> {
  const { narrator, room, operator, pageId } = lesson;
  const { say, check } = bind(narrator);
  const link = await mintWatchLink(operator.page, narrator, 'Carol', 1);
  say(`   The teacher mints a Can watch link for one student in the widget: ${maskLink(link)}`);
  const carol = await room.claude('claude-carol', CAROL.sub, CAROL.email);
  say(
    `tools/call pair_page { invite: "${maskLink(link)}" } from claude-carol (${CAROL.email}, not a member)`,
  );
  const joined = await callTool(carol, 'pair_page', { invite: link });
  check(!joined.isError && joined.text.includes('as observer'), 'Carol should join as an observer');
  say(`   ${joined.text.split('\n', 1)[0] ?? ''}`);
  say('   A watch link lets her in with no prompt: the page honours it against its own record.');

  const before = stateBody(await readPageState(carol, pageId)).version;
  say(
    `tools/call call_page_tool { page: "${pageId}", tool: "go_to_stop", arguments: { walkthroughId: "maria", index: 0 } } from claude-carol`,
  );
  const { answer, proposalId } = await propose(carol, pageId, 'go_to_stop', {
    walkthroughId: 'maria',
    index: 0,
  });
  say(`   ${answer.text.split('\n', 1)[0] ?? ''}`);
  check(answer.head === 'proposed' && proposalId !== null, 'an observer write should be proposed');
  if (proposalId === null) return;

  say(
    `   Her Claude waits twice: get_proposal { proposal: "${proposalId}", waitMs: 30000 } and wait_for_page_state { after: ${String(before)} }.`,
  );
  const decided = getProposal(carol, pageId, proposalId, 30_000);
  const moved = waitPageState(carol, pageId, before, 30_000);
  await openPanel(operator.page);
  const row = await until(async () => {
    // The row as laid out, a line per block, as the teacher reads it.
    const text = await proposalRow(
      operator.page,
      proposalId,
      'function () { return this.innerText; }',
    );
    return typeof text === 'string' && text !== '' ? text : null;
  }, "the proposal's row in the widget");
  say("   The widget's queue shows the row:");
  for (const line of row.split('\n').filter((text) => text.trim() !== '')) {
    say(`   | ${line.trim()}`);
  }
  await acceptProposalInWidget(operator.page, proposalId);
  say(
    "   The teacher clicks Accept once the row has held still; that click is the call's confirmation.",
  );
  const first = await decided;
  say(`   get_proposal wakes: ${first.text.split('\n', 1)[0] ?? ''}`);
  const settled = await settledProposal(carol, pageId, proposalId);
  const [head = '', label = ''] = settled.text.split('\n');
  say(`   A second get_proposal reads the run: ${head}`);
  say(`   ${label}`);
  check(settled.head === 'accepted' && !settled.isError, 'the accepted proposal should have run');
  const woke = stateBody(await moved);
  say(
    `   wait_for_page_state wakes too: version ${String(woke.version)}, ${centre(mapState(woke))}, walkthrough ${mapState(woke)?.walkthrough?.id ?? '?'}.`,
  );
  check(mapState(woke)?.walkthrough?.id === 'maria', 'the map should be at the proposed stop');

  const lines = auditLines(room.auditDir).filter(
    (record) =>
      (record.type === 'call' || record.type === 'proposal_closed') &&
      record.proposalId === proposalId,
  );
  say("   The audit log names the proposal and its one run, both as Carol's:");
  for (const record of lines) say(`   ${storyLine(record)}`);
  const run = lines.find((record) => record.type === 'call' && record.acceptedOnPage === true);
  const callId = run?.type === 'call' ? run.callId : undefined;
  check(callId !== undefined, 'the run should be audited acceptedOnPage with its callId');
  if (callId !== undefined) lesson.proposalRun = { proposalId, callId };
}

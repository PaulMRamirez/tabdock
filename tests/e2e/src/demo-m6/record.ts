// Leg 9 of pnpm demo:m6 (ADR 0045): the teacher saves the page's record from
// the widget's record box, after the warning that names everyone in it, with
// a trusted click once Save has held still; then `pnpm audit:log --match
// <file> --verify` holds the record to the relay's hash-chained log, the
// restart in between. Carol's accepted proposal is in both under one callId,
// the step docs/tour/06-classroom.md ends on.

import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSessionRecord } from '@tabdock/protocol';
import { auditMatch, openRecordBox, saveRecordFromWidget } from '../record-helpers.ts';
import { widgetText } from '../tabdock-harness.ts';
import { auditLines, bind, type Lesson } from './lesson.ts';
import { storyLine } from './narrator.ts';
import { openPanel } from './operator.ts';

export async function record(lesson: Lesson): Promise<void> {
  const { narrator, operator, room } = lesson;
  const { page } = operator;
  const { say, check } = bind(narrator);
  await openPanel(page);
  say(`   The widget's record line: "${(await widgetText(page, 'record-summary')) ?? ''}"`);
  await openRecordBox(page);
  say(
    `   Save record opens a box that warns first: "${(await widgetText(page, 'record-warning')) ?? ''}"`,
  );
  const saved = await saveRecordFromWidget(page, 'json');
  const file = join(lesson.scratch, saved.name);
  copyFileSync(saved.path, file);
  say(`   The teacher clicks Save JSON once it has held still; the browser saves ${saved.name}.`);
  const parsed = parseSessionRecord(saved.text);
  if (!parsed.ok) throw new Error(`the saved record does not parse: ${parsed.reason}`);
  const { calls, attachments, proposals } = parsed.record;
  say(
    `   It holds ${String(calls.length)} calls, ${String(attachments.length)} attachment spans and ${String(proposals.length)} proposal(s), never an argument, a result or an image.`,
  );

  const run = lesson.proposalRun;
  const inRecord = run === null ? undefined : calls.find((call) => call.callId === run.callId);
  const inLog = auditLines(room.auditDir).find(
    (line) => line.type === 'call' && run !== null && line.callId === run.callId,
  );
  say("   Carol's accepted proposal, in both under one callId:");
  if (inLog !== undefined) say(`   log:    ${storyLine(inLog)}`);
  if (inRecord !== undefined) {
    say(
      `   record: callId ${inRecord.callId} ${inRecord.tool}: ${inRecord.outcome}, proposal ${inRecord.proposalId ?? 'none'} (${proposals.find((entry) => entry.proposalId === inRecord.proposalId)?.status ?? 'not kept'})`,
    );
  }
  check(
    inRecord !== undefined && inLog !== undefined,
    'the proposal run should be in the record and the log',
  );

  say(`$ pnpm audit:log --match ${saved.name} --dir <audit directory> --verify`);
  const matched = auditMatch(file, room.auditDir);
  for (const line of `${matched.out}\n${matched.err}`.split('\n')) {
    if (line.trim() !== '') say(`   ${line}`);
  }
  check(
    matched.code === 0,
    `audit --match should agree with the log (exit ${String(matched.code)})`,
  );
}

// pnpm demo:m6: a class on one tab, narrated, entirely on this machine.
//   --headed   watch the map tabs in a visible browser
// The relay runs in public URL mode on loopback against the relay tests'
// stand-in identity provider, with invites, agent tokens and the restart
// snapshot on, its members in a file and its audit log hash-chained
// (demo-m6/classroom.ts); the canvas map page runs in headless Chromium and
// is driven only through its widget, as a teacher would. Ten legs, each in
// its own file under demo-m6/: a walk with state and a wait (ADRs 0038 and
// 0040), a capture whose SHA-256 the audit holds (0039), a student's
// proposal accepted in the widget (0042), a members file changed with no
// restart and a 30 minute session ending on the page's clock (0043), a
// class of forty watchers and an agent token (0044), a restart from the
// snapshot (0046), the record held to the log (0045), and `pnpm ci-check`
// (0041). Every code, token and link is masked, every line is checked
// against the secrets the run has met before it is printed, and at the end
// the relay's log and the pages' consoles are scanned for them too (S11).

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from '@playwright/test';
import { privateTempRoot } from '@tabdock/relay/test/private-tmp';
import { agent } from './demo-m6/agent.ts';
import { capture } from './demo-m6/capture.ts';
import { ciCheck } from './demo-m6/ci-check.ts';
import { type Classroom, startClassroom } from './demo-m6/classroom.ts';
import type { Lesson, Stage } from './demo-m6/lesson.ts';
import { members } from './demo-m6/members.ts';
import { Narrator } from './demo-m6/narrator.ts';
import { proposal } from './demo-m6/proposal.ts';
import { record } from './demo-m6/record.ts';
import { restart } from './demo-m6/restart.ts';
import { room } from './demo-m6/room.ts';
import { session } from './demo-m6/session.ts';
import { walk } from './demo-m6/walk.ts';
import { launchChromium } from './harness.ts';

const headed = process.argv.includes('--headed');
const narrator = new Narrator();
const startedAt = Date.now();

narrator.say('Tabdock M6: a class on one tab, on a loopback relay in public URL mode\n');
// The members file needs a directory only this account can change.
const scratch = realpathSync(mkdtempSync(join(privateTempRoot(), 'tabdock-demo-m6-')));
let browser: Browser | undefined;
let classroom: Classroom | undefined;
const pageConsole: string[] = [];
try {
  browser = await launchChromium(!headed);
  classroom = await startClassroom(narrator, scratch);
  narrator.say(
    `The relay: public URL https://relay.test (a stand-in tunnel to ${classroom.relay.url}), the stand-in provider,`,
  );
  narrator.say(
    '  invites, agent tokens and the restart snapshot on, members from a file, an audit directory.',
  );
  narrator.say(`Chromium ${browser.version()}, headless${headed ? ' off' : ''}.`);
  const stage: Stage = { narrator, room: classroom, browser, scratch, startedAt, pageConsole };

  narrator.leg(1, 'A walk with state, then a wait', startedAt);
  const lesson: Lesson = await walk(stage);
  narrator.leg(2, "capture_view, saved, its SHA-256 the audit line's", startedAt);
  await capture(lesson);
  narrator.leg(3, 'An invited student proposes go_to_stop, and the widget accepts it', startedAt);
  await proposal(lesson);
  narrator.leg(4, 'A members file changed twice, with no restart', startedAt);
  await members(lesson);
  narrator.leg(5, 'A 30 minute session with observers, ending on the page clock', startedAt);
  await session(lesson);
  narrator.leg(6, 'Forty watchers, and the forty-first refused', startedAt);
  await room(lesson);
  narrator.leg(7, 'An agent token: minted, allowed, cancelled, then 404', startedAt);
  await agent(lesson);
  narrator.leg(8, 'A graceful restart with the snapshot, and the page resumes', startedAt);
  await restart(lesson);
  narrator.leg(9, 'The record saved, and audit --match holds it to the log', startedAt);
  await record(lesson);
  narrator.leg(10, 'pnpm ci-check in local mode', startedAt);
  await ciCheck(stage);

  const logged = classroom.logLines.join('\n');
  narrator.check(narrator.leakIn(logged) === null, 'the relay logged a secret this run met');
  narrator.check(
    narrator.leakIn(pageConsole.join('\n')) === null,
    "a page's console held a secret this run met",
  );
  narrator.say(
    `\nOf the ${String(classroom.logLines.length)} lines the relay logged and the ${String(pageConsole.length)} the pages wrote to their consoles, none holds a token, code or link secret.`,
  );
  if (headed) {
    narrator.say('The browser stays open for 30 s so you can look at the map.');
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
} catch (error) {
  narrator.say(`\nThe demo stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await classroom?.close();
  rmSync(scratch, { recursive: true, force: true });
}
const seconds = Math.round((Date.now() - startedAt) / 1000);
if (narrator.unexpected > 0) {
  narrator.say(
    `\n${String(narrator.unexpected)} step(s) did not behave as expected (${String(seconds)} s).`,
  );
  process.exitCode = 1;
} else if (process.exitCode !== 1) {
  narrator.say(`\nEvery step behaved as expected, in ${String(seconds)} s.`);
}

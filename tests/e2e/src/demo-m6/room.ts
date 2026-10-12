// Leg 6 of pnpm demo:m6 (ADR 0044): a class joins the projected map by two
// watch links at /i, each student signing in on a phone of their own (the
// relay tests' Phone, played over HTTP), with no prompt: the page honours a
// watch link against its own record. Watchers take watching seats, 40 a page
// by default, apart from the people seats, so the members keep theirs. The
// widget's Watching section counts them and tells of the joins in one line
// per link; the forty-first watcher is turned away at /i though the link
// still has a use. The teacher then revokes one student from the compact
// Watching section, which frees the seat the next leg's agent takes.

import { joinAtI, student } from '../room-harness.ts';
import { clickInWidget, widgetEvaluate } from '../tabdock-harness.ts';
import { JOIN_LIMITS } from './classroom.ts';
import { bind, type Lesson } from './lesson.ts';
import { maskLink } from './narrator.ts';
import { mintWatchLink, openPanel, watchingTitle, watchingView } from './operator.ts';

function secretOf(link: string): string {
  return link.slice(link.indexOf('#') + 1);
}

export async function room(lesson: Lesson): Promise<void> {
  const { narrator, operator } = lesson;
  const { say, check } = bind(narrator);
  const { pairAttemptsPerPage } = JOIN_LIMITS;
  say(
    `   This relay takes ${String(pairAttemptsPerPage.demo)} joins a minute on one page so the class joins in seconds. A deployed relay takes ${String(pairAttemptsPerPage.deployed)}, the teacher's own pairings among them (S14), and past that /i answers rate_limited until the minute turns, so a teacher hands the link out a few minutes early.`,
  );
  const classA = await mintWatchLink(operator.page, narrator, 'Class A', 20);
  const classB = await mintWatchLink(operator.page, narrator, 'Class B', 20);
  say(`   Two watch links of 20 uses: ${maskLink(classA)} and ${maskLink(classB)}`);

  const join = async (from: number, to: number, link: string): Promise<number> => {
    let approved = 0;
    for (let index = from; index < to; index += 1) {
      const joined = await joinAtI(lesson.room, index, secretOf(link));
      if (joined.data.status === 'approved' && joined.data.role === 'observer') approved += 1;
    }
    return approved;
  };
  const startedAt = Date.now();
  const first = (await join(0, 20, classA)) + (await join(20, 30, classB));
  say(
    `   30 students sign in at /i on their phones and join: ${String(first)} approved as observers in ${String(Date.now() - startedAt)} ms, no prompt.`,
  );
  check(first === 30, 'thirty students should join');
  await openPanel(operator.page);
  await watchingTitle(operator.page, 'Watching by invite: 31 of 40');
  say('   The widget: "Watching by invite: 31 of 40" (Carol from leg 3 and the thirty).');
  const second = await join(30, 39, classB);
  check(second === 9, 'nine more students should join');
  await watchingTitle(operator.page, 'Watching by invite: 40 of 40');
  say(`   Nine more join by Class B: "Watching by invite: 40 of 40".`);

  const late = await joinAtI(lesson.room, 39, secretOf(classB));
  say(
    `   The forty-first watcher, ${student(39).email}, by Class B's last use: /i answers ${String(late.status)} ${String(late.data.error)}`,
  );
  check(
    late.status === 409 && late.data.error === 'page_busy',
    'the forty-first should get page_busy',
  );
  const joins = (await widgetEvaluate(
    operator.page,
    'joins',
    'function () { return Array.from(this.children, (line) => line.textContent); }',
  )) as string[] | null;
  say('   The widget tells of the joins in one line per link, never forty:');
  for (const line of joins ?? []) say(`   | ${line}`);

  await clickInWidget(operator.page, { action: 'watching-toggle' });
  const view = await watchingView(operator.page);
  const leaving = view?.rows.find((row) => row.text.includes(student(0).email));
  if (leaving === undefined)
    throw new Error("the first student's row is not in the Watching section");
  await clickInWidget(operator.page, { action: 'revoke', userId: leaving.userId });
  await watchingTitle(operator.page, 'Watching by invite: 39 of 40');
  say(
    `   The teacher opens the compact Watching section and revokes ${student(0).email} once the row has held still: "Watching by invite: 39 of 40".`,
  );
  await clickInWidget(operator.page, { action: 'watching-toggle' });
}

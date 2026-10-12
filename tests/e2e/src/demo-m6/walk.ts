// Leg 1 of pnpm demo:m6 (ADRs 0038 and 0040): the teacher links the canvas
// map page and allows her Claude as driver in the widget; Claude walks the
// flyby with go_to_stop and reads where the page is after each stop with
// get_page_state; then it waits with wait_for_page_state while the teacher
// drags the map by hand, and the wait wakes with the view she left.

import { MAP_PROFILE_TOOLS } from '@tabdock/sim-page/map';
import { callMapTool } from '../map-harness.ts';
import { labelledAlone, readPageState, stateBody, waitPageState } from '../state-helpers.ts';
import { callTool } from '../tabdock-harness.ts';
import { ALICE } from './classroom.ts';
import { bind, centre, inFlight, type Lesson, mapState, type Stage, stateWhere } from './lesson.ts';
import { maskCode } from './narrator.ts';
import { allowIn, openOperatorTab } from './operator.ts';

const FLYBY_STOPS = 4;

export async function walk(stage: Stage): Promise<Lesson> {
  const { narrator, room } = stage;
  const { say, check } = bind(narrator);
  const operator = await openOperatorTab(stage.browser, narrator, {
    mapUrl: room.map.url,
    relayPageUrl: room.relay.pageUrl,
    console: stage.pageConsole,
    // Students may propose writes; the page's other defaults stand (one driver seat).
    policy: { proposals: 'all' },
  });
  say(
    `   The canvas map page (${new URL(room.map.url).origin}, no map library) links to the relay through its connect hook, with proposals from all.`,
  );
  const alice = await room.claude('claude-alice', ALICE.sub);
  const code = await operator.freshCode();
  say(`tools/call pair_page { code: "${maskCode(code)}" } from claude-alice (Alice, a member)`);
  const pairing = inFlight(callTool(alice, 'pair_page', { code }));
  await allowIn(operator.page, 'claude-alice', 'driver');
  const paired = await pairing;
  operator.usedUp(code);
  check(!paired.isError, `pair_page should succeed: ${paired.text.slice(0, 120)}`);
  const pageId = (paired.structured as { page?: string } | null)?.page ?? '';
  say(`   The teacher clicks Allow as driver in the widget; Alice's Claude holds ${pageId}.`);
  const listed = await callTool(alice, 'list_page_tools', { page: pageId });
  const tools = (listed.structured as { tools?: { name: string }[] } | null)?.tools ?? [];
  const profile = new Set<string>(MAP_PROFILE_TOOLS.map((tool) => tool.name));
  say(
    `   list_page_tools: ${String(tools.length)} tools, ${String(tools.filter((tool) => profile.has(tool.name)).length)} of them the map profile's (guide page 16).`,
  );
  check(tools.length === 16, 'the map page should list sixteen tools');

  say('\n   Alice asks her Claude to walk the flyby; after each stop it reads the page state:');
  let version = 0;
  for (let index = 0; index < FLYBY_STOPS; index += 1) {
    const stop = await callMapTool(alice, pageId, 'go_to_stop', { walkthroughId: 'flyby', index });
    check(!stop.isError, `go_to_stop ${String(index)} should run: ${stop.text.slice(0, 120)}`);
    // The page publishes at most twice a second, so its state may trail the call by a moment.
    const body = await stateWhere(
      stateBody(await readPageState(alice, pageId)),
      async (after, waitMs) => stateBody(await waitPageState(alice, pageId, after, waitMs)),
      (state) => mapState(state)?.walkthrough?.stopIndex === index,
      `the page to publish stop ${String(index + 1)} of the flyby`,
    );
    version = body.version;
    say(
      `   go_to_stop flyby ${String(index)}: ok; get_page_state version ${String(body.version)}, stop ${String(index + 1)} of ${String(FLYBY_STOPS)}, ${centre(mapState(body))}`,
    );
  }
  const read = await readPageState(alice, pageId);
  check(
    labelledAlone(read, new URL(room.map.url).origin),
    'a state answer should come behind its page-state label, as text alone (S10)',
  );
  say(
    '   Each answer comes behind the page-state label, as one text block and no structured content (S10).',
  );

  say(
    `\n   Then Claude waits: wait_for_page_state { after: ${String(version)}, timeoutMs: 20000 }, while the teacher drags the map by hand.`,
  );
  const askedAt = Date.now();
  const waiting = inFlight(waitPageState(alice, pageId, version, 20_000));
  const canvas = await operator.page.locator('canvas#map').boundingBox();
  if (canvas === null) throw new Error('the map page shows no canvas');
  // Left of centre, clear of the widget's panel; one drag is one discrete change the page publishes.
  const from = { x: canvas.x + canvas.width * 0.3, y: canvas.y + canvas.height * 0.5 };
  await operator.page.mouse.move(from.x, from.y);
  await operator.page.mouse.down();
  await operator.page.mouse.move(from.x + 140, from.y + 60, { steps: 8 });
  await operator.page.mouse.up();
  const woke = stateBody(await waiting);
  say(
    `   The wait wakes after ${String(Date.now() - askedAt)} ms: version ${String(woke.version)}, changed ${String(woke.changed)}, ${centre(mapState(woke))}.`,
  );
  check(woke.changed === true && woke.version > version, 'the wait should wake with the drag');
  return { ...stage, operator, pageId, alice, proposalRun: null };
}

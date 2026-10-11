// The deterministic check (ADR 0041, A6.8): every stop of every walkthrough
// and every observation, each in a step of its own, with the published state
// and capture_view's picture at each. It ends by printing how many page calls
// it made, which this repository's runner holds the audit log's call records
// to; that line holds a count, never a code or a token.

import { walkPage } from '../src/walk.ts';
import { expect, test } from '../src/tabdock.ts';

/** Each stop and observation may take this long, on top of a minute for setting up. */
const PER_PLACE_MS = 10_000;
/**
 * The optional tools this page registers, so that losing one fails the walk
 * rather than skipping its checks. A copier lists what its own page has.
 */
const REQUIRE_TOOLS = [
  'get_clock',
  'capture_view',
  'list_observations',
  'get_observation',
  'view_from_observation',
];

test('every walkthrough stop and observation', async ({ tabdock }) => {
  const findings = await walkPage(tabdock.caller, tabdock.pageId, {
    requireTools: REQUIRE_TOOLS,
    step: (title, body) => test.step(title, body),
    planned: ({ stops, observations }) => {
      test.setTimeout(60_000 + PER_PLACE_MS * (stops + observations));
    },
  });
  console.log(`ci-check: ${String(tabdock.pageCalls())} page calls`);
  expect(findings).toEqual([]);
});

// Whoever writes a board link writes its policy too, so SPEC section 4 names
// every policy setting a link can make, the Connect bar names each one a link
// departs on, and the Connect form offers each as a box (ADR 0029's notes and
// ADR 0042's). SPEC once listed two after the board read a third; this holds
// SPEC's lists, and the demo README's, to the parameters the board itself
// reads and writes, so the next one cannot slip past.

import {
  DEFAULT_LINK_POLICY,
  type LinkPolicy,
  linkPolicyFromQuery,
  setPolicyParams,
} from '@tabdock/demo/policy';
import { describe, expect, it } from 'vitest';
import { readRepo } from '../src/doc-files.ts';

/** A link departing from the defaults in every way the board knows. */
const EVERY_DEPARTURE: LinkPolicy = { confirmInClient: true, invites: 'all', proposals: 'all' };

/** The query parameters the board writes for a policy, sorted. */
function paramsOf(link: LinkPolicy): string[] {
  const params = new URLSearchParams();
  setPolicyParams(params, link);
  return [...params.keys()].sort();
}

/** Every backticked `?name` in `text`, as name, sorted. */
function linkParams(text: string): string[] {
  return [...text.matchAll(/`\?([a-z]+)`/g)].map((match) => match[1] ?? '').sort();
}

function demoParagraph(): string {
  const found = readRepo('SPEC.md')
    .split('\n')
    .find((line) => line.startsWith('The demo page should make state visible'));
  if (found === undefined) throw new Error('SPEC.md has no demo paragraph');
  return found;
}

/** The text a regular expression's first group captures, or a thrown error naming what is missing. */
function captured(text: string, pattern: RegExp, what: string): string {
  const found = pattern.exec(text)?.[1];
  if (found === undefined) throw new Error(`no ${what}`);
  return found;
}

describe("the demo board's link policy", () => {
  it('departs in every field of LinkPolicy, and reads back what it writes', () => {
    expect(Object.keys(EVERY_DEPARTURE).sort()).toEqual(Object.keys(DEFAULT_LINK_POLICY).sort());
    expect(paramsOf(DEFAULT_LINK_POLICY)).toEqual([]);
    const params = new URLSearchParams();
    setPolicyParams(params, EVERY_DEPARTURE);
    expect(linkPolicyFromQuery(params)).toEqual(EVERY_DEPARTURE);
    // Each parameter alone moves the policy off the defaults, so none is written for nothing.
    for (const name of paramsOf(EVERY_DEPARTURE)) {
      const alone = new URLSearchParams([[name, params.get(name) ?? '']]);
      expect(linkPolicyFromQuery(alone), name).not.toEqual(DEFAULT_LINK_POLICY);
    }
  });

  it("is named whole in SPEC section 4's list of what the Connect bar names", () => {
    const bar = captured(demoParagraph(), /beyond the defaults \(([^)]*)\)/, 'list on the bar');
    expect(linkParams(bar)).toEqual(paramsOf(EVERY_DEPARTURE));
  });

  it("is named whole in SPEC section 4's list of what the Connect form sets", () => {
    const form = captured(
      demoParagraph(),
      /Connect form it offers[^,]*, which sets (.*?) only as its visitor ticks them/,
      'list for the form',
    );
    expect(linkParams(form)).toEqual(paramsOf(EVERY_DEPARTURE));
  });

  it('offers a box on the Connect form for each parameter', () => {
    const source = readRepo('apps/demo/src/connect.ts');
    const boxes = [...source.matchAll(/\boption\(\s*'([a-z]+)'/g)].map((match) => match[1] ?? '');
    expect(boxes.sort()).toEqual(paramsOf(EVERY_DEPARTURE));
  });

  it("is named whole in the demo README's list of what a remembered choice covers", () => {
    const readme = readRepo('apps/demo/README.md');
    const list = captured(readme, /the policy the link sets \(([^)]*)\)/, 'list in the README');
    expect(linkParams(list)).toEqual(paramsOf(EVERY_DEPARTURE));
  });
});

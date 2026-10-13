import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { TOUR_DIR } from './links.ts';
import { guidePage, indexPage, tourPage } from './page.ts';

// The tour's index at /tour/ names the page its explainers attach to. Up to
// 05 that was the demo board beside it; 06 works on the canvas map page,
// which `pnpm dev:map` serves from a clone, so the index names every
// explainer that runs it, and a later one that does fails here until it does.
// The index and every page's header also lead to the map demo at /map/
// (ADR 0050), so a reader of either collection finds it.

const REPO_ROOT = join(import.meta.dirname, '../../..');
const repository = { web: 'https://github.com/owner/tabdock', commit: '0'.repeat(40) };

/** The tour's explainers whose steps serve the canvas map page, by their two-digit number. */
function onTheMapPage(): string[] {
  const dir = join(REPO_ROOT, TOUR_DIR);
  return readdirSync(dir)
    .filter((name) => /^\d\d-.+\.md$/.test(name))
    .filter((name) => readFileSync(join(dir, name), 'utf8').includes('pnpm dev:map'))
    .map((name) => name.slice(0, 2));
}

describe('the tour index', () => {
  it('names the canvas map page for each explainer that serves it with pnpm dev:map', () => {
    const numbers = onTheMapPage();
    assert.ok(numbers.includes('06'), 'tour 06 serves the canvas map page');
    const html = indexPage([{ href: '00-baseline.html', title: '00: Baseline' }], repository);
    const closing = /<p>The <a href="\.\.\/">demo board<\/a>[^]*?<\/p>/.exec(html)?.[0] ?? '';
    assert.match(closing, /canvas map page, which <code>pnpm dev:map<\/code> serves/);
    for (const number of numbers) {
      assert.match(closing, new RegExp(`\\b${number} uses the canvas map page`), number);
    }
  });

  it('leads a visitor to the map demo at /map/ (ADR 0050), from its header and its text', () => {
    const html = indexPage([{ href: '00-baseline.html', title: '00: Baseline' }], repository);
    const header = /<header>([^]*?)<\/header>/.exec(html)?.[1] ?? '';
    assert.match(header, /<a href="\.\.\/map\/">The map demo<\/a>/);
    const main = /<main>([^]*?)<\/main>/.exec(html)?.[1] ?? '';
    assert.match(main, /<a href="\.\.\/map\/">map demo<\/a>/);
  });
});

describe('every tour and guide page', () => {
  it('links the map demo from its header, beside the board, the tour and the guide', () => {
    for (const html of [
      tourPage({ title: 'T', body: '<h1>T</h1>\n', previous: null, next: null, repository }),
      guidePage({ title: 'G', body: '<h1>G</h1>\n', previous: null, next: null, repository }),
    ]) {
      const header = /<header>([^]*?)<\/header>/.exec(html)?.[1] ?? '';
      const hrefs = [...header.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
      assert.deepEqual(hrefs.slice(-2), ['../', '../map/']);
      assert.equal(hrefs.length, 4);
    }
  });
});

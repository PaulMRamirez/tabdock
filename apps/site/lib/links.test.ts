import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type Collection,
  GUIDE_DIR,
  type LinkContext,
  LinkError,
  rewriteImage,
  rewriteLink,
  TOUR_DIR,
} from './links.ts';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const repository = { web: 'https://github.com/owner/tabdock', commit: COMMIT };
const tour: Collection = {
  dir: TOUR_DIR,
  out: 'tour',
  pages: new Set(['00-baseline', '01-walking-skeleton']),
};
const guide: Collection = {
  dir: GUIDE_DIR,
  out: 'guide',
  indexStem: 'README',
  pages: new Set(['01-concepts', '07-run-a-relay']),
};
const collections = [tour, guide];
const context: LinkContext = { repository, collection: tour, collections };
const inGuide: LinkContext = { repository, collection: guide, collections };
const blob = (path: string) => `https://github.com/owner/tabdock/blob/${COMMIT}/${path}`;

describe('rewriteLink (ADRs 0029 and 0035)', () => {
  it('turns a link to another tour page into its .html page, keeping the fragment', () => {
    assert.equal(rewriteLink('01-walking-skeleton.md', context), '01-walking-skeleton.html');
    assert.equal(
      rewriteLink('./00-baseline.md#one-call-traced', context),
      '00-baseline.html#one-call-traced',
    );
    assert.equal(rewriteLink('../tour/00-baseline.md', context), '00-baseline.html');
    assert.equal(rewriteLink('./', context), 'index.html');
  });

  it('turns any other repository path into a GitHub link at the commit built', () => {
    assert.equal(
      rewriteLink('../adr/0029-tour-on-pages.md', context),
      blob('docs/adr/0029-tour-on-pages.md'),
    );
    assert.equal(
      rewriteLink('../../packages/relay/src/hub.ts#L10', context),
      blob('packages/relay/src/hub.ts#L10'),
    );
    assert.equal(rewriteLink('/SPEC.md', context), blob('SPEC.md'));
    assert.equal(
      rewriteLink('../../apps/demo/', context),
      `https://github.com/owner/tabdock/tree/${COMMIT}/apps/demo`,
    );
    assert.equal(rewriteLink('../../', context), `https://github.com/owner/tabdock/tree/${COMMIT}`);
  });

  it('stops on a link to a tour or guide page that does not exist', () => {
    for (const [href, from] of [
      ['99-missing.md', context],
      ['../guide/12-missing.md', context],
      ['13-missing.md#anchor', inGuide],
      ['../tour/09-missing.md', inGuide],
    ] as const) {
      assert.throws(() => rewriteLink(href, from), /is no page of docs\/(?:tour|guide)/, href);
    }
  });

  it('resolves a guide page against the guide, and its index to index.html', () => {
    assert.equal(rewriteLink('07-run-a-relay.md#hosted', inGuide), '07-run-a-relay.html#hosted');
    assert.equal(rewriteLink('README.md', inGuide), 'index.html');
    assert.equal(rewriteLink('./', inGuide), 'index.html');
    assert.equal(
      rewriteLink('../../packages/relay/src/config.ts', inGuide),
      blob('packages/relay/src/config.ts'),
    );
    assert.equal(rewriteLink('../deploy.md', inGuide), blob('docs/deploy.md'));
  });

  it('links between the guide and the tour by their places on the site', () => {
    assert.equal(rewriteLink('../tour/00-baseline.md', inGuide), '../tour/00-baseline.html');
    assert.equal(rewriteLink('../tour/', inGuide), '../tour/index.html');
    assert.equal(rewriteLink('../guide/01-concepts.md', context), '../guide/01-concepts.html');
    assert.equal(
      rewriteLink('../guide/README.md#where-to-start', context),
      '../guide/index.html#where-to-start',
    );
    assert.equal(rewriteLink('../tour/img/m0-board.png', inGuide), '../tour/img/m0-board.png');
  });

  it('keeps fragments, http, https and mailto links as written', () => {
    for (const href of [
      '#try-it-by-hand',
      'https://modelcontextprotocol.io/',
      'http://127.0.0.1:5173/',
      'mailto:a@example.com',
    ]) {
      assert.equal(rewriteLink(href, context), href);
      assert.equal(rewriteLink(href, inGuide), href);
    }
  });

  it('keeps a link into the copied images beside the page', () => {
    assert.equal(rewriteLink('img/m0-board.png', context), 'img/m0-board.png');
    assert.equal(rewriteLink('img/flow.png', inGuide), 'img/flow.png');
  });

  it('refuses script, data and other schemes, scheme-relative hosts, and paths out of the repository', () => {
    for (const href of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:x',
      'file:///etc/passwd',
      '//evil.example/x',
      '\\\\evil.example\\x',
      '../../../outside.md',
      '',
    ]) {
      assert.throws(() => rewriteLink(href, context), LinkError, href);
      assert.throws(() => rewriteLink(href, inGuide), LinkError, href);
    }
  });
});

describe('rewriteImage', () => {
  it("takes the collection's own images only", () => {
    assert.equal(rewriteImage('img/m0-board.png', tour), 'img/m0-board.png');
    assert.equal(rewriteImage('./img/m1-board.png', tour), 'img/m1-board.png');
    assert.equal(rewriteImage('img/flow.png', guide), 'img/flow.png');
    for (const href of [
      'https://example.com/x.png',
      '//example.com/x.png',
      'data:image/png;base64,AAAA',
      '../../apps/demo/x.png',
      'm0-board.png',
      'img/m0-board.png?v=1',
    ]) {
      assert.throws(() => rewriteImage(href, tour), LinkError, href);
      assert.throws(() => rewriteImage(href, guide), LinkError, href);
    }
    // A guide page shows the guide's images, not the tour's.
    assert.throws(() => rewriteImage('../tour/img/m0-board.png', guide), LinkError);
  });
});

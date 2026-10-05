import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type LinkContext, LinkError, rewriteImage, rewriteLink, TOUR_DIR } from './links.ts';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const context: LinkContext = {
  repository: { web: 'https://github.com/owner/tabdock', commit: COMMIT },
  tourPages: new Set(['00-baseline', '01-walking-skeleton']),
};
const blob = (path: string) => `https://github.com/owner/tabdock/blob/${COMMIT}/${path}`;

describe('rewriteLink (ADR 0029)', () => {
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
    // A tour file the build does not render is still a repository path.
    // (Spelt through TOUR_DIR: doc-pointers.test.ts holds every docs path named in code to exist.)
    assert.equal(rewriteLink('99-missing.md', context), blob(`${TOUR_DIR}/99-missing.md`));
    assert.equal(
      rewriteLink('../../apps/demo/', context),
      `https://github.com/owner/tabdock/tree/${COMMIT}/apps/demo`,
    );
    assert.equal(rewriteLink('../../', context), `https://github.com/owner/tabdock/tree/${COMMIT}`);
  });

  it('keeps fragments, http, https and mailto links as written', () => {
    for (const href of [
      '#try-it-by-hand',
      'https://modelcontextprotocol.io/',
      'http://127.0.0.1:5173/',
      'mailto:a@example.com',
    ]) {
      assert.equal(rewriteLink(href, context), href);
    }
  });

  it('keeps a link into the copied images beside the page', () => {
    assert.equal(rewriteLink('img/m0-board.png', context), 'img/m0-board.png');
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
    }
  });
});

describe('rewriteImage', () => {
  it("takes the tour's own images only", () => {
    assert.equal(rewriteImage('img/m0-board.png'), 'img/m0-board.png');
    assert.equal(rewriteImage('./img/m1-board.png'), 'img/m1-board.png');
    for (const href of [
      'https://example.com/x.png',
      '//example.com/x.png',
      'data:image/png;base64,AAAA',
      '../../apps/demo/x.png',
      'm0-board.png',
      'img/m0-board.png?v=1',
    ]) {
      assert.throws(() => rewriteImage(href), LinkError, href);
    }
  });
});

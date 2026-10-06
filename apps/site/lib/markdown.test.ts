import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tourPageProblems } from './checks.ts';
import { type Collection, GUIDE_DIR, LinkError, type LinkContext, TOUR_DIR } from './links.ts';
import { mermaidSources, renderPage, slug } from './markdown.ts';
import { guideIndexPage, guidePage, tourPage } from './page.ts';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const tour: Collection = {
  dir: TOUR_DIR,
  out: 'tour',
  pages: new Set(['04-local-and-hosted', '05-first-class-tools']),
};
const guide: Collection = {
  dir: GUIDE_DIR,
  out: 'guide',
  indexStem: 'README',
  pages: new Set(['01-concepts', '02-quick-start']),
};
const repository = { web: 'https://github.com/owner/tabdock', commit: COMMIT };
const links: LinkContext = { repository, collection: tour, collections: [tour, guide] };
const guideLinks: LinkContext = { repository, collection: guide, collections: [tour, guide] };

const SAMPLE = `# 05: First-class tools

Intro with a [link back](04-local-and-hosted.md#one-watch-invite-traced) and [the hub](../../packages/relay/src/hub.ts).

![The board](img/m2-board.png)

## One call, traced

\`\`\`mermaid
sequenceDiagram
  C->>R: tools/call
\`\`\`

\`\`\`ts
const x = '<script>alert(1)</script>';
\`\`\`

## One call, traced

<script>alert(1)</script>

Inline <img src=x onerror=alert(1)> and <a href="javascript:alert(1)">raw</a> HTML.
`;

function render(markdown = SAMPLE) {
  return renderPage(markdown, '05-first-class-tools', links);
}

describe('renderPage for the tour (ADR 0029)', () => {
  it('takes the title from the first # heading and gives headings GitHub anchors', () => {
    const page = render();
    assert.equal(page.title, '05: First-class tools');
    assert.match(page.body, /<h1 id="05-first-class-tools">05: First-class tools<\/h1>/);
    assert.match(page.body, /<h2 id="one-call-traced">One call, traced<\/h2>/);
    assert.match(page.body, /<h2 id="one-call-traced-1">One call, traced<\/h2>/);
    assert.equal(slug('`attach()` and S9: the *limits*'), 'attach-and-s9-the-limits');
  });

  it('turns each Mermaid fence into an <img> of the SVG drawn for it, numbered by the page', () => {
    const page = render();
    assert.deepEqual(page.diagrams, [
      {
        file: '05-1.svg',
        source: 'sequenceDiagram\n  C->>R: tools/call',
        alt: 'Diagram: One call, traced',
      },
    ]);
    assert.match(
      page.body,
      /<figure class="diagram"><img src="img\/05-1\.svg" alt="Diagram: One call, traced"><\/figure>/,
    );
    assert.doesNotMatch(page.body, /sequenceDiagram/);
  });

  it('rewrites links and images as links.ts says', () => {
    const { body } = render();
    assert.match(body, /href="04-local-and-hosted\.html#one-watch-invite-traced"/);
    assert.match(
      body,
      new RegExp(
        `href="https://github.com/owner/tabdock/blob/${COMMIT}/packages/relay/src/hub\\.ts"`,
      ),
    );
    assert.match(body, /<img src="img\/m2-board\.png" alt="The board">/);
  });

  it("shows raw HTML as text, so the only markup is marked's own, and the page passes its checks", () => {
    const { title, body } = render();
    assert.doesNotMatch(body, /<script/i);
    assert.doesNotMatch(body, /<img src=x/);
    assert.doesNotMatch(body, /<a href="javascript/);
    assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt;/);
    const html = tourPage({
      title,
      body,
      previous: null,
      next: null,
      repository,
    });
    assert.deepEqual(tourPageProblems(html), []);
  });

  it('stops on a script link, an outside image, or a page with no title', () => {
    assert.throws(() => render('# T\n\n[x](javascript:alert(1))\n'), LinkError);
    assert.throws(() => render('# T\n\n<javascript:alert(1)>\n'), LinkError);
    assert.throws(() => render('# T\n\n![x](https://example.com/x.png)\n'), LinkError);
    assert.throws(() => render('No title here\n'), /has no # title/);
  });
});

const GUIDE_SAMPLE = `# Quick start

From a clone to a call; [Concepts](01-concepts.md#the-five-parts) first, or [the tour](../tour/04-local-and-hosted.md), or [the index](README.md).

<!-- fragment -->

\`\`\`ts
import { attach } from '@tabdock/adapter';
\`\`\`

\`\`\`mermaid
flowchart LR
  P[page] --> R[relay]
\`\`\`

Settings live in [config.ts](../../packages/relay/src/config.ts).
`;

describe('renderPage for the guide (ADR 0035)', () => {
  it('links guide pages beside it, tour pages in /tour/ and code on GitHub', () => {
    const page = renderPage(GUIDE_SAMPLE, '02-quick-start', guideLinks);
    assert.equal(page.title, 'Quick start');
    assert.match(page.body, /href="01-concepts\.html#the-five-parts"/);
    assert.match(page.body, /href="\.\.\/tour\/04-local-and-hosted\.html"/);
    assert.match(page.body, /href="index\.html"/);
    assert.match(
      page.body,
      new RegExp(
        `href="https://github.com/owner/tabdock/blob/${COMMIT}/packages/relay/src/config\\.ts"`,
      ),
    );
  });

  it('draws its diagrams under its own number, and drops a lone comment instead of showing it', () => {
    const page = renderPage(GUIDE_SAMPLE, '02-quick-start', guideLinks);
    assert.deepEqual(
      page.diagrams.map((diagram) => diagram.file),
      ['02-1.svg'],
    );
    assert.doesNotMatch(page.body, /fragment/);
    assert.doesNotMatch(page.body, /&lt;!--/);
    // A comment beside other markup is still shown as text, never passed through.
    const mixed = renderPage(
      '# T\n\n<!-- x --><script>alert(1)</script>\n',
      '02-quick-start',
      guideLinks,
    );
    assert.match(mixed.body, /&lt;script&gt;/);
  });

  it('passes the same checks as a tour page, with the guide first in the header', () => {
    const page = renderPage(GUIDE_SAMPLE, '02-quick-start', guideLinks);
    const html = guidePage({
      title: page.title,
      body: page.body,
      previous: null,
      next: null,
      repository,
    });
    assert.deepEqual(tourPageProblems(html), []);
    assert.match(html, /<title>Quick start · Tabdock guide<\/title>/);
    assert.match(
      html,
      /<nav><a href="index\.html">The guide<\/a> <a href="\.\.\/tour\/index\.html">The tour<\/a> <a href="\.\.\/">The demo board<\/a><\/nav>/,
    );
    const index = guideIndexPage({ title: 'The Tabdock guide', body: page.body, repository });
    assert.deepEqual(tourPageProblems(index), []);
  });

  it('stops on a link to a guide or tour page that does not exist', () => {
    assert.throws(
      () => renderPage('# T\n\n[gone](12-missing.md)\n', '02-quick-start', guideLinks),
      /is no page of docs\/guide/,
    );
    assert.throws(
      () => renderPage('# T\n\n[gone](../tour/09-missing.md)\n', '02-quick-start', guideLinks),
      /is no page of docs\/tour/,
    );
    assert.throws(
      () => renderPage('# T\n\n![x](../tour/img/m2-board.png)\n', '02-quick-start', guideLinks),
      LinkError,
    );
  });
});

describe('mermaidSources', () => {
  it("finds every Mermaid fence, in order, and nothing else's", () => {
    assert.deepEqual(
      mermaidSources(`${SAMPLE}\n\n\`\`\`mermaid\nflowchart TB\n  a --> b\n\`\`\`\n`),
      ['sequenceDiagram\n  C->>R: tools/call', 'flowchart TB\n  a --> b'],
    );
    assert.deepEqual(mermaidSources('# T\n\n```ts\nconst x = 1;\n```\n'), []);
  });
});

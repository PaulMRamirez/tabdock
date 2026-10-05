import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tourPageProblems } from './checks.ts';
import { LinkError, type LinkContext } from './links.ts';
import { renderTourPage, slug } from './markdown.ts';
import { tourPage } from './page.ts';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const links: LinkContext = {
  repository: { web: 'https://github.com/owner/tabdock', commit: COMMIT },
  tourPages: new Set(['04-local-and-hosted', '05-first-class-tools']),
};

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
  return renderTourPage(markdown, '05-first-class-tools', links);
}

describe('renderTourPage (ADR 0029)', () => {
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
      repository: links.repository,
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

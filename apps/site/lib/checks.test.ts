import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  svgProblems,
  TOUR_POLICY,
  TOUR_POLICY_META,
  tourDirProblems,
  tourPageProblems,
} from './checks.ts';
import { indexPage, tourPage } from './page.ts';

const repository = {
  web: 'https://github.com/owner/tabdock',
  commit: '0123456789abcdef0123456789abcdef01234567',
};
const body =
  '<h1 id="t">T</h1>\n<p><a href="01-x.html">next</a> <a href="https://example.com/">out</a></p>\n<figure class="diagram"><img src="img/00-1.svg" alt="Diagram: T"></figure>\n';
const good = tourPage({
  title: 'T',
  body,
  previous: { href: '00-a.html', title: 'A' },
  next: null,
  repository,
});

describe('tourPageProblems (ADR 0029)', () => {
  it("passes the build's own pages and index", () => {
    assert.deepEqual(tourPageProblems(good), []);
    assert.deepEqual(
      tourPageProblems(indexPage([{ href: '00-a.html', title: 'A' }], repository)),
      [],
    );
    assert.equal(
      TOUR_POLICY,
      "default-src 'none'; img-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'",
    );
  });

  const withBody = (extra: string) => good.replace('</main>', `${extra}\n</main>`);

  it('refuses any script', () => {
    for (const extra of [
      '<script>alert(1)</script>',
      '<SCRIPT src="x.js"></SCRIPT>',
      '<script\nsrc=x>',
    ]) {
      assert.ok(tourPageProblems(withBody(extra)).includes('holds a <script> element'), extra);
    }
  });

  it('refuses an event handler attribute, however it is spelt', () => {
    for (const extra of [
      '<img src="img/a.png" onerror="alert(1)">',
      '<img/onerror=alert(1) src="img/a.png">',
      '<a href="x.html"onclick="alert(1)">x</a>',
      '<p ONMOUSEOVER = "x">',
    ]) {
      assert.ok(
        tourPageProblems(withBody(extra)).includes('holds an on* event handler attribute'),
        extra,
      );
    }
    // Text that reads like one is escaped by marked and is no attribute.
    assert.deepEqual(
      tourPageProblems(withBody('<p>&lt;img onerror=alert(1)&gt; and onclick=x</p>')),
      [],
    );
  });

  it('refuses a page without its policy, with it twice, or with it after what it governs', () => {
    assert.ok(
      tourPageProblems(good.replace(TOUR_POLICY_META, '')).some((p) =>
        p.startsWith('lacks the tour policy'),
      ),
    );
    assert.ok(
      tourPageProblems(
        good.replace(TOUR_POLICY_META, `${TOUR_POLICY_META}\n${TOUR_POLICY_META}`),
      ).some((p) => p.startsWith('lacks the tour policy')),
    );
    const late = good
      .replace(`${TOUR_POLICY_META}\n`, '')
      .replace('</head>', `${TOUR_POLICY_META}\n</head>`);
    assert.ok(tourPageProblems(late).includes('has <title ahead of its policy'));
    const weaker = good.replace("default-src 'none'", "default-src 'self'");
    assert.ok(tourPageProblems(weaker).some((p) => p.startsWith('lacks the tour policy')));
    assert.ok(
      tourPageProblems(good.replace('<meta name="referrer" content="no-referrer">', '')).includes(
        'lacks the no-referrer meta',
      ),
    );
  });

  it('refuses frames, forms, a base, inline styles and another http-equiv', () => {
    for (const [extra, problem] of [
      ['<iframe src="x.html"></iframe>', 'holds a <iframe> element'],
      ['<object data="x"></object>', 'holds a <object> element'],
      ['<form action="x"></form>', 'holds a <form> element'],
      ['<base href="https://evil.example/">', 'holds a <base> element'],
      ['<style>body{}</style>', 'holds a <style> element'],
      ['<link rel="stylesheet" href="https://evil.example/x.css">', 'holds a <link> element'],
      ['<p style="color:red">x</p>', 'holds a style attribute'],
      [
        '<meta http-equiv="refresh" content="0;url=https://evil.example">',
        'holds another http-equiv meta',
      ],
    ] as const) {
      assert.ok(tourPageProblems(withBody(extra)).includes(problem), extra);
    }
  });

  it('refuses a script URL in a link, even behind character references, and an image from elsewhere', () => {
    for (const extra of [
      '<a href="javascript:alert(1)">x</a>',
      '<a href="JaVaScRiPt:alert(1)">x</a>',
      '<a href="javascript&#58;alert(1)">x</a>',
      '<a href="java&#x09;script:alert(1)">x</a>',
      '<a href="data:text/html,x">x</a>',
    ]) {
      assert.ok(
        tourPageProblems(withBody(extra)).some((p) => p.startsWith('links to a ')),
        extra,
      );
    }
    for (const extra of [
      '<img src="https://evil.example/x.png">',
      '<img src="//evil.example/x.png">',
      '<img src="/x.png">',
    ]) {
      assert.ok(
        tourPageProblems(withBody(extra)).some((p) => p.startsWith('shows an image from outside')),
        extra,
      );
    }
    assert.ok(
      tourPageProblems(withBody("<a href='x.html'>x</a>")).some((p) =>
        p.startsWith('has an unquoted'),
      ),
    );
  });
});

describe('svgProblems (ADR 0029)', () => {
  const svg = (inner: string) =>
    `<svg id="d" width="10" height="10" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><style>#d{font-family:"trebuchet ms";}</style><defs><marker id="m"/></defs>${inner}</svg>`;

  it('passes a picture that names only its own parts', () => {
    assert.deepEqual(
      svgProblems(
        svg(
          '<rect filter="url(#d-shadow)"/><path marker-end="url(&quot;#m&quot;)"/><use href="#m"/><text>GET /pair</text>',
        ),
      ),
      [],
    );
  });

  it('refuses script, event handlers, HTML and declarations', () => {
    for (const [inner, problem] of [
      ['<script>alert(1)</script>', 'holds a <script> element'],
      ['<rect onload="alert(1)"/>', 'holds an on* event handler attribute'],
      ['<rect/onclick="x"/>', 'holds an on* event handler attribute'],
      [
        '<foreignObject><div>x</div></foreignObject>',
        'holds a <foreignObject>, which carries HTML',
      ],
      ['<style>@import "x.css";</style>', 'imports a stylesheet'],
    ] as const) {
      assert.ok(svgProblems(svg(inner)).includes(problem), inner);
    }
    assert.ok(svgProblems(`<!DOCTYPE svg [<!ENTITY x "y">]>${svg('')}`).length > 0);
  });

  it('refuses any URL outside the diagram, in an attribute, in CSS or in its text', () => {
    for (const inner of [
      '<a href="https://evil.example/"><text>x</text></a>',
      '<a xlink:href="javascript:alert(1)"><text>x</text></a>',
      '<image href="data:image/png;base64,AAAA"/>',
      "<image xlink:href='img.png'/>",
      '<rect filter="url(https://evil.example/f.svg#x)"/>',
      '<rect style="fill:url(\'x.svg#p\')"/>',
      '<style>rect{background:url(//evil.example/x.png)}</style>',
      '<text>see https://evil.example/x</text>',
    ]) {
      assert.ok(svgProblems(svg(inner)).length > 0, inner);
    }
    // Only the W3C namespaces themselves may be named.
    assert.ok(
      svgProblems(svg('').replace('http://www.w3.org/1999/xlink', 'http://evil.example/ns'))
        .length > 0,
    );
  });
});

describe('tourDirProblems, the read-back of the built tour', () => {
  it('passes a clean tour and names each file that may not ship', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tabdock-site-check-'));
    try {
      mkdirSync(join(dir, 'img'));
      writeFileSync(join(dir, 'index.html'), good);
      writeFileSync(join(dir, 'tour.css'), 'body{}');
      writeFileSync(join(dir, 'img', '00-1.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
      writeFileSync(join(dir, 'img', 'm0.png'), 'png');
      assert.deepEqual(await tourDirProblems(dir), []);

      writeFileSync(join(dir, '05-x.html'), good.replace('</main>', '<script>x</script></main>'));
      writeFileSync(
        join(dir, 'img', '05-1.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>',
      );
      writeFileSync(join(dir, 'tour.js'), 'alert(1)');
      writeFileSync(join(dir, 'img', 'evil.SVGZ'), 'x');
      symlinkSync('/etc/hostname', join(dir, 'img', 'link.png'));
      assert.deepEqual(await tourDirProblems(dir), [
        '05-x.html: holds a <script> element',
        'img/05-1.svg: holds a <script> element',
        'img/evil.SVGZ: a .svgz file has no place in the tour',
        'img/link.png: is neither a file nor a directory',
        'tour.js: a .js file has no place in the tour',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
